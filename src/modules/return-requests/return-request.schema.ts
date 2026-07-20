import { z } from 'zod';
import { ReturnRequestStatus } from '@prisma/client';

export const RETURN_REASONS = [
  'Wrong item received',
  'Defective or damaged product',
  'Color or design mismatch',
  'Quality not as expected',
  'Changed my mind',
  'Other',
] as const;

export const createReturnRequestSchema = z.object({
  orderId: z.string().uuid(),
  phone: z.string().regex(/^[6-9]\d{9}$/, 'Enter valid 10-digit mobile number'),
  reason: z.string().min(5, 'Please provide a return reason').max(1000),
  items: z
    .array(
      z.object({
        orderItemId: z.string().uuid(),
        quantity: z.number().int().positive(),
      }),
    )
    .min(1),
});

export const returnRequestQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  status: z.nativeEnum(ReturnRequestStatus).optional(),
  search: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export const updateReturnRequestStatusSchema = z.object({
  status: z.nativeEnum(ReturnRequestStatus),
  adminNotes: z.string().max(2000).optional(),
  /** Escalation: allow any status jump */
  force: z.boolean().optional(),
});

export const adminCreateReturnRequestSchema = z.object({
  orderId: z.string().uuid(),
  reason: z.string().min(5, 'Please provide a return reason').max(1000),
  items: z
    .array(
      z.object({
        orderItemId: z.string().uuid(),
        quantity: z.number().int().positive(),
      }),
    )
    .min(1),
  adminNotes: z.string().max(2000).optional(),
  /** Default ACCEPTED for escalation arrange-return */
  initialStatus: z.nativeEnum(ReturnRequestStatus).optional(),
  force: z.boolean().optional().default(true),
});
