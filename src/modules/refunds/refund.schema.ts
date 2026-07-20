import { z } from 'zod';

export const refundQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  search: z.string().optional(),
  filter: z.enum(['pending', 'completed', 'all']).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export const processRefundSchema = z.object({
  deduction: z.coerce.number().min(0).default(0),
  couponAmount: z.coerce.number().positive('Coupon amount must be greater than zero'),
  /** Escalation: skip cancelled/returned/RTO eligibility checks */
  force: z.boolean().optional(),
});
