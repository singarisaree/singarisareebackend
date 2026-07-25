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
  // Prefer current_status_id — Hyper-Local docs reuse some shipment_status_id values differently
  const currentId = Number(node.current_status_id);
  if (Number.isFinite(currentId)) {
    if (currentId === 7) return 'DELIVERED';
    if ([16, 45, 55].includes(currentId)) return 'RTO';
    if ([19, 94].includes(currentId)) return 'IN_TRANSIT'; // OFD / rider reached drop
    if ([34, 51, 91, 93, 95].includes(currentId)) return 'SHIPPED'; // pickup / rider stages
    // 1 NEW, 5 CANCELED — no forward fulfillment mapping
  }

  const ids = [
    node.shipment_status_id,
    node.status_code,
    node.sr_status,
    node.track_status,
  ]
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n));

  // Common Shiprocket shipment status ids (+ Hyper-Local shipment_status_id values)
  if (ids.some((id) => id === 7)) return 'DELIVERED';
  if (ids.some((id) => [9, 10, 14, 16, 40, 41, 42, 46].includes(id))) return 'RTO';
  if (ids.some((id) => [17, 18, 20, 21, 22, 82].includes(id))) return 'IN_TRANSIT';
  if (ids.some((id) => [4, 5, 6, 15, 19, 79, 81].includes(id))) return 'SHIPPED';

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
  if (
    /OUT FOR DELIVERY|\bOFD\b|IN TRANSIT|IN_TRANSIT|REACHED DESTINATION|AT DESTINATION|RIDER REACHED DROP/.test(
      text,
    )
  ) {
    return 'IN_TRANSIT';
  }
  if (
    /PICKED UP|PICKED_UP|SHIPPED|MANIFESTED|IN TRANSIT TO|RIDER ASSIGNED|OUT FOR PICKUP|RIDER REACHED PICKUP|SEARCHING FOR RIDER/.test(
      text,
    )
  ) {
    return 'SHIPPED';
  }

  return null;
}
