-- CreateTable
CREATE TABLE "shipment_history" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "method" "ShippingMethod" NOT NULL DEFAULT 'SHIPROCKET',
    "shiprocket_order_id" TEXT,
    "shiprocket_shipment_id" TEXT,
    "awb_code" TEXT,
    "courier_name" TEXT,
    "tracking_number" TEXT,
    "tracking_url" TEXT,
    "label_url" TEXT,
    "manifest_url" TEXT,
    "shipped_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,

    CONSTRAINT "shipment_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shipment_history_order_id_idx" ON "shipment_history"("order_id");

-- CreateIndex
CREATE INDEX "shipment_history_archived_at_idx" ON "shipment_history"("archived_at");

-- AddForeignKey
ALTER TABLE "shipment_history" ADD CONSTRAINT "shipment_history_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
