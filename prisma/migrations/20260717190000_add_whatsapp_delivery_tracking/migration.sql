ALTER TABLE "marketing_message_logs"
ADD COLUMN "provider_message_id" TEXT,
ADD COLUMN "accepted_at" TIMESTAMP(3),
ADD COLUMN "delivered_at" TIMESTAMP(3),
ADD COLUMN "read_at" TIMESTAMP(3),
ADD COLUMN "failed_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "marketing_message_logs_provider_message_id_key"
ON "marketing_message_logs"("provider_message_id");
