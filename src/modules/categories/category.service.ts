import { prisma } from '@/config/database';
import { ApiError } from '@/shared/api-response';
import { slugify, parsePagination, parseCreatedAtFilter } from '@/utils/helpers';
import { buildPaginationMeta } from '@/shared/api-response';
import { localStorageService } from '@/integrations/local-storage.service';
import { STORE_CACHE_TTL_MS, withCache, invalidateCache } from '@/utils/memory-cache';
import { productService } from '@/modules/products/product.service';
import { realtime } from '@/realtime/emitter';

function bustCategoryCaches() {
  invalidateCache('categories:');
  invalidateCache('category:');
  invalidateCache('category:page:');
  invalidateCache('storefront:');
  realtime.catalogChanged('category');
}

export class CategoryService {
  private async findByIdAny(id: string) {
    const category = await prisma.category.findFirst({ where: { id } });
    if (!category) throw new ApiError(404, 'Category not found');
    return category;
  }

  async findAll(activeOnly = true, options?: { withProductCount?: boolean }) {
    const cacheKey = `categories:${activeOnly}:${options?.withProductCount ?? !activeOnly}`;
    return withCache(cacheKey, STORE_CACHE_TTL_MS, async () => {
      const withProductCount = options?.withProductCount ?? !activeOnly;
      return prisma.category.findMany({
        where: {
          deletedAt: null,
          ...(activeOnly && { isActive: true }),
        },
        orderBy: { sortOrder: 'asc' },
        ...(withProductCount && {
          include: {
            _count: { select: { products: { where: { deletedAt: null } } } },
          },
        }),
      });
    });
  }

  async findAllPaginated(query: Record<string, string>) {
    const { page, limit, skip } = parsePagination(query);
    const search = query.search?.trim();
    const createdAt = parseCreatedAtFilter(query);

    const where = {
      deletedAt: null,
      ...(query.isActive === 'true' || query.isActive === 'false'
        ? { isActive: query.isActive === 'true' }
        : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' as const } },
              { slug: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
      ...(createdAt ? { createdAt } : {}),
    };

    const [categories, total] = await Promise.all([
      prisma.category.findMany({
        where,
        orderBy: { sortOrder: 'asc' },
        skip,
        take: limit,
        include: {
          _count: { select: { products: { where: { deletedAt: null } } } },
        },
      }),
      prisma.category.count({ where }),
    ]);

    return { categories, meta: buildPaginationMeta(page, limit, total) };
  }

  async findBySlug(slug: string) {
    return withCache(`category:slug:${slug}`, STORE_CACHE_TTL_MS, async () => {
      const category = await prisma.category.findFirst({
        where: { slug, deletedAt: null, isActive: true },
      });
      if (!category) throw new ApiError(404, 'Category not found');
      return category;
    });
  }

  /** Single payload for category storefront page — one round trip instead of three. */
  async getStorefrontPage(slug: string) {
    return withCache(`category:page:${slug}`, STORE_CACHE_TTL_MS, async () => {
      const [category, categories, productsResult] = await Promise.all([
        this.findBySlug(slug),
        this.findAll(true),
        productService.findStorefrontList({ categorySlug: slug, limit: '50' }),
      ]);
      return {
        category,
        categories,
        products: productsResult.products,
      };
    });
  }

  async findById(id: string) {
    const category = await prisma.category.findFirst({
      where: { id, deletedAt: null },
      include: {
        _count: { select: { products: { where: { deletedAt: null } } } },
      },
    });
    if (!category) throw new ApiError(404, 'Category not found');
    return category;
  }

  async create(data: {
    name: string;
    description?: string;
    imageUrl?: string;
    sortOrder?: number;
    isActive?: boolean;
    seoTitle?: string;
    seoDesc?: string;
  }) {
    const slug = slugify(data.name);
    const existing = await prisma.category.findFirst({ where: { slug } });
    if (existing) throw new ApiError(409, 'Category with this name already exists');

    return prisma.category.create({
      data: { ...data, slug },
    }).then((category) => {
      bustCategoryCaches();
      return category;
    });
  }

  async update(id: string, data: Record<string, unknown>) {
    await this.findById(id);
    if (data.name) {
      data.slug = slugify(data.name as string);
    }
    return prisma.category.update({ where: { id }, data: data as Parameters<typeof prisma.category.update>[0]['data'] }).then((category) => {
      bustCategoryCaches();
      return category;
    });
  }

  async softDelete(id: string) {
    await this.findById(id);

    const productCount = await prisma.product.count({
      where: { categoryId: id, deletedAt: null },
    });
    if (productCount > 0) {
      throw new ApiError(
        400,
        `Cannot delete category while it has ${productCount} product${productCount === 1 ? '' : 's'}. Move or delete those products first.`,
      );
    }

    await prisma.category.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    bustCategoryCaches();
  }

  async unhide(id: string) {
    await this.findByIdAny(id);
    return prisma.category.update({
      where: { id },
      data: { deletedAt: null, isActive: true },
    }).then((category) => {
      bustCategoryCaches();
      return category;
    });
  }

  async uploadImage(id: string, file: Express.Multer.File) {
    const existing = await this.findById(id);
    const upload = await localStorageService.uploadImage(file.buffer, 'categories');
    // Remove the previous image once the replacement is safely written.
    if (existing.imageUrl) {
      void localStorageService.deleteImage(existing.imageUrl).catch(() => undefined);
    }
    return prisma.category.update({
      where: { id },
      data: { imageUrl: upload.url },
    }).then((category) => {
      bustCategoryCaches();
      return category;
    });
  }
}

export const categoryService = new CategoryService();
