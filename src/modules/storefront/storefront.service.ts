import { categoryService } from '@/modules/categories/category.service';
import { productService } from '@/modules/products/product.service';
import { heroBannerService } from '@/modules/hero-banners/hero-banner.service';
import { settingsService } from '@/modules/settings/settings.service';
import { STORE_CACHE_TTL_MS, withCache } from '@/utils/memory-cache';

export class StorefrontService {
  async getHomepage() {
    return withCache('storefront:homepage', STORE_CACHE_TTL_MS, async () => {
      const [banners, categories, productsResult, settings] = await Promise.all([
        heroBannerService.findActive(),
        categoryService.findAll(true),
        productService.findStorefrontList({ limit: '10', sortBy: 'createdAt', sortOrder: 'desc' }),
        settingsService.getPublicSettings(),
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
        categoryService.findAll(true),
        productService.findStorefrontList({ limit: '50' }),
      ]);

      return {
        categories,
        products: productsResult.products,
      };
    });
  }
}

export const storefrontService = new StorefrontService();
