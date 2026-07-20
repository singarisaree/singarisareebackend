import { z } from 'zod';

export const vipJoinSchema = z.object({
  name: z.string().trim().min(2, 'Enter your name').max(100),
  phone: z.string().regex(/^[6-9]\d{9}$/, 'Enter valid 10-digit Indian mobile number'),
});
