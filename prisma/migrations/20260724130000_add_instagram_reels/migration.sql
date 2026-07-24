-- CreateTable
CREATE TABLE IF NOT EXISTS "instagram_reels" (
    "id" UUID NOT NULL,
    "video_url" VARCHAR(500) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "instagram_reels_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "instagram_reels_is_active_deleted_at_idx" ON "instagram_reels"("is_active", "deleted_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "instagram_reels_sort_order_idx" ON "instagram_reels"("sort_order");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "instagram_reels_created_at_idx" ON "instagram_reels"("created_at");
