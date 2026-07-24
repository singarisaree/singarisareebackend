import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Response } from 'express';
import { prisma } from '@/config/database';
import { env } from '@/config/env';
import { ApiError } from '@/shared/api-response';
import { JwtPayload } from '@/middleware/auth';
import { emailService } from '@/integrations/email.service';
import { logger } from '@/utils/logger';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  // lax allows API cookies on cross-port localhost and normal SPA navigations
  sameSite: 'lax' as const,
  path: '/',
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildPasswordUpdatedEmail(input: {
  adminName: string;
  adminEmail: string;
  newPassword: string;
}): { subject: string; html: string; text: string } {
  const name = escapeHtml(input.adminName.split(' ')[0] || input.adminName || 'Admin');
  const email = escapeHtml(input.adminEmail);
  const password = escapeHtml(input.newPassword);
  const loginUrl = `${env.FRONTEND_URL.replace(/\/$/, '')}/admin/login`;
  const subject = 'Your Singari Sarees admin password was updated';

  const text = [
    `Hi ${input.adminName || 'Admin'},`,
    '',
    'Your admin password has been updated successfully.',
    '',
    `Email: ${input.adminEmail}`,
    `Updated password: ${input.newPassword}`,
    '',
    `Login: ${loginUrl}`,
    '',
    'If you did not make this change, contact support immediately.',
  ].join('\n');

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f7efe3;font-family:Georgia,serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f7efe3;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border:1px solid #efe8dc;">
          <tr>
            <td style="padding:28px 28px 8px;">
              <p style="margin:0;color:#b8944a;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;">Singari Sarees</p>
              <h1 style="margin:10px 0 0;color:#1c1612;font-size:22px;font-weight:normal;">Admin password updated</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 28px 24px;color:#5c4c3f;font-size:15px;line-height:1.6;">
              <p style="margin:0;">Hi ${name},</p>
              <p style="margin:12px 0 0;">Your admin password has been updated successfully. Keep this email for your records.</p>
              <table role="presentation" width="100%" style="margin:20px 0;background:#faf6ef;border:1px solid #efe8dc;">
                <tr>
                  <td style="padding:16px;">
                    <p style="margin:0;color:#8a7a6b;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;">Admin email</p>
                    <p style="margin:6px 0 0;color:#1c1612;font-size:15px;">${email}</p>
                    <p style="margin:16px 0 0;color:#8a7a6b;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;">Updated password</p>
                    <p style="margin:6px 0 0;color:#1c1612;font-size:18px;font-family:ui-monospace,Menlo,monospace;letter-spacing:0.04em;">${password}</p>
                  </td>
                </tr>
              </table>
              <p style="margin:0;">
                <a href="${escapeHtml(loginUrl)}" style="display:inline-block;padding:12px 20px;background:#1c1612;color:#f7efe3;text-decoration:none;font-size:13px;">Go to admin login</a>
              </p>
              <p style="margin:18px 0 0;color:#8a7a6b;font-size:13px;">If you did not make this change, contact support immediately.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, html, text };
}

export class AuthService {
  async login(email: string, password: string): Promise<{
    admin: { id: string; email: string; name: string; role: string };
    accessToken: string;
    refreshToken: string;
  }> {
    const admin = await prisma.admin.findFirst({
      where: { email, isActive: true, deletedAt: null },
    });

    if (!admin) {
      throw new ApiError(401, 'Invalid credentials');
    }

    const isValid = await bcrypt.compare(password, admin.passwordHash);
    if (!isValid) {
      throw new ApiError(401, 'Invalid credentials');
    }

    await prisma.admin.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });

    const payload: JwtPayload = {
      sub: admin.id,
      email: admin.email,
      role: admin.role,
      name: admin.name,
    };

    const accessToken = jwt.sign(payload, env.JWT_ACCESS_SECRET, {
      expiresIn: env.JWT_ACCESS_EXPIRES_IN,
    } as jwt.SignOptions);

    const refreshToken = jwt.sign(payload, env.JWT_REFRESH_SECRET, {
      expiresIn: env.JWT_REFRESH_EXPIRES_IN,
    } as jwt.SignOptions);

    return {
      admin: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: admin.role,
      },
      accessToken,
      refreshToken,
    };
  }

  async changePassword(
    adminId: string,
    data: { currentPassword: string; newPassword: string },
  ): Promise<{ emailSent: boolean; email: string }> {
    const admin = await prisma.admin.findFirst({
      where: { id: adminId, isActive: true, deletedAt: null },
    });
    if (!admin) {
      throw new ApiError(404, 'Admin account not found');
    }

    const isValid = await bcrypt.compare(data.currentPassword, admin.passwordHash);
    if (!isValid) {
      throw new ApiError(401, 'Current password is incorrect');
    }

    const passwordHash = await bcrypt.hash(data.newPassword, 12);
    await prisma.admin.update({
      where: { id: admin.id },
      data: { passwordHash },
    });

    const mail = buildPasswordUpdatedEmail({
      adminName: admin.name,
      adminEmail: admin.email,
      newPassword: data.newPassword,
    });

    const emailSent = await emailService.send({
      to: admin.email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });

    if (!emailSent) {
      logger.warn('Admin password updated but confirmation email was not sent', {
        adminId: admin.id,
        email: admin.email,
      });
    }

    return { emailSent, email: admin.email };
  }

  async refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    try {
      const decoded = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET) as JwtPayload;

      const admin = await prisma.admin.findFirst({
        where: { id: decoded.sub, isActive: true, deletedAt: null },
      });

      if (!admin) {
        throw new ApiError(401, 'Invalid refresh token');
      }

      const payload: JwtPayload = {
        sub: admin.id,
        email: admin.email,
        role: admin.role,
        name: admin.name,
      };

      const newAccessToken = jwt.sign(payload, env.JWT_ACCESS_SECRET, {
        expiresIn: env.JWT_ACCESS_EXPIRES_IN,
      } as jwt.SignOptions);

      const newRefreshToken = jwt.sign(payload, env.JWT_REFRESH_SECRET, {
        expiresIn: env.JWT_REFRESH_EXPIRES_IN,
      } as jwt.SignOptions);

      return { accessToken: newAccessToken, refreshToken: newRefreshToken };
    } catch {
      throw new ApiError(401, 'Invalid or expired refresh token');
    }
  }

  setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
    res.cookie('accessToken', accessToken, {
      ...COOKIE_OPTIONS,
      maxAge: 15 * 60 * 1000,
    });
    res.cookie('refreshToken', refreshToken, {
      ...COOKIE_OPTIONS,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }

  clearAuthCookies(res: Response): void {
    res.clearCookie('accessToken', COOKIE_OPTIONS);
    res.clearCookie('refreshToken', COOKIE_OPTIONS);
  }
}

export const authService = new AuthService();
