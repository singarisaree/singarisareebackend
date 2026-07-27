import { Prisma } from '@prisma/client';
import {
  INTERNATIONAL_COUNTRY_CODES,
  INTERNATIONAL_COUNTRY_NAMES,
} from '@/integrations/international-shipping-rates';

const INDIA_ADDRESS_OR: Prisma.OrderWhereInput[] = [
  { shippingAddress: { path: ['countryCode'], equals: 'IN' } },
  { shippingAddress: { path: ['country'], equals: 'India' } },
  { shippingAddress: { path: ['country'], equals: 'india' } },
  { shippingAddress: { path: ['country'], equals: 'IN' } },
  { shippingAddress: { path: ['country'], equals: 'Bharat' } },
  { shippingAddress: { path: ['country'], equals: 'bharat' } },
];

/** Standard (non-Instant) — includes missing preferredShipping on older orders. */
const NON_QUICK_SHIPPING_OR: Prisma.OrderWhereInput[] = [
  { shippingAddress: { path: ['preferredShipping'], equals: Prisma.DbNull } },
  { shippingAddress: { path: ['preferredShipping'], equals: Prisma.JsonNull } },
  { shippingAddress: { path: ['preferredShipping'], equals: 'STANDARD' } },
];

function internationalAddressOr(): Prisma.OrderWhereInput[] {
  const byCode = INTERNATIONAL_COUNTRY_CODES.map(
    (code): Prisma.OrderWhereInput => ({
      shippingAddress: { path: ['countryCode'], equals: code },
    }),
  );
  const byName = INTERNATIONAL_COUNTRY_NAMES.map(
    (name): Prisma.OrderWhereInput => ({
      shippingAddress: { path: ['country'], equals: name },
    }),
  );
  return [...byCode, ...byName];
}

/**
 * Admin list / dispatch filters by delivery type.
 * Avoid `NOT` on JSON paths — Prisma omits rows missing keys.
 */
export function buildOrderDeliveryTypeFilter(
  deliveryType?: string,
): Prisma.OrderWhereInput | null {
  const type = (deliveryType || 'ALL').trim().toUpperCase();
  if (type === 'ALL') return null;

  if (type === 'QUICK') {
    return { shippingAddress: { path: ['preferredShipping'], equals: 'QUICK' } };
  }

  if (type === 'INDIA') {
    return {
      AND: [{ OR: INDIA_ADDRESS_OR }, { OR: NON_QUICK_SHIPPING_OR }],
    };
  }

  if (type === 'INTERNATIONAL') {
    return {
      AND: [{ OR: NON_QUICK_SHIPPING_OR }, { OR: internationalAddressOr() }],
    };
  }

  return null;
}
