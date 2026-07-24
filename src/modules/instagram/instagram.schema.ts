import { z } from 'zod';

const MAX_INSTAGRAM_REELS = 10;

/** Normal Instagram reel/post link for click-through to the app/site. */
export function normalizeInstagramLink(raw: string): string | null {
  try {
    let candidate = raw.trim().replace(/&amp;/g, '&');
    if (/^(?:www\.)?(?:instagram\.com|instagr\.am)\//i.test(candidate)) {
      candidate = `https://${candidate.replace(/^https?:\/\//i, '')}`;
    }
    const url = new URL(candidate);
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    if (host !== 'instagram.com' && host !== 'instagr.am') return null;

    let path = url.pathname.replace(/\/+$/, '');
    path = path.replace(/\/embed(?:\/captioned)?$/i, '');
    path = path.replace(/^\/reels\//i, '/reel/');
    path = path
      .replace(/^\/share\/(reel|reels|p|tv)\//i, '/$1/')
      .replace(/^\/reels\//i, '/reel/');

    if (!/^\/(reel|p|tv)\/[^/]+$/i.test(path)) return null;
    if (!path.endsWith('/')) path += '/';
    return `https://www.instagram.com${path}`;
  } catch {
    return null;
  }
}

const instagramLinkSchema = z
  .string()
  .trim()
  .min(1, 'Instagram link is required')
  .max(500)
  .transform((value, ctx) => {
    const link = normalizeInstagramLink(value);
    if (!link) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Enter a normal Instagram reel/post link, e.g. https://www.instagram.com/reel/XXXX/',
      });
      return z.NEVER;
    }
    return link;
  });

export const createInstagramReelFieldsSchema = z.object({
  instagramUrl: instagramLinkSchema,
  sortOrder: z.coerce.number().int().min(0).max(999).optional(),
  isActive: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .optional()
    .transform((value) => {
      if (value === undefined) return undefined;
      if (typeof value === 'boolean') return value;
      return value === 'true' || value === '1';
    }),
});

export const updateInstagramReelFieldsSchema = z.object({
  instagramUrl: instagramLinkSchema.optional(),
  sortOrder: z.coerce.number().int().min(0).max(999).optional(),
  isActive: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .optional()
    .transform((value) => {
      if (value === undefined) return undefined;
      if (typeof value === 'boolean') return value;
      return value === 'true' || value === '1';
    }),
});

export const reorderInstagramReelsSchema = z.object({
  orderedIds: z.array(z.string().uuid()).min(1).max(MAX_INSTAGRAM_REELS),
});

export { MAX_INSTAGRAM_REELS };
