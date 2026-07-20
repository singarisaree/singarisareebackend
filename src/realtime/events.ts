export const REALTIME_EVENTS = {
  ORDER_CREATED: 'order:created',
  ORDER_STATUS_CHANGED: 'order:status-changed',
  RETURN_REQUEST_CREATED: 'return-request:created',
  RETURN_REQUEST_UPDATED: 'return-request:updated',
  REFUND_PROCESSED: 'refund:processed',
  DASHBOARD_REFRESH: 'dashboard:refresh',
  CATALOG_CHANGED: 'catalog:changed',
  CUSTOMER_ORDER_UPDATED: 'customer:order-updated',
  CUSTOMER_SUBSCRIBE: 'customer:subscribe',
  CUSTOMER_UNSUBSCRIBE: 'customer:unsubscribe',
  ADMIN_JOIN: 'admin:join',
  CONNECTION_READY: 'connection:ready',
} as const;

export type RealtimeEvent = (typeof REALTIME_EVENTS)[keyof typeof REALTIME_EVENTS];

export interface OrderRealtimePayload {
  orderId: string;
  orderNumber: string;
  status: string;
  customerPhone: string;
  grandTotal?: number;
}

export interface ReturnRequestRealtimePayload {
  returnRequestId: string;
  orderId: string;
  orderNumber?: string;
  status: string;
  customerPhone: string;
}

export interface RefundRealtimePayload {
  orderId: string;
  orderNumber: string;
  customerPhone: string;
  refundAmount: number;
}

export interface CustomerOrderRealtimePayload {
  orderId: string;
  orderNumber?: string;
  status?: string;
}
