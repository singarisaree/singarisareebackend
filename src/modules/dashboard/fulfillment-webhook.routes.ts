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
 * Optional security token → sent as header x-api-key = SHIPROCKET_WEBHOOK_TOKEN
 * URL must not contain keywords: shiprocket, kartrocket, sr, kr
 *
 * Shiprocket validates the URL with a POST and REQUIRES HTTP 200.
 * Do not return 401/503 during their save/test or they show:
 * "Please check your endpoint, unable to send request to mentioned api."
 */
router.post(
  '/tracking',
  asyncHandler(async (req: Request, res: Response) => {
    const configuredToken = env.SHIPROCKET_WEBHOOK_TOKEN?.trim();
    if (configuredToken) {
      const provided = String(req.headers['x-api-key'] || '').trim();
      if (provided !== configuredToken) {
        // Still 200 — Shiprocket fails the URL check on any non-200
        logger.warn('Fulfillment webhook: invalid or missing x-api-key');
        res.status(200).json({ success: false, message: 'Invalid webhook token' });
        return;
      }
    } else if (env.NODE_ENV === 'production') {
      logger.warn(
        'SHIPROCKET_WEBHOOK_TOKEN is not set — webhook accepts all requests (set token in .env)',
      );
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

    // Shiprocket requires HTTP 200 for URL validation and delivery
    res.status(200).json({ success: true });
  }),
);

export default router;
