import { z } from 'zod';

const MAX_INSTAGRAM_REELS = 10;

const EMBED_MARKERS =
  /<blockquote[\s\S]*instagram-media|data-instgrm-permalink|data-instgrm-version|<iframe[^>]+instagram\.com[^>]+\/embed/i;

/**
 * Only Instagram embed HTML is accepted (blockquote / iframe embed).
 * Plain reel/post share URLs are rejected.
 */
export function extractPermalinkFromEmbedHtml(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || !EMBED_MARKERS.test(trimmed)) return null;

  const permalinkAttr = trimmed.match(
    /data-instgrm-permalink=["']([^"']+)["']/i,
  );
  if (permalinkAttr?.[1]) {
    return cleanPermalink(permalinkAttr[1]);
  }

  const iframeSrc = trimmed.match(
    /<iframe[^>]+src=["']([^"']*instagram\.com[^"']*\/embed[^"']*)["']/i,
  );
  if (iframeSrc?.[1]) {
    return cleanPermalink(iframeSrc[1]);
  }

  // Official embed blockquote often includes an <a href="permalink">
  if (/instagram-media/i.test(trimmed)) {
    const href = trimmed.match(
      /href=["'](https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels|p|tv)\/[^"']+)["']/i,
    );
    if (href?.[1]) return cleanPermalink(href[1]);
  }

  return null;
}

function cleanPermalink(value: string): string | null {
  try {
    const url = new URL(value.trim().replace(/&amp;/g, '&'));
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    if (host !== 'instagram.com' && host !== 'instagr.am') return null;

    let path = url.pathname.replace(/\/+$/, '');
    path = path.replace(/\/embed(?:\/captioned)?$/i, '');
    path = path.replace(/^\/reels\//i, '/reel/');
    path = path.replace(/^\/share\/(reel|reels|p|tv)\//i, '/$1/').replace(/^\/reels\//i, '/reel/');

    if (!/^\/(reel|p|tv)\/[^/]+$/i.test(path)) return null;

    if (!path.endsWith('/')) path += '/';
    return `https://www.instagram.com${path}`;
  } catch {
    return null;
  }
}

function looksLikePlainInstagramUrl(value: string): boolean {
  const trimmed = value.trim();
  if (EMBED_MARKERS.test(trimmed)) return false;
  return /^(?:https?:\/\/)?(?:www\.)?(?:instagram\.com|instagr\.am)\//i.test(trimmed);
}

const instagramReelUrlSchema = z
  .string()
  .trim()
  .min(1, 'Instagram embed code is required')
  .max(8000)
  .transform((value, ctx) => {
    if (looksLikePlainInstagramUrl(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Paste Instagram embed HTML only (Embed → Copy embed code). Normal Instagram links are not accepted.',
      });
      return z.NEVER;
    }

    const permalink = extractPermalinkFromEmbedHtml(value);
    if (!permalink) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Invalid Instagram embed. On Instagram: Share → Embed → Copy embed code, then paste it here.',
      });
      return z.NEVER;
    }
    return permalink;
  });

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
