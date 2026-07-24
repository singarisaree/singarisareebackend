import nodemailer, { type Transporter } from 'nodemailer';
import { randomBytes } from 'crypto';
import { env } from '@/config/env';
import { logger } from '@/utils/logger';

export type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  /** Extra SMTP headers (e.g. List-Unsubscribe for marketing). */
  headers?: Record<string, string>;
  /** When true, adds marketing List-Unsubscribe headers. */
  isMarketing?: boolean;
};

class EmailService {
  private transporter: Transporter | null = null;

  isConfigured(): boolean {
    return Boolean(env.SMTP_HOST?.trim() && env.SMTP_USER?.trim() && env.SMTP_PASS?.trim());
  }

  private getTransporter(): Transporter | null {
    if (!this.isConfigured()) return null;

    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: parseInt(env.SMTP_PORT, 10),
        secure: env.SMTP_SECURE === 'true',
        auth: {
          user: env.SMTP_USER,
          pass: env.SMTP_PASS,
        },
      });
    }

    return this.transporter;
  }

  async send(input: SendEmailInput): Promise<boolean> {
    const to = input.to?.trim();
    if (!to || !to.includes('@')) {
      logger.warn('SMTP email skipped — invalid recipient', { to: input.to });
      return false;
    }

    const transporter = this.getTransporter();
    if (!transporter) {
      logger.warn('SMTP not configured — skipping email', { to, subject: input.subject });
      return false;
    }

    const fromEmail = env.SMTP_FROM_EMAIL?.trim() || env.SMTP_USER?.trim() || '';
    const fromName = (env.SMTP_FROM_NAME || 'Singari Sarees').trim();
    if (!fromEmail) {
      logger.warn('SMTP email skipped — from email missing', { to, subject: input.subject });
      return false;
    }

    const domain = fromEmail.includes('@') ? fromEmail.split('@')[1]! : 'localhost';
    const messageId = `<${Date.now()}.${randomBytes(8).toString('hex')}@${domain}>`;
    const unsubscribeMailto = `mailto:${fromEmail}?subject=${encodeURIComponent('Unsubscribe')}`;

    const headers: Record<string, string> = {
      'Message-ID': messageId,
      'X-Auto-Response-Suppress': 'OOF, AutoReply',
      ...(input.headers ?? {}),
    };

    if (input.isMarketing) {
      headers['List-Unsubscribe'] = `<${unsubscribeMailto}>`;
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
      headers['Precedence'] = 'bulk';
    }

    // Prefer plain-text companion so clients don't treat HTML-only as spammy.
    const text =
      input.text?.trim() ||
      input.html
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    try {
      await transporter.sendMail({
        from: `"${fromName}" <${fromEmail}>`,
        to,
        subject: input.subject,
        html: input.html,
        text,
        replyTo: input.replyTo || fromEmail,
        headers,
        // Helps some providers associate envelope sender with From.
        envelope: {
          from: fromEmail,
          to,
        },
      });
      logger.info('SMTP email sent', { to, subject: input.subject, messageId });
      return true;
    } catch (error) {
      logger.error('SMTP email failed', {
        to,
        subject: input.subject,
        error: error instanceof Error ? error.message : error,
      });
      return false;
    }
  }
}

export const emailService = new EmailService();
