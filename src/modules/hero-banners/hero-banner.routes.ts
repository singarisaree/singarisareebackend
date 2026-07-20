import { Router, Response } from 'express';
import { heroBannerService } from './hero-banner.service';
import { validateParams, asyncHandler } from '@/middleware/validate';
import { authenticateAdmin, loadAdmin, AuthenticatedRequest } from '@/middleware/auth';
import { sendSuccess } from '@/shared/api-response';
import { idParamSchema } from '@/modules/auth/auth.schema';
import { upload } from '@/middleware/upload';
import { ApiError } from '@/shared/api-response';
import { Request } from 'express';
import { paramString } from '@/utils/params';
import { publicCache } from '@/middleware/cache';
import { invalidateCache } from '@/utils/memory-cache';

function invalidateHeroBannerCaches(): void {
  invalidateCache('storefront:homepage');
}

const router = Router();

router.get(
  '/',
  publicCache(120),
  asyncHandler(async (_req: Request, res: Response) => {
    const banners = await heroBannerService.findActive();
    sendSuccess(res, banners, 'Hero banners fetched');
  }),
);

router.get(
  '/all',
  authenticateAdmin,
  loadAdmin,
  asyncHandler(async (_req: AuthenticatedRequest, res: Response) => {
    const banners = await heroBannerService.findAll();
    sendSuccess(res, banners, 'All banners fetched');
  }),
);

router.post(
  '/',
  authenticateAdmin,
  loadAdmin,
  upload.fields([{ name: 'image', maxCount: 1 }, { name: 'mobileImage', maxCount: 1 }]),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const files = req.files as { image?: Express.Multer.File[]; mobileImage?: Express.Multer.File[] };
    if (!files?.image?.[0]) throw new ApiError(400, 'Banner image required');

    const banner = await heroBannerService.create(
      {
        title: req.body.title,
        subtitle: req.body.subtitle,
        linkUrl: req.body.linkUrl,
        sortOrder: req.body.sortOrder ? parseInt(req.body.sortOrder) : undefined,
        isActive: req.body.isActive !== 'false',
        startsAt: req.body.startsAt,
        endsAt: req.body.endsAt,
      },
      files.image[0],
      files.mobileImage?.[0],
    );
    invalidateHeroBannerCaches();
    sendSuccess(res, banner, 'Banner created', 201);
  }),
);

router.put(
  '/:id',
  authenticateAdmin,
  loadAdmin,
  validateParams(idParamSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const banner = await heroBannerService.update(paramString(req.params.id), req.body);
    invalidateHeroBannerCaches();
    sendSuccess(res, banner, 'Banner updated');
  }),
);

router.post(
  '/reorder',
  authenticateAdmin,
  loadAdmin,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { orderedIds } = req.body as { orderedIds: string[] };
    await heroBannerService.reorder(orderedIds);
    invalidateHeroBannerCaches();
    sendSuccess(res, null, 'Banners reordered');
  }),
);

router.delete(
  '/:id',
  authenticateAdmin,
  loadAdmin,
  validateParams(idParamSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    await heroBannerService.softDelete(paramString(req.params.id));
    invalidateHeroBannerCaches();
    sendSuccess(res, null, 'Banner deleted');
  }),
);

export default router;
