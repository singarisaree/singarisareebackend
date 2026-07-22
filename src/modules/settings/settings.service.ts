import { Prisma } from '@prisma/client';
import { prisma } from '@/config/database';
import { localStorageService } from '@/integrations/local-storage.service';
import { ApiError } from '@/shared/api-response';
import { invalidateCache } from '@/utils/memory-cache';
import { realtime } from '@/realtime/emitter';
import {
  type WhatsAppTemplateDraftInput,
  type WhatsAppTemplateKind,
  type WhatsAppTemplateRecord,
  whatsappTemplateStatusSchema,
} from './whatsapp-template.schema';

const OUR_STORY_IMAGE_KEY = 'our_story_image_url';
const OUR_STORY_PUBLIC_ID_KEY = 'our_story_image_public_id';
const INVOICE_SIGNATURE_URL_KEY = 'invoice_signature_url';
const INVOICE_SIGNATURE_PUBLIC_ID_KEY = 'invoice_signature_public_id';
const QUICK_PICKUP_LAT_KEY = 'quick_pickup_lat';
const QUICK_PICKUP_LNG_KEY = 'quick_pickup_lng';
const QUICK_DELIVERY_START_KEY = 'quick_delivery_start';
const QUICK_DELIVERY_END_KEY = 'quick_delivery_end';
const QUICK_HOLIDAYS_KEY = 'quick_holidays';
const WHATSAPP_TEMPLATE_GROUP = 'whatsapp_templates';
const WHATSAPP_TEMPLATE_CACHE_TTL_MS = 15 * 1000;
/** Business timezone for Instant / Quick acceptance. */
const QUICK_TIMEZONE = 'Asia/Kolkata';

export type QuickScheduleStatus =
  { available: true } | { available: false; reason: 'holiday' | 'outside_hours'; message: string };

function parseHm(value: unknown): { hours: number; minutes: number } | null {
  const raw = String(value ?? '').trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return null;
  }
  return { hours, minutes };
}

function formatHmLabel(hm: { hours: number; minutes: number }): string {
  const d = new Date(2000, 0, 1, hm.hours, hm.minutes);
  return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function normalizeHolidayDates(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const item of value) {
    const day = String(item ?? '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) out.add(day);
  }
  return [...out].sort();
}

function getZonedDateParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  };
}

const PUBLIC_SETTINGS_TTL_MS = 30 * 1000;

let publicSettingsCache: { data: Record<string, unknown>; expiresAt: number } | null = null;
let whatsappTemplatesCache: { data: WhatsAppTemplateRecord[]; expiresAt: number } | null = null;

function invalidatePublicSettingsCache(): void {
  publicSettingsCache = null;
  invalidateCache('storefront:homepage');
  realtime.catalogChanged('settings');
}

function invalidateWhatsAppTemplatesCache(): void {
  whatsappTemplatesCache = null;
}

function orderTemplate(
  kind: WhatsAppTemplateKind,
  name: string,
  headerText: string,
  body: string,
  examples: string[],
  variableLabels: string[],
): WhatsAppTemplateRecord {
  return {
    kind,
    name,
    language: 'en',
    category: 'UTILITY',
    headerText,
    body,
    footer: 'Singari Sarees',
    examples,
    variableLabels,
    status: 'DRAFT',
    isActive: false,
  };
}

/**
 * Meta WhatsApp template body rules:
 * - Body must not start or end with a variable
 * - Enough static text for the number of variables
 * - No line that is only a variable
 * Variable order is fixed for send-code compatibility.
 */
const WHATSAPP_TEMPLATE_DEFAULTS: Record<WhatsAppTemplateKind, WhatsAppTemplateRecord> = {
  order_placed: orderTemplate(
    'order_placed',
    'singari_order_placed',
    'Order placed',
    'Hello {{1}}, thank you for shopping with Singari Sarees. We received your order {{2}}. Your order total is {{3}}. We will update you as it moves ahead.',
    ['Lakshmi', 'SS12345', '₹2,499'],
    ['Customer name', 'Short order number', 'Formatted order total'],
  ),
  order_payment_pending: orderTemplate(
    'order_payment_pending',
    'singari_order_payment_pending',
    'Payment pending',
    'Hello {{1}}, payment is still pending for your Singari Sarees order {{2}}. The order total is {{3}}. Please complete payment to confirm your order.',
    ['Lakshmi', 'SS12345', '₹2,499'],
    ['Customer name', 'Short order number', 'Formatted order total'],
  ),
  order_confirmed: orderTemplate(
    'order_confirmed',
    'singari_order_confirmed',
    'Order confirmed',
    'Hello {{1}}, your Singari Sarees order {{2}} is confirmed. The order total is {{3}}. We are preparing your saree with care.',
    ['Lakshmi', 'SS12345', '₹2,499'],
    ['Customer name', 'Short order number', 'Formatted order total'],
  ),
  order_ready_to_ship: orderTemplate(
    'order_ready_to_ship',
    'singari_order_ready_to_ship',
    'Ready to ship',
    'Hello {{1}}, your Singari Sarees order {{2}} is packed and ready to ship. We will share tracking details once it is dispatched.',
    ['Lakshmi', 'SS12345'],
    ['Customer name', 'Short order number'],
  ),
  order_shipped: orderTemplate(
    'order_shipped',
    'singari_order_shipped',
    'Order shipped',
    'Hello {{1}}, your Singari Sarees order {{2}} has been shipped. Track your delivery here: {{3}}. Thank you for shopping with us.',
    ['Lakshmi', 'SS12345', 'https://www.singarisaree.com'],
    ['Customer name', 'Short order number', 'Tracking URL'],
  ),
  order_in_transit: orderTemplate(
    'order_in_transit',
    'singari_order_in_transit',
    'Order in transit',
    'Hello {{1}}, your Singari Sarees order {{2}} is on the way. Track your delivery here: {{3}}. We hope you enjoy your saree.',
    ['Lakshmi', 'SS12345', 'https://www.singarisaree.com'],
    ['Customer name', 'Short order number', 'Tracking URL'],
  ),
  order_delivered: orderTemplate(
    'order_delivered',
    'singari_order_delivered',
    'Order delivered',
    'Hello {{1}}, your Singari Sarees order {{2}} has been delivered. Thank you for shopping with us. Visit www.singarisaree.com anytime.',
    ['Lakshmi', 'SS12345'],
    ['Customer name', 'Short order number'],
  ),
  order_returned: orderTemplate(
    'order_returned',
    'singari_order_returned',
    'Order returned',
    'Hello {{1}}, your Singari Sarees order {{2}} has been marked as returned. Our team will guide you on the next steps.',
    ['Lakshmi', 'SS12345'],
    ['Customer name', 'Short order number'],
  ),
  order_cancelled: orderTemplate(
    'order_cancelled',
    'singari_order_cancelled',
    'Order cancelled',
    'Hello {{1}}, your Singari Sarees order {{2}} has been cancelled. If you need help, please contact our support team.',
    ['Lakshmi', 'SS12345'],
    ['Customer name', 'Short order number'],
  ),
  order_failed: orderTemplate(
    'order_failed',
    'singari_order_failed',
    'Order failed',
    'Hello {{1}}, your Singari Sarees order {{2}} could not be completed. Please contact support if any amount was charged.',
    ['Lakshmi', 'SS12345'],
    ['Customer name', 'Short order number'],
  ),
  order_rto: orderTemplate(
    'order_rto',
    'singari_order_rto',
    'Returned to origin',
    'Hello {{1}}, your Singari Sarees order {{2}} is being returned to origin. Our team will update you soon.',
    ['Lakshmi', 'SS12345'],
    ['Customer name', 'Short order number'],
  ),
  order_refunded: orderTemplate(
    'order_refunded',
    'singari_order_refunded',
    'Order refunded',
    'Hello {{1}}, the refund for your Singari Sarees order {{2}} has been processed. It may take a few working days to reflect.',
    ['Lakshmi', 'SS12345'],
    ['Customer name', 'Short order number'],
  ),
  return_requested: orderTemplate(
    'return_requested',
    'singari_return_requested',
    'Return requested',
    'Hello {{1}}, we received your return request for Singari Sarees order {{2}}. Reason noted: {{3}}. Our team will review it shortly.',
    ['Lakshmi', 'SS12345', 'Product did not fit'],
    ['Customer name', 'Short order number', 'Return reason'],
  ),
  return_accepted: orderTemplate(
    'return_accepted',
    'singari_return_accepted',
    'Return accepted',
    'Hello {{1}}, your return request for Singari Sarees order {{2}} has been accepted. We will arrange the next pickup steps soon.',
    ['Lakshmi', 'SS12345'],
    ['Customer name', 'Short order number'],
  ),
  return_rejected: orderTemplate(
    'return_rejected',
    'singari_return_rejected',
    'Return request update',
    'Hello {{1}}, your return request for Singari Sarees order {{2}} was not approved. Note from our team: {{3}}. Please contact support if you need help.',
    ['Lakshmi', 'SS12345', 'Please contact support for details'],
    ['Customer name', 'Short order number', 'Admin note'],
  ),
  return_out_for_pickup: orderTemplate(
    'return_out_for_pickup',
    'singari_return_out_for_pickup',
    'Return pickup arranged',
    'Hello {{1}}, pickup is arranged for your return from Singari Sarees order {{2}}. Please keep the package ready.',
    ['Lakshmi', 'SS12345'],
    ['Customer name', 'Short order number'],
  ),
  return_pickup_cancelled: orderTemplate(
    'return_pickup_cancelled',
    'singari_return_pickup_cancelled',
    'Return pickup cancelled',
    'Hello {{1}}, pickup for your Singari Sarees order {{2}} return was cancelled. We will update you after it is rescheduled.',
    ['Lakshmi', 'SS12345'],
    ['Customer name', 'Short order number'],
  ),
  return_picked_up: orderTemplate(
    'return_picked_up',
    'singari_return_picked_up',
    'Return picked up',
    'Hello {{1}}, the return for your Singari Sarees order {{2}} has been picked up. We will process it after inspection.',
    ['Lakshmi', 'SS12345'],
    ['Customer name', 'Short order number'],
  ),
  return_completed: orderTemplate(
    'return_completed',
    'singari_return_completed',
    'Return received',
    'Hello {{1}}, we received the return for your Singari Sarees order {{2}}. Thank you for shopping with us.',
    ['Lakshmi', 'SS12345'],
    ['Customer name', 'Short order number'],
  ),
  refund_coupon_issued: orderTemplate(
    'refund_coupon_issued',
    'singari_refund_coupon_issued',
    'Store credit issued',
    'Hello {{1}}, store credit for your Singari Sarees order {{2}} is ready. Use coupon code {{3}} worth {{4}}. Shipping deduction applied: {{5}}. This coupon expires on {{6}}. Shop again at www.singarisaree.com.',
    ['Lakshmi', 'SS12345', 'SCABC234', '₹2,400', '₹99', '15 October 2026'],
    [
      'Customer name',
      'Short order number',
      'Coupon code',
      'Coupon amount',
      'Shipping deduction',
      'Expiry date',
    ],
  ),
  customer_welcome: orderTemplate(
    'customer_welcome',
    'singari_customer_welcome',
    'Welcome to Singari Sarees',
    'Hello {{1}}, welcome to Singari Sarees. Your account is ready. You can now view orders and favourites anytime at www.singarisaree.com.',
    ['Lakshmi'],
    ['Customer name'],
  ),
  customer_login_otp: {
    kind: 'customer_login_otp',
    name: 'singari_customer_login_otp',
    language: 'en',
    category: 'AUTHENTICATION',
    headerText: '',
    // Preview copy for Admin; Meta AUTHENTICATION templates use a fixed OTP layout.
    body: 'Your Singari Sarees login code is {{1}}. It expires in 10 minutes. Do not share this code with anyone.',
    footer: 'Code expires in 10 minutes',
    examples: ['482915'],
    variableLabels: ['Login OTP code'],
    status: 'DRAFT',
    isActive: false,
  },
  marketing_text: {
    kind: 'marketing_text',
    name: 'singari_marketing_text',
    language: 'en',
    category: 'MARKETING',
    headerText: 'A special update for you',
    body: 'Hello {{1}}, thank you for being part of Singari Sarees. Here is our latest update: {{2}}. More details for you: {{3}}. Shop this collection here: {{4}}. We look forward to seeing you again soon.',
    footer: 'Reply STOP to opt out',
    examples: [
      'Lakshmi',
      'Festive Sale',
      'Discover our latest sarees curated for every occasion.',
      'https://www.singarisaree.com/collections',
    ],
    variableLabels: ['Customer name', 'Campaign heading', 'Campaign story', 'Campaign link'],
    status: 'DRAFT',
    isActive: false,
  },
  marketing_image: {
    kind: 'marketing_image',
    name: 'singari_marketing_image',
    language: 'en',
    category: 'MARKETING',
    headerText: '',
    body: 'Hello {{1}}, thank you for being part of Singari Sarees. Here is our latest update: {{2}}. More details for you: {{3}}. Shop this collection here: {{4}}. We look forward to seeing you again soon.',
    footer: 'Reply STOP to opt out',
    examples: [
      'Lakshmi',
      'Festive Sale',
      'Discover our latest sarees curated for every occasion.',
      'https://www.singarisaree.com/collections',
    ],
    variableLabels: ['Customer name', 'Campaign heading', 'Campaign story', 'Campaign link'],
    status: 'DRAFT',
    isActive: false,
  },
};

function whatsappTemplateKey(kind: WhatsAppTemplateKind): string {
  return `whatsapp_template_${kind}`;
}

export function getWhatsAppBodyMetaIssue(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return 'Template body is required';
  if (/^\{\{\d+\}\}/.test(trimmed)) {
    return 'Body cannot start with a variable. Add text before {{1}}.';
  }
  if (/\{\{\d+\}\}$/.test(trimmed)) {
    return 'Body cannot end with a variable. Add text after the last variable.';
  }
  if (/(?:^|\n)\s*\{\{\d+\}\}\s*(?:\n|$)/.test(body)) {
    return 'A variable cannot be alone on a line. Wrap every variable with surrounding text.';
  }
  const placeholders = [...body.matchAll(/\{\{(\d+)\}\}/g)];
  const staticText = body.replace(/\{\{\d+\}\}/g, '').replace(/\s+/g, ' ').trim();
  // Meta rejects short bodies with many variables (rough ratio check).
  if (placeholders.length >= 3 && staticText.length < placeholders.length * 18) {
    return 'Too many variables for this message length. Add more fixed text around the variables.';
  }
  if (placeholders.length >= 5 && staticText.length < 120) {
    return 'This template needs more fixed text for Meta approval.';
  }
  return null;
}

export function validateWhatsAppTemplateRecord(record: WhatsAppTemplateRecord): void {
  const placeholders = [...record.body.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]));
  const expected = record.variableLabels.map((_, index) => index + 1);
  if (
    placeholders.length !== expected.length ||
    placeholders.some((value, index) => value !== expected[index])
  ) {
    throw new ApiError(
      400,
      `Body variables must appear exactly once in this order: ${expected.map((value) => `{{${value}}}`).join(', ')}`,
    );
  }
  if (record.examples.length !== expected.length) {
    throw new ApiError(400, `Provide exactly ${expected.length} sample values`);
  }
  if (/\{\{\d+\}\}/.test(record.headerText) || /\{\{\d+\}\}/.test(record.footer)) {
    throw new ApiError(400, 'Variables are supported only in the template body');
  }
  const metaIssue = getWhatsAppBodyMetaIssue(record.body);
  if (metaIssue) {
    throw new ApiError(400, metaIssue);
  }
}

function hasCurrentTemplateContract(
  record: Pick<WhatsAppTemplateRecord, 'kind' | 'body' | 'examples'>,
): boolean {
  if (record.kind !== 'marketing_text' && record.kind !== 'marketing_image') return true;
  const variables = [...record.body.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]));
  return variables.join(',') === '1,2,3,4' && record.examples.length === 4;
}

export class SettingsService {
  async getAll(group?: string) {
    return prisma.setting.findMany({
      where: group ? { group } : undefined,
    });
  }

  async getByKey(key: string) {
    return prisma.setting.findUnique({ where: { key } });
  }

  async getWhatsAppTemplates(forceRefresh = false): Promise<WhatsAppTemplateRecord[]> {
    const now = Date.now();
    if (!forceRefresh && whatsappTemplatesCache && whatsappTemplatesCache.expiresAt > now) {
      return whatsappTemplatesCache.data;
    }

    const rows = await prisma.setting.findMany({
      where: { group: WHATSAPP_TEMPLATE_GROUP },
    });
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const templates = (Object.keys(WHATSAPP_TEMPLATE_DEFAULTS) as WhatsAppTemplateKind[]).map(
      (kind) => {
        const fallback = WHATSAPP_TEMPLATE_DEFAULTS[kind];
        const stored = values.get(whatsappTemplateKey(kind));
        if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return fallback;
        const value = stored as Record<string, unknown>;
        const parsedStatus = whatsappTemplateStatusSchema.safeParse(value.status);
        const record = {
          ...fallback,
          ...value,
          kind,
          category: fallback.category,
          variableLabels: fallback.variableLabels,
          status: parsedStatus.success ? parsedStatus.data : 'DRAFT',
          isActive: value.isActive === true && parsedStatus.data === 'APPROVED',
          name: typeof value.name === 'string' ? value.name : fallback.name,
          language: typeof value.language === 'string' ? value.language : fallback.language,
          headerText: typeof value.headerText === 'string' ? value.headerText : fallback.headerText,
          body: typeof value.body === 'string' ? value.body : fallback.body,
          footer: typeof value.footer === 'string' ? value.footer : fallback.footer,
          examples: Array.isArray(value.examples) ? value.examples.map(String) : fallback.examples,
        } as WhatsAppTemplateRecord;

        // Refresh draft/rejected bodies that break Meta start/end/length rules.
        const editable =
          record.status === 'DRAFT' || record.status === 'REJECTED' || record.status === 'DISABLED';
        if (editable && getWhatsAppBodyMetaIssue(record.body)) {
          record.body = fallback.body;
          record.examples = fallback.examples;
          record.footer = fallback.footer;
          record.headerText = fallback.headerText;
        }

        return { ...record, isActive: record.isActive && hasCurrentTemplateContract(record) };
      },
    );
    whatsappTemplatesCache = {
      data: templates,
      expiresAt: now + WHATSAPP_TEMPLATE_CACHE_TTL_MS,
    };
    return templates;
  }

  async getWhatsAppTemplate(
    kind: WhatsAppTemplateKind,
    forceRefresh = false,
  ): Promise<WhatsAppTemplateRecord> {
    const templates = await this.getWhatsAppTemplates(forceRefresh);
    return templates.find((template) => template.kind === kind) ?? WHATSAPP_TEMPLATE_DEFAULTS[kind];
  }

  async saveWhatsAppTemplateDraft(
    kind: WhatsAppTemplateKind,
    input: WhatsAppTemplateDraftInput,
  ): Promise<WhatsAppTemplateRecord> {
    const fallback = WHATSAPP_TEMPLATE_DEFAULTS[kind];
    const record: WhatsAppTemplateRecord = {
      ...fallback,
      ...input,
      kind,
      category: fallback.category,
      variableLabels: fallback.variableLabels,
      status: 'DRAFT',
      isActive: false,
      metaTemplateId: undefined,
      rejectionReason: undefined,
      submittedAt: undefined,
      lastSyncedAt: undefined,
    };
    validateWhatsAppTemplateRecord(record);
    await this.storeWhatsAppTemplate(record);
    return record;
  }

  async setWhatsAppTemplateActive(
    kind: WhatsAppTemplateKind,
    isActive: boolean,
  ): Promise<WhatsAppTemplateRecord> {
    const current = await this.getWhatsAppTemplate(kind, true);
    if (isActive && current.status !== 'APPROVED') {
      throw new ApiError(409, 'Only an approved Meta template can be activated');
    }
    if (isActive && !hasCurrentTemplateContract(current)) {
      throw new ApiError(409, 'This marketing template must be resubmitted with the campaign link variable');
    }
    const updated = { ...current, isActive };
    await this.storeWhatsAppTemplate(updated);
    return updated;
  }

  async storeWhatsAppTemplate(record: WhatsAppTemplateRecord): Promise<void> {
    await prisma.setting.upsert({
      where: { key: whatsappTemplateKey(record.kind) },
      update: {
        value: record as unknown as Prisma.InputJsonValue,
        group: WHATSAPP_TEMPLATE_GROUP,
      },
      create: {
        key: whatsappTemplateKey(record.kind),
        value: record as unknown as Prisma.InputJsonValue,
        group: WHATSAPP_TEMPLATE_GROUP,
      },
    });
    invalidateWhatsAppTemplatesCache();
  }

  async upsert(key: string, value: unknown, group = 'general') {
    const result = await prisma.setting.upsert({
      where: { key },
      update: {
        value: value as Parameters<typeof prisma.setting.upsert>[0]['update']['value'],
        group,
      },
      create: {
        key,
        value: value as Parameters<typeof prisma.setting.upsert>[0]['create']['value'],
        group,
      },
    });
    invalidatePublicSettingsCache();
    if (group === WHATSAPP_TEMPLATE_GROUP) invalidateWhatsAppTemplatesCache();
    return result;
  }

  async getPublicSettings() {
    const now = Date.now();
    if (publicSettingsCache && publicSettingsCache.expiresAt > now) {
      return publicSettingsCache.data;
    }

    const settings = await prisma.setting.findMany({
      where: {
        group: { in: ['general', 'contact', 'social', 'shipping', 'home', 'announcement'] },
      },
    });

    const data = Object.fromEntries(settings.map((s) => [s.key, s.value]));
    publicSettingsCache = { data, expiresAt: now + PUBLIC_SETTINGS_TTL_MS };
    return data;
  }

  async getOurStoryImage() {
    const [image, publicId] = await Promise.all([
      this.getByKey(OUR_STORY_IMAGE_KEY),
      this.getByKey(OUR_STORY_PUBLIC_ID_KEY),
    ]);

    return {
      imageUrl: (image?.value as string) || null,
      publicId: (publicId?.value as string) || null,
    };
  }

  async uploadOurStoryImage(file: Express.Multer.File) {
    const existing = await this.getOurStoryImage();
    if (existing.publicId) {
      await localStorageService.deleteImage(existing.publicId);
    }

    const upload = await localStorageService.uploadImage(file.buffer, 'our-story');
    await this.upsert(OUR_STORY_IMAGE_KEY, upload.url, 'home');
    await this.upsert(OUR_STORY_PUBLIC_ID_KEY, upload.publicId, 'home');

    return {
      imageUrl: upload.url,
      publicId: upload.publicId,
    };
  }

  async deleteOurStoryImage() {
    const existing = await this.getOurStoryImage();
    if (existing.publicId) {
      await localStorageService.deleteImage(existing.publicId);
    }

    await prisma.setting.deleteMany({
      where: { key: { in: [OUR_STORY_IMAGE_KEY, OUR_STORY_PUBLIC_ID_KEY] } },
    });

    invalidatePublicSettingsCache();

    return { imageUrl: null, publicId: null };
  }

  async getInvoiceSignature() {
    const [image, publicId] = await Promise.all([
      this.getByKey(INVOICE_SIGNATURE_URL_KEY),
      this.getByKey(INVOICE_SIGNATURE_PUBLIC_ID_KEY),
    ]);

    return {
      imageUrl: (image?.value as string) || null,
      publicId: (publicId?.value as string) || null,
    };
  }

  async saveInvoiceSignature(dataUrl: string) {
    if (!dataUrl.startsWith('data:image/')) {
      throw new ApiError(400, 'Invalid signature data');
    }

    const base64 = dataUrl.split(',')[1];
    if (!base64) {
      throw new ApiError(400, 'Invalid signature data');
    }

    const buffer = Buffer.from(base64, 'base64');
    const existing = await this.getInvoiceSignature();
    if (existing.publicId) {
      await localStorageService.deleteImage(existing.publicId);
    }

    const upload = await localStorageService.uploadImage(buffer, 'invoice-signature');
    await this.upsert(INVOICE_SIGNATURE_URL_KEY, upload.url, 'invoice');
    await this.upsert(INVOICE_SIGNATURE_PUBLIC_ID_KEY, upload.publicId, 'invoice');

    return { imageUrl: upload.url, publicId: upload.publicId };
  }

  async deleteInvoiceSignature() {
    const existing = await this.getInvoiceSignature();
    if (existing.publicId) {
      await localStorageService.deleteImage(existing.publicId);
    }

    await prisma.setting.deleteMany({
      where: { key: { in: [INVOICE_SIGNATURE_URL_KEY, INVOICE_SIGNATURE_PUBLIC_ID_KEY] } },
    });

    return { imageUrl: null, publicId: null };
  }

  /** Pickup coordinates for Shiprocket Quick (admin Settings → Quick Delivery). */
  async getQuickPickupCoordinates(): Promise<{ latitude: number; longitude: number } | null> {
    const [latRow, lngRow] = await Promise.all([
      this.getByKey(QUICK_PICKUP_LAT_KEY),
      this.getByKey(QUICK_PICKUP_LNG_KEY),
    ]);
    const latitude = Number(latRow?.value);
    const longitude = Number(lngRow?.value);
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      return null;
    }
    return { latitude, longitude };
  }

  /**
   * Instant / Quick acceptance window (Asia/Kolkata).
   * - Holidays block Instant for the whole day.
   * - When start+end are set, Instant is only accepted inside that window.
   * - When times are not set, Instant is open any hour (holidays still apply).
   */
  async getQuickScheduleAvailability(at: Date = new Date()): Promise<QuickScheduleStatus> {
    const [startRow, endRow, holidaysRow] = await Promise.all([
      this.getByKey(QUICK_DELIVERY_START_KEY),
      this.getByKey(QUICK_DELIVERY_END_KEY),
      this.getByKey(QUICK_HOLIDAYS_KEY),
    ]);

    const zoned = getZonedDateParts(at, QUICK_TIMEZONE);
    const today = `${String(zoned.year).padStart(4, '0')}-${String(zoned.month).padStart(2, '0')}-${String(zoned.day).padStart(2, '0')}`;
    const holidays = normalizeHolidayDates(holidaysRow?.value);

    if (holidays.includes(today)) {
      return {
        available: false,
        reason: 'holiday',
        message: 'Instant delivery is not available today (holiday).',
      };
    }

    const start = parseHm(startRow?.value);
    const end = parseHm(endRow?.value);
    if (!start || !end) {
      return { available: true };
    }

    const nowMins = zoned.hour * 60 + zoned.minute;
    const startMins = start.hours * 60 + start.minutes;
    const endMins = end.hours * 60 + end.minutes;

    let inWindow: boolean;
    if (startMins === endMins) {
      inWindow = true;
    } else if (startMins < endMins) {
      inWindow = nowMins >= startMins && nowMins < endMins;
    } else {
      // Overnight window (e.g. 22:00 → 06:00)
      inWindow = nowMins >= startMins || nowMins < endMins;
    }

    if (!inWindow) {
      return {
        available: false,
        reason: 'outside_hours',
        message: `Instant delivery is available between ${formatHmLabel(start)} and ${formatHmLabel(end)}.`,
      };
    }

    return { available: true };
  }
}

export const settingsService = new SettingsService();
