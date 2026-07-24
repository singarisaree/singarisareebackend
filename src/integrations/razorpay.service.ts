import crypto from 'crypto';
import Razorpay from 'razorpay';
import { env } from '@/config/env';
import { logger } from '@/utils/logger';
import { ApiError } from '@/shared/api-response';

export interface CreateRazorpayOrderInput {
  orderNumber: string;
  amountRupees: number;
  currency?: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
}

export interface RazorpayOrderResult {
  id: string;
  amount: number;
  currency: string;
  receipt: string;
  status: string;
}

type RazorpayPaymentEntity = {
  id: string;
  order_id: string;
  status: string;
  amount?: number;
  currency?: string;
  error_description?: string | null;
  error_reason?: string | null;
  created_at?: number;
  [key: string]: unknown;
};

export class RazorpayService {
  private client: Razorpay | null = null;

  private getClient(): Razorpay {
    if (!env.RAZORPAY_KEY_ID?.trim() || !env.RAZORPAY_KEY_SECRET?.trim()) {
      throw new ApiError(503, 'Payment gateway is not configured yet');
    }
    if (!this.client) {
      this.client = new Razorpay({
        key_id: env.RAZORPAY_KEY_ID,
        key_secret: env.RAZORPAY_KEY_SECRET,
      });
    }
    return this.client;
  }

  getPublicKeyId(): string {
    const keyId = env.RAZORPAY_KEY_ID?.trim();
    if (!keyId) {
      throw new ApiError(503, 'Payment gateway is not configured yet');
    }
    return keyId;
  }

  isConfigured(): boolean {
    return Boolean(env.RAZORPAY_KEY_ID?.trim() && env.RAZORPAY_KEY_SECRET?.trim());
  }

  /** Convert INR rupees to paise for Razorpay APIs. */
  toPaise(amountRupees: number): number {
    return Math.round(Number(amountRupees) * 100);
  }

  async createOrder(data: CreateRazorpayOrderInput): Promise<RazorpayOrderResult> {
    try {
      const order = await this.getClient().orders.create({
        amount: this.toPaise(data.amountRupees),
        currency: data.currency || 'INR',
        receipt: data.orderNumber.slice(0, 40),
        notes: {
          orderNumber: data.orderNumber,
          customerName: data.customerName,
          customerEmail: data.customerEmail,
          customerPhone: data.customerPhone,
        },
      });

      return {
        id: String(order.id),
        amount: Number(order.amount),
        currency: String(order.currency),
        receipt: String(order.receipt || data.orderNumber),
        status: String(order.status),
      };
    } catch (error) {
      logger.error('Razorpay create order failed', { error });
      throw new ApiError(502, 'Payment gateway error');
    }
  }

  async getOrder(razorpayOrderId: string): Promise<Record<string, unknown>> {
    try {
      const order = await this.getClient().orders.fetch(razorpayOrderId);
      return order as unknown as Record<string, unknown>;
    } catch (error) {
      logger.error('Razorpay get order failed', { razorpayOrderId, error });
      throw new ApiError(502, 'Failed to fetch payment status');
    }
  }

  async getPaymentsForOrder(razorpayOrderId: string): Promise<RazorpayPaymentEntity[] | null> {
    try {
      const result = await this.getClient().orders.fetchPayments(razorpayOrderId);
      const items = (result as unknown as { items?: RazorpayPaymentEntity[] }).items;
      return Array.isArray(items) ? items : [];
    } catch (error) {
      logger.error('Razorpay get payments failed', { razorpayOrderId, error });
      return null;
    }
  }

  async getPayment(razorpayPaymentId: string): Promise<RazorpayPaymentEntity | null> {
    try {
      const payment = await this.getClient().payments.fetch(razorpayPaymentId);
      return payment as unknown as RazorpayPaymentEntity;
    } catch (error) {
      logger.error('Razorpay get payment failed', { razorpayPaymentId, error });
      return null;
    }
  }

  /**
   * Checkout success HMAC:
   * HMAC_SHA256(order_id + "|" + payment_id, key_secret) === razorpay_signature
   */
  verifyPaymentSignature(params: {
    orderId: string;
    paymentId: string;
    signature: string;
  }): boolean {
    const secret = env.RAZORPAY_KEY_SECRET?.trim();
    if (!secret) return false;

    const orderId = params.orderId.trim();
    const paymentId = params.paymentId.trim();
    const signature = params.signature.trim().toLowerCase();
    if (!orderId || !paymentId || !signature) return false;

    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    try {
      const a = Buffer.from(signature, 'utf8');
      const b = Buffer.from(expected, 'utf8');
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  /** Webhook HMAC over the raw request body. Fails closed if secret is missing. */
  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    const secret = env.RAZORPAY_WEBHOOK_SECRET?.trim();
    if (!secret) return false;
    if (!rawBody || !signature.trim()) return false;

    const expected = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    try {
      const a = Buffer.from(signature.trim().toLowerCase(), 'utf8');
      const b = Buffer.from(expected, 'utf8');
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
}

export const razorpayService = new RazorpayService();
