-- AlterTable
ALTER TABLE "orders" ADD COLUMN "package_length" DECIMAL(8,2),
ADD COLUMN "package_width" DECIMAL(8,2),
ADD COLUMN "package_height" DECIMAL(8,2);

-- Backfill package dimensions from order items (max L/W, stacked height)
UPDATE "orders" o
SET
  "package_length" = agg.max_length,
  "package_width" = agg.max_width,
  "package_height" = agg.total_height
FROM (
  SELECT
    oi."order_id",
    MAX(oi."length") AS max_length,
    MAX(oi."width") AS max_width,
    SUM(COALESCE(oi."height", 0) * oi."quantity") AS total_height
  FROM "order_items" oi
  GROUP BY oi."order_id"
) agg
WHERE o."id" = agg."order_id";
