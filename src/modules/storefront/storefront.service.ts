import { categoryService } from '@/modules/categories/category.service';
import { productService } from '@/modules/products/product.service';
import { heroBannerService } from '@/modules/hero-banners/hero-banner.service';
import { settingsService } from '@/modules/settings/settings.service';
import { STORE_CACHE_TTL_MS, withCache } from '@/utils/memory-cache';
import { logger } from '@/utils/logger';

async function settle<T>(label: string, loader: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await loader();
  } catch (error) {
    logger.error(`Storefront homepage partial failure: ${label}`, {
      error: error instanceof Error ? error.message : error,
    });
    return fallback;
  }
}

export class StorefrontService {
  async getHomepage() {
    return withCache('storefront:homepage', STORE_CACHE_TTL_MS, async () => {
      const [banners, categories, productsResult, settings] = await Promise.all([
        settle('banners', () => heroBannerService.findActive(), []),
        settle('categories', () => categoryService.findAll(true), []),
        settle(
          'products',
          () =>
            productService.findStorefrontList({
              limit: '10',
              sortBy: 'createdAt',
              sortOrder: 'desc',
            }),
          { products: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0, hasNext: false, hasPrev: false } },
        ),
        settle('settings', () => settingsService.getPublicSettings(), {} as Record<string, unknown>),
      ]);

      return {
        banners,
        categories,
        products: productsResult.products,
        settings,
      };
    });
  }

  async getCollectionsPage() {
    return withCache('storefront:collections', STORE_CACHE_TTL_MS, async () => {
      const [categories, productsResult] = await Promise.all([
        settle('categories', () => categoryService.findAll(true), []),
        settle(
          'products',
          () => productService.findStorefrontList({ limit: '50' }),
          { products: [], meta: { page: 1, limit: 50, total: 0, totalPages: 0, hasNext: false, hasPrev: false } },
        ),
      ]);

      return {
        categories,
        products: productsResult.products,
      };
    });
  }
}

export const storefrontService = new StorefrontService();
