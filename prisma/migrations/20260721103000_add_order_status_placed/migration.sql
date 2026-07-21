-- App + Prisma schema use PLACED; initial migration created NEW instead.
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'PLACED';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'OrderStatus'
      AND e.enumlabel = 'NEW'
  ) THEN
    EXECUTE 'UPDATE "orders" SET "status" = ''PLACED'' WHERE "status"::text = ''NEW''';
  END IF;
END $$;

ALTER TABLE "orders" ALTER COLUMN "status" SET DEFAULT 'PLACED';
