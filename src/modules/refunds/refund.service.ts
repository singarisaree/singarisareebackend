import {
  CouponType,
  OrderStatus,
  PaymentStatus,
  Prisma,
  ReturnRequestStatus,
} from '@prisma/client';
import { randomBytes } from 'crypto';
import { prisma } from '@/config/database';
import { ApiError } from '@/shared/api-response';
import { parsePagination, parseCreatedAtFilter } from '@/utils/helpers';
import { buildPaginationMeta } from '@/shared/api-response';
import { z } from 'zod';
import { processRefundSchema } from './refund.schema';
import { invalidateCache } from '@/utils/memory-cache';
import { realtime } from '@/realtime/emitter';
import { areAllOrderItemsFullyReturned } from '@/modules/orders/order-tracking.sync';
import { whatsAppService } from '@/integrations/whatsapp.service';
import { logger } from '@/utils/logger';

const refundListInclude = {
  payments: { orderBy: { createdAt: 'desc' as const } },
  items: {
    select: {
      id: true,
      quantity: true,
      unitPrice: true,
      totalPrice: true,
    },
  },
  returnRequests: {
    orderBy: { createdAt: 'desc' as const },
    select: {
      id: true,
      status: true,
      returnedAt: true,
      refundCouponId: true,
      refundCouponCode: true,
      items: {
        select: {
          quantity: true,
          orderItem: {
            select: {
              unitPrice: true,
              totalPrice: true,
              quantity: true,
            },
          },
        },
      },
    },
  },
} satisfies Prisma.OrderInclude;

type RefundOrder = Prisma.OrderGetPayload<{ include: typeof refundListInclude }>;

function isOrderCouponIssued(order: {
  status: OrderStatus;
  refundedAt: Date | null;
  refundCouponId: string | null;
}): boolean {
  return (
    order.status === OrderStatus.REFUNDED ||
    order.refundedAt != null ||
    order.refundCouponId != null
  );
}

/** Unambiguous chars only (no 0/O, 1/I/L) so codes are easy to type. */
const COUPON_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function generateSimpleCouponCode(length = 6): string {
  const bytes = randomBytes(length);
  let body = '';
  for (let i = 0; i < length; i++) {
    body += COUPON_CODE_ALPHABET[bytes[i]! % COUPON_CODE_ALPHABET.length];
  }
  return `SC${body}`;
}

async function allocateUniqueRefundCouponCode(
  tx: Prisma.TransactionClient,
  maxAttempts = 12,
): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const code = generateSimpleCouponCode();
    const existing = await tx.coupon.findUnique({
      where: { code },
      select: { id: true },
    });
    if (!existing) return code;
  }
  throw new ApiError(500, 'Could not generate a unique coupon code. Please try again.');
}

function computeEligibleAmount(
  order: RefundOrder,
  pendingReturn: RefundOrder['returnRequests'][number] | undefined,
): number {
  const orderMerchandiseCap =
    Math.round(Math.max(0, Number(order.subtotal) - Number(order.discountAmount)) * 100) / 100;

  if (pendingReturn?.items?.length) {
    const itemsTotal = pendingReturn.items.reduce((sum, item) => {
      const unit = Number(item.orderItem.unitPrice);
      return sum + unit * item.quantity;
    }, 0);
    const returnItemsCap = Math.round(itemsTotal * 100) / 100;
    // Never exceed returned items value, and never exceed what was paid for merchandise
    return Math.min(returnItemsCap, orderMerchandiseCap);
  }

  return orderMerchandiseCap;
}

function findReturnForCoupon(
  order: Pick<RefundOrder, 'returnRequests'>,
  opts?: { force?: boolean },
): RefundOrder['returnRequests'][number] | undefined {
  const withoutCoupon = order.returnRequests.filter(
    (r) => !r.refundCouponId && r.status !== ReturnRequestStatus.REJECTED,
  );
  const pendingReturned = withoutCoupon.find((r) => r.status === ReturnRequestStatus.RETURNED);
  if (pendingReturned) return pendingReturned;
  if (opts?.force) {
    return withoutCoupon.find((r) => (r.items?.length ?? 0) > 0) ?? withoutCoupon[0];
  }
  return undefined;
}

function formatRefundOrder(order: RefundOrder) {
  const grandTotal = Number(order.grandTotal);
  const shippingCharge = Number(order.shippingCharge);
  const successfulPayment = order.payments.find((p) => p.status === PaymentStatus.SUCCESS);
  const latestReturn = order.returnRequests[0];
  const pendingReturn = findReturnForCoupon(order);
  const couponedReturn = order.returnRequests.find((r) => r.refundCouponId);
  const returnForAmount = pendingReturn ?? couponedReturn ?? undefined;
  const needsFullCoupon =
    (order.status === OrderStatus.CANCELLED ||
      order.status === OrderStatus.RETURNED ||
      order.status === OrderStatus.RTO) &&
    !order.refundCouponId &&
    !order.refundedAt;
  const canIssueCoupon = needsFullCoupon || pendingReturn != null;
  const refundType =
    order.status === OrderStatus.CANCELLED
      ? 'CANCELLATION'
      : order.status === OrderStatus.RTO
        ? 'OTHER'
        : order.status === OrderStatus.RETURNED ||
            order.status === OrderStatus.REFUNDED ||
            latestReturn?.status === ReturnRequestStatus.RETURNED
          ? 'RETURN'
          : 'OTHER';

  const refundCouponCode =
    order.refundCouponCode ??
    order.returnRequests.find((r) => r.refundCouponCode)?.refundCouponCode ??
    null;

  const eligibleAmount = computeEligibleAmount(order, returnForAmount);

  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status:
      isOrderCouponIssued(order) && order.status !== OrderStatus.REFUNDED
        ? OrderStatus.REFUNDED
        : order.status,
    refundType,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    grandTotal,
    eligibleAmount,
    shippingCharge,
    paymentStatus: successfulPayment?.status ?? order.payments[0]?.status ?? null,
    paymentMethod: successfulPayment?.method ?? order.payments[0]?.method ?? null,
    createdAt: order.createdAt,
    cancelledAt: order.status === OrderStatus.CANCELLED ? order.updatedAt : null,
    returnedAt:
      latestReturn?.returnedAt ?? (order.status === OrderStatus.RETURNED ? order.updatedAt : null),
    returnRequestId: pendingReturn?.id ?? couponedReturn?.id ?? latestReturn?.id ?? null,
    isRefunded: !canIssueCoupon,
    refundAmount: order.refundAmount != null ? Number(order.refundAmount) : null,
    refundDeduction: order.refundDeduction != null ? Number(order.refundDeduction) : null,
    refundCouponCode,
    refundedAt: order.refundedAt,
  };
}

function refundPendingWhere(): Prisma.OrderWhereInput {
  return {
    deletedAt: null,
    payments: { some: { status: PaymentStatus.SUCCESS } },
    OR: [
      {
        AND: [
          { status: { in: [OrderStatus.CANCELLED, OrderStatus.RETURNED, OrderStatus.RTO] } },
          { refundCouponId: null },
          { refundedAt: null },
          { status: { not: OrderStatus.REFUNDED } },
        ],
      },
      {
        returnRequests: {
          some: {
            status: ReturnRequestStatus.RETURNED,
            refundCouponId: null,
          },
        },
      },
    ],
  };
}

function refundCompletedWhere(): Prisma.OrderWhereInput {
  return {
    deletedAt: null,
    OR: [
      { status: OrderStatus.REFUNDED },
      { refundedAt: { not: null } },
      { refundCouponId: { not: null } },
      {
        returnRequests: {
          some: { refundCouponId: { not: null } },
        },
      },
    ],
  };
}

function refundListWhere(filter?: string): Prisma.OrderWhereInput {
  if (filter === 'pending') return refundPendingWhere();
  if (filter === 'completed') return refundCompletedWhere();

  return {
    deletedAt: null,
    OR: [refundPendingWhere(), refundCompletedWhere()],
  };
}

export class RefundService {
  async findAll(query: Record<string, string>) {
    const { page, limit, skip } = parsePagination(query);
    const where: Prisma.OrderWhereInput = refundListWhere(query.filter);
    const createdAt = parseCreatedAtFilter(query);
    if (createdAt) where.createdAt = createdAt;

    if (query.search) {
      where.AND = [
        {
          OR: [
            { orderNumber: { contains: query.search, mode: 'insensitive' } },
            { customerName: { contains: query.search, mode: 'insensitive' } },
            { customerPhone: { contains: query.search } },
          ],
        },
      ];
    }

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        include: refundListInclude,
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.order.count({ where }),
    ]);

    return {
      orders: orders.map(formatRefundOrder),
      meta: buildPaginationMeta(page, limit, total),
    };
  }

  async processRefund(orderId: string, data: z.infer<typeof processRefundSchema>) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, deletedAt: null },
      include: {
        payments: { orderBy: { createdAt: 'desc' } },
        returnRequests: {
          orderBy: { createdAt: 'asc' },
          include: {
            items: {
              select: {
                quantity: true,
                orderItem: {
                  select: {
                    unitPrice: true,
                    totalPrice: true,
                    quantity: true,
                  },
                },
              },
            },
          },
        },
        items: { select: { id: true, quantity: true, unitPrice: true, totalPrice: true } },
      },
    });

    if (!order) throw new ApiError(404, 'Order not found');

    const successfulPayment = order.payments.find((p) => p.status === PaymentStatus.SUCCESS);
    if (!successfulPayment) {
      throw new ApiError(400, 'No successful payment found for this order');
    }

    const force = Boolean(data.force);
    const pendingReturn = findReturnForCoupon(order, { force });

    const isCancelled = order.status === OrderStatus.CANCELLED;
    const isRto = order.status === OrderStatus.RTO;
    const isOrderReturned = order.status === OrderStatus.RETURNED;
    const eligibleFull =
      (isCancelled || isRto || isOrderReturned) &&
      !order.refundCouponId &&
      !order.refundedAt &&
      order.status !== OrderStatus.REFUNDED;
    const eligiblePartial =
      pendingReturn != null && pendingReturn.status === ReturnRequestStatus.RETURNED;

    if (!force && !eligibleFull && !eligiblePartial) {
      throw new ApiError(
        400,
        'Only cancelled, returned, RTO, or successfully returned items can receive a coupon refund',
      );
    }

    if (!force && eligibleFull && isOrderCouponIssued(order) && !eligiblePartial) {
      throw new ApiError(400, 'A store credit coupon has already been issued for this order');
    }

    if (force && isOrderCouponIssued(order) && !eligiblePartial && !pendingReturn) {
      throw new ApiError(400, 'A store credit coupon has already been issued for this order');
    }

    // When a return is involved, cap to those items; never exceed merchandise paid
    const eligibleAmount = computeEligibleAmount(order, pendingReturn);
    const deduction = data.deduction;
    const maxCoupon = Math.round(Math.max(0, eligibleAmount - deduction) * 100) / 100;

    if (deduction > eligibleAmount) {
      throw new ApiError(400, 'Deduction cannot exceed eligible amount');
    }
    if (data.couponAmount > maxCoupon) {
      throw new ApiError(400, `Coupon amount cannot exceed Rs. ${maxCoupon}`);
    }

    const now = new Date();
    const expiresAt = new Date(now);
    expiresAt.setDate(expiresAt.getDate() + 90);

    const result = await prisma.$transaction(async (tx) => {
      const couponCode = await allocateUniqueRefundCouponCode(tx);
      const coupon = await tx.coupon.create({
        data: {
          code: couponCode,
          type: CouponType.FLAT,
          value: data.couponAmount,
          remainingBalance: data.couponAmount,
          minOrderAmount: 0,
          usageLimit: null,
          isActive: true,
          isRefundCoupon: true,
          allowedPhone: order.customerPhone,
          sourceOrderId: order.id,
          expiresAt,
        },
      });

      const fullyReturned = isOrderReturned || (await areAllOrderItemsFullyReturned(tx, orderId));
      const isPartialOnly = Boolean(pendingReturn) && !isCancelled && !isRto && !fullyReturned;

      if (pendingReturn) {
        await tx.returnRequest.update({
          where: { id: pendingReturn.id },
          data: {
            refundCouponId: coupon.id,
            refundCouponCode: coupon.code,
          },
        });
      }

      if (isPartialOnly) {
        await tx.trackingHistory.create({
          data: {
            orderId,
            status: 'COUPON_ISSUED',
            description: 'Refunded',
          },
        });
      } else {
        await tx.order.update({
          where: { id: orderId },
          data: {
            status: OrderStatus.REFUNDED,
            refundDeduction: deduction,
            refundAmount: data.couponAmount,
            refundedAt: now,
            refundCouponId: coupon.id,
            refundCouponCode: coupon.code,
          },
        });

        await tx.trackingHistory.create({
          data: {
            orderId,
            status: OrderStatus.REFUNDED,
            description: 'Refunded',
          },
        });
      }

      return { couponCode: coupon.code, isPartialOnly };
    });

    const updated = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: refundListInclude,
    });

    invalidateCache('dashboard:');

    const formatted = formatRefundOrder(updated);

    realtime.refundProcessed({
      orderId: updated.id,
      orderNumber: updated.orderNumber,
      customerPhone: updated.customerPhone,
      refundAmount: Number(updated.refundAmount ?? data.couponAmount),
    });

    void (async () => {
      const notification = await whatsAppService.sendRefundCouponIssued({
        customerPhone: updated.customerPhone,
        customerName: updated.customerName,
        orderNumber: updated.orderNumber,
        couponCode: result.couponCode,
        couponAmount: data.couponAmount,
        deduction,
        expiresAt,
      });
      await prisma.notification.create({
        data: {
          orderId: updated.id,
          type: 'REFUND_COUPON_ISSUED',
          channel: 'WHATSAPP',
          recipient: updated.customerPhone,
          message: notification.message,
          status: notification.sent ? 'sent' : 'failed',
          sentAt: notification.sent ? new Date() : undefined,
          error: notification.error,
        },
      });
    })().catch((error) => {
      logger.warn('Refund coupon WhatsApp notification failed', {
        orderId: updated.id,
        error,
      });
    });

    return {
      ...formatted,
      couponCode: result.couponCode,
    };
  }
}

export const refundService = new RefundService();
