import { Router, Response, Request } from 'express';
import { storefrontService } from './storefront.service';
import { customerService } from '@/modules/customers/customer.service';
import { vipJoinSchema } from './storefront.schema';
import { asyncHandler, validateBody } from '@/middleware/validate';
import { sendSuccess } from '@/shared/api-response';

const router = Router();

router.get(
  '/homepage',
  asyncHandler(async (_req: Request, res: Response) => {
    res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
    const data = await storefrontService.getHomepage();
    sendSuccess(res, data, 'Homepage fetched');
  }),
);

router.get(
  '/collections',
  asyncHandler(async (_req: Request, res: Response) => {
    res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
    const data = await storefrontService.getCollectionsPage();
    sendSuccess(res, data, 'Collections page fetched');
  }),
);

router.post(
  '/vip-join',
  validateBody(vipJoinSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const customer = await customerService.joinVipList(req.body.phone, req.body.name);
    sendSuccess(res, { id: customer.id }, 'You have joined our VIP list', 201);
  }),
);

export default router;
