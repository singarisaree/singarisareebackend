export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function generateOrderNumber(): string {
  // Short customer-facing order ID (8 chars). Displayed as-is across the app.
  const time = Date.now().toString(36).toUpperCase().slice(-4);
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${time}${random}`;
}

/** Last 8 characters — consistent short order ID for UI / WhatsApp / prints. */
export function formatShortOrderNumber(orderNumber: string): string {
  if (!orderNumber) return '';
  return orderNumber.length > 8 ? orderNumber.slice(-8) : orderNumber;
}

export function generateSku(categoryCode: string): string {
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `${categoryCode}-${random}`;
}

export function calculateSoldCount(baseSoldCount: number, actualSold: number): number {
  return baseSoldCount + actualSold;
}

/** Storefront display boost — random default between 68 and 180 */
export function randomBaseSoldCount(min = 68, max = 180): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function formatCurrency(amount: number | string): string {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  const formatted = new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(num);
  return `Rs. ${formatted}`;
}

export function calculateDiscountedPrice(
  price: number,
  discountPercent: number,
): number {
  return Math.round(price - (price * discountPercent) / 100);
}

export function calculateTax(subtotal: number, taxRate = 0.18): number {
  return Math.round(subtotal * taxRate * 100) / 100;
}

export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function parsePagination(query: {
  page?: string;
  limit?: string;
}): { page: number; limit: number; skip: number } {
  const page = Math.max(1, parseInt(query.page || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

/** Inclusive createdAt range from `startDate` / `endDate` (YYYY-MM-DD or ISO). */
export function parseCreatedAtFilter(query: {
  startDate?: string;
  endDate?: string;
}): { gte?: Date; lte?: Date } | undefined {
  const range: { gte?: Date; lte?: Date } = {};

  if (query.startDate?.trim()) {
    const start = new Date(query.startDate.trim());
    if (!Number.isNaN(start.getTime())) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(query.startDate.trim())) {
        start.setUTCHours(0, 0, 0, 0);
      }
      range.gte = start;
    }
  }

  if (query.endDate?.trim()) {
    const end = new Date(query.endDate.trim());
    if (!Number.isNaN(end.getTime())) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(query.endDate.trim())) {
        end.setUTCHours(23, 59, 59, 999);
      }
      range.lte = end;
    }
  }

  return range.gte || range.lte ? range : undefined;
}

export function sanitizeString(input: string): string {
  return input.replace(/<[^>]*>/g, '').trim();
}

export function omit<T extends Record<string, unknown>, K extends keyof T>(
  obj: T,
  keys: K[],
): Omit<T, K> {
  const result = { ...obj };
  keys.forEach((key) => delete result[key]);
  return result;
}

export function pick<T extends Record<string, unknown>, K extends keyof T>(
  obj: T,
  keys: K[],
): Pick<T, K> {
  const result = {} as Pick<T, K>;
  keys.forEach((key) => {
    if (key in obj) result[key] = obj[key];
  });
  return result;
}
