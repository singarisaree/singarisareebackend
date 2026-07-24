-- AlterTable: switch Instagram reels from embed URLs to uploaded video + Instagram link
ALTER TABLE "instagram_reels" ADD COLUMN IF NOT EXISTS "public_id" VARCHAR(500);
ALTER TABLE "instagram_reels" ADD COLUMN IF NOT EXISTS "instagram_url" VARCHAR(500);

-- Soft-delete legacy embed-only rows (no uploaded file)
UPDATE "instagram_reels"
SET
  "deleted_at" = COALESCE("deleted_at", CURRENT_TIMESTAMP),
  "is_active" = false
WHERE ("public_id" IS NULL OR "public_id" = '')
  AND "deleted_at" IS NULL;

-- Backfill required columns for any remaining rows, then enforce NOT NULL
UPDATE "instagram_reels"
SET
  "public_id" = COALESCE(NULLIF("public_id", ''), "video_url"),
  "instagram_url" = COALESCE(NULLIF("instagram_url", ''), "video_url")
WHERE "public_id" IS NULL OR "instagram_url" IS NULL OR "public_id" = '' OR "instagram_url" = '';

ALTER TABLE "instagram_reels" ALTER COLUMN "public_id" SET NOT NULL;
ALTER TABLE "instagram_reels" ALTER COLUMN "instagram_url" SET NOT NULL;
