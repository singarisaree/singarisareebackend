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
