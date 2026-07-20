import { WhatsAppOutboxStatus } from '@prisma/client';
import { prisma } from '@/config/database';
import { whatsAppService } from '@/integrations/whatsapp.service';
import { logger } from '@/utils/logger';

const MAX_ATTEMPTS = 8;
const POLL_INTERVAL_MS = 30_000;
const STALE_LOCK_MS = 5 * 60_000;

type WelcomePayload = { customerName: string };

export class WhatsAppOutboxService {
  private running = false;
  private timer?: NodeJS.Timeout;

  resumePendingEvents(): void {
    void this.processPending();
    if (!this.timer) {
      this.timer = setInterval(() => void this.processPending(), POLL_INTERVAL_MS);
      this.timer.unref();
    }
  }

  scheduleProcessing(): void {
    setImmediate(() => void this.processPending());
  }

  async processPending(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (await this.processNext()) {
        // Drain ready events without blocking the login request that enqueued them.
      }
    } catch (error) {
      logger.error('WhatsApp outbox processing failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }

  private async processNext(): Promise<boolean> {
    const now = new Date();
    const candidate = await prisma.whatsAppOutboxEvent.findFirst({
      where: {
        attempts: { lt: MAX_ATTEMPTS },
        nextAttemptAt: { lte: now },
        OR: [
          { status: { in: [WhatsAppOutboxStatus.PENDING, WhatsAppOutboxStatus.FAILED] } },
          {
            status: WhatsAppOutboxStatus.PROCESSING,
            lockedAt: { lt: new Date(now.getTime() - STALE_LOCK_MS) },
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!candidate) return false;

    const claimed = await prisma.whatsAppOutboxEvent.updateMany({
      where: {
        id: candidate.id,
        attempts: candidate.attempts,
        status: candidate.status,
      },
      data: {
        status: WhatsAppOutboxStatus.PROCESSING,
        lockedAt: now,
        attempts: { increment: 1 },
      },
    });
    if (claimed.count === 0) return true;

    const payload = candidate.payload as WelcomePayload;
    const result =
      candidate.templateKind === 'customer_welcome'
        ? await whatsAppService.sendCustomerWelcome({
            phone: candidate.phone,
            customerName: payload.customerName || 'Customer',
          })
        : { sent: false, error: `Unsupported outbox template: ${candidate.templateKind}` };

    if (result.sent) {
      await prisma.whatsAppOutboxEvent.update({
        where: { id: candidate.id },
        data: {
          status: WhatsAppOutboxStatus.SENT,
          sentAt: new Date(),
          lockedAt: null,
          providerMessageId: result.messageId,
          lastError: null,
        },
      });
      return true;
    }

    const attempt = candidate.attempts + 1;
    const delayMinutes = Math.min(60, 2 ** Math.min(attempt, 6));
    await prisma.whatsAppOutboxEvent.update({
      where: { id: candidate.id },
      data: {
        status: WhatsAppOutboxStatus.FAILED,
        lockedAt: null,
        lastError: result.error || 'WhatsApp provider rejected the message',
        nextAttemptAt: new Date(Date.now() + delayMinutes * 60_000),
      },
    });
    return true;
  }
}

export const whatsAppOutboxService = new WhatsAppOutboxService();
