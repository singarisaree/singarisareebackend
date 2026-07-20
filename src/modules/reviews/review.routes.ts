import { Router, Response, Request } from 'express';
import { reviewService, createReviewSchema, updateReviewSchema } from './review.service';
import { validateBody, validateParams, asyncHandler, validateQuery } from '@/middleware/validate';
import { authenticateAdmin, loadAdmin, AuthenticatedRequest } from '@/middleware/auth';
import { sendSuccess } from '@/shared/api-response';
import { idParamSchema, paginationSchema } from '@/modules/auth/auth.schema';
import { uploadSingle } from '@/middleware/upload';
import { paramString } from '@/utils/params';
import { z } from 'zod';

const router = Router();

router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const reviews = await reviewService.findActive();
    sendSuccess(res, reviews, 'Reviews fetched');
  }),
);

router.get(
  '/product/:productId',
  validateParams(z.object({ productId: z.string().uuid() })),
  asyncHandler(async (req: Request, res: Response) => {
    const reviews = await reviewService.findByProductId(paramString(req.params.productId));
    sendSuccess(res, reviews, 'Product reviews fetched');
  }),
);

router.get(
  '/all',
  authenticateAdmin,
  loadAdmin,
  validateQuery(paginationSchema.extend({
    productId: z.string().uuid().optional(),
    categoryId: z.string().uuid().optional(),
  })),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await reviewService.findAllPaginated(req.query as Record<string, string>);
    sendSuccess(res, result.reviews, 'All reviews fetched', 200, result.meta);
  }),
);

router.post(
  '/',
  authenticateAdmin,
  loadAdmin,
  uploadSingle,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const parsed = createReviewSchema.parse({
      ...req.body,
      rating: parseInt(req.body.rating),
      isActive: req.body.isActive !== 'false',
      sortOrder: req.body.sortOrder ? parseInt(req.body.sortOrder) : undefined,
    });
    const review = await reviewService.create(parsed, req.file);
    sendSuccess(res, review, 'Review created', 201);
  }),
);

router.put(
  '/:id',
  authenticateAdmin,
  loadAdmin,
  validateParams(idParamSchema),
  validateBody(updateReviewSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const review = await reviewService.update(paramString(req.params.id), req.body);
    sendSuccess(res, review, 'Review updated');
  }),
);

router.delete(
  '/:id',
  authenticateAdmin,
  loadAdmin,
  validateParams(idParamSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    await reviewService.softDelete(paramString(req.params.id));
    sendSuccess(res, null, 'Review deleted');
  }),
);

export default router;
