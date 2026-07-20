import { Router, Response } from 'express';
import { authService } from './auth.service';
import { loginSchema, refreshTokenSchema } from './auth.schema';
import { validateBody } from '@/middleware/validate';
import { asyncHandler } from '@/middleware/validate';
import { authenticateAdmin, AuthenticatedRequest } from '@/middleware/auth';
import { sendSuccess } from '@/shared/api-response';
import { Request } from 'express';

const router = Router();

router.post(
  '/login',
  validateBody(loginSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { email, password } = req.body;
    const result = await authService.login(email, password);
    authService.setAuthCookies(res, result.accessToken, result.refreshToken);
    sendSuccess(res, { admin: result.admin }, 'Login successful');
  }),
);

router.post(
  '/refresh',
  validateBody(refreshTokenSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const token = req.cookies?.refreshToken || req.body.refreshToken;
    if (!token) {
      res.status(401).json({ success: false, message: 'Refresh token required' });
      return;
    }
    const result = await authService.refresh(token);
    authService.setAuthCookies(res, result.accessToken, result.refreshToken);
    sendSuccess(res, null, 'Token refreshed');
  }),
);

router.post(
  '/logout',
  authenticateAdmin,
  asyncHandler(async (_req: AuthenticatedRequest, res: Response) => {
    authService.clearAuthCookies(res);
    sendSuccess(res, null, 'Logged out successfully');
  }),
);

router.get(
  '/me',
  authenticateAdmin,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    sendSuccess(res, { admin: req.admin }, 'Admin profile');
  }),
);

export default router;
