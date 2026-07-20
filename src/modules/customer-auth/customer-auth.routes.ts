import { Router, Response } from 'express';
import { customerAuthService } from './customer-auth.service';
import { sendOtpSchema, verifyOtpSchema } from './customer-auth.schema';
import { validateBody, asyncHandler } from '@/middleware/validate';
import {
  authenticateCustomer,
  CustomerAuthenticatedRequest,
} from '@/middleware/auth';
import { sendSuccess } from '@/shared/api-response';

const router = Router();

router.post(
  '/otp/send',
  validateBody(sendOtpSchema),
  asyncHandler(async (req, res: Response) => {
    const result = await customerAuthService.sendOtp(req.body.phone);
    sendSuccess(res, result, 'OTP sent');
  }),
);

router.post(
  '/otp/verify',
  validateBody(verifyOtpSchema),
  asyncHandler(async (req, res: Response) => {
    const result = await customerAuthService.verifyOtp({
      phoneRaw: req.body.phone,
      otp: req.body.otp,
      name: req.body.name,
      userAgent: req.get('user-agent') || undefined,
      ipAddress: req.ip,
    });

    customerAuthService.setSessionCookie(res, result.rawToken);
    sendSuccess(
      res,
      { customer: result.customer },
      'Logged in',
    );
  }),
);

router.get(
  '/me',
  authenticateCustomer,
  asyncHandler(async (req: CustomerAuthenticatedRequest, res: Response) => {
    sendSuccess(res, { customer: req.customer }, 'OK');
  }),
);

router.post(
  '/logout',
  asyncHandler(async (req, res: Response) => {
    const token = req.cookies?.[customerAuthService.cookieName] as string | undefined;
    await customerAuthService.logout(token);
    customerAuthService.clearSessionCookie(res);
    sendSuccess(res, null, 'Logged out');
  }),
);

router.post(
  '/logout-all',
  authenticateCustomer,
  asyncHandler(async (req: CustomerAuthenticatedRequest, res: Response) => {
    if (req.customer?.id) {
      await customerAuthService.logoutAll(req.customer.id);
    }
    customerAuthService.clearSessionCookie(res);
    sendSuccess(res, null, 'Logged out from all devices');
  }),
);

export default router;
