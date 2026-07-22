import { z } from 'zod';

/** Relative `/uploads/...` path or absolute http(s) URL stored from local uploads. */
export const optionalStoredImagePathSchema = z
  .union([
    z.string().url(),
    z.string().regex(/^\/uploads\/[^\s]+$/),
  ])
  .optional()
  .or(z.literal(''));

export function isStoredImagePath(value: string): boolean {
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) || /^\/uploads\//.test(trimmed);
}
