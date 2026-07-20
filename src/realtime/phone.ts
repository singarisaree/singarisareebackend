/**
 * Normalize phone for Socket.IO customer rooms.
 * India 10-digit stays as-is (strip leading 91). International uses full digit string.
 */
export function normalizePhoneForRealtime(phone: string): string {
  const cleaned = phone.replace(/\D/g, '');
  if (!cleaned) return '';
  if (cleaned.length === 12 && cleaned.startsWith('91')) return cleaned.slice(2);
  if (cleaned.length === 11 && cleaned.startsWith('0')) return cleaned.slice(1);
  return cleaned;
}

export function isValidRealtimePhone(normalized: string): boolean {
  if (!normalized) return false;
  // India mobile
  if (/^[6-9]\d{9}$/.test(normalized)) return true;
  // International E.164 digits (8–15)
  return normalized.length >= 8 && normalized.length <= 15;
}
