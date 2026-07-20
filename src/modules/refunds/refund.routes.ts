import { Router, Response } from 'express';
import { refundService } from './refund.service';
import { processRefundSchema, refundQuerySchema } from './refund.schema';
import { validateBody, validateParams, validateQuery, asyncHandler } from '@/middleware/validate';
import { authenticateAdmin, loadAdmin, AuthenticatedRequest } from '@/middleware/auth';
import { sendSuccess } from '@/shared/api-response';
import { idParamSchema } from '@/modules/auth/auth.schema';
import { paramString } from '@/utils/params';

const router = Router();

router.get(
  '/',
  authenticateAdmin,
  loadAdmin,
  validateQuery(refundQuerySchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await refundService.findAll(req.query as Record<string, string>);
    sendSuccess(res, result.orders, 'Refunds fetched', 200, result.meta);
  }),
);

router.post(
  '/:id/process',
  authenticateAdmin,
  loadAdmin,
  validateParams(idParamSchema),
  validateBody(processRefundSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const order = await refundService.processRefund(paramString(req.params.id), req.body);
    sendSuccess(res, order, 'Store credit coupon issued');
  }),
);

export default router;
