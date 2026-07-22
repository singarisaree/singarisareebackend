import SentDm from '@sentdm/sentdm';
import { env } from '@/config/env';
import { logger } from '@/utils/logger';

function toE164India(phone: string): string {
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.length >= 10) {
    const national = cleaned.slice(-10);
    if (/^[6-9]\d{9}$/.test(national)) {
      return `+91${national}`;
    }
  }
  if (cleaned.startsWith('+')) return cleaned;
  return `+${cleaned}`;
}

/** Sent.dm v3: template must have id OR name, not both. */
function buildOtpTemplate(templateId: string, parameters: Record<string, string>) {
  if (templateId) {
    return { id: templateId, parameters };
  }
  const name = env.SENT_DM_OTP_TEMPLATE_NAME?.trim() || 'login_otp';
  return { name, parameters };
}

/**
 * Sent.dm — customer login OTP via SMS only.
 * Order / shipping / marketing WhatsApp uses Meta Cloud API separately.
 */
class SentService {
  private client: SentDm | null = null;

  isConfigured(): boolean {
    return Boolean(
      env.SENT_DM_API_KEY?.trim() &&
        (env.SENT_DM_OTP_TEMPLATE_ID?.trim() || env.SENT_DM_OTP_TEMPLATE_NAME?.trim()),
    );
  }

  private getClient(): SentDm | null {
    if (!env.SENT_DM_API_KEY?.trim()) return null;
    if (!this.client) {
      this.client = new SentDm({ apiKey: env.SENT_DM_API_KEY.trim() });
    }
    return this.client;
  }

  async sendOtp(phone: string, otp: string): Promise<boolean> {
    const client = this.getClient();
    const templateId = env.SENT_DM_OTP_TEMPLATE_ID?.trim() || '';

    if (!client) {
      logger.warn('Sent.dm OTP skipped — SENT_DM_API_KEY not set');
      return false;
    }
    if (!templateId && !env.SENT_DM_OTP_TEMPLATE_NAME?.trim()) {
      logger.warn('Sent.dm OTP skipped — set SENT_DM_OTP_TEMPLATE_ID');
      return false;
    }

    const to = toE164India(phone);

    try {
      const response = await client.messages.send({
        to: [to],
        template: buildOtpTemplate(templateId, {
          // sent_Verify_Code_* templates use {{var_1}} in Sent.dm
          var_1: otp,
          code: otp,
          otp,
        }),
        // SMS only — do not also send on WhatsApp (that delivered the same OTP twice).
        channel: ['sms'],
      });

      logger.info('Sent.dm OTP accepted', {
        to,
        status: response.data?.status,
        messageId: response.data?.recipients?.[0]?.message_id,
      });
      return true;
    } catch (error) {
      const detail =
        error && typeof error === 'object' && 'status' in error
          ? JSON.stringify({
              status: (error as { status?: number }).status,
              message: error instanceof Error ? error.message : String(error),
            })
          : error instanceof Error
            ? error.message
            : String(error);
      logger.error('Sent.dm OTP failed', { to, error: detail });
      return false;
    }
  }
}

export const sentService = new SentService();
