ALTER TABLE "marketing_campaigns"
ADD COLUMN "campaign_link" TEXT NOT NULL DEFAULT '';

ALTER TABLE "marketing_campaigns"
ALTER COLUMN "campaign_link" DROP DEFAULT;

CREATE TYPE "WhatsAppOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED');

CREATE TABLE "whatsapp_outbox_events" (
  "id" UUID NOT NULL,
  "dedupe_key" TEXT NOT NULL,
  "customer_id" UUID,
  "phone" TEXT NOT NULL,
  "template_kind" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "WhatsAppOutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_at" TIMESTAMP(3),
  "provider_message_id" TEXT,
  "last_error" TEXT,
  "sent_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "whatsapp_outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "whatsapp_outbox_events_dedupe_key_key"
ON "whatsapp_outbox_events"("dedupe_key");

CREATE INDEX "whatsapp_outbox_events_status_next_attempt_at_idx"
ON "whatsapp_outbox_events"("status", "next_attempt_at");

CREATE INDEX "whatsapp_outbox_events_customer_id_idx"
ON "whatsapp_outbox_events"("customer_id");

ALTER TABLE "whatsapp_outbox_events"
ADD CONSTRAINT "whatsapp_outbox_events_customer_id_fkey"
FOREIGN KEY ("customer_id") REFERENCES "customers"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
