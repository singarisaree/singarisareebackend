import { Prisma } from '@prisma/client';
import { prisma } from '@/config/database';
import { localStorageService } from '@/integrations/local-storage.service';
import { ApiError } from '@/shared/api-response';
import { invalidateCache } from '@/utils/memory-cache';
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

const WHATSAPP_TEMPLATE_DEFAULTS: Record<WhatsAppTemplateKind, WhatsAppTemplateRecord> = {
  order_placed: orderTemplate(
    'order_placed',
    'singari_order_placed',
    'Order placed',
    'Hello {{1}}, we received your Singari Sarees order {{2}}.\nOrder total: {{3}}',
    ['Lakshmi', 'SS12345', '₹2,499'],
    ['Customer name', 'Short order number', 'Formatted order total'],
  ),
  order_payment_pending: orderTemplate(
    'order_payment_pending',
    'singari_order_payment_pending',
    'Payment pending',
    'Hello {{1}}, payment is pending for your Singari Sarees order {{2}}.\nOrder total: {{3}}',
    ['Lakshmi', 'SS12345', '₹2,499'],
    ['Customer name', 'Short order number', 'Formatted order total'],
  ),
  order_confirmed: orderTemplate(
    'order_confirmed',
    'singari_order_confirmed',
    'Order confirmed',
    'Hello {{1}}, your Singari Sarees order {{2}} is confirmed.\nOrder total: {{3}}',
    ['Lakshmi', 'SS12345', '₹2,499'],
    ['Customer name', 'Short order number', 'Formatted order total'],
  ),
  order_ready_to_ship: orderTemplate(
    'order_ready_to_ship',
    'singari_order_ready_to_ship',
    'Ready to ship',
    'Hello {{1}}, your Singari Sarees order {{2}} is packed and ready to ship.',
    ['Lakshmi', 'SS12345'],
    ['Customer name', 'Short order number'],
  ),
  order_shipped: orderTemplate(
    'order_shipped',
    'singari_order_shipped',
    'Order shipped',
    'Hello {{1}}, your Singari Sarees order {{2}} has shipped.\nTrack it here: {{3}}',
    ['Lakshmi', 'SS12345', 'https://example.com/track'],
    ['Customer name', 'Short order number', 'Tracking URL'],
  ),
  order_in_transit: orderTemplate(
    'order_in_transit',
    'singari_order_in_transit',
    'Order in transit',
    'Hello {{1}}, your Singari Sarees order {{2}} is in transit.\nTrack it here: {{3}}',
    ['Lakshmi', 'SS12345', 'https://example.com/track'],
    ['Customer name', 'Short order number', 'Tracking URL'],
  ),
  order_delivered: orderTemplate(
    'order_delivered',
    'singari_order_delivered',
    'Order delivered',
    'Hello {{1}}, your Singari Sarees order {{2}} has been delivered. Thank you for shopping with us.',
    ['Lakshmi', 'SS12345'],
    ['Customer name', 'Short order number'],
  ),
  order_returned: orderTemplate(
    'order_returned',
    'singari_order_returned',
    'Order returned',
    'Hello {{1}}, your Singari Sarees order {{2}} has been marked as returned.',
    ['Lakshmi', 'SS12345'],
    ['Customer name', 'Short order number'],
  ),
  order_cancelled: orderTemplate(
    'order_cancelled',
    'singari_order_cancelled',
    'Order cancelled',
    'Hello {{1}}, your Singari Sarees order {{2}} has been cancelled.',
    ['Lakshmi', 'SS12345'],
    ['Customer name', 'Short order number'],
  ),
  order_failed: orderTemplate(
    'order_failed',
    'singari_order_failed',
    'Order failed',
    'Hello {{1}}, your Singari Sarees order {{2}} could not be completed. Please contact support if you need help.',
    ['Lakshmi', 'SS12345'],
    ['Customer name', 'Short order number'],
  ),
  order_rto: orderTemplate(
    'order_rto',
    'singari_order_rto',
    'Returned to origin',
    'Hello {{1}}, your Singari Sarees order {{2}} is being returned to origin.',
    ['Lakshmi', 'SS12345'],
    ['Customer name', 'Short order number'],
  ),
  order_refunded: orderTemplate(
    'order_refunded',
    'singari_order_refunded',
    'Order refunded',
    'Hello {{1}}, the refund for your Singari Sarees order {{2}} has been processed.',
    ['Lakshmi', 'SS12345'],
    ['Customer name', 'Short order number'],
  ),
  return_requested: orderTemplate(
    'return_requested',
    'singari_return_requested',
    'Return requested',
    'Hello {{1}}, your return request for Singari Sarees order {{2}} was received.\nReason: {{3}}',
    ['Lakshmi', 'SS12345', 'Product did not fit'],
    ['Customer name', 'Short order number', 'Return reason'],
  ),
  return_accepted: orderTemplate(
    'return_accepted',
    'singari_return_accepted',
    'Return accepted',
    'Hello {{1}}, your return request for Singari Sarees order {{2}} has been accepted.',
    ['Lakshmi', 'SS12345'],
    ['Customer name', 'Short order number'],
  ),
  return_rejected: orderTemplate(
    'return_rejected',
    'singari_return_rejected',
    'Return request update',
    'Hello {{1}}, your return request for Singari Sarees order {{2}} was not approved.\nNote: {{3}}',
    ['Lakshmi', 'SS12345', 'Please contact support for details'],
    ['Customer name', 'Short order number', 'Admin note'],
  ),
  return_out_for_pickup: orderTemplate(
    'return_out_for_pickup',
    'singari_return_out_for_pickup',
    'Return pickup arranged',
    'Hello {{1}}, pickup is arranged for your return from Singari Sarees order {{2}}.',
    ['Lakshmi', 'SS12345'],
    ['Customer name', 'Short order number'],
  ),
  return_pickup_cancelled: orderTemplate(
    'return_pickup_cancelled',
    'singari_return_pickup_cancelled',
    'Return pickup cancelled',
    'Hello {{1}}, pickup for your Singari Sarees order {{2}} return was cancelled. We will update you after rescheduling.',
    ['Lakshmi', 'SS12345'],
    ['Customer name', 'Short order number'],
  ),
  return_picked_up: orderTemplate(
    'return_picked_up',
    'singari_return_picked_up',
    'Return picked up',
    'Hello {{1}}, the return for your Singari Sarees order {{2}} has been picked up.',
    ['Lakshmi', 'SS12345'],
    ['Customer name', 'Short order number'],
  ),
  return_completed: orderTemplate(
    'return_completed',
    'singari_return_completed',
    'Return received',
    'Hello {{1}}, we received the return for your Singari Sarees order {{2}}.',
    ['Lakshmi', 'SS12345'],
    ['Customer name', 'Short order number'],
  ),
  refund_coupon_issued: orderTemplate(
    'refund_coupon_issued',
    'singari_refund_coupon_issued',
    'Store credit issued',
    'Hello {{1}}, for Singari Sarees order {{2}}, coupon {{3}} worth {{4}} has been issued. Shipping deduction: {{5}}. It expires on {{6}}.',
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
    'Hello {{1}}, welcome to Singari Sarees. Your account is ready and you can now view your orders and favourites.',
    ['Lakshmi'],
    ['Customer name'],
  ),
  marketing_text: {
    kind: 'marketing_text',
    name: 'singari_marketing_text',
    language: 'en',
    category: 'MARKETING',
    headerText: 'A special update for you',
    body: 'Hi {{1}},\n\n{{2}}\n\n{{3}}\n\nShop now: {{4}}\n\n— Singari Sarees',
    footer: 'Reply STOP to opt out',
    examples: [
      'Lakshmi',
      'Festive Sale',
      'Discover our latest sarees today.',
      'https://singarisarees.com/collections',
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
    body: 'Hi {{1}},\n\n{{2}}\n\n{{3}}\n\nShop now: {{4}}\n\n— Singari Sarees',
    footer: 'Reply STOP to opt out',
    examples: [
      'Lakshmi',
      'Festive Sale',
      'Discover our latest sarees today.',
      'https://singarisarees.com/collections',
    ],
    variableLabels: ['Customer name', 'Campaign heading', 'Campaign story', 'Campaign link'],
    status: 'DRAFT',
    isActive: false,
  },
};

function whatsappTemplateKey(kind: WhatsAppTemplateKind): string {
  return `whatsapp_template_${kind}`;
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
