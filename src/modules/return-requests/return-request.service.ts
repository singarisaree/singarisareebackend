import { ReturnRequestStatus, Prisma } from '@prisma/client';
import { prisma } from '@/config/database';
import { ApiError } from '@/shared/api-response';
import { parsePagination, parseCreatedAtFilter } from '@/utils/helpers';
import { buildPaginationMeta } from '@/shared/api-response';
import { localStorageService } from '@/integrations/local-storage.service';
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

const ACTIVE_STATUSES: ReturnRequestStatus[] = [
  ReturnRequestStatus.REQUESTED,
  ReturnRequestStatus.ACCEPTED,
  ReturnRequestStatus.OUT_FOR_PICKUP,
  ReturnRequestStatus.PICKUP_CANCELLED,
  ReturnRequestStatus.PICKED_UP,
];

const RETURN_WINDOW_DAYS = 3;

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

function getDeliveredAt(order: {
  shipping?: { deliveredAt: Date | null } | null;
  trackingHistory: Array<{ timestamp: Date }>;
}): Date | null {
  if (order.shipping?.deliveredAt) return order.shipping.deliveredAt;
  if (order.trackingHistory[0]) return order.trackingHistory[0].timestamp;
  return null;
}

function assertWithinReturnWindow(deliveredAt: Date | null) {
  if (!deliveredAt) {
    throw new ApiError(400, 'Delivery date not found for this order');
  }
  const deadline = new Date(deliveredAt);
  deadline.setDate(deadline.getDate() + RETURN_WINDOW_DAYS);
  if (new Date() > deadline) {
    throw new ApiError(
      400,
      'Return window has expired. Returns are allowed within 3 days of delivery.',
    );
  }
}

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

  async create(data: z.infer<typeof createReturnRequestSchema>, files?: Express.Multer.File[]) {
    const order = await prisma.order.findFirst({
      where: {
        id: data.orderId,
        customerPhone: data.phone,
        deletedAt: null,
      },
      include: {
        items: true,
        shipping: { select: { deliveredAt: true } },
        trackingHistory: {
          where: { status: 'DELIVERED' },
          orderBy: { timestamp: 'desc' },
          take: 1,
          select: { timestamp: true },
        },
      },
    });

    if (!order) throw new ApiError(404, 'Order not found for this mobile number');
    if (order.status !== 'DELIVERED') {
      throw new ApiError(400, 'Return can only be requested for delivered orders');
    }

    assertWithinReturnWindow(getDeliveredAt(order));

    const activeReturn = await prisma.returnRequest.findFirst({
      where: {
        orderId: order.id,
        status: { in: ACTIVE_STATUSES },
      },
    });

    if (activeReturn) {
      throw new ApiError(400, 'A return request is already in progress for this order');
    }

    const orderItemById = new Map(order.items.map((item) => [item.id, item]));
    const uniqueItemIds = new Set(data.items.map((item) => item.orderItemId));
    if (uniqueItemIds.size !== data.items.length) {
      throw new ApiError(400, 'Duplicate items in return request');
    }

    for (const item of data.items) {
      if (!orderItemById.has(item.orderItemId)) {
        throw new ApiError(400, 'One or more items do not belong to this order');
      }
    }

    const existingReturnQtys = await prisma.returnRequestItem.groupBy({
      by: ['orderItemId'],
      where: {
        orderItemId: { in: [...uniqueItemIds] },
        returnRequest: {
          orderId: order.id,
          status: { not: ReturnRequestStatus.REJECTED },
        },
      },
      _sum: { quantity: true },
    });

    const alreadyReturning = new Map(
      existingReturnQtys.map((row) => [row.orderItemId, row._sum.quantity ?? 0]),
    );

    for (const item of data.items) {
      const orderItem = orderItemById.get(item.orderItemId)!;
      const used = alreadyReturning.get(item.orderItemId) ?? 0;
      const available = orderItem.quantity - used;
      if (item.quantity > available) {
        throw new ApiError(
          400,
          `Only ${available} of "${orderItem.productName}" available to return`,
        );
      }
    }

    const uploads =
      files && files.length > 0
        ? await localStorageService.uploadMultiple(files.slice(0, 3), 'return-requests')
        : [];

    const created = await prisma.$transaction(async (tx) => {
      const request = await tx.returnRequest.create({
        data: {
          orderId: order.id,
          customerPhone: data.phone,
          reason: data.reason.trim(),
          status: ReturnRequestStatus.REQUESTED,
          items: {
            create: data.items.map((item) => ({
              orderItemId: item.orderItemId,
              quantity: item.quantity,
            })),
          },
          images: {
            create: uploads.map((upload, index) => ({
              url: upload.url,
              publicId: upload.publicId,
              sortOrder: index,
            })),
          },
        },
      });

      await tx.returnRequestTrackingHistory.create({
        data: {
          returnRequestId: request.id,
          status: ReturnRequestStatus.REQUESTED,
          description: getReturnStatusDescription(ReturnRequestStatus.REQUESTED),
        },
      });

      await syncOrderFromReturnStatus(tx, order.id, ReturnRequestStatus.REQUESTED);

      return tx.returnRequest.findUniqueOrThrow({
        where: { id: request.id },
        include: returnInclude,
      });
    });

    const formatted = formatReturnRequest(created);
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

    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
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

      return tx.returnRequest.findUniqueOrThrow({
        where: { id },
        include: returnInclude,
      });
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
   * Escalation / admin arrange-return: create RR without customer window limits.
   */
  async adminCreate(data: z.infer<typeof adminCreateReturnRequestSchema>) {
    const order = await prisma.order.findFirst({
      where: { id: data.orderId, deletedAt: null },
      include: { items: true },
    });
    if (!order) throw new ApiError(404, 'Order not found');

    const force = data.force !== false;
    if (!force && order.status !== 'DELIVERED') {
      throw new ApiError(400, 'Return can only be requested for delivered orders');
    }

    const activeReturn = await prisma.returnRequest.findFirst({
      where: {
        orderId: order.id,
        status: { in: ACTIVE_STATUSES },
      },
    });
    if (activeReturn && !force) {
      throw new ApiError(400, 'A return request is already in progress for this order');
    }
    // Escalation force: reject any in-progress return so a new one can be arranged
    if (activeReturn && force) {
      await prisma.$transaction(async (tx) => {
        await tx.returnRequest.update({
          where: { id: activeReturn.id },
          data: {
            status: ReturnRequestStatus.REJECTED,
            rejectedAt: new Date(),
            adminNotes: [activeReturn.adminNotes, 'Superseded by escalation arrange-return']
              .filter(Boolean)
              .join(' | '),
          },
        });
        await tx.returnRequestTrackingHistory.create({
          data: {
            returnRequestId: activeReturn.id,
            status: ReturnRequestStatus.REJECTED,
            description: 'Escalation: superseded by new arranged return',
          },
        });
      });
      const superseded = await this.findById(activeReturn.id);
      this.queueStatusNotification(superseded);
    }

    const orderItemById = new Map(order.items.map((item) => [item.id, item]));
    const uniqueItemIds = new Set(data.items.map((item) => item.orderItemId));
    if (uniqueItemIds.size !== data.items.length) {
      throw new ApiError(400, 'Duplicate items in return request');
    }

    for (const item of data.items) {
      if (!orderItemById.has(item.orderItemId)) {
        throw new ApiError(400, 'One or more items do not belong to this order');
      }
    }

    const existingReturnQtys = await prisma.returnRequestItem.groupBy({
      by: ['orderItemId'],
      where: {
        orderItemId: { in: [...uniqueItemIds] },
        returnRequest: {
          orderId: order.id,
          status: { not: ReturnRequestStatus.REJECTED },
        },
      },
      _sum: { quantity: true },
    });

    const alreadyReturning = new Map(
      existingReturnQtys.map((row) => [row.orderItemId, row._sum.quantity ?? 0]),
    );

    for (const item of data.items) {
      const orderItem = orderItemById.get(item.orderItemId)!;
      const used = alreadyReturning.get(item.orderItemId) ?? 0;
      const available = orderItem.quantity - used;
      if (item.quantity > available) {
        throw new ApiError(
          400,
          `Only ${available} of "${orderItem.productName}" available to return`,
        );
      }
    }

    const initialStatus = data.initialStatus ?? ReturnRequestStatus.ACCEPTED;
    const now = new Date();

    const created = await prisma.$transaction(async (tx) => {
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
          description: force
            ? `Escalation: return arranged as ${initialStatus}`
            : getReturnStatusDescription(initialStatus),
        },
      });

      await syncOrderFromReturnStatus(tx, order.id, initialStatus);

      return tx.returnRequest.findUniqueOrThrow({
        where: { id: request.id },
        include: returnInclude,
      });
    });

    const formatted = formatReturnRequest(created);
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
