import axios, { AxiosInstance } from 'axios';
import { randomInt } from 'crypto';
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
  courierCompanyId?: number;
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

export interface ShiprocketHyperlocalOtps {
  /** 4-digit OTP verified on the rider app at pickup */
  pickupOtp: string;
  /** 4-digit OTP verified on the rider app at drop */
  dropOtp: string;
  /** 4-digit OTP verified on the rider app for RTO */
  rtoOtp: string;
}

export interface ShiprocketQuickOrderPayload extends ShiprocketQuickLocationPayload {
  orderRef: string;
  customerName: string;
  customerPhone: string;
  customerEmail?: string;
  /** Shiprocket pickup location name (from panel / addpickup). */
  pickupLocation: string;
  billingAddress: string;
  billingAddress2?: string;
  billingCity: string;
  billingState: string;
  billingCountry: string;
  billingPincode: string;
  paymentMethod: string;
  subTotal: number;
  lengthCm: number;
  breadthCm: number;
  heightCm: number;
  orderDate?: string;
  /** Hyper-Local rider verification OTPs (4 digits each). Generated if omitted. */
  otps?: Partial<ShiprocketHyperlocalOtps>;
  orderItems: Array<{
    name: string;
    sku: string;
    units: number;
    sellingPrice: number;
    /** Mandatory for Hyper-Local — Clothes | Electronics | Medicines | Food | Documents | Groceries | Others */
    categoryName?: string;
    hsn?: number;
  }>;
}

/** Cryptographically random 4-digit OTP (1000–9999) for Hyper-Local rider verification. */
export function generateHyperlocalOtp(): string {
  return String(randomInt(1000, 10000));
}

export function generateHyperlocalOtps(): ShiprocketHyperlocalOtps {
  const pickupOtp = generateHyperlocalOtp();
  let dropOtp = generateHyperlocalOtp();
  while (dropOtp === pickupOtp) dropOtp = generateHyperlocalOtp();
  let rtoOtp = generateHyperlocalOtp();
  while (rtoOtp === pickupOtp || rtoOtp === dropOtp) rtoOtp = generateHyperlocalOtp();
  return { pickupOtp, dropOtp, rtoOtp };
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

  /**
   * Assign AWB. For Hyper-Local Instant, omit courierId — Shiprocket Quick is selected
   * server-side. Passing a courier_id on HL shipments returns an error.
   */
  async generateAWB(shipmentId: number, courierId?: number): Promise<Record<string, unknown>> {
    try {
      const headers = await this.getAuthHeaders();
      const body: Record<string, unknown> = { shipment_id: shipmentId };
      if (courierId != null && courierId > 0) {
        body.courier_id = courierId;
      }
      const response = await this.client.post('/courier/assign/awb', body, { headers });
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
    const quotes = await this.listInternationalShippingQuotes(payload);
    if (!quotes.length) {
      throw new ApiError(400, 'Delivery is not available for this location.');
    }
    return quotes[0];
  }

  /** Up to 3 cheapest distinct international couriers (Shiprocket X). */
  async listInternationalShippingQuotes(
    payload: ShiprocketRateQuotePayload,
  ): Promise<ShiprocketShippingQuote[]> {
    const countryCode = (payload.deliveryCountryCode || '').trim().toUpperCase();
    if (!countryCode || countryCode.length !== 2) {
      throw new ApiError(400, 'A valid destination country is required for international shipping');
    }

    try {
      const { rows, lastMessage } = await this.collectInternationalServiceabilityRows(payload);
      const byCourier = new Map<string, ShiprocketShippingQuote>();
      for (const row of rows) {
        const quote = this.mapCourierQuote(row);
        if (!quote) continue;
        const key = quote.courier.trim().toLowerCase();
        const existing = byCourier.get(key);
        if (!existing || quote.shippingFee < existing.shippingFee) {
          byCourier.set(key, quote);
        }
      }

      const sorted = [...byCourier.values()].sort((a, b) => a.shippingFee - b.shippingFee);
      if (sorted.length > 0) {
        return sorted.slice(0, 3);
      }

      logger.warn('Shiprocket international quote returned no couriers', {
        countryCode,
        weightKg: Math.max(0.5, Number(payload.weightKg) || 0.5),
        lastMessage,
      });

      throw new ApiError(400, this.formatInternationalNoCourierMessage(countryCode, payload, lastMessage));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      logger.error('Shiprocket international shipping quote failed', {
        countryCode,
        error: axios.isAxiosError(error) ? error.response?.data : error,
      });
      const message = extractShiprocketMessage(error, '');
      if (/no serviceable|not available|not serviceable|given weight/i.test(message)) {
        throw new ApiError(400, this.formatInternationalNoCourierMessage(countryCode, payload, message));
      }
      throw new ApiError(502, 'Unable to fetch international shipping fare right now');
    }
  }

  private formatInternationalNoCourierMessage(
    countryCode: string,
    payload: ShiprocketRateQuotePayload,
    shiprocketMessage: string,
  ): string {
    const weightKg = Math.max(0.5, Number(payload.weightKg) || 0.5);
    const base = shiprocketMessage.trim() || 'No serviceable couriers available for this route.';
    return `${base} (destination ${countryCode}, chargeable weight ${weightKg} kg). Update line-item weight (grams) on the order, confirm postal code, and ensure Shiprocket X international is enabled on your account.`;
  }

  private extractServiceabilityMessage(raw: unknown): string {
    if (!raw || typeof raw !== 'object') return '';
    const root = raw as Record<string, unknown>;
    for (const key of ['message', 'msg', 'error']) {
      const v = root[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    const data = root.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const nested = data as Record<string, unknown>;
      for (const key of ['message', 'msg', 'error']) {
        const v = nested[key];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
    }
    return '';
  }

  private buildInternationalServiceabilityAttempts(
    payload: ShiprocketRateQuotePayload,
  ): Array<Record<string, string | number>> {
    const countryCode = (payload.deliveryCountryCode || '').trim().toUpperCase();
    const pickupPostcode = String(env.SHIPROCKET_PICKUP_PINCODE || '500035').trim();
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

    return [
      baseParams,
      { ...baseParams, mode: 'Air' },
      { ...baseParams, mode: 'Surface' },
      { ...baseParams, weight: Math.max(1, Math.ceil(weightKg)) },
    ];
  }

  private async collectInternationalServiceabilityRows(
    payload: ShiprocketRateQuotePayload,
    options?: { shiprocketOrderId?: number | string },
  ): Promise<{ rows: Array<Record<string, unknown>>; lastMessage: string }> {
    const endpoints = [
      '/international/courier/serviceability',
      '/courier/international/serviceability',
    ];
    const attempts = this.buildInternationalServiceabilityAttempts(payload);
    const byCourierId = new Map<number, Record<string, unknown>>();
    let lastMessage = 'No international courier partners available for this destination.';

    const headers = await this.getAuthHeaders();
    const srOrderId = options?.shiprocketOrderId;
    const orderIdParam =
      srOrderId != null && String(srOrderId).trim()
        ? Number(srOrderId)
        : NaN;

    for (const endpoint of endpoints) {
      for (const params of attempts) {
        const query: Record<string, string | number> = { ...params };
        if (Number.isFinite(orderIdParam) && orderIdParam > 0) {
          query.order_id = orderIdParam;
        }
        try {
          const response = await this.client.get(endpoint, { headers, params: query });
          const msg = this.extractServiceabilityMessage(response.data);
          if (msg) lastMessage = msg;
          for (const row of this.parseCourierRows(response.data)) {
            const courierId = Number(row.courier_company_id ?? row.id ?? row.courier_id);
            if (!Number.isFinite(courierId) || courierId <= 0) continue;
            byCourierId.set(courierId, row);
          }
        } catch (attemptError) {
          lastMessage = extractShiprocketMessage(
            attemptError,
            'No international courier partners available for this destination.',
          );
        }
      }
    }

    return { rows: [...byCourierId.values()], lastMessage };
  }

  async getInternationalCouriers(
    payload: ShiprocketRateQuotePayload & { shiprocketOrderId?: number | string },
  ): Promise<ShiprocketCourierOption[]> {
    const countryCode = (payload.deliveryCountryCode || '').trim().toUpperCase();
    if (!countryCode || countryCode.length !== 2) {
      throw new ApiError(400, 'Destination country code is required for international couriers');
    }

    try {
      const { rows, lastMessage } = await this.collectInternationalServiceabilityRows(payload, {
        ...(payload.shiprocketOrderId != null ? { shiprocketOrderId: payload.shiprocketOrderId } : {}),
      });

      const couriers = rows
        .map((row): ShiprocketCourierOption | null => {
          const courierId = Number(row.courier_company_id ?? row.id ?? row.courier_id);
          const courierName = String(
            row.courier_name ?? row.courier_company_name ?? row.name ?? '',
          ).trim();
          if (!Number.isFinite(courierId) || courierId <= 0 || !courierName) return null;
          const rate = this.extractCourierFreightRate(row);
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

      if (couriers.length === 0) {
        throw new ApiError(
          400,
          this.formatInternationalNoCourierMessage(countryCode, payload, lastMessage),
        );
      }

      return couriers;
    } catch (error) {
      if (error instanceof ApiError) throw error;
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

  /** International serviceability rows nest freight under `rate.rate` / `rate.total`. */
  private extractCourierFreightRate(company: Record<string, unknown>): number {
    const rateRaw = company.rate;
    if (typeof rateRaw === 'object' && rateRaw !== null) {
      const nested = rateRaw as Record<string, unknown>;
      const candidates = [
        nested.rate,
        nested.total,
        nested.last_mile_charge,
        nested.default,
      ];
      for (const c of candidates) {
        const n = Number(c);
        if (Number.isFinite(n) && n >= 0) return n;
      }
    }
    let rate = Number(rateRaw);
    if (!Number.isFinite(rate) || rate < 0) {
      rate =
        Number(company.freight_charge) ||
        Number(company.courier_charge) ||
        Number(company.estimated_cost) ||
        Number(company.total_charges);
    }
    if (!Number.isFinite(rate) || rate < 0) {
      const extra = company.extra_charges;
      if (Array.isArray(extra) && extra.length > 0) {
        const first = extra[0] as Record<string, unknown>;
        rate = Number(first.value);
      }
    }
    return Number.isFinite(rate) && rate >= 0 ? rate : NaN;
  }

  private mapCourierQuote(company: Record<string, unknown>): ShiprocketShippingQuote | null {
    const courierName = String(
      company.courier_name ?? company.courier_company_name ?? company.name ?? '',
    ).trim();

    const rate = this.extractCourierFreightRate(company);
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

    const dataCurrency =
      typeof company.rate === 'object' && company.rate !== null
        ? (company.rate as Record<string, unknown>).currency
        : undefined;
    const currency =
      String(dataCurrency ?? company.currency ?? company.rate_currency ?? 'INR').trim() || 'INR';

    const companyIdRaw = company.courier_company_id ?? company.courier_id;
    const courierCompanyId =
      companyIdRaw != null && Number.isFinite(Number(companyIdRaw))
        ? Number(companyIdRaw)
        : undefined;

    return {
      courier: courierName,
      shippingFee: Math.round(rate * 100) / 100,
      estimatedDays,
      currency,
      ...(courierCompanyId != null ? { courierCompanyId } : {}),
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

  private mapHyperlocalQuoteRow(
    row: Record<string, unknown>,
    raw: Record<string, unknown>,
  ): ShiprocketQuickQuote {
    const rate =
      Number(row.rates) ||
      Number(row.rate) ||
      Number(row.freight_charge) ||
      Number(row.delivery_charge) ||
      Number(row.total_amount) ||
      Number(row.amount) ||
      0;
    const etdHours = Number(row.etd_hours);
    const etaFromHours =
      Number.isFinite(etdHours) && etdHours > 0
        ? etdHours === 1
          ? 'About 1 hour'
          : `About ${etdHours} hours`
        : null;
    const durationMins = Number(
      row.duration_minutes ?? row.eta_minutes ?? row.estimated_minutes ?? row.minutes,
    );
    const etaFromMinutes =
      Number.isFinite(durationMins) && durationMins > 0 ? `${Math.round(durationMins)} min` : null;
    // Prefer real time fields — never treat distance (km) as an ETA label.
    const timeRaw =
      row.eta ??
      row.etd ??
      row.estimated_delivery_time ??
      row.estimated_time ??
      row.delivery_time ??
      row.duration ??
      null;
    const timeLabel =
      timeRaw != null && String(timeRaw).trim() && !/\bkm\b/i.test(String(timeRaw))
        ? String(timeRaw).trim()
        : null;
    // Last resort: estimate minutes from distance (hyperlocal city pace + buffer).
    const distance = Number(row.distance);
    const etaFromDistance =
      Number.isFinite(distance) && distance > 0
        ? `${Math.max(30, Math.round(20 + distance * 4))} min`
        : null;
    const etaRaw = etaFromHours ?? etaFromMinutes ?? timeLabel ?? etaFromDistance;
    const courierNameRaw = row.courier_name ?? row.partner_name ?? row.service_name;
    const courierIdRaw = Number(row.courier_company_id ?? row.courier_id ?? row.id);
    return {
      rate: Number.isFinite(rate) ? Math.round(rate * 100) / 100 : 0,
      currency: String(row.currency ?? 'INR').trim() || 'INR',
      etaMinutes: etaRaw != null && String(etaRaw).trim() ? String(etaRaw) : null,
      courierName:
        typeof courierNameRaw === 'string' && courierNameRaw.trim() ? courierNameRaw.trim() : null,
      // HL serviceability often omits courier id — AWB assign must not send one
      courierId: Number.isFinite(courierIdRaw) && courierIdRaw > 0 ? courierIdRaw : null,
      raw,
    };
  }

  /**
   * Instant quote via Hyper-Local serviceability:
   * GET /v1/external/courier/serviceability?is_new_hyperlocal=1&lat_from&long_from&lat_to&long_to
   */
  async quoteQuickDelivery(
    payload: ShiprocketQuickLocationPayload,
  ): Promise<ShiprocketQuickQuote> {
    const headers = await this.getAuthHeaders();

    try {
      const response = await this.client.get('/courier/serviceability', {
        headers,
        params: {
          pickup_postcode: payload.pickupPostalCode,
          delivery_postcode: payload.deliveryPostalCode,
          lat_from: payload.pickupLatitude,
          long_from: payload.pickupLongitude,
          lat_to: payload.deliveryLatitude,
          long_to: payload.deliveryLongitude,
          is_new_hyperlocal: 1,
          weight: Number(payload.weightKg.toFixed(3)),
          cod: payload.cod ? 1 : 0,
          ...(payload.declaredValue != null && payload.declaredValue > 0
            ? { declared_value: Math.max(payload.declaredValue, 1) }
            : {}),
        },
      });

      const body = response.data as Record<string, unknown>;
      const rowsRaw = body.data;
      const rows = Array.isArray(rowsRaw)
        ? rowsRaw.filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object')
        : [];

      if (body.status === false || rows.length === 0) {
        throw new ApiError(400, 'Instant delivery is not available for this location');
      }

      const quotes = rows
        .map((row) => this.mapHyperlocalQuoteRow(row, body))
        .filter((q) => Number.isFinite(q.rate) && q.rate >= 0)
        .sort((a, b) => a.rate - b.rate);

      const best = quotes[0];
      if (!best) {
        throw new ApiError(400, 'Instant delivery is not available for this location');
      }

      return {
        ...best,
        courierName: best.courierName || 'Shiprocket Quick',
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      logger.error('Shiprocket Hyper-Local serviceability failed', {
        status,
        error: axios.isAxiosError(error) ? error.response?.data : error,
      });
      throw new ApiError(
        502,
        extractShiprocketMessage(error, 'Unable to calculate Instant (Hyper-Local) delivery charge'),
      );
    }
  }

  /**
   * Instant create via Hyper-Local adhoc order:
   * POST /v1/external/orders/create/adhoc with shipping_method: "HL"
   */
  async createQuickDelivery(payload: ShiprocketQuickOrderPayload): Promise<Record<string, unknown>> {
    const nameParts = payload.customerName.trim().split(/\s+/);
    const firstName = nameParts[0] || 'Customer';
    const lastName = nameParts.slice(1).join(' ') || '.';

    const body: Record<string, unknown> = {
      order_id: payload.orderRef,
      order_date:
        payload.orderDate?.trim() ||
        new Date().toISOString().slice(0, 16).replace('T', ' '),
      pickup_location: payload.pickupLocation,
      billing_customer_name: firstName,
      billing_last_name: lastName,
      billing_address: payload.billingAddress,
      billing_address_2: payload.billingAddress2 || '',
      billing_city: payload.billingCity,
      billing_pincode: payload.billingPincode,
      billing_state: payload.billingState,
      billing_country: payload.billingCountry || 'India',
      billing_email: payload.customerEmail || '',
      billing_phone: payload.customerPhone,
      shipping_is_billing: true,
      latitude: payload.deliveryLatitude,
      longitude: payload.deliveryLongitude,
      order_items: payload.orderItems.map((item) => ({
        name: item.name,
        sku: item.sku,
        units: item.units,
        selling_price: item.sellingPrice,
        category_name: item.categoryName || 'Clothes',
        hsn: item.hsn ?? 5208,
      })),
      payment_method: payload.paymentMethod,
      sub_total: payload.subTotal,
      length: payload.lengthCm,
      breadth: payload.breadthCm,
      height: payload.heightCm,
      weight: Number(payload.weightKg.toFixed(3)),
      shipping_method: 'HL',
      collect_shipping_fees: false,
    };

    const otps = {
      pickupOtp: /^\d{4}$/.test(payload.otps?.pickupOtp?.trim() || '')
        ? payload.otps!.pickupOtp!.trim()
        : generateHyperlocalOtp(),
      dropOtp: /^\d{4}$/.test(payload.otps?.dropOtp?.trim() || '')
        ? payload.otps!.dropOtp!.trim()
        : generateHyperlocalOtp(),
      rtoOtp: /^\d{4}$/.test(payload.otps?.rtoOtp?.trim() || '')
        ? payload.otps!.rtoOtp!.trim()
        : generateHyperlocalOtp(),
    };
    body.pickup_otp = Number(otps.pickupOtp);
    body.drop_otp = Number(otps.dropOtp);
    body.rto_otp = Number(otps.rtoOtp);

    return this.createOrder(body);
  }

  /**
   * Register / update a hyperlocal pickup location.
   * POST /v1/external/settings/company/addpickup
   */
  async addHyperlocalPickup(payload: {
    pickupLocation: string;
    name: string;
    email: string;
    phone: string;
    address: string;
    address2?: string;
    city: string;
    state: string;
    country?: string;
    pinCode: string;
    latitude: number;
    longitude: number;
  }): Promise<Record<string, unknown>> {
    try {
      const headers = await this.getAuthHeaders();
      const response = await this.client.post(
        '/settings/company/addpickup',
        {
          pickup_location: payload.pickupLocation,
          name: payload.name,
          email: payload.email,
          phone: payload.phone,
          address: payload.address,
          address_2: payload.address2 || '',
          city: payload.city,
          state: payload.state,
          country: payload.country || 'India',
          pin_code: payload.pinCode,
          lat: String(payload.latitude),
          long: String(payload.longitude),
          is_hyperlocal: 1,
        },
        { headers },
      );
      return response.data as Record<string, unknown>;
    } catch (error) {
      logger.error('Shiprocket add hyperlocal pickup failed', {
        error: axios.isAxiosError(error) ? error.response?.data : error,
      });
      throw new ApiError(
        502,
        extractShiprocketMessage(error, 'Failed to add Shiprocket hyperlocal pickup location'),
      );
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

  /**
   * Hyper-Local rider tracking:
   * GET /v1/external/courier/hyperlocal/get_rider_data
   */
  async trackQuickOrder(
    shipmentOrOrderId: string,
    options?: { awb?: string | null },
  ): Promise<Record<string, unknown>> {
    const id = shipmentOrOrderId.trim();
    if (!id) throw new ApiError(400, 'Shipment id is required for Instant tracking');

    const headers = await this.getAuthHeaders();
    const attempts: Array<Record<string, string>> = [{ shipment_id: id }];
    if (options?.awb?.trim()) {
      attempts.push({ awb: options.awb.trim() });
    }
    if (/^\d+$/.test(id)) {
      attempts.push({ order_id: id });
    }

    let lastError: unknown;
    for (const params of attempts) {
      try {
        const response = await this.client.get('/courier/hyperlocal/get_rider_data', {
          headers,
          params,
        });
        return response.data as Record<string, unknown>;
      } catch (error) {
        lastError = error;
        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        if (status && status !== 404 && status !== 400 && status !== 422) {
          break;
        }
      }
    }

    // Legacy Quick orders (pre Hyper-Local migration) may still live under /quick/orders
    try {
      const response = await this.client.get(`/quick/orders/${encodeURIComponent(id)}`, {
        headers,
      });
      return response.data as Record<string, unknown>;
    } catch {
      // fall through to last hyperlocal error
    }

    logger.error('Shiprocket Hyper-Local rider tracking failed', {
      shipmentOrOrderId: id,
      error: axios.isAxiosError(lastError) ? lastError.response?.data : lastError,
    });
    throw new ApiError(
      502,
      extractShiprocketMessage(lastError, 'Instant delivery tracking failed'),
    );
  }

  /**
   * Legacy Quick cancel — kept for shipments created before Hyper-Local migration.
   * New Instant orders cancel via cancelOrders / cancelByAwbs.
   */
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
