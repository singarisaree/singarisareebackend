import { createServer } from 'http';
import { createApp } from './app';
import { env } from '@/config/env';
import { logger } from '@/utils/logger';
import { prisma } from '@/config/database';
import { categoryService } from '@/modules/categories/category.service';
import { productService } from '@/modules/products/product.service';
import { settingsService } from '@/modules/settings/settings.service';
import { initSocketServer } from '@/realtime/socket-server';
import { shippingService } from '@/modules/dashboard/dashboard.service';
import { emailMarketingService } from '@/modules/email-marketing/email-marketing.service';
import { whatsAppOutboxService } from '@/modules/whatsapp-outbox/whatsapp-outbox.service';
import { localStorageService } from '@/integrations/local-storage.service';

const app = createApp();
const httpServer = createServer(app);
initSocketServer(httpServer);

const SHIPROCKET_CANCEL_SYNC_INTERVAL_MS = 2 * 60 * 1000;

async function warmInBatches<T>(
  items: T[],
  worker: (item: T) => Promise<unknown>,
  batchSize = 3,
): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    await Promise.all(items.slice(i, i + batchSize).map(worker));
  }
}

async function warmStorefrontCache(): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    await Promise.all([
      categoryService.findAll(true),
      settingsService.getPublicSettings(),
      productService.findStorefrontList({ limit: '20' }),
    ]);

    const [hotProductSlugs, hotCategorySlugs] = await Promise.all([
      prisma.product.findMany({
        where: { isActive: true, deletedAt: null },
        orderBy: [{ soldCount: 'desc' }, { createdAt: 'desc' }],
        take: 8,
        select: { slug: true },
      }),
      prisma.category.findMany({
        where: { isActive: true, deletedAt: null },
        orderBy: { sortOrder: 'asc' },
        take: 5,
        select: { slug: true },
      }),
    ]);

    await warmInBatches(hotProductSlugs, ({ slug }) => productService.findBySlugStorefront(slug));
    await warmInBatches(hotCategorySlugs, ({ slug }) => categoryService.getStorefrontPage(slug));
    logger.info('Storefront cache warmed');
  } catch (err) {
    logger.warn('Storefront cache warmup skipped', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const server = httpServer.listen(env.PORT, () => {
  logger.info(`Singari Sarees API running on port ${env.PORT}`, {
    environment: env.NODE_ENV,
    apiVersion: env.API_VERSION,
  });
  void localStorageService
    .ensureBaseFolders()
    .catch((err) =>
      logger.error('Failed to create upload folders', {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  void warmStorefrontCache();
  void emailMarketingService.resumePendingCampaigns();
  whatsAppOutboxService.resumePendingEvents();
  // Auto-sync Shiprocket cancel + forward tracking → live admin/customer status
  shippingService.scheduleShiprocketCancellationSync();
  setInterval(() => {
    shippingService.scheduleShiprocketCancellationSync();
  }, SHIPROCKET_CANCEL_SYNC_INTERVAL_MS);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => process.exit(0));
});

process.on('unhandledRejection', (reason: Error) => {
  logger.error('Unhandled rejection', { error: reason.message, stack: reason.stack });
});

export default app;
