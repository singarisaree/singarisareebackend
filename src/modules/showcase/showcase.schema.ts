import { z } from 'zod';

export const MAX_SHOWCASE_ITEMS = 6;
export const SHOWCASE_CATEGORY_IDS_KEY = 'showcase_category_ids';

export const updateShowcaseCategoriesSchema = z.object({
  categoryIds: z.array(z.string().uuid()).max(50),
});

export const createShowcaseItemFieldsSchema = z.object({
  productId: z.string().uuid(),
  productColorId: z.string().uuid(),
  sortOrder: z.coerce.number().int().min(0).max(99).optional(),
  isActive: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === true || v === 'true')),
});

export const updateShowcaseItemFieldsSchema = z.object({
  productId: z.string().uuid().optional(),
  productColorId: z.string().uuid().optional(),
  sortOrder: z.coerce.number().int().min(0).max(99).optional(),
  isActive: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === true || v === 'true')),
});

export const reorderShowcaseSchema = z.object({
  orderedIds: z.array(z.string().uuid()).min(1).max(MAX_SHOWCASE_ITEMS),
});
