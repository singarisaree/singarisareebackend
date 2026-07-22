-- Optional bullet-point product details (one point per line)
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "product_details" TEXT;
