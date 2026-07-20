-- Coupon phone-linked refund fields
ALTER TABLE "coupons" ADD COLUMN IF NOT EXISTS "allowed_phone" TEXT;
ALTER TABLE "coupons" ADD COLUMN IF NOT EXISTS "source_order_id" UUID;
ALTER TABLE "coupons" ADD COLUMN IF NOT EXISTS "is_refund_coupon" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "coupons_allowed_phone_idx" ON "coupons"("allowed_phone");

-- Order refund coupon audit
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "refund_coupon_id" UUID;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "refund_coupon_code" TEXT;

-- Return request coupon + items
ALTER TABLE "return_requests" ADD COLUMN IF NOT EXISTS "refund_coupon_id" UUID;
ALTER TABLE "return_requests" ADD COLUMN IF NOT EXISTS "refund_coupon_code" TEXT;

CREATE TABLE IF NOT EXISTS "return_request_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "return_request_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "return_request_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "return_request_items_return_request_id_order_item_id_key"
  ON "return_request_items"("return_request_id", "order_item_id");
CREATE INDEX IF NOT EXISTS "return_request_items_return_request_id_idx" ON "return_request_items"("return_request_id");
CREATE INDEX IF NOT EXISTS "return_request_items_order_item_id_idx" ON "return_request_items"("order_item_id");

DO $$ BEGIN
  ALTER TABLE "coupons" ADD CONSTRAINT "coupons_source_order_id_fkey"
    FOREIGN KEY ("source_order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "orders" ADD CONSTRAINT "orders_refund_coupon_id_fkey"
    FOREIGN KEY ("refund_coupon_id") REFERENCES "coupons"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_refund_coupon_id_fkey"
    FOREIGN KEY ("refund_coupon_id") REFERENCES "coupons"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "return_request_items" ADD CONSTRAINT "return_request_items_return_request_id_fkey"
    FOREIGN KEY ("return_request_id") REFERENCES "return_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "return_request_items" ADD CONSTRAINT "return_request_items_order_item_id_fkey"
    FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
