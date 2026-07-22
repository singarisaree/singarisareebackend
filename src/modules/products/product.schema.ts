import { z } from 'zod';

export const createCategorySchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().optional(),
  imageUrl: z.string().url().optional(),
  sortOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
  seoTitle: z.string().optional(),
  seoDesc: z.string().optional(),
});

export const updateCategorySchema = createCategorySchema.partial();

export const createProductSchema = z.object({
  name: z.string().min(2).max(200),
  categoryId: z.string().uuid(),
  description: z.string().min(10),
  productDetails: z.string().max(5000).optional(),
  fabric: z.string().optional(),
  care: z.string().optional(),
  shippingInfo: z.string().optional(),
  returnPolicy: z.string().optional(),
  price: z.number().positive(),
  mrp: z.number().positive(),
  discount: z.number().min(0).max(100).optional(),
  weight: z.number().positive().optional(),
  length: z.number().positive().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  tags: z.array(z.string()).optional(),
  seoTitle: z.string().optional(),
  seoDesc: z.string().optional(),
  seoKeywords: z.array(z.string()).optional(),
  baseSoldCount: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
  isComingSoon: z.boolean().optional(),
  isFeatured: z.boolean().optional(),
  colors: z
    .array(
      z.object({
        name: z.string().min(1),
        hexCode: z.string().optional(),
        sortOrder: z.number().int().optional(),
        stock: z.number().int().min(0).default(0),
      }),
    )
    .min(1),
});

export const updateProductSchema = createProductSchema.partial().omit({ colors: true });

/** One color/variant slice of an atomic admin product save */
export const adminSaveColorSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).optional(),
  hexCode: z.string().optional(),
  isActive: z.boolean().optional(),
  availableStock: z.number().int().min(0).optional(),
  deleteImageIds: z.array(z.string().uuid()).max(6).optional(),
  /**
   * Final gallery order. Use existing image UUIDs, or `"new"` for each uploaded
   * file for this color (files arrive as `color_<colorId>` in matching order).
   */
  orderedImageRefs: z
    .array(z.union([z.string().uuid(), z.literal('new')]))
    .max(6)
    .optional(),
});

export const adminSaveProductSchema = z.object({
  product: updateProductSchema.default({}),
  colors: z.array(adminSaveColorSchema).default([]),
});

export const updateBaseSoldCountSchema = z.object({
  baseSoldCount: z.number().int().min(0).max(999999),
});

export const addColorSchema = z.object({
  name: z.string().min(1),
  hexCode: z.string().optional(),
  sortOrder: z.number().int().optional(),
  stock: z.number().int().min(0).default(0),
  isActive: z.boolean().optional(),
});

/** Multipart create: same as createProductSchema; files use field `color_<index>` */
export const adminCreateProductSchema = createProductSchema;

/** Multipart add-variant: same as addColorSchema; files use field `images` */
export const adminAddColorSchema = addColorSchema;

export const updateColorSchema = z.object({
  name: z.string().min(1).optional(),
  hexCode: z.string().optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

export const updateColorStockSchema = z.object({
  availableStock: z.number().int().min(0),
});

export const reorderColorImagesSchema = z.object({
  orderedIds: z.array(z.string().uuid()).min(1).max(6),
});

export const updateInventorySchema = z.object({
  quantity: z.number().int().min(0).optional(),
  reserved: z.number().int().min(0).optional(),
  lowStockAlert: z.number().int().min(0).optional(),
  reason: z.string().optional(),
});

export const productQuerySchema = z.object({
  page: z.string().optional().default('1'),
  limit: z.string().optional().default('20'),
  search: z.string().optional(),
  categoryId: z.string().uuid().optional(),
  categorySlug: z.string().optional(),
  isActive: z.string().optional(),
  isFeatured: z.string().optional(),
  minPrice: z.string().optional(),
  maxPrice: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  sortBy: z.enum(['price', 'name', 'createdAt', 'soldCount']).optional().default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
});

/** Admin list — same filters as storefront query, without public cache */
export const adminProductQuerySchema = productQuerySchema;
