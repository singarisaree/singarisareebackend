import { Prisma } from '@prisma/client';
import { prisma, PRISMA_TX_OPTIONS } from '@/config/database';
import { ApiError } from '@/shared/api-response';
import { slugify, generateUniqueSku, parsePagination, parseCreatedAtFilter, randomBaseSoldCount } from '@/utils/helpers';
import { buildPaginationMeta } from '@/shared/api-response';
import { localStorageService } from '@/integrations/local-storage.service';
import { STORE_CACHE_TTL_MS, ADMIN_LIST_CACHE_TTL_MS, withCache, invalidateCache } from '@/utils/memory-cache';
import { realtime } from '@/realtime/emitter';
import type { adminSaveProductSchema, adminCreateProductSchema, adminAddColorSchema } from './product.schema';
import type { z } from 'zod';

type AdminSavePayload = z.infer<typeof adminSaveProductSchema>;
type AdminCreatePayload = z.infer<typeof adminCreateProductSchema>;
type AdminAddColorPayload = z.infer<typeof adminAddColorSchema>;

const storefrontColorWhere = { deletedAt: null, isActive: true };

const productListInclude = {
  category: { select: { id: true, name: true, slug: true } },
  colors: {
    where: storefrontColorWhere,
    orderBy: { sortOrder: 'asc' as const },
    take: 1,
    include: {
      images: {
        where: { deletedAt: null },
        orderBy: { sortOrder: 'asc' as const },
        take: 1,
      },
      inventory: {
        where: { deletedAt: null },
        select: { id: true, quantity: true, reserved: true, lowStockAlert: true },
      },
    },
  },
};

const adminProductListInclude = {
  category: { select: { id: true, name: true, slug: true } },
  colors: {
    where: { deletedAt: null },
    orderBy: { sortOrder: 'asc' as const },
    select: {
      images: {
        where: { deletedAt: null },
        orderBy: { sortOrder: 'asc' as const },
        take: 1,
        select: { url: true },
      },
      inventory: {
        where: { deletedAt: null },
        select: { quantity: true, reserved: true },
      },
    },
  },
};

const relatedListInclude = {
  category: { select: { id: true, name: true, slug: true } },
  colors: {
    where: storefrontColorWhere,
    orderBy: { sortOrder: 'asc' as const },
    take: 1,
    include: {
      images: {
        where: { deletedAt: null },
        orderBy: { sortOrder: 'asc' as const },
        take: 1,
      },
      inventory: {
        where: { deletedAt: null },
        select: { quantity: true, reserved: true },
      },
    },
  },
};

function invalidateStorefrontProductCaches(): void {
  invalidateCache('product:');
  invalidateCache('products:list:');
  invalidateCache('products:storefront-list:');
  invalidateCache('products:admin:list:');
  invalidateCache('product:related:');
  invalidateCache('products:latest-by-category:');
  invalidateCache('category:page:');
  invalidateCache('storefront:');
  invalidateCache('categories:');
  realtime.catalogChanged('product');
}

const productInclude = {
  category: { select: { id: true, name: true, slug: true } },
  colors: {
    where: { deletedAt: null },
    orderBy: { sortOrder: 'asc' as const },
    include: {
      images: {
        where: { deletedAt: null },
        orderBy: { sortOrder: 'asc' as const },
      },
      inventory: {
        where: { deletedAt: null },
        select: { id: true, quantity: true, reserved: true, lowStockAlert: true },
      },
    },
  },
};

const storefrontProductInclude = {
  category: { select: { id: true, name: true, slug: true } },
  colors: {
    where: storefrontColorWhere,
    orderBy: { sortOrder: 'asc' as const },
    include: {
      images: {
        where: { deletedAt: null },
        orderBy: { sortOrder: 'asc' as const },
      },
      inventory: {
        where: { deletedAt: null },
        select: { id: true, quantity: true, reserved: true, lowStockAlert: true },
      },
    },
  },
};

export class ProductService {
  private async allocateSku(): Promise<string> {
    return generateUniqueSku(async (sku) => {
      const existing = await prisma.product.findUnique({
        where: { sku },
        select: { id: true },
      });
      return !!existing;
    });
  }

  private buildListWhere(
    query: {
      search?: string;
      categoryId?: string;
      categorySlug?: string;
      isActive?: string;
      isFeatured?: string;
      minPrice?: string;
      maxPrice?: string;
      startDate?: string;
      endDate?: string;
    },
    options: { storefront?: boolean } = {},
  ): Prisma.ProductWhereInput {
    const where: Prisma.ProductWhereInput = { deletedAt: null };

    if (options.storefront) {
      if (query.isActive !== undefined) {
        where.isActive = query.isActive === 'true';
      } else {
        where.isActive = true;
      }
    } else if (query.isActive === 'true' || query.isActive === 'false') {
      where.isActive = query.isActive === 'true';
    }

    if (query.isFeatured === 'true') where.isFeatured = true;
    if (query.categoryId) where.categoryId = query.categoryId;
    if (query.categorySlug) {
      where.category = { slug: query.categorySlug };
    }
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { sku: { contains: query.search, mode: 'insensitive' } },
        { tags: { has: query.search } },
      ];
    }
    if (query.minPrice || query.maxPrice) {
      where.price = {};
      if (query.minPrice) where.price.gte = parseFloat(query.minPrice);
      if (query.maxPrice) where.price.lte = parseFloat(query.maxPrice);
    }
    const createdAt = parseCreatedAtFilter(query);
    if (createdAt) where.createdAt = createdAt;

    return where;
  }

  private async queryProducts(
    query: {
      page?: string;
      limit?: string;
      search?: string;
      categoryId?: string;
      categorySlug?: string;
      isActive?: string;
      isFeatured?: string;
      minPrice?: string;
      maxPrice?: string;
      sortBy?: string;
      sortOrder?: string;
    },
    options: { storefront?: boolean; adminList?: boolean; skipCount?: boolean; listOnly?: boolean } = {},
  ) {
    const { page, limit, skip } = parsePagination(query);
    const where = this.buildListWhere(query, options);
    const orderBy: Prisma.ProductOrderByWithRelationInput = {
      [query.sortBy || 'createdAt']: query.sortOrder || 'desc',
    };
    const include = options.adminList ? adminProductListInclude : productListInclude;
    const formatter = options.adminList
      ? this.formatAdminListProduct
      : options.listOnly
        ? this.formatListProduct
        : this.formatProduct;

    const products = await prisma.product.findMany({
      where,
      include,
      orderBy,
      skip,
      take: limit,
    });

    if (options.skipCount) {
      return {
        products: products.map(formatter),
        meta: buildPaginationMeta(page, limit, products.length),
      };
    }

    const total = await prisma.product.count({ where });

    return {
      products: products.map(formatter),
      meta: buildPaginationMeta(page, limit, total),
    };
  }

  async findAll(query: {
    page?: string;
    limit?: string;
    search?: string;
    categoryId?: string;
    categorySlug?: string;
    isActive?: string;
    isFeatured?: string;
    minPrice?: string;
    maxPrice?: string;
    sortBy?: string;
    sortOrder?: string;
  }) {
    const cacheKey = `products:list:${JSON.stringify(query)}`;
    return withCache(cacheKey, STORE_CACHE_TTL_MS, () =>
      this.queryProducts(query, { storefront: true }),
    );
  }

  /** Storefront grids — lean payload, no count query. */
  async findStorefrontList(query: {
    page?: string;
    limit?: string;
    categoryId?: string;
    categorySlug?: string;
    isFeatured?: string;
    sortBy?: string;
    sortOrder?: string;
  }) {
    const cacheKey = `products:storefront-list:${JSON.stringify(query)}`;
    return withCache(cacheKey, STORE_CACHE_TTL_MS, () =>
      this.queryProducts(query, { storefront: true, skipCount: true, listOnly: true }),
    );
  }

  /** Admin — all non-deleted products; isActive filter optional */
  async findAllForAdmin(query: {
    page?: string;
    limit?: string;
    search?: string;
    categoryId?: string;
    categorySlug?: string;
    isActive?: string;
    isFeatured?: string;
    minPrice?: string;
    maxPrice?: string;
    sortBy?: string;
    sortOrder?: string;
  }) {
    const cacheKey = `products:admin:list:${JSON.stringify(query)}`;
    return withCache(cacheKey, ADMIN_LIST_CACHE_TTL_MS, () =>
      this.queryProducts(query, { adminList: true }),
    );
  }

  async findBySlug(slug: string) {
    return withCache(`product:slug:${slug}`, STORE_CACHE_TTL_MS, async () => {
      const product = await prisma.product.findFirst({
        where: { slug, deletedAt: null, isActive: true },
        include: storefrontProductInclude,
      });

      if (!product) throw new ApiError(404, 'Product not found');

      const relatedProducts = await this.fetchRelatedProducts(
        product.id,
        product.categoryId,
        4,
      );

      return {
        ...this.formatProduct(product),
        relatedProducts,
      };
    });
  }

  /** Storefront product page — product payload only; related picks load separately. */
  async findBySlugStorefront(slug: string) {
    return withCache(`product:slug:storefront:${slug}`, STORE_CACHE_TTL_MS, async () => {
      const product = await prisma.product.findFirst({
        where: { slug, deletedAt: null, isActive: true },
        include: storefrontProductInclude,
      });

      if (!product) throw new ApiError(404, 'Product not found');

      return this.formatProduct(product);
    });
  }

  async findById(id: string, includeDeleted = false) {
    let product = await prisma.product.findFirst({
      where: { id, ...(includeDeleted ? {} : { deletedAt: null }) },
      include: productInclude,
    });

    if (!product) throw new ApiError(404, 'Product not found');

    const created = await this.ensureColorInventories(product.id, product.colors);
    if (created) {
      product = await prisma.product.findFirst({
        where: { id, ...(includeDeleted ? {} : { deletedAt: null }) },
        include: productInclude,
      });
      if (!product) throw new ApiError(404, 'Product not found');
    }

    return this.formatProduct(product);
  }

  /** Create inventory rows for colors that are missing them (legacy data) */
  private async ensureColorInventories(
    productId: string,
    colors: Array<{ id: string; inventory?: Array<unknown> }>,
  ): Promise<boolean> {
    const missing = colors.filter((color) => !color.inventory?.length);
    if (missing.length === 0) return false;

    await prisma.$transaction(
      missing.map((color) =>
        prisma.inventory.create({
          data: { productId, productColorId: color.id, quantity: 0 },
        }),
      ),
    );
    return true;
  }

  async updateColorStock(colorId: string, availableStock: number) {
    const color = await prisma.productColor.findFirst({
      where: { id: colorId, deletedAt: null },
      include: { inventory: { where: { deletedAt: null } } },
    });
    if (!color) throw new ApiError(404, 'Color not found');

    let inventory = color.inventory[0];
    if (!inventory) {
      inventory = await prisma.inventory.create({
        data: {
          productId: color.productId,
          productColorId: color.id,
          quantity: availableStock,
        },
      });
    } else {
      const previousQty = inventory.quantity;
      const quantity = availableStock + inventory.reserved;

      inventory = await prisma.$transaction(async (tx) => {
        const inv = await tx.inventory.update({
          where: { id: inventory!.id },
          data: { quantity },
        });

        if (quantity !== previousQty) {
          await tx.inventoryHistory.create({
            data: {
              inventoryId: inv.id,
              changeType: quantity > previousQty ? 'IN' : 'OUT',
              quantity: Math.abs(quantity - previousQty),
              previousQty,
              newQty: quantity,
              reason: 'Admin stock update',
            },
          });
        }

        return inv;
      });
    }

    invalidateStorefrontProductCaches();
    return inventory;
  }

  async create(data: {
    name: string;
    categoryId: string;
    description: string;
    price: number;
    mrp: number;
    colors: Array<{ name: string; hexCode?: string; sortOrder?: number; stock: number }>;
    [key: string]: unknown;
  }) {
    const category = await prisma.category.findFirst({
      where: { id: data.categoryId, deletedAt: null },
    });
    if (!category) throw new ApiError(404, 'Category not found');

    const slug = slugify(data.name);
    const existingSlug = await prisma.product.findFirst({ where: { slug } });
    const finalSlug = existingSlug ? `${slug}-${Date.now()}` : slug;
    const sku = await this.allocateSku();

    const { colors, ...productData } = data;

    const product = await prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          name: productData.name,
          slug: finalSlug,
          sku,
          categoryId: data.categoryId,
          description: productData.description,
          productDetails: (productData.productDetails as string | undefined)?.trim() || null,
          price: productData.price,
          mrp: productData.mrp,
          fabric: productData.fabric as string | undefined,
          care: productData.care as string | undefined,
          shippingInfo: productData.shippingInfo as string | undefined,
          returnPolicy: productData.returnPolicy as string | undefined,
          discount: (productData.discount as number) ?? 0,
          weight: productData.weight as number | undefined,
          length: productData.length as number | undefined,
          width: productData.width as number | undefined,
          height: productData.height as number | undefined,
          tags: (productData.tags as string[]) ?? [],
          seoTitle: productData.seoTitle as string | undefined,
          seoDesc: productData.seoDesc as string | undefined,
          seoKeywords: (productData.seoKeywords as string[]) ?? [],
          baseSoldCount:
            typeof productData.baseSoldCount === 'number'
              ? productData.baseSoldCount
              : randomBaseSoldCount(),
          isActive: (productData.isActive as boolean) ?? true,
          isFeatured: (productData.isFeatured as boolean) ?? false,
        },
      });

      for (const [index, color] of colors.entries()) {
        const productColor = await tx.productColor.create({
          data: {
            productId: created.id,
            name: color.name,
            hexCode: color.hexCode,
            sortOrder: color.sortOrder ?? index,
          },
        });

        await tx.inventory.create({
          data: {
            productId: created.id,
            productColorId: productColor.id,
            quantity: color.stock,
          },
        });
      }

      return created;
    });

    invalidateStorefrontProductCaches();
    return this.findById(product.id);
  }

  /**
   * Atomic admin create: product + variants + inventory + images in one DB transaction.
   * Files use fieldnames `color_<index>` matching the colors array order.
   */
  async adminCreate(
    data: AdminCreatePayload,
    files: Express.Multer.File[],
  ) {
    const filesByIndex = new Map<number, Express.Multer.File[]>();
    for (const file of files) {
      const match = /^color_(\d+)$/.exec(file.fieldname);
      if (!match) {
        throw new ApiError(400, `Unexpected file field "${file.fieldname}"`);
      }
      const index = Number(match[1]);
      if (!Number.isInteger(index) || index < 0 || index >= data.colors.length) {
        throw new ApiError(400, `File field "${file.fieldname}" does not match a color`);
      }
      const list = filesByIndex.get(index) ?? [];
      list.push(file);
      filesByIndex.set(index, list);
    }

    for (const [index, colorFiles] of filesByIndex) {
      if (colorFiles.length > 6) {
        throw new ApiError(
          400,
          `Maximum 6 images per color. Color "${data.colors[index]?.name}" has ${colorFiles.length}`,
        );
      }
    }

    const category = await prisma.category.findFirst({
      where: { id: data.categoryId, deletedAt: null },
    });
    if (!category) throw new ApiError(404, 'Category not found');

    const slug = slugify(data.name);
    const existingSlug = await prisma.product.findFirst({ where: { slug } });
    const finalSlug = existingSlug ? `${slug}-${Date.now()}` : slug;
    const sku = await this.allocateSku();

    const uploadedPublicIds: string[] = [];
    const uploadsByIndex = new Map<number, Array<{ url: string; publicId: string }>>();

    try {
      const pendingFolder = `products/pending-${Date.now()}`;
      // Upload all colors in parallel — biggest save latency win
      await Promise.all(
        [...filesByIndex.entries()].map(async ([index, colorFiles]) => {
          if (colorFiles.length === 0) return;
          const uploads = await localStorageService.uploadMultiple(
            colorFiles,
            `${pendingFolder}/c${index}`,
          );
          uploadedPublicIds.push(...uploads.map((u) => u.publicId));
          uploadsByIndex.set(index, uploads);
        }),
      );

      const { colors, ...productData } = data;

      const productId = await prisma.$transaction(async (tx) => {
        const created = await tx.product.create({
          data: {
            name: productData.name,
            slug: finalSlug,
            sku,
            categoryId: data.categoryId,
            description: productData.description,
            productDetails: productData.productDetails?.trim() || null,
            price: productData.price,
            mrp: productData.mrp,
            fabric: productData.fabric,
            care: productData.care,
            shippingInfo: productData.shippingInfo,
            returnPolicy: productData.returnPolicy,
            discount: productData.discount ?? 0,
            weight: productData.weight,
            length: productData.length,
            width: productData.width,
            height: productData.height,
            tags: productData.tags ?? [],
            seoTitle: productData.seoTitle,
            seoDesc: productData.seoDesc,
            seoKeywords: productData.seoKeywords ?? [],
            baseSoldCount:
              typeof productData.baseSoldCount === 'number'
                ? productData.baseSoldCount
                : randomBaseSoldCount(),
            isActive: productData.isActive ?? true,
            isComingSoon: productData.isComingSoon ?? false,
            isFeatured: productData.isFeatured ?? false,
          },
        });

        for (const [index, color] of colors.entries()) {
          const productColor = await tx.productColor.create({
            data: {
              productId: created.id,
              name: color.name,
              hexCode: color.hexCode,
              sortOrder: color.sortOrder ?? index,
            },
          });

          await tx.inventory.create({
            data: {
              productId: created.id,
              productColorId: productColor.id,
              quantity: color.stock,
            },
          });

          const uploads = uploadsByIndex.get(index) ?? [];
          if (uploads.length > 0) {
            await tx.productImage.createMany({
              data: uploads.map((upload, imgIndex) => ({
                productColorId: productColor.id,
                url: upload.url,
                publicId: upload.publicId,
                sortOrder: imgIndex,
                isDefault: imgIndex === 0,
              })),
            });
          }
        }

        return created.id;
      }, PRISMA_TX_OPTIONS);

      invalidateStorefrontProductCaches();
      return this.findById(productId);
    } catch (error) {
      if (uploadedPublicIds.length > 0) {
        void localStorageService.deleteMultiple(uploadedPublicIds).catch(() => undefined);
      }
      throw error;
    }
  }

  async update(id: string, data: Record<string, unknown>) {
    await this.findById(id, true);

    if (data.categoryId) {
      const category = await prisma.category.findFirst({
        where: { id: data.categoryId as string, deletedAt: null },
      });
      if (!category) throw new ApiError(404, 'Category not found');
    }

    if (data.name) {
      const slug = slugify(data.name as string);
      const existing = await prisma.product.findFirst({
        where: { slug, id: { not: id } },
      });
      if (!existing) data.slug = slug;
    }

    await prisma.product.update({ where: { id }, data: data as Prisma.ProductUpdateInput });
    invalidateStorefrontProductCaches();
    return this.findById(id);
  }

  /**
   * Atomic admin save: product fields + variant metadata/stock + image delete/upload/reorder
   * in one DB transaction. Image files are written to disk first; orphans are cleaned on TX failure.
   */
  async adminSave(
    productId: string,
    payload: AdminSavePayload,
    files: Express.Multer.File[],
  ) {
    const exists = await prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: { id: true },
    });
    if (!exists) throw new ApiError(404, 'Product not found');

    const productData: Record<string, unknown> = { ...payload.product };
    if ('productDetails' in productData) {
      const raw = productData.productDetails;
      productData.productDetails =
        typeof raw === 'string' && raw.trim() ? raw.trim() : null;
    }
    if (productData.categoryId) {
      const category = await prisma.category.findFirst({
        where: { id: productData.categoryId as string, deletedAt: null },
      });
      if (!category) throw new ApiError(404, 'Category not found');
    }
    if (productData.name) {
      const slug = slugify(productData.name as string);
      const existing = await prisma.product.findFirst({
        where: { slug, id: { not: productId } },
      });
      if (!existing) productData.slug = slug;
    }

    const filesByColor = new Map<string, Express.Multer.File[]>();
    for (const file of files) {
      const match = /^color_([0-9a-f-]{36})$/i.exec(file.fieldname);
      if (!match) {
        throw new ApiError(400, `Unexpected file field "${file.fieldname}"`);
      }
      const colorId = match[1];
      const list = filesByColor.get(colorId) ?? [];
      list.push(file);
      filesByColor.set(colorId, list);
    }

    type PreparedColor = {
      id: string;
      name?: string;
      hexCode?: string;
      isActive?: boolean;
      availableStock?: number;
      deleteImageIds: string[];
      orderedImageRefs?: Array<string | 'new'>;
      uploads: Array<{ url: string; publicId: string }>;
    };

    const prepared: PreparedColor[] = [];
    const uploadedPublicIds: string[] = [];

    try {
      // Validate colors first (DB only), then upload all new images in one parallel batch
      const colorRows = await Promise.all(
        payload.colors.map(async (colorPayload) => {
          const color = await prisma.productColor.findFirst({
            where: { id: colorPayload.id, productId, deletedAt: null },
            include: { images: { where: { deletedAt: null } } },
          });
          if (!color) throw new ApiError(404, `Variant not found: ${colorPayload.id}`);
          return { colorPayload, color };
        }),
      );

      for (const { colorPayload, color } of colorRows) {
        const deleteImageIds = colorPayload.deleteImageIds ?? [];
        const orderedImageRefs = colorPayload.orderedImageRefs;
        const colorFiles = filesByColor.get(colorPayload.id) ?? [];

        if (orderedImageRefs === undefined && colorFiles.length > 0) {
          throw new ApiError(400, 'Image files require orderedImageRefs');
        }

        if (orderedImageRefs !== undefined) {
          const newSlotCount = orderedImageRefs.filter((ref) => ref === 'new').length;
          if (newSlotCount !== colorFiles.length) {
            throw new ApiError(
              400,
              `Variant ${color.name}: expected ${newSlotCount} new image(s), got ${colorFiles.length}`,
            );
          }

          const existingIds = new Set(color.images.map((img) => img.id));
          const deleteSet = new Set(deleteImageIds);
          for (const imageId of deleteImageIds) {
            if (!existingIds.has(imageId)) {
              throw new ApiError(400, 'One or more images to delete are invalid for this variant');
            }
          }

          for (const ref of orderedImageRefs) {
            if (ref === 'new') continue;
            if (!existingIds.has(ref) || deleteSet.has(ref)) {
              throw new ApiError(400, 'One or more ordered images are invalid for this variant');
            }
          }

          const remainingExisting = color.images.filter((img) => !deleteSet.has(img.id)).length;
          if (remainingExisting + newSlotCount > 6) {
            throw new ApiError(400, `Maximum 6 images per color. Variant: ${color.name}`);
          }
        } else if (deleteImageIds.length > 0) {
          const existingIds = new Set(color.images.map((img) => img.id));
          for (const imageId of deleteImageIds) {
            if (!existingIds.has(imageId)) {
              throw new ApiError(400, 'One or more images to delete are invalid for this variant');
            }
          }
        }

        prepared.push({
          id: colorPayload.id,
          name: colorPayload.name,
          hexCode: colorPayload.hexCode,
          isActive: colorPayload.isActive,
          availableStock: colorPayload.availableStock,
          deleteImageIds,
          orderedImageRefs,
          uploads: [],
        });
      }

      for (const colorId of filesByColor.keys()) {
        if (!prepared.some((c) => c.id === colorId)) {
          throw new ApiError(400, `Files provided for unknown variant ${colorId}`);
        }
      }

      await Promise.all(
        prepared.map(async (colorSave) => {
          const colorFiles = filesByColor.get(colorSave.id) ?? [];
          if (colorFiles.length === 0) return;
          const uploads = await localStorageService.uploadMultiple(
            colorFiles,
            `products/${productId}/${colorSave.id.slice(0, 8)}`,
          );
          uploadedPublicIds.push(...uploads.map((u) => u.publicId));
          colorSave.uploads = uploads;
        }),
      );

      const publicIdsToDeleteAfter = await prisma.$transaction(async (tx) => {
        const imagesToCleanup: string[] = [];

        if (Object.keys(productData).length > 0) {
          await tx.product.update({
            where: { id: productId },
            data: productData as Prisma.ProductUpdateInput,
          });
        }

        for (const colorSave of prepared) {
          const colorRow = await tx.productColor.findFirst({
            where: { id: colorSave.id, productId, deletedAt: null },
            include: {
              inventory: { where: { deletedAt: null } },
              images: { where: { deletedAt: null } },
            },
          });
          if (!colorRow) throw new ApiError(404, 'Variant not found');

          const colorUpdate: Prisma.ProductColorUpdateInput = {};
          if (colorSave.name !== undefined) colorUpdate.name = colorSave.name;
          if (colorSave.hexCode !== undefined) colorUpdate.hexCode = colorSave.hexCode;
          if (colorSave.isActive !== undefined) colorUpdate.isActive = colorSave.isActive;
          if (Object.keys(colorUpdate).length > 0) {
            await tx.productColor.update({
              where: { id: colorSave.id },
              data: colorUpdate,
            });
          }

          if (colorSave.availableStock !== undefined) {
            const inventory = colorRow.inventory[0];
            if (!inventory) {
              await tx.inventory.create({
                data: {
                  productId,
                  productColorId: colorSave.id,
                  quantity: colorSave.availableStock,
                },
              });
            } else {
              const previousQty = inventory.quantity;
              const quantity = colorSave.availableStock + inventory.reserved;
              const inv = await tx.inventory.update({
                where: { id: inventory.id },
                data: { quantity },
              });
              if (quantity !== previousQty) {
                await tx.inventoryHistory.create({
                  data: {
                    inventoryId: inv.id,
                    changeType: quantity > previousQty ? 'IN' : 'OUT',
                    quantity: Math.abs(quantity - previousQty),
                    previousQty,
                    newQty: quantity,
                    reason: 'Admin stock update',
                  },
                });
              }
            }
          }

          if (colorSave.deleteImageIds.length > 0) {
            const toDelete = colorRow.images.filter((img) =>
              colorSave.deleteImageIds.includes(img.id),
            );
            imagesToCleanup.push(
              ...toDelete.map((img) => img.publicId).filter(Boolean),
            );
            await tx.productImage.updateMany({
              where: { id: { in: colorSave.deleteImageIds }, productColorId: colorSave.id },
              data: { deletedAt: new Date() },
            });
          }

          const createdIds: string[] = [];
          if (colorSave.uploads.length > 0) {
            for (const upload of colorSave.uploads) {
              const created = await tx.productImage.create({
                data: {
                  productColorId: colorSave.id,
                  url: upload.url,
                  publicId: upload.publicId,
                  sortOrder: 999,
                  isDefault: false,
                },
              });
              createdIds.push(created.id);
            }
          }

          if (colorSave.orderedImageRefs !== undefined) {
            let newIndex = 0;
            const orderedIds = colorSave.orderedImageRefs.map((ref) => {
              if (ref === 'new') {
                const id = createdIds[newIndex++];
                if (!id) throw new ApiError(500, 'Image upload mapping failed');
                return id;
              }
              return ref;
            });

            await Promise.all(
              orderedIds.map((imageId, index) =>
                tx.productImage.update({
                  where: { id: imageId },
                  data: { sortOrder: index, isDefault: index === 0 },
                }),
              ),
            );
          }
        }

        return imagesToCleanup;
      }, PRISMA_TX_OPTIONS);

      // Don't block the save response on deleting replaced image files
      if (publicIdsToDeleteAfter.length > 0) {
        void localStorageService.deleteMultiple(publicIdsToDeleteAfter).catch(() => undefined);
      }
    } catch (error) {
      if (uploadedPublicIds.length > 0) {
        void localStorageService.deleteMultiple(uploadedPublicIds).catch(() => undefined);
      }
      throw error;
    }

    invalidateStorefrontProductCaches();
    return this.findById(productId);
  }

  async updateBaseSoldCount(id: string, baseSoldCount: number) {
    await this.findById(id, true);
    await prisma.product.update({
      where: { id },
      data: { baseSoldCount },
    });
    invalidateStorefrontProductCaches();
    return this.findById(id);
  }

  /**
   * Permanently remove a product from the database when it has no order history.
   * Products referenced by past orders are soft-deleted (hidden) so order records stay valid.
   */
  async softDelete(id: string): Promise<{ permanentlyDeleted: boolean }> {
    const product = await prisma.product.findFirst({
      where: { id, deletedAt: null },
      include: {
        colors: {
          include: { images: { select: { publicId: true } } },
        },
        inventory: { select: { id: true } },
        _count: { select: { orderItems: true } },
      },
    });
    if (!product) throw new ApiError(404, 'Product not found');

    if (product._count.orderItems > 0) {
      await prisma.product.update({
        where: { id },
        data: { deletedAt: new Date(), isActive: false },
      });
      invalidateStorefrontProductCaches();
      return { permanentlyDeleted: false };
    }

    const publicIds = product.colors.flatMap((color) =>
      color.images.map((image) => image.publicId).filter(Boolean),
    );
    for (const publicId of publicIds) {
      try {
        await localStorageService.deleteImage(publicId);
      } catch {
        // Continue even if image file cleanup fails
      }
    }

    const inventoryIds = product.inventory.map((row) => row.id);
    await prisma.$transaction(async (tx) => {
      if (inventoryIds.length > 0) {
        await tx.inventoryHistory.deleteMany({ where: { inventoryId: { in: inventoryIds } } });
        await tx.inventory.deleteMany({ where: { productId: id } });
      }
      await tx.customerReview.updateMany({
        where: { productId: id },
        data: { productId: null },
      });
      // ProductColor / ProductImage cascade from Product
      await tx.product.delete({ where: { id } });
    });

    invalidateStorefrontProductCaches();
    return { permanentlyDeleted: true };
  }

  async addColor(
    productId: string,
    data: { name: string; hexCode?: string; sortOrder?: number; stock: number; isActive?: boolean },
  ) {
    await this.findById(productId);

    const maxSort = await prisma.productColor.aggregate({
      where: { productId, deletedAt: null },
      _max: { sortOrder: true },
    });

    await prisma.$transaction(async (tx) => {
      const productColor = await tx.productColor.create({
        data: {
          productId,
          name: data.name,
          hexCode: data.hexCode,
          sortOrder: data.sortOrder ?? (maxSort._max.sortOrder ?? -1) + 1,
          isActive: data.isActive ?? true,
        },
      });

      await tx.inventory.create({
        data: {
          productId,
          productColorId: productColor.id,
          quantity: data.stock,
        },
      });
    });

    invalidateStorefrontProductCaches();
    return this.findById(productId);
  }

  /**
   * Atomic add-variant: color + inventory + images in one DB transaction.
   * Image files use fieldname `images`.
   */
  async adminAddColor(
    productId: string,
    data: AdminAddColorPayload,
    files: Express.Multer.File[],
  ) {
    await this.findById(productId);

    const imageFiles = files.filter((f) => f.fieldname === 'images');
    if (files.some((f) => f.fieldname !== 'images')) {
      throw new ApiError(400, 'Unexpected file field; use "images"');
    }
    if (imageFiles.length > 6) {
      throw new ApiError(400, 'Maximum 6 images per color');
    }

    const maxSort = await prisma.productColor.aggregate({
      where: { productId, deletedAt: null },
      _max: { sortOrder: true },
    });

    const uploadedPublicIds: string[] = [];

    try {
      const uploads =
        imageFiles.length > 0
          ? await localStorageService.uploadMultiple(imageFiles, `products/${productId}`)
          : [];
      uploadedPublicIds.push(...uploads.map((u) => u.publicId));

      await prisma.$transaction(async (tx) => {
        const productColor = await tx.productColor.create({
          data: {
            productId,
            name: data.name,
            hexCode: data.hexCode,
            sortOrder: data.sortOrder ?? (maxSort._max.sortOrder ?? -1) + 1,
            isActive: data.isActive ?? true,
          },
        });

        await tx.inventory.create({
          data: {
            productId,
            productColorId: productColor.id,
            quantity: data.stock,
          },
        });

        for (const [imgIndex, upload] of uploads.entries()) {
          await tx.productImage.create({
            data: {
              productColorId: productColor.id,
              url: upload.url,
              publicId: upload.publicId,
              sortOrder: imgIndex,
              isDefault: imgIndex === 0,
            },
          });
        }
      }, PRISMA_TX_OPTIONS);

      invalidateStorefrontProductCaches();
      return this.findById(productId);
    } catch (error) {
      for (const publicId of uploadedPublicIds) {
        try {
          await localStorageService.deleteImage(publicId);
        } catch {
          // Best-effort orphan cleanup
        }
      }
      throw error;
    }
  }

  async updateColor(
    colorId: string,
    data: { name?: string; hexCode?: string; sortOrder?: number; isActive?: boolean },
  ) {
    const color = await prisma.productColor.findFirst({
      where: { id: colorId, deletedAt: null },
    });
    if (!color) throw new ApiError(404, 'Color not found');

    await prisma.productColor.update({
      where: { id: colorId },
      data,
    });

    invalidateStorefrontProductCaches();
    return this.findById(color.productId);
  }

  async uploadColorImages(
    productColorId: string,
    files: Express.Multer.File[],
  ) {
    const color = await prisma.productColor.findFirst({
      where: { id: productColorId, deletedAt: null },
      include: { images: { where: { deletedAt: null } } },
    });

    if (!color) throw new ApiError(404, 'Product color not found');

    const currentCount = color.images.length;
    if (currentCount + files.length > 6) {
      throw new ApiError(400, `Maximum 6 images per color. Current: ${currentCount}`);
    }

    const uploads = await localStorageService.uploadMultiple(files, `products/${color.productId}`);

    const images = await prisma.$transaction(
      uploads.map((upload, index) =>
        prisma.productImage.create({
          data: {
            productColorId,
            url: upload.url,
            publicId: upload.publicId,
            sortOrder: currentCount + index,
            isDefault: currentCount === 0 && index === 0,
          },
        }),
      ),
    );

    invalidateStorefrontProductCaches();
    return images;
  }

  async deleteImage(imageId: string) {
    const image = await prisma.productImage.findFirst({
      where: { id: imageId, deletedAt: null },
    });
    if (!image) throw new ApiError(404, 'Image not found');

    await localStorageService.deleteImage(image.publicId);
    await prisma.productImage.update({
      where: { id: imageId },
      data: { deletedAt: new Date() },
    });

    invalidateStorefrontProductCaches();
  }

  async reorderColorImages(colorId: string, orderedIds: string[]) {
    const color = await prisma.productColor.findFirst({
      where: { id: colorId, deletedAt: null },
    });
    if (!color) throw new ApiError(404, 'Color not found');

    const images = await prisma.productImage.findMany({
      where: {
        productColorId: colorId,
        deletedAt: null,
        id: { in: orderedIds },
      },
    });

    if (images.length !== orderedIds.length) {
      throw new ApiError(400, 'One or more images are invalid for this variant');
    }

    await prisma.$transaction(
      orderedIds.map((imageId, index) =>
        prisma.productImage.update({
          where: { id: imageId },
          data: { sortOrder: index, isDefault: index === 0 },
        }),
      ),
    );

    invalidateStorefrontProductCaches();
  }

  async getLatestByCategory(limit = 5) {
    const cap = Math.min(Math.max(limit, 1), 10);
    return withCache(`products:latest-by-category:${cap}`, STORE_CACHE_TTL_MS, async () => {
      const categories = await prisma.category.findMany({
        where: { isActive: true, deletedAt: null },
        orderBy: { sortOrder: 'asc' },
        select: { id: true, name: true, slug: true, imageUrl: true },
      });

      if (categories.length === 0) return [];

      const categoryIds = categories.map((category) => category.id);
      const products = await prisma.product.findMany({
        where: {
          categoryId: { in: categoryIds },
          isActive: true,
          deletedAt: null,
        },
        include: productListInclude,
        orderBy: { createdAt: 'desc' },
      });

      const byCategory = new Map<string, ReturnType<typeof this.formatListProduct>[]>();
      for (const product of products) {
        const formatted = this.formatListProduct(product);
        const bucket = byCategory.get(product.categoryId) ?? [];
        if (bucket.length < cap) {
          bucket.push(formatted);
          byCategory.set(product.categoryId, bucket);
        }
      }

      return categories
        .map((category) => ({
          category,
          products: byCategory.get(category.id) ?? [],
        }))
        .filter((entry) => entry.products.length > 0);
    });
  }

  async getRelated(productId: string, limit = 4) {
    const cap = Math.min(Math.max(limit, 1), 8);
    return withCache(`product:related:${productId}:${cap}`, STORE_CACHE_TTL_MS, async () => {
      const product = await prisma.product.findFirst({
        where: { id: productId },
        select: { id: true, categoryId: true },
      });
      if (!product) throw new ApiError(404, 'Product not found');
      return this.fetchRelatedProducts(product.id, product.categoryId, cap);
    });
  }

  private async fetchRelatedProducts(
    productId: string,
    categoryId: string,
    limit: number,
  ) {
    const cap = Math.min(Math.max(limit, 1), 8);

    const sameCategory = await prisma.product.findMany({
      where: {
        id: { not: productId },
        categoryId,
        isActive: true,
        deletedAt: null,
      },
      include: relatedListInclude,
      take: cap,
      orderBy: [{ isFeatured: 'desc' }, { soldCount: 'desc' }, { createdAt: 'desc' }],
    });

    if (sameCategory.length >= cap) {
      return sameCategory.map(this.formatListProduct);
    }

    const remaining = cap - sameCategory.length;
    const excludeIds = [productId, ...sameCategory.map((p) => p.id)];

    const others = await prisma.product.findMany({
      where: {
        id: { notIn: excludeIds },
        isActive: true,
        deletedAt: null,
      },
      include: relatedListInclude,
      take: remaining,
      orderBy: [{ isFeatured: 'desc' }, { soldCount: 'desc' }, { createdAt: 'desc' }],
    });

    return [...sameCategory, ...others].map(this.formatListProduct);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private formatAdminListProduct(product: any) {
    const defaultColor = product.colors?.[0];
    const defaultImage = defaultColor?.images?.[0]?.url || null;

    const totalStock =
      product.colors?.reduce(
        (sum: number, color: { inventory: Array<{ quantity: number; reserved: number }> }) => {
          const available = color.inventory?.reduce(
            (colorSum: number, inv: { quantity: number; reserved: number }) =>
              colorSum + (inv.quantity - inv.reserved),
            0,
          );
          return sum + (available ?? 0);
        },
        0,
      ) ?? 0;

    return {
      id: product.id,
      name: product.name,
      slug: product.slug,
      sku: product.sku,
      categoryId: product.categoryId,
      price: Number(product.price),
      mrp: Number(product.mrp),
      isActive: product.isActive,
      isComingSoon: product.isComingSoon,
      isFeatured: product.isFeatured,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
      category: product.category,
      defaultImage,
      totalStock,
      baseSoldCount: product.baseSoldCount ?? 0,
      soldCount: product.soldCount ?? 0,
      displaySoldCount: (product.baseSoldCount ?? 0) + (product.soldCount ?? 0),
      isOutOfStock: totalStock <= 0,
      effectivePrice: Number(product.price),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private formatListProduct(product: any) {
    const defaultColor = product.colors?.[0];
    const defaultImage = defaultColor?.images?.[0]?.url || null;

    const totalStock =
      product.colors?.reduce(
        (sum: number, color: { inventory: Array<{ quantity: number; reserved: number }> }) => {
          const inv = color.inventory?.[0];
          return sum + (inv ? inv.quantity - inv.reserved : 0);
        },
        0,
      ) ?? 0;

    const isOutOfStock =
      !product.colors?.length ||
      product.colors.every((color: { inventory: Array<{ quantity: number; reserved: number }> }) => {
        const inv = color.inventory?.[0];
        return !inv || inv.quantity - inv.reserved <= 0;
      });

    return {
      id: product.id,
      name: product.name,
      slug: product.slug,
      sku: product.sku,
      categoryId: product.categoryId,
      category: product.category,
      description: '',
      price: Number(product.price),
      mrp: Number(product.mrp),
      discount: Number(product.discount ?? 0),
      effectivePrice: Number(product.price),
      isComingSoon: product.isComingSoon ?? false,
      isFeatured: product.isFeatured ?? false,
      isActive: product.isActive,
      baseSoldCount: product.baseSoldCount,
      soldCount: product.soldCount,
      displaySoldCount: product.baseSoldCount + product.soldCount,
      defaultImage,
      totalStock,
      isOutOfStock,
      colors: [] as [],
      tags: [] as string[],
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private formatProduct(product: any) {
    const defaultColor = product.colors?.[0];
    const defaultImage = defaultColor?.images?.[0]?.url || null;

    const totalStock = product.colors?.reduce((sum: number, color: { inventory: Array<{ quantity: number; reserved: number }> }) => {
      const inv = color.inventory?.[0];
      return sum + (inv ? inv.quantity - inv.reserved : 0);
    }, 0) ?? 0;

    const displaySoldCount = product.baseSoldCount + product.soldCount;
    const isOutOfStock =
      !product.colors?.length ||
      product.colors.every((color: { inventory: Array<{ quantity: number; reserved: number }> }) => {
        const inv = color.inventory?.[0];
        return !inv || inv.quantity - inv.reserved <= 0;
      });

    return {
      ...product,
      defaultImage,
      totalStock,
      displaySoldCount,
      isOutOfStock,
      effectivePrice: Number(product.price),
      colors: product.colors?.map((color: {
        id: string;
        name: string;
        hexCode: string | null;
        sortOrder: number;
        images: Array<{ id: string; url: string; altText: string | null; sortOrder: number; isDefault: boolean }>;
        inventory: Array<{ id: string; quantity: number; reserved: number; lowStockAlert: number }>;
      }) => {
        const inv = color.inventory?.[0];
        const { inventory: _inventory, ...colorFields } = color;
        return {
          ...colorFields,
          inventoryId: inv?.id,
          quantity: inv?.quantity ?? 0,
          reserved: inv?.reserved ?? 0,
          availableStock: inv ? inv.quantity - inv.reserved : 0,
          images: color.images?.map((img: { url: string }) => ({
            ...img,
            highResUrl: img.url,
            url: img.url,
          })),
        };
      }),
    };
  }
}

export const productService = new ProductService();
