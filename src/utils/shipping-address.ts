import {
  INTERNATIONAL_COUNTRY_NAME_TO_ISO,
  INTERNATIONAL_SHIPPING_RATES,
} from '@/integrations/international-shipping-rates';

/** Whether the order ships within India (returns are India-only). */
export function isIndiaShippingAddressFromJson(shippingAddress: unknown): boolean {
  const address = (shippingAddress ?? {}) as {
    country?: string;
    countryCode?: string;
    postalCode?: string;
  };
  const code = (address.countryCode || '').trim().toUpperCase();
  if (code === 'IN') return true;
  const country = (address.country || '').trim().toLowerCase();
  const postalCode = (address.postalCode || '').trim();
  const isIndia = country === 'india' || country === 'in' || country === 'bharat';
  const looksLikeIndianPincode = /^\d{6}$/.test(postalCode);

  if (isIndia) return true;
  if (!country && !code && looksLikeIndianPincode) return true;
  if (!country && !code && !postalCode) return true;
  return false;
}

export function isInternationalShippingAddressFromJson(shippingAddress: unknown): boolean {
  return !isIndiaShippingAddressFromJson(shippingAddress);
}

/** ISO 3166-1 alpha-2 for Shiprocket / filters (never default intl → IN). */
export function resolveShippingCountryIsoCode(address: {
  country?: string;
  countryCode?: string;
  postalCode?: string;
}): string {
  const code = (address.countryCode || '').trim().toUpperCase();
  if (code.length === 2) return code;

  const countryRaw = (address.country || '').trim();
  const countryLower = countryRaw.toLowerCase();
  if (countryLower === 'india' || countryLower === 'in' || countryLower === 'bharat') {
    return 'IN';
  }

  if (countryRaw) {
    const exact = INTERNATIONAL_COUNTRY_NAME_TO_ISO[countryRaw];
    if (exact) return exact;
    for (const [name, iso] of Object.entries(INTERNATIONAL_COUNTRY_NAME_TO_ISO)) {
      if (name.toLowerCase() === countryLower) return iso;
    }
  }

  const postal = (address.postalCode || '').trim();
  if (!countryRaw && !code && /^\d{6}$/.test(postal)) return 'IN';

  return '';
}

export function isSupportedInternationalCountryCode(code: string): boolean {
  const c = code.trim().toUpperCase();
  return c.length === 2 && Boolean(INTERNATIONAL_SHIPPING_RATES[c]);
}
