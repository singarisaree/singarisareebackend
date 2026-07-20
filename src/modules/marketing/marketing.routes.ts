import { Router, Response } from 'express';
import { marketingService } from './marketing.service';
import { previewMarketingSchema, sendMarketingSchema } from './marketing.schema';
import { validateBody, asyncHandler } from '@/middleware/validate';
import { authenticateAdmin, loadAdmin, AuthenticatedRequest } from '@/middleware/auth';
import { sendSuccess } from '@/shared/api-response';
import { uploadSingle } from '@/middleware/upload';
import { ApiError } from '@/shared/api-response';

const router = Router();

router.use(authenticateAdmin, loadAdmin);

router.get(
  '/templates',
  asyncHandler(async (_req: AuthenticatedRequest, res: Response) => {
    const templates = marketingService.getTemplates();
    sendSuccess(res, templates, 'Marketing templates fetched');
  }),
);

router.post(
  '/preview',
  validateBody(previewMarketingSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const preview = marketingService.preview(req.body);
    sendSuccess(res, preview, 'Preview generated');
  }),
);

router.post(
  '/upload-image',
  uploadSingle,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.file) throw new ApiError(400, 'No image provided');
    const image = await marketingService.uploadImage(req.file);
    sendSuccess(res, image, 'Image uploaded');
  }),
);

router.post(
  '/send',
  validateBody(sendMarketingSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await marketingService.sendCampaign(req.body, req.admin?.id);
    sendSuccess(res, result, 'Marketing campaign sent');
  }),
);

router.get(
  '/campaigns',
  asyncHandler(async (_req: AuthenticatedRequest, res: Response) => {
    const campaigns = await marketingService.getCampaignHistory();
    sendSuccess(res, campaigns, 'Campaign history fetched');
  }),
);

export default router;
