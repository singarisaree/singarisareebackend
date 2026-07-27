import { Router, Response, Request } from 'express';
import { showcaseService } from './showcase.service';
import {
  createShowcaseItemFieldsSchema,
  reorderShowcaseSchema,
  updateShowcaseCategoriesSchema,
  updateShowcaseItemFieldsSchema,
} from './showcase.schema';
import { validateBody, validateParams, asyncHandler } from '@/middleware/validate';
import { authenticateAdmin, loadAdmin, AuthenticatedRequest } from '@/middleware/auth';
import { sendSuccess } from '@/shared/api-response';
import { idParamSchema } from '@/modules/auth/auth.schema';
import { uploadInstagramReelVideo } from '@/middleware/upload';
import { ApiError } from '@/shared/api-response';
import { paramString } from '@/utils/params';
import { publicCache } from '@/middleware/cache';
import { invalidateCache } from '@/utils/memory-cache';
import { realtime } from '@/realtime/emitter';

const router = Router();

function invalidateShowcaseCaches() {
  invalidateCache('storefront:homepage');
  realtime.catalogChanged('showcase');
}

router.get(
  '/',
  publicCache(60),
  asyncHandler(async (_req: Request, res: Response) => {
    const items = await showcaseService.findActiveForStorefront();
    sendSuccess(res, items, 'Showcase fetched');
  }),
);

router.get(
  '/admin',
  authenticateAdmin,
  loadAdmin,
  asyncHandler(async (_req: AuthenticatedRequest, res: Response) => {
    const data = await showcaseService.findAllAdmin();
    sendSuccess(res, data, 'Showcase admin data fetched');
  }),
);

router.put(
  '/categories',
  authenticateAdmin,
  loadAdmin,
  validateBody(updateShowcaseCategoriesSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const categoryIds = await showcaseService.setCategoryIds(req.body.categoryIds);
    invalidateShowcaseCaches();
    sendSuccess(res, { categoryIds }, 'Showcase categories updated');
  }),
);

router.post(
  '/',
  authenticateAdmin,
  loadAdmin,
  uploadInstagramReelVideo,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.file) throw new ApiError(400, 'Video file is required');
    const parsed = createShowcaseItemFieldsSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(400, parsed.error.errors[0]?.message || 'Invalid showcase data');
    }
    const item = await showcaseService.createItem(parsed.data, req.file);
    invalidateShowcaseCaches();
    sendSuccess(res, item, 'Showcase video added', 201);
  }),
);

router.put(
  '/reorder',
  authenticateAdmin,
  loadAdmin,
  validateBody(reorderShowcaseSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const items = await showcaseService.reorderItems(req.body.orderedIds);
    invalidateShowcaseCaches();
    sendSuccess(res, items, 'Showcase videos reordered');
  }),
);

router.put(
  '/:id',
  authenticateAdmin,
  loadAdmin,
  validateParams(idParamSchema),
  uploadInstagramReelVideo,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const parsed = updateShowcaseItemFieldsSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(400, parsed.error.errors[0]?.message || 'Invalid showcase data');
    }
    const updated = await showcaseService.updateItem(
      paramString(req.params.id),
      parsed.data,
      req.file,
    );
    invalidateShowcaseCaches();
    sendSuccess(res, updated, 'Showcase video updated');
  }),
);

router.delete(
  '/:id',
  authenticateAdmin,
  loadAdmin,
  validateParams(idParamSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    await showcaseService.deleteItem(paramString(req.params.id));
    invalidateShowcaseCaches();
    sendSuccess(res, null, 'Showcase video deleted');
  }),
);

export default router;
