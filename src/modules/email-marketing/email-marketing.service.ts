import { EmailCampaignStatus, EmailDeliveryStatus } from '@prisma/client';
import { prisma } from '@/config/database';
import { env } from '@/config/env';
import { emailService } from '@/integrations/email.service';
import { toPublicImageUrl } from '@/integrations/local-storage.service';
import { ApiError } from '@/shared/api-response';
import { logger } from '@/utils/logger';
import { EMAIL_MARKETING_TEMPLATES } from './email-marketing-templates';

type Audience = {
  customerIds?: string[];
  sendToAll?: boolean;
};

type CampaignContent = {
  templateKey: string;
  subject: string;
  heading: string;
  body: string;
  imageUrl?: string;
};

const SEND_DELAY_MS = 250;
const activeCampaigns = new Set<string>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function personalize(value: string, customerName: string): string {
  const firstName = customerName.trim().split(/\s+/)[0] || 'Customer';
  return value.replace(/\{\{\s*name\s*\}\}/gi, firstName);
}

function validEmail(value?: string | null): value is string {
  return Boolean(value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()));
}

function emailSafeImageUrl(value: string): string {
  // Email clients need an absolute URL; locally stored images are relative paths.
  return toPublicImageUrl(value.trim()) ?? value.trim();
}

function renderEmail(content: Omit<CampaignContent, 'templateKey'>, customerName: string) {
  const subject = personalize(content.subject, customerName).trim();
  const heading = personalize(content.heading, customerName).trim();
  const body = personalize(content.body, customerName).trim();
  const image = content.imageUrl?.trim()
    ? `<tr><td><img src="${escapeHtml(emailSafeImageUrl(content.imageUrl))}" alt="${escapeHtml(heading)}" width="600" style="display:block;width:100%;max-width:600px;height:auto;max-height:420px;object-fit:cover;border:0;" /></td></tr>`
    : '';
  const htmlBody = escapeHtml(body).replace(/\r?\n/g, '<br/>');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f6f1ea;font-family:Georgia,'Times New Roman',serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f1ea;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border:1px solid #ebe3d6;border-radius:16px;overflow:hidden;">
        <tr><td style="background:#1c1612;padding:28px;text-align:center;">
          <p style="margin:0;color:#c9a96e;letter-spacing:.28em;font-size:12px;text-transform:uppercase;">Singari Sarees</p>
          <p style="margin:10px 0 0;color:#f7efe3;font-size:13px;">Where Every Weave Tells a Story</p>
        </td></tr>
        ${image}
        <tr><td style="padding:32px 30px 12px;">
          <h1 style="margin:0;color:#1c1612;font-size:28px;line-height:1.3;font-weight:normal;">${escapeHtml(heading)}</h1>
          <p style="margin:18px 0 0;color:#5c4c3f;font-size:15px;line-height:1.7;">${htmlBody}</p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 12px;">
            <tr><td style="background:#7f1d1d;border-radius:999px;">
              <a href="${escapeHtml(env.FRONTEND_URL)}/collections" style="display:inline-block;padding:13px 24px;color:#fff;text-decoration:none;font-size:13px;letter-spacing:.06em;">SHOP COLLECTIONS</a>
            </td></tr>
          </table>
          <p style="margin:24px 0 0;color:#8a7a6b;font-size:13px;line-height:1.6;">With warmth,<br/>The Singari Sarees team</p>
        </td></tr>
        <tr><td style="padding:18px 30px 24px;border-top:1px solid #efe8dc;">
          <p style="margin:0;color:#a09386;font-size:11px;line-height:1.5;">You are receiving this promotional email because marketing updates are enabled for your Singari Sarees customer profile.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return {
    subject,
    html,
    text: `${heading}\n\n${body}\n\nShop: ${env.FRONTEND_URL}/collections\n\nWith warmth,\nThe Singari Sarees team`,
  };
}

class EmailMarketingService {
  getTemplates() {
    return EMAIL_MARKETING_TEMPLATES;
  }

  preview(data: {
    subject: string;
    heading: string;
    body: string;
    imageUrl?: string;
    sampleName?: string;
  }) {
    return renderEmail(
      {
        subject: data.subject,
        heading: data.heading,
        body: data.body,
        imageUrl: data.imageUrl,
      },
      data.sampleName || 'Priya',
    );
  }

  private async recipientsFor(audience: Audience) {
    if (!audience.sendToAll && !audience.customerIds?.length) {
      throw new ApiError(400, 'Select at least one customer or choose send to all');
    }

    const customers = await prisma.customer.findMany({
      where: {
        deletedAt: null,
        allowMarketing: true,
        email: { not: null },
        ...(!audience.sendToAll ? { id: { in: audience.customerIds } } : {}),
      },
      select: { id: true, name: true, email: true },
    });

    const seen = new Set<string>();
    return customers
      .filter((customer) => validEmail(customer.email))
      .map((customer) => ({ ...customer, email: customer.email!.trim().toLowerCase() }))
      .filter((customer) => {
        if (seen.has(customer.email)) return false;
        seen.add(customer.email);
        return true;
      });
  }

  async eligibility(audience: Audience) {
    const recipients = await this.recipientsFor(audience);
    const consideredCount = audience.sendToAll
      ? await prisma.customer.count({ where: { deletedAt: null, allowMarketing: true } })
      : new Set(audience.customerIds || []).size;
    return {
      eligibleCount: recipients.length,
      skippedCount: Math.max(0, consideredCount - recipients.length),
    };
  }

  async createCampaign(content: CampaignContent, audience: Audience, adminId?: string) {
    if (!emailService.isConfigured()) {
      throw new ApiError(503, 'SMTP is not configured. Add SMTP settings before sending email campaigns.');
    }

    const recipients = await this.recipientsFor(audience);
    if (recipients.length === 0) {
      throw new ApiError(400, 'No marketing-enabled customers with a valid email were found');
    }

    const campaign = await prisma.emailMarketingCampaign.create({
      data: {
        subject: content.subject.trim(),
        heading: content.heading.trim(),
        body: content.body.trim(),
        imageUrl: content.imageUrl?.trim() || null,
        recipientCount: recipients.length,
        createdByAdminId: adminId,
        recipients: {
          create: recipients.map((recipient) => ({
            customerId: recipient.id,
            customerName: recipient.name,
            email: recipient.email,
          })),
        },
      },
    });

    this.queueCampaign(campaign.id);
    return campaign;
  }

  private queueCampaign(campaignId: string) {
    setImmediate(() => {
      void this.processCampaign(campaignId);
    });
  }

  async processCampaign(campaignId: string) {
    if (activeCampaigns.has(campaignId)) return;
    activeCampaigns.add(campaignId);

    try {
      const campaign = await prisma.emailMarketingCampaign.update({
        where: { id: campaignId },
        data: { status: EmailCampaignStatus.PROCESSING, startedAt: new Date() },
        include: {
          recipients: {
            where: { status: EmailDeliveryStatus.QUEUED },
            orderBy: { createdAt: 'asc' },
          },
        },
      });

      let sentCount = campaign.sentCount;
      let failedCount = campaign.failedCount;

      for (const recipient of campaign.recipients) {
        const rendered = renderEmail(
          {
            subject: campaign.subject,
            heading: campaign.heading,
            body: campaign.body,
            imageUrl: campaign.imageUrl || undefined,
          },
          recipient.customerName,
        );
        const sent = await emailService.send({
          to: recipient.email,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
        });

        if (sent) sentCount += 1;
        else failedCount += 1;

        await prisma.emailMarketingRecipient.update({
          where: { id: recipient.id },
          data: {
            status: sent ? EmailDeliveryStatus.SENT : EmailDeliveryStatus.FAILED,
            attempts: { increment: 1 },
            sentAt: sent ? new Date() : null,
            errorMessage: sent ? null : 'SMTP delivery failed',
          },
        });
        await prisma.emailMarketingCampaign.update({
          where: { id: campaignId },
          data: { sentCount, failedCount },
        });
        await sleep(SEND_DELAY_MS);
      }

      await prisma.emailMarketingCampaign.update({
        where: { id: campaignId },
        data: {
          status: EmailCampaignStatus.COMPLETED,
          sentCount,
          failedCount,
          completedAt: new Date(),
        },
      });
    } catch (error) {
      logger.error('Email marketing campaign processing failed', {
        campaignId,
        error: error instanceof Error ? error.message : error,
      });
      await prisma.emailMarketingCampaign
        .update({
          where: { id: campaignId },
          data: { status: EmailCampaignStatus.FAILED, completedAt: new Date() },
        })
        .catch(() => undefined);
    } finally {
      activeCampaigns.delete(campaignId);
    }
  }

  async resumePendingCampaigns() {
    if (!emailService.isConfigured()) return;
    const campaigns = await prisma.emailMarketingCampaign.findMany({
      where: { status: { in: [EmailCampaignStatus.QUEUED, EmailCampaignStatus.PROCESSING] } },
      select: { id: true },
      take: 20,
      orderBy: { createdAt: 'asc' },
    });
    campaigns.forEach((campaign) => this.queueCampaign(campaign.id));
  }

  async history(limit = 30) {
    return prisma.emailMarketingCampaign.findMany({
      take: Math.min(Math.max(limit, 1), 100),
      orderBy: { createdAt: 'desc' },
      include: {
        createdByAdmin: { select: { name: true } },
      },
    });
  }
}

export const emailMarketingService = new EmailMarketingService();
