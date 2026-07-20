-- Store-credit refund coupons can be reused until remaining balance is spent.
ALTER TABLE "coupons" ADD COLUMN "remaining_balance" DECIMAL(10,2);

-- Backfill existing refund coupons so leftover credit can still be used.
UPDATE "coupons"
SET
  "remaining_balance" = "value",
  "usage_limit" = NULL
WHERE "is_refund_coupon" = true
  AND "remaining_balance" IS NULL;
