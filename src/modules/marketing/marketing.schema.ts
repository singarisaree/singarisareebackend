import { z } from 'zod';
import { optionalStoredImagePathSchema } from '@/utils/stored-image-path';

export const previewMarketingSchema = z.object({
  heading: z.string().min(1).max(200),
  story: z.string().min(1).max(2000),
  sampleName: z.string().min(1).max(100).optional().default('Priya'),
});

export const sendMarketingSchema = z.object({
  templateKey: z.string().min(1),
  heading: z.string().min(1).max(200),
  story: z.string().min(1).max(2000),
  campaignLink: z
    .string()
    .url()
    .refine((value) => /^https?:\/\//i.test(value), 'Link must start with http:// or https://'),
  imageUrl: optionalStoredImagePathSchema,
  customerIds: z.array(z.string().uuid()).optional(),
  sendToAll: z.boolean().optional().default(false),
});
