-- CreateIndex
CREATE INDEX "products_created_at_idx" ON "products"("created_at");

-- CreateIndex
CREATE INDEX "products_category_id_is_active_deleted_at_idx" ON "products"("category_id", "is_active", "deleted_at");
