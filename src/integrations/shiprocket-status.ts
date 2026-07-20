import type { OrderStatus } from '@prisma/client';

/**
 * Map Shiprocket tracking webhook / track API payloads to our order statuses.
 * Returns null when the payload has no actionable forward status.
 */
export function mapShiprocketPayloadToOrderStatus(
  payload: Record<string, unknown> | null | undefined,
): OrderStatus | null {
  if (!payload) return null;

  const nodes = flattenTrackingNodes(payload);
  for (const node of nodes) {
    const mapped = mapNodeToStatus(node);
    if (mapped) return mapped;
  }
  return null;
}

/** Whether Shiprocket-driven status may replace the current order status. */
export function canApplyShiprocketFulfillmentStatus(
  from: OrderStatus,
  to: OrderStatus,
): boolean {
  if (from === to) return false;
  if (to === 'RTO') {
    return from === 'READY_TO_SHIP' || from === 'SHIPPED' || from === 'IN_TRANSIT';
  }
  const fromRank = FULFILLMENT_RANK[from];
  const toRank = FULFILLMENT_RANK[to];
  if (fromRank == null || toRank == null) return false;
  return toRank > fromRank;
}

const FULFILLMENT_RANK: Partial<Record<OrderStatus, number>> = {
  READY_TO_SHIP: 1,
  SHIPPED: 2,
  IN_TRANSIT: 3,
  DELIVERED: 4,
};

function flattenTrackingNodes(payload: Record<string, unknown>): Record<string, unknown>[] {
  const data = payload.data as Record<string, unknown> | undefined;
  const trackingData =
    (payload.tracking_data as Record<string, unknown> | undefined) ||
    (data?.tracking_data as Record<string, unknown> | undefined);

  return [payload, data, trackingData].filter(Boolean) as Record<string, unknown>[];
}

function mapNodeToStatus(node: Record<string, unknown>): OrderStatus | null {
  const ids = [
    node.current_status_id,
    node.shipment_status_id,
    node.status_code,
    node.sr_status,
    node.track_status,
  ]
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n));

  // Common Shiprocket shipment status ids
  if (ids.some((id) => id === 7)) return 'DELIVERED';
  if (ids.some((id) => [9, 10, 14, 40, 41, 42].includes(id))) return 'RTO';
  if (ids.some((id) => [17, 18, 19, 20, 21, 22].includes(id))) return 'IN_TRANSIT';
  if (ids.some((id) => [4, 5, 6, 15, 16].includes(id))) return 'SHIPPED';

  const text = [
    node.current_status,
    node.shipment_status,
    node.status,
    node.status_label,
    node['sr-status'],
    node['sr-status-label'],
  ]
    .map((t) => String(t ?? '').toUpperCase())
    .join(' | ');

  if (!text.trim()) return null;

  if (/\bRTO\b|RETURN TO ORIGIN|RETURNED TO SELLER|RETURNED TO ORIGIN/.test(text)) {
    return 'RTO';
  }
  if (/DELIVERED|DELIVERY COMPLETED/.test(text)) return 'DELIVERED';
  if (/OUT FOR DELIVERY|\bOFD\b|IN TRANSIT|IN_TRANSIT|REACHED DESTINATION|AT DESTINATION/.test(text)) {
    return 'IN_TRANSIT';
  }
  if (/PICKED UP|PICKED_UP|SHIPPED|MANIFESTED|IN TRANSIT TO/.test(text)) return 'SHIPPED';

  return null;
}
