-- Bootstrap customer + marketing tables (missing from earlier migrations on fresh installs).
-- Safe on existing databases: uses IF NOT EXISTS and exception handlers.

DO $$ BEGIN
  CREATE TYPE "CustomerSource" AS ENUM ('ORDER', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "MarketingMessageStatus" AS ENUM ('SENT', 'FAILED', 'SKIPPED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "customers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "source" "CustomerSource" NOT NULL DEFAULT 'MANUAL',
    "notes" TEXT,
    "allow_marketing" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),
    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "customers_phone_key" ON "customers"("phone");
CREATE INDEX IF NOT EXISTS "customers_phone_idx" ON "customers"("phone");
CREATE INDEX IF NOT EXISTS "customers_deleted_at_idx" ON "customers"("deleted_at");
CREATE INDEX IF NOT EXISTS "customers_source_idx" ON "customers"("source");

CREATE TABLE IF NOT EXISTS "marketing_campaigns" (
    "id" UUID NOT NULL,
    "template_key" TEXT NOT NULL,
    "heading" TEXT NOT NULL,
    "story" TEXT NOT NULL,
    "image_url" TEXT,
    "recipient_count" INTEGER NOT NULL DEFAULT 0,
    "sent_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_admin_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "marketing_campaigns_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "marketing_campaigns_created_at_idx" ON "marketing_campaigns"("created_at");

DO $$ BEGIN
  ALTER TABLE "marketing_campaigns"
    ADD CONSTRAINT "marketing_campaigns_created_by_admin_id_fkey"
    FOREIGN KEY ("created_by_admin_id") REFERENCES "admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "marketing_message_logs" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "customer_id" UUID,
    "phone" TEXT NOT NULL,
    "customer_name" TEXT NOT NULL,
    "status" "MarketingMessageStatus" NOT NULL,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "marketing_message_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "marketing_message_logs_campaign_id_idx" ON "marketing_message_logs"("campaign_id");
CREATE INDEX IF NOT EXISTS "marketing_message_logs_customer_id_idx" ON "marketing_message_logs"("customer_id");
CREATE INDEX IF NOT EXISTS "marketing_message_logs_phone_idx" ON "marketing_message_logs"("phone");

DO $$ BEGIN
  ALTER TABLE "marketing_message_logs"
    ADD CONSTRAINT "marketing_message_logs_campaign_id_fkey"
    FOREIGN KEY ("campaign_id") REFERENCES "marketing_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "marketing_message_logs"
    ADD CONSTRAINT "marketing_message_logs_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Add VIP source
DO $$ BEGIN
  ALTER TYPE "CustomerSource" ADD VALUE IF NOT EXISTS 'VIP';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
