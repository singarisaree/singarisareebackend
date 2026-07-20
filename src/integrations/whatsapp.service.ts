import axios, { AxiosError, type AxiosInstance } from 'axios';
import type { OrderStatus, ReturnRequestStatus } from '@prisma/client';
import { env } from '@/config/env';
import { logger } from '@/utils/logger';
import { formatCurrency, formatShortOrderNumber } from '@/utils/helpers';
import { settingsService } from '@/modules/settings/settings.service';
import {
  type WhatsAppTemplateKind,
  type WhatsAppTemplateRecord,
  orderStatusTemplateKinds,
  refundCouponTemplateKind,
  returnStatusTemplateKinds,
  whatsappTemplateStatusSchema,
} from '@/modules/settings/whatsapp-template.schema';
import { ApiError } from '@/shared/api-response';
import { localStorageService } from '@/integrations/local-storage.service';

export type WhatsAppSendResult = {
  sent: boolean;
  messageId?: string;
  error?: string;
};

export type WhatsAppRuntimeTemplateConfig = {
  name?: string;
  language: string;
};

type TemplateParameter = {
  type: 'text';
  text: string;
};

export function normalizeWhatsAppPhone(value: string): string {
  let digits = value.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 10) digits = `91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) digits = `91${digits.slice(1)}`;
  return digits;
}

export function buildWhatsAppTemplatePayload(options: {
  to: string;
  templateName: string;
  language: string;
  bodyParameters: string[];
  imageUrl?: string;
}): Record<string, unknown> {
  const components: Array<Record<string, unknown>> = [];
  if (options.imageUrl?.trim()) {
    components.push({
      type: 'header',
      parameters: [{ type: 'image', image: { link: options.imageUrl.trim() } }],
    });
  }
  if (options.bodyParameters.length) {
    components.push({
      type: 'body',
      parameters: options.bodyParameters.map((text): TemplateParameter => ({ type: 'text', text })),
    });
  }

  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: normalizeWhatsAppPhone(options.to),
    type: 'template',
    template: {
      name: options.templateName,
      language: { code: options.language },
      components,
    },
  };
}

export function buildMetaTemplateSubmission(record: WhatsAppTemplateRecord) {
  const components: Array<Record<string, unknown>> = [];
  if (record.kind === 'marketing_image') {
    if (!record.headerHandle) {
      throw new ApiError(400, 'Upload a sample header image before submitting this template');
    }
    components.push({
      type: 'HEADER',
      format: 'IMAGE',
      example: { header_handle: [record.headerHandle] },
    });
  } else if (record.headerText) {
    components.push({
      type: 'HEADER',
      format: 'TEXT',
      text: record.headerText,
    });
  }
  components.push({
    type: 'BODY',
    text: record.body,
    example: { body_text: [record.examples] },
  });
  if (record.footer) {
    components.push({ type: 'FOOTER', text: record.footer });
  }
  return {
    name: record.name,
    language: record.language,
    category: record.category,
    allow_category_change: true,
    parameter_format: 'POSITIONAL',
    components,
  };
}

export function buildOrderStatusTemplateRequest(data: {
  customerName: string;
  orderNumber: string;
  status: OrderStatus;
  grandTotal?: string;
  trackingUrl?: string;
}) {
  const shortOrderId = formatShortOrderNumber(data.orderNumber);
  const readableStatus = data.status.replace(/_/g, ' ').toLowerCase();
  const totalStatuses: OrderStatus[] = ['PLACED', 'PAYMENT_PENDING', 'CONFIRMED'];
  const trackingStatuses: OrderStatus[] = ['SHIPPED', 'IN_TRANSIT'];
  const bodyParameters = [data.customerName, shortOrderId];
  if (totalStatuses.includes(data.status)) {
    bodyParameters.push(data.grandTotal?.trim() || '-');
  } else if (trackingStatuses.includes(data.status)) {
    bodyParameters.push(data.trackingUrl?.trim() || '-');
  }
  return {
    kind: orderStatusTemplateKinds[data.status],
    bodyParameters,
    message: `Hello ${data.customerName}, your Singari Sarees order ${shortOrderId} is ${readableStatus}.`,
  };
}

export function buildReturnStatusTemplateRequest(data: {
  customerName: string;
  orderNumber: string;
  status: ReturnRequestStatus;
  reason?: string;
  adminNotes?: string | null;
}) {
  const shortOrderId = formatShortOrderNumber(data.orderNumber);
  const bodyParameters = [data.customerName, shortOrderId];
  if (data.status === 'REQUESTED') {
    bodyParameters.push(data.reason?.trim() || '-');
  } else if (data.status === 'REJECTED') {
    bodyParameters.push(data.adminNotes?.trim() || 'Please contact support for details');
  }
  return {
    kind: returnStatusTemplateKinds[data.status],
    bodyParameters,
    message: `Return request for order ${shortOrderId}: ${data.status.replace(/_/g, ' ').toLowerCase()}.`,
  };
}

export function buildRefundCouponTemplateRequest(data: {
  customerName: string;
  orderNumber: string;
  couponCode: string;
  couponAmount: number;
  deduction: number;
  expiresAt: Date;
}) {
  const shortOrderId = formatShortOrderNumber(data.orderNumber);
  return {
    kind: refundCouponTemplateKind,
    bodyParameters: [
      data.customerName,
      shortOrderId,
      data.couponCode,
      formatCurrency(data.couponAmount),
      formatCurrency(data.deduction),
      data.expiresAt.toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'Asia/Kolkata',
      }),
    ],
    message: `Store credit coupon ${data.couponCode} issued for order ${shortOrderId}.`,
  };
}

function metaErrorMessage(error: unknown): string {
  if (error instanceof AxiosError) {
    const data = error.response?.data as
      | {
          error?: { message?: string; error_user_msg?: string; code?: number };
        }
      | undefined;
    return (
      data?.error?.error_user_msg ||
      data?.error?.message ||
      (error.response?.status ? `Meta API returned ${error.response.status}` : error.message)
    );
  }
  return error instanceof Error ? error.message : 'WhatsApp Cloud API request failed';
}

export class WhatsAppService {
  private client: AxiosInstance | null = null;

  isConfigured(): boolean {
    return Boolean(
      env.WHATSAPP_CLOUD_ACCESS_TOKEN?.trim() && env.WHATSAPP_CLOUD_PHONE_NUMBER_ID?.trim(),
    );
  }

  async isMarketingConfigured(withImage = false): Promise<boolean> {
    if (!this.isConfigured()) return false;
    const config = await this.getMarketingTemplateConfig(withImage);
    return Boolean(config.name);
  }

  async getMarketingTemplateConfig(withImage = false): Promise<WhatsAppRuntimeTemplateConfig> {
    return this.resolveTemplateConfig(withImage ? 'marketing_image' : 'marketing_text');
  }

  private async resolveTemplateConfig(
    kind: WhatsAppTemplateKind,
  ): Promise<WhatsAppRuntimeTemplateConfig> {
    const record = await settingsService.getWhatsAppTemplate(kind);
    if (record.status === 'APPROVED' && record.isActive && record.name.trim()) {
      return { name: record.name.trim(), language: record.language.trim() };
    }
    return {
      name: undefined,
      language: record.language.trim(),
    };
  }

  private getClient(): AxiosInstance | null {
    if (!this.isConfigured()) return null;
    if (!this.client) {
      const version = env.WHATSAPP_CLOUD_API_VERSION.replace(/^\/+|\/+$/g, '');
      this.client = axios.create({
        baseURL: `https://graph.facebook.com/${version}`,
        timeout: 15_000,
        headers: {
          Authorization: `Bearer ${env.WHATSAPP_CLOUD_ACCESS_TOKEN!.trim()}`,
          'Content-Type': 'application/json',
        },
      });
    }
    return this.client;
  }

  private async sendTemplate(options: {
    to: string;
    kind: WhatsAppTemplateKind;
    bodyParameters: string[];
    imageUrl?: string;
    templateConfig?: WhatsAppRuntimeTemplateConfig;
  }): Promise<WhatsAppSendResult> {
    const client = this.getClient();
    const config = options.templateConfig ?? (await this.resolveTemplateConfig(options.kind));
    const templateName = config.name;
    if (!client || !templateName) {
      return {
        sent: false,
        error: !client
          ? 'WhatsApp Cloud API credentials are not configured'
          : 'No approved and active WhatsApp template is available',
      };
    }

    const to = normalizeWhatsAppPhone(options.to);
    if (to.length < 10 || to.length > 15) {
      return { sent: false, error: 'Invalid WhatsApp recipient number' };
    }

    try {
      const response = await client.post(
        `/${env.WHATSAPP_CLOUD_PHONE_NUMBER_ID!.trim()}/messages`,
        buildWhatsAppTemplatePayload({
          to,
          templateName,
          language: config.language,
          bodyParameters: options.bodyParameters,
          imageUrl: options.imageUrl,
        }),
      );
      const messageId = response.data?.messages?.[0]?.id as string | undefined;
      if (!messageId) {
        return { sent: false, error: 'Meta accepted the request without a message ID' };
      }
      logger.info('WhatsApp Cloud API message accepted', { to, templateName, messageId });
      return { sent: true, messageId };
    } catch (error) {
      const message = metaErrorMessage(error);
      logger.error('WhatsApp Cloud API send failed', { to, templateName, error: message });
      return { sent: false, error: message };
    }
  }

  async uploadTemplateSample(
    kind: WhatsAppTemplateKind,
    file: Express.Multer.File,
  ): Promise<WhatsAppTemplateRecord> {
    if (kind !== 'marketing_image') {
      throw new ApiError(400, 'Only the image marketing template uses a sample image');
    }
    if (!env.WHATSAPP_CLOUD_ACCESS_TOKEN?.trim() || !env.WHATSAPP_CLOUD_APP_ID?.trim()) {
      throw new ApiError(503, 'Meta App ID and Cloud API access token are required');
    }

    try {
      const version = env.WHATSAPP_CLOUD_API_VERSION.replace(/^\/+|\/+$/g, '');
      const baseUrl = `https://graph.facebook.com/${version}`;
      const session = await axios.post(
        `${baseUrl}/${env.WHATSAPP_CLOUD_APP_ID.trim()}/uploads`,
        null,
        {
          params: {
            file_name: file.originalname,
            file_length: file.size,
            file_type: file.mimetype,
          },
          headers: { Authorization: `Bearer ${env.WHATSAPP_CLOUD_ACCESS_TOKEN.trim()}` },
          timeout: 15_000,
        },
      );
      const sessionId = session.data?.id as string | undefined;
      if (!sessionId) throw new Error('Meta did not return an upload session ID');

      const upload = await axios.post(`${baseUrl}/${sessionId}`, file.buffer, {
        headers: {
          Authorization: `OAuth ${env.WHATSAPP_CLOUD_ACCESS_TOKEN.trim()}`,
          file_offset: '0',
          'Content-Type': file.mimetype,
        },
        timeout: 30_000,
        maxBodyLength: 10 * 1024 * 1024,
      });
      const headerHandle = upload.data?.h as string | undefined;
      if (!headerHandle) throw new Error('Meta did not return a media handle');

      const preview = await localStorageService.uploadImage(file.buffer, 'whatsapp-template-samples');
      const current = await settingsService.getWhatsAppTemplate(kind);
      const updated: WhatsAppTemplateRecord = {
        ...current,
        headerHandle,
        headerPreviewUrl: preview.url,
        status: 'DRAFT',
        metaTemplateId: undefined,
        rejectionReason: undefined,
      };
      await settingsService.storeWhatsAppTemplate(updated);
      return updated;
    } catch (error) {
      throw new ApiError(502, metaErrorMessage(error));
    }
  }

  async submitTemplate(kind: WhatsAppTemplateKind): Promise<WhatsAppTemplateRecord> {
    const client = this.getClient();
    const wabaId = env.WHATSAPP_CLOUD_WABA_ID?.trim();
    if (!client || !wabaId) {
      throw new ApiError(
        503,
        'WhatsApp Cloud API token, phone-number ID, and WABA ID are required',
      );
    }
    const record = await settingsService.getWhatsAppTemplate(kind, true);
    if (record.status === 'PENDING' || record.status === 'APPROVED') {
      throw new ApiError(409, `Template is already ${record.status.toLowerCase()}`);
    }

    try {
      const response = await client.post(
        `/${wabaId}/message_templates`,
        buildMetaTemplateSubmission(record),
      );
      const parsedStatus = whatsappTemplateStatusSchema.safeParse(response.data?.status);
      const updated: WhatsAppTemplateRecord = {
        ...record,
        metaTemplateId: String(response.data?.id || ''),
        status: parsedStatus.success ? parsedStatus.data : 'PENDING',
        isActive: false,
        rejectionReason: undefined,
        submittedAt: new Date().toISOString(),
        lastSyncedAt: new Date().toISOString(),
      };
      await settingsService.storeWhatsAppTemplate(updated);
      return updated;
    } catch (error) {
      throw new ApiError(502, metaErrorMessage(error));
    }
  }

  async syncTemplateStatus(kind: WhatsAppTemplateKind): Promise<WhatsAppTemplateRecord> {
    const client = this.getClient();
    const wabaId = env.WHATSAPP_CLOUD_WABA_ID?.trim();
    if (!client || !wabaId) {
      throw new ApiError(
        503,
        'WhatsApp Cloud API token, phone-number ID, and WABA ID are required',
      );
    }
    const record = await settingsService.getWhatsAppTemplate(kind, true);
    if (!record.metaTemplateId && record.status === 'DRAFT') {
      throw new ApiError(400, 'Submit this template before refreshing its status');
    }

    try {
      const response = await client.get(`/${wabaId}/message_templates`, {
        params: { name: record.name, limit: 100 },
      });
      const templates = Array.isArray(response.data?.data) ? response.data.data : [];
      const match = templates.find(
        (template: { name?: string; language?: string }) =>
          template.name === record.name && template.language === record.language,
      );
      if (!match) throw new ApiError(404, 'Template was not found in the configured WABA');
      const parsedStatus = whatsappTemplateStatusSchema.safeParse(match.status);
      const updated: WhatsAppTemplateRecord = {
        ...record,
        metaTemplateId: String(match.id || record.metaTemplateId || ''),
        status: parsedStatus.success ? parsedStatus.data : record.status,
        isActive:
          parsedStatus.success && parsedStatus.data === 'APPROVED' ? record.isActive : false,
        rejectionReason:
          typeof match.rejected_reason === 'string' ? match.rejected_reason : undefined,
        lastSyncedAt: new Date().toISOString(),
      };
      await settingsService.storeWhatsAppTemplate(updated);
      return updated;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, metaErrorMessage(error));
    }
  }

  async sendMarketingMessage(data: {
    to: string;
    customerName: string;
    heading: string;
    story: string;
    campaignLink: string;
    mediaUrl?: string;
    templateConfig?: WhatsAppRuntimeTemplateConfig;
  }): Promise<WhatsAppSendResult> {
    return this.sendTemplate({
      to: data.to,
      kind: data.mediaUrl ? 'marketing_image' : 'marketing_text',
      bodyParameters: [
        data.customerName.trim() || 'Customer',
        data.heading.trim(),
        data.story.trim(),
        data.campaignLink.trim(),
      ],
      imageUrl: data.mediaUrl,
      templateConfig: data.templateConfig,
    });
  }

  async sendCustomerWelcome(data: {
    phone: string;
    customerName: string;
  }): Promise<WhatsAppSendResult> {
    return this.sendTemplate({
      to: data.phone,
      kind: 'customer_welcome',
      bodyParameters: [data.customerName.trim() || 'Customer'],
    });
  }

  async sendOrderStatusUpdate(data: {
    customerPhone: string;
    customerName: string;
    orderNumber: string;
    status: OrderStatus;
    grandTotal?: string;
    trackingUrl?: string;
  }): Promise<WhatsAppSendResult & { message: string }> {
    const request = buildOrderStatusTemplateRequest(data);
    const result = await this.sendTemplate({
      to: data.customerPhone,
      kind: request.kind,
      bodyParameters: request.bodyParameters,
    });
    return { ...result, message: request.message };
  }

  async sendReturnStatusUpdate(data: {
    customerPhone: string;
    customerName: string;
    orderNumber: string;
    status: ReturnRequestStatus;
    reason?: string;
    adminNotes?: string | null;
  }): Promise<WhatsAppSendResult & { message: string }> {
    const request = buildReturnStatusTemplateRequest(data);
    const result = await this.sendTemplate({
      to: data.customerPhone,
      kind: request.kind,
      bodyParameters: request.bodyParameters,
    });
    return { ...result, message: request.message };
  }

  async sendRefundCouponIssued(data: {
    customerPhone: string;
    customerName: string;
    orderNumber: string;
    couponCode: string;
    couponAmount: number;
    deduction: number;
    expiresAt: Date;
  }): Promise<WhatsAppSendResult & { message: string }> {
    const request = buildRefundCouponTemplateRequest(data);
    const result = await this.sendTemplate({
      to: data.customerPhone,
      kind: request.kind,
      bodyParameters: request.bodyParameters,
    });
    return { ...result, message: request.message };
  }
}

export const whatsAppService = new WhatsAppService();
