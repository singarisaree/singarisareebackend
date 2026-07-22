import { z } from 'zod';

/** Admin-only preview path. Accept https URLs, `/uploads/...`, or drop invalid values. */
const optionalHeaderPreviewUrlSchema = z.preprocess((value) => {
  if (value == null) return undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('blob:')) return undefined;
  if (/^https?:\/\//i.test(trimmed) || /^\/uploads\//.test(trimmed)) return trimmed;
  return undefined;
}, z.string().max(4000).optional());

export const orderStatusTemplateKinds = {
  PLACED: 'order_placed',
  PAYMENT_PENDING: 'order_payment_pending',
  CONFIRMED: 'order_confirmed',
  READY_TO_SHIP: 'order_ready_to_ship',
  SHIPPED: 'order_shipped',
  IN_TRANSIT: 'order_in_transit',
  DELIVERED: 'order_delivered',
  RETURNED: 'order_returned',
  CANCELLED: 'order_cancelled',
  FAILED: 'order_failed',
  RTO: 'order_rto',
  REFUNDED: 'order_refunded',
} as const;

export const returnStatusTemplateKinds = {
  REQUESTED: 'return_requested',
  ACCEPTED: 'return_accepted',
  REJECTED: 'return_rejected',
  OUT_FOR_PICKUP: 'return_out_for_pickup',
  PICKUP_CANCELLED: 'return_pickup_cancelled',
  PICKED_UP: 'return_picked_up',
  RETURNED: 'return_completed',
} as const;

export const refundCouponTemplateKind = 'refund_coupon_issued' as const;

export const whatsappTemplateKinds = [
  'order_placed',
  'order_payment_pending',
  'order_confirmed',
  'order_ready_to_ship',
  'order_shipped',
  'order_in_transit',
  'order_delivered',
  'order_returned',
  'order_cancelled',
  'order_failed',
  'order_rto',
  'order_refunded',
  'return_requested',
  'return_accepted',
  'return_rejected',
  'return_out_for_pickup',
  'return_pickup_cancelled',
  'return_picked_up',
  'return_completed',
  'refund_coupon_issued',
  'customer_welcome',
  'customer_login_otp',
  'marketing_text',
  'marketing_image',
] as const;

export type WhatsAppTemplateKind = (typeof whatsappTemplateKinds)[number];

export const whatsappTemplateStatusSchema = z.enum([
  'DRAFT',
  'PENDING',
  'APPROVED',
  'REJECTED',
  'PAUSED',
  'DISABLED',
  'IN_APPEAL',
  'DELETED',
]);

export type WhatsAppTemplateStatus = z.infer<typeof whatsappTemplateStatusSchema>;

const templateNameSchema = z
  .string()
  .trim()
  .min(1, 'Template name is required')
  .max(512)
  .regex(/^[a-z0-9_]+$/, 'Use lowercase letters, numbers, and underscores only');

export const whatsappTemplateDraftSchema = z.object({
  name: templateNameSchema,
  language: z.string().trim().min(2).max(20),
  headerText: z.string().trim().max(60).default(''),
  body: z.string().trim().min(1).max(1024),
  footer: z.string().trim().max(60).default(''),
  examples: z.array(z.string().trim().min(1).max(200)).max(10),
  headerHandle: z.string().trim().max(4000).optional(),
  headerPreviewUrl: optionalHeaderPreviewUrlSchema,
});

export type WhatsAppTemplateDraftInput = z.infer<typeof whatsappTemplateDraftSchema>;

export interface WhatsAppTemplateRecord extends WhatsAppTemplateDraftInput {
  kind: WhatsAppTemplateKind;
  category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';
  variableLabels: string[];
  status: WhatsAppTemplateStatus;
  isActive: boolean;
  metaTemplateId?: string;
  rejectionReason?: string;
  submittedAt?: string;
  lastSyncedAt?: string;
}

export const templateKindParamSchema = z.object({
  kind: z.enum(whatsappTemplateKinds),
});
