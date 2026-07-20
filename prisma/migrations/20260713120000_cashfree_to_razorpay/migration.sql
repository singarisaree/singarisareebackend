-- PaymentMethod: CASHFREE -> RAZORPAY
ALTER TYPE "PaymentMethod" RENAME VALUE 'CASHFREE' TO 'RAZORPAY';

-- Rename Cashfree columns to Razorpay
ALTER TABLE "payments" RENAME COLUMN "cashfree_order_id" TO "razorpay_order_id";
ALTER TABLE "payments" RENAME COLUMN "cashfree_payment_id" TO "razorpay_payment_id";

-- Drop unused Cashfree session column
ALTER TABLE "payments" DROP COLUMN IF EXISTS "payment_session_id";

-- Rename index
DROP INDEX IF EXISTS "payments_cashfree_order_id_idx";
CREATE INDEX IF NOT EXISTS "payments_razorpay_order_id_idx" ON "payments"("razorpay_order_id");
