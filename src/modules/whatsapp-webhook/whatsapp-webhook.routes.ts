import { createHmac, timingSafeEqual } from 'crypto';
import { Router, type Request, type Response } from 'express';
import { env } from '@/config/env';
import { asyncHandler } from '@/middleware/validate';
import { whatsAppWebhookService } from './whatsapp-webhook.service';

type RawBodyRequest = Request & { rawBody?: Buffer };

const router = Router();

router.get('/', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (!env.WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN) {
    res.status(503).send('WhatsApp webhook verification is not configured');
    return;
  }
  if (
    mode === 'subscribe' &&
    token === env.WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN &&
    typeof challenge === 'string'
  ) {
    res.status(200).send(challenge);
    return;
  }
  res.status(403).send('Webhook verification failed');
});

router.post(
  '/',
  asyncHandler(async (req: RawBodyRequest, res: Response) => {
    const signature = req.header('x-hub-signature-256');
    const secret = env.WHATSAPP_CLOUD_APP_SECRET;
    if (!signature || !secret || !req.rawBody) {
      res.status(401).send('Invalid webhook signature');
      return;
    }

    const expected = `sha256=${createHmac('sha256', secret).update(req.rawBody).digest('hex')}`;
    const suppliedBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (
      suppliedBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(suppliedBuffer, expectedBuffer)
    ) {
      res.status(401).send('Invalid webhook signature');
      return;
    }

    await whatsAppWebhookService.process(req.body);
    res.sendStatus(200);
  }),
);

export default router;
