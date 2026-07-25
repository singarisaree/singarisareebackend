-- Hyper-Local Instant rider verification OTPs
ALTER TABLE "shipping" ADD COLUMN IF NOT EXISTS "pickup_otp" VARCHAR(4);
ALTER TABLE "shipping" ADD COLUMN IF NOT EXISTS "drop_otp" VARCHAR(4);
ALTER TABLE "shipping" ADD COLUMN IF NOT EXISTS "rto_otp" VARCHAR(4);
