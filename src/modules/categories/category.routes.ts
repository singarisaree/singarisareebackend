import { Router, Response } from 'express';
import { categoryService } from './category.service';
import { createCategorySchema, updateCategorySchema } from '@/modules/products/product.schema';
import { validateBody, validateParams, asyncHandler } from '@/middleware/validate';
import { authenticateAdmin, loadAdmin, AuthenticatedRequest } from '@/middleware/auth';
import { sendSuccess } from '@/shared/api-response';
import { idParamSchema } from '@/modules/auth/auth.schema';
import { uploadSingle } from '@/middleware/upload';
import { ApiError } from '@/shared/api-response';
import { paramString } from '@/utils/params';
import { Request } from 'express';
import { z } from 'zod';

const router = Router();

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const activeOnly = req.query.all !== 'true';
    if (!activeOnly && req.query.page) {
      const result = await categoryService.findAllPaginated(req.query as Record<string, string>);
      sendSuccess(res, result.categories, 'Categories fetched', 200, result.meta);
      return;
    }
    if (activeOnly) {
      res.set(
        'Cache-Control',
        'public, max-age=120, stale-while-revalidate=600',
      );
    }
    const categories = await categoryService.findAll(activeOnly, {
      withProductCount: !activeOnly,
    });
    sendSuccess(res, categories, 'Categories fetched');
  }),
);

router.get(
  '/slug/:slug/storefront',
  validateParams(z.object({ slug: z.string() })),
  asyncHandler(async (req: Request, res: Response) => {
    res.set('Cache-Control', 'public, max-age=120, stale-while-revalidate=300');
    const page = await categoryService.getStorefrontPage(paramString(req.params.slug));
    sendSuccess(res, page, 'Category page fetched');
  }),
);

router.get(
  '/slug/:slug',
  validateParams(z.object({ slug: z.string() })),
  asyncHandler(async (req: Request, res: Response) => {
    res.set('Cache-Control', 'public, max-age=120, stale-while-revalidate=600');
    const category = await categoryService.findBySlug(paramString(req.params.slug));
    sendSuccess(res, category, 'Category fetched');
  }),
);

router.get(
  '/:id',
  validateParams(idParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const category = await categoryService.findById(paramString(req.params.id));
    sendSuccess(res, category, 'Category fetched');
  }),
);

router.post(
  '/',
  authenticateAdmin,
  loadAdmin,
  validateBody(createCategorySchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const category = await categoryService.create(req.body);
    sendSuccess(res, category, 'Category created', 201);
  }),
);

router.put(
  '/:id',
  authenticateAdmin,
  loadAdmin,
  validateParams(idParamSchema),
  validateBody(updateCategorySchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const category = await categoryService.update(paramString(req.params.id), req.body);
    sendSuccess(res, category, 'Category updated');
  }),
);

router.delete(
  '/:id',
  authenticateAdmin,
  loadAdmin,
  validateParams(idParamSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    await categoryService.softDelete(paramString(req.params.id));
    sendSuccess(res, null, 'Category deleted');
  }),
);

router.patch(
  '/:id/unhide',
  authenticateAdmin,
  loadAdmin,
  validateParams(idParamSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const category = await categoryService.unhide(paramString(req.params.id));
    sendSuccess(res, category, 'Category unhidden');
  }),
);

router.post(
  '/:id/image',
  authenticateAdmin,
  loadAdmin,
  validateParams(idParamSchema),
  uploadSingle,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.file) throw new ApiError(400, 'No image provided');
    const category = await categoryService.uploadImage(paramString(req.params.id), req.file);
    sendSuccess(res, category, 'Category image uploaded');
  }),
);

export default router;
