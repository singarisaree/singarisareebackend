-- AlterTable
ALTER TABLE "order_items" ADD COLUMN "weight" DECIMAL(8,3),
ADD COLUMN "length" DECIMAL(8,2),
ADD COLUMN "width" DECIMAL(8,2),
ADD COLUMN "height" DECIMAL(8,2);

-- Backfill from product catalog where available
UPDATE "order_items" oi
SET
  "weight" = p."weight",
  "length" = p."length",
  "width" = p."width",
  "height" = p."height"
FROM "products" p
WHERE oi."product_id" = p."id"
  AND (oi."weight" IS NULL OR oi."length" IS NULL OR oi."width" IS NULL OR oi."height" IS NULL);
