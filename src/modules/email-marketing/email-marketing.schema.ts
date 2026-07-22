import { z } from 'zod';
import { optionalStoredImagePathSchema } from '@/utils/stored-image-path';

const audienceSchema = z.object({
  customerIds: z.array(z.string().uuid()).max(5000).optional(),
  sendToAll: z.boolean().optional().default(false),
});

export const emailMarketingPreviewSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  heading: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10000),
  imageUrl: optionalStoredImagePathSchema,
  sampleName: z.string().trim().min(1).max(100).optional().default('Priya'),
});

export const emailMarketingEligibilitySchema = audienceSchema;

export const sendEmailMarketingSchema = audienceSchema.extend({
  templateKey: z.string().trim().min(1).max(100),
  subject: z.string().trim().min(1).max(200),
  heading: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10000),
  imageUrl: optionalStoredImagePathSchema,
});
