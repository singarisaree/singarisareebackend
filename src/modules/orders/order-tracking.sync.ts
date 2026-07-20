import { OrderStatus, ReturnRequestStatus, Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

export function getReturnStatusDescription(status: ReturnRequestStatus): string {
  const descriptions: Record<ReturnRequestStatus, string> = {
    REQUESTED: 'Return request submitted',
    ACCEPTED: 'Return request accepted',
    REJECTED: 'Return request rejected',
    OUT_FOR_PICKUP: 'Pickup scheduled — item out for pickup',
    PICKUP_CANCELLED: 'Pickup cancelled',
    PICKED_UP: 'Item picked up',
    RETURNED: 'Returned',
  };
  return descriptions[status];
}

export function getOrderStatusTrackingDescription(status: OrderStatus): string {
  const descriptions: Record<OrderStatus, string> = {
    PLACED: 'Order placed',
    PAYMENT_PENDING: 'Awaiting payment',
    CONFIRMED: 'Order confirmed',
    READY_TO_SHIP: 'Ready to ship',
    SHIPPED: 'Order shipped',
    IN_TRANSIT: 'In transit',
    DELIVERED: 'Delivered',
    RETURNED: 'Returned',
    REFUNDED: 'Refunded',
    CANCELLED: 'Order cancelled',
    FAILED: 'Order failed',
    RTO: 'Returned to origin',
  };
  return descriptions[status];
}

/** Map return workflow statuses to order tracking history status codes. */
export function returnStatusToOrderTrackingStatus(status: ReturnRequestStatus): string {
  if (status === ReturnRequestStatus.RETURNED) {
    return OrderStatus.RETURNED;
  }
  return `RETURN_${status}`;
}

export async function appendOrderTracking(
  tx: Tx,
  orderId: string,
  status: string,
  description: string,
) {
  await tx.trackingHistory.create({
    data: { orderId, status, description },
  });
}

/** True when every order-item quantity is covered by RETURNED return requests. */
export async function areAllOrderItemsFullyReturned(tx: Tx, orderId: string): Promise<boolean> {
  const orderItems = await tx.orderItem.findMany({
    where: { orderId },
    select: { id: true, quantity: true },
  });

  if (orderItems.length === 0) return false;

  const returnedItems = await tx.returnRequestItem.groupBy({
    by: ['orderItemId'],
    where: {
      returnRequest: {
        orderId,
        status: ReturnRequestStatus.RETURNED,
      },
    },
    _sum: { quantity: true },
  });

  const returnedByItem = new Map(
    returnedItems.map((row) => [row.orderItemId, row._sum.quantity ?? 0]),
  );

  return orderItems.every((item) => (returnedByItem.get(item.id) ?? 0) >= item.quantity);
}

export async function syncOrderFromReturnStatus(
  tx: Tx,
  orderId: string,
  returnStatus: ReturnRequestStatus,
) {
  await appendOrderTracking(
    tx,
    orderId,
    returnStatusToOrderTrackingStatus(returnStatus),
    getReturnStatusDescription(returnStatus),
  );

  if (returnStatus === ReturnRequestStatus.RETURNED) {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        status: true,
        refundedAt: true,
        refundAmount: true,
        refundCouponId: true,
        payments: { select: { status: true } },
      },
    });

    const alreadyRefunded =
      order?.status === OrderStatus.REFUNDED ||
      order?.refundedAt != null ||
      order?.refundCouponId != null ||
      order?.refundAmount != null ||
      order?.payments.some((payment) => payment.status === 'REFUNDED');

    if (alreadyRefunded) return;

    const fullyReturned = await areAllOrderItemsFullyReturned(tx, orderId);
    if (fullyReturned) {
      await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.RETURNED },
      });
    }
    // Partial return: leave order as DELIVERED
  }
}

const RETURN_SYNC_FROM_ORDER: ReturnRequestStatus[] = [
  ReturnRequestStatus.REQUESTED,
  ReturnRequestStatus.ACCEPTED,
  ReturnRequestStatus.OUT_FOR_PICKUP,
  ReturnRequestStatus.PICKUP_CANCELLED,
  ReturnRequestStatus.PICKED_UP,
];

export async function syncReturnRequestFromOrderStatus(
  tx: Tx,
  orderId: string,
  orderStatus: OrderStatus,
) {
  if (orderStatus !== OrderStatus.RETURNED) return;

  const returnRequest = await tx.returnRequest.findFirst({
    where: {
      orderId,
      status: { in: RETURN_SYNC_FROM_ORDER },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!returnRequest) return;

  const now = new Date();
  await tx.returnRequest.update({
    where: { id: returnRequest.id },
    data: {
      status: ReturnRequestStatus.RETURNED,
      returnedAt: now,
      pickedUpAt: returnRequest.pickedUpAt ?? now,
    },
  });

  await tx.returnRequestTrackingHistory.create({
    data: {
      returnRequestId: returnRequest.id,
      status: ReturnRequestStatus.RETURNED,
      description: getReturnStatusDescription(ReturnRequestStatus.RETURNED),
    },
  });
}
