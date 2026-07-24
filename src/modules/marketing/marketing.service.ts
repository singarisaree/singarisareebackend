import { MarketingMessageStatus } from '@prisma/client';
import { prisma } from '@/config/database';
import { ApiError } from '@/shared/api-response';
import { whatsAppService } from '@/integrations/whatsapp.service';
import { localStorageService, toPublicImageUrl } from '@/integrations/local-storage.service';
import { invalidateCache } from '@/utils/memory-cache';
import { MARKETING_TEMPLATES, renderMarketingMessage } from './marketing-templates';

const SEND_DELAY_MS = 600;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MarketingService {
  getTemplates() {
    return MARKETING_TEMPLATES;
  }

  preview(data: { heading: string; story: string; sampleName?: string }) {
    return {
      message: renderMarketingMessage(data.heading, data.story, data.sampleName || 'Priya'),
    };
  }

  async uploadImage(file: Express.Multer.File) {
    const upload = await localStorageService.uploadImage(file.buffer, 'marketing');
    const publicUrl = toPublicImageUrl(upload.url);
    return { imageUrl: upload.url, publicUrl, publicId: upload.publicId };
  }

  async sendCampaign(
    data: {
      templateKey: string;
      heading: string;
      story: string;
      campaignLink: string;
      imageUrl?: string;
      customerIds?: string[];
      sendToAll?: boolean;
    },
    adminId?: string,
  ) {
    const imageUrl = data.imageUrl?.trim() || undefined;
    const templateConfig = await whatsAppService.getMarketingTemplateConfig(Boolean(imageUrl));
    if (!whatsAppService.isConfigured() || !templateConfig.name) {
      throw new ApiError(
        503,
        imageUrl
          ? 'WhatsApp Cloud API image marketing template is not configured'
          : 'WhatsApp Cloud API marketing template is not configured',
      );
    }

    // WhatsApp rejects WebP header images and often fails on non-public image links.
    // Convert + upload once per campaign, then send with Meta media id.
    let imageId: string | undefined;
    if (imageUrl) {
      const storedPath = imageUrl.replace(/^https?:\/\/[^/]+/i, '');
      const relativePath = storedPath.startsWith('/uploads/')
        ? storedPath
        : imageUrl.startsWith('/uploads/')
          ? imageUrl
          : null;
      if (!relativePath) {
        throw new ApiError(
          400,
          'Marketing image must be an uploaded site image. Re-upload the image and try again.',
        );
      }
      imageId = await whatsAppService.uploadMarketingImageMedia(relativePath);
    }

    let recipients;

    if (data.sendToAll) {
      recipients = await prisma.customer.findMany({
        where: { deletedAt: null, allowMarketing: true },
      });
    } else if (data.customerIds?.length) {
      recipients = await prisma.customer.findMany({
        where: {
          id: { in: data.customerIds },
          deletedAt: null,
          allowMarketing: true,
        },
      });
    } else {
      throw new ApiError(400, 'Select at least one customer or choose send to all');
    }

    if (recipients.length === 0) {
      throw new ApiError(400, 'No eligible recipients found');
    }

    const campaign = await prisma.marketingCampaign.create({
      data: {
        templateKey: data.templateKey,
        heading: data.heading,
        story: data.story,
        campaignLink: data.campaignLink,
        imageUrl: data.imageUrl || null,
        recipientCount: recipients.length,
        createdByAdminId: adminId,
      },
    });

    let sentCount = 0;
    let failedCount = 0;

    for (const customer of recipients) {
      const result = await whatsAppService.sendMarketingMessage({
        to: customer.phone,
        customerName: customer.name,
        heading: data.heading,
        story: data.story,
        campaignLink: data.campaignLink,
        imageId,
        templateConfig,
      });

      if (result.sent) {
        sentCount += 1;
        await prisma.$transaction([
          prisma.marketingMessageLog.create({
            data: {
              campaignId: campaign.id,
              customerId: customer.id,
              phone: customer.phone,
              customerName: customer.name,
              status: MarketingMessageStatus.SENT,
              providerMessageId: result.messageId,
              acceptedAt: new Date(),
            },
          }),
          prisma.marketingCampaign.update({
            where: { id: campaign.id },
            data: { sentCount: { increment: 1 } },
          }),
        ]);
      } else {
        failedCount += 1;
        await prisma.$transaction([
          prisma.marketingMessageLog.create({
            data: {
              campaignId: campaign.id,
              customerId: customer.id,
              phone: customer.phone,
              customerName: customer.name,
              status: MarketingMessageStatus.FAILED,
              errorMessage: result.error || 'WhatsApp Cloud API rejected the message',
              failedAt: new Date(),
            },
          }),
          prisma.marketingCampaign.update({
            where: { id: campaign.id },
            data: { failedCount: { increment: 1 } },
          }),
        ]);
      }

      await sleep(SEND_DELAY_MS);
    }

    const updated = await prisma.marketingCampaign.findUniqueOrThrow({
      where: { id: campaign.id },
    });

    invalidateCache('customers:list:');

    return {
      campaign: updated,
      sentCount,
      failedCount,
      recipientCount: recipients.length,
    };
  }

  async getCampaignHistory(limit = 20) {
    const campaigns = await prisma.marketingCampaign.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        createdByAdmin: { select: { name: true } },
        logs: {
          select: {
            status: true,
            deliveredAt: true,
            failedAt: true,
            errorMessage: true,
          },
        },
      },
    });

    return campaigns.map((campaign) => {
      const deliveredCount = campaign.logs.filter((log) => log.deliveredAt != null).length;
      const failedAfterAccept = campaign.logs.filter((log) => log.failedAt != null).length;
      const recentErrors = [
        ...new Set(
          campaign.logs
            .map((log) => log.errorMessage?.trim())
            .filter((message): message is string => Boolean(message)),
        ),
      ].slice(0, 3);

      const { logs: _logs, ...rest } = campaign;
      return {
        ...rest,
        /** Meta accepted the send API (not the same as delivered to the phone). */
        acceptedCount: campaign.sentCount,
        deliveredCount,
        failedAfterAccept,
        recentErrors,
      };
    });
  }
}

export const marketingService = new MarketingService();
