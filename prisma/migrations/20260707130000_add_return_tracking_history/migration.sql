-- Add return pickup statuses and tracking history
ALTER TYPE "ReturnRequestStatus" ADD VALUE IF NOT EXISTS 'PICKUP_CANCELLED' AFTER 'OUT_FOR_PICKUP';
ALTER TYPE "ReturnRequestStatus" ADD VALUE IF NOT EXISTS 'PICKED_UP' AFTER 'PICKUP_CANCELLED';

ALTER TABLE "return_requests" ADD COLUMN IF NOT EXISTS "pickup_cancelled_at" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "return_request_tracking_history" (
    "id" UUID NOT NULL,
    "return_request_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "description" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "return_request_tracking_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "return_request_tracking_history_return_request_id_idx"
ON "return_request_tracking_history"("return_request_id");

CREATE INDEX IF NOT EXISTS "return_request_tracking_history_timestamp_idx"
ON "return_request_tracking_history"("timestamp");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'return_request_tracking_history_return_request_id_fkey'
  ) THEN
    ALTER TABLE "return_request_tracking_history"
    ADD CONSTRAINT "return_request_tracking_history_return_request_id_fkey"
    FOREIGN KEY ("return_request_id") REFERENCES "return_requests"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Backfill tracking history for existing return requests
INSERT INTO "return_request_tracking_history" ("id", "return_request_id", "status", "description", "timestamp", "created_at")
SELECT
  gen_random_uuid(),
  rr.id,
  rr.status::text,
  CASE rr.status::text
    WHEN 'REQUESTED' THEN 'Return request submitted'
    WHEN 'ACCEPTED' THEN 'Return request accepted'
    WHEN 'REJECTED' THEN 'Return request rejected'
    WHEN 'OUT_FOR_PICKUP' THEN 'Pickup scheduled — item out for pickup'
    WHEN 'PICKUP_CANCELLED' THEN 'Pickup cancelled'
    WHEN 'PICKED_UP' THEN 'Item picked up'
    WHEN 'RETURNED' THEN 'Return completed'
    ELSE 'Return status updated'
  END,
  COALESCE(
    rr.returned_at,
    rr.picked_up_at,
    rr.pickup_cancelled_at,
    rr.rejected_at,
    rr.accepted_at,
    rr.created_at
  ),
  COALESCE(
    rr.returned_at,
    rr.picked_up_at,
    rr.pickup_cancelled_at,
    rr.rejected_at,
    rr.accepted_at,
    rr.created_at
  )
FROM "return_requests" rr
WHERE NOT EXISTS (
  SELECT 1
  FROM "return_request_tracking_history" h
  WHERE h.return_request_id = rr.id
);
