import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { orderService } from '@/modules/orders/order.service';
import { razorpayService } from '@/integrations/razorpay.service';
import { asyncHandler } from '@/middleware/validate';
import { sendSuccess } from '@/shared/api-response';
import { prisma } from '@/config/database';
import { logger } from '@/utils/logger';
import { env } from '@/config/env';

const SUCCESSFUL_ORDER_STATUSES = new Set([
  'PLACED',
  'CONFIRMED',
  'READY_TO_SHIP',
  'SHIPPED',
  'IN_TRANSIT',
  'DELIVERED',
]);

type RequestWithRawBody = Request & { rawBody?: Buffer };

const verifyPaymentSchema = z.object({
  orderNumber: z.string().min(1),
  razorpayOrderId: z.string().min(1),
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().min(1),
});

const reportPaymentFailedSchema = z.object({
  orderNumber: z.string().min(1),
  reason: z.string().max(500).optional(),
});

const router = Router();

router.post(
  '/webhook',
  asyncHandler(async (req: Request, res: Response) => {
    const signature = String(req.headers['x-razorpay-signature'] || '').trim();
    const rawBody = (req as RequestWithRawBody).rawBody?.toString('utf8') ?? '';

    if (!env.RAZORPAY_WEBHOOK_SECRET?.trim()) {
      logger.warn('Razorpay webhook rejected: RAZORPAY_WEBHOOK_SECRET is not configured');
      res.status(503).json({ success: false, message: 'Webhook secret not configured' });
      return;
    }

    if (!signature || !rawBody) {
      res.status(401).json({ success: false, message: 'Missing webhook signature' });
      return;
    }

    const isValid = razorpayService.verifyWebhookSignature(rawBody, signature);
    if (!isValid) {
      res.status(401).json({ success: false, message: 'Invalid webhook signature' });
      return;
    }

    const event = String(req.body?.event || '');
    const payload = (req.body?.payload || {}) as Record<string, unknown>;
    const paymentEntity = (payload.payment as { entity?: Record<string, unknown> } | undefined)
      ?.entity;
    const orderEntity = (payload.order as { entity?: Record<string, unknown> } | undefined)?.entity;

    const razorpayOrderId = String(
      paymentEntity?.order_id || orderEntity?.id || '',
    ).trim();
    const razorpayPaymentId = String(paymentEntity?.id || '').trim();

    logger.info('Razorpay webhook received', {
      event,
      razorpayOrderId,
      razorpayPaymentId,
    });

    if (!razorpayOrderId) {
      res.status(200).json({ success: true });
      return;
    }

    const payment = await prisma.payment.findFirst({
      where: { razorpayOrderId },
      include: { order: { select: { orderNumber: true } } },
    });

    const orderNumber =
      payment?.order.orderNumber ||
      String(
        (orderEntity?.notes as Record<string, unknown> | undefined)?.orderNumber ||
          orderEntity?.receipt ||
          '',
      ).trim();

    if (!orderNumber) {
      res.status(200).json({ success: true });
      return;
    }

    if (event === 'payment.captured' || event === 'order.paid') {
      await orderService.handlePaymentSuccess(orderNumber, {
        ...(paymentEntity || orderEntity || {}),
        razorpay_payment_id: razorpayPaymentId || paymentEntity?.id,
        razorpay_order_id: razorpayOrderId,
      });
    } else if (event === 'payment.failed') {
      const reason =
        String(paymentEntity?.error_description || paymentEntity?.error_reason || '').trim() ||
        undefined;
      await orderService.handlePaymentFailure(orderNumber, reason);
    } else {
      logger.info('Razorpay webhook ignored (unhandled event)', { event });
    }

    res.status(200).json({ success: true });
  }),
);

/** Client reports Razorpay payment.failed (transaction was attempted). */
router.post(
  '/failed',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = reportPaymentFailedSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, message: 'Invalid payment failure payload' });
      return;
    }

    await orderService.handlePaymentFailure(parsed.data.orderNumber, parsed.data.reason);
    sendSuccess(res, { orderNumber: parsed.data.orderNumber, paymentStatus: 'FAILED' }, 'Payment marked failed');
  }),
);

router.post(
  '/verify',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = verifyPaymentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, message: 'Invalid payment verification payload' });
      return;
    }

    const { orderNumber, razorpayOrderId, razorpayPaymentId, razorpaySignature } = parsed.data;

    // 1) HMAC signature from Razorpay Checkout (order_id|payment_id)
    const isValid = razorpayService.verifyPaymentSignature({
      orderId: razorpayOrderId,
      paymentId: razorpayPaymentId,
      signature: razorpaySignature,
    });

    if (!isValid) {
      logger.warn('Razorpay payment signature rejected', {
        orderNumber,
        razorpayOrderId,
        razorpayPaymentId,
      });
      res.status(400).json({ success: false, message: 'Invalid payment signature' });
      return;
    }

    const localPayment = await prisma.payment.findFirst({
      where: { razorpayOrderId },
      include: { order: { select: { orderNumber: true, grandTotal: true } } },
    });

    if (!localPayment || localPayment.order.orderNumber !== orderNumber) {
      res.status(400).json({ success: false, message: 'Payment does not match this order' });
      return;
    }

    const expectedPaise = razorpayService.toPaise(
      Number(localPayment.order.grandTotal ?? localPayment.amount),
    );

    // Signature is the secure Checkout proof — confirm the order immediately.
    // Remote amount/status is audited in the background (must not delay the shopper).
    const alreadyPaid =
      localPayment.status === 'SUCCESS' ||
      (await prisma.order.findFirst({
        where: { orderNumber, deletedAt: null },
        select: { payments: { where: { status: 'SUCCESS' }, select: { id: true }, take: 1 } },
      }))?.payments.length === 1;

    if (alreadyPaid) {
      await orderService.handlePaymentSuccess(orderNumber, {
        razorpay_order_id: razorpayOrderId,
        razorpay_payment_id: razorpayPaymentId,
        razorpay_signature: razorpaySignature,
        verified: true,
      });
      sendSuccess(
        res,
        { orderNumber, paymentStatus: 'SUCCESS', alreadyPaid: true },
        'Payment already confirmed',
      );
      return;
    }

    await orderService.handlePaymentSuccess(orderNumber, {
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: razorpayPaymentId,
      razorpay_signature: razorpaySignature,
      verified: true,
    });

    sendSuccess(res, { orderNumber, paymentStatus: 'SUCCESS' }, 'Payment verified');

    void razorpayService
      .getPayment(razorpayPaymentId)
      .then((remotePayment) => {
        if (!remotePayment) return;
        const remoteOrderId = String(remotePayment.order_id || '').trim();
        const remoteStatus = String(remotePayment.status || '').toLowerCase();
        const paidPaise = Number(remotePayment.amount);
        if (remoteOrderId !== razorpayOrderId) {
          logger.error('Post-verify Razorpay order mismatch', { orderNumber, remoteOrderId });
          return;
        }
        if (remoteStatus !== 'captured' && remoteStatus !== 'authorized') {
          logger.error('Post-verify Razorpay status unexpected', { orderNumber, remoteStatus });
          return;
        }
        if (Number.isFinite(paidPaise) && paidPaise !== expectedPaise) {
          logger.error('Post-verify Razorpay amount mismatch', {
            orderNumber,
            expectedPaise,
            paidPaise,
          });
        }
      })
      .catch((error) => {
        logger.warn('Post-verify Razorpay audit skipped', {
          orderNumber,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }),
);

router.get(
  '/status/:orderNumber',
  asyncHandler(async (req: Request, res: Response) => {
    const orderNumber = req.params.orderNumber as string;
    const fromPaymentReturn = req.query.context === 'return';

    const existing = await prisma.order.findFirst({
      where: { orderNumber },
      include: { payments: true },
    });

    if (!existing) {
      res.status(404).json({ success: false, message: 'Order not found' });
      return;
    }

    const alreadyConfirmed =
      existing.payments.some((payment) => payment.status === 'SUCCESS') ||
      SUCCESSFUL_ORDER_STATUSES.has(existing.status);

    if (!alreadyConfirmed) {
      try {
        await orderService.syncPaymentStatus(orderNumber, { fromPaymentReturn });
      } catch (error) {
        logger.warn('Payment status sync skipped', { orderNumber, error });
      }
    }

    const order = await prisma.order.findFirst({
      where: { orderNumber },
      select: {
        orderNumber: true,
        status: true,
        grandTotal: true,
        createdAt: true,
        estimatedDelivery: true,
        shippingAddress: true,
        payments: { select: { status: true } },
      },
    });

    if (!order) {
      res.status(404).json({ success: false, message: 'Order not found' });
      return;
    }

    const paymentSucceeded = order.payments.some((payment) => payment.status === 'SUCCESS');
    const customerStatus =
      paymentSucceeded && ['FAILED', 'PAYMENT_PENDING'].includes(order.status)
        ? 'PLACED'
        : order.status;
    const paymentStatus = paymentSucceeded
      ? 'SUCCESS'
      : order.payments[0]?.status;

    const address = (order.shippingAddress ?? {}) as {
      preferredShipping?: string;
      country?: string;
      countryCode?: string;
      postalCode?: string;
      city?: string;
      landmark?: string;
      state?: string;
      selectedCourier?: string;
      selectedCourierEta?: string;
    };
    const preferred = String(address.preferredShipping || '').toUpperCase();
    const code = String(address.countryCode || '').trim().toUpperCase();
    const country = String(address.country || '').trim().toLowerCase();
    const pin = String(address.postalCode || '').trim();
    const isIndia =
      code === 'IN' ||
      country === 'india' ||
      country === 'in' ||
      (!code && !country && /^\d{6}$/.test(pin.replace(/\D/g, '')));

    let deliveryType: 'QUICK' | 'INDIA' | 'INTERNATIONAL' = 'INDIA';
    if (!isIndia) {
      deliveryType = 'INTERNATIONAL';
    } else if (preferred === 'QUICK') {
      deliveryType = 'QUICK';
    }

    const pinDigits = pin.replace(/\D/g, '');
    const haystack = [address.city, address.landmark, address.state]
      .map((part) => String(part || '').trim().toLowerCase())
      .join(' ');
    const hyderabadMarkers = [
      'hyderabad',
      'secunderabad',
      'cyberabad',
      'kukatpally',
      'gachibowli',
      'madhapur',
      'hitech city',
      'hitec city',
    ];
    const isHyderabadDelivery =
      deliveryType === 'INDIA' &&
      (/^500\d{3}$/.test(pinDigits) || hyderabadMarkers.some((m) => haystack.includes(m)));

    let estimatedDelivery = order.estimatedDelivery;
    if (isHyderabadDelivery) {
      estimatedDelivery = new Date(order.createdAt);
      estimatedDelivery.setDate(estimatedDelivery.getDate() + 2);
    }

    sendSuccess(res, {
      orderNumber: order.orderNumber,
      status: customerStatus,
      paymentStatus,
      grandTotal: order.grandTotal,
      estimatedDelivery,
      deliveryType,
      isHyderabadDelivery,
      shippingAddress: {
        country: address.country,
        countryCode: address.countryCode,
        preferredShipping: address.preferredShipping,
        selectedCourier: address.selectedCourier,
        selectedCourierEta: address.selectedCourierEta,
        city: address.city,
        postalCode: address.postalCode,
        landmark: address.landmark,
        state: address.state,
      },
    }, 'Payment status');
  }),
);

export default router;
