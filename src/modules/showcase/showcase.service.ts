import { prisma } from '@/config/database';
import { ApiError } from '@/shared/api-response';
import { localStorageService } from '@/integrations/local-storage.service';
import {
  MAX_SHOWCASE_ITEMS,
  SHOWCASE_CATEGORY_IDS_KEY,
} from './showcase.schema';

const productInclude = {
  product: {
    include: {
      colors: {
        where: { deletedAt: null, isActive: true },
        include: {
          images: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' as const } },
          inventory: { where: { deletedAt: null } },
        },
        orderBy: { sortOrder: 'asc' as const },
      },
    },
  },
  productColor: {
    include: {
      images: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' as const } },
      inventory: { where: { deletedAt: null } },
    },
  },
};

function mapShowcaseRow(
  row: {
    id: string;
    videoUrl: string;
    sortOrder: number;
    isActive: boolean;
    productId: string;
    productColorId: string;
    product: {
      id: string;
      name: string;
      slug: string;
      price: unknown;
      mrp: unknown;
      isComingSoon: boolean;
      isActive: boolean;
      colors: Array<{
        id: string;
        name: string;
        images: Array<{ url: string; isDefault: boolean }>;
        inventory: Array<{ quantity: number; reserved: number }>;
      }>;
    } | null;
    productColor: {
      id: string;
      name: string;
      images: Array<{ url: string; isDefault: boolean }>;
      inventory: Array<{ quantity: number; reserved: number }>;
    } | null;
  },
  options?: { forAdmin?: boolean },
) {
  const product = row.product;
  const color = row.productColor;
  if (!product || !color) {
    if (!options?.forAdmin) return null;
    return {
      id: row.id,
      videoUrl: row.videoUrl,
      sortOrder: row.sortOrder,
      isActive: row.isActive,
      productId: row.productId,
      productColorId: row.productColorId,
      productName: 'Unknown product',
      slug: '',
      colorName: 'Unknown color',
      price: 0,
      mrp: 0,
      imageUrl: null,
      maxStock: 0,
      isComingSoon: false,
      isOutOfStock: true,
    };
  }
  if (!options?.forAdmin && !product.isActive) return null;

  const inv = color.inventory?.[0];
  const availableStock = inv ? Math.max(0, inv.quantity - inv.reserved) : 0;
  const defaultImg =
    color.images.find((i) => i.isDefault)?.url ||
    color.images[0]?.url ||
    product.colors[0]?.images[0]?.url ||
    null;

  return {
    id: row.id,
    videoUrl: row.videoUrl,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    productId: product.id,
    productColorId: color.id,
    productName: product.name,
    slug: product.slug,
    colorName: color.name,
    price: Number(product.price),
    mrp: Number(product.mrp),
    imageUrl: defaultImg,
    maxStock: availableStock,
    isComingSoon: product.isComingSoon,
    isOutOfStock: availableStock <= 0,
  };
}

export class ShowcaseService {
  async getCategoryIds(): Promise<string[]> {
    const row = await prisma.setting.findUnique({ where: { key: SHOWCASE_CATEGORY_IDS_KEY } });
    if (!row?.value || !Array.isArray(row.value)) return [];
    return row.value.filter((id): id is string => typeof id === 'string');
  }

  async setCategoryIds(categoryIds: string[]) {
    const unique = [...new Set(categoryIds)];
    const categories = await prisma.category.findMany({
      where: { id: { in: unique }, deletedAt: null },
      select: { id: true },
    });
    if (categories.length !== unique.length) {
      throw new ApiError(400, 'One or more categories were not found');
    }
    await prisma.setting.upsert({
      where: { key: SHOWCASE_CATEGORY_IDS_KEY },
      create: { key: SHOWCASE_CATEGORY_IDS_KEY, value: unique, group: 'showcase' },
      update: { value: unique },
    });
    return unique;
  }

  async findActiveForStorefront() {
    const rows = await prisma.showcaseItem.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        product: { deletedAt: null, isActive: true },
        productColor: { deletedAt: null, isActive: true },
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: productInclude,
    });
    return rows
      .map((row) => mapShowcaseRow(row))
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .slice(0, MAX_SHOWCASE_ITEMS);
  }

  async findAllAdmin() {
    const [categoryIds, items] = await Promise.all([
      this.getCategoryIds(),
      prisma.showcaseItem.findMany({
        where: { deletedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        include: productInclude,
      }),
    ]);
    return {
      categoryIds,
      items: items
        .map((row) => mapShowcaseRow(row, { forAdmin: true }))
        .filter((item): item is NonNullable<typeof item> => Boolean(item)),
    };
  }

  private async assertProductAndColor(productId: string, productColorId: string) {
    const product = await prisma.product.findFirst({
      where: {
        id: productId,
        deletedAt: null,
        isActive: true,
      },
      include: {
        colors: {
          where: { id: productColorId, deletedAt: null, isActive: true },
        },
      },
    });
    if (!product || !product.colors.length) {
      throw new ApiError(400, 'Product or color not found');
    }
  }

  async createItem(
    data: {
      productId: string;
      productColorId: string;
      sortOrder?: number;
      isActive?: boolean;
    },
    file: Express.Multer.File,
  ) {
    await this.assertProductAndColor(data.productId, data.productColorId);

    // Unique on product_color_id — same product with different colors is allowed.
    const existingColor = await prisma.showcaseItem.findFirst({
      where: { productColorId: data.productColorId },
    });

    if (existingColor && !existingColor.deletedAt) {
      throw new ApiError(400, 'This color variant already has a showcase video. Choose a different color.');
    }

    const activeCount = await prisma.showcaseItem.count({ where: { deletedAt: null } });
    if (!existingColor && activeCount >= MAX_SHOWCASE_ITEMS) {
      throw new ApiError(400, `Maximum ${MAX_SHOWCASE_ITEMS} showcase videos allowed`);
    }
    if (existingColor?.deletedAt && activeCount >= MAX_SHOWCASE_ITEMS) {
      throw new ApiError(400, `Maximum ${MAX_SHOWCASE_ITEMS} showcase videos allowed`);
    }

    const upload = await localStorageService.uploadVideo(
      file.buffer,
      file.mimetype,
      file.originalname,
      'showcase-videos',
    );

    try {
      if (existingColor?.deletedAt) {
        // Reuse the soft-deleted row for this color variant
        const previousPublicId = existingColor.publicId;
        const updated = await prisma.showcaseItem.update({
          where: { id: existingColor.id },
          data: {
            productId: data.productId,
            videoUrl: upload.url,
            publicId: upload.publicId,
            sortOrder: data.sortOrder ?? existingColor.sortOrder,
            isActive: true,
            deletedAt: null,
          },
          include: productInclude,
        });
        if (previousPublicId && previousPublicId !== upload.publicId) {
          await localStorageService.deleteImage(previousPublicId).catch(() => undefined);
        }
        const mapped = mapShowcaseRow(updated);
        if (!mapped) throw new ApiError(500, 'Could not load showcase item');
        return mapped;
      }

      const created = await prisma.showcaseItem.create({
        data: {
          productId: data.productId,
          productColorId: data.productColorId,
          videoUrl: upload.url,
          publicId: upload.publicId,
          sortOrder: data.sortOrder ?? activeCount,
          isActive: true,
        },
        include: productInclude,
      });

      const mapped = mapShowcaseRow(created);
      if (!mapped) throw new ApiError(500, 'Could not load showcase item');
      return mapped;
    } catch (error) {
      await localStorageService.deleteImage(upload.publicId).catch(() => undefined);
      throw error;
    }
  }

  async updateItem(
    id: string,
    data: {
      productId?: string;
      productColorId?: string;
      sortOrder?: number;
      isActive?: boolean;
    },
    file?: Express.Multer.File,
  ) {
    const item = await prisma.showcaseItem.findFirst({ where: { id, deletedAt: null } });
    if (!item) throw new ApiError(404, 'Showcase video not found');

    const nextProductId = data.productId ?? item.productId;
    const nextColorId = data.productColorId ?? item.productColorId;

    if (data.productColorId && data.productColorId !== item.productColorId) {
      const clash = await prisma.showcaseItem.findFirst({
        where: { productColorId: data.productColorId, deletedAt: null, NOT: { id } },
      });
      if (clash) throw new ApiError(400, 'This color variant already has a showcase video');
    }

    await this.assertProductAndColor(nextProductId, nextColorId);

    let upload: { url: string; publicId: string } | null = null;
    if (file) {
      upload = await localStorageService.uploadVideo(
        file.buffer,
        file.mimetype,
        file.originalname,
        'showcase-videos',
      );
    }

    try {
      const updated = await prisma.showcaseItem.update({
        where: { id },
        data: {
          productId: nextProductId,
          productColorId: nextColorId,
          sortOrder: data.sortOrder,
          isActive: data.isActive,
          ...(upload
            ? { videoUrl: upload.url, publicId: upload.publicId }
            : {}),
        },
        include: productInclude,
      });

      if (upload && item.publicId !== upload.publicId) {
        await localStorageService.deleteImage(item.publicId).catch(() => undefined);
      }

      const mapped = mapShowcaseRow(updated);
      if (!mapped) throw new ApiError(500, 'Could not load showcase item');
      return mapped;
    } catch (error) {
      if (upload) await localStorageService.deleteImage(upload.publicId).catch(() => undefined);
      throw error;
    }
  }

  async deleteItem(id: string) {
    const item = await prisma.showcaseItem.findFirst({ where: { id, deletedAt: null } });
    if (!item) throw new ApiError(404, 'Showcase video not found');
    await localStorageService.deleteImage(item.publicId).catch(() => undefined);
    await prisma.showcaseItem.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  async reorderItems(orderedIds: string[]) {
    const items = await prisma.showcaseItem.findMany({
      where: { deletedAt: null, id: { in: orderedIds } },
    });
    if (items.length !== orderedIds.length) {
      throw new ApiError(400, 'Invalid showcase order');
    }
    await prisma.$transaction(
      orderedIds.map((id, index) =>
        prisma.showcaseItem.update({
          where: { id },
          data: { sortOrder: index },
        }),
      ),
    );
    return this.findAllAdmin().then((r) => r.items);
  }
}

export const showcaseService = new ShowcaseService();
