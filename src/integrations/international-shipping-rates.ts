/**
 * Checkout international shipping — fixed weight slabs (INR). No Shiprocket quote at payment.
 * Admin fulfillment still uses live Shiprocket rates when creating shipments.
 */

export type InternationalWeightSlabRates = {
  /** 0–0.5 kg */
  w05: number;
  /** 0.5–1 kg */
  w1: number;
  /** 1–1.5 kg */
  w15: number;
  /** 1.5–2 kg */
  w2: number;
  /** Each additional 0.5 kg above 2 kg */
  extraPerHalfKg: number;
};

/** ISO 3166-1 alpha-2 → slab rates (INR). */
export const INTERNATIONAL_SHIPPING_RATES: Record<string, InternationalWeightSlabRates> = {
  US: { w05: 1799, w1: 2299, w15: 2799, w2: 3299, extraPerHalfKg: 500 },
  CA: { w05: 1899, w1: 2399, w15: 2899, w2: 3399, extraPerHalfKg: 550 },
  GB: { w05: 1699, w1: 2199, w15: 2699, w2: 3199, extraPerHalfKg: 450 },
  AU: { w05: 1999, w1: 2599, w15: 3199, w2: 3799, extraPerHalfKg: 600 },
  NZ: { w05: 2099, w1: 2699, w15: 3299, w2: 3899, extraPerHalfKg: 650 },
  AE: { w05: 999, w1: 1399, w15: 1799, w2: 2199, extraPerHalfKg: 350 },
  SA: { w05: 1199, w1: 1699, w15: 2199, w2: 2699, extraPerHalfKg: 400 },
  QA: { w05: 1199, w1: 1699, w15: 2199, w2: 2699, extraPerHalfKg: 400 },
  KW: { w05: 1199, w1: 1699, w15: 2199, w2: 2699, extraPerHalfKg: 400 },
  SG: { w05: 999, w1: 1399, w15: 1799, w2: 2199, extraPerHalfKg: 350 },
  MY: { w05: 1099, w1: 1599, w15: 2099, w2: 2599, extraPerHalfKg: 400 },
  JP: { w05: 1699, w1: 2199, w15: 2799, w2: 3399, extraPerHalfKg: 500 },
  KR: { w05: 1699, w1: 2199, w15: 2799, w2: 3399, extraPerHalfKg: 500 },
  HK: { w05: 999, w1: 1399, w15: 1799, w2: 2199, extraPerHalfKg: 350 },
  TH: { w05: 1199, w1: 1699, w15: 2199, w2: 2699, extraPerHalfKg: 400 },
  ID: { w05: 1399, w1: 1899, w15: 2399, w2: 2899, extraPerHalfKg: 450 },
  VN: { w05: 1399, w1: 1899, w15: 2399, w2: 2899, extraPerHalfKg: 450 },
  DE: { w05: 1799, w1: 2299, w15: 2899, w2: 3399, extraPerHalfKg: 500 },
  FR: { w05: 1799, w1: 2299, w15: 2899, w2: 3399, extraPerHalfKg: 500 },
  NL: { w05: 1799, w1: 2299, w15: 2899, w2: 3399, extraPerHalfKg: 500 },
  IT: { w05: 1799, w1: 2299, w15: 2899, w2: 3399, extraPerHalfKg: 500 },
  CH: { w05: 1999, w1: 2499, w15: 3099, w2: 3699, extraPerHalfKg: 600 },
  BE: { w05: 1799, w1: 2299, w15: 2899, w2: 3399, extraPerHalfKg: 500 },
  SE: { w05: 1899, w1: 2399, w15: 2999, w2: 3599, extraPerHalfKg: 550 },
  NO: { w05: 1999, w1: 2499, w15: 3099, w2: 3699, extraPerHalfKg: 600 },
  DK: { w05: 1899, w1: 2399, w15: 2999, w2: 3599, extraPerHalfKg: 550 },
  FI: { w05: 1999, w1: 2499, w15: 3099, w2: 3699, extraPerHalfKg: 600 },
  AT: { w05: 1899, w1: 2399, w15: 2999, w2: 3599, extraPerHalfKg: 550 },
  ZA: { w05: 1999, w1: 2499, w15: 3099, w2: 3699, extraPerHalfKg: 600 },
};

export const INTERNATIONAL_COUNTRY_CODES = Object.keys(INTERNATIONAL_SHIPPING_RATES);

/** Must match checkout country names (listShippingCountries). */
export const INTERNATIONAL_COUNTRY_NAMES = [
  'United States',
  'Canada',
  'United Kingdom',
  'Australia',
  'New Zealand',
  'United Arab Emirates',
  'Saudi Arabia',
  'Qatar',
  'Kuwait',
  'Singapore',
  'Malaysia',
  'Japan',
  'South Korea',
  'Hong Kong',
  'Thailand',
  'Indonesia',
  'Vietnam',
  'Germany',
  'France',
  'Netherlands',
  'Italy',
  'Switzerland',
  'Belgium',
  'Sweden',
  'Norway',
  'Denmark',
  'Finland',
  'Austria',
  'South Africa',
] as const;

/** Country display name → ISO (matches checkout country list). */
export const INTERNATIONAL_COUNTRY_NAME_TO_ISO: Record<string, string> = {
  'United States': 'US',
  Canada: 'CA',
  'United Kingdom': 'GB',
  Australia: 'AU',
  'New Zealand': 'NZ',
  'United Arab Emirates': 'AE',
  'Saudi Arabia': 'SA',
  Qatar: 'QA',
  Kuwait: 'KW',
  Singapore: 'SG',
  Malaysia: 'MY',
  Japan: 'JP',
  'South Korea': 'KR',
  'Hong Kong': 'HK',
  Thailand: 'TH',
  Indonesia: 'ID',
  Vietnam: 'VN',
  Germany: 'DE',
  France: 'FR',
  Netherlands: 'NL',
  Italy: 'IT',
  Switzerland: 'CH',
  Belgium: 'BE',
  Sweden: 'SE',
  Norway: 'NO',
  Denmark: 'DK',
  Finland: 'FI',
  Austria: 'AT',
  'South Africa': 'ZA',
};

export const CHECKOUT_INTERNATIONAL_COURIER_LABEL = 'International shipping';

/** Business-day range shown at checkout (e.g. "7-12" → "7–12 Business Days" in UI). */
export const INTERNATIONAL_ESTIMATED_DELIVERY_DAYS: Record<string, string> = {
  US: '7-12',
  CA: '8-14',
  GB: '6-10',
  AU: '8-14',
  NZ: '8-15',
  AE: '4-8',
  SA: '5-10',
  QA: '5-10',
  KW: '5-10',
  SG: '4-7',
  MY: '5-8',
  JP: '5-9',
  KR: '5-9',
  HK: '4-7',
  TH: '5-8',
  ID: '6-10',
  VN: '6-10',
  DE: '7-12',
  FR: '7-12',
  NL: '7-11',
  IT: '8-13',
  CH: '7-12',
  BE: '7-11',
  SE: '8-13',
  NO: '8-13',
  DK: '7-12',
  FI: '8-14',
  AT: '7-12',
  ZA: '8-15',
};

const FALLBACK_ESTIMATED_DAYS = '10-14';

export function getInternationalEstimatedDeliveryDays(countryCode: string): string {
  const code = countryCode.trim().toUpperCase();
  return INTERNATIONAL_ESTIMATED_DELIVERY_DAYS[code] ?? FALLBACK_ESTIMATED_DAYS;
}

export function isInternationalRateCountry(countryCode: string): boolean {
  const code = countryCode.trim().toUpperCase();
  return code.length === 2 && Boolean(INTERNATIONAL_SHIPPING_RATES[code]);
}

/**
 * Chargeable weight: sum of line items (grams → kg), minimum 0.5 kg for international.
 */
export function computeInternationalChargeableWeightKg(
  orderItems: Array<{ quantity: number; weight: number | null }>,
): number {
  const totalWeightGrams = orderItems.reduce(
    (sum, item) => sum + (item.weight != null ? item.weight * item.quantity : 0),
    0,
  );
  if (totalWeightGrams <= 0) return 0.5;
  return Math.max(totalWeightGrams / 1000, 0.5);
}

export function calculateInternationalShippingFee(
  countryCode: string,
  weightKg: number,
): number {
  const code = countryCode.trim().toUpperCase();
  const slabs = INTERNATIONAL_SHIPPING_RATES[code];
  if (!slabs) {
    throw new Error('UNSUPPORTED_COUNTRY');
  }

  const w = Math.max(Number(weightKg) || 0.5, 0.01);

  if (w <= 0.5) return slabs.w05;
  if (w <= 1) return slabs.w1;
  if (w <= 1.5) return slabs.w15;
  if (w <= 2) return slabs.w2;

  const above = w - 2;
  const halfKgSteps = Math.ceil(above / 0.5 - 1e-9);
  return slabs.w2 + halfKgSteps * slabs.extraPerHalfKg;
}

export function buildCheckoutInternationalQuote(countryCode: string, weightKg: number) {
  const fee = calculateInternationalShippingFee(countryCode, weightKg);
  const rounded = Math.round(fee * 100) / 100;
  return {
    courier: CHECKOUT_INTERNATIONAL_COURIER_LABEL,
    shippingFee: rounded,
    estimatedDays: getInternationalEstimatedDeliveryDays(countryCode),
    currency: 'INR' as const,
    weightKg: Math.round(weightKg * 1000) / 1000,
  };
}
