import { ReturnRequestStatus, Prisma } from '@prisma/client';
import { prisma } from '@/config/database';
import { runPrismaTransaction } from '@/utils/prisma-transaction';
import { ApiError } from '@/shared/api-response';
import { parsePagination, parseCreatedAtFilter } from '@/utils/helpers';
import { buildPaginationMeta } from '@/shared/api-response';
import { z } from 'zod';
import {
  createReturnRequestSchema,
  updateReturnRequestStatusSchema,
  adminCreateReturnRequestSchema,
} from './return-request.schema';
import {
  getReturnStatusDescription,
  syncOrderFromReturnStatus,
} from '@/modules/orders/order-tracking.sync';
import { realtime } from '@/realtime/emitter';
import { whatsAppService } from '@/integrations/whatsapp.service';
import { logger } from '@/utils/logger';
import { isInternationalShippingAddressFromJson } from '@/utils/shipping-address';
import { bookShiprocketReversePickup } from '@/modules/return-requests/return-request-reverse-pickup';

const returnItemInclude = {
  orderItem: {
    select: {
      id: true,
      productName: true,
      colorName: true,
      sku: true,
      imageUrl: true,
      quantity: true,
      unitPrice: true,
      totalPrice: true,
    },
  },
} satisfies Prisma.ReturnRequestItemInclude;

const returnInclude = {
  images: { orderBy: { sortOrder: 'asc' as const } },
  trackingHistory: { orderBy: { timestamp: 'desc' as const } },
  items: { include: returnItemInclude },
  order: {
    select: {
      id: true,
      orderNumber: true,
      status: true,
      customerName: true,
      customerPhone: true,
      grandTotal: true,
      createdAt: true,
      updatedAt: true,
      shipping: { select: { deliveredAt: true } },
    },
  },
} satisfies Prisma.ReturnRequestInclude;

const returnListInclude = {
  items: { include: returnItemInclude },
  order: {
    select: {
      id: true,
      orderNumber: true,
      status: true,
      customerName: true,
      customerPhone: true,
      grandTotal: true,
      createdAt: true,
      updatedAt: true,
    },
  },
} satisfies Prisma.ReturnRequestInclude;

function formatReturnRequest(
  request:
    | Prisma.ReturnRequestGetPayload<{ include: typeof returnInclude }>
    | Prisma.ReturnRequestGetPayload<{ include: typeof returnListInclude }>,
) {
  return {
    ...request,
    order: request.order
      ? {
          ...request.order,
          grandTotal: Number(request.order.grandTotal),
        }
      : undefined,
    items: request.items.map((item) => ({
      ...item,
      orderItem: item.orderItem
        ? {
            ...item.orderItem,
            unitPrice: Number(item.orderItem.unitPrice),
            totalPrice: Number(item.orderItem.totalPrice),
          }
        : item.orderItem,
    })),
  };
}

export class ReturnRequestService {
  /**
   * Accept return + book Shiprocket reverse pickup, then move to OUT_FOR_PICKUP.
   */
  private async acceptAndBookReversePickup(
    id: string,
    existing: { orderId: string; adminNotes: string | null },
    adminNotes?: string,
  ) {
    const booking = await bookShiprocketReversePickup(id);
    const now = new Date();
    const pickupNote = booking.reverseAwbCode
      ? `Reverse pickup booked via Shiprocket · AWB ${booking.reverseAwbCode}`
      : booking.shiprocketReturnShipmentId
        ? `Reverse pickup booked via Shiprocket · shipment #${booking.shiprocketReturnShipmentId}`
        : 'Reverse pickup booked via Shiprocket';

    await runPrismaTransaction(async (tx) => {
      await tx.returnRequest.update({
        where: { id },
        data: {
          status: ReturnRequestStatus.OUT_FOR_PICKUP,
          adminNotes: adminNotes?.trim() || existing.adminNotes,
          acceptedAt: now,
        },
      });

      await tx.returnRequestTrackingHistory.create({
        data: {
          returnRequestId: id,
          status: ReturnRequestStatus.ACCEPTED,
          description: getReturnStatusDescription(ReturnRequestStatus.ACCEPTED),
        },
      });

      await tx.returnRequestTrackingHistory.create({
        data: {
          returnRequestId: id,
          status: ReturnRequestStatus.OUT_FOR_PICKUP,
          description: pickupNote,
        },
      });

      await syncOrderFromReturnStatus(tx, existing.orderId, ReturnRequestStatus.ACCEPTED);
      await syncOrderFromReturnStatus(tx, existing.orderId, ReturnRequestStatus.OUT_FOR_PICKUP);
    });

    // Heavy include read stays outside the transaction to keep it short.
    const updated = await prisma.returnRequest.findUniqueOrThrow({
      where: { id },
      include: returnInclude,
    });

    return formatReturnRequest(updated);
  }

  private queueStatusNotification(request: {
    orderId: string;
    customerPhone: string;
    status: ReturnRequestStatus;
    reason: string;
    adminNotes?: string | null;
    order?: { orderNumber: string; customerName: string } | null;
  }): void {
    if (!request.order) return;
    void (async () => {
      const result = await whatsAppService.sendReturnStatusUpdate({
        customerPhone: request.customerPhone,
        customerName: request.order!.customerName,
        orderNumber: request.order!.orderNumber,
        status: request.status,
        reason: request.reason,
        adminNotes: request.adminNotes,
      });
      await prisma.notification.create({
        data: {
          orderId: request.orderId,
          type: 'RETURN_REQUEST_UPDATE',
          channel: 'WHATSAPP',
          recipient: request.customerPhone,
          message: result.message,
          status: result.sent ? 'sent' : 'failed',
          sentAt: result.sent ? new Date() : undefined,
          error: result.error,
        },
      });
    })().catch((error) => {
      logger.warn('Return request WhatsApp notification failed', {
        orderId: request.orderId,
        status: request.status,
        error,
      });
    });
  }

  async create(_data: z.infer<typeof createReturnRequestSchema>, _files?: Express.Multer.File[]) {
    throw new ApiError(
      403,
      'Online returns are not available. For damages within 3 days of delivery, please contact +91 9490458789.',
    );
  }

  async findAll(query: Record<string, string>) {
    const { page, limit, skip } = parsePagination(query);
    const where: Prisma.ReturnRequestWhereInput = {};
    const createdAt = parseCreatedAtFilter(query);
    if (createdAt) where.createdAt = createdAt;

    if (query.status) {
      where.status = query.status as ReturnRequestStatus;
    }

    if (query.search) {
      where.OR = [
        { customerPhone: { contains: query.search } },
        { reason: { contains: query.search, mode: 'insensitive' } },
        { order: { orderNumber: { contains: query.search, mode: 'insensitive' } } },
        { order: { customerName: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    const [requests, total] = await Promise.all([
      prisma.returnRequest.findMany({
        where,
        include: returnListInclude,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.returnRequest.count({ where }),
    ]);

    return {
      requests: requests.map(formatReturnRequest),
      meta: buildPaginationMeta(page, limit, total),
    };
  }

  async findById(id: string) {
    const request = await prisma.returnRequest.findUnique({
      where: { id },
      include: returnInclude,
    });
    if (!request) throw new ApiError(404, 'Return request not found');
    return formatReturnRequest(request);
  }

  async updateStatus(id: string, data: z.infer<typeof updateReturnRequestStatusSchema>) {
    const existing = await prisma.returnRequest.findUnique({ where: { id } });
    if (!existing) throw new ApiError(404, 'Return request not found');

    const nextStatus = data.status;
    const current = existing.status;
    const force = Boolean(data.force);

    const allowed: Record<ReturnRequestStatus, ReturnRequestStatus[]> = {
      REQUESTED: [ReturnRequestStatus.ACCEPTED, ReturnRequestStatus.REJECTED],
      ACCEPTED: [ReturnRequestStatus.OUT_FOR_PICKUP],
      OUT_FOR_PICKUP: [ReturnRequestStatus.PICKED_UP, ReturnRequestStatus.PICKUP_CANCELLED],
      PICKUP_CANCELLED: [ReturnRequestStatus.OUT_FOR_PICKUP],
      PICKED_UP: [ReturnRequestStatus.RETURNED],
      REJECTED: [],
      RETURNED: [],
    };

    if (!force && current !== nextStatus && !allowed[current].includes(nextStatus)) {
      throw new ApiError(400, `Cannot change return status from ${current} to ${nextStatus}`);
    }

    if (
      !force &&
      current === ReturnRequestStatus.REQUESTED &&
      nextStatus === ReturnRequestStatus.ACCEPTED
    ) {
      const formatted = await this.acceptAndBookReversePickup(id, existing, data.adminNotes);
      realtime.returnRequestUpdated({
        returnRequestId: formatted.id,
        orderId: formatted.orderId,
        orderNumber: formatted.order?.orderNumber,
        status: formatted.status,
        customerPhone: formatted.customerPhone,
      });
      this.queueStatusNotification(formatted);
      return formatted;
    }

    const now = new Date();
    await runPrismaTransaction(async (tx) => {
      await tx.returnRequest.update({
        where: { id },
        data: {
          status: nextStatus,
          adminNotes: data.adminNotes?.trim() || existing.adminNotes,
          acceptedAt:
            nextStatus === ReturnRequestStatus.ACCEPTED ||
            (force &&
              (
                [
                  ReturnRequestStatus.ACCEPTED,
                  ReturnRequestStatus.OUT_FOR_PICKUP,
                  ReturnRequestStatus.PICKED_UP,
                  ReturnRequestStatus.RETURNED,
                ] as ReturnRequestStatus[]
              ).includes(nextStatus))
              ? (existing.acceptedAt ?? now)
              : existing.acceptedAt,
          rejectedAt: nextStatus === ReturnRequestStatus.REJECTED ? now : existing.rejectedAt,
          pickedUpAt:
            nextStatus === ReturnRequestStatus.PICKED_UP ||
            (force && nextStatus === ReturnRequestStatus.RETURNED)
              ? (existing.pickedUpAt ?? now)
              : existing.pickedUpAt,
          pickupCancelledAt:
            nextStatus === ReturnRequestStatus.PICKUP_CANCELLED ? now : existing.pickupCancelledAt,
          returnedAt: nextStatus === ReturnRequestStatus.RETURNED ? now : existing.returnedAt,
        },
      });

      await tx.returnRequestTrackingHistory.create({
        data: {
          returnRequestId: id,
          status: nextStatus,
          description: force
            ? `Escalation: ${current} → ${nextStatus}`
            : getReturnStatusDescription(nextStatus),
        },
      });

      await syncOrderFromReturnStatus(tx, existing.orderId, nextStatus);
    });

    const updated = await prisma.returnRequest.findUniqueOrThrow({
      where: { id },
      include: returnInclude,
    });

    const formatted = formatReturnRequest(updated);
    realtime.returnRequestUpdated({
      returnRequestId: formatted.id,
      orderId: formatted.orderId,
      orderNumber: formatted.order?.orderNumber,
      status: formatted.status,
      customerPhone: formatted.customerPhone,
    });
    this.queueStatusNotification(formatted);

    return formatted;
  }

  /**
   * Admin mark-return: create RR for selected items/qty (no customer window).
   * One return per order.
   */
  async adminCreate(data: z.infer<typeof adminCreateReturnRequestSchema>) {
    const order = await prisma.order.findFirst({
      where: { id: data.orderId, deletedAt: null },
      include: { items: true },
    });
    if (!order) throw new ApiError(404, 'Order not found');
    if (isInternationalShippingAddressFromJson(order.shippingAddress)) {
      throw new ApiError(400, 'Returns are not available for international orders');
    }

    if (order.status !== 'DELIVERED' && order.status !== 'RETURNED') {
      throw new ApiError(400, 'Return can only be marked for delivered orders');
    }

    const existingReturn = await prisma.returnRequest.findFirst({
      where: { orderId: order.id },
      select: { id: true },
    });
    if (existingReturn) {
      throw new ApiError(400, 'This order already has a return');
    }

    const orderItemById = new Map(order.items.map((item) => [item.id, item]));
    const uniqueItemIds = new Set(data.items.map((item) => item.orderItemId));
    if (uniqueItemIds.size !== data.items.length) {
      throw new ApiError(400, 'Duplicate items in return request');
    }

    for (const item of data.items) {
      const orderItem = orderItemById.get(item.orderItemId);
      if (!orderItem) {
        throw new ApiError(400, 'One or more items do not belong to this order');
      }
      if (item.quantity > orderItem.quantity) {
        throw new ApiError(
          400,
          `Only ${orderItem.quantity} of "${orderItem.productName}" available to return`,
        );
      }
    }

    const wantsAutoReversePickup =
      (data.initialStatus ?? ReturnRequestStatus.ACCEPTED) === ReturnRequestStatus.ACCEPTED;
    const initialStatus = wantsAutoReversePickup
      ? ReturnRequestStatus.REQUESTED
      : (data.initialStatus ?? ReturnRequestStatus.ACCEPTED);
    const now = new Date();

    const createdId = await runPrismaTransaction(async (tx) => {
      const request = await tx.returnRequest.create({
        data: {
          orderId: order.id,
          customerPhone: order.customerPhone,
          reason: data.reason.trim(),
          status: initialStatus,
          adminNotes: data.adminNotes?.trim() || null,
          acceptedAt:
            initialStatus === ReturnRequestStatus.REQUESTED ||
            initialStatus === ReturnRequestStatus.REJECTED
              ? null
              : now,
          pickedUpAt:
            initialStatus === ReturnRequestStatus.PICKED_UP ||
            initialStatus === ReturnRequestStatus.RETURNED
              ? now
              : null,
          returnedAt: initialStatus === ReturnRequestStatus.RETURNED ? now : null,
          items: {
            create: data.items.map((item) => ({
              orderItemId: item.orderItemId,
              quantity: item.quantity,
            })),
          },
        },
      });

      await tx.returnRequestTrackingHistory.create({
        data: {
          returnRequestId: request.id,
          status: initialStatus,
          description: getReturnStatusDescription(initialStatus),
        },
      });

      await syncOrderFromReturnStatus(tx, order.id, initialStatus);

      return request.id;
    });

    const created = await prisma.returnRequest.findUniqueOrThrow({
      where: { id: createdId },
      include: returnInclude,
    });

    const formatted = formatReturnRequest(created);
    if (wantsAutoReversePickup) {
      const booked = await this.acceptAndBookReversePickup(
        formatted.id,
        { orderId: order.id, adminNotes: formatted.adminNotes ?? null },
        data.adminNotes,
      );
      realtime.returnRequestCreated({
        returnRequestId: booked.id,
        orderId: booked.orderId,
        orderNumber: booked.order?.orderNumber,
        status: booked.status,
        customerPhone: booked.customerPhone,
      });
      this.queueStatusNotification(booked);
      return booked;
    }

    realtime.returnRequestCreated({
      returnRequestId: formatted.id,
      orderId: formatted.orderId,
      orderNumber: formatted.order?.orderNumber,
      status: formatted.status,
      customerPhone: formatted.customerPhone,
    });
    this.queueStatusNotification(formatted);

    return formatted;
  }
}

export const returnRequestService = new ReturnRequestService();
