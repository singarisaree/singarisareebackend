-- AlterTable
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "last_login_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE IF NOT EXISTS "customer_otp_challenges" (
    "id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "otp_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_otp_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "customer_sessions" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "device_label" TEXT,
    "user_agent" TEXT,
    "ip_address" TEXT,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "customer_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "customer_otp_challenges_phone_idx" ON "customer_otp_challenges"("phone");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "customer_otp_challenges_expires_at_idx" ON "customer_otp_challenges"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "customer_sessions_token_hash_key" ON "customer_sessions"("token_hash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "customer_sessions_customer_id_idx" ON "customer_sessions"("customer_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "customer_sessions_revoked_at_idx" ON "customer_sessions"("revoked_at");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'customer_sessions_customer_id_fkey'
  ) THEN
    ALTER TABLE "customer_sessions"
      ADD CONSTRAINT "customer_sessions_customer_id_fkey"
      FOREIGN KEY ("customer_id") REFERENCES "customers"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
