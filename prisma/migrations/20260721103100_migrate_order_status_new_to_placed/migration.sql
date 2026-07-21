-- Step 2: migrate legacy NEW rows and set default (runs after PLACED is committed).
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
