import { z } from 'zod';
import { CouponType } from '@prisma/client';
import { prisma } from '@/config/database';
import { ApiError } from '@/shared/api-response';
import { parsePagination, parseCreatedAtFilter } from '@/utils/helpers';
import { buildPaginationMeta } from '@/shared/api-response';

export const createCouponSchema = z.object({
  code: z.string().min(3).max(20),
  type: z.nativeEnum(CouponType),
  value: z.number().positive(),
  minOrderAmount: z.number().min(0).optional(),
  maxDiscount: z.number().positive().optional(),
  usageLimit: z.number().int().positive().optional(),
  startsAt: z.string().datetime().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  isActive: z.boolean().optional(),
});

export const updateCouponSchema = createCouponSchema.partial();

export class CouponService {
  async findAll(query: Record<string, string>) {
    const { page, limit, skip } = parsePagination(query);
    const search = query.search?.trim();
    const createdAt = parseCreatedAtFilter(query);
    const where = {
      deletedAt: null,
      ...(query.isActive === 'true' || query.isActive === 'false'
        ? { isActive: query.isActive === 'true' }
        : {}),
      ...(search
        ? { code: { contains: search, mode: 'insensitive' as const } }
        : {}),
      ...(createdAt ? { createdAt } : {}),
    };

    const [coupons, total] = await Promise.all([
      prisma.coupon.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      prisma.coupon.count({ where }),
    ]);

    return { coupons, meta: buildPaginationMeta(page, limit, total) };
  }

  async findById(id: string) {
    const coupon = await prisma.coupon.findFirst({ where: { id, deletedAt: null } });
    if (!coupon) throw new ApiError(404, 'Coupon not found');
    return coupon;
  }

  async create(data: z.infer<typeof createCouponSchema>) {
    const existing = await prisma.coupon.findFirst({
      where: { code: data.code.toUpperCase(), deletedAt: null },
    });
    if (existing) throw new ApiError(409, 'Coupon code already exists');

    return prisma.coupon.create({
      data: {
        ...data,
        code: data.code.toUpperCase(),
        startsAt: data.startsAt ? new Date(data.startsAt) : undefined,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
      },
    });
  }

  async update(id: string, data: z.infer<typeof updateCouponSchema>) {
    const coupon = await prisma.coupon.findFirst({ where: { id, deletedAt: null } });
    if (!coupon) throw new ApiError(404, 'Coupon not found');

    if (data.code) {
      const conflict = await prisma.coupon.findFirst({
        where: {
          code: data.code.toUpperCase(),
          deletedAt: null,
          NOT: { id },
        },
      });
      if (conflict) throw new ApiError(409, 'Coupon code already exists');
    }

    return prisma.coupon.update({
      where: { id },
      data: {
        ...data,
        ...(data.code && { code: data.code.toUpperCase() }),
        ...(data.startsAt !== undefined && {
          startsAt: data.startsAt ? new Date(data.startsAt) : null,
        }),
        ...(data.expiresAt !== undefined && {
          expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
        }),
      },
    });
  }

  async softDelete(id: string) {
    const coupon = await prisma.coupon.findFirst({ where: { id, deletedAt: null } });
    if (!coupon) throw new ApiError(404, 'Coupon not found');

    await prisma.coupon.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }
}

export const couponService = new CouponService();
