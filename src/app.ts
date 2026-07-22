import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { env, isDevelopment } from '@/config/env';
import { logger } from '@/utils/logger';
import { hasValidAdminSession } from '@/middleware/auth';
import { errorHandler, notFoundHandler } from '@/middleware/validate';
import { UPLOADS_DIR } from '@/integrations/local-storage.service';

import authRoutes from '@/modules/auth/auth.routes';
import customerAuthRoutes from '@/modules/customer-auth/customer-auth.routes';
import productRoutes from '@/modules/products/product.routes';
import categoryRoutes from '@/modules/categories/category.routes';
import orderRoutes from '@/modules/orders/order.routes';
import paymentRoutes from '@/modules/payments/payment.routes';
import couponRoutes from '@/modules/coupons/coupon.routes';
import heroBannerRoutes from '@/modules/hero-banners/hero-banner.routes';
import reviewRoutes from '@/modules/reviews/review.routes';
import instagramRoutes from '@/modules/instagram/instagram.routes';
import settingsRoutes from '@/modules/settings/settings.routes';
import dashboardRoutes from '@/modules/dashboard/dashboard.routes';
import fulfillmentWebhookRoutes from '@/modules/dashboard/fulfillment-webhook.routes';
import customerRoutes from '@/modules/customers/customer.routes';
import marketingRoutes from '@/modules/marketing/marketing.routes';
import emailMarketingRoutes from '@/modules/email-marketing/email-marketing.routes';
import whatsappWebhookRoutes from '@/modules/whatsapp-webhook/whatsapp-webhook.routes';
import storefrontRoutes from '@/modules/storefront/storefront.routes';
import returnRequestRoutes from '@/modules/return-requests/return-request.routes';
import refundRoutes from '@/modules/refunds/refund.routes';

export function createApp(): Application {
  const app = express();

  app.set('trust proxy', 1);

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  const isAllowedDevOrigin = (origin: string) =>
    /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(:\d+)?$/.test(
      origin,
    );

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) {
          callback(null, true);
          return;
        }
        if (origin === env.FRONTEND_URL) {
          callback(null, true);
          return;
        }
        if (isDevelopment && isAllowedDevOrigin(origin)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    }),
  );

  app.use(compression());

  // Serve locally stored images. Long-lived cache since filenames are content-unique (UUIDs).
  app.use(
    '/uploads',
    express.static(UPLOADS_DIR, {
      immutable: true,
      maxAge: '365d',
      fallthrough: false,
    }),
  );

  const apiPrefix = `/api/${env.API_VERSION}`;

  /** Storefront SSR + prefetch can burst many GETs from one Next server IP — don't throttle reads. */
  const isStorefrontRead = (req: express.Request) =>
    req.method === 'GET' &&
    new RegExp(
      `^${apiPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(products|categories|hero-banners|settings/public|storefront|reviews)(/|$)`,
    ).test(req.path);

  const isCheckoutMutation = (req: express.Request) =>
    (req.method === 'POST' &&
      new RegExp(
        `^${apiPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/orders/(cart-sync|calculate|checkout|validate-coupon|shipping-quote)(/|$)`,
      ).test(req.path)) ||
    (req.method === 'GET' &&
      new RegExp(
        `^${apiPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/orders/shipping-countries(/|$)`,
      ).test(req.path));

  const isWhatsAppWebhook = (req: express.Request) =>
    req.path === `${apiPrefix}/whatsapp/webhook` || req.path === `${apiPrefix}/whatsapp/webhook/`;

  app.use(
    rateLimit({
      windowMs: parseInt(env.RATE_LIMIT_WINDOW_MS, 10),
      max: parseInt(env.RATE_LIMIT_MAX_REQUESTS, 10),
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) =>
        hasValidAdminSession(req) ||
        isStorefrontRead(req) ||
        isCheckoutMutation(req) ||
        isWhatsAppWebhook(req),
      message: { success: false, message: 'Too many requests, please try again later' },
    }),
  );

  app.use(
    express.json({
      limit: '10mb',
      verify: (req, _res, buf) => {
        // Preserve raw bytes for Razorpay and Meta webhook HMAC verification
        (req as Express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(cookieParser());

  app.use((req, _res, next) => {
    if (!isDevelopment && req.method === 'GET') {
      next();
      return;
    }
    logger.info(`${req.method} ${req.path}`, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    next();
  });

  app.get(`${apiPrefix}/health`, (_req, res) => {
    res.json({
      success: true,
      message: 'Singari Sarees API is healthy',
      timestamp: new Date().toISOString(),
    });
  });

  app.use(`${apiPrefix}/auth`, authRoutes);
  app.use(`${apiPrefix}/customer-auth`, customerAuthRoutes);
  app.use(`${apiPrefix}/products`, productRoutes);
  app.use(`${apiPrefix}/categories`, categoryRoutes);
  app.use(`${apiPrefix}/orders`, orderRoutes);
  app.use(`${apiPrefix}/payments`, paymentRoutes);
  app.use(`${apiPrefix}/coupons`, couponRoutes);
  app.use(`${apiPrefix}/hero-banners`, heroBannerRoutes);
  app.use(`${apiPrefix}/reviews`, reviewRoutes);
  app.use(`${apiPrefix}/instagram`, instagramRoutes);
  app.use(`${apiPrefix}/settings`, settingsRoutes);
  app.use(`${apiPrefix}/dashboard`, dashboardRoutes);
  app.use(`${apiPrefix}/fulfillment`, fulfillmentWebhookRoutes);
  app.use(`${apiPrefix}/customers`, customerRoutes);
  app.use(`${apiPrefix}/marketing`, marketingRoutes);
  app.use(`${apiPrefix}/email-marketing`, emailMarketingRoutes);
  app.use(`${apiPrefix}/whatsapp/webhook`, whatsappWebhookRoutes);
  app.use(`${apiPrefix}/storefront`, storefrontRoutes);
  app.use(`${apiPrefix}/return-requests`, returnRequestRoutes);
  app.use(`${apiPrefix}/refunds`, refundRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
