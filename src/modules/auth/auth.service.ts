import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Response } from 'express';
import { prisma } from '@/config/database';
import { env } from '@/config/env';
import { ApiError } from '@/shared/api-response';
import { JwtPayload } from '@/middleware/auth';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  // lax allows API cookies on cross-port localhost and normal SPA navigations
  sameSite: 'lax' as const,
  path: '/',
};

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
