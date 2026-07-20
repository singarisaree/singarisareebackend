import { Router, Response, Request } from 'express';
import { returnRequestService } from './return-request.service';
import {
  createReturnRequestSchema,
  returnRequestQuerySchema,
  updateReturnRequestStatusSchema,
  adminCreateReturnRequestSchema,
} from './return-request.schema';
import { validateBody, validateParams, validateQuery, asyncHandler } from '@/middleware/validate';
import { authenticateAdmin, loadAdmin, AuthenticatedRequest } from '@/middleware/auth';
import { sendSuccess } from '@/shared/api-response';
import { idParamSchema } from '@/modules/auth/auth.schema';
import { paramString } from '@/utils/params';
import { uploadReturnImages } from '@/middleware/upload';

const router = Router();

router.post(
  '/',
  uploadReturnImages,
  asyncHandler(async (req: Request, res: Response) => {
    let items = req.body.items;
    if (typeof items === 'string') {
      try {
        items = JSON.parse(items);
      } catch {
        items = undefined;
      }
    }
    const parsed = createReturnRequestSchema.parse({
      orderId: req.body.orderId,
      phone: req.body.phone,
      reason: req.body.reason,
      items,
    });
    const files = req.files as Express.Multer.File[] | undefined;
    const request = await returnRequestService.create(parsed, files);
    sendSuccess(res, request, 'Return request submitted', 201);
  }),
);

router.post(
  '/admin',
  authenticateAdmin,
  loadAdmin,
  validateBody(adminCreateReturnRequestSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const request = await returnRequestService.adminCreate(req.body);
    sendSuccess(res, request, 'Return arranged by admin', 201);
  }),
);

router.get(
  '/',
  authenticateAdmin,
  loadAdmin,
  validateQuery(returnRequestQuerySchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await returnRequestService.findAll(req.query as Record<string, string>);
    sendSuccess(res, result.requests, 'Return requests fetched', 200, result.meta);
  }),
);

router.get(
  '/:id',
  authenticateAdmin,
  loadAdmin,
  validateParams(idParamSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const request = await returnRequestService.findById(paramString(req.params.id));
    sendSuccess(res, request, 'Return request fetched');
  }),
);

router.patch(
  '/:id/status',
  authenticateAdmin,
  loadAdmin,
  validateParams(idParamSchema),
  validateBody(updateReturnRequestStatusSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const request = await returnRequestService.updateStatus(
      paramString(req.params.id),
      req.body,
    );
    sendSuccess(res, request, 'Return request updated');
  }),
);

export default router;
