CREATE TYPE "EmailCampaignStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED');
CREATE TYPE "EmailDeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

CREATE TABLE "email_marketing_campaigns" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subject" TEXT NOT NULL,
    "heading" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "image_url" TEXT,
    "status" "EmailCampaignStatus" NOT NULL DEFAULT 'QUEUED',
    "recipient_count" INTEGER NOT NULL DEFAULT 0,
    "sent_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_admin_id" UUID,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_marketing_campaigns_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "email_marketing_recipients" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "campaign_id" UUID NOT NULL,
    "customer_id" UUID,
    "email" TEXT NOT NULL,
    "customer_name" TEXT NOT NULL,
    "status" "EmailDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_marketing_recipients_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "email_marketing_campaigns_status_idx" ON "email_marketing_campaigns"("status");
CREATE INDEX "email_marketing_campaigns_created_at_idx" ON "email_marketing_campaigns"("created_at");
CREATE INDEX "email_marketing_recipients_campaign_id_status_idx" ON "email_marketing_recipients"("campaign_id", "status");
CREATE INDEX "email_marketing_recipients_customer_id_idx" ON "email_marketing_recipients"("customer_id");
CREATE INDEX "email_marketing_recipients_email_idx" ON "email_marketing_recipients"("email");
CREATE UNIQUE INDEX "email_marketing_recipients_campaign_id_email_key" ON "email_marketing_recipients"("campaign_id", "email");

ALTER TABLE "email_marketing_campaigns"
ADD CONSTRAINT "email_marketing_campaigns_created_by_admin_id_fkey"
FOREIGN KEY ("created_by_admin_id") REFERENCES "admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "email_marketing_recipients"
ADD CONSTRAINT "email_marketing_recipients_campaign_id_fkey"
FOREIGN KEY ("campaign_id") REFERENCES "email_marketing_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "email_marketing_recipients"
ADD CONSTRAINT "email_marketing_recipients_customer_id_fkey"
FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
