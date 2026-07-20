import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '@/config/env';
import { logger } from '@/utils/logger';

export type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
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

    try {
      await transporter.sendMail({
        from: `"${fromName}" <${fromEmail}>`,
        to,
        subject: input.subject,
        html: input.html,
        ...(input.text ? { text: input.text } : {}),
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      });
      logger.info('SMTP email sent', { to, subject: input.subject });
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
