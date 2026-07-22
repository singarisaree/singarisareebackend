import { OrderStatus, Prisma, CouponType } from '@prisma/client';
import { prisma } from '@/config/database';
import { env } from '@/config/env';
import { runPrismaTransaction } from '@/utils/prisma-transaction';
import { ApiError } from '@/shared/api-response';
import {
  generateUniqueOrderNumber,
  parsePagination,
  parseCreatedAtFilter,
  addDays,
  formatCurrency,
} from '@/utils/helpers';
import { buildPaginationMeta } from '@/shared/api-response';
import { razorpayService } from '@/integrations/razorpay.service';
import { shiprocketService } from '@/integrations/shiprocket.service';
import { whatsAppService } from '@/integrations/whatsapp.service';
import { orderEmailService } from '@/integrations/order-email.service';
import { logger } from '@/utils/logger';
import { customerService } from '@/modules/customers/customer.service';
import { geocodingService } from '@/integrations/geocoding.service';
import { settingsService } from '@/modules/settings/settings.service';
import {
  syncReturnRequestFromOrderStatus,
  getOrderStatusTrackingDescription,
} from '@/modules/orders/order-tracking.sync';
import { invalidateCache, withCache, STORE_CACHE_TTL_MS } from '@/utils/memory-cache';
import { realtime } from '@/realtime/emitter';
import { shippingService } from '@/modules/dashboard/dashboard.service';

interface CheckoutItem {
  productId: string;
  productColorId: string;
  quantity: number;
}

interface ShippingAddress {
  country: string;
  countryCode?: string;
  state: string;
  city: string;
  postalCode: string;
  addressLine1: string;
  addressLine2?: string;
  landmark?: string;
  latitude?: number;
  longitude?: number;
  preferredShipping?: 'QUICK' | 'STANDARD';
}

const SUCCESSFUL_ORDER_STATUSES = new Set<OrderStatus>([
  'PLACED',
  'CONFIRMED',
  'READY_TO_SHIP',
  'SHIPPED',
  'IN_TRANSIT',
  'DELIVERED',
]);

/** Full order graph for admin detail / mutation responses — no external API sync. */
const orderDetailInclude = {
  items: {
    include: {
      product: {
        select: { weight: true, length: true, width: true, height: true },
      },
    },
  },
  shipping: true,
  shipmentHistory: {
    orderBy: { archivedAt: 'desc' as const },
    take: 10,
  },
  trackingHistory: {
    orderBy: { timestamp: 'desc' as const },
    take: 40,
    select: {
      id: true,
      status: true,
      description: true,
      timestamp: true,
      location: true,
    },
  },
  payments: {
    orderBy: { createdAt: 'desc' as const },
    take: 5,
    select: {
      id: true,
      status: true,
      method: true,
      amount: true,
      currency: true,
      transactionId: true,
      razorpayOrderId: true,
      razorpayPaymentId: true,
      failureReason: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  coupon: { select: { id: true, code: true, type: true, value: true, isRefundCoupon: true } },
  returnRequests: {
    orderBy: { createdAt: 'desc' as const },
    select: {
      id: true,
      status: true,
      reason: true,
      createdAt: true,
      customerPhone: true,
      refundCouponId: true,
      refundCouponCode: true,
      adminNotes: true,
      items: {
        select: {
          id: true,
          orderItemId: true,
          quantity: true,
          orderItem: {
            select: {
              id: true,
              productName: true,
              colorName: true,
              sku: true,
              imageUrl: true,
              quantity: true,
              unitPrice: true,
              totalPrice: true,
            },
          },
        },
      },
      trackingHistory: {
        orderBy: { timestamp: 'desc' as const },
        take: 20,
        select: {
          id: true,
          status: true,
          description: true,
          timestamp: true,
        },
      },
    },
  },
} satisfies Prisma.OrderInclude;

function shippingAddressFingerprint(address: ShippingAddress): string {
  return [
    address.country,
    address.countryCode ?? '',
    address.state,
    address.city,
    address.postalCode,
    address.addressLine1,
    address.addressLine2 ?? '',
    address.landmark ?? '',
  ]
    .map((part) => part.trim().toLowerCase())
    .join('|');
}

/** Customer-facing Instant unavailable copy (never expose Shiprocket API errors). */
const CUSTOMER_QUICK_UNAVAILABLE =
  'Instant delivery is not available right now. You can continue with Standard delivery.';

/** Storefront + lookup: last 10 digits for Indian mobiles. */
function normalizeCustomerPhone(phone: string): string {
  return phone.replace(/\D/g, '').slice(-10);
}

/** Parse Instant ETA labels ("About 1 hour", "45 min", "90") into milliseconds. */
function parseQuickEtaDurationMs(estimatedDays: string | null | undefined): number {
  const raw = String(estimatedDays ?? '').trim();
  if (!raw) return 60 * 60 * 1000; // default 1 hour
  if (/^\d+$/.test(raw)) {
    const mins = Number(raw);
    return Number.isFinite(mins) && mins > 0 ? mins * 60_000 : 60 * 60 * 1000;
  }
  const aboutHours = raw.match(/about\s+(\d+(?:\.\d+)?)\s+hours?/i);
  if (aboutHours) {
    const hours = Number(aboutHours[1]);
    return Number.isFinite(hours) && hours > 0 ? hours * 3_600_000 : 60 * 60 * 1000;
  }
  const aboutMins = raw.match(/(?:about\s+)?(\d+)\s+min(?:utes?)?/i);
  if (aboutMins) {
    const mins = Number(aboutMins[1]);
    return Number.isFinite(mins) && mins > 0 ? mins * 60_000 : 60 * 60 * 1000;
  }
  const plainHours = raw.match(/(\d+(?:\.\d+)?)\s*h(?:ours?)?/i);
  if (plainHours) {
    const hours = Number(plainHours[1]);
    return Number.isFinite(hours) && hours > 0 ? hours * 3_600_000 : 60 * 60 * 1000;
  }
  return 60 * 60 * 1000;
}

/** Parse Shiprocket ETA strings like "5-7", "7 days", "About 1 hour" → whole days (min 1). */
function parseEstimatedDeliveryDays(
  estimatedDays: string | null | undefined,
  fallback: number,
): number {
  const raw = String(estimatedDays ?? '').trim();
  if (!raw) return Math.max(1, fallback);
  if (/hour|minute|same.?day|today/i.test(raw)) return 0;
  const range = raw.match(/(\d+)\s*[-–to]+\s*(\d+)/i);
  if (range) {
    const upper = Number(range[2]);
    return Number.isFinite(upper) && upper > 0 ? upper : Math.max(1, fallback);
  }
  const single = raw.match(/(\d+)/);
  if (single) {
    const days = Number(single[1]);
    return Number.isFinite(days) && days > 0 ? days : Math.max(1, fallback);
  }
  return Math.max(1, fallback);
}

function customerPhoneLookupVariants(phone: string): string[] {
  const normalized = normalizeCustomerPhone(phone);
  if (!normalized) return [];
  return Array.from(new Set([normalized, `91${normalized}`, `+91${normalized}`, phone.trim()]));
}

export class OrderService {
  /** In-process lock so list GETs don't stampede Razorpay sync. */
  private pendingSyncInFlight: Promise<number> | null = null;
  private pendingSyncLastStartedAt = 0;
  private static readonly PENDING_SYNC_COOLDOWN_MS = 15_000;

  private async allocateOrderNumber(): Promise<string> {
    return generateUniqueOrderNumber(async (orderNumber) => {
      const existing = await prisma.order.findUnique({
        where: { orderNumber },
        select: { id: true },
      });
      return !!existing;
    });
  }

  async listAvailableCoupons(subtotal = 0, phone?: string, shippingCharge = 0) {
    const now = new Date();
    const normalizePhone = (value: string) => {
      const digits = value.replace(/\D/g, '');
      return digits.length > 10 ? digits.slice(-10) : digits;
    };
    const providedPhone = phone ? normalizePhone(phone) : '';
    const chargeable = Math.max(0, subtotal) + Math.max(0, shippingCharge);

    const coupons = await prisma.coupon.findMany({
      where: {
        deletedAt: null,
        isActive: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return coupons
      .filter((coupon) => {
        if (coupon.startsAt && coupon.startsAt > now) return false;
        if (coupon.expiresAt && coupon.expiresAt < now) return false;
        if (coupon.isRefundCoupon) {
          const remaining = Number(coupon.remainingBalance ?? coupon.value);
          if (remaining <= 0) return false;
        } else if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
          return false;
        }
        if (coupon.allowedPhone) {
          if (!providedPhone || normalizePhone(coupon.allowedPhone) !== providedPhone) {
            return false;
          }
        }
        return true;
      })
      .map((coupon) => {
        const minOrderAmount = Number(coupon.minOrderAmount || 0);
        const eligible = subtotal >= minOrderAmount;
        let discountPreview = 0;
        if (eligible && chargeable > 0) {
          if (coupon.isRefundCoupon) {
            const credit = Number(coupon.remainingBalance ?? coupon.value);
            discountPreview = Math.min(credit, chargeable);
          } else if (coupon.type === CouponType.FLAT) {
            discountPreview = Math.min(Number(coupon.value), subtotal);
          } else {
            discountPreview = (subtotal * Number(coupon.value)) / 100;
            if (coupon.maxDiscount) {
              discountPreview = Math.min(discountPreview, Number(coupon.maxDiscount));
            }
          }
        }
        return {
          id: coupon.id,
          code: coupon.code,
          type: coupon.type,
          value: Number(coupon.value),
          remainingBalance:
            coupon.remainingBalance != null ? Number(coupon.remainingBalance) : null,
          isRefundCoupon: coupon.isRefundCoupon,
          minOrderAmount,
          maxDiscount: coupon.maxDiscount ? Number(coupon.maxDiscount) : null,
          expiresAt: coupon.expiresAt,
          eligible,
          discountPreview: Math.round(discountPreview * 100) / 100,
        };
      })
      .sort((a, b) => Number(b.eligible) - Number(a.eligible));
  }

  async validateCoupon(code: string, subtotal: number, phone?: string, shippingCharge = 0) {
    const coupon = await prisma.coupon.findFirst({
      where: {
        code: code.toUpperCase(),
        isActive: true,
        deletedAt: null,
      },
    });

    if (!coupon) throw new ApiError(404, 'Invalid coupon code');

    if (coupon.startsAt && coupon.startsAt > new Date()) {
      throw new ApiError(400, 'Coupon not yet active');
    }
    if (coupon.expiresAt && coupon.expiresAt < new Date()) {
      throw new ApiError(400, 'Coupon has expired');
    }

    if (coupon.isRefundCoupon) {
      const remaining = Number(coupon.remainingBalance ?? coupon.value);
      if (remaining <= 0) {
        throw new ApiError(400, 'This store credit has been fully used');
      }
    } else if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
      throw new ApiError(400, 'Coupon usage limit reached');
    }

    if (Number(coupon.minOrderAmount) > subtotal) {
      const minFormatted = Number(coupon.minOrderAmount).toLocaleString('en-IN');
      throw new ApiError(400, `Minimum order value is Rs. ${minFormatted} to use this coupon`);
    }

    if (coupon.allowedPhone) {
      const normalize = (value: string) => {
        const digits = value.replace(/\D/g, '');
        return digits.length > 10 ? digits.slice(-10) : digits;
      };
      const allowed = normalize(coupon.allowedPhone);
      const provided = phone ? normalize(phone) : '';
      if (!provided || provided !== allowed) {
        throw new ApiError(400, 'This coupon is valid only for the registered mobile number');
      }
    }

    const chargeable = Math.max(0, subtotal) + Math.max(0, shippingCharge);
    let discount = 0;
    if (coupon.isRefundCoupon) {
      const remaining = Number(coupon.remainingBalance ?? coupon.value);
      discount = Math.min(remaining, chargeable);
    } else if (coupon.type === CouponType.FLAT) {
      discount = Math.min(Number(coupon.value), subtotal);
    } else {
      discount = (subtotal * Number(coupon.value)) / 100;
      if (coupon.maxDiscount) {
        discount = Math.min(discount, Number(coupon.maxDiscount));
      }
    }

    return { coupon, discount: Math.round(discount * 100) / 100 };
  }

  /** Reserve coupon use / store-credit balance when an order is placed. */
  private async consumeCouponOnOrder(
    tx: Prisma.TransactionClient,
    couponId: string,
    discountAmount: number,
  ) {
    if (discountAmount <= 0) {
      await tx.coupon.update({
        where: { id: couponId },
        data: { usedCount: { increment: 1 } },
      });
      return;
    }

    const coupon = await tx.coupon.findUnique({ where: { id: couponId } });
    if (!coupon || coupon.deletedAt) {
      throw new ApiError(400, 'Coupon is no longer available');
    }

    if (coupon.isRefundCoupon) {
      const updated = await tx.coupon.updateMany({
        where: {
          id: couponId,
          remainingBalance: { gte: discountAmount },
        },
        data: {
          remainingBalance: { decrement: discountAmount },
          usedCount: { increment: 1 },
        },
      });
      if (updated.count === 0) {
        throw new ApiError(400, 'This store credit does not have enough remaining balance');
      }
      await tx.coupon.updateMany({
        where: { id: couponId, remainingBalance: { lte: 0 } },
        data: { isActive: false },
      });
      return;
    }

    if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
      throw new ApiError(400, 'Coupon usage limit reached');
    }

    await tx.coupon.update({
      where: { id: couponId },
      data: { usedCount: { increment: 1 } },
    });
  }

  /** Restore coupon use / store-credit when payment fails or order is cancelled before use. */
  private async restoreCouponFromOrder(
    tx: Prisma.TransactionClient,
    couponId: string,
    discountAmount: number,
  ) {
    const coupon = await tx.coupon.findUnique({ where: { id: couponId } });
    if (!coupon) return;

    if (coupon.isRefundCoupon) {
      const restoreBy = Math.max(0, Number(discountAmount) || 0);
      await tx.coupon.update({
        where: { id: couponId },
        data: {
          remainingBalance: { increment: restoreBy },
          ...(coupon.usedCount > 0 ? { usedCount: { decrement: 1 } } : {}),
          isActive: true,
          deletedAt: null,
        },
      });
      return;
    }

    if (coupon.usedCount > 0) {
      await tx.coupon.update({
        where: { id: couponId },
        data: { usedCount: { decrement: 1 } },
      });
    }
  }

  async syncCartItems(items: CheckoutItem[]) {
    const syncedItems: Array<{
      productId: string;
      productColorId: string;
      productName: string;
      colorName: string;
      slug: string;
      imageUrl: string;
      price: number;
      mrp: number;
      quantity: number;
      maxStock: number;
    }> = [];
    const removed: Array<{ productColorId: string; productName: string; reason: string }> = [];
    const adjusted: Array<{
      productColorId: string;
      productName: string;
      from: number;
      to: number;
    }> = [];

    const byColorId = await this.loadCheckoutProductsByColor(items);

    for (const item of items) {
      const entry = byColorId.get(item.productColorId);
      if (!entry) {
        removed.push({
          productColorId: item.productColorId,
          productName: 'Product',
          reason: 'This product is no longer available',
        });
        continue;
      }

      const { product, color } = entry;
      const inventory = color.inventory[0];
      const available = inventory ? inventory.quantity - inventory.reserved : 0;

      if (available <= 0) {
        removed.push({
          productColorId: item.productColorId,
          productName: product.name,
          reason: `${color.name} is out of stock`,
        });
        continue;
      }

      const quantity = Math.min(item.quantity, available);
      if (quantity < item.quantity) {
        adjusted.push({
          productColorId: color.id,
          productName: product.name,
          from: item.quantity,
          to: quantity,
        });
      }

      syncedItems.push({
        productId: product.id,
        productColorId: color.id,
        productName: product.name,
        colorName: color.name,
        slug: product.slug,
        imageUrl: color.images[0]?.url || '',
        price: Number(product.price),
        mrp: Number(product.mrp),
        quantity,
        maxStock: available,
      });
    }

    return { items: syncedItems, removed, adjusted };
  }

  async calculateOrderTotals(
    items: CheckoutItem[],
    couponCode?: string,
    shippingAddress?: Partial<ShippingAddress>,
    phone?: string,
  ) {
    const [byColorId, settings] = await Promise.all([
      this.loadCheckoutProductsByColor(items),
      this.getShippingSettings(),
    ]);

    let subtotal = 0;
    const orderItems: Array<{
      productId: string;
      productColorId: string;
      productName: string;
      colorName: string;
      sku: string;
      imageUrl: string | null;
      quantity: number;
      unitPrice: number;
      totalPrice: number;
      weight: number | null;
      length: number | null;
      width: number | null;
      height: number | null;
    }> = [];

    for (const item of items) {
      const entry = byColorId.get(item.productColorId);
      if (!entry) throw new ApiError(404, `Product not found: ${item.productId}`);

      const { product, color } = entry;
      const inventory = color.inventory[0];
      const available = inventory ? inventory.quantity - inventory.reserved : 0;
      if (available < item.quantity) {
        throw new ApiError(400, `Insufficient stock for ${product.name} (${color.name})`);
      }

      const unitPrice = Number(product.price);
      const totalPrice = unitPrice * item.quantity;
      subtotal += totalPrice;

      orderItems.push({
        productId: product.id,
        productColorId: color.id,
        productName: product.name,
        colorName: color.name,
        sku: product.sku,
        imageUrl: color.images[0]?.url || null,
        quantity: item.quantity,
        unitPrice,
        totalPrice,
        weight: product.weight != null ? Number(product.weight) : null,
        length: product.length != null ? Number(product.length) : null,
        width: product.width != null ? Number(product.width) : null,
        height: product.height != null ? Number(product.height) : null,
      });
    }

    let discountAmount = 0;
    let couponId: string | undefined;
    let appliedCouponCode: string | undefined;

    const shippingQuote = await this.resolveShippingQuote(
      subtotal,
      orderItems,
      shippingAddress,
      settings,
    );
    const shippingCharge = shippingQuote.shippingFee;

    if (couponCode) {
      const { coupon, discount } = await this.validateCoupon(
        couponCode,
        subtotal,
        phone,
        shippingCharge,
      );
      discountAmount = discount;
      couponId = coupon.id;
      appliedCouponCode = coupon.code;
    }

    const taxAmount = 0;
    const grandTotal = Math.max(
      0,
      Math.round((subtotal - discountAmount + shippingCharge + taxAmount) * 100) / 100,
    );

    const isQuick = shippingAddress?.preferredShipping === 'QUICK';
    const isInternational =
      !isQuick && shippingAddress != null && !this.isIndiaShippingAddress(shippingAddress);

    let estimatedDelivery: Date;
    if (isQuick) {
      estimatedDelivery = new Date(
        Date.now() + parseQuickEtaDurationMs(shippingQuote.estimatedDays),
      );
    } else if (isInternational) {
      const days = parseEstimatedDeliveryDays(
        shippingQuote.estimatedDays,
        Math.max(Number(settings.estimatedDeliveryDays) || 7, 7),
      );
      estimatedDelivery = addDays(new Date(), days);
    } else {
      // Other India cities: promise window is 3–7 days (store upper bound for ETA date)
      const indiaDays = this.isHyderabadDeliveryArea(shippingAddress) ? 2 : 7;
      estimatedDelivery = addDays(new Date(), indiaDays);
    }

    return {
      orderItems,
      subtotal,
      discountAmount,
      shippingCharge,
      taxAmount,
      grandTotal,
      couponId,
      couponCode: appliedCouponCode,
      estimatedDelivery,
      shippingQuote: {
        success: true as const,
        courier: shippingQuote.courier,
        shippingFee: shippingQuote.shippingFee,
        estimatedDays: shippingQuote.estimatedDays,
        currency: shippingQuote.currency,
      },
    };
  }

  /**
   * Quote-only shipping (no shipment creation). India uses store settings;
   * international uses Shiprocket X serviceability and picks the cheapest courier.
   */
  async quoteShipping(
    items: CheckoutItem[],
    shippingAddress: Partial<ShippingAddress>,
  ): Promise<
    | {
        success: true;
        courier: string;
        shippingFee: number;
        estimatedDays: string;
        currency: string;
      }
    | { success: false; message: string }
  > {
    try {
      if (
        !shippingAddress.country?.trim() ||
        !shippingAddress.state?.trim() ||
        !shippingAddress.city?.trim() ||
        !shippingAddress.postalCode?.trim()
      ) {
        return {
          success: false,
          message: 'Country, state, city, and postal code are required to calculate shipping.',
        };
      }

      const byColorId = await this.loadCheckoutProductsByColor(items);
      let subtotal = 0;
      const orderItems: Array<{
        quantity: number;
        weight: number | null;
        length: number | null;
        width: number | null;
        height: number | null;
      }> = [];

      for (const item of items) {
        const entry = byColorId.get(item.productColorId);
        if (!entry) throw new ApiError(404, `Product not found: ${item.productId}`);
        const { product, color } = entry;
        const inventory = color.inventory[0];
        const available = inventory ? inventory.quantity - inventory.reserved : 0;
        if (available < item.quantity) {
          throw new ApiError(400, `Insufficient stock for ${product.name} (${color.name})`);
        }
        subtotal += Number(product.price) * item.quantity;
        orderItems.push({
          quantity: item.quantity,
          weight: product.weight != null ? Number(product.weight) : null,
          length: product.length != null ? Number(product.length) : null,
          width: product.width != null ? Number(product.width) : null,
          height: product.height != null ? Number(product.height) : null,
        });
      }

      const settings = await this.getShippingSettings();
      // Quote endpoint always returns standard rates for India; Quick is separate
      const quote = await this.resolveShippingQuote(
        subtotal,
        orderItems,
        { ...shippingAddress, preferredShipping: 'STANDARD' },
        settings,
      );
      return {
        success: true,
        courier: quote.courier,
        shippingFee: quote.shippingFee,
        estimatedDays: quote.estimatedDays,
        currency: quote.currency,
      };
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 400) {
        return {
          success: false,
          message: error.message || 'Delivery is not available for this location.',
        };
      }
      throw error;
    }
  }

  /**
   * Quote-only Shiprocket Quick (hyperlocal). Does not create a delivery.
   */
  async quoteQuickDelivery(
    items: CheckoutItem[],
    delivery: {
      latitude: number;
      longitude: number;
      postalCode?: string;
      city?: string;
    },
  ): Promise<
    | {
        available: true;
        rate: number;
        etaMinutes: string | null;
        currency: string;
        courierName: string | null;
      }
    | { available: false; message: string }
  > {
    try {
      const schedule = await settingsService.getQuickScheduleAvailability();
      if (!schedule.available) {
        return { available: false, message: schedule.message };
      }

      const pickup = await settingsService.getQuickPickupCoordinates();
      if (!pickup) {
        return {
          available: false,
          message: CUSTOMER_QUICK_UNAVAILABLE,
        };
      }

      const byColorId = await this.loadCheckoutProductsByColor(items);
      let subtotal = 0;
      let totalWeightGrams = 0;

      for (const item of items) {
        const entry = byColorId.get(item.productColorId);
        if (!entry) throw new ApiError(404, `Product not found: ${item.productId}`);
        const { product, color } = entry;
        const inventory = color.inventory[0];
        const available = inventory ? inventory.quantity - inventory.reserved : 0;
        if (available < item.quantity) {
          throw new ApiError(400, `Insufficient stock for ${product.name} (${color.name})`);
        }
        subtotal += Number(product.price) * item.quantity;
        if (product.weight != null) {
          totalWeightGrams += Number(product.weight) * item.quantity;
        }
      }

      const weightKg = Math.max(totalWeightGrams > 0 ? totalWeightGrams / 1000 : 0.5, 0.1);
      const quote = await shiprocketService.quoteQuickDelivery({
        pickupPostalCode: env.SHIPROCKET_PICKUP_PINCODE,
        deliveryPostalCode: delivery.postalCode?.trim() || '500001',
        pickupLatitude: pickup.latitude,
        pickupLongitude: pickup.longitude,
        deliveryLatitude: delivery.latitude,
        deliveryLongitude: delivery.longitude,
        weightKg,
        declaredValue: subtotal,
        cod: false,
      });

      if (!Number.isFinite(quote.rate) || quote.rate < 0) {
        return { available: false, message: CUSTOMER_QUICK_UNAVAILABLE };
      }

      return {
        available: true,
        rate: quote.rate,
        etaMinutes: quote.etaMinutes,
        currency: quote.currency,
        courierName: quote.courierName,
      };
    } catch (error) {
      // Never show Shiprocket API / account errors to storefront customers
      logger.warn('Quick delivery quote failed', {
        error,
        message: error instanceof Error ? error.message : undefined,
      });
      if (error instanceof ApiError && error.statusCode === 400) {
        // Schedule / location messages from our own validation can stay customer-facing
        const msg = error.message || '';
        if (
          /outside|hours|holiday|location|coordinates|detect|configured|schedule/i.test(msg) &&
          !/shiprocket|\/quick\/|404|api/i.test(msg)
        ) {
          return { available: false, message: msg };
        }
      }
      return {
        available: false,
        message: CUSTOMER_QUICK_UNAVAILABLE,
      };
    }
  }

  async listShippingCountries() {
    return withCache('shiprocket:countries', 6 * 60 * 60 * 1000, () =>
      shiprocketService.getCountries(),
    );
  }

  async createGuestOrder(data: {
    customerName: string;
    customerPhone: string;
    customerEmail: string;
    shippingAddress: ShippingAddress;
    items: CheckoutItem[];
    couponCode?: string;
  }) {
    const totals = await this.calculateOrderTotals(
      data.items,
      data.couponCode,
      data.shippingAddress,
      data.customerPhone,
    );
    const orderNumber = await this.allocateOrderNumber();
    const shippingAddress = geocodingService.resolveCoordinatesForCheckout(data.shippingAddress);
    const isFreeCheckout = totals.grandTotal <= 0;

    // Start the Razorpay order in parallel with the DB write so its network round-trip
    // overlaps the transaction instead of adding to it. Wrapped so it never rejects;
    // the outcome is inspected after the order is committed.
    const razorpaySessionPromise: Promise<
      | { ok: true; order: Awaited<ReturnType<typeof razorpayService.createOrder>> }
      | { ok: false; error: unknown }
      | null
    > = isFreeCheckout
      ? Promise.resolve(null)
      : razorpayService
          .createOrder({
            orderNumber,
            amountRupees: totals.grandTotal,
            customerName: data.customerName,
            customerEmail: data.customerEmail,
            customerPhone: data.customerPhone,
          })
          .then((rzp) => ({ ok: true as const, order: rzp }))
          .catch((error) => ({ ok: false as const, error }));

    const order = await runPrismaTransaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          orderNumber,
          status: isFreeCheckout ? 'PLACED' : 'PAYMENT_PENDING',
          customerName: data.customerName,
          customerEmail: data.customerEmail,
          customerPhone: normalizeCustomerPhone(data.customerPhone),
          shippingAddress: shippingAddress as unknown as Prisma.InputJsonValue,
          subtotal: totals.subtotal,
          discountAmount: totals.discountAmount,
          shippingCharge: totals.shippingCharge,
          taxAmount: totals.taxAmount,
          grandTotal: totals.grandTotal,
          couponId: totals.couponId,
          couponCode: totals.couponCode,
          estimatedDelivery: totals.estimatedDelivery,
          items: {
            create: totals.orderItems,
          },
        },
        include: { items: true },
      });

      await Promise.all([
        tx.trackingHistory.create({
          data: {
            orderId: created.id,
            status: isFreeCheckout ? 'PLACED' : 'PAYMENT_PENDING',
            description: isFreeCheckout
              ? 'Order placed. No payment required (store credit covered the total).'
              : 'Order created. Waiting for payment confirmation.',
          },
        }),
        this.reserveInventoryForItems(tx, data.items),
        tx.payment.create({
          data: {
            orderId: created.id,
            amount: totals.grandTotal,
            status: isFreeCheckout ? 'SUCCESS' : 'PENDING',
            method: isFreeCheckout ? 'STORE_CREDIT' : 'RAZORPAY',
            ...(isFreeCheckout
              ? {
                  transactionId: 'ZERO_TOTAL',
                  metadata: {
                    freeCheckout: true,
                    reason: 'zero_grand_total',
                  },
                }
              : {}),
          },
        }),
        totals.couponId
          ? this.consumeCouponOnOrder(tx, totals.couponId, totals.discountAmount)
          : Promise.resolve(),
      ]);

      return created;
    });

    void this.enrichOrderCoordinates(order.id, data.shippingAddress).catch((err) =>
      logger.warn('Background order geocoding failed', { orderId: order.id, err }),
    );

    void customerService
      .upsertFromOrder({
        name: data.customerName,
        phone: data.customerPhone,
        email: data.customerEmail,
      })
      .catch((err) => logger.warn('Customer upsert failed', { err }));

    if (totals.grandTotal <= 0) {
      void this.sendOrderNotifications(order.id).catch((err) =>
        logger.warn('Order notifications failed', { orderId: order.id, err }),
      );

      realtime.orderCreated({
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        customerPhone: order.customerPhone,
        grandTotal: Number(order.grandTotal),
      });
      invalidateCache('product:');
      invalidateCache('products:');
      invalidateCache('storefront:');
      realtime.catalogChanged('checkout-reserve');

      return {
        order,
        paymentRequired: false as const,
        razorpayOrderId: null,
        keyId: null,
        amount: 0,
        currency: 'INR',
      };
    }

    const razorpaySession = await razorpaySessionPromise;
    if (!razorpaySession || razorpaySession.ok === false) {
      logger.error('Razorpay session creation failed after order create', {
        orderId: order.id,
        orderNumber,
        error: razorpaySession?.error,
      });
      await this.releasePendingOrder(order.id, 'Payment session initialization failed');
      throw new ApiError(502, 'Unable to start payment right now. Please try again.');
    }
    const razorpayOrder = razorpaySession.order;

    void prisma.payment
      .updateMany({
        where: { orderId: order.id },
        data: {
          method: 'RAZORPAY',
          razorpayOrderId: razorpayOrder.id,
        },
      })
      .catch((err) =>
        logger.warn('Deferred payment session update failed', { orderId: order.id, err }),
      );

    void realtime.orderCreated({
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      customerPhone: order.customerPhone,
      grandTotal: Number(order.grandTotal),
    });
    invalidateCache('product:');
    invalidateCache('products:');
    invalidateCache('storefront:');
    realtime.catalogChanged('checkout-reserve');

    return {
      order,
      paymentRequired: true as const,
      razorpayOrderId: razorpayOrder.id,
      keyId: razorpayService.getPublicKeyId(),
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
    };
  }

  async createAdminOrder(
    data: {
      customerName: string;
      customerPhone: string;
      customerEmail: string;
      shippingAddress: ShippingAddress;
      items: CheckoutItem[];
      couponCode?: string;
      status?: OrderStatus;
      notes?: string;
    },
    adminId: string,
  ) {
    const totals = await this.calculateOrderTotals(
      data.items,
      data.couponCode,
      data.shippingAddress,
      data.customerPhone,
    );
    const orderNumber = await this.allocateOrderNumber();
    const shippingAddress = await geocodingService.resolveCoordinates(data.shippingAddress);

    if (data.status === 'READY_TO_SHIP') {
      throw new ApiError(
        400,
        'Cannot create an order as Ready to Ship. Create as Confirmed, then use Create Shipment.',
      );
    }

    const order = await runPrismaTransaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          orderNumber,
          status: data.status || 'CONFIRMED',
          customerName: data.customerName,
          customerEmail: data.customerEmail,
          customerPhone: normalizeCustomerPhone(data.customerPhone),
          shippingAddress: shippingAddress as unknown as Prisma.InputJsonValue,
          subtotal: totals.subtotal,
          discountAmount: totals.discountAmount,
          shippingCharge: totals.shippingCharge,
          taxAmount: totals.taxAmount,
          grandTotal: totals.grandTotal,
          couponId: totals.couponId,
          couponCode: totals.couponCode,
          estimatedDelivery: totals.estimatedDelivery,
          isAdminOrder: true,
          createdByAdminId: adminId,
          notes: data.notes,
          items: { create: totals.orderItems },
        },
        include: { items: true },
      });

      await tx.trackingHistory.create({
        data: {
          orderId: created.id,
          status: data.status || 'CONFIRMED',
          description: `Order created by admin with status ${(data.status || 'CONFIRMED').toLowerCase().replace(/_/g, ' ')}.`,
        },
      });

      for (const item of data.items) {
        await this.deductInventory(tx, item.productColorId, item.quantity, created.id, false);
        await tx.product.update({
          where: { id: item.productId },
          data: { soldCount: { increment: item.quantity } },
        });
      }

      await tx.payment.create({
        data: {
          orderId: created.id,
          method: 'ADMIN',
          status: 'SUCCESS',
          amount: totals.grandTotal,
        },
      });

      if (totals.couponId) {
        await this.consumeCouponOnOrder(tx, totals.couponId, totals.discountAmount);
      }

      return created;
    });

    void this.sendOrderNotifications(order.id).catch((err) =>
      logger.warn('Order notifications failed', { orderId: order.id, err }),
    );

    void customerService
      .upsertFromOrder({
        name: data.customerName,
        phone: data.customerPhone,
        email: data.customerEmail,
      })
      .catch((err) => logger.warn('Customer upsert failed', { err }));

    realtime.orderCreated({
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      customerPhone: order.customerPhone,
      grandTotal: Number(order.grandTotal),
    });

    return order;
  }

  async handlePaymentSuccess(orderNumber: string, paymentData: Record<string, unknown>) {
    const order = await prisma.order.findFirst({
      where: { orderNumber },
      include: { items: true, payments: true, trackingHistory: true },
    });

    if (!order) throw new ApiError(404, 'Order not found');
    if (this.isOrderPastPaymentPhase(order.status)) return order;

    const alreadyPaid = order.payments.some((p) => p.status === 'SUCCESS');
    if (alreadyPaid) {
      await this.healPaidOrderState(orderNumber);
      return prisma.order.findFirst({
        where: { orderNumber },
        include: { items: true, payments: true },
      });
    }

    if (!['PLACED', 'PAYMENT_PENDING', 'FAILED'].includes(order.status)) return order;

    const recoveringFromFailed = order.status === 'FAILED';
    const shouldNotify = order.status !== 'PLACED';

    await runPrismaTransaction(async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: 'PLACED' },
      });

      await tx.trackingHistory.create({
        data: {
          orderId: order.id,
          status: 'PLACED',
          description: 'Payment confirmed. Order placed successfully.',
        },
      });

      if (recoveringFromFailed) {
        await this.reserveInventoryForItems(tx, this.orderItemsToCheckoutItems(order.items));
      }

      await tx.payment.updateMany({
        where: { orderId: order.id },
        data: {
          status: 'SUCCESS',
          razorpayPaymentId: String(paymentData.razorpay_payment_id || paymentData.id || ''),
          transactionId: String(paymentData.razorpay_payment_id || paymentData.id || ''),
          metadata: paymentData as Prisma.InputJsonValue,
        },
      });
    });

    if (shouldNotify) {
      void this.sendOrderNotifications(order.id).catch((err) =>
        logger.warn('Order notifications failed', { orderId: order.id, err }),
      );

      void customerService
        .upsertFromOrder({
          name: order.customerName,
          phone: order.customerPhone,
          email: order.customerEmail,
        })
        .catch((err) => logger.warn('Customer upsert failed', { err }));

      realtime.orderStatusChanged({
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: 'PLACED',
        customerPhone: order.customerPhone,
        grandTotal: Number(order.grandTotal),
      });
    }

    return prisma.order.findFirst({
      where: { orderNumber },
      include: { items: true, payments: true },
    });
  }

  async syncPaymentStatus(orderNumber: string, options?: { fromPaymentReturn?: boolean }) {
    const order = await prisma.order.findFirst({
      where: { orderNumber },
      include: { payments: true, items: true },
    });

    if (!order) throw new ApiError(404, 'Order not found');

    const paymentSucceeded = order.payments.some((p) => p.status === 'SUCCESS');
    if (paymentSucceeded) {
      if (['FAILED', 'PAYMENT_PENDING'].includes(order.status)) {
        await this.healPaidOrderState(orderNumber);
        return prisma.order.findFirst({
          where: { orderNumber },
          include: { payments: true },
        });
      }
      return order;
    }

    if (SUCCESSFUL_ORDER_STATUSES.has(order.status)) return order;

    if (!['PAYMENT_PENDING', 'PLACED', 'FAILED'].includes(order.status)) return order;

    try {
      const paid = await this.reconcileRazorpayPaidOrder(orderNumber, order.payments[0]);
      if (paid) {
        return prisma.order.findFirst({
          where: { orderNumber },
          include: { payments: true },
        });
      }

      // Always detect failed attempts (including after Razorpay return).
      const failed = await this.reconcileRazorpayFailedPayment(orderNumber, order.payments[0]);
      if (failed) {
        return prisma.order.findFirst({
          where: { orderNumber },
          include: { payments: true },
        });
      }

      // Razorpay has no successful payment (abandoned / never attempted).
      const abandoned = await this.reconcileAbandonedRazorpayOrder(orderNumber, order);
      if (abandoned) {
        return prisma.order.findFirst({
          where: { orderNumber },
          include: { payments: true },
        });
      }

      if (options?.fromPaymentReturn) {
        return order;
      }
    } catch (error) {
      logger.error('Failed to sync payment status with Razorpay', { orderNumber, error });
    }

    return prisma.order.findFirst({
      where: { orderNumber },
      include: { payments: true },
    });
  }

  /** Sync stale pending orders with Razorpay so admin/customer don't show false pending. */
  async syncStalePendingOrders(limit = 25) {
    const cutoff = new Date(Date.now() - 2 * 60 * 1000);
    const pending = await prisma.order.findMany({
      where: {
        deletedAt: null,
        createdAt: { lt: cutoff },
        OR: [
          { status: 'PAYMENT_PENDING' },
          {
            status: 'PLACED',
            payments: { none: { status: 'SUCCESS' } },
          },
        ],
      },
      select: { orderNumber: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    if (pending.length === 0) return 0;

    await Promise.all(
      pending.map((row) =>
        this.syncPaymentStatus(row.orderNumber).catch((err) => {
          logger.warn('Stale pending order sync failed', {
            orderNumber: row.orderNumber,
            err,
          });
        }),
      ),
    );

    return pending.length;
  }

  /**
   * Fire-and-forget pending sync with cooldown so list/detail reads stay fast.
   * Concurrent callers share one in-flight sync; cooldown skips redundant kicks.
   */
  private scheduleStalePendingSync(limit = 25) {
    const now = Date.now();
    if (this.pendingSyncInFlight) return;
    if (now - this.pendingSyncLastStartedAt < OrderService.PENDING_SYNC_COOLDOWN_MS) return;

    this.pendingSyncLastStartedAt = now;
    this.pendingSyncInFlight = this.syncStalePendingOrders(limit)
      .catch((err) => {
        logger.warn('Background pending order sync failed', { err });
        return 0;
      })
      .finally(() => {
        this.pendingSyncInFlight = null;
      });
  }

  async handlePaymentFailure(orderNumber: string, reason?: string) {
    const order = await prisma.order.findFirst({
      where: { orderNumber },
      include: { payments: true },
    });
    if (!order) throw new ApiError(404, 'Order not found');

    if (order.payments.some((p) => p.status === 'SUCCESS')) {
      await this.healPaidOrderState(orderNumber);
      return;
    }

    if (this.isOrderPastPaymentPhase(order.status)) return;
    if (!['PAYMENT_PENDING', 'FAILED'].includes(order.status)) return;

    try {
      const paid = await this.reconcileRazorpayPaidOrder(orderNumber, order.payments[0]);
      if (paid) return;
    } catch (error) {
      logger.warn('Razorpay verify before payment failure skipped', { orderNumber, error });
    }

    let markedFailed = false;

    await runPrismaTransaction(async (tx) => {
      const latestPayments = await tx.payment.findMany({ where: { orderId: order.id } });
      if (latestPayments.some((payment) => payment.status === 'SUCCESS')) {
        return;
      }

      await tx.order.update({
        where: { id: order.id },
        data: { status: 'FAILED' },
      });

      await tx.trackingHistory.create({
        data: {
          orderId: order.id,
          status: 'FAILED',
          description: reason
            ? `Payment failed: ${reason}`
            : 'Payment failed. If any amount was debited, it will be auto-refunded within 3 to 7 working days.',
        },
      });

      await tx.payment.updateMany({
        where: { orderId: order.id, status: { not: 'SUCCESS' } },
        data: { status: 'FAILED', failureReason: reason },
      });

      const items = await tx.orderItem.findMany({ where: { orderId: order.id } });
      for (const item of items) {
        const inventory = await tx.inventory.findFirst({
          where: { productColorId: item.productColorId },
        });
        if (inventory) {
          await tx.inventory.update({
            where: { id: inventory.id },
            data: { reserved: { decrement: item.quantity } },
          });
        }
      }

      if (order.couponId) {
        await this.restoreCouponFromOrder(tx, order.couponId, Number(order.discountAmount));
      }

      markedFailed = true;
    });

    if (markedFailed) {
      invalidateCache('product:');
      invalidateCache('products:');
      invalidateCache('storefront:');
      realtime.orderStatusChanged({
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: 'FAILED',
        customerPhone: order.customerPhone,
        grandTotal: Number(order.grandTotal),
      });
    }
  }

  private customerOrderInclude() {
    return {
      items: true,
      shipping: true,
      trackingHistory: { orderBy: { timestamp: 'desc' as const } },
      payments: { select: { status: true, method: true } },
      returnRequests: {
        orderBy: { createdAt: 'desc' as const },
        include: {
          images: { orderBy: { sortOrder: 'asc' as const } },
          trackingHistory: { orderBy: { timestamp: 'desc' as const } },
          items: {
            include: {
              orderItem: {
                select: {
                  id: true,
                  productName: true,
                  colorName: true,
                  sku: true,
                  imageUrl: true,
                  quantity: true,
                  unitPrice: true,
                  totalPrice: true,
                },
              },
            },
          },
        },
      },
    } satisfies Prisma.OrderInclude;
  }

  private async fetchCustomerOrdersByPhone(phone: string) {
    const variants = customerPhoneLookupVariants(phone);
    return prisma.order.findMany({
      where: {
        deletedAt: null,
        customerPhone: { in: variants.length > 0 ? variants : [phone] },
      },
      include: this.customerOrderInclude(),
      orderBy: { createdAt: 'desc' },
    });
  }

  async findByPhone(phone: string) {
    const orders = await this.fetchCustomerOrdersByPhone(phone);

    void this.reconcileCustomerOrdersInBackground(orders).catch((err) =>
      logger.warn('Background customer order reconcile failed', { phone, err }),
    );

    return this.normalizeCustomerOrders(orders);
  }

  private async reconcileCustomerOrdersInBackground(
    orders: Array<{
      id: string;
      orderNumber: string;
      status: OrderStatus;
      refundedAt: Date | null;
      refundAmount?: Prisma.Decimal | number | null;
      payments: Array<{ status: string; updatedAt?: Date }>;
      trackingHistory?: Array<{ status: string }>;
    }>,
  ) {
    const healPaidTargets = orders.filter(
      (order) =>
        order.payments.some((payment) => payment.status === 'SUCCESS') &&
        ['FAILED', 'PAYMENT_PENDING'].includes(order.status),
    );

    if (healPaidTargets.length > 0) {
      await Promise.all(
        healPaidTargets.map((order) =>
          this.healPaidOrderState(order.orderNumber).catch((err) =>
            logger.warn('Background paid-order heal failed', {
              orderNumber: order.orderNumber,
              err,
            }),
          ),
        ),
      );
    }

    // Sync recent pending payments with Razorpay so failed attempts don't stay pending forever.
    // Non-blocking for the lookup response; realtime/next refresh picks up FAILED.
    const pendingTargets = orders
      .filter(
        (order) =>
          order.status === 'PAYMENT_PENDING' &&
          order.payments.some((payment) => payment.status === 'PENDING'),
      )
      .slice(0, 5);

    if (pendingTargets.length > 0) {
      await Promise.all(
        pendingTargets.map((order) =>
          this.syncPaymentStatus(order.orderNumber).catch((err) =>
            logger.warn('Background pending payment sync failed', {
              orderNumber: order.orderNumber,
              err,
            }),
          ),
        ),
      );
    }

    await this.healRefundedOrders(orders);
  }

  /**
   * Admin may keep the same status, or move along the fulfillment path.
   * READY_TO_SHIP is NOT settable here — only Create Shipment (Shiprocket) may set it.
   */
  private assertValidStatusTransition(from: OrderStatus, to: OrderStatus) {
    if (from === to) return;

    if (to === 'READY_TO_SHIP') {
      throw new ApiError(
        400,
        'Ready to Ship can only be set by Create Shipment (Shiprocket). Do not change status manually.',
      );
    }

    const allowed: Record<OrderStatus, OrderStatus[]> = {
      PAYMENT_PENDING: ['PLACED', 'FAILED', 'CANCELLED'],
      PLACED: ['CONFIRMED', 'CANCELLED', 'FAILED'],
      CONFIRMED: ['CANCELLED', 'RTO'],
      READY_TO_SHIP: ['SHIPPED', 'CANCELLED', 'RTO'],
      SHIPPED: ['IN_TRANSIT', 'DELIVERED', 'RTO'],
      IN_TRANSIT: ['DELIVERED', 'RTO'],
      DELIVERED: ['RETURNED', 'REFUNDED'],
      RETURNED: ['REFUNDED'],
      RTO: ['CONFIRMED', 'CANCELLED', 'REFUNDED'],
      FAILED: ['PAYMENT_PENDING', 'CANCELLED'],
      CANCELLED: [],
      REFUNDED: [],
    };

    const next = allowed[from] ?? [];
    if (!next.includes(to)) {
      throw new ApiError(400, `Cannot change order status from ${from} to ${to}`);
    }
  }

  /** True when Shiprocket create-shipment completed (shipment id + AWB). */
  static hasShiprocketShipment(
    shipping:
      | {
          method?: string | null;
          shiprocketShipmentId?: string | null;
          awbCode?: string | null;
        }
      | null
      | undefined,
  ): boolean {
    return Boolean(
      shipping &&
      shipping.method === 'SHIPROCKET' &&
      shipping.shiprocketShipmentId &&
      shipping.awbCode,
    );
  }

  private isCustomerOrderRefunded(order: {
    status: OrderStatus;
    refundedAt: Date | null;
    refundAmount?: Prisma.Decimal | number | null;
    payments: Array<{ status: string }>;
    trackingHistory?: Array<{ status: string }>;
  }): boolean {
    return (
      order.status === 'REFUNDED' ||
      order.refundedAt != null ||
      order.refundAmount != null ||
      order.payments.some((payment) => payment.status === 'REFUNDED') ||
      (order.trackingHistory?.some((entry) => entry.status === 'REFUNDED') ?? false)
    );
  }

  private async healRefundedOrders(
    orders: Array<{
      id: string;
      status: OrderStatus;
      refundedAt: Date | null;
      refundAmount?: Prisma.Decimal | number | null;
      payments: Array<{ status: string }>;
      trackingHistory?: Array<{ status: string }>;
    }>,
  ) {
    const toHeal = orders.filter(
      (order) => this.isCustomerOrderRefunded(order) && order.status !== 'REFUNDED',
    );

    await Promise.all(
      toHeal.map(async (order) => {
        try {
          await runPrismaTransaction(async (tx) => {
            await tx.order.update({
              where: { id: order.id },
              data: { status: 'REFUNDED' },
            });

            const hasRefundedTracking = order.trackingHistory?.some(
              (entry) => entry.status === 'REFUNDED',
            );
            if (!hasRefundedTracking) {
              await tx.trackingHistory.create({
                data: {
                  orderId: order.id,
                  status: 'REFUNDED',
                  description: 'Refund successfully processed',
                },
              });
            }
          });
        } catch (error) {
          logger.warn('Failed to heal refunded order status', {
            orderId: order.id,
            error,
          });
        }
      }),
    );

    if (toHeal.length > 0) {
      invalidateCache('dashboard:');
    }
  }

  private normalizeCustomerOrders<
    T extends {
      status: OrderStatus;
      refundedAt: Date | null;
      payments: Array<{ status: string }>;
    },
  >(orders: T[]): T[] {
    return orders.map((order) => {
      if (this.isCustomerOrderRefunded(order) && order.status !== 'REFUNDED') {
        return { ...order, status: 'REFUNDED' };
      }
      if (
        order.payments.some((payment) => payment.status === 'SUCCESS') &&
        ['FAILED', 'PAYMENT_PENDING'].includes(order.status)
      ) {
        return { ...order, status: 'PLACED' };
      }
      return order;
    });
  }

  async findAll(query: Record<string, string>) {
    // Kick Razorpay sync in the background — do not block list TTFB.
    if (query.status === 'PAYMENT_PENDING' || !query.status) {
      this.scheduleStalePendingSync(query.status === 'PAYMENT_PENDING' ? 30 : 10);
    }
    // Keep Ready-to-Ship aligned with Shiprocket cancellations (no manual admin cancel).
    if (query.status === 'READY_TO_SHIP' || !query.status) {
      shippingService.scheduleShiprocketCancellationSync();
    }

    const { page, limit, skip } = parsePagination(query);
    const where: Prisma.OrderWhereInput = { deletedAt: null };
    const andFilters: Prisma.OrderWhereInput[] = [];

    if (query.status) {
      if (query.status === 'PLACED') {
        andFilters.push({
          status: 'PLACED',
          payments: { some: { status: 'SUCCESS' } },
        });
      } else if (query.status === 'PAYMENT_PENDING') {
        andFilters.push({
          OR: [
            { status: 'PAYMENT_PENDING' },
            {
              status: 'PLACED',
              payments: { none: { status: 'SUCCESS' } },
            },
          ],
        });
      } else if (query.status === 'RETURNED') {
        andFilters.push({
          status: 'RETURNED',
          refundedAt: null,
          payments: { none: { status: 'REFUNDED' } },
        });
      } else if (query.status === 'REFUNDED') {
        andFilters.push({
          OR: [
            { status: 'REFUNDED' },
            { refundedAt: { not: null } },
            { payments: { some: { status: 'REFUNDED' } } },
          ],
        });
      } else {
        where.status = query.status as OrderStatus;
      }
    }
    if (query.isAdminOrder === 'true') where.isAdminOrder = true;
    if (query.isAdminOrder === 'false') where.isAdminOrder = false;
    if (query.search) {
      const search = query.search.trim();
      const searchOr: Prisma.OrderWhereInput[] = [
        { orderNumber: { contains: search, mode: 'insensitive' } },
        { customerName: { contains: search, mode: 'insensitive' } },
        { customerPhone: { contains: search } },
        { customerEmail: { contains: search, mode: 'insensitive' } },
      ];
      // Short order IDs are the last 8 chars — match suffix searches too.
      if (search.length >= 4 && search.length <= 12) {
        searchOr.push({ orderNumber: { endsWith: search, mode: 'insensitive' } });
      }
      andFilters.push({ OR: searchOr });
    }

    const deliveryType = (query.deliveryType || 'ALL').toUpperCase();
    const indiaAddressFilter: Prisma.OrderWhereInput = {
      OR: [
        { shippingAddress: { path: ['countryCode'], equals: 'IN' } },
        { shippingAddress: { path: ['country'], equals: 'India' } },
        { shippingAddress: { path: ['country'], equals: 'india' } },
        { shippingAddress: { path: ['country'], equals: 'IN' } },
      ],
    };
    // Prisma JSON NOT equals misses rows without the key — match STANDARD / null instead.
    const nonQuickShippingFilter: Prisma.OrderWhereInput = {
      OR: [
        { shippingAddress: { path: ['preferredShipping'], equals: Prisma.DbNull } },
        { shippingAddress: { path: ['preferredShipping'], equals: Prisma.JsonNull } },
        { shippingAddress: { path: ['preferredShipping'], equals: 'STANDARD' } },
      ],
    };

    if (deliveryType === 'QUICK') {
      andFilters.push({
        shippingAddress: { path: ['preferredShipping'], equals: 'QUICK' },
      });
    } else if (deliveryType === 'INDIA') {
      andFilters.push({
        AND: [indiaAddressFilter, nonQuickShippingFilter],
      });
    } else if (deliveryType === 'INTERNATIONAL') {
      andFilters.push({
        AND: [nonQuickShippingFilter, { NOT: indiaAddressFilter }],
      });
    }

    const createdAt = parseCreatedAtFilter(query);
    if (createdAt) where.createdAt = createdAt;

    if (andFilters.length > 0) {
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        ...andFilters,
      ];
    }

    const sortBy = (query.sortBy || 'createdAt') as
      'createdAt' | 'updatedAt' | 'grandTotal' | 'orderNumber';
    const sortOrder = query.sortOrder === 'asc' ? 'asc' : 'desc';

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          customerName: true,
          customerPhone: true,
          grandTotal: true,
          shippingAddress: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { [sortBy]: sortOrder },
        skip,
        take: limit,
      }),
      prisma.order.count({ where }),
    ]);

    return { orders, meta: buildPaginationMeta(page, limit, total) };
  }

  async bulkUpdateStatus(orderIds: string[], status: OrderStatus, notes?: string) {
    const uniqueIds = [...new Set(orderIds)];
    const results = await Promise.allSettled(
      uniqueIds.map((id) => this.updateStatus(id, status, notes)),
    );

    const succeeded: string[] = [];
    const failed: Array<{ orderId: string; message: string }> = [];

    results.forEach((result, index) => {
      const orderId = uniqueIds[index]!;
      if (result.status === 'fulfilled') {
        succeeded.push(orderId);
        return;
      }
      const reason = result.reason;
      failed.push({
        orderId,
        message: reason instanceof ApiError ? reason.message : 'Failed to update status',
      });
    });

    return {
      succeeded,
      failed,
      successCount: succeeded.length,
      failedCount: failed.length,
    };
  }

  async findByIdsForPrint(orderIds: string[]) {
    const uniqueIds = [...new Set(orderIds)];
    const orders = await prisma.order.findMany({
      where: { id: { in: uniqueIds }, deletedAt: null },
      include: {
        items: {
          include: {
            productColor: { select: { name: true } },
          },
        },
        shipping: true,
        payments: { select: { status: true, method: true, createdAt: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const byId = new Map(orders.map((o) => [o.id, o]));
    // Preserve requested order for print consistency
    return uniqueIds.map((id) => byId.get(id)).filter(Boolean);
  }

  /**
   * Escalation lookup — order number, UUID, phone, or email (no status filter).
   */
  async searchEscalation(q: string) {
    const query = q.trim();
    if (!query) return [];

    const digits = query.replace(/\D/g, '');
    const phoneTail = digits.length >= 10 ? digits.slice(-10) : digits;

    const or: Prisma.OrderWhereInput[] = [
      { orderNumber: { contains: query, mode: 'insensitive' } },
      { customerEmail: { contains: query, mode: 'insensitive' } },
      { customerName: { contains: query, mode: 'insensitive' } },
      { customerPhone: { contains: query } },
    ];

    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(query)) {
      or.push({ id: query });
    }
    if (phoneTail.length >= 7) {
      or.push({ customerPhone: { contains: phoneTail } });
    }
    if (query.length >= 4 && query.length <= 12) {
      or.push({ orderNumber: { endsWith: query, mode: 'insensitive' } });
    }

    return prisma.order.findMany({
      where: { deletedAt: null, OR: or },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        customerName: true,
        customerPhone: true,
        customerEmail: true,
        grandTotal: true,
        refundedAt: true,
        refundCouponCode: true,
        createdAt: true,
        updatedAt: true,
        payments: {
          orderBy: { createdAt: 'desc' as const },
          take: 1,
          select: { status: true, method: true, amount: true },
        },
        trackingHistory: {
          orderBy: { timestamp: 'desc' as const },
          take: 20,
          select: { status: true, timestamp: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 30,
    });
  }

  /**
   * Full escalation update — bypasses normal status transition and refund locks.
   */
  async applyEscalation(
    id: string,
    data: {
      status?: OrderStatus;
      customerName?: string;
      customerPhone?: string;
      customerEmail?: string;
      shippingAddress?: Partial<ShippingAddress> & Record<string, unknown>;
      notes?: string;
      clearRefundMarkers?: boolean;
      reason?: string;
    },
  ) {
    const order = await prisma.order.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        grandTotal: true,
        customerName: true,
        customerPhone: true,
        customerEmail: true,
        shippingAddress: true,
        notes: true,
        couponId: true,
        discountAmount: true,
        refundedAt: true,
        refundAmount: true,
        refundCouponId: true,
        refundCouponCode: true,
        items: {
          select: { productId: true, productColorId: true, quantity: true },
        },
        payments: {
          select: { id: true, status: true, amount: true },
        },
      },
    });
    if (!order) throw new ApiError(404, 'Order not found');

    const previousStatus = order.status;
    const nextStatus = data.status ?? previousStatus;
    const statusChanged = data.status !== undefined && data.status !== previousStatus;
    const reason = data.reason?.trim() || 'Admin escalation override';

    const existingAddress = (order.shippingAddress ?? {}) as unknown as ShippingAddress;
    let nextAddress: ShippingAddress | undefined;
    if (data.shippingAddress) {
      nextAddress = {
        ...existingAddress,
        ...Object.fromEntries(
          Object.entries(data.shippingAddress).filter(([, v]) => v !== undefined),
        ),
      } as ShippingAddress;
    }

    const stockDeductedStatuses: OrderStatus[] = [
      'CONFIRMED',
      'READY_TO_SHIP',
      'SHIPPED',
      'IN_TRANSIT',
      'DELIVERED',
      'RETURNED',
      'RTO',
      'REFUNDED',
    ];
    const reservedStatuses: OrderStatus[] = ['PLACED', 'PAYMENT_PENDING'];
    const wasStockDeducted = stockDeductedStatuses.includes(previousStatus);
    const willBeStockDeducted = stockDeductedStatuses.includes(nextStatus);
    const wasReserved = reservedStatuses.includes(previousStatus);
    const willBeReserved = reservedStatuses.includes(nextStatus);
    const willCancel = nextStatus === 'CANCELLED' || nextStatus === 'FAILED';
    /** Any status after a successful payment phase — must not stay unpaid or sync will revert. */
    const needsSuccessfulPayment =
      statusChanged && !['PAYMENT_PENDING', 'FAILED'].includes(nextStatus);
    const needsPendingPayment = statusChanged && nextStatus === 'PAYMENT_PENDING';
    const needsFailedPayment = statusChanged && nextStatus === 'FAILED';
    const recoverReservedFromFailed =
      previousStatus === 'FAILED' && (nextStatus === 'PLACED' || nextStatus === 'PAYMENT_PENDING');

    await runPrismaTransaction(async (tx) => {
      const patch: Prisma.OrderUpdateInput = {
        ...(data.customerName !== undefined && { customerName: data.customerName }),
        ...(data.customerPhone !== undefined && { customerPhone: data.customerPhone }),
        ...(data.customerEmail !== undefined && { customerEmail: data.customerEmail }),
        ...(data.notes !== undefined && { notes: data.notes }),
        ...(nextAddress && {
          shippingAddress: nextAddress as unknown as Prisma.InputJsonValue,
        }),
        ...(statusChanged && { status: nextStatus }),
      };

      if (data.clearRefundMarkers) {
        patch.refundedAt = null;
        patch.refundAmount = null;
        patch.refundDeduction = null;
        patch.refundCouponCode = null;
        patch.refundCoupon = { disconnect: true };
      }

      if (Object.keys(patch).length > 0) {
        await tx.order.update({ where: { id }, data: patch });
      }

      if (statusChanged) {
        await tx.trackingHistory.create({
          data: {
            orderId: id,
            status: nextStatus,
            description: `Escalation: ${previousStatus} → ${nextStatus}. ${reason}`,
          },
        });

        // Keep payment in sync with order status so Razorpay sync cannot overwrite escalation.
        const hasSuccessfulPayment = order.payments.some((p) => p.status === 'SUCCESS');
        if (needsSuccessfulPayment && !hasSuccessfulPayment) {
          if (order.payments.length === 0) {
            await tx.payment.create({
              data: {
                orderId: id,
                amount: order.grandTotal,
                currency: 'INR',
                status: 'SUCCESS',
                method: 'ADMIN',
                transactionId: 'ESCALATION',
                failureReason: null,
              },
            });
          } else {
            await tx.payment.updateMany({
              where: { orderId: id, status: { not: 'SUCCESS' } },
              data: {
                status: 'SUCCESS',
                method: 'ADMIN',
                transactionId: 'ESCALATION',
                failureReason: null,
              },
            });
          }
          await tx.trackingHistory.create({
            data: {
              orderId: id,
              status: nextStatus,
              description:
                'Escalation: payment marked successful so the order stays placed (admin override)',
            },
          });
        }

        if (needsPendingPayment) {
          await tx.payment.updateMany({
            where: { orderId: id, status: { not: 'SUCCESS' } },
            data: { status: 'PENDING', failureReason: null },
          });
        }

        if (needsFailedPayment) {
          await tx.payment.updateMany({
            where: { orderId: id, status: { not: 'SUCCESS' } },
            data: {
              status: 'FAILED',
              failureReason: reason,
            },
          });
        }

        // Payment-failed orders already released reserved stock — re-hold when recovering.
        if (recoverReservedFromFailed) {
          await this.reserveInventoryForItems(
            tx,
            order.items.map((item) => ({
              productId: item.productId,
              productColorId: item.productColorId,
              quantity: item.quantity,
            })),
          );
        }

        // Inventory: confirm when entering deducted pipeline from reserved
        if (
          !wasStockDeducted &&
          willBeStockDeducted &&
          (wasReserved ||
            recoverReservedFromFailed ||
            previousStatus === 'CANCELLED' ||
            previousStatus === 'FAILED')
        ) {
          await this.confirmOrderInventory(tx, id, order.items);
        }

        // Inventory: release reserved when cancelling from placed/pending
        if (willCancel && (wasReserved || recoverReservedFromFailed)) {
          // If we just re-reserved then cancel in same request, still release.
          await this.releaseReservedInventory(tx, order.items);
          if (order.couponId) {
            await this.restoreCouponFromOrder(tx, order.couponId, Number(order.discountAmount));
          }
        }

        // Inventory: restore sold stock when leaving deducted pipeline to cancel/fail/placed
        if (wasStockDeducted && (willCancel || willBeReserved) && !willBeStockDeducted) {
          await this.restoreConfirmedInventory(tx, id, order.items);
          if (willCancel && order.couponId) {
            await this.restoreCouponFromOrder(tx, order.couponId, Number(order.discountAmount));
          }
        }

        if (nextStatus === 'RETURNED') {
          await syncReturnRequestFromOrderStatus(tx, id, nextStatus);
        }
      } else if (data.reason?.trim()) {
        await tx.trackingHistory.create({
          data: {
            orderId: id,
            status: previousStatus,
            description: `Escalation update: ${reason}`,
          },
        });
      }
    });

    if (
      statusChanged &&
      [
        'PLACED',
        'CONFIRMED',
        'READY_TO_SHIP',
        'SHIPPED',
        'IN_TRANSIT',
        'DELIVERED',
        'CANCELLED',
        'REFUNDED',
        'RTO',
        'RETURNED',
        'FAILED',
        'PAYMENT_PENDING',
      ].includes(nextStatus)
    ) {
      void this.sendStatusNotification(id, nextStatus).catch((err) =>
        logger.warn('Escalation status notification failed', {
          orderId: id,
          status: nextStatus,
          err,
        }),
      );
    }

    invalidateCache('dashboard:');
    if (
      statusChanged &&
      (nextStatus === 'CONFIRMED' || nextStatus === 'CANCELLED' || previousStatus === 'CONFIRMED')
    ) {
      invalidateCache('product:');
      invalidateCache('products:');
      invalidateCache('storefront:');
      realtime.catalogChanged('order-escalation');
    }

    realtime.orderStatusChanged({
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: nextStatus,
      customerPhone: data.customerPhone ?? order.customerPhone,
      grandTotal: Number(order.grandTotal),
    });

    return this.findByIdWithoutPaymentSync(id);
  }

  async findById(id: string) {
    const order = await this.findByIdWithoutPaymentSync(id);

    if (
      order.status === 'PAYMENT_PENDING' ||
      (order.status === 'PLACED' && !order.payments.some((payment) => payment.status === 'SUCCESS'))
    ) {
      // Don't block admin detail on Razorpay — background sync emits realtime if status changes
      void this.syncPaymentStatus(order.orderNumber).catch((err) =>
        logger.warn('Order detail payment sync skipped', {
          orderNumber: order.orderNumber,
          err,
        }),
      );
    }

    return order;
  }

  /**
   * Load order for admin mutations. Skips Razorpay payment sync so confirm/save
   * stay fast (sync runs on detail GET / list stale-pending kick instead).
   */
  private async findByIdWithoutPaymentSync(id: string) {
    const order = await prisma.order.findFirst({
      where: { id, deletedAt: null },
      include: orderDetailInclude,
    });
    if (!order) throw new ApiError(404, 'Order not found');

    const needsHeal = this.isCustomerOrderRefunded(order) && order.status !== 'REFUNDED';
    if (!needsHeal) return order;

    await this.healRefundedOrders([order]);

    const healed = await prisma.order.findFirst({
      where: { id, deletedAt: null },
      include: orderDetailInclude,
    });
    if (!healed) throw new ApiError(404, 'Order not found');
    return healed;
  }

  async updateStatus(id: string, status: OrderStatus, notes?: string) {
    const order = await prisma.order.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        grandTotal: true,
        customerPhone: true,
        couponId: true,
        discountAmount: true,
        refundedAt: true,
        refundAmount: true,
        items: {
          select: { productId: true, productColorId: true, quantity: true },
        },
        payments: { select: { status: true } },
        trackingHistory: { select: { status: true }, take: 20 },
      },
    });
    if (!order) throw new ApiError(404, 'Order not found');

    if (this.isCustomerOrderRefunded(order) && status !== 'REFUNDED') {
      throw new ApiError(400, 'Refunded orders cannot be changed to another status');
    }

    if (status === 'RETURNED' && this.isCustomerOrderRefunded(order)) {
      throw new ApiError(400, 'This order has already been refunded');
    }

    if (order.status === 'REFUNDED' && status !== 'REFUNDED') {
      throw new ApiError(400, 'Refunded orders cannot be changed to another status');
    }

    this.assertValidStatusTransition(order.status, status);

    const confirming =
      status === 'CONFIRMED' && ['PLACED', 'PAYMENT_PENDING'].includes(order.status);
    const cancelling =
      status === 'CANCELLED' && ['PLACED', 'PAYMENT_PENDING'].includes(order.status);

    await runPrismaTransaction(async (tx) => {
      await Promise.all([
        tx.order.update({
          where: { id },
          data: { status, ...(notes !== undefined && { notes }) },
        }),
        tx.trackingHistory.create({
          data: {
            orderId: id,
            status,
            description: getOrderStatusTrackingDescription(status),
          },
        }),
      ]);

      if (status === 'RETURNED') {
        await syncReturnRequestFromOrderStatus(tx, id, status);
      }

      if (confirming) {
        await this.confirmOrderInventory(tx, id, order.items);
      }

      if (cancelling) {
        await this.releaseReservedInventory(tx, order.items);
        if (order.couponId) {
          await this.restoreCouponFromOrder(tx, order.couponId, Number(order.discountAmount));
        }
      }
    });

    if (
      [
        'PLACED',
        'CONFIRMED',
        'READY_TO_SHIP',
        'SHIPPED',
        'IN_TRANSIT',
        'DELIVERED',
        'CANCELLED',
        'REFUNDED',
        'RTO',
        'RETURNED',
        'FAILED',
        'PAYMENT_PENDING',
      ].includes(status)
    ) {
      void this.sendStatusNotification(id, status).catch((err) =>
        logger.warn('Status notification failed', { orderId: id, status, err }),
      );
    }

    invalidateCache('dashboard:');
    realtime.orderStatusChanged({
      orderId: order.id,
      orderNumber: order.orderNumber,
      status,
      customerPhone: order.customerPhone,
      grandTotal: Number(order.grandTotal),
    });
    if (status === 'CONFIRMED' || status === 'CANCELLED') {
      invalidateCache('product:');
      invalidateCache('products:');
      invalidateCache('storefront:');
      realtime.catalogChanged('order-status');
    }

    // Skip heavy detail reload — bulk confirm and status PATCH only need scalars.
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status,
      customerPhone: order.customerPhone,
      grandTotal: order.grandTotal,
      notes: notes !== undefined ? notes : undefined,
    };
  }

  async updateOrderDetails(
    id: string,
    data: {
      customerName?: string;
      customerPhone?: string;
      customerEmail?: string;
      shippingAddress?: ShippingAddress;
      status?: OrderStatus;
      notes?: string;
      items?: Array<{
        id: string;
        weight?: number | null;
        length?: number | null;
        width?: number | null;
        height?: number | null;
      }>;
    },
  ) {
    // Light load for validation — avoid full detail include before write
    const order = await prisma.order.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        grandTotal: true,
        customerName: true,
        customerPhone: true,
        customerEmail: true,
        shippingAddress: true,
        couponId: true,
        discountAmount: true,
        refundedAt: true,
        refundAmount: true,
        items: {
          select: {
            id: true,
            productId: true,
            productColorId: true,
            quantity: true,
            weight: true,
            length: true,
            width: true,
            height: true,
          },
        },
        payments: { select: { status: true } },
        trackingHistory: { select: { status: true }, take: 20 },
      },
    });
    if (!order) throw new ApiError(404, 'Order not found');

    const statusChanged = data.status !== undefined && order.status !== data.status;
    const existingAddress = order.shippingAddress as unknown as ShippingAddress;

    let shippingAddress: ShippingAddress | undefined;
    let addressChanged = false;
    if (data.shippingAddress) {
      addressChanged =
        shippingAddressFingerprint(existingAddress) !==
        shippingAddressFingerprint(data.shippingAddress);
      shippingAddress = geocodingService.resolveCoordinatesForCheckout({
        ...data.shippingAddress,
        ...(!addressChanged
          ? {
              latitude: existingAddress.latitude ?? data.shippingAddress.latitude,
              longitude: existingAddress.longitude ?? data.shippingAddress.longitude,
            }
          : {}),
      });
    }

    if (statusChanged && data.status) {
      if (this.isCustomerOrderRefunded(order) && data.status !== 'REFUNDED') {
        throw new ApiError(400, 'Refunded orders cannot be changed to another status');
      }
      if (data.status === 'RETURNED' && this.isCustomerOrderRefunded(order)) {
        throw new ApiError(400, 'This order has already been refunded');
      }
      if (order.status === 'REFUNDED' && data.status !== 'REFUNDED') {
        throw new ApiError(400, 'Refunded orders cannot be changed to another status');
      }
      this.assertValidStatusTransition(order.status, data.status);
    }

    const itemUpdates = (data.items ?? []).filter((item) => {
      const current = order.items.find((row) => row.id === item.id);
      if (!current) return false;
      const sameWeight =
        item.weight === undefined ||
        Number(current.weight ?? NaN) === Number(item.weight ?? NaN) ||
        (current.weight == null && item.weight == null);
      const sameLength =
        item.length === undefined ||
        Number(current.length ?? NaN) === Number(item.length ?? NaN) ||
        (current.length == null && item.length == null);
      const sameWidth =
        item.width === undefined ||
        Number(current.width ?? NaN) === Number(item.width ?? NaN) ||
        (current.width == null && item.width == null);
      const sameHeight =
        item.height === undefined ||
        Number(current.height ?? NaN) === Number(item.height ?? NaN) ||
        (current.height == null && item.height == null);
      return !(sameWeight && sameLength && sameWidth && sameHeight);
    });

    let packageDims: ReturnType<OrderService['computePackageDimensionsFromItems']> | null = null;
    if (itemUpdates.length > 0) {
      const specsById = new Map(itemUpdates.map((item) => [item.id, item]));
      packageDims = this.computePackageDimensionsFromItems(
        order.items.map((item) => {
          const patch = specsById.get(item.id);
          return {
            quantity: item.quantity,
            length: patch?.length !== undefined ? patch.length : item.length,
            width: patch?.width !== undefined ? patch.width : item.width,
            height: patch?.height !== undefined ? patch.height : item.height,
          };
        }),
      );
    }

    const orderPatch: Prisma.OrderUpdateInput = {
      ...(data.customerName !== undefined && { customerName: data.customerName }),
      ...(data.customerPhone !== undefined && { customerPhone: data.customerPhone }),
      ...(data.customerEmail !== undefined && { customerEmail: data.customerEmail }),
      ...(shippingAddress !== undefined && {
        shippingAddress: shippingAddress as unknown as Prisma.InputJsonValue,
      }),
      ...(data.status !== undefined && { status: data.status }),
      ...(data.notes !== undefined && { notes: data.notes }),
      ...(packageDims ?? {}),
    };

    const hasOrderPatch = Object.keys(orderPatch).length > 0;
    const hasItemUpdates = itemUpdates.length > 0;
    const hasStatusSideEffects = statusChanged;

    if (!hasOrderPatch && !hasItemUpdates && !hasStatusSideEffects) {
      return this.findByIdWithoutPaymentSync(id);
    }

    const confirming =
      statusChanged &&
      data.status === 'CONFIRMED' &&
      ['PLACED', 'PAYMENT_PENDING'].includes(order.status);
    const cancelling =
      statusChanged &&
      data.status === 'CANCELLED' &&
      ['PLACED', 'PAYMENT_PENDING'].includes(order.status);
    const statusOnlyPatch =
      statusChanged &&
      !hasItemUpdates &&
      data.customerName === undefined &&
      data.customerPhone === undefined &&
      data.customerEmail === undefined &&
      data.shippingAddress === undefined;

    await runPrismaTransaction(async (tx) => {
      const writes: Promise<unknown>[] = [];

      if (hasOrderPatch) {
        writes.push(
          tx.order.update({
            where: { id },
            data: orderPatch,
          }),
        );
      }

      if (statusChanged && data.status) {
        writes.push(
          tx.trackingHistory.create({
            data: {
              orderId: id,
              status: data.status,
              description: getOrderStatusTrackingDescription(data.status),
            },
          }),
        );
      }

      if (writes.length > 0) {
        await Promise.all(writes);
      }

      if (confirming) {
        await this.confirmOrderInventory(tx, id, order.items);
      }

      if (cancelling) {
        await this.releaseReservedInventory(tx, order.items);
        if (order.couponId) {
          await this.restoreCouponFromOrder(tx, order.couponId, Number(order.discountAmount));
        }
      }

      if (hasItemUpdates) {
        await Promise.all(
          itemUpdates.map((item) =>
            tx.orderItem.update({
              where: { id: item.id },
              data: {
                ...(item.weight !== undefined && { weight: item.weight }),
                ...(item.length !== undefined && { length: item.length }),
                ...(item.width !== undefined && { width: item.width }),
                ...(item.height !== undefined && { height: item.height }),
              },
            }),
          ),
        );
      }
    });

    if (
      statusChanged &&
      data.status &&
      [
        'PLACED',
        'CONFIRMED',
        'READY_TO_SHIP',
        'SHIPPED',
        'IN_TRANSIT',
        'DELIVERED',
        'CANCELLED',
        'REFUNDED',
        'RTO',
        'RETURNED',
        'FAILED',
        'PAYMENT_PENDING',
      ].includes(data.status)
    ) {
      void this.sendStatusNotification(id, data.status).catch((err) =>
        logger.warn('Status notification failed', { orderId: id, status: data.status, err }),
      );
    }

    if (
      shippingAddress &&
      (shippingAddress.latitude == null || shippingAddress.longitude == null)
    ) {
      void this.enrichOrderCoordinates(id, shippingAddress).catch((err) =>
        logger.warn('Background geocoding failed', { orderId: id, err }),
      );
    }

    if (statusChanged && data.status) {
      invalidateCache('dashboard:');
      realtime.orderStatusChanged({
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: data.status,
        customerPhone: data.customerPhone ?? order.customerPhone,
        grandTotal: Number(order.grandTotal),
      });
      if (data.status === 'CONFIRMED' || data.status === 'CANCELLED') {
        invalidateCache('product:');
        invalidateCache('products:');
        invalidateCache('storefront:');
        realtime.catalogChanged('order-status');
      }
    }

    // Status-only update: skip heavy detail reload so admin save returns fast.
    // Client already applied optimistic status; merge this patch onto cached order.
    if (statusOnlyPatch && data.status) {
      return {
        id: order.id,
        orderNumber: order.orderNumber,
        status: data.status,
        notes: data.notes !== undefined ? data.notes : undefined,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        customerEmail: order.customerEmail,
        grandTotal: order.grandTotal,
      };
    }

    return this.findByIdWithoutPaymentSync(id);
  }

  async retryPayment(orderNumber: string) {
    await this.syncPaymentStatus(orderNumber).catch(() => undefined);

    const order = await prisma.order.findFirst({
      where: { orderNumber },
      include: { payments: true },
    });
    if (!order) throw new ApiError(404, 'Order not found');

    if (order.payments.some((payment) => payment.status === 'SUCCESS')) {
      throw new ApiError(400, 'This order is already paid');
    }

    if (order.status === 'FAILED') {
      throw new ApiError(400, 'Payment failed for this order. Please place a new order.');
    }

    if (order.status !== 'PAYMENT_PENDING') {
      throw new ApiError(400, 'This order cannot accept another payment');
    }

    const payment = order.payments[0];
    if (!payment || payment.status !== 'PENDING') {
      throw new ApiError(400, 'This order cannot accept another payment');
    }

    if (Number(order.grandTotal) <= 0) {
      throw new ApiError(400, 'No payment is required for this order');
    }

    // Reuse an existing Razorpay session when one is still open — avoid duplicate charges.
    const existingRazorpayOrderId = payment.razorpayOrderId?.trim();
    if (existingRazorpayOrderId) {
      try {
        const rzOrder = await razorpayService.getOrder(existingRazorpayOrderId);
        const rzStatus = String(rzOrder.status || '').toLowerCase();
        if (rzStatus === 'paid') {
          await this.syncPaymentStatus(orderNumber);
          throw new ApiError(400, 'This order is already paid');
        }
        if (rzStatus === 'created' || rzStatus === 'attempted') {
          return {
            razorpayOrderId: existingRazorpayOrderId,
            keyId: razorpayService.getPublicKeyId(),
            amount: Number(rzOrder.amount),
            currency: String(rzOrder.currency || 'INR'),
          };
        }
      } catch (error) {
        if (error instanceof ApiError) throw error;
        logger.warn('Existing Razorpay order check failed; creating a new session', {
          orderNumber,
          error,
        });
      }
    }

    await runPrismaTransaction(async (tx) => {
      await tx.trackingHistory.create({
        data: {
          orderId: order.id,
          status: 'PAYMENT_PENDING',
          description: 'Payment attempt started. Waiting for payment confirmation.',
        },
      });
    });

    const razorpayOrder = await razorpayService.createOrder({
      orderNumber,
      amountRupees: Number(order.grandTotal),
      customerName: order.customerName,
      customerEmail: order.customerEmail,
      customerPhone: order.customerPhone,
    });

    await prisma.payment.updateMany({
      where: { orderId: order.id },
      data: {
        status: 'PENDING',
        failureReason: null,
        method: 'RAZORPAY',
        razorpayOrderId: razorpayOrder.id,
      },
    });

    return {
      razorpayOrderId: razorpayOrder.id,
      keyId: razorpayService.getPublicKeyId(),
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
    };
  }

  private aggregateItemQuantities(items: Array<{ productColorId: string; quantity: number }>) {
    const quantities = new Map<string, number>();
    for (const item of items) {
      quantities.set(
        item.productColorId,
        (quantities.get(item.productColorId) || 0) + item.quantity,
      );
    }
    return quantities;
  }

  private isOrderPastPaymentPhase(status: string) {
    return [
      'CONFIRMED',
      'READY_TO_SHIP',
      'SHIPPED',
      'IN_TRANSIT',
      'DELIVERED',
      'RETURNED',
      'REFUNDED',
      'CANCELLED',
      'RTO',
    ].includes(status);
  }

  private orderItemsToCheckoutItems(
    items: Array<{ productId: string; productColorId: string; quantity: number }>,
  ): CheckoutItem[] {
    return items.map((item) => ({
      productId: item.productId,
      productColorId: item.productColorId,
      quantity: item.quantity,
    }));
  }

  private async healPaidOrderState(orderNumber: string) {
    const order = await prisma.order.findFirst({
      where: { orderNumber },
      include: { items: true, payments: true, trackingHistory: true },
    });
    if (!order) return;
    if (!order.payments.some((payment) => payment.status === 'SUCCESS')) return;
    if (!['FAILED', 'PAYMENT_PENDING'].includes(order.status)) return;

    const recoveringFromFailed = order.status === 'FAILED';

    await runPrismaTransaction(async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: 'PLACED' },
      });

      const hasPlacedEntry = order.trackingHistory.some((entry) => entry.status === 'PLACED');
      if (!hasPlacedEntry) {
        await tx.trackingHistory.create({
          data: {
            orderId: order.id,
            status: 'PLACED',
            description: 'Payment confirmed. Order placed successfully.',
          },
        });
      }

      if (recoveringFromFailed) {
        await this.reserveInventoryForItems(tx, this.orderItemsToCheckoutItems(order.items));
      }
    });

    realtime.orderStatusChanged({
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: 'PLACED',
      customerPhone: order.customerPhone,
      grandTotal: Number(order.grandTotal),
    });
  }

  private resolveRazorpayOrderId(
    localPayment?: { razorpayOrderId: string | null } | null,
  ): string | null {
    return localPayment?.razorpayOrderId?.trim() || null;
  }

  private getRazorpayPaymentStatus(payment: Record<string, unknown>): string {
    return String(payment.status || '').toLowerCase();
  }

  private getRazorpayPaymentTimestamp(payment: Record<string, unknown>): number {
    const raw = payment.created_at;
    if (typeof raw === 'number') return raw * 1000;
    if (!raw) return 0;
    return new Date(String(raw)).getTime();
  }

  private isTerminalRazorpayFailure(status: string): boolean {
    return status === 'failed';
  }

  private isRazorpayPaymentSuccess(status: string): boolean {
    return status === 'captured';
  }

  private getLatestRazorpayPayment(
    payments: Record<string, unknown>[],
  ): Record<string, unknown> | null {
    if (!payments.length) return null;
    return [...payments].sort(
      (a, b) => this.getRazorpayPaymentTimestamp(b) - this.getRazorpayPaymentTimestamp(a),
    )[0];
  }

  private getRazorpayFailureReason(payment: Record<string, unknown>): string {
    const description = String(payment.error_description || '').trim();
    const reason = String(payment.error_reason || '').trim();
    return description || reason || 'Payment failed';
  }

  private async reconcileRazorpayPaidOrder(
    orderNumber: string,
    localPayment?: { razorpayOrderId: string | null } | null,
  ): Promise<boolean> {
    const razorpayOrderId = this.resolveRazorpayOrderId(localPayment);
    if (!razorpayOrderId) return false;

    const rzOrder = await razorpayService.getOrder(razorpayOrderId);
    const orderStatus = String(rzOrder.status || '').toLowerCase();

    if (orderStatus === 'paid') {
      const payments = await razorpayService.getPaymentsForOrder(razorpayOrderId);
      const successPayment = payments?.find((payment) =>
        this.isRazorpayPaymentSuccess(this.getRazorpayPaymentStatus(payment)),
      );
      await this.handlePaymentSuccess(orderNumber, {
        ...(successPayment || rzOrder),
        razorpay_payment_id: successPayment?.id || rzOrder.id,
        razorpay_order_id: razorpayOrderId,
      });
      return true;
    }

    const payments = await razorpayService.getPaymentsForOrder(razorpayOrderId);
    if (!payments) return false;
    const successPayment = payments.find((payment) =>
      this.isRazorpayPaymentSuccess(this.getRazorpayPaymentStatus(payment)),
    );
    if (!successPayment) return false;

    await this.handlePaymentSuccess(orderNumber, {
      ...successPayment,
      razorpay_payment_id: successPayment.id,
      razorpay_order_id: razorpayOrderId,
    });
    return true;
  }

  /** Detect failed payment attempts via Razorpay payments API. */
  private async reconcileRazorpayFailedPayment(
    orderNumber: string,
    localPayment?: { status: string; updatedAt: Date; razorpayOrderId: string | null },
  ): Promise<boolean> {
    if (!localPayment) {
      const order = await prisma.order.findFirst({
        where: { orderNumber },
        include: { payments: true },
      });
      localPayment = order?.payments[0];
    }
    if (!localPayment || localPayment.status !== 'PENDING') return false;

    const razorpayOrderId = this.resolveRazorpayOrderId(localPayment);
    if (!razorpayOrderId) return false;

    const payments = await razorpayService.getPaymentsForOrder(razorpayOrderId);
    if (!payments) return false;
    if (!payments.length) return false;

    const hasSuccess = payments.some((payment) =>
      this.isRazorpayPaymentSuccess(this.getRazorpayPaymentStatus(payment)),
    );
    if (hasSuccess) {
      const successPayment = payments.find((payment) =>
        this.isRazorpayPaymentSuccess(this.getRazorpayPaymentStatus(payment)),
      );
      if (successPayment) {
        await this.handlePaymentSuccess(orderNumber, {
          ...successPayment,
          razorpay_payment_id: successPayment.id,
          razorpay_order_id: razorpayOrderId,
        });
      }
      return false;
    }

    const latest = this.getLatestRazorpayPayment(payments);
    if (!latest) return false;

    const latestStatus = this.getRazorpayPaymentStatus(latest);
    if (!this.isTerminalRazorpayFailure(latestStatus)) return false;

    await this.handlePaymentFailure(orderNumber, this.getRazorpayFailureReason(latest));
    return true;
  }

  /**
   * When Razorpay has no successful payment (created / attempted with no capture),
   * mark our order FAILED so admin doesn't show a false pending.
   */
  private async reconcileAbandonedRazorpayOrder(
    orderNumber: string,
    order: {
      createdAt: Date;
      status: string;
      payments: Array<{ razorpayOrderId: string | null }>;
    },
  ): Promise<boolean> {
    if (!['PAYMENT_PENDING', 'PLACED'].includes(order.status)) return false;

    const razorpayOrderId = this.resolveRazorpayOrderId(order.payments[0]);
    if (!razorpayOrderId) {
      const ageMs = Date.now() - new Date(order.createdAt).getTime();
      if (ageMs < 5 * 60 * 1000) return false;
      await this.handlePaymentFailure(orderNumber, 'Payment session was not created');
      return true;
    }

    const rzOrder = await razorpayService.getOrder(razorpayOrderId);
    const orderStatus = String(rzOrder.status || '').toLowerCase();

    if (orderStatus === 'paid') return false;

    const payments = await razorpayService.getPaymentsForOrder(razorpayOrderId);
    if (!payments) return false;

    const hasSuccess = payments.some((payment) =>
      this.isRazorpayPaymentSuccess(this.getRazorpayPaymentStatus(payment)),
    );
    if (hasSuccess) return false;

    const hasInFlightPayment = payments.some((payment) => {
      const status = this.getRazorpayPaymentStatus(payment);
      return ['created', 'authorized'].includes(status);
    });
    if (hasInFlightPayment) return false;

    const ageMs = Date.now() - new Date(order.createdAt).getTime();
    const hasFailedAttempt = payments.some((payment) =>
      this.isTerminalRazorpayFailure(this.getRazorpayPaymentStatus(payment)),
    );

    // Failed attempt → fail immediately.
    // No payment attempts and order is older than 5 minutes → abandoned.
    // Attempted with only failures older than 15 minutes → abandoned.
    const abandonAfterMs = hasFailedAttempt
      ? 0
      : payments.length === 0
        ? 5 * 60 * 1000
        : 15 * 60 * 1000;

    if (ageMs < abandonAfterMs) return false;

    const latestFailed = this.getLatestRazorpayPayment(
      payments.filter((payment) =>
        this.isTerminalRazorpayFailure(this.getRazorpayPaymentStatus(payment)),
      ),
    );

    await this.handlePaymentFailure(
      orderNumber,
      latestFailed
        ? this.getRazorpayFailureReason(latestFailed)
        : 'Payment not completed on Razorpay',
    );
    return true;
  }

  private async reserveInventoryForItems(tx: Prisma.TransactionClient, items: CheckoutItem[]) {
    const quantities = this.aggregateItemQuantities(items);
    const colorIds = [...quantities.keys()];
    if (colorIds.length === 0) return;

    const inventories = await tx.inventory.findMany({
      where: { productColorId: { in: colorIds }, deletedAt: null },
    });
    const inventoryByColorId = new Map(inventories.map((row) => [row.productColorId, row]));

    await Promise.all(
      [...quantities.entries()].map(([colorId, quantity]) => {
        const inventory = inventoryByColorId.get(colorId);
        if (!inventory) return Promise.resolve();
        return tx.inventory.update({
          where: { id: inventory.id },
          data: { reserved: { increment: quantity } },
        });
      }),
    );
  }

  private async releasePendingOrder(orderId: string, reason: string) {
    try {
      await runPrismaTransaction(async (tx) => {
        const order = await tx.order.findUnique({
          where: { id: orderId },
          include: { items: true },
        });
        if (!order || order.status !== 'PAYMENT_PENDING') return;

        const quantities = this.aggregateItemQuantities(order.items);
        const colorIds = [...quantities.keys()];
        if (colorIds.length > 0) {
          const inventories = await tx.inventory.findMany({
            where: { productColorId: { in: colorIds }, deletedAt: null },
          });
          const inventoryByColorId = new Map(inventories.map((row) => [row.productColorId, row]));

          await Promise.all(
            [...quantities.entries()].map(([colorId, quantity]) => {
              const inventory = inventoryByColorId.get(colorId);
              if (!inventory) return Promise.resolve();
              return tx.inventory.update({
                where: { id: inventory.id },
                data: {
                  reserved: { decrement: Math.min(quantity, inventory.reserved) },
                },
              });
            }),
          );
        }

        if (order.couponId) {
          await this.restoreCouponFromOrder(tx, order.couponId, Number(order.discountAmount));
        }

        await tx.order.update({
          where: { id: orderId },
          data: { status: 'FAILED' },
        });

        await tx.trackingHistory.create({
          data: {
            orderId,
            status: 'FAILED',
            description: reason,
          },
        });

        await tx.payment.updateMany({
          where: { orderId },
          data: { status: 'FAILED', failureReason: reason },
        });
      });
    } catch (error) {
      logger.error('Failed to release pending order after payment init failure', {
        orderId,
        error,
      });
    }
  }

  private async deductInventory(
    tx: Prisma.TransactionClient,
    productColorId: string,
    quantity: number,
    orderId: string,
    releaseReserved = true,
  ) {
    const inventory = await tx.inventory.findFirst({
      where: { productColorId, deletedAt: null },
    });
    if (!inventory) return;

    const previousQty = inventory.quantity;
    const newQty = previousQty - quantity;

    await tx.inventory.update({
      where: { id: inventory.id },
      data: {
        quantity: newQty,
        ...(releaseReserved &&
          inventory.reserved > 0 && {
            reserved: { decrement: Math.min(quantity, inventory.reserved) },
          }),
      },
    });

    await tx.inventoryHistory.create({
      data: {
        inventoryId: inventory.id,
        changeType: 'OUT',
        quantity,
        previousQty,
        newQty,
        reason: 'Order confirmed',
        referenceId: orderId,
      },
    });
  }

  private async releaseReservedInventory(
    tx: Prisma.TransactionClient,
    items: Array<{ productColorId: string; quantity: number }>,
  ) {
    if (items.length === 0) return;

    const qtyByColor = new Map<string, number>();
    for (const item of items) {
      qtyByColor.set(
        item.productColorId,
        (qtyByColor.get(item.productColorId) ?? 0) + item.quantity,
      );
    }

    const inventories = await tx.inventory.findMany({
      where: { productColorId: { in: [...qtyByColor.keys()] }, deletedAt: null },
      select: { id: true, productColorId: true, reserved: true },
    });

    await Promise.all(
      inventories.map((inventory) => {
        const quantity = qtyByColor.get(inventory.productColorId) ?? 0;
        if (quantity <= 0 || inventory.reserved <= 0) return Promise.resolve();
        return tx.inventory.update({
          where: { id: inventory.id },
          data: { reserved: { decrement: Math.min(quantity, inventory.reserved) } },
        });
      }),
    );
  }

  /**
   * Confirm inventory for all order lines in fewer DB round-trips (critical on Neon).
   */
  private async confirmOrderInventory(
    tx: Prisma.TransactionClient,
    orderId: string,
    items: Array<{ productId: string; productColorId: string; quantity: number }>,
  ) {
    if (items.length === 0) return;

    const qtyByColor = new Map<string, number>();
    const soldByProduct = new Map<string, number>();
    for (const item of items) {
      qtyByColor.set(
        item.productColorId,
        (qtyByColor.get(item.productColorId) ?? 0) + item.quantity,
      );
      soldByProduct.set(item.productId, (soldByProduct.get(item.productId) ?? 0) + item.quantity);
    }

    const colorIds = [...qtyByColor.keys()];
    const inventories = await tx.inventory.findMany({
      where: { productColorId: { in: colorIds }, deletedAt: null },
    });
    const inventoryByColor = new Map(inventories.map((row) => [row.productColorId, row]));

    const historyRows: Prisma.InventoryHistoryCreateManyInput[] = [];
    const inventoryUpdates: Promise<unknown>[] = [];

    for (const [productColorId, quantity] of qtyByColor) {
      const inventory = inventoryByColor.get(productColorId);
      if (!inventory) continue;

      const previousQty = inventory.quantity;
      const newQty = previousQty - quantity;
      historyRows.push({
        inventoryId: inventory.id,
        changeType: 'OUT',
        quantity,
        previousQty,
        newQty,
        reason: 'Order confirmed',
        referenceId: orderId,
      });
      inventoryUpdates.push(
        tx.inventory.update({
          where: { id: inventory.id },
          data: {
            quantity: newQty,
            ...(inventory.reserved > 0 && {
              reserved: { decrement: Math.min(quantity, inventory.reserved) },
            }),
          },
        }),
      );
    }

    await Promise.all([
      ...inventoryUpdates,
      historyRows.length > 0
        ? tx.inventoryHistory.createMany({ data: historyRows })
        : Promise.resolve(),
      ...[...soldByProduct.entries()].map(([productId, quantity]) =>
        tx.product.update({
          where: { id: productId },
          data: { soldCount: { increment: quantity } },
        }),
      ),
    ]);
  }

  /** Reverse confirm inventory (escalation cancel / reopen). */
  private async restoreConfirmedInventory(
    tx: Prisma.TransactionClient,
    orderId: string,
    items: Array<{ productId: string; productColorId: string; quantity: number }>,
  ) {
    if (items.length === 0) return;

    const qtyByColor = new Map<string, number>();
    const soldByProduct = new Map<string, number>();
    for (const item of items) {
      qtyByColor.set(
        item.productColorId,
        (qtyByColor.get(item.productColorId) ?? 0) + item.quantity,
      );
      soldByProduct.set(item.productId, (soldByProduct.get(item.productId) ?? 0) + item.quantity);
    }

    const inventories = await tx.inventory.findMany({
      where: { productColorId: { in: [...qtyByColor.keys()] }, deletedAt: null },
    });
    const inventoryByColor = new Map(inventories.map((row) => [row.productColorId, row]));

    const historyRows: Prisma.InventoryHistoryCreateManyInput[] = [];
    const inventoryUpdates: Promise<unknown>[] = [];

    for (const [productColorId, quantity] of qtyByColor) {
      const inventory = inventoryByColor.get(productColorId);
      if (!inventory) continue;
      const previousQty = inventory.quantity;
      const newQty = previousQty + quantity;
      historyRows.push({
        inventoryId: inventory.id,
        changeType: 'IN',
        quantity,
        previousQty,
        newQty,
        reason: 'Escalation inventory restore',
        referenceId: orderId,
      });
      inventoryUpdates.push(
        tx.inventory.update({
          where: { id: inventory.id },
          data: { quantity: newQty },
        }),
      );
    }

    await Promise.all([
      ...inventoryUpdates,
      historyRows.length > 0
        ? tx.inventoryHistory.createMany({ data: historyRows })
        : Promise.resolve(),
      ...[...soldByProduct.entries()].map(([productId, quantity]) =>
        tx.product.update({
          where: { id: productId },
          data: { soldCount: { decrement: quantity } },
        }),
      ),
    ]);
  }

  private async getShippingSettings() {
    return withCache('shipping-settings', STORE_CACHE_TTL_MS, async () => {
      const settings = await prisma.setting.findMany({
        where: { group: 'shipping' },
      });

      const map = Object.fromEntries(settings.map((s) => [s.key, s.value]));
      return {
        defaultShippingCharge: Number(map.default_shipping_charge ?? 99),
        freeShippingThreshold: Number(map.free_shipping_threshold ?? 1999),
        freeShippingEnabled:
          map.free_shipping_enabled === true || map.free_shipping_enabled === 'true',
        estimatedDeliveryDays: Number(map.estimated_delivery_days ?? 7),
      };
    });
  }

  private async enrichOrderCoordinates(orderId: string, address: ShippingAddress) {
    const enriched = await geocodingService.resolveCoordinates(address);
    if (
      enriched.latitude == null ||
      enriched.longitude == null ||
      (enriched.latitude === address.latitude && enriched.longitude === address.longitude)
    ) {
      return;
    }

    await prisma.order.update({
      where: { id: orderId },
      data: { shippingAddress: enriched as unknown as Prisma.InputJsonValue },
    });
  }

  private async sendOrderNotifications(orderId: string) {
    const order = await this.findById(orderId);
    const grandTotal = formatCurrency(Number(order.grandTotal));

    // Email first in background queue — never blocks WhatsApp / response path
    orderEmailService.queueStatusEmail(orderId, order.status);

    const { sent: waSent, message: waMessage } = await whatsAppService.sendOrderStatusUpdate({
      customerPhone: order.customerPhone,
      customerName: order.customerName,
      orderNumber: order.orderNumber,
      status: order.status,
      grandTotal,
    });

    await prisma.notification.create({
      data: {
        orderId,
        type: 'ORDER_CONFIRMATION',
        channel: 'WHATSAPP',
        recipient: order.customerPhone,
        message: waMessage,
        status: waSent ? 'sent' : 'failed',
        sentAt: waSent ? new Date() : undefined,
      },
    });
  }

  private async sendStatusNotification(orderId: string, status: OrderStatus) {
    orderEmailService.queueStatusEmail(orderId, status);

    const order = await prisma.order.findFirst({
      where: { id: orderId, deletedAt: null },
      select: {
        customerPhone: true,
        customerName: true,
        orderNumber: true,
        grandTotal: true,
        shipping: { select: { trackingUrl: true } },
      },
    });
    if (!order) return;

    const shipping = order.shipping;

    const notificationTypeByStatus: Partial<
      Record<
        OrderStatus,
        | 'ORDER_PACKED'
        | 'ORDER_SHIPPED'
        | 'ORDER_DELIVERED'
        | 'ORDER_CANCELLED'
        | 'ORDER_CONFIRMATION'
        | 'PAYMENT_FAILED'
      >
    > = {
      PLACED: 'ORDER_CONFIRMATION',
      CONFIRMED: 'ORDER_CONFIRMATION',
      READY_TO_SHIP: 'ORDER_PACKED',
      SHIPPED: 'ORDER_SHIPPED',
      IN_TRANSIT: 'ORDER_SHIPPED',
      DELIVERED: 'ORDER_DELIVERED',
      CANCELLED: 'ORDER_CANCELLED',
      REFUNDED: 'ORDER_CANCELLED',
      RTO: 'ORDER_CANCELLED',
      RETURNED: 'ORDER_CANCELLED',
      FAILED: 'PAYMENT_FAILED',
      PAYMENT_PENDING: 'PAYMENT_FAILED',
    };
    const notificationType = notificationTypeByStatus[status] || 'ORDER_SHIPPED';

    const { sent: waSent, message: waMessage } = await whatsAppService.sendOrderStatusUpdate({
      customerPhone: order.customerPhone,
      customerName: order.customerName,
      orderNumber: order.orderNumber,
      status,
      grandTotal: formatCurrency(Number(order.grandTotal)),
      trackingUrl: shipping?.trackingUrl || undefined,
    });

    await prisma.notification.create({
      data: {
        orderId,
        type: notificationType,
        channel: 'WHATSAPP',
        recipient: order.customerPhone,
        message: waMessage,
        status: waSent ? 'sent' : 'failed',
        sentAt: waSent ? new Date() : undefined,
      },
    });
  }

  private resolveIndiaShippingChargeWithSettings(
    subtotal: number,
    settings: Awaited<ReturnType<OrderService['getShippingSettings']>>,
  ): number {
    if (settings.freeShippingEnabled) return 0;
    if (subtotal >= settings.freeShippingThreshold) return 0;
    return settings.defaultShippingCharge;
  }

  private isIndiaShippingAddress(shippingAddress?: Partial<ShippingAddress>): boolean {
    const code = (shippingAddress?.countryCode || '').trim().toUpperCase();
    if (code === 'IN') return true;
    const country = (shippingAddress?.country || '').trim().toLowerCase();
    const postalCode = (shippingAddress?.postalCode || '').trim();
    const isIndia = country === 'india' || country === 'in' || country === 'bharat';
    const looksLikeIndianPincode = /^\d{6}$/.test(postalCode);

    if (isIndia) return true;
    if (!country && !code && looksLikeIndianPincode) return true;
    if (!country && !code && !postalCode) return true;
    return false;
  }

  /** Hyderabad city / metro pin → Standard delivery promise is 2 days. */
  private isHyderabadDeliveryArea(shippingAddress?: Partial<ShippingAddress>): boolean {
    const pin = (shippingAddress?.postalCode || '').replace(/\D/g, '');
    if (/^500\d{3}$/.test(pin)) return true;
    const haystack = [shippingAddress?.city, shippingAddress?.landmark, shippingAddress?.state]
      .map((part) => (part || '').trim().toLowerCase())
      .join(' ');
    const markers = [
      'hyderabad',
      'secunderabad',
      'cyberabad',
      'kukatpally',
      'gachibowli',
      'madhapur',
      'hitech city',
      'hitec city',
    ];
    return markers.some((marker) => haystack.includes(marker));
  }

  private resolveCountryCode(shippingAddress?: Partial<ShippingAddress>): string {
    const code = (shippingAddress?.countryCode || '').trim().toUpperCase();
    if (code.length === 2) return code;
    if (this.isIndiaShippingAddress(shippingAddress)) return 'IN';
    return '';
  }

  private async resolveShippingQuote(
    subtotal: number,
    orderItems: Array<{
      quantity: number;
      weight: number | null;
      length?: number | null;
      width?: number | null;
      height?: number | null;
    }>,
    shippingAddress?: Partial<ShippingAddress>,
    settings?: Awaited<ReturnType<OrderService['getShippingSettings']>>,
  ): Promise<{
    courier: string;
    shippingFee: number;
    estimatedDays: string;
    currency: string;
  }> {
    const shippingSettings = settings ?? (await this.getShippingSettings());

    if (shippingAddress?.preferredShipping === 'QUICK') {
      if (
        shippingAddress.latitude == null ||
        shippingAddress.longitude == null ||
        !Number.isFinite(shippingAddress.latitude) ||
        !Number.isFinite(shippingAddress.longitude)
      ) {
        throw new ApiError(
          400,
          'Instant delivery requires your location. Tap Detect My Location and try again.',
        );
      }

      const pickup = await settingsService.getQuickPickupCoordinates();
      if (!pickup) {
        throw new ApiError(
          400,
          'Instant delivery is not available right now. Choose standard delivery.',
        );
      }

      const schedule = await settingsService.getQuickScheduleAvailability();
      if (!schedule.available) {
        throw new ApiError(400, `${schedule.message} Choose standard delivery.`);
      }

      const totalWeightGrams = orderItems.reduce(
        (sum, item) => sum + (item.weight != null ? item.weight * item.quantity : 0),
        0,
      );
      const weightKg = Math.max(totalWeightGrams > 0 ? totalWeightGrams / 1000 : 0.5, 0.1);

      try {
        const quick = await shiprocketService.quoteQuickDelivery({
          pickupPostalCode: env.SHIPROCKET_PICKUP_PINCODE,
          deliveryPostalCode: shippingAddress.postalCode?.trim() || '500001',
          pickupLatitude: pickup.latitude,
          pickupLongitude: pickup.longitude,
          deliveryLatitude: shippingAddress.latitude,
          deliveryLongitude: shippingAddress.longitude,
          weightKg,
          declaredValue: subtotal,
          cod: false,
        });

        const etaLabel = quick.etaMinutes
          ? /^\d+$/.test(String(quick.etaMinutes).trim())
            ? `${quick.etaMinutes} min`
            : String(quick.etaMinutes)
          : 'same day';

        return {
          courier: quick.courierName || 'Shiprocket Quick',
          shippingFee: quick.rate,
          estimatedDays: etaLabel,
          currency: quick.currency || 'INR',
        };
      } catch (error) {
        logger.warn('Instant shipping quote during checkout failed', {
          error: error instanceof Error ? error.message : error,
        });
        throw new ApiError(
          400,
          'Instant delivery is not available right now. Choose standard delivery.',
        );
      }
    }

    if (this.isIndiaShippingAddress(shippingAddress)) {
      const shippingFee = this.resolveIndiaShippingChargeWithSettings(subtotal, shippingSettings);
      // Hyderabad → 2 days; all other India cities → 3–7 days
      const indiaEta = this.isHyderabadDeliveryArea(shippingAddress) ? '2' : '3-7';
      return {
        courier: 'India Domestic',
        shippingFee,
        estimatedDays: indiaEta,
        currency: 'INR',
      };
    }

    if (
      !shippingAddress?.country?.trim() ||
      !shippingAddress?.state?.trim() ||
      !shippingAddress?.city?.trim() ||
      !shippingAddress?.postalCode?.trim()
    ) {
      throw new ApiError(
        400,
        'Country, state, city, and postal code are required for international shipping',
      );
    }

    const countryCode = this.resolveCountryCode(shippingAddress);
    if (!countryCode) {
      throw new ApiError(400, 'A valid country code is required for international shipping');
    }

    const totalWeightGrams = orderItems.reduce(
      (sum, item) => sum + (item.weight != null ? item.weight * item.quantity : 0),
      0,
    );
    // Product weights are stored in grams
    const weightKg = Math.max(totalWeightGrams / 1000, 0.5);

    let maxLength = 0;
    let maxWidth = 0;
    let totalHeight = 0;
    for (const item of orderItems) {
      if (item.length != null) maxLength = Math.max(maxLength, item.length);
      if (item.width != null) maxWidth = Math.max(maxWidth, item.width);
      if (item.height != null) totalHeight += item.height * item.quantity;
    }

    return shiprocketService.getShippingQuote({
      deliveryPostalCode: shippingAddress.postalCode,
      deliveryCountryCode: countryCode,
      weightKg,
      declaredValue: subtotal,
      lengthCm: maxLength > 0 ? maxLength : 10,
      breadthCm: maxWidth > 0 ? maxWidth : 10,
      heightCm: totalHeight > 0 ? totalHeight : 5,
    });
  }

  private computePackageDimensionsFromItems(
    items: Array<{
      quantity: number;
      length: Prisma.Decimal | number | null;
      width: Prisma.Decimal | number | null;
      height: Prisma.Decimal | number | null;
    }>,
  ) {
    let maxLength = 0;
    let maxWidth = 0;
    let totalHeight = 0;
    let hasLength = false;
    let hasWidth = false;
    let hasHeight = false;

    for (const item of items) {
      if (item.length != null) {
        maxLength = Math.max(maxLength, Number(item.length));
        hasLength = true;
      }
      if (item.width != null) {
        maxWidth = Math.max(maxWidth, Number(item.width));
        hasWidth = true;
      }
      if (item.height != null) {
        totalHeight += Number(item.height) * item.quantity;
        hasHeight = true;
      }
    }

    return {
      packageLength: hasLength ? maxLength : null,
      packageWidth: hasWidth ? maxWidth : null,
      packageHeight: hasHeight ? totalHeight : null,
    };
  }

  private async loadCheckoutProductsByColor(items: CheckoutItem[]) {
    type CheckoutColor = {
      id: string;
      name: string;
      images: Array<{ url: string }>;
      inventory: Array<{ quantity: number; reserved: number }>;
    };
    type CheckoutProduct = {
      id: string;
      name: string;
      slug: string;
      sku: string;
      price: Prisma.Decimal;
      mrp: Prisma.Decimal;
      weight: Prisma.Decimal | null;
      length: Prisma.Decimal | null;
      width: Prisma.Decimal | null;
      height: Prisma.Decimal | null;
      colors: CheckoutColor[];
    };

    const byColorId = new Map<string, { product: CheckoutProduct; color: CheckoutColor }>();
    if (items.length === 0) return byColorId;

    const colorIds = [...new Set(items.map((i) => i.productColorId))];
    const products = await prisma.product.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        colors: {
          some: { id: { in: colorIds }, deletedAt: null, isActive: true },
        },
      },
      include: {
        colors: {
          where: { id: { in: colorIds }, deletedAt: null, isActive: true },
          include: {
            images: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' }, take: 1 },
            inventory: { where: { deletedAt: null } },
          },
        },
      },
    });

    for (const product of products) {
      for (const color of product.colors) {
        byColorId.set(color.id, { product, color });
      }
    }

    return byColorId;
  }
}

export const orderService = new OrderService();
