import { Router, Response, Request } from 'express';
import { productService } from './product.service';
import {
  createProductSchema,
  updateProductSchema,
  updateBaseSoldCountSchema,
  updateColorStockSchema,
  reorderColorImagesSchema,
  updateColorSchema,
  addColorSchema,
  productQuerySchema,
  adminProductQuerySchema,
  updateInventorySchema,
  adminSaveProductSchema,
  adminCreateProductSchema,
  adminAddColorSchema,
} from './product.schema';
import { validateBody, validateQuery, validateParams, asyncHandler } from '@/middleware/validate';
import { authenticateAdmin, loadAdmin, AuthenticatedRequest } from '@/middleware/auth';
import { uploadMultiple, uploadAdminProductSave } from '@/middleware/upload';
import { sendSuccess } from '@/shared/api-response';
import { idParamSchema } from '@/modules/auth/auth.schema';
import { prisma } from '@/config/database';
import { ApiError } from '@/shared/api-response';
import { paramString } from '@/utils/params';
import { invalidateCache } from '@/utils/memory-cache';
import { realtime } from '@/realtime/emitter';
import { z } from 'zod';

const router = Router();

function parseAdminMultipartPayload<S extends z.ZodTypeAny>(
  raw: unknown,
  schema: S,
): z.infer<S> {
  if (typeof raw !== 'string') {
    throw new ApiError(400, 'Missing payload');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError(400, 'Invalid payload JSON');
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ApiError(400, result.error.issues[0]?.message ?? 'Invalid payload');
  }
  return result.data;
}

// Public routes
router.get(
  '/',
  validateQuery(productQuerySchema),
  asyncHandler(async (req: Request, res: Response) => {
    res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
    const result = await productService.findAll(req.query as Record<string, string>);
    sendSuccess(res, result.products, 'Products fetched', 200, result.meta);
  }),
);

router.get(
  '/admin/list',
  authenticateAdmin,
  loadAdmin,
  validateQuery(adminProductQuerySchema),
  asyncHandler(async (_req: AuthenticatedRequest, res: Response) => {
    const result = await productService.findAllForAdmin(
      _req.query as Record<string, string>,
    );
    sendSuccess(res, result.products, 'Products fetched', 200, result.meta);
  }),
);

router.get(
  '/latest-by-category',
  asyncHandler(async (_req: Request, res: Response) => {
    res.set('Cache-Control', 'public, max-age=120, stale-while-revalidate=300');
    const result = await productService.getLatestByCategory();
    sendSuccess(res, result, 'Latest products by category');
  }),
);

router.get(
  '/slug/:slug/storefront',
  validateParams(z.object({ slug: z.string() })),
  asyncHandler(async (req: Request, res: Response) => {
    res.set('Cache-Control', 'public, max-age=120, stale-while-revalidate=300');
    const product = await productService.findBySlugStorefront(paramString(req.params.slug));
    sendSuccess(res, product, 'Product fetched');
  }),
);

router.get(
  '/slug/:slug',
  validateParams(z.object({ slug: z.string() })),
  asyncHandler(async (req: Request, res: Response) => {
    res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
    const product = await productService.findBySlug(paramString(req.params.slug));
    sendSuccess(res, product, 'Product fetched');
  }),
);

router.get(
  '/:id/related',
  validateParams(idParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
    const rawLimit = parseInt(String(req.query.limit ?? '4'), 10);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 4;
    const related = await productService.getRelated(paramString(req.params.id), limit);
    sendSuccess(res, related, 'Related products');
  }),
);

router.get(
  '/:id',
  validateParams(idParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const product = await productService.findById(paramString(req.params.id));
    sendSuccess(res, product, 'Product fetched');
  }),
);

// Admin routes
router.post(
  '/admin-create',
  authenticateAdmin,
  loadAdmin,
  uploadAdminProductSave,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const payload = parseAdminMultipartPayload(req.body?.payload, adminCreateProductSchema);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const product = await productService.adminCreate(payload, files);
    sendSuccess(res, product, 'Product created', 201);
  }),
);

router.post(
  '/',
  authenticateAdmin,
  loadAdmin,
  validateBody(createProductSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const product = await productService.create(req.body);
    sendSuccess(res, product, 'Product created', 201);
  }),
);

router.put(
  '/:id',
  authenticateAdmin,
  loadAdmin,
  validateParams(idParamSchema),
  validateBody(updateProductSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const product = await productService.update(paramString(req.params.id), req.body);
    sendSuccess(res, product, 'Product updated');
  }),
);

router.put(
  '/:id/admin-save',
  authenticateAdmin,
  loadAdmin,
  validateParams(idParamSchema),
  uploadAdminProductSave,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const payload = parseAdminMultipartPayload(req.body?.payload, adminSaveProductSchema);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const product = await productService.adminSave(
      paramString(req.params.id),
      payload,
      files,
    );
    sendSuccess(res, product, 'Product saved');
  }),
);

router.patch(
  '/:id/base-sold-count',
  authenticateAdmin,
  loadAdmin,
  validateParams(idParamSchema),
  validateBody(updateBaseSoldCountSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const product = await productService.updateBaseSoldCount(
      paramString(req.params.id),
      req.body.baseSoldCount,
    );
    sendSuccess(res, product, 'Duplicate sold updated');
  }),
);

router.delete(
  '/:id',
  authenticateAdmin,
  loadAdmin,
  validateParams(idParamSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await productService.softDelete(paramString(req.params.id));
    sendSuccess(
      res,
      result,
      result.permanentlyDeleted
        ? 'Product permanently deleted'
        : 'Product has order history, so it was hidden instead of permanently deleted',
    );
  }),
);

router.post(
  '/:id/colors/admin-add',
  authenticateAdmin,
  loadAdmin,
  validateParams(idParamSchema),
  uploadAdminProductSave,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const payload = parseAdminMultipartPayload(req.body?.payload, adminAddColorSchema);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const product = await productService.adminAddColor(
      paramString(req.params.id),
      payload,
      files,
    );
    sendSuccess(res, product, 'Variant added', 201);
  }),
);

router.post(
  '/:id/colors',
  authenticateAdmin,
  loadAdmin,
  validateParams(idParamSchema),
  validateBody(addColorSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const product = await productService.addColor(paramString(req.params.id), req.body);
    sendSuccess(res, product, 'Variant added', 201);
  }),
);

router.patch(
  '/colors/:colorId',
  authenticateAdmin,
  loadAdmin,
  validateParams(z.object({ colorId: z.string().uuid() })),
  validateBody(updateColorSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const product = await productService.updateColor(
      paramString(req.params.colorId),
      req.body,
    );
    sendSuccess(res, product, 'Variant updated');
  }),
);

router.post(
  '/colors/:colorId/images',
  authenticateAdmin,
  loadAdmin,
  validateParams(z.object({ colorId: z.string().uuid() })),
  uploadMultiple,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const files = req.files as Express.Multer.File[];
    if (!files?.length) throw new ApiError(400, 'No images provided');
    const images = await productService.uploadColorImages(paramString(req.params.colorId), files);
    sendSuccess(res, images, 'Images uploaded', 201);
  }),
);

router.patch(
  '/colors/:colorId/images/reorder',
  authenticateAdmin,
  loadAdmin,
  validateParams(z.object({ colorId: z.string().uuid() })),
  validateBody(reorderColorImagesSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    await productService.reorderColorImages(
      paramString(req.params.colorId),
      req.body.orderedIds,
    );
    sendSuccess(res, null, 'Images reordered');
  }),
);

router.patch(
  '/colors/:colorId/stock',
  authenticateAdmin,
  loadAdmin,
  validateParams(z.object({ colorId: z.string().uuid() })),
  validateBody(updateColorStockSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const inventory = await productService.updateColorStock(
      paramString(req.params.colorId),
      req.body.availableStock,
    );
    sendSuccess(res, inventory, 'Stock updated');
  }),
);

router.delete(
  '/images/:imageId',
  authenticateAdmin,
  loadAdmin,
  validateParams(z.object({ imageId: z.string().uuid() })),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    await productService.deleteImage(paramString(req.params.imageId));
    sendSuccess(res, null, 'Image deleted');
  }),
);

router.patch(
  '/inventory/:inventoryId',
  authenticateAdmin,
  loadAdmin,
  validateParams(z.object({ inventoryId: z.string().uuid() })),
  validateBody(updateInventorySchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const inventory = await prisma.inventory.findFirst({
      where: { id: paramString(req.params.inventoryId), deletedAt: null },
    });
    if (!inventory) throw new ApiError(404, 'Inventory not found');

    const { quantity, reserved, lowStockAlert, reason } = req.body;
    const previousQty = inventory.quantity;

    const updated = await prisma.$transaction(async (tx) => {
      const inv = await tx.inventory.update({
        where: { id: paramString(req.params.inventoryId) },
        data: {
          ...(quantity !== undefined && { quantity }),
          ...(reserved !== undefined && { reserved }),
          ...(lowStockAlert !== undefined && { lowStockAlert }),
        },
      });

      if (quantity !== undefined && quantity !== previousQty) {
        await tx.inventoryHistory.create({
          data: {
            inventoryId: inv.id,
            changeType: quantity > previousQty ? 'IN' : 'OUT',
            quantity: Math.abs(quantity - previousQty),
            previousQty,
            newQty: quantity,
            reason: reason || 'Manual adjustment',
          },
        });
      }

      return inv;
    });

    invalidateCache('product:');
    invalidateCache('products:list:');
    invalidateCache('products:storefront-list:');
    invalidateCache('products:admin:list:');
    invalidateCache('product:related:');
    invalidateCache('category:page:');
    invalidateCache('storefront:');
    invalidateCache('categories:');
    realtime.catalogChanged('inventory');

    sendSuccess(res, updated, 'Inventory updated');
  }),
);

export default router;
