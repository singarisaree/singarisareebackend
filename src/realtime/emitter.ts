import type { Server } from 'socket.io';
import {
  REALTIME_EVENTS,
  type CustomerOrderRealtimePayload,
  type OrderRealtimePayload,
  type RefundRealtimePayload,
  type ReturnRequestRealtimePayload,
} from '@/realtime/events';
import { normalizePhoneForRealtime } from '@/realtime/phone';

const ADMIN_ROOM = 'admin';

let io: Server | null = null;

export function setSocketServer(server: Server): void {
  io = server;
}

function customerRoom(phone: string): string {
  return `customer:${normalizePhoneForRealtime(phone)}`;
}

function emitAdmin<T>(event: string, payload: T): void {
  io?.to(ADMIN_ROOM).emit(event, payload);
}

function emitCustomer<T>(phone: string, event: string, payload: T): void {
  io?.to(customerRoom(phone)).emit(event, payload);
}

export const realtime = {
  orderCreated(payload: OrderRealtimePayload) {
    emitAdmin(REALTIME_EVENTS.ORDER_CREATED, payload);
    emitAdmin(REALTIME_EVENTS.DASHBOARD_REFRESH, { at: new Date().toISOString() });
    emitCustomer<CustomerOrderRealtimePayload>(payload.customerPhone, REALTIME_EVENTS.CUSTOMER_ORDER_UPDATED, {
      orderId: payload.orderId,
      orderNumber: payload.orderNumber,
      status: payload.status,
    });
  },

  orderStatusChanged(payload: OrderRealtimePayload) {
    emitAdmin(REALTIME_EVENTS.ORDER_STATUS_CHANGED, payload);
    emitAdmin(REALTIME_EVENTS.DASHBOARD_REFRESH, { at: new Date().toISOString() });
    emitCustomer<CustomerOrderRealtimePayload>(payload.customerPhone, REALTIME_EVENTS.CUSTOMER_ORDER_UPDATED, {
      orderId: payload.orderId,
      orderNumber: payload.orderNumber,
      status: payload.status,
    });
  },

  returnRequestCreated(payload: ReturnRequestRealtimePayload) {
    emitAdmin(REALTIME_EVENTS.RETURN_REQUEST_CREATED, payload);
    emitAdmin(REALTIME_EVENTS.DASHBOARD_REFRESH, { at: new Date().toISOString() });
    emitCustomer<CustomerOrderRealtimePayload>(payload.customerPhone, REALTIME_EVENTS.CUSTOMER_ORDER_UPDATED, {
      orderId: payload.orderId,
    });
  },

  returnRequestUpdated(payload: ReturnRequestRealtimePayload) {
    emitAdmin(REALTIME_EVENTS.RETURN_REQUEST_UPDATED, payload);
    emitAdmin(REALTIME_EVENTS.DASHBOARD_REFRESH, { at: new Date().toISOString() });
    emitCustomer<CustomerOrderRealtimePayload>(payload.customerPhone, REALTIME_EVENTS.CUSTOMER_ORDER_UPDATED, {
      orderId: payload.orderId,
    });
  },

  refundProcessed(payload: RefundRealtimePayload) {
    emitAdmin(REALTIME_EVENTS.REFUND_PROCESSED, payload);
    emitAdmin(REALTIME_EVENTS.DASHBOARD_REFRESH, { at: new Date().toISOString() });
    emitCustomer<CustomerOrderRealtimePayload>(payload.customerPhone, REALTIME_EVENTS.CUSTOMER_ORDER_UPDATED, {
      orderId: payload.orderId,
      orderNumber: payload.orderNumber,
      status: 'REFUNDED',
    });
  },

  /** Broadcast to all sockets (admin + storefront guests) when catalog/stock changes. */
  catalogChanged(reason?: string) {
    io?.emit(REALTIME_EVENTS.CATALOG_CHANGED, {
      at: new Date().toISOString(),
      reason,
    });
  },
};
