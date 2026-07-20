import { Router, Response, Request } from 'express';
import { instagramService } from './instagram.service';
import { validateParams, asyncHandler } from '@/middleware/validate';
import { authenticateAdmin, loadAdmin, AuthenticatedRequest } from '@/middleware/auth';
import { sendSuccess } from '@/shared/api-response';
import { idParamSchema } from '@/modules/auth/auth.schema';
import { uploadSingle } from '@/middleware/upload';
import { ApiError } from '@/shared/api-response';
import { paramString } from '@/utils/params';

const router = Router();

router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const feeds = await instagramService.findActive();
  sendSuccess(res, feeds, 'Instagram feeds fetched');
}));

router.get('/all', authenticateAdmin, loadAdmin, asyncHandler(async (_req: AuthenticatedRequest, res: Response) => {
  const feeds = await instagramService.findAll();
  sendSuccess(res, feeds, 'All feeds fetched');
}));

router.post('/', authenticateAdmin, loadAdmin, uploadSingle, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.file) throw new ApiError(400, 'Image required');
  const feed = await instagramService.create({
    caption: req.body.caption,
    linkUrl: req.body.linkUrl,
    sortOrder: req.body.sortOrder ? parseInt(req.body.sortOrder) : undefined,
  }, req.file);
  sendSuccess(res, feed, 'Feed created', 201);
}));

router.put('/:id', authenticateAdmin, loadAdmin, validateParams(idParamSchema), asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const feed = await instagramService.update(paramString(req.params.id), req.body);
  sendSuccess(res, feed, 'Feed updated');
}));

router.delete('/:id', authenticateAdmin, loadAdmin, validateParams(idParamSchema), asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  await instagramService.softDelete(paramString(req.params.id));
  sendSuccess(res, null, 'Feed deleted');
}));

export default router;
