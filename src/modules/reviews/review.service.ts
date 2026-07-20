import { z } from 'zod';
import { prisma } from '@/config/database';
import { ApiError, buildPaginationMeta } from '@/shared/api-response';
import { localStorageService } from '@/integrations/local-storage.service';
import { parsePagination, parseCreatedAtFilter } from '@/utils/helpers';

export const createReviewSchema = z.object({
  productId: z.string().uuid(),
  customerName: z.string().min(2),
  rating: z.number().int().min(1).max(5),
  comment: z.string().min(3),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export const updateReviewSchema = createReviewSchema.partial();

export class ReviewService {
  async findActive() {
    return prisma.customerReview.findMany({
      where: { isActive: true, deletedAt: null },
      orderBy: { sortOrder: 'asc' },
      include: { product: { select: { id: true, name: true, slug: true } } },
    });
  }

  async findAll(productId?: string) {
    return prisma.customerReview.findMany({
      where: {
        deletedAt: null,
        ...(productId && { productId }),
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      include: { product: { select: { id: true, name: true, slug: true } } },
    });
  }

  async findAllPaginated(query: Record<string, string>) {
    const { page, limit, skip } = parsePagination(query);
    const productId = query.productId;
    const categoryId = query.categoryId;
    const search = query.search?.trim();
    const createdAt = parseCreatedAtFilter(query);

    const where = {
      deletedAt: null,
      ...(productId ? { productId } : {}),
      ...(categoryId ? { product: { categoryId } } : {}),
      ...(search
        ? {
            OR: [
              { customerName: { contains: search, mode: 'insensitive' as const } },
              { comment: { contains: search, mode: 'insensitive' as const } },
              { product: { name: { contains: search, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
      ...(createdAt ? { createdAt } : {}),
    };

    const [reviews, total] = await Promise.all([
      prisma.customerReview.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
        skip,
        take: limit,
        include: { product: { select: { id: true, name: true, slug: true, categoryId: true } } },
      }),
      prisma.customerReview.count({ where }),
    ]);

    return { reviews, meta: buildPaginationMeta(page, limit, total) };
  }

  async findByProductId(productId: string) {
    return prisma.customerReview.findMany({
      where: { productId, isActive: true, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        customerName: true,
        rating: true,
        comment: true,
        imageUrl: true,
        createdAt: true,
      },
    });
  }

  async create(data: z.infer<typeof createReviewSchema>, file?: Express.Multer.File) {
    let imageUrl: string | undefined;
    let publicId: string | undefined;

    if (file) {
      const upload = await localStorageService.uploadImage(file.buffer, 'reviews');
      imageUrl = upload.url;
      publicId = upload.publicId;
    }

    return prisma.customerReview.create({
      data: { ...data, imageUrl, publicId },
    });
  }

  async update(id: string, data: z.infer<typeof updateReviewSchema>) {
    const review = await prisma.customerReview.findFirst({ where: { id, deletedAt: null } });
    if (!review) throw new ApiError(404, 'Review not found');
    return prisma.customerReview.update({ where: { id }, data });
  }

  async softDelete(id: string) {
    await prisma.customerReview.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }
}

export const reviewService = new ReviewService();
