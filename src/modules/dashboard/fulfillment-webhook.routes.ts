import { Router, Request, Response } from 'express';
import { shippingService } from './dashboard.service';
import { asyncHandler } from '@/middleware/validate';
import { env } from '@/config/env';
import { logger } from '@/utils/logger';

const router = Router();

/**
 * Shiprocket tracking webhook.
 * Configure in Shiprocket → Settings → API → Webhooks:
 *   POST {API_URL}/api/v1/fulfillment/tracking
 * Optional header: x-api-key = SHIPROCKET_WEBHOOK_TOKEN
 * URL must not contain the word "shiprocket".
 */
router.post(
  '/tracking',
  asyncHandler(async (req: Request, res: Response) => {
    const configuredToken = env.SHIPROCKET_WEBHOOK_TOKEN?.trim();
    if (configuredToken) {
      const provided = String(req.headers['x-api-key'] || '').trim();
      if (provided !== configuredToken) {
        res.status(401).json({ success: false, message: 'Invalid webhook token' });
        return;
      }
    } else if (env.NODE_ENV === 'production') {
      logger.error('SHIPROCKET_WEBHOOK_TOKEN is required in production');
      res.status(503).json({ success: false, message: 'Webhook not configured' });
      return;
    }

    const payload = (req.body || {}) as Record<string, unknown>;
    logger.info('Fulfillment tracking webhook received', {
      awb: payload.awb,
      current_status: payload.current_status,
      shipment_status: payload.shipment_status,
      shipment_status_id: payload.shipment_status_id,
    });

    try {
      await shippingService.handleShiprocketTrackingWebhook(payload);
    } catch (error) {
      logger.error('Fulfillment tracking webhook handler failed', { error });
    }

    // Shiprocket requires HTTP 200
    res.status(200).json({ success: true });
  }),
);

export default router;
