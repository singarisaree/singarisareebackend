-- Change showcase unique constraint from product_id to product_color_id
-- so same product with different colors can each have a video.

DROP INDEX "showcase_items_product_id_key";
CREATE UNIQUE INDEX "showcase_items_product_color_id_key" ON "showcase_items"("product_color_id");
