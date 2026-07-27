import { addDays } from '@/utils/helpers';

/** Parse Shiprocket ETA strings like "5-7", "7 days", "About 1 hour" → whole days (min 0). */
export function parseEstimatedDeliveryDays(
  estimatedDays: string | null | undefined,
  fallback: number,
): number {
  const raw = String(estimatedDays ?? '').trim();
  if (!raw) return Math.max(1, fallback);
  if (/hour|minute|same.?day|today/i.test(raw)) return 0;
  const range = raw.match(/(\d+)\s*[-–to]+\s*(\d+)/i);
  if (range) {
    const upper = Number(range[2]);
    return Number.isFinite(upper) && upper > 0 ? upper : Math.max(1, fallback);
  }
  const single = raw.match(/(\d+)/);
  if (single) {
    const days = Number(single[1]);
    return Number.isFinite(days) && days > 0 ? days : Math.max(1, fallback);
  }
  return Math.max(1, fallback);
}

/** Normalize Shiprocket ETD for storage and customer-facing copy. */
export function normalizeShiprocketEtdLabel(etdRaw: string | null | undefined): string | null {
  if (etdRaw == null) return null;
  const etd = String(etdRaw).trim();
  if (!etd) return null;
  const range = etd.match(/(\d+)\s*[-–to]+\s*(\d+)/i);
  if (range) return `${range[1]}-${range[2]}`;
  if (/^\d+$/.test(etd)) return etd;
  return etd;
}

export function estimatedDeliveryDateFromEtd(
  etd: string | null | undefined,
  options?: { fallbackDays?: number; fromDate?: Date },
): Date {
  const fallbackDays = Math.max(1, options?.fallbackDays ?? 7);
  const from = options?.fromDate ?? new Date();
  const days = parseEstimatedDeliveryDays(etd, fallbackDays);
  return addDays(from, days);
}
