import { createHash, randomBytes, randomInt } from 'crypto';
import { Response } from 'express';
import { prisma } from '@/config/database';
import { env, isDevelopment } from '@/config/env';
import { sentService } from '@/integrations/sent.service';
import { ApiError } from '@/shared/api-response';
import { logger } from '@/utils/logger';
import { whatsAppOutboxService } from '@/modules/whatsapp-outbox/whatsapp-outbox.service';

const CUSTOMER_SESSION_COOKIE = 'customerSession';
/** ~10 years — sessions do not expire until logout */
const SESSION_COOKIE_MAX_AGE_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 45 * 1000;
const MAX_OTP_ATTEMPTS = 5;

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
};

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '').slice(-10);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function hashOtp(phone: string, otp: string): string {
  return createHash('sha256').update(`${phone}:${otp}:${env.JWT_ACCESS_SECRET}`).digest('hex');
}

function generateOtp(): string {
  return String(randomInt(100000, 999999));
}

function formatCustomer(customer: {
  id: string;
  name: string;
  phone: string;
  email: string | null;
}) {
  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
  };
}

export class CustomerAuthService {
  cookieName = CUSTOMER_SESSION_COOKIE;

  setSessionCookie(res: Response, rawToken: string): void {
    res.cookie(CUSTOMER_SESSION_COOKIE, rawToken, {
      ...COOKIE_OPTIONS,
      maxAge: SESSION_COOKIE_MAX_AGE_MS,
    });
  }

  clearSessionCookie(res: Response): void {
    res.clearCookie(CUSTOMER_SESSION_COOKIE, COOKIE_OPTIONS);
  }

  async sendOtp(phoneRaw: string): Promise<{
    phone: string;
    expiresInSeconds: number;
    /** Dev-only fallback when Sent.dm keys are not set */
    debugOtp?: string;
  }> {
    const phone = normalizePhone(phoneRaw);

    const recent = await prisma.customerOtpChallenge.findFirst({
      where: {
        phone,
        consumedAt: null,
        createdAt: { gte: new Date(Date.now() - OTP_RESEND_COOLDOWN_MS) },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (recent) {
      throw new ApiError(429, 'Please wait a moment before requesting another OTP');
    }

    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);

    await prisma.customerOtpChallenge.create({
      data: {
        phone,
        otpHash: hashOtp(phone, otp),
        expiresAt,
      },
    });

    const sent = await sentService.sendOtp(phone, otp);

    if (!sent) {
      if (isDevelopment || !sentService.isConfigured()) {
        logger.warn('Sent.dm OTP not delivered — exposing debug OTP in non-production', {
          phone,
        });
        console.info(`[customer-auth] OTP for ${phone}: ${otp}`);
        return {
          phone,
          expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
          debugOtp: otp,
        };
      }
      throw new ApiError(503, 'OTP service is not configured. Add SENT_DM_API_KEY and OTP template.');
    }

    return {
      phone,
      expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
    };
  }

  async verifyOtp(options: {
    phoneRaw: string;
    otp: string;
    name?: string;
    userAgent?: string;
    ipAddress?: string;
  }) {
    const phone = normalizePhone(options.phoneRaw);
    const rawToken = randomBytes(48).toString('base64url');
    const now = new Date();
    const transactionResult = await prisma.$transaction(async (tx) => {
      const challenge = await tx.customerOtpChallenge.findFirst({
        where: {
          phone,
          consumedAt: null,
          expiresAt: { gt: now },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!challenge) return { error: 'expired' as const };
      if (challenge.attempts >= MAX_OTP_ATTEMPTS) return { error: 'attempts' as const };

      if (challenge.otpHash !== hashOtp(phone, options.otp.trim())) {
        await tx.customerOtpChallenge.update({
          where: { id: challenge.id },
          data: { attempts: { increment: 1 } },
        });
        return { error: 'incorrect' as const };
      }

      const consumed = await tx.customerOtpChallenge.updateMany({
        where: { id: challenge.id, consumedAt: null },
        data: { consumedAt: now },
      });
      if (consumed.count === 0) return { error: 'expired' as const };

      const existing = await tx.customer.findUnique({ where: { phone } });
      const suppliedName = options.name?.trim();
      const customerName = suppliedName || existing?.name || 'Customer';
      const customer = await tx.customer.upsert({
        where: { phone },
        create: {
          phone,
          name: customerName,
          source: 'MANUAL',
        },
        update: {
          deletedAt: null,
          name:
            existing?.name === 'Customer' && suppliedName
              ? suppliedName
              : existing?.name || customerName,
        },
      });

      const firstLogin = (
        await tx.customer.updateMany({
          where: { id: customer.id, lastLoginAt: null },
          data: { lastLoginAt: now },
        })
      ).count === 1;
      if (!firstLogin) {
        await tx.customer.update({
          where: { id: customer.id },
          data: { lastLoginAt: now },
        });
      } else {
        await tx.whatsAppOutboxEvent.upsert({
          where: { dedupeKey: `customer-welcome:${customer.id}` },
          create: {
            dedupeKey: `customer-welcome:${customer.id}`,
            customerId: customer.id,
            phone,
            templateKind: 'customer_welcome',
            payload: { customerName: customer.name },
          },
          update: {},
        });
      }

      const session = await tx.customerSession.create({
        data: {
          customerId: customer.id,
          tokenHash: hashToken(rawToken),
          userAgent: options.userAgent?.slice(0, 500) || null,
          ipAddress: options.ipAddress?.slice(0, 64) || null,
          deviceLabel: null,
        },
      });
      return { customer: { ...customer, lastLoginAt: now }, session };
    });

    if ('error' in transactionResult) {
      if (transactionResult.error === 'attempts') {
        throw new ApiError(429, 'Too many incorrect attempts. Request a new OTP.');
      }
      if (transactionResult.error === 'incorrect') throw new ApiError(401, 'Incorrect OTP');
      throw new ApiError(400, 'OTP expired or not found. Request a new one.');
    }

    whatsAppOutboxService.scheduleProcessing();

    return {
      customer: formatCustomer(transactionResult.customer),
      sessionId: transactionResult.session.id,
      rawToken,
    };
  }

  async resolveSession(rawToken: string | undefined) {
    if (!rawToken?.trim()) return null;

    const session = await prisma.customerSession.findUnique({
      where: { tokenHash: hashToken(rawToken.trim()) },
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
            deletedAt: true,
          },
        },
      },
    });

    if (!session || session.revokedAt || session.customer.deletedAt) {
      return null;
    }

    // Touch lastSeen occasionally (best-effort, don't block auth)
    if (Date.now() - session.lastSeenAt.getTime() > 5 * 60 * 1000) {
      void prisma.customerSession
        .update({
          where: { id: session.id },
          data: { lastSeenAt: new Date() },
        })
        .catch(() => undefined);
    }

    return {
      sessionId: session.id,
      customer: formatCustomer(session.customer),
    };
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken?.trim()) return;
    await prisma.customerSession.updateMany({
      where: {
        tokenHash: hashToken(rawToken.trim()),
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
  }

  async logoutAll(customerId: string): Promise<void> {
    await prisma.customerSession.updateMany({
      where: { customerId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}

export const customerAuthService = new CustomerAuthService();
