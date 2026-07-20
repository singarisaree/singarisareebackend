import { z } from 'zod';

const phoneSchema = z.string().regex(/^[6-9]\d{9}$/, 'Enter valid 10-digit Indian mobile number');

export const createCustomerSchema = z.object({
  name: z.string().min(2).max(100),
  phone: phoneSchema,
  email: z.string().email().optional().or(z.literal('')),
  notes: z.string().max(500).optional(),
  allowMarketing: z.boolean().optional(),
});

export const updateCustomerSchema = createCustomerSchema.partial();

export const customerQuerySchema = z.object({
  search: z.string().optional(),
  source: z.enum(['ORDER', 'MANUAL', 'VIP', 'ALL']).optional().default('ALL'),
  page: z.string().optional().default('1'),
  limit: z.string().optional().default('50'),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});
