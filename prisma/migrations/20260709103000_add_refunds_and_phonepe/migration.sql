-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'REFUNDED';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "refund_deduction" DECIMAL(10,2) DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "refund_amount" DECIMAL(10,2);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "refund_utr" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "refunded_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "return_requests" ADD COLUMN IF NOT EXISTS "phone_pe_number" TEXT;
ALTER TABLE "return_requests" ADD COLUMN IF NOT EXISTS "phone_pe_account_name" TEXT;
