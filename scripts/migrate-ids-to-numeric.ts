/**
 * One-time migration: convert legacy alphanumeric order numbers and SKUs to numeric IDs.
 * Uses random 8-digit numbers (same as new orders/products), not sequential counters.
 *
 * Usage:
 *   npm run migrate:ids:numeric          # apply
 *   npm run migrate:ids:numeric -- --dry-run
 */
import { PrismaClient } from '@prisma/client';
import { generateOrderNumber, generateSku } from '../src/utils/helpers';

const prisma = new PrismaClient();

function isNumericId(value: string): boolean {
  return /^\d+$/.test(value.trim());
}

function allocateUniqueRandom(
  used: Set<string>,
  generate: () => string,
  maxAttempts = 32,
): string {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const value = generate();
    if (!used.has(value)) {
      used.add(value);
      return value;
    }
  }
  throw new Error('Failed to allocate unique numeric ID');
}

async function migrateProductSkus(dryRun: boolean) {
  const products = await prisma.product.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true, sku: true, name: true },
  });

  const usedSkus = new Set(
    products.filter((product) => isNumericId(product.sku)).map((product) => product.sku.trim()),
  );

  let migrated = 0;
  let skipped = 0;

  for (const product of products) {
    if (isNumericId(product.sku)) {
      skipped += 1;
      continue;
    }

    const newSku = allocateUniqueRandom(usedSkus, generateSku);
    console.log(`SKU  ${product.sku} -> ${newSku}  (${product.name})`);

    if (!dryRun) {
      await prisma.$transaction([
        prisma.product.update({
          where: { id: product.id },
          data: { sku: newSku },
        }),
        prisma.orderItem.updateMany({
          where: { productId: product.id },
          data: { sku: newSku },
        }),
      ]);
    }

    migrated += 1;
  }

  return { migrated, skipped, total: products.length };
}

async function migrateOrderNumbers(dryRun: boolean) {
  const orders = await prisma.order.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true, orderNumber: true, customerName: true },
  });

  const usedNumbers = new Set(
    orders
      .filter((order) => isNumericId(order.orderNumber))
      .map((order) => order.orderNumber.trim()),
  );

  let migrated = 0;
  let skipped = 0;

  for (const order of orders) {
    if (isNumericId(order.orderNumber)) {
      skipped += 1;
      continue;
    }

    const newOrderNumber = allocateUniqueRandom(usedNumbers, generateOrderNumber);
    console.log(
      `Order ${order.orderNumber} -> ${newOrderNumber}  (${order.customerName || 'customer'})`,
    );

    if (!dryRun) {
      await prisma.order.update({
        where: { id: order.id },
        data: { orderNumber: newOrderNumber },
      });
    }

    migrated += 1;
  }

  return { migrated, skipped, total: orders.length };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  console.log(
    dryRun
      ? '==> Dry run (no database writes)'
      : '==> Applying random numeric ID migration',
  );

  const skuResult = await migrateProductSkus(dryRun);
  console.log(
    `Products: ${skuResult.migrated} migrated, ${skuResult.skipped} already numeric, ${skuResult.total} total`,
  );

  const orderResult = await migrateOrderNumbers(dryRun);
  console.log(
    `Orders: ${orderResult.migrated} migrated, ${orderResult.skipped} already numeric, ${orderResult.total} total`,
  );

  if (dryRun) {
    console.log('Dry run complete. Re-run without --dry-run to apply changes.');
  } else {
    console.log('Migration complete.');
  }
}

main()
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
