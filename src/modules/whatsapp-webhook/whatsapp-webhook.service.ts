import { MarketingMessageStatus } from '@prisma/client';
import { prisma } from '@/config/database';
import { logger } from '@/utils/logger';

type MetaStatus = {
  id?: string;
  status?: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp?: string;
  errors?: Array<{
    code?: number;
    title?: string;
    message?: string;
    error_data?: { details?: string };
  }>;
};

type MetaWebhookBody = {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      field?: string;
      value?: { statuses?: MetaStatus[] };
    }>;
  }>;
};

function eventTime(timestamp?: string): Date {
  const milliseconds = Number(timestamp) * 1000;
  return Number.isFinite(milliseconds) && milliseconds > 0 ? new Date(milliseconds) : new Date();
}

function failureMessage(errors?: MetaStatus['errors']): string {
  if (!errors?.length) return 'Meta reported WhatsApp delivery failure';
  return errors
    .map(
      (error) =>
        error.error_data?.details ||
        error.message ||
        error.title ||
        (error.code ? `Meta error ${error.code}` : 'Unknown Meta error'),
    )
    .join('; ')
    .slice(0, 1000);
}

export class WhatsAppWebhookService {
  async process(body: MetaWebhookBody): Promise<number> {
    if (body.object !== 'whatsapp_business_account') return 0;

    const statuses =
      body.entry?.flatMap(
        (entry) =>
          entry.changes?.flatMap((change) =>
            change.field === 'messages' ? change.value?.statuses || [] : [],
          ) || [],
      ) || [];

    let processed = 0;
    for (const event of statuses) {
      if (!event.id || !event.status) continue;
      const occurredAt = eventTime(event.timestamp);

      if (event.status === 'sent') {
        const result = await prisma.marketingMessageLog.updateMany({
          where: { providerMessageId: event.id, acceptedAt: null },
          data: { acceptedAt: occurredAt },
        });
        processed += result.count;
        continue;
      }

      if (event.status === 'delivered') {
        const result = await prisma.marketingMessageLog.updateMany({
          where: { providerMessageId: event.id, deliveredAt: null },
          data: { deliveredAt: occurredAt },
        });
        processed += result.count;
        continue;
      }

      if (event.status === 'read') {
        const result = await prisma.marketingMessageLog.updateMany({
          where: { providerMessageId: event.id, readAt: null },
          data: { readAt: occurredAt },
        });
        processed += result.count;
        continue;
      }

      if (event.status === 'failed') {
        const changed = await prisma.$transaction(async (tx) => {
          const log = await tx.marketingMessageLog.findUnique({
            where: { providerMessageId: event.id },
            select: { campaignId: true, failedAt: true },
          });
          if (!log || log.failedAt) return false;

          const update = await tx.marketingMessageLog.updateMany({
            where: { providerMessageId: event.id, failedAt: null },
            data: {
              status: MarketingMessageStatus.FAILED,
              failedAt: occurredAt,
              errorMessage: failureMessage(event.errors),
            },
          });
          if (!update.count) return false;

          await tx.marketingCampaign.update({
            where: { id: log.campaignId },
            data: {
              sentCount: { decrement: 1 },
              failedCount: { increment: 1 },
            },
          });
          return true;
        });
        if (changed) processed += 1;
      }
    }

    logger.info('WhatsApp webhook statuses processed', {
      received: statuses.length,
      updated: processed,
    });
    return processed;
  }
}

export const whatsAppWebhookService = new WhatsAppWebhookService();
