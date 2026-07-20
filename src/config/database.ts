import { PrismaClient } from '@prisma/client';
import { logger } from '@/utils/logger';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? [{ emit: 'stdout', level: 'error' }]
        : [{ emit: 'stdout', level: 'error' }],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/** Neon/serverless DBs can exceed Prisma's default 5s interactive transaction limit. */
export const PRISMA_TX_OPTIONS = {
  maxWait: 15_000,
  timeout: 30_000,
} as const;

prisma.$connect().catch((err: Error) => {
  logger.error('Failed to connect to database', { error: err.message });
  process.exit(1);
});

export default prisma;
