import { Router, Response } from 'express';
import { orderService } from './order.service';
import {
  checkoutSchema,
  calculateTotalsSchema,
  adminCreateOrderSchema,
  orderQuerySchema,
  updateOrderStatusSchema,
  updateOrderDetailsSchema,
  bulkUpdateOrderStatusSchema,
  bulkFetchOrdersSchema,
  validateCouponSchema,
  availableCouponsQuerySchema,
  cartSyncSchema,
  shippingQuoteSchema,
  quickQuoteSchema,
  escalationSearchSchema,
  escalationUpdateSchema,
} from './order.schema';
import { validateBody, validateQuery, validateParams, asyncHandler } from '@/middleware/validate';
import { authenticateAdmin, loadAdmin, authenticateCustomer, AuthenticatedRequest, CustomerAuthenticatedRequest } from '@/middleware/auth';
import { sendSuccess } from '@/shared/api-response';
import { idParamSchema } from '@/modules/auth/auth.schema';
import { paramString } from '@/utils/params';
import { Request } from 'express';

const router = Router();

router.post(
  '/validate-coupon',
  validateBody(validateCouponSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { code, subtotal, phone, shippingCharge } = req.body;
    const result = await orderService.validateCoupon(
      code,
      subtotal,
      phone,
      Number(shippingCharge) || 0,
    );
    sendSuccess(
      res,
      {
        discount: result.discount,
        isRefundCoupon: Boolean(result.coupon.isRefundCoupon),
        coupon: {
          id: result.coupon.id,
          code: result.coupon.code,
          type: result.coupon.type,
          value: Number(result.coupon.value),
          isRefundCoupon: Boolean(result.coupon.isRefundCoupon),
        },
      },
      'Coupon validated',
    );
  }),
);

router.get(
  '/available-coupons',
  validateQuery(availableCouponsQuerySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const subtotal = Number(req.query.subtotal || 0);
    const shippingCharge = Number(req.query.shippingCharge || 0);
    const phone = typeof req.query.phone === 'string' ? req.query.phone : undefined;
    const coupons = await orderService.listAvailableCoupons(subtotal, phone, shippingCharge);
    sendSuccess(res, coupons, 'Available coupons fetched');
  }),
);

router.post(
  '/cart-sync',
  validateBody(cartSyncSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await orderService.syncCartItems(req.body.items);
    sendSuccess(res, result, 'Cart synced');
  }),
);

router.post(
  '/calculate',
  validateBody(calculateTotalsSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const totals = await orderService.calculateOrderTotals(
      req.body.items,
      req.body.couponCode,
      req.body.shippingAddress,
      req.body.phone,
    );
    sendSuccess(res, totals, 'Order totals calculated');
  }),
);

router.post(
  '/shipping-quote',
  validateBody(shippingQuoteSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const quote = await orderService.quoteShipping(req.body.items, req.body.shippingAddress);
    if (quote.success) {
      sendSuccess(res, quote, 'Shipping quote fetched');
      return;
    }
    sendSuccess(res, quote, quote.message);
  }),
);

router.post(
  '/quick-quote',
  validateBody(quickQuoteSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const quote = await orderService.quoteQuickDelivery(req.body.items, req.body.delivery);
    sendSuccess(res, quote, quote.available ? 'Quick delivery quote fetched' : quote.message);
  }),
);

router.get(
  '/shipping-countries',
  asyncHandler(async (_req: Request, res: Response) => {
    const countries = await orderService.listShippingCountries();
    sendSuccess(res, countries, 'Shipping countries fetched');
  }),
);

router.post(
  '/checkout',
  validateBody(checkoutSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await orderService.createGuestOrder(req.body);
    sendSuccess(res, result, 'Order created', 201);
  }),
);

router.get(
  '/mine',
  authenticateCustomer,
  asyncHandler(async (req: CustomerAuthenticatedRequest, res: Response) => {
    const phone = req.customer!.phone;
    const orders = await orderService.findByPhone(phone);
    sendSuccess(res, orders, 'Orders fetched');
  }),
);

router.post(
  '/:orderNumber/retry-payment',
  asyncHandler(async (req: Request, res: Response) => {
    const result = await orderService.retryPayment(paramString(req.params.orderNumber));
    sendSuccess(res, result, 'Payment order created');
  }),
);

// Admin routes
router.get(
  '/',
  authenticateAdmin,
  loadAdmin,
  validateQuery(orderQuerySchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await orderService.findAll(req.query as Record<string, string>);
    sendSuccess(res, result.orders, 'Orders fetched', 200, result.meta);
  }),
);

router.post(
  '/admin',
  authenticateAdmin,
  loadAdmin,
  validateBody(adminCreateOrderSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const order = await orderService.createAdminOrder(req.body, req.admin!.id);
    sendSuccess(res, order, 'Admin order created', 201);
  }),
);

router.post(
  '/bulk-status',
  authenticateAdmin,
  loadAdmin,
  validateBody(bulkUpdateOrderStatusSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await orderService.bulkUpdateStatus(
      req.body.orderIds,
      req.body.status,
      req.body.notes,
    );
    sendSuccess(res, result, 'Bulk status update completed');
  }),
);

router.post(
  '/bulk-fetch',
  authenticateAdmin,
  loadAdmin,
  validateBody(bulkFetchOrdersSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const orders = await orderService.findByIdsForPrint(req.body.orderIds);
    sendSuccess(res, orders, 'Orders fetched');
  }),
);

router.get(
  '/escalation/search',
  authenticateAdmin,
  loadAdmin,
  validateQuery(escalationSearchSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const orders = await orderService.searchEscalation(q);
    sendSuccess(res, orders, 'Escalation search results');
  }),
);

router.patch(
  '/:id/escalation',
  authenticateAdmin,
  loadAdmin,
  validateParams(idParamSchema),
  validateBody(escalationUpdateSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const order = await orderService.applyEscalation(paramString(req.params.id), req.body);
    sendSuccess(res, order, 'Escalation applied');
  }),
);

router.get(
  '/:id',
  authenticateAdmin,
  loadAdmin,
  validateParams(idParamSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const order = await orderService.findById(paramString(req.params.id));
    sendSuccess(res, order, 'Order fetched');
  }),
);

router.patch(
  '/:id/status',
  authenticateAdmin,
  loadAdmin,
  validateParams(idParamSchema),
  validateBody(updateOrderStatusSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const order = await orderService.updateStatus(paramString(req.params.id), req.body.status, req.body.notes);
    sendSuccess(res, order, 'Order status updated');
  }),
);

router.patch(
  '/:id',
  authenticateAdmin,
  loadAdmin,
  validateParams(idParamSchema),
  validateBody(updateOrderDetailsSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const order = await orderService.updateOrderDetails(paramString(req.params.id), req.body);
    sendSuccess(res, order, 'Order updated');
  }),
);

export default router;
