import { Prisma } from '@prisma/client';
import { prisma } from '@/config/database';
import { env } from '@/config/env';
import { shiprocketService } from '@/integrations/shiprocket.service';
import { ApiError } from '@/shared/api-response';
import { logger } from '@/utils/logger';
import { isInternationalShippingAddressFromJson } from '@/utils/shipping-address';

type ReturnBookingRow = Prisma.ReturnRequestGetPayload<{
  include: {
    items: {
      include: {
        orderItem: {
          select: {
            id: true;
            productName: true;
            sku: true;
            quantity: true;
            unitPrice: true;
            weight: true;
            length: true;
            width: true;
            height: true;
          };
        };
      };
    };
    order: {
      include: {
        items: true;
        shipping: true;
      };
    };
  };
}>;

function parseShippingAddress(raw: Prisma.JsonValue | null) {
  const address = (raw ?? {}) as Record<string, unknown>;
  return {
    addressLine1: String(address.addressLine1 ?? '').trim(),
    addressLine2: address.addressLine2 ? String(address.addressLine2).trim() : '',
    landmark: address.landmark ? String(address.landmark).trim() : '',
    city: String(address.city ?? '').trim(),
    state: String(address.state ?? '').trim(),
    postalCode: String(address.postalCode ?? '').trim(),
    country: String(address.country ?? 'India').trim() || 'India',
  };
}

function phoneDigits(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: 'Customer', last: '.' };
  return { first: parts[0], last: parts.slice(1).join(' ') || '.' };
}

function todayPickupDateIst(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}

function resolvePackageDims(order: ReturnBookingRow['order']) {
  let maxLength = 0;
  let maxWidth = 0;
  let totalHeight = 0;
  for (const item of order.items) {
    if (item.length) maxLength = Math.max(maxLength, Number(item.length));
    if (item.width) maxWidth = Math.max(maxWidth, Number(item.width));
    if (item.height) totalHeight += Number(item.height) * item.quantity;
  }
  return {
    length: order.packageLength ? Number(order.packageLength) : maxLength || 30,
    breadth: order.packageWidth ? Number(order.packageWidth) : maxWidth || 20,
    height: order.packageHeight ? Number(order.packageHeight) : totalHeight || 5,
  };
}

function resolveReturnWeightKg(row: ReturnBookingRow): number {
  let grams = 0;
  for (const item of row.items) {
    const weight = item.orderItem?.weight;
    if (weight != null) {
      grams += Number(weight) * item.quantity;
    }
  }
  if (grams <= 0) {
    grams = row.items.reduce((sum, item) => sum + item.quantity, 0) * 500;
  }
  return Math.max(0.5, Math.round((grams / 1000) * 1000) / 1000);
}

async function getWarehouseContact() {
  const settings = await prisma.setting.findMany({
    where: { key: { in: ['store_address', 'store_phone'] } },
  });
  const map = Object.fromEntries(settings.map((s) => [s.key, String(s.value ?? '').trim()]));
  return {
    address: map.store_address || env.SHIPROCKET_PICKUP_LOCATION || 'Singari Sarees warehouse',
    phone: phoneDigits(map.store_phone || '9490458789'),
  };
}

function mapReturnReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed) return 'Product not as described';
  if (trimmed.length <= 120) return trimmed;
  return trimmed.slice(0, 120);
}

function extractAwbFromAssignResult(result: Record<string, unknown>): string | null {
  const awbData =
    (result.response as { data?: Record<string, unknown> } | undefined)?.data ??
    (result.data as Record<string, unknown> | undefined) ??
    result;
  const awb =
    (typeof awbData.awb_code === 'string' && awbData.awb_code) ||
    (typeof result.awb_code === 'string' && result.awb_code) ||
    null;
  return awb?.trim() || null;
}

export type ReversePickupBooking = {
  shiprocketReturnOrderId: string | null;
  shiprocketReturnShipmentId: string | null;
  reverseAwbCode: string | null;
  reverseTrackingUrl: string | null;
};

export async function bookShiprocketReversePickup(
  returnRequestId: string,
): Promise<ReversePickupBooking> {
  const row = await prisma.returnRequest.findUnique({
    where: { id: returnRequestId },
    include: {
      items: {
        include: {
          orderItem: {
            select: {
              id: true,
              productName: true,
              sku: true,
              quantity: true,
              unitPrice: true,
              weight: true,
              length: true,
              width: true,
              height: true,
            },
          },
        },
      },
      order: {
        include: {
          items: true,
          shipping: true,
        },
      },
    },
  });

  if (!row) throw new ApiError(404, 'Return request not found');
  if (isInternationalShippingAddressFromJson(row.order.shippingAddress)) {
    throw new ApiError(400, 'Reverse pickup is only available for India orders');
  }

  if (row.shiprocketReturnShipmentId) {
    return {
      shiprocketReturnOrderId: row.shiprocketReturnOrderId,
      shiprocketReturnShipmentId: row.shiprocketReturnShipmentId,
      reverseAwbCode: row.reverseAwbCode,
      reverseTrackingUrl: row.reverseTrackingUrl,
    };
  }

  const customerAddress = parseShippingAddress(row.order.shippingAddress);
  if (
    !customerAddress.addressLine1 ||
    !customerAddress.city ||
    !customerAddress.state ||
    !customerAddress.postalCode
  ) {
    throw new ApiError(400, 'Order shipping address is incomplete for reverse pickup');
  }

  const customerPhone = phoneDigits(row.order.customerPhone);
  if (customerPhone.length !== 10) {
    throw new ApiError(400, 'Valid customer phone is required for reverse pickup');
  }

  const { first, last } = splitName(row.order.customerName);
  const warehouse = await getWarehouseContact();
  const dims = resolvePackageDims(row.order);
  const weightKg = resolveReturnWeightKg(row);
  const subTotal = row.items.reduce(
    (sum, item) => sum + Number(item.orderItem?.unitPrice ?? 0) * item.quantity,
    0,
  );

  const pickupLine = [customerAddress.addressLine1, customerAddress.addressLine2, customerAddress.landmark]
    .filter(Boolean)
    .join(', ');

  const orderRef = `${row.order.orderNumber}-RET-${returnRequestId.slice(0, 8)}`.slice(0, 48);
  const pad = (n: number) => String(n).padStart(2, '0');
  const created = row.order.createdAt;
  const orderDate = `${created.getFullYear()}-${pad(created.getMonth() + 1)}-${pad(created.getDate())}`;

  const payload: Record<string, unknown> = {
    order_id: orderRef,
    order_date: orderDate,
    pickup_location: env.SHIPROCKET_PICKUP_LOCATION || 'Primary',
    channel_id: '',
    payment_method: 'Prepaid',
    sub_total: Math.max(subTotal, 1),
    length: dims.length,
    breadth: dims.breadth,
    height: dims.height,
    weight: weightKg,
    return_reason: mapReturnReason(row.reason),
    pickup_customer_name: first,
    pickup_last_name: last,
    pickup_address: pickupLine,
    pickup_address_2: customerAddress.addressLine2 || '',
    pickup_city: customerAddress.city,
    pickup_state: customerAddress.state,
    pickup_pincode: customerAddress.postalCode,
    pickup_country: customerAddress.country || 'India',
    pickup_email: row.order.customerEmail || 'orders@singarisaree.com',
    pickup_phone: customerPhone,
    pickup_isd_code: '91',
    shipping_customer_name: 'Singari',
    shipping_last_name: 'Sarees',
    shipping_address: warehouse.address,
    shipping_address_2: '',
    shipping_city: 'Hyderabad',
    shipping_state: 'Telangana',
    shipping_pincode: env.SHIPROCKET_PICKUP_PINCODE,
    shipping_country: 'India',
    shipping_email: row.order.customerEmail || 'orders@singarisaree.com',
    shipping_phone: warehouse.phone,
    shipping_isd_code: '91',
    order_items: row.items.map((item) => ({
      name: item.orderItem?.productName || 'Saree',
      sku: item.orderItem?.sku || 'SKU',
      units: item.quantity,
      selling_price: Number(item.orderItem?.unitPrice ?? 0),
      discount: 0,
      tax: 0,
      hsn: 5208,
    })),
  };

  const createdReturn = await shiprocketService.createReturnOrder(payload);
  const shipmentId = shiprocketService.extractShipmentId(createdReturn);
  const shiprocketReturnOrderId = String(
    createdReturn.order_id ??
      (createdReturn.data as Record<string, unknown> | undefined)?.order_id ??
      orderRef,
  );

  let reverseAwbCode: string | null = null;
  if (shipmentId) {
    try {
      const awbResult = await shiprocketService.generateAWB(shipmentId);
      reverseAwbCode = extractAwbFromAssignResult(awbResult);
    } catch (error) {
      logger.warn('Reverse pickup AWB assign failed; shipment still created', {
        returnRequestId,
        shipmentId,
        error,
      });
    }

    try {
      await shiprocketService.generatePickup([shipmentId], todayPickupDateIst());
    } catch (error) {
      logger.warn('Reverse pickup schedule failed; shipment still created', {
        returnRequestId,
        shipmentId,
        error,
      });
    }
  } else {
    logger.warn('Shiprocket return created without shipment id', {
      returnRequestId,
      response: createdReturn,
    });
  }

  const reverseTrackingUrl = reverseAwbCode
    ? `https://shiprocket.co/tracking/${reverseAwbCode}`
    : null;

  await prisma.returnRequest.update({
    where: { id: returnRequestId },
    data: {
      shiprocketReturnOrderId,
      shiprocketReturnShipmentId: shipmentId ? String(shipmentId) : null,
      reverseAwbCode,
      reverseTrackingUrl,
    },
  });

  return {
    shiprocketReturnOrderId,
    shiprocketReturnShipmentId: shipmentId ? String(shipmentId) : null,
    reverseAwbCode,
    reverseTrackingUrl,
  };
}
