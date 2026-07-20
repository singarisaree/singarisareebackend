import { Prisma } from '@prisma/client';
import { prisma, PRISMA_TX_OPTIONS } from '@/config/database';

const RETRYABLE_TX_CODES = new Set(['P2028', 'P2034']);

export async function runPrismaTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await prisma.$transaction(fn, PRISMA_TX_OPTIONS);
    } catch (error) {
      const code =
        error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined;
      const shouldRetry = code && RETRYABLE_TX_CODES.has(code) && attempt < maxAttempts;
      if (!shouldRetry) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
    }
  }

  throw new Error('Transaction failed after retries');
}
