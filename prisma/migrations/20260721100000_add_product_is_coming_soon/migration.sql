-- Add missing is_coming_soon flag used by product create/update flows
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "is_coming_soon" BOOLEAN NOT NULL DEFAULT false;
