ALTER TABLE "return_requests"
  ADD COLUMN IF NOT EXISTS "shiprocket_return_order_id" TEXT,
  ADD COLUMN IF NOT EXISTS "shiprocket_return_shipment_id" TEXT,
  ADD COLUMN IF NOT EXISTS "reverse_awb_code" TEXT,
  ADD COLUMN IF NOT EXISTS "reverse_tracking_url" TEXT;
