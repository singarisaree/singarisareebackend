import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '@/config/env';
import { ApiError } from '@/shared/api-response';
import { customerAuthService } from '@/modules/customer-auth/customer-auth.service';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  name?: string;
}

export interface AuthenticatedRequest extends Request {
  admin?: {
    id: string;
    email: string;
    name: string;
    role: string;
  };
}

export interface CustomerAuthenticatedRequest extends Request {
  customer?: {
    id: string;
    name: string;
    phone: string;
    email: string | null;
  };
  customerSessionId?: string;
}

export function authenticateAdmin(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction,
): void {
  const token =
    req.cookies?.accessToken ||
    (req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null);

  if (!token) {
    next(new ApiError(401, 'Authentication required'));
    return;
  }

  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtPayload;
    req.admin = {
      id: decoded.sub,
      email: decoded.email,
      role: decoded.role,
      name: decoded.name || '',
    };
    next();
  } catch {
    next(new ApiError(401, 'Invalid or expired token'));
  }
}

/** Trust JWT from authenticateAdmin — avoids a DB round-trip on every admin request. */
export function loadAdmin(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction,
): void {
  if (!req.admin?.id) {
    next(new ApiError(401, 'Authentication required'));
    return;
  }
  next();
}

/**
 * Storefront customer session (permanent cookie, multi-device).
 * Does not expire until the customer logs out on that device.
 */
export function authenticateCustomer(
  req: CustomerAuthenticatedRequest,
  _res: Response,
  next: NextFunction,
): void {
  const token =
    (req.cookies?.[customerAuthService.cookieName] as string | undefined) ||
    (req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : undefined);

  void customerAuthService
    .resolveSession(token)
    .then((resolved) => {
      if (!resolved) {
        next(new ApiError(401, 'Login required'));
        return;
      }
      req.customer = resolved.customer;
      req.customerSessionId = resolved.sessionId;
      next();
    })
    .catch((error) => next(error));
}

/** Optional customer auth — attaches customer when session exists, never 401s. */
export function optionalCustomer(
  req: CustomerAuthenticatedRequest,
  _res: Response,
  next: NextFunction,
): void {
  const token = req.cookies?.[customerAuthService.cookieName] as string | undefined;
  if (!token) {
    next();
    return;
  }

  void customerAuthService
    .resolveSession(token)
    .then((resolved) => {
      if (resolved) {
        req.customer = resolved.customer;
        req.customerSessionId = resolved.sessionId;
      }
      next();
    })
    .catch(() => next());
}
