import axios, { AxiosInstance } from 'axios';
import { env } from '@/config/env';
import { logger } from '@/utils/logger';
import { ApiError } from '@/shared/api-response';

interface ShiprocketAuthResponse {
  token: string;
}

interface ShiprocketOrderPayload {
  order_id: string;
  order_date: string;
  pickup_location: string;
  billing_customer_name: string;
  billing_last_name: string;
  billing_address: string;
  billing_city: string;
  billing_pincode: string;
  billing_state: string;
  billing_country: string;
  billing_email: string;
  billing_phone: string;
  shipping_is_billing: boolean;
  order_items: Array<{
    name: string;
    sku: string;
    units: number;
    selling_price: number;
    discount: number;
    tax: number;
    hsn: number;
  }>;
  payment_method: string;
  sub_total: number;
  length: number;
  breadth: number;
  height: number;
  weight: number;
}

interface ShiprocketRateQuotePayload {
  deliveryPostalCode: string;
  weightKg: number;
  declaredValue: number;
  /** ISO Alpha-2 country code for international (Shiprocket X) quotes */
  deliveryCountryCode?: string;
  lengthCm?: number;
  breadthCm?: number;
  heightCm?: number;
}

export interface ShiprocketCourierOption {
  courierId: number;
  courierName: string;
  rate: number;
  etd: string | null;
  rating: number | null;
}

export interface ShiprocketShippingQuote {
  courier: string;
  shippingFee: number;
  estimatedDays: string;
  currency: string;
}

export interface ShiprocketCountryOption {
  id: number;
  name: string;
  isoCode: string;
  dialCode: string;
  postcodeRequired: boolean;
  postalRegex: string | null;
}

export type ShiprocketShippingMode = 'domestic' | 'international' | 'quick';

export interface ShiprocketQuickLocationPayload {
  pickupPostalCode: string;
  deliveryPostalCode: string;
  pickupLatitude: number;
  pickupLongitude: number;
  deliveryLatitude: number;
  deliveryLongitude: number;
  weightKg: number;
  declaredValue?: number;
  cod?: boolean;
}

export interface ShiprocketQuickOrderPayload extends ShiprocketQuickLocationPayload {
  orderRef: string;
  customerName: string;
  customerPhone: string;
  customerEmail?: string;
  pickupAddress: string;
  deliveryAddress: string;
  paymentMethod: string;
  subTotal: number;
  orderItems: Array<{
    name: string;
    sku: string;
    units: number;
    sellingPrice: number;
  }>;
}

export interface ShiprocketQuickQuote {
  rate: number;
  currency: string;
  etaMinutes: string | null;
  courierName: string | null;
  /** Present when quote came from courier serviceability (needed for AWB assign). */
  courierId?: number | null;
  raw: Record<string, unknown>;
}

function extractShiprocketMessage(error: unknown, fallback: string): string {
  if (!axios.isAxiosError(error)) return fallback;
  const data = error.response?.data as
    | { message?: string | string[]; errors?: Record<string, string[]> | string }
    | undefined;
  if (!data) return fallback;
  if (typeof data.message === 'string' && data.message.trim()) return data.message.trim();
  if (Array.isArray(data.message) && data.message[0]) return String(data.message[0]);
  if (typeof data.errors === 'string' && data.errors.trim()) return data.errors.trim();
  if (data.errors && typeof data.errors === 'object') {
    const first = Object.values(data.errors).flat()[0];
    if (first) return String(first);
  }
  return fallback;
}

function extractDocumentUrl(payload: Record<string, unknown>, keys: string[]): string {
  const nested = payload.data as Record<string, unknown> | unknown[] | undefined;
  const candidates: unknown[] = [payload, nested];
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    candidates.push(nested);
  }
  if (Array.isArray(nested)) {
    for (const row of nested) {
      if (row && typeof row === 'object') candidates.push(row);
    }
  }

  for (const node of candidates) {
    if (!node || typeof node !== 'object') continue;
    const record = node as Record<string, unknown>;
    for (const key of keys) {
      const raw = record[key];
      if (typeof raw === 'string' && raw.trim()) return raw.trim();
      if (Array.isArray(raw) && typeof raw[0] === 'string' && raw[0].trim()) {
        return raw[0].trim();
      }
    }
  }
  return '';
}

export class ShiprocketService {
  private client: AxiosInstance;
  private token: string | null = null;
  private tokenExpiry: Date | null = null;

  constructor() {
    this.client = axios.create({
      baseURL: 'https://apiv2.shiprocket.in/v1/external',
    });
  }

  private async authenticate(): Promise<string> {
    if (this.token && this.tokenExpiry && new Date() < this.tokenExpiry) {
      return this.token;
    }

    if (!env.SHIPROCKET_EMAIL || !env.SHIPROCKET_PASSWORD) {
      throw new ApiError(503, 'Shiprocket credentials not configured');
    }

    const response = await this.client.post<ShiprocketAuthResponse>('/auth/login', {
      email: env.SHIPROCKET_EMAIL,
      password: env.SHIPROCKET_PASSWORD,
    });

    this.token = response.data.token;
    this.tokenExpiry = new Date(Date.now() + 9 * 24 * 60 * 60 * 1000);
    return this.token;
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await this.authenticate();
    return { Authorization: `Bearer ${token}` };
  }

  async createOrder(payload: ShiprocketOrderPayload | Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const headers = await this.getAuthHeaders();
      const response = await this.client.post('/orders/create/adhoc', payload, { headers });
      const data = response.data as Record<string, unknown>;

      const shipmentId = this.extractShipmentId(data);
      if (!shipmentId) {
        const message =
          (typeof data.message === 'string' && data.message.trim()) ||
          'Shiprocket did not return a valid shipment id';
        logger.error('Shiprocket create order missing shipment id', { data });
        throw new ApiError(502, message);
      }

      return data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      logger.error('Shiprocket create order failed', {
        error: axios.isAxiosError(error) ? error.response?.data : error,
      });
      throw new ApiError(502, extractShiprocketMessage(error, 'Shiprocket order creation failed'));
    }
  }

  /** Shiprocket may return shipment_id at the top level or nested under data. */
  extractShipmentId(payload: Record<string, unknown>): number | null {
    const candidates = [
      payload.shipment_id,
      payload.shipmentId,
      (payload.data as Record<string, unknown> | undefined)?.shipment_id,
      (payload.data as Record<string, unknown> | undefined)?.shipmentId,
    ];
    for (const raw of candidates) {
      const id = parseInt(String(raw ?? ''), 10);
      if (Number.isFinite(id) && id > 0) return id;
    }
    return null;
  }

  async generateAWB(shipmentId: number, courierId: number): Promise<Record<string, unknown>> {
    try {
      const headers = await this.getAuthHeaders();
      const response = await this.client.post(
        '/courier/assign/awb',
        { shipment_id: shipmentId, courier_id: courierId },
        { headers },
      );
      return response.data as Record<string, unknown>;
    } catch (error) {
      logger.error('Shiprocket AWB generation failed', {
        error: axios.isAxiosError(error) ? error.response?.data : error,
      });
      throw new ApiError(502, extractShiprocketMessage(error, 'AWB generation failed'));
    }
  }

  async generatePickup(shipmentIds: number[], pickupDate?: string): Promise<Record<string, unknown>> {
    try {
      const headers = await this.getAuthHeaders();
      const body: { shipment_id: number[]; pickup_date?: string[] } = {
        shipment_id: shipmentIds,
      };
      if (pickupDate) {
        body.pickup_date = [pickupDate];
      }
      const response = await this.client.post('/courier/generate/pickup', body, { headers });
      return response.data as Record<string, unknown>;
    } catch (error) {
      logger.error('Shiprocket pickup generation failed', {
        error: axios.isAxiosError(error) ? error.response?.data : error,
      });
      throw new ApiError(502, extractShiprocketMessage(error, 'Pickup generation failed'));
    }
  }

  async getAvailableCouriers(payload: ShiprocketRateQuotePayload): Promise<ShiprocketCourierOption[]> {
    try {
      const headers = await this.getAuthHeaders();
      const response = await this.client.get('/courier/serviceability/', {
        headers,
        params: {
          pickup_postcode: env.SHIPROCKET_PICKUP_PINCODE,
          delivery_postcode: payload.deliveryPostalCode,
          cod: 0,
          weight: Number(payload.weightKg.toFixed(3)),
          declared_value: Math.max(payload.declaredValue, 1),
        },
      });

      const companies =
        (response.data as { data?: { available_courier_companies?: Array<Record<string, unknown>> } })
          .data?.available_courier_companies ?? [];

      const couriers = companies
        .map((company): ShiprocketCourierOption | null => {
          const courierId = Number(company.courier_company_id ?? company.id);
          const courierName = String(company.courier_name ?? company.courier_company_name ?? '').trim();
          if (!Number.isFinite(courierId) || courierId <= 0 || !courierName) return null;

          const rate =
            Number(company.rate) ||
            Number(company.freight_charge) ||
            Number(company.courier_charge) ||
            Number(company.estimated_cost) ||
            0;

          const etdRaw = company.etd ?? company.estimated_delivery_days;
          const ratingRaw = Number(company.rating);

          return {
            courierId,
            courierName,
            rate: Number.isFinite(rate) ? rate : 0,
            etd: etdRaw != null && String(etdRaw).trim() ? String(etdRaw) : null,
            rating: Number.isFinite(ratingRaw) && ratingRaw > 0 ? ratingRaw : null,
          };
        })
        .filter((c): c is ShiprocketCourierOption => c !== null)
        .sort((a, b) => a.rate - b.rate);

      return couriers;
    } catch (error) {
      logger.error('Shiprocket courier serviceability failed', {
        error: axios.isAxiosError(error) ? error.response?.data : error,
      });
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, extractShiprocketMessage(error, 'Unable to fetch available couriers'));
    }
  }

  async trackShipment(awbCode: string): Promise<Record<string, unknown>> {
    try {
      const headers = await this.getAuthHeaders();
      const response = await this.client.get(`/courier/track/awb/${awbCode}`, { headers });
      return response.data as Record<string, unknown>;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = extractShiprocketMessage(error, '');
        if (/cancel/i.test(message)) {
          return {
            cancelled: true,
            message,
            status_code: error.response?.status,
          };
        }
      }
      logger.error('Shiprocket tracking failed', { awbCode, error });
      throw new ApiError(502, 'Tracking fetch failed');
    }
  }

  async getOrderDetails(shiprocketOrderId: number): Promise<Record<string, unknown>> {
    try {
      const headers = await this.getAuthHeaders();
      const response = await this.client.get(`/orders/show/${shiprocketOrderId}`, { headers });
      return response.data as Record<string, unknown>;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = extractShiprocketMessage(error, '');
        if (/cancel/i.test(message)) {
          return { cancelled: true, message };
        }
      }
      logger.error('Shiprocket order details failed', {
        shiprocketOrderId,
        error: axios.isAxiosError(error) ? error.response?.data : error,
      });
      throw new ApiError(502, extractShiprocketMessage(error, 'Unable to fetch Shiprocket order'));
    }
  }

  /** True when Shiprocket payload / error indicates the shipment was cancelled. */
  isCancelledPayload(payload: Record<string, unknown> | null | undefined): boolean {
    if (!payload) return false;
    if (payload.cancelled === true) return true;

    const nested = [
      payload,
      payload.data as Record<string, unknown> | undefined,
      payload.tracking_data as Record<string, unknown> | undefined,
      (payload.data as Record<string, unknown> | undefined)?.tracking_data as
        | Record<string, unknown>
        | undefined,
    ].filter(Boolean) as Record<string, unknown>[];

    for (const node of nested) {
      const ids = [
        node.current_status_id,
        node.shipment_status_id,
        node.status_code,
        node.shipment_status,
        node.track_status,
      ];
      // Shiprocket uses status id 8 for Canceled
      if (ids.some((id) => Number(id) === 8)) return true;

      const texts = [
        node.current_status,
        node.shipment_status,
        node.status,
        node.status_label,
        node.message,
        node['sr-status-label'],
      ];
      if (
        texts.some((t) => {
          const s = String(t ?? '').toUpperCase();
          return s.includes('CANCEL');
        })
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Cancel shipment(s) by AWB. Safe to call if already cancelled in Shiprocket panel.
   */
  async cancelByAwbs(awbs: string[]): Promise<Record<string, unknown>> {
    const cleaned = awbs.map((a) => a.trim()).filter(Boolean);
    if (cleaned.length === 0) return {};
    try {
      const headers = await this.getAuthHeaders();
      const response = await this.client.post(
        '/orders/cancel/shipment/awbs',
        { awbs: cleaned },
        { headers },
      );
      return response.data as Record<string, unknown>;
    } catch (error) {
      logger.error('Shiprocket cancel by AWB failed', {
        awbs: cleaned,
        error: axios.isAxiosError(error) ? error.response?.data : error,
      });
      throw new ApiError(502, extractShiprocketMessage(error, 'Shiprocket shipment cancel failed'));
    }
  }

  /** Cancel Shiprocket order(s) by Shiprocket order id. */
  async cancelOrders(ids: number[]): Promise<Record<string, unknown>> {
    const cleaned = ids.filter((id) => Number.isFinite(id) && id > 0);
    if (cleaned.length === 0) return {};
    try {
      const headers = await this.getAuthHeaders();
      const response = await this.client.post('/orders/cancel', { ids: cleaned }, { headers });
      return response.data as Record<string, unknown>;
    } catch (error) {
      logger.error('Shiprocket cancel order failed', {
        ids: cleaned,
        error: axios.isAxiosError(error) ? error.response?.data : error,
      });
      throw new ApiError(502, extractShiprocketMessage(error, 'Shiprocket order cancel failed'));
    }
  }

  async getLabel(shipmentId: number): Promise<string> {
    try {
      const headers = await this.getAuthHeaders();
      const response = await this.client.post(
        '/courier/generate/label',
        { shipment_id: [shipmentId] },
        { headers },
      );
      const data = response.data as Record<string, unknown>;
      const nested = data.data as Record<string, unknown> | undefined;
      const raw = data.label_url ?? nested?.label_url;
      if (typeof raw === 'string' && raw.trim()) return raw.trim();
      if (Array.isArray(raw) && typeof raw[0] === 'string' && raw[0].trim()) {
        return raw[0].trim();
      }
      return '';
    } catch (error) {
      logger.error('Shiprocket label generation failed', { error });
      throw new ApiError(502, 'Label generation failed');
    }
  }

  async getCountries(): Promise<ShiprocketCountryOption[]> {
    try {
      const headers = await this.getAuthHeaders();
      const response = await this.client.get('/countries', { headers });
      const rows =
        (response.data as { data?: Array<Record<string, unknown>> })?.data ??
        (Array.isArray(response.data) ? (response.data as Array<Record<string, unknown>>) : []);

      return rows
        .map((row): ShiprocketCountryOption | null => {
          const name = String(row.name ?? '').trim();
          const isoCode = String(row.iso_code_2 ?? row.iso2 ?? '').trim().toUpperCase();
          if (!name || !isoCode) return null;
          const validation = row.validation as { pincode_regex?: string } | null | undefined;
          const rawRegex = validation?.pincode_regex ? String(validation.pincode_regex) : null;
          return {
            id: Number(row.id) || 0,
            name,
            isoCode,
            dialCode: String(row.isd_code ?? row.dial_code ?? '').trim() || '+',
            postcodeRequired: Number(row.postcode_required ?? 1) !== 0,
            postalRegex: rawRegex,
          };
        })
        .filter((c): c is ShiprocketCountryOption => c !== null)
        .sort((a, b) => {
          if (a.isoCode === 'IN') return -1;
          if (b.isoCode === 'IN') return 1;
          return a.name.localeCompare(b.name);
        });
    } catch (error) {
      logger.error('Shiprocket countries fetch failed', {
        error: axios.isAxiosError(error) ? error.response?.data : error,
      });
      throw new ApiError(502, extractShiprocketMessage(error, 'Unable to fetch countries'));
    }
  }

  /**
   * Quote-only: cheapest available courier. Never creates a shipment.
   * India/domestic → /courier/serviceability/
   * International (Shiprocket X) → /international/courier/serviceability
   */
  async getShippingQuote(payload: ShiprocketRateQuotePayload): Promise<ShiprocketShippingQuote> {
    const countryCode = (payload.deliveryCountryCode || 'IN').trim().toUpperCase();
    if (countryCode === 'IN') {
      return this.getDomesticShippingQuote(payload);
    }
    return this.getInternationalShippingQuote(payload);
  }

  private parseCourierRows(raw: unknown): Array<Record<string, unknown>> {
    if (!raw || typeof raw !== 'object') return [];
    const data = raw as Record<string, unknown>;
    const nested = data.data as Record<string, unknown> | unknown[] | undefined;
    if (Array.isArray(nested)) return nested as Array<Record<string, unknown>>;
    if (nested && typeof nested === 'object') {
      const companies = (nested as Record<string, unknown>).available_courier_companies;
      if (Array.isArray(companies)) return companies as Array<Record<string, unknown>>;
      const dataCompanies = (nested as Record<string, unknown>).data;
      if (Array.isArray(dataCompanies)) return dataCompanies as Array<Record<string, unknown>>;
    }
    if (Array.isArray(data.available_courier_companies)) {
      return data.available_courier_companies as Array<Record<string, unknown>>;
    }
    return [];
  }

  private mapCourierQuote(company: Record<string, unknown>): ShiprocketShippingQuote | null {
    const courierName = String(
      company.courier_name ?? company.courier_company_name ?? company.name ?? '',
    ).trim();
    const rate =
      Number(company.rate) ||
      Number(company.freight_charge) ||
      Number(company.courier_charge) ||
      Number(company.estimated_cost) ||
      Number(company.total_charges);
    if (!courierName || !Number.isFinite(rate) || rate < 0) return null;

    const etdRaw = company.etd ?? company.estimated_delivery_days ?? company.edd;
    let estimatedDays = '3-5';
    if (etdRaw != null && String(etdRaw).trim()) {
      const etd = String(etdRaw).trim();
      const range = etd.match(/(\d+)\s*[-–to]+\s*(\d+)/i);
      if (range) estimatedDays = `${range[1]}-${range[2]}`;
      else if (/^\d+$/.test(etd)) estimatedDays = etd;
      else estimatedDays = etd;
    }

    const currency = String(company.currency ?? company.rate_currency ?? 'INR').trim() || 'INR';

    return {
      courier: courierName,
      shippingFee: Math.round(rate * 100) / 100,
      estimatedDays,
      currency,
    };
  }

  private async getDomesticShippingQuote(
    payload: ShiprocketRateQuotePayload,
  ): Promise<ShiprocketShippingQuote> {
    try {
      const headers = await this.getAuthHeaders();
      const response = await this.client.get('/courier/serviceability/', {
        headers,
        params: {
          pickup_postcode: env.SHIPROCKET_PICKUP_PINCODE,
          delivery_postcode: payload.deliveryPostalCode,
          cod: 0,
          weight: Number(payload.weightKg.toFixed(3)),
          declared_value: Math.max(payload.declaredValue, 1),
        },
      });

      const quotes = this.parseCourierRows(response.data)
        .map((row) => this.mapCourierQuote(row))
        .filter((q): q is ShiprocketShippingQuote => q !== null)
        .sort((a, b) => a.shippingFee - b.shippingFee);

      if (quotes.length === 0) {
        throw new ApiError(400, 'Delivery is not available for this location.');
      }
      return quotes[0];
    } catch (error) {
      if (error instanceof ApiError) throw error;
      logger.error('Shiprocket domestic shipping quote failed', {
        error: axios.isAxiosError(error) ? error.response?.data : error,
      });
      const message = extractShiprocketMessage(error, '');
      if (/no serviceable|not available|not serviceable/i.test(message)) {
        throw new ApiError(400, 'Delivery is not available for this location.');
      }
      throw new ApiError(502, 'Unable to fetch shipping fare right now');
    }
  }

  private normalizeInternationalPostal(countryCode: string, postalCode: string): string {
    const raw = postalCode.trim().toUpperCase();
    if (countryCode === 'US') {
      // Shiprocket expects 12345 or 12345 6789 (space), not hyphen
      return raw.replace(/[^0-9]/g, '').replace(/^(\d{5})(\d{4})$/, '$1 $2');
    }
    if (countryCode === 'CA') {
      const compact = raw.replace(/[^A-Z0-9]/g, '');
      if (compact.length === 6) return `${compact.slice(0, 3)} ${compact.slice(3)}`;
      return raw;
    }
    if (countryCode === 'GB') {
      const compact = raw.replace(/\s+/g, '');
      if (compact.length > 3) return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
      return raw;
    }
    return postalCode.trim();
  }

  private async getInternationalShippingQuote(
    payload: ShiprocketRateQuotePayload,
  ): Promise<ShiprocketShippingQuote> {
    const countryCode = (payload.deliveryCountryCode || '').trim().toUpperCase();
    if (!countryCode || countryCode.length !== 2) {
      throw new ApiError(400, 'A valid destination country is required for international shipping');
    }

    const pickupPostcode = String(env.SHIPROCKET_PICKUP_PINCODE || '500035').trim();
    // Shiprocket min default weight is 0.5 kg; keep decimals (do not ceil to 1 kg)
    const weightKg = Math.max(0.5, Number(payload.weightKg) || 0.5);
    const postal = payload.deliveryPostalCode?.trim()
      ? this.normalizeInternationalPostal(countryCode, payload.deliveryPostalCode)
      : undefined;

    const baseParams: Record<string, string | number> = {
      pickup_postcode: pickupPostcode,
      delivery_country: countryCode,
      cod: 0,
      weight: Number(weightKg.toFixed(3)),
    };
    if (postal) baseParams.delivery_postcode = postal;
    if (payload.declaredValue > 0) {
      baseParams.declared_value = Math.max(payload.declaredValue, 1);
    }
    if (payload.lengthCm && payload.lengthCm > 0) baseParams.length = payload.lengthCm;
    if (payload.breadthCm && payload.breadthCm > 0) baseParams.breadth = payload.breadthCm;
    if (payload.heightCm && payload.heightCm > 0) baseParams.height = payload.heightCm;

    const endpoints = [
      '/international/courier/serviceability',
      '/courier/international/serviceability',
    ];
    // Try prepaid quote; some accounts only return Air or Surface
    const attempts: Array<Record<string, string | number>> = [
      baseParams,
      { ...baseParams, mode: 'Air' },
      { ...baseParams, mode: 'Surface' },
      // Retry with integer kg if decimal rejected
      { ...baseParams, weight: Math.max(1, Math.ceil(weightKg)) },
    ];

    let lastMessage = 'Delivery is not available for this location.';

    try {
      const headers = await this.getAuthHeaders();

      for (const endpoint of endpoints) {
        for (const params of attempts) {
          try {
            const response = await this.client.get(endpoint, { headers, params });
            const quotes = this.parseCourierRows(response.data)
              .map((row) => this.mapCourierQuote(row))
              .filter((q): q is ShiprocketShippingQuote => q !== null)
              .sort((a, b) => a.shippingFee - b.shippingFee);

            if (quotes.length > 0) {
              logger.info('Shiprocket international quote succeeded', {
                endpoint,
                countryCode,
                weight: params.weight,
                courier: quotes[0].courier,
                shippingFee: quotes[0].shippingFee,
              });
              return quotes[0];
            }
          } catch (attemptError) {
            lastMessage = extractShiprocketMessage(
              attemptError,
              'Delivery is not available for this location.',
            );
          }
        }
      }

      logger.warn('Shiprocket international quote returned no couriers', {
        countryCode,
        postal,
        weightKg,
        pickupPostcode,
        lastMessage,
      });

      // Keep user-facing copy clear; include Shiprocket reason when useful
      if (/weight/i.test(lastMessage)) {
        throw new ApiError(
          400,
          'Delivery is not available for this location. Shiprocket international (X) did not return any courier for this destination/weight. Confirm Shiprocket X is enabled on this API account and the destination is serviceable in your Shiprocket panel.',
        );
      }
      throw new ApiError(400, 'Delivery is not available for this location.');
    } catch (error) {
      if (error instanceof ApiError) throw error;
      logger.error('Shiprocket international shipping quote failed', {
        countryCode,
        error: axios.isAxiosError(error) ? error.response?.data : error,
      });
      const message = extractShiprocketMessage(error, '');
      if (/no serviceable|not available|not serviceable|given weight/i.test(message)) {
        throw new ApiError(
          400,
          'Delivery is not available for this location. Shiprocket international (X) did not return any courier for this destination. Please verify Shiprocket X is activated for API access.',
        );
      }
      throw new ApiError(502, 'Unable to fetch international shipping fare right now');
    }
  }

  async getLowestShippingRate(payload: ShiprocketRateQuotePayload): Promise<number> {
    const quote = await this.getShippingQuote(payload);
    return quote.shippingFee;
  }

  async generateInvoice(shiprocketOrderIds: number[]): Promise<Record<string, unknown>> {
    const ids = shiprocketOrderIds.filter((id) => Number.isFinite(id) && id > 0);
    if (ids.length === 0) {
      throw new ApiError(400, 'Shiprocket order id is required to generate invoice');
    }
    try {
      const headers = await this.getAuthHeaders();
      const response = await this.client.post('/orders/print/invoice', { ids }, { headers });
      return response.data as Record<string, unknown>;
    } catch (error) {
      logger.error('Shiprocket invoice generation failed', {
        ids,
        error: axios.isAxiosError(error) ? error.response?.data : error,
      });
      throw new ApiError(502, extractShiprocketMessage(error, 'Invoice generation failed'));
    }
  }

  async getInvoiceUrl(shiprocketOrderId: number): Promise<string> {
    const data = await this.generateInvoice([shiprocketOrderId]);
    const url = extractDocumentUrl(data, [
      'invoice_url',
      'invoiceUrl',
      'url',
      'pdf_url',
      'pdfUrl',
    ]);
    if (!url) {
      throw new ApiError(502, 'Shiprocket did not return an invoice URL');
    }
    return url;
  }

  async generateManifest(shipmentIds: number[]): Promise<Record<string, unknown>> {
    const ids = shipmentIds.filter((id) => Number.isFinite(id) && id > 0);
    if (ids.length === 0) {
      throw new ApiError(400, 'Shipment id is required to generate manifest');
    }
    try {
      const headers = await this.getAuthHeaders();
      const response = await this.client.post(
        '/manifests/generate',
        { shipment_id: ids },
        { headers },
      );
      return response.data as Record<string, unknown>;
    } catch (error) {
      logger.error('Shiprocket manifest generation failed', {
        ids,
        error: axios.isAxiosError(error) ? error.response?.data : error,
      });
      throw new ApiError(502, extractShiprocketMessage(error, 'Manifest generation failed'));
    }
  }

  async getManifestUrl(shipmentId: number): Promise<string> {
    const data = await this.generateManifest([shipmentId]);
    const url = extractDocumentUrl(data, [
      'manifest_url',
      'manifestUrl',
      'url',
      'pdf_url',
      'pdfUrl',
    ]);
    if (!url) {
      throw new ApiError(502, 'Shiprocket did not return a manifest URL');
    }
    return url;
  }

  async getInternationalCouriers(
    payload: ShiprocketRateQuotePayload,
  ): Promise<ShiprocketCourierOption[]> {
    const countryCode = (payload.deliveryCountryCode || '').trim().toUpperCase();
    if (!countryCode || countryCode.length !== 2) {
      throw new ApiError(400, 'Destination country code is required for international couriers');
    }

    const pickupPostcode = String(env.SHIPROCKET_PICKUP_PINCODE || '500035').trim();
    const weightKg = Math.max(0.5, Number(payload.weightKg) || 0.5);
    const params: Record<string, string | number> = {
      pickup_postcode: pickupPostcode,
      delivery_country: countryCode,
      cod: 0,
      weight: Number(weightKg.toFixed(3)),
      declared_value: Math.max(payload.declaredValue, 1),
    };
    if (payload.deliveryPostalCode?.trim()) {
      params.delivery_postcode = payload.deliveryPostalCode.trim();
    }
    if (payload.lengthCm && payload.lengthCm > 0) params.length = payload.lengthCm;
    if (payload.breadthCm && payload.breadthCm > 0) params.breadth = payload.breadthCm;
    if (payload.heightCm && payload.heightCm > 0) params.height = payload.heightCm;

    try {
      const headers = await this.getAuthHeaders();
      const response = await this.client.get('/international/courier/serviceability', {
        headers,
        params,
      });
      const couriers = this.parseCourierRows(response.data)
        .map((row): ShiprocketCourierOption | null => {
          const courierId = Number(row.courier_company_id ?? row.id ?? row.courier_id);
          const courierName = String(
            row.courier_name ?? row.courier_company_name ?? row.name ?? '',
          ).trim();
          if (!Number.isFinite(courierId) || courierId <= 0 || !courierName) return null;
          const rate =
            Number(row.rate) ||
            Number(row.freight_charge) ||
            Number(row.courier_charge) ||
            Number(row.estimated_cost) ||
            Number(row.total_charges) ||
            0;
          const etdRaw = row.etd ?? row.estimated_delivery_days ?? row.edd;
          const ratingRaw = Number(row.rating);
          return {
            courierId,
            courierName,
            rate: Number.isFinite(rate) ? rate : 0,
            etd: etdRaw != null && String(etdRaw).trim() ? String(etdRaw) : null,
            rating: Number.isFinite(ratingRaw) && ratingRaw > 0 ? ratingRaw : null,
          };
        })
        .filter((c): c is ShiprocketCourierOption => c !== null)
        .sort((a, b) => a.rate - b.rate);

      return couriers;
    } catch (error) {
      logger.error('Shiprocket international courier serviceability failed', {
        countryCode,
        error: axios.isAxiosError(error) ? error.response?.data : error,
      });
      throw new ApiError(
        502,
        extractShiprocketMessage(error, 'Unable to fetch international couriers'),
      );
    }
  }

  async createInternationalForwardShipment(
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    try {
      const headers = await this.getAuthHeaders();
      const response = await this.client.post(
        '/international/shipments/create/forward-shipment',
        payload,
        { headers },
      );
      const data = response.data as Record<string, unknown>;
      const shipmentId = this.extractShipmentId(data);
      if (!shipmentId) {
        const message =
          (typeof data.message === 'string' && data.message.trim()) ||
          'Shiprocket did not return a valid international shipment id';
        logger.error('Shiprocket international shipment missing shipment id', { data });
        throw new ApiError(502, message);
      }
      return data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      logger.error('Shiprocket international forward shipment failed', {
        error: axios.isAxiosError(error) ? error.response?.data : error,
      });
      throw new ApiError(
        502,
        extractShiprocketMessage(error, 'International shipment creation failed'),
      );
    }
  }

  async updateInternationalOrder(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const headers = await this.getAuthHeaders();
      const response = await this.client.post('/international/orders/update/adhoc', payload, {
        headers,
      });
      return response.data as Record<string, unknown>;
    } catch (error) {
      logger.error('Shiprocket international order update failed', {
        error: axios.isAxiosError(error) ? error.response?.data : error,
      });
      throw new ApiError(
        502,
        extractShiprocketMessage(error, 'International order update failed'),
      );
    }
  }

  async assignInternationalAWB(
    shipmentId: number,
    courierId: number,
  ): Promise<Record<string, unknown>> {
    try {
      const headers = await this.getAuthHeaders();
      const response = await this.client.post(
        '/international/courier/assign/awb',
        { shipment_id: shipmentId, courier_id: courierId },
        { headers },
      );
      return response.data as Record<string, unknown>;
    } catch (error) {
      logger.error('Shiprocket international AWB assignment failed', {
        shipmentId,
        courierId,
        error: axios.isAxiosError(error) ? error.response?.data : error,
      });
      throw new ApiError(
        502,
        extractShiprocketMessage(error, 'International AWB assignment failed'),
      );
    }
  }

  private buildQuickLocationBody(payload: ShiprocketQuickLocationPayload): Record<string, unknown> {
    return {
      pickup_pincode: payload.pickupPostalCode,
      delivery_pincode: payload.deliveryPostalCode,
      pickup_postcode: payload.pickupPostalCode,
      delivery_postcode: payload.deliveryPostalCode,
      lat_from: payload.pickupLatitude,
      long_from: payload.pickupLongitude,
      lat_to: payload.deliveryLatitude,
      long_to: payload.deliveryLongitude,
      pickup_latitude: payload.pickupLatitude,
      pickup_longitude: payload.pickupLongitude,
      delivery_latitude: payload.deliveryLatitude,
      delivery_longitude: payload.deliveryLongitude,
      weight: Number(payload.weightKg.toFixed(3)),
      cod: payload.cod ? 1 : 0,
      ...(payload.declaredValue != null && payload.declaredValue > 0
        ? { declared_value: Math.max(payload.declaredValue, 1) }
        : {}),
    };
  }

  private mapQuickQuote(data: Record<string, unknown>): ShiprocketQuickQuote {
    const nested = data.data as Record<string, unknown> | undefined;
    // Hyperlocal quotes come as array rows; dedicated /quick/quote wraps under data object
    const node =
      nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : data;
    const rate =
      Number(node.freight_charge) ||
      Number(node.rate) ||
      Number(node.rates) || // Shiprocket Quick hyperlocal uses `rates`
      Number(node.delivery_charge) ||
      Number(node.total_amount) ||
      Number(node.amount) ||
      0;
    const etdHours = Number(node.etd_hours);
    const etaFromHours =
      Number.isFinite(etdHours) && etdHours > 0
        ? etdHours === 1
          ? 'About 1 hour'
          : `About ${etdHours} hours`
        : null;
    const etaRaw =
      etaFromHours ??
      node.eta ??
      node.etd ??
      node.estimated_delivery_time ??
      node.estimated_time ??
      node.delivery_time;
    const courierNameRaw = node.courier_name ?? node.partner_name ?? node.service_name;
    const courierIdRaw = Number(node.courier_company_id ?? node.courier_id ?? node.id);
    return {
      rate: Number.isFinite(rate) ? Math.round(rate * 100) / 100 : 0,
      currency: String(node.currency ?? 'INR').trim() || 'INR',
      etaMinutes: etaRaw != null && String(etaRaw).trim() ? String(etaRaw) : null,
      courierName:
        typeof courierNameRaw === 'string' && courierNameRaw.trim() ? courierNameRaw.trim() : null,
      courierId:
        Number.isFinite(courierIdRaw) && courierIdRaw > 0 ? courierIdRaw : null,
      raw: data,
    };
  }

  /**
   * Instant / Shiprocket Quick — quote only via official Hyperlocal API:
   * POST /v1/external/quick/quote
   */
  async quoteQuickDelivery(
    payload: ShiprocketQuickLocationPayload,
  ): Promise<ShiprocketQuickQuote> {
    const headers = await this.getAuthHeaders();
    const body = this.buildQuickLocationBody(payload);

    try {
      const response = await this.client.post('/quick/quote', body, { headers });
      const quote = this.mapQuickQuote(response.data as Record<string, unknown>);
      if (!Number.isFinite(quote.rate) || quote.rate < 0) {
        throw new ApiError(400, 'Shiprocket Quick returned an invalid delivery charge');
      }
      return {
        ...quote,
        courierName: quote.courierName || 'Shiprocket Quick',
        courierId: quote.courierId ?? 1,
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      logger.error('Shiprocket Quick quote failed', {
        status,
        error: axios.isAxiosError(error) ? error.response?.data : error,
      });
      if (status === 404) {
        throw new ApiError(
          502,
          'Shiprocket Quick API is not enabled on this account (POST /quick/quote → 404). Ask Shiprocket to activate Hyperlocal Quick, then retry Instant.',
        );
      }
      throw new ApiError(
        502,
        extractShiprocketMessage(error, 'Unable to calculate Instant (Shiprocket Quick) delivery charge'),
      );
    }
  }

  /**
   * Instant create — official Hyperlocal API only:
   * POST /v1/external/quick/orders
   */
  async createQuickDelivery(payload: ShiprocketQuickOrderPayload): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      ...this.buildQuickLocationBody(payload),
      order_id: payload.orderRef,
      pickup_address: payload.pickupAddress,
      delivery_address: payload.deliveryAddress,
      customer_name: payload.customerName,
      customer_phone: payload.customerPhone,
      payment_method: payload.paymentMethod,
      sub_total: payload.subTotal,
      order_items: payload.orderItems.map((item) => ({
        name: item.name,
        sku: item.sku,
        units: item.units,
        selling_price: item.sellingPrice,
      })),
    };
    if (payload.customerEmail?.trim()) {
      body.customer_email = payload.customerEmail.trim();
    }

    try {
      const headers = await this.getAuthHeaders();
      const response = await this.client.post('/quick/orders', body, { headers });
      return response.data as Record<string, unknown>;
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      logger.error('Shiprocket Quick order creation failed', {
        status,
        error: axios.isAxiosError(error) ? error.response?.data : error,
      });
      if (status === 404) {
        throw new ApiError(
          502,
          'Shiprocket Quick API is not enabled on this account (POST /quick/orders → 404). Ask Shiprocket to activate Hyperlocal Quick before creating Instant shipments.',
        );
      }
      throw new ApiError(502, extractShiprocketMessage(error, 'Quick delivery creation failed'));
    }
  }

  extractQuickOrderId(payload: Record<string, unknown>): string | null {
    const candidates = [
      payload.order_id,
      payload.quick_order_id,
      payload.id,
      (payload.data as Record<string, unknown> | undefined)?.order_id,
      (payload.data as Record<string, unknown> | undefined)?.quick_order_id,
      (payload.data as Record<string, unknown> | undefined)?.id,
    ];
    for (const raw of candidates) {
      const value = String(raw ?? '').trim();
      if (value) return value;
    }
    return null;
  }

  /** GET /v1/external/quick/orders/{order_id} — Track Rider */
  async trackQuickOrder(quickOrderId: string): Promise<Record<string, unknown>> {
    const id = quickOrderId.trim();
    if (!id) throw new ApiError(400, 'Quick order id is required');
    try {
      const headers = await this.getAuthHeaders();
      const response = await this.client.get(`/quick/orders/${encodeURIComponent(id)}`, { headers });
      return response.data as Record<string, unknown>;
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      logger.error('Shiprocket Quick tracking failed', {
        quickOrderId: id,
        status,
        error: axios.isAxiosError(error) ? error.response?.data : error,
      });
      if (status === 404) {
        throw new ApiError(
          502,
          'Shiprocket Quick track API is not available (GET /quick/orders/{id} → 404).',
        );
      }
      throw new ApiError(502, extractShiprocketMessage(error, 'Quick delivery tracking failed'));
    }
  }

  /** POST /v1/external/quick/orders/{order_id}/cancel */
  async cancelQuickDelivery(quickOrderId: string): Promise<Record<string, unknown>> {
    const id = quickOrderId.trim();
    if (!id) throw new ApiError(400, 'Quick order id is required');
    try {
      const headers = await this.getAuthHeaders();
      const response = await this.client.post(
        `/quick/orders/${encodeURIComponent(id)}/cancel`,
        {},
        { headers },
      );
      return response.data as Record<string, unknown>;
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      logger.error('Shiprocket Quick cancel failed', {
        quickOrderId: id,
        status,
        error: axios.isAxiosError(error) ? error.response?.data : error,
      });
      if (status === 404) {
        throw new ApiError(
          502,
          'Shiprocket Quick cancel API is not available (POST /quick/orders/{id}/cancel → 404).',
        );
      }
      throw new ApiError(502, extractShiprocketMessage(error, 'Quick delivery cancel failed'));
    }
  }
}

export const shiprocketService = new ShiprocketService();
