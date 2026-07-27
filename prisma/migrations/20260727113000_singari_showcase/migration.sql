-- Singari Showcase: up to 6 product videos on homepage
CREATE TABLE "showcase_items" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "product_color_id" UUID NOT NULL,
    "video_url" VARCHAR(500) NOT NULL,
    "public_id" VARCHAR(500) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "showcase_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "showcase_items_product_id_key" ON "showcase_items"("product_id");
CREATE INDEX "showcase_items_is_active_deleted_at_idx" ON "showcase_items"("is_active", "deleted_at");
CREATE INDEX "showcase_items_sort_order_idx" ON "showcase_items"("sort_order");

ALTER TABLE "showcase_items" ADD CONSTRAINT "showcase_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "showcase_items" ADD CONSTRAINT "showcase_items_product_color_id_fkey" FOREIGN KEY ("product_color_id") REFERENCES "product_colors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
