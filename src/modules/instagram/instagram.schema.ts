import { z } from 'zod';

const MAX_INSTAGRAM_REELS = 10;

const instagramReelUrlSchema = z
  .string()
  .trim()
  .min(1, 'Instagram video URL is required')
  .max(500)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        if (!/(^|\.)instagram\.com$/i.test(url.hostname)) return false;
        return /\/(reel|reels|p|tv)\//i.test(url.pathname);
      } catch {
        return false;
      }
    },
    { message: 'Enter a valid Instagram reel/post URL' },
  );

export const createInstagramReelSchema = z.object({
  videoUrl: instagramReelUrlSchema,
  sortOrder: z.coerce.number().int().min(0).max(999).optional(),
  isActive: z.boolean().optional(),
});

export const updateInstagramReelSchema = z.object({
  videoUrl: instagramReelUrlSchema.optional(),
  sortOrder: z.coerce.number().int().min(0).max(999).optional(),
  isActive: z.boolean().optional(),
});

export const reorderInstagramReelsSchema = z.object({
  orderedIds: z.array(z.string().uuid()).min(1).max(MAX_INSTAGRAM_REELS),
});

export { MAX_INSTAGRAM_REELS };
