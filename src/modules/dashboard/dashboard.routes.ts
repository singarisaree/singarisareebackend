import { Router, Response } from 'express';
import { dashboardService, shippingService } from './dashboard.service';
import { authenticateAdmin, loadAdmin, AuthenticatedRequest } from '@/middleware/auth';
import { asyncHandler, validateBody, validateParams, validateQuery } from '@/middleware/validate';
import { sendSuccess } from '@/shared/api-response';
import { paginationSchema } from '@/modules/auth/auth.schema';
import { manualShippingSchema } from '@/modules/orders/order.schema';
import { paramString } from '@/utils/params';
import { z } from 'zod';

const router = Router();

const orderIdParamSchema = z.object({
  orderId: z.string().uuid('Invalid order ID'),
});

router.get(
  '/stats',
  authenticateAdmin,
  loadAdmin,
  asyncHandler(async (_req: AuthenticatedRequest, res: Response) => {
    const stats = await dashboardService.getStats();
    sendSuccess(res, stats, 'Dashboard stats fetched');
  }),
);

router.get(
  '/dispatches',
  authenticateAdmin,
  loadAdmin,
  validateQuery(
    paginationSchema.extend({
      courier: z.string().optional(),
    }),
  ),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await shippingService.listDispatches(req.query as Record<string, string>);
    sendSuccess(
      res,
      { dispatches: result.dispatches, courierPartners: result.courierPartners },
      'Dispatches fetched',
      200,
      result.meta,
    );
  }),
);

router.get(
  '/inventory',
  authenticateAdmin,
  loadAdmin,
  validateQuery(
    paginationSchema.extend({
      stock: z.enum(['all', 'low', 'out']).optional(),
    }),
  ),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await shippingService.getInventory(req.query as Record<string, string>);
    sendSuccess(res, result.inventory, 'Inventory fetched', 200, result.meta);
  }),
);

router.post(
  '/shipping/:orderId/manual',
  authenticateAdmin,
  loadAdmin,
  validateParams(orderIdParamSchema),
  validateBody(manualShippingSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const shipping = await shippingService.createManualShipping(paramString(req.params.orderId), req.body);
    sendSuccess(res, shipping, 'Manual shipping created');
  }),
);

router.post(
  '/shipping/bulk-shiprocket-quote',
  authenticateAdmin,
  loadAdmin,
  validateBody(
    z.object({
      orderIds: z.array(z.string().uuid()).min(1).max(50),
    }),
  ),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await shippingService.quoteBulkShiprocketOrders(req.body.orderIds);
    sendSuccess(res, result, 'Bulk Shiprocket quote fetched');
  }),
);

router.post(
  '/shipping/bulk-shiprocket',
  authenticateAdmin,
  loadAdmin,
  validateBody(
    z.object({
      orderIds: z.array(z.string().uuid()).min(1).max(50),
      pickupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pickup date must be YYYY-MM-DD'),
      selections: z
        .array(
          z.object({
            orderId: z.string().uuid(),
            courierId: z.number().int().positive(),
            courierName: z.string().trim().min(1).optional(),
          }),
        )
        .optional(),
    }),
  ),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await shippingService.bulkCreateShiprocketOrders(
      req.body.orderIds,
      req.body.pickupDate,
      req.body.selections,
    );
    sendSuccess(res, result, 'Bulk Shiprocket shipments completed');
  }),
);

router.get(
  '/shipping/:orderId/couriers',
  authenticateAdmin,
  loadAdmin,
  validateParams(orderIdParamSchema),
  validateQuery(
    z.object({
      mode: z.enum(['domestic', 'international', 'quick']).optional(),
    }),
  ),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await shippingService.listAvailableCouriers(
      paramString(req.params.orderId),
      (req.query.mode as 'domestic' | 'international' | 'quick' | undefined) ?? 'domestic',
    );
    sendSuccess(res, result, 'Available couriers fetched');
  }),
);

router.post(
  '/shipping/:orderId/shiprocket',
  authenticateAdmin,
  loadAdmin,
  validateParams(orderIdParamSchema),
  validateBody(
    z.object({
      mode: z.enum(['domestic', 'international', 'quick']).default('domestic'),
      courierId: z.number().int().positive().optional(),
      pickupDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Pickup date must be YYYY-MM-DD')
        .optional(),
      courierName: z.string().trim().min(1).optional(),
    }),
  ),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await shippingService.createShiprocketOrder(paramString(req.params.orderId), req.body);
    sendSuccess(res, result, 'Shiprocket order created');
  }),
);

router.post(
  '/shipping/:orderId/awb',
  authenticateAdmin,
  loadAdmin,
  validateParams(orderIdParamSchema),
  validateBody(z.object({ courierId: z.number().int().positive() })),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await shippingService.generateAWB(paramString(req.params.orderId), req.body.courierId);
    sendSuccess(res, result, 'AWB generated');
  }),
);

router.get(
  '/shipping/:orderId/label',
  authenticateAdmin,
  loadAdmin,
  validateParams(orderIdParamSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await shippingService.getShiprocketLabel(paramString(req.params.orderId));
    sendSuccess(res, result, 'Shiprocket label fetched');
  }),
);

router.get(
  '/shipping/:orderId/invoice',
  authenticateAdmin,
  loadAdmin,
  validateParams(orderIdParamSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await shippingService.getShiprocketInvoice(paramString(req.params.orderId));
    sendSuccess(res, result, 'Shiprocket invoice fetched');
  }),
);

router.get(
  '/shipping/:orderId/manifest',
  authenticateAdmin,
  loadAdmin,
  validateParams(orderIdParamSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await shippingService.getShiprocketManifest(paramString(req.params.orderId));
    sendSuccess(res, result, 'Shiprocket manifest fetched');
  }),
);

router.get(
  '/shipping/:orderId/quick-track',
  authenticateAdmin,
  loadAdmin,
  validateParams(orderIdParamSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await shippingService.trackQuickDelivery(paramString(req.params.orderId));
    sendSuccess(res, result, 'Quick delivery tracking fetched');
  }),
);

router.post(
  '/shipping/:orderId/cancel',
  authenticateAdmin,
  loadAdmin,
  validateParams(orderIdParamSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await shippingService.cancelShiprocketShipment(paramString(req.params.orderId));
    sendSuccess(res, result, 'Shiprocket shipment cancelled');
  }),
);

export default router;
