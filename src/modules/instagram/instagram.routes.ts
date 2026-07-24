import { Router, Response, Request } from 'express';
import { instagramService } from './instagram.service';
import {
  createInstagramReelSchema,
  reorderInstagramReelsSchema,
  updateInstagramReelSchema,
} from './instagram.schema';
import { validateBody, validateParams, asyncHandler } from '@/middleware/validate';
import { authenticateAdmin, loadAdmin, AuthenticatedRequest } from '@/middleware/auth';
import { sendSuccess } from '@/shared/api-response';
import { idParamSchema } from '@/modules/auth/auth.schema';
import { uploadSingle } from '@/middleware/upload';
import { ApiError } from '@/shared/api-response';
import { paramString } from '@/utils/params';
import { publicCache } from '@/middleware/cache';
import { invalidateCache } from '@/utils/memory-cache';
import { realtime } from '@/realtime/emitter';

const router = Router();

function invalidateInstagramCaches() {
  invalidateCache('storefront:homepage');
  realtime.catalogChanged('instagram-reels');
}

router.get(
  '/',
  publicCache(120),
  asyncHandler(async (_req: Request, res: Response) => {
    const feeds = await instagramService.findActive();
    sendSuccess(res, feeds, 'Instagram feeds fetched');
  }),
);

router.get(
  '/reels',
  publicCache(60),
  asyncHandler(async (_req: Request, res: Response) => {
    const reels = await instagramService.findActiveReels();
    sendSuccess(res, reels, 'Instagram reels fetched');
  }),
);

router.get(
  '/reels/all',
  authenticateAdmin,
  loadAdmin,
  asyncHandler(async (_req: AuthenticatedRequest, res: Response) => {
    const reels = await instagramService.findAllReels();
    sendSuccess(res, reels, 'All Instagram reels fetched');
  }),
);

router.post(
  '/reels',
  authenticateAdmin,
  loadAdmin,
  validateBody(createInstagramReelSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const reel = await instagramService.createReel(req.body);
    invalidateInstagramCaches();
    sendSuccess(res, reel, 'Instagram video added', 201);
  }),
);

router.put(
  '/reels/reorder',
  authenticateAdmin,
  loadAdmin,
  validateBody(reorderInstagramReelsSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const reels = await instagramService.reorderReels(req.body.orderedIds);
    invalidateInstagramCaches();
    sendSuccess(res, reels, 'Instagram videos reordered');
  }),
);

router.put(
  '/reels/:id',
  authenticateAdmin,
  loadAdmin,
  validateParams(idParamSchema),
  validateBody(updateInstagramReelSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const reel = await instagramService.updateReel(paramString(req.params.id), req.body);
    invalidateInstagramCaches();
    sendSuccess(res, reel, 'Instagram video updated');
  }),
);

router.delete(
  '/reels/:id',
  authenticateAdmin,
  loadAdmin,
  validateParams(idParamSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    await instagramService.softDeleteReel(paramString(req.params.id));
    invalidateInstagramCaches();
    sendSuccess(res, null, 'Instagram video deleted');
  }),
);

router.get(
  '/all',
  authenticateAdmin,
  loadAdmin,
  asyncHandler(async (_req: AuthenticatedRequest, res: Response) => {
    const feeds = await instagramService.findAll();
    sendSuccess(res, feeds, 'All feeds fetched');
  }),
);

router.post(
  '/',
  authenticateAdmin,
  loadAdmin,
  uploadSingle,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.file) throw new ApiError(400, 'Image required');
    const feed = await instagramService.create(
      {
        caption: req.body.caption,
        linkUrl: req.body.linkUrl,
        sortOrder: req.body.sortOrder ? parseInt(req.body.sortOrder, 10) : undefined,
      },
      req.file,
    );
    sendSuccess(res, feed, 'Feed created', 201);
  }),
);

router.put(
  '/:id',
  authenticateAdmin,
  loadAdmin,
  validateParams(idParamSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const feed = await instagramService.update(paramString(req.params.id), req.body);
    sendSuccess(res, feed, 'Feed updated');
  }),
);

router.delete(
  '/:id',
  authenticateAdmin,
  loadAdmin,
  validateParams(idParamSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    await instagramService.softDelete(paramString(req.params.id));
    sendSuccess(res, null, 'Feed deleted');
  }),
);

export default router;
