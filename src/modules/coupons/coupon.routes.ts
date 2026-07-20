import { Router, Response } from 'express';
import { z } from 'zod';
import { couponService, createCouponSchema, updateCouponSchema } from './coupon.service';
import { validateBody, validateParams, validateQuery, asyncHandler } from '@/middleware/validate';
import { authenticateAdmin, loadAdmin, AuthenticatedRequest } from '@/middleware/auth';
import { sendSuccess } from '@/shared/api-response';
import { idParamSchema, paginationSchema } from '@/modules/auth/auth.schema';
import { paramString } from '@/utils/params';

const router = Router();

router.get(
  '/',
  authenticateAdmin,
  loadAdmin,
  validateQuery(
    paginationSchema.extend({
      isActive: z.enum(['true', 'false']).optional(),
    }),
  ),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await couponService.findAll(req.query as Record<string, string>);
    sendSuccess(res, result.coupons, 'Coupons fetched', 200, result.meta);
  }),
);

router.post(
  '/',
  authenticateAdmin,
  loadAdmin,
  validateBody(createCouponSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const coupon = await couponService.create(req.body);
    sendSuccess(res, coupon, 'Coupon created', 201);
  }),
);

router.get(
  '/:id',
  authenticateAdmin,
  loadAdmin,
  validateParams(idParamSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const coupon = await couponService.findById(paramString(req.params.id));
    sendSuccess(res, coupon, 'Coupon fetched');
  }),
);

router.put(
  '/:id',
  authenticateAdmin,
  loadAdmin,
  validateParams(idParamSchema),
  validateBody(updateCouponSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const coupon = await couponService.update(paramString(req.params.id), req.body);
    sendSuccess(res, coupon, 'Coupon updated');
  }),
);

router.delete(
  '/:id',
  authenticateAdmin,
  loadAdmin,
  validateParams(idParamSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    await couponService.softDelete(paramString(req.params.id));
    sendSuccess(res, null, 'Coupon deleted');
  }),
);

export default router;
