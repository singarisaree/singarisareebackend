import { Router, Response } from 'express';
import { authenticateAdmin, loadAdmin, AuthenticatedRequest } from '@/middleware/auth';
import { asyncHandler, validateBody } from '@/middleware/validate';
import { sendSuccess } from '@/shared/api-response';
import {
  emailMarketingEligibilitySchema,
  emailMarketingPreviewSchema,
  sendEmailMarketingSchema,
} from './email-marketing.schema';
import { emailMarketingService } from './email-marketing.service';

const router = Router();

router.use(authenticateAdmin, loadAdmin);

router.get(
  '/templates',
  asyncHandler(async (_req: AuthenticatedRequest, res: Response) => {
    sendSuccess(res, emailMarketingService.getTemplates(), 'Email marketing templates fetched');
  }),
);

router.post(
  '/preview',
  validateBody(emailMarketingPreviewSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    sendSuccess(res, emailMarketingService.preview(req.body), 'Email preview generated');
  }),
);

router.post(
  '/eligibility',
  validateBody(emailMarketingEligibilitySchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await emailMarketingService.eligibility(req.body);
    sendSuccess(res, result, 'Email audience checked');
  }),
);

router.post(
  '/send',
  validateBody(sendEmailMarketingSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const campaign = await emailMarketingService.createCampaign(
      {
        templateKey: req.body.templateKey,
        subject: req.body.subject,
        heading: req.body.heading,
        body: req.body.body,
        imageUrl: req.body.imageUrl,
      },
      {
        customerIds: req.body.customerIds,
        sendToAll: req.body.sendToAll,
      },
      req.admin?.id,
    );
    sendSuccess(
      res,
      {
        campaignId: campaign.id,
        status: campaign.status,
        recipientCount: campaign.recipientCount,
      },
      'Email campaign queued',
      202,
    );
  }),
);

router.get(
  '/campaigns',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const limit = Number(req.query.limit) || 30;
    const campaigns = await emailMarketingService.history(limit);
    sendSuccess(res, campaigns, 'Email campaign history fetched');
  }),
);

export default router;
