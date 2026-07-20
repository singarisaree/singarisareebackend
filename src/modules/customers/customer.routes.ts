import { Router, Response } from 'express';
import { customerService } from './customer.service';
import { createCustomerSchema, updateCustomerSchema, customerQuerySchema } from './customer.schema';
import { validateBody, validateQuery, validateParams, asyncHandler } from '@/middleware/validate';
import { authenticateAdmin, loadAdmin, AuthenticatedRequest } from '@/middleware/auth';
import { sendSuccess } from '@/shared/api-response';
import { idParamSchema } from '@/modules/auth/auth.schema';
import { paramString } from '@/utils/params';

const router = Router();

router.use(authenticateAdmin, loadAdmin);

router.get(
  '/',
  validateQuery(customerQuerySchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await customerService.findAll(req.query as Record<string, string>);
    sendSuccess(res, result.customers, 'Customers fetched', 200, result.meta);
  }),
);

router.post(
  '/sync-orders',
  asyncHandler(async (_req: AuthenticatedRequest, res: Response) => {
    const result = await customerService.syncFromOrders();
    sendSuccess(res, result, 'Customers synced from orders');
  }),
);

router.get(
  '/:id',
  validateParams(idParamSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const customer = await customerService.findById(paramString(req.params.id));
    sendSuccess(res, customer, 'Customer fetched');
  }),
);

router.post(
  '/',
  validateBody(createCustomerSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const customer = await customerService.create(req.body);
    sendSuccess(res, customer, 'Customer created', 201);
  }),
);

router.patch(
  '/:id',
  validateParams(idParamSchema),
  validateBody(updateCustomerSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const customer = await customerService.update(paramString(req.params.id), req.body);
    sendSuccess(res, customer, 'Customer updated');
  }),
);

router.delete(
  '/:id',
  validateParams(idParamSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    await customerService.softDelete(paramString(req.params.id));
    sendSuccess(res, null, 'Customer deleted');
  }),
);

export default router;
