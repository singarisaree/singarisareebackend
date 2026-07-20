-- Admin order list: deletedAt + createdAt / status filters
CREATE INDEX IF NOT EXISTS "orders_deleted_at_created_at_idx" ON "orders"("deleted_at", "created_at");
CREATE INDEX IF NOT EXISTS "orders_deleted_at_status_created_at_idx" ON "orders"("deleted_at", "status", "created_at");

-- Payment relation filters on PLACED / PAYMENT_PENDING / REFUNDED tabs
CREATE INDEX IF NOT EXISTS "payments_order_id_status_idx" ON "payments"("order_id", "status");
