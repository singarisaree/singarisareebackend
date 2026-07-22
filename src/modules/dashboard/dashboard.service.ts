import { prisma } from '@/config/database';
import { env } from '@/config/env';
import { shiprocketService, type ShiprocketShippingMode } from '@/integrations/shiprocket.service';
import {
  canApplyShiprocketFulfillmentStatus,
  mapShiprocketPayloadToOrderStatus,
} from '@/integrations/shiprocket-status';
import { whatsAppService } from '@/integrations/whatsapp.service';
import { orderEmailService } from '@/integrations/order-email.service';
import { settingsService } from '@/modules/settings/settings.service';
import { ApiError, buildPaginationMeta } from '@/shared/api-response';
import { OrderStatus, Prisma, ReturnRequestStatus } from '@prisma/client';
import { parsePagination, parseCreatedAtFilter } from '@/utils/helpers';
import { logger } from '@/utils/logger';
import { withCache, invalidateCache } from '@/utils/memory-cache';
import { realtime } from '@/realtime/emitter';
import { getOrderStatusTrackingDescription } from '@/modules/orders/order-tracking.sync';

const PENDING_STATUSES: OrderStatus[] = ['PLACED', 'PAYMENT_PENDING', 'CONFIRMED'];
const REVENUE_STATUSES: OrderStatus[] = [
  'CONFIRMED',
  'READY_TO_SHIP',
  'SHIPPED',
  'IN_TRANSIT',
  'DELIVERED',
];
const OPEN_RETURN_STATUSES: ReturnRequestStatus[] = [
  'REQUESTED',
  'ACCEPTED',
  'OUT_FOR_PICKUP',
  'PICKED_UP',
];
const DASHBOARD_STATS_TTL_MS = 15 * 1000;

function startOfDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfWeek(date = new Date()) {
  const d = startOfDay(date);
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1; // Monday start
  d.setDate(d.getDate() - diff);
  return d;
}

function startOfMonth(date = new Date()) {
  const d = startOfDay(date);
  d.setDate(1);
  return d;
}

export class DashboardService {
  async getStats() {
    return withCache('dashboard:stats', DASHBOARD_STATS_TTL_MS, () => this.fetchStats());
  }

  private revenueWhere(createdAtGte?: Date): Prisma.OrderWhereInput {
    return {
      deletedAt: null,
      status: { in: REVENUE_STATUSES },
      ...(createdAtGte ? { createdAt: { gte: createdAtGte } } : {}),
    };
  }

  private async fetchStats() {
    const today = startOfDay();
    const weekStart = startOfWeek();
    const monthStart = startOfMonth();

    const [
      totalRevenue,
      todayRevenue,
      weekRevenue,
      monthRevenue,
      todayOrders,
      statusGroups,
      lowStock,
      salesByMonth,
      activeProducts,
      outOfStockCount,
      openReturnRequests,
      topProductsRaw,
    ] = await Promise.all([
      prisma.order.aggregate({
        where: this.revenueWhere(),
        _sum: { grandTotal: true },
      }),
      prisma.order.aggregate({
        where: this.revenueWhere(today),
        _sum: { grandTotal: true },
      }),
      prisma.order.aggregate({
        where: this.revenueWhere(weekStart),
        _sum: { grandTotal: true },
      }),
      prisma.order.aggregate({
        where: this.revenueWhere(monthStart),
        _sum: { grandTotal: true },
      }),
      prisma.order.count({ where: { createdAt: { gte: today }, deletedAt: null } }),
      prisma.order.groupBy({
        by: ['status'],
        where: { deletedAt: null },
        _count: { _all: true },
      }),
      prisma.inventory.findMany({
        where: {
          deletedAt: null,
          quantity: { lte: prisma.inventory.fields.lowStockAlert },
          product: { deletedAt: null },
          productColor: { deletedAt: null },
        },
        include: {
          product: { select: { name: true, sku: true } },
          productColor: { select: { name: true } },
        },
        take: 10,
      }),
      this.getSalesByMonth(6),
      prisma.product.count({ where: { deletedAt: null, isActive: true } }),
      prisma.product.count({
        where: {
          deletedAt: null,
          isActive: true,
          NOT: {
            colors: {
              some: {
                deletedAt: null,
                inventory: {
                  some: {
                    deletedAt: null,
                    quantity: { gt: prisma.inventory.fields.reserved },
                  },
                },
              },
            },
          },
        },
      }),
      prisma.returnRequest.count({
        where: { status: { in: OPEN_RETURN_STATUSES } },
      }),
      prisma.product.findMany({
        where: { deletedAt: null },
        orderBy: { soldCount: 'desc' },
        take: 5,
        select: {
          id: true,
          name: true,
          sku: true,
          soldCount: true,
          price: true,
        },
      }),
    ]);

    const countByStatus = Object.fromEntries(
      statusGroups.map((group) => [group.status, group._count._all]),
    ) as Partial<Record<OrderStatus, number>>;

    const pendingOrders = PENDING_STATUSES.reduce(
      (sum, status) => sum + (countByStatus[status] ?? 0),
      0,
    );

    const topProducts = topProductsRaw.map((product) => ({
      id: product.id,
      name: product.name,
      sku: product.sku,
      soldCount: product.soldCount,
      price: Number(product.price),
    }));

    const ALL_ORDER_STATUSES: OrderStatus[] = [
      'PLACED',
      'PAYMENT_PENDING',
      'CONFIRMED',
      'READY_TO_SHIP',
      'SHIPPED',
      'IN_TRANSIT',
      'DELIVERED',
      'RETURNED',
      'CANCELLED',
      'FAILED',
      'RTO',
      'REFUNDED',
    ];

    const orderPipeline = ALL_ORDER_STATUSES.map((status) => ({
      status,
      count: countByStatus[status] ?? 0,
    }));

    return {
      totalRevenue: Number(totalRevenue._sum.grandTotal || 0),
      todayRevenue: Number(todayRevenue._sum.grandTotal || 0),
      weekRevenue: Number(weekRevenue._sum.grandTotal || 0),
      monthRevenue: Number(monthRevenue._sum.grandTotal || 0),
      todayOrders,
      pendingOrders,
      paymentPending: countByStatus.PAYMENT_PENDING ?? 0,
      confirmed: countByStatus.CONFIRMED ?? 0,
      readyToShip: countByStatus.READY_TO_SHIP ?? 0,
      shipped: countByStatus.SHIPPED ?? 0,
      inTransit: countByStatus.IN_TRANSIT ?? 0,
      deliveredOrders: countByStatus.DELIVERED ?? 0,
      cancelledOrders: countByStatus.CANCELLED ?? 0,
      failed: countByStatus.FAILED ?? 0,
      rto: countByStatus.RTO ?? 0,
      returned: countByStatus.RETURNED ?? 0,
      refunded: countByStatus.REFUNDED ?? 0,
      placed: countByStatus.PLACED ?? 0,
      activeProducts,
      outOfStockCount,
      openReturnRequests,
      lowStock,
      topProducts,
      salesByMonth,
      orderPipeline,
    };
  }

  private async getSalesByMonth(months = 6) {
    const start = new Date();
    start.setMonth(start.getMonth() - (months - 1));
    start.setDate(1);
    start.setHours(0, 0, 0, 0);

    const rows = await prisma.$queryRaw<Array<{ month: string; revenue: number }>>`
      SELECT
        to_char(created_at, 'YYYY-MM') AS month,
        COALESCE(SUM(grand_total), 0)::float AS revenue
      FROM orders
      WHERE created_at >= ${start}
        AND deleted_at IS NULL
        AND status NOT IN ('CANCELLED', 'FAILED', 'PAYMENT_PENDING')
      GROUP BY 1
      ORDER BY 1
    `;

    return rows.map((row) => ({ month: row.month, revenue: Number(row.revenue) }));
  }
}

export class ShippingService {
  private cancellationSyncInFlight: Promise<number> | null = null;
  private cancellationSyncLastStartedAt = 0;
  private static readonly CANCELLATION_SYNC_COOLDOWN_MS = 45_000;

  private buildDispatchOrderWhere(
    courier?: string,
    search?: string,
    dateRange?: { gte?: Date; lte?: Date },
  ): Prisma.OrderWhereInput {
    const where: Prisma.OrderWhereInput = {
      deletedAt: null,
      status: 'READY_TO_SHIP',
      // Only real Shiprocket bookings — never status-only "ready" orders
      shipping: {
        is: {
          method: 'SHIPROCKET',
          shiprocketShipmentId: { not: null },
          awbCode: { not: null },
        },
      },
      ...(dateRange ? { createdAt: dateRange } : {}),
    };

    if (courier && courier !== 'ALL') {
      if (courier === 'UNASSIGNED') {
        where.shipping = {
          is: {
            method: 'SHIPROCKET',
            shiprocketShipmentId: { not: null },
            awbCode: { not: null },
            OR: [{ courierName: null }, { courierName: '' }],
          },
        };
      } else {
        where.shipping = {
          is: {
            method: 'SHIPROCKET',
            shiprocketShipmentId: { not: null },
            awbCode: { not: null },
            courierName: { equals: courier, mode: 'insensitive' },
          },
        };
      }
    }

    if (search) {
      const searchFilter: Prisma.OrderWhereInput = {
        OR: [
          { orderNumber: { contains: search, mode: 'insensitive' } },
          { customerName: { contains: search, mode: 'insensitive' } },
          { customerPhone: { contains: search } },
          { shipping: { is: { awbCode: { contains: search, mode: 'insensitive' } } } },
          { shipping: { is: { trackingNumber: { contains: search, mode: 'insensitive' } } } },
          { shipping: { is: { courierName: { contains: search, mode: 'insensitive' } } } },
        ],
      };
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        searchFilter,
      ];
    }

    return where;
  }

  private async getCourierPartnerCounts(search?: string): Promise<{
    total: number;
    unassigned: number;
    partners: { key: string; label: string; count: number }[];
  }> {
    const cacheKey = `dashboard:courier-counts:${search?.trim() || 'all'}`;
    return withCache(cacheKey, 30 * 1000, () => this.fetchCourierPartnerCounts(search));
  }

  private async fetchCourierPartnerCounts(search?: string): Promise<{
    total: number;
    unassigned: number;
    partners: { key: string; label: string; count: number }[];
  }> {
    if (!search?.trim()) {
      const rows = await prisma.$queryRaw<Array<{ courier_name: string | null; count: number }>>`
        SELECT s.courier_name, COUNT(*)::int AS count
        FROM orders o
        INNER JOIN shipping s ON s.order_id = o.id
        WHERE o.deleted_at IS NULL
          AND o.status = 'READY_TO_SHIP'
          AND s.method = 'SHIPROCKET'
          AND s.shiprocket_shipment_id IS NOT NULL
          AND s.awb_code IS NOT NULL
        GROUP BY s.courier_name
      `;

      let unassigned = 0;
      const counts = new Map<string, number>();

      for (const row of rows) {
        const name = row.courier_name?.trim();
        if (!name) {
          unassigned += Number(row.count);
        } else {
          counts.set(name, Number(row.count));
        }
      }

      const partners = Array.from(counts.entries())
        .map(([key, count]) => ({ key, label: key, count }))
        .sort((a, b) => b.count - a.count);

      const total = partners.reduce((sum, partner) => sum + partner.count, 0) + unassigned;
      return { total, unassigned, partners };
    }

    const baseWhere: Prisma.OrderWhereInput = {
      deletedAt: null,
      status: 'READY_TO_SHIP',
      shipping: {
        is: {
          method: 'SHIPROCKET',
          shiprocketShipmentId: { not: null },
          awbCode: { not: null },
        },
      },
      ...(search
        ? {
            AND: [
              {
                OR: [
                  { orderNumber: { contains: search, mode: 'insensitive' } },
                  { customerName: { contains: search, mode: 'insensitive' } },
                  { customerPhone: { contains: search } },
                  { shipping: { is: { awbCode: { contains: search, mode: 'insensitive' } } } },
                  {
                    shipping: { is: { trackingNumber: { contains: search, mode: 'insensitive' } } },
                  },
                  { shipping: { is: { courierName: { contains: search, mode: 'insensitive' } } } },
                ],
              },
            ],
          }
        : {}),
    };

    const readyOrders = await prisma.order.findMany({
      where: baseWhere,
      select: { shipping: { select: { courierName: true } } },
    });

    const counts = new Map<string, number>();
    let unassigned = 0;

    for (const order of readyOrders) {
      const name = order.shipping?.courierName?.trim();
      if (!name) {
        unassigned++;
      } else {
        counts.set(name, (counts.get(name) || 0) + 1);
      }
    }

    const partners = Array.from(counts.entries())
      .map(([key, count]) => ({ key, label: key, count }))
      .sort((a, b) => b.count - a.count);

    return { total: readyOrders.length, unassigned, partners };
  }

  async listDispatches(query: Record<string, string>) {
    this.scheduleShiprocketCancellationSync();

    const { page, limit, skip } = parsePagination(query);
    const rawCourier = query.courier?.trim();
    const courier =
      !rawCourier || rawCourier.toUpperCase() === 'ALL'
        ? undefined
        : rawCourier.toUpperCase() === 'UNASSIGNED'
          ? 'UNASSIGNED'
          : rawCourier;
    const search = query.search?.trim();
    const dateRange = parseCreatedAtFilter(query);
    const where = this.buildDispatchOrderWhere(courier, search, dateRange);

    const [orders, total, partnerCounts] = await Promise.all([
      prisma.order.findMany({
        where,
        include: { shipping: true },
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.order.count({ where }),
      this.getCourierPartnerCounts(search),
    ]);

    const dispatches = orders.map((order) => ({
      id: order.id,
      shippingId: order.shipping?.id ?? order.id,
      orderNumber: order.orderNumber,
      orderStatus: order.status,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      grandTotal: order.grandTotal,
      courierPartner: order.shipping?.courierName ?? null,
      method: order.shipping?.method ?? 'SHIPROCKET',
      awbCode: order.shipping?.awbCode ?? null,
      trackingNumber: order.shipping?.trackingNumber ?? null,
      trackingUrl: order.shipping?.trackingUrl ?? null,
      shiprocketShipmentId: order.shipping?.shiprocketShipmentId ?? null,
      shippedAt: order.shipping?.shippedAt ?? null,
      dispatchedAt: order.shipping?.updatedAt ?? order.updatedAt,
      orderCreatedAt: order.createdAt,
    }));

    return {
      dispatches,
      courierPartners: [
        { key: 'ALL', label: 'All Orders', count: partnerCounts.total },
        ...partnerCounts.partners.filter((p) => p.count > 0),
      ],
      meta: buildPaginationMeta(page, limit, total),
    };
  }

  async createManualShipping(
    orderId: string,
    data: { courierName: string; trackingNumber: string; trackingUrl?: string },
  ) {
    const order = await prisma.order.findFirst({ where: { id: orderId, deletedAt: null } });
    if (!order) throw new ApiError(404, 'Order not found');

    const shipping = await prisma.shipping.upsert({
      where: { orderId },
      update: {
        method: 'MANUAL',
        courierName: data.courierName,
        trackingNumber: data.trackingNumber,
        trackingUrl: data.trackingUrl,
        shippedAt: new Date(),
      },
      create: {
        orderId,
        method: 'MANUAL',
        courierName: data.courierName,
        trackingNumber: data.trackingNumber,
        trackingUrl: data.trackingUrl,
        shippedAt: new Date(),
      },
    });

    await prisma.order.update({ where: { id: orderId }, data: { status: 'SHIPPED' } });
    await prisma.trackingHistory.create({
      data: {
        orderId,
        status: 'SHIPPED',
        description: `Shipped via ${data.courierName}. Tracking: ${data.trackingNumber}`,
      },
    });

    realtime.orderStatusChanged({
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: 'SHIPPED',
      customerPhone: order.customerPhone,
      grandTotal: Number(order.grandTotal),
    });
    invalidateCache('dashboard:');

    void this.notifyFulfillmentStatus(orderId, 'SHIPPED', data.trackingUrl).catch((err) =>
      logger.warn('Manual ship notification failed', { orderId, err }),
    );

    return shipping;
  }

  async listAvailableCouriers(orderId: string, mode: ShiprocketShippingMode = 'domestic') {
    const order = await prisma.order.findFirst({
      where: { id: orderId, deletedAt: null },
      include: { items: true, shipping: true },
    });
    if (!order) throw new ApiError(404, 'Order not found');

    const isRtoReship = order.status === 'RTO';
    if (order.status !== 'CONFIRMED' && !isRtoReship) {
      throw new ApiError(400, 'Only confirmed or RTO orders can create shipment');
    }
    if (
      !isRtoReship &&
      order.shipping?.shiprocketShipmentId &&
      order.shipping.awbCode &&
      order.shipping.pickupScheduled
    ) {
      throw new ApiError(400, 'Shipment already created for this order');
    }

    const resolvedMode = this.resolveShippingMode(order, mode);
    const address = this.parseShippingAddress(order.shippingAddress);
    const postalCode = address.postalCode?.trim();
    if (!postalCode) {
      throw new ApiError(400, 'Order shipping address is missing a postal code');
    }

    const weightKg = this.resolveOrderWeightKg(order);
    const declaredValue = Number(order.grandTotal);
    const packageDims = this.resolveOrderPackageDimensions(order);

    if (resolvedMode === 'quick') {
      const quickPayload = await this.buildQuickLocationPayload(order, address);
      // Instant: POST /v1/external/quick/quote only
      const quote = await shiprocketService.quoteQuickDelivery(quickPayload);
      return {
        mode: resolvedMode,
        couriers: [
          {
            courierId: quote.courierId && quote.courierId > 0 ? quote.courierId : 1,
            courierName: quote.courierName || 'Shiprocket Quick',
            rate: quote.rate,
            etd: quote.etaMinutes,
            rating: null,
          },
        ],
      };
    }

    if (resolvedMode === 'international') {
      const countryCode = this.resolveCountryCode(address);
      const couriers = await shiprocketService.getInternationalCouriers({
        deliveryPostalCode: postalCode,
        weightKg,
        declaredValue,
        deliveryCountryCode: countryCode,
        lengthCm: packageDims.length,
        breadthCm: packageDims.width,
        heightCm: packageDims.height,
      });
      if (couriers.length === 0) {
        throw new ApiError(400, 'No international courier partners available for this destination');
      }
      return { mode: resolvedMode, couriers };
    }

    const couriers = await shiprocketService.getAvailableCouriers({
      deliveryPostalCode: postalCode,
      weightKg,
      declaredValue,
    });

    if (couriers.length === 0) {
      throw new ApiError(400, 'No courier partners available for this delivery pincode');
    }

    return { mode: resolvedMode, couriers };
  }

  async createShiprocketOrder(
    orderId: string,
    options: {
      courierId?: number;
      pickupDate?: string;
      courierName?: string;
      mode?: ShiprocketShippingMode;
    },
  ) {
    const mode = options.mode ?? 'domestic';
    if (mode === 'quick') {
      return this.createQuickShiprocketOrder(orderId, {
        courierName: options.courierName,
        courierId: options.courierId,
      });
    }

    const courierId = options.courierId;
    const pickupDate = options.pickupDate?.trim() ?? '';
    if (!courierId || courierId <= 0) {
      throw new ApiError(400, 'Courier partner is required');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pickupDate)) {
      throw new ApiError(400, 'Pickup date must be YYYY-MM-DD');
    }

    if (mode === 'international') {
      return this.createInternationalShiprocketOrder(orderId, {
        courierId,
        pickupDate,
        courierName: options.courierName,
      });
    }

    return this.createDomesticShiprocketOrder(orderId, {
      courierId,
      pickupDate,
      courierName: options.courierName,
    });
  }

  private async createDomesticShiprocketOrder(
    orderId: string,
    options: {
      courierId: number;
      pickupDate: string;
      courierName?: string;
      latitude?: number;
      longitude?: number;
      asInstantHyperlocal?: boolean;
    },
  ) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, deletedAt: null },
      include: { items: true, shipping: true },
    });
    if (!order) throw new ApiError(404, 'Order not found');

    const isRtoReship = order.status === 'RTO';
    if (order.status !== 'CONFIRMED' && !isRtoReship) {
      throw new ApiError(400, 'Only confirmed or RTO orders can create shipment');
    }

    const existingShipping = order.shipping;
    const hasShipmentId = Boolean(existingShipping?.shiprocketShipmentId);
    const hasAwb = Boolean(existingShipping?.awbCode);
    const canResumeAwb = !isRtoReship && hasShipmentId && !hasAwb;
    const canResumePickup =
      !isRtoReship && hasShipmentId && hasAwb && !existingShipping?.pickupScheduled;

    if (!isRtoReship && hasShipmentId && hasAwb && existingShipping?.pickupScheduled) {
      throw new ApiError(400, 'Shipment already created for this order');
    }

    const pickupDate = options.pickupDate.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pickupDate)) {
      throw new ApiError(400, 'Pickup date must be YYYY-MM-DD');
    }
    const pickupDay = new Date(`${pickupDate}T00:00:00`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (Number.isNaN(pickupDay.getTime()) || pickupDay < today) {
      throw new ApiError(400, 'Pickup date cannot be in the past');
    }

    const address = order.shippingAddress as {
      addressLine1: string;
      city: string;
      state: string;
      postalCode: string;
      country: string;
    };

    if (!address?.addressLine1 || !address?.postalCode || !address?.city || !address?.state) {
      throw new ApiError(400, 'Order shipping address is incomplete');
    }

    let shipmentId: number;
    let shiprocketOrderId = '';
    let shiprocketOrder: Record<string, unknown> = {};
    let awbResult: Record<string, unknown> = {};
    let awbCode: string | null = existingShipping?.awbCode ?? null;
    let courierName: string | null =
      options.courierName?.trim() || existingShipping?.courierName || null;

    if ((canResumeAwb || canResumePickup) && existingShipping?.shiprocketShipmentId) {
      shipmentId = parseInt(existingShipping.shiprocketShipmentId, 10);
      if (!Number.isFinite(shipmentId) || shipmentId <= 0) {
        throw new ApiError(502, 'Stored Shiprocket shipment id is invalid');
      }
      shiprocketOrderId = existingShipping.shiprocketOrderId || '';
    } else {
      const nameParts = order.customerName.split(' ');
      const packageDims = this.resolveOrderPackageDimensions(order);
      const totalWeightKg = this.resolveOrderWeightKg(order);

      const buildPayload = (orderRef: string) => {
        const payload: Record<string, unknown> = {
          order_id: orderRef,
          order_date: order.createdAt.toISOString().split('T')[0],
          pickup_location: env.SHIPROCKET_PICKUP_LOCATION || 'Primary',
          billing_customer_name: nameParts[0],
          billing_last_name: nameParts.slice(1).join(' ') || '.',
          billing_address: address.addressLine1,
          billing_city: address.city,
          billing_pincode: address.postalCode,
          billing_state: address.state,
          billing_country: address.country || 'India',
          billing_email: order.customerEmail,
          billing_phone: order.customerPhone,
          shipping_is_billing: true,
          order_items: order.items.map((item) => ({
            name: item.productName,
            sku: item.sku,
            units: item.quantity,
            selling_price: Number(item.unitPrice),
            discount: 0,
            tax: 0,
            hsn: 5208,
          })),
          payment_method: 'Prepaid',
          sub_total: Number(order.subtotal),
          length: packageDims.length,
          breadth: packageDims.width,
          height: packageDims.height,
          weight: totalWeightKg,
        };
        // Instant hyperlocal booking needs drop GPS on the Shiprocket order
        if (
          options.asInstantHyperlocal &&
          options.latitude != null &&
          options.longitude != null &&
          Number.isFinite(options.latitude) &&
          Number.isFinite(options.longitude)
        ) {
          payload.latitude = options.latitude;
          payload.longitude = options.longitude;
        }
        return payload;
      };

      const priorShipmentCount = await prisma.shipmentHistory.count({ where: { orderId } });
      // After a cancelled shipment, reuse of the same Shiprocket order_id often fails —
      // use a unique ref when this order has prior shipment history.
      const primaryRef = isRtoReship
        ? `${order.orderNumber}-RTO-${Date.now()}`
        : priorShipmentCount > 0
          ? `${order.orderNumber}-SR-${Date.now()}`
          : order.orderNumber;

      try {
        shiprocketOrder = await shiprocketService.createOrder(buildPayload(primaryRef));
      } catch (error) {
        if (isRtoReship) throw error;
        shiprocketOrder = await shiprocketService.createOrder(
          buildPayload(`${order.orderNumber}-SR-${Date.now()}`),
        );
      }

      const shipmentIdParsed = shiprocketService.extractShipmentId(shiprocketOrder);
      if (!shipmentIdParsed) {
        const message =
          (typeof shiprocketOrder.message === 'string' && shiprocketOrder.message.trim()) ||
          'Shiprocket did not return a valid shipment id';
        throw new ApiError(502, message);
      }
      shipmentId = shipmentIdParsed;
      shiprocketOrderId = String(
        shiprocketOrder.order_id ||
          (shiprocketOrder.data as Record<string, unknown> | undefined)?.order_id ||
          '',
      );

      if (isRtoReship && existingShipping) {
        await prisma.shipmentHistory.create({
          data: {
            orderId,
            method: existingShipping.method,
            shiprocketOrderId: existingShipping.shiprocketOrderId,
            shiprocketShipmentId: existingShipping.shiprocketShipmentId,
            awbCode: existingShipping.awbCode,
            courierName: existingShipping.courierName,
            trackingNumber: existingShipping.trackingNumber,
            trackingUrl: existingShipping.trackingUrl,
            labelUrl: existingShipping.labelUrl,
            manifestUrl: existingShipping.manifestUrl,
            shippedAt: existingShipping.shippedAt,
            deliveredAt: existingShipping.deliveredAt,
            reason: 'RTO reshipment',
          },
        });
      }

      await prisma.shipping.upsert({
        where: { orderId },
        update: {
          method: 'SHIPROCKET',
          shiprocketOrderId,
          shiprocketShipmentId: String(shipmentId),
          awbCode: null,
          courierName: null,
          trackingNumber: null,
          pickupScheduled: null,
          ...(isRtoReship && {
            trackingUrl: null,
            labelUrl: null,
            manifestUrl: null,
            shippedAt: null,
            deliveredAt: null,
          }),
        },
        create: {
          orderId,
          method: 'SHIPROCKET',
          shiprocketOrderId,
          shiprocketShipmentId: String(shipmentId),
        },
      });
    }

    if (!awbCode) {
      awbResult = await shiprocketService.generateAWB(shipmentId, options.courierId);
      const awbData =
        (awbResult.response as { data?: Record<string, unknown> } | undefined)?.data ??
        (awbResult.data as Record<string, unknown> | undefined) ??
        awbResult;
      awbCode =
        (typeof awbData.awb_code === 'string' && awbData.awb_code) ||
        (typeof awbResult.awb_code === 'string' && (awbResult.awb_code as string)) ||
        null;
      courierName =
        options.courierName?.trim() ||
        (typeof awbData.courier_name === 'string' && awbData.courier_name) ||
        (typeof awbData.courier_company_name === 'string' && awbData.courier_company_name) ||
        courierName;

      await prisma.shipping.update({
        where: { orderId },
        data: {
          awbCode,
          courierName,
          trackingNumber: awbCode,
          ...(awbCode ? { trackingUrl: `https://shiprocket.co/tracking/${awbCode}` } : {}),
        },
      });
    } else if (awbCode && !existingShipping?.trackingUrl) {
      await prisma.shipping.update({
        where: { orderId },
        data: { trackingUrl: `https://shiprocket.co/tracking/${awbCode}` },
      });
    }

    try {
      await shiprocketService.generatePickup([shipmentId], pickupDate);
    } catch (error) {
      if (error instanceof ApiError) {
        throw new ApiError(
          error.statusCode,
          `AWB assigned but pickup scheduling failed: ${error.message}. Retry create shipment to schedule pickup.`,
        );
      }
      throw new ApiError(
        502,
        'AWB assigned but pickup scheduling failed. Retry create shipment to schedule pickup.',
      );
    }

    const shipping = await prisma.shipping.update({
      where: { orderId },
      data: {
        pickupScheduled: pickupDay,
        courierName: courierName || undefined,
      },
    });

    if (order.status !== 'READY_TO_SHIP') {
      await prisma.order.update({ where: { id: orderId }, data: { status: 'READY_TO_SHIP' } });
      await prisma.trackingHistory.create({
        data: {
          orderId,
          status: 'READY_TO_SHIP',
          description: options.asInstantHyperlocal
            ? `Instant hyperlocal booked via ${courierName || 'courier'}. Pickup: ${pickupDate}`
            : isRtoReship
              ? `New shipment created after RTO via ${courierName || 'courier'}. Pickup: ${pickupDate}`
              : canResumeAwb || canResumePickup
                ? `Shipment resumed via ${courierName || 'courier'}. Pickup: ${pickupDate}`
                : `Shipment created via ${courierName || 'courier'}. Pickup: ${pickupDate}`,
        },
      });
      orderEmailService.queueStatusEmail(orderId, 'READY_TO_SHIP');
    } else if (canResumePickup) {
      await prisma.trackingHistory.create({
        data: {
          orderId,
          status: 'READY_TO_SHIP',
          description: `Pickup scheduled for ${pickupDate} via ${courierName || 'courier'}`,
        },
      });
    }

    let labelUrl: string | null = shipping.labelUrl;
    if (awbCode && shipping.shiprocketShipmentId) {
      try {
        const fetchedLabel = await shiprocketService.getLabel(
          parseInt(shipping.shiprocketShipmentId, 10),
        );
        if (fetchedLabel) {
          labelUrl = fetchedLabel;
          await prisma.shipping.update({
            where: { orderId },
            data: { labelUrl },
          });
        }
      } catch {
        // Label can be fetched later via getShiprocketLabel — shipment is still valid
      }
    }

    const finalShipping = labelUrl
      ? { ...shipping, labelUrl }
      : await prisma.shipping.findUniqueOrThrow({ where: { orderId } });

    const updatedOrder = await prisma.order.findFirst({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        customerPhone: true,
        grandTotal: true,
      },
    });
    if (updatedOrder) {
      realtime.orderStatusChanged({
        orderId: updatedOrder.id,
        orderNumber: updatedOrder.orderNumber,
        status: updatedOrder.status,
        customerPhone: updatedOrder.customerPhone,
        grandTotal: Number(updatedOrder.grandTotal),
      });
      invalidateCache('dashboard:');
    }

    return { shipping: finalShipping, shiprocket: shiprocketOrder, awb: awbResult };
  }

  private async createInternationalShiprocketOrder(
    orderId: string,
    options: { courierId: number; pickupDate: string; courierName?: string },
  ) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, deletedAt: null },
      include: { items: true, shipping: true },
    });
    if (!order) throw new ApiError(404, 'Order not found');

    const isRtoReship = order.status === 'RTO';
    if (order.status !== 'CONFIRMED' && !isRtoReship) {
      throw new ApiError(400, 'Only confirmed or RTO orders can create shipment');
    }

    const existingShipping = order.shipping;
    if (!isRtoReship && existingShipping?.shiprocketShipmentId && existingShipping.awbCode) {
      throw new ApiError(400, 'International shipment already created for this order');
    }

    const pickupDate = options.pickupDate.trim();
    const pickupDay = new Date(`${pickupDate}T00:00:00`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (Number.isNaN(pickupDay.getTime()) || pickupDay < today) {
      throw new ApiError(400, 'Pickup date cannot be in the past');
    }

    const address = this.parseShippingAddress(order.shippingAddress);
    if (!address.addressLine1 || !address.postalCode || !address.city || !address.state) {
      throw new ApiError(400, 'Order shipping address is incomplete');
    }

    const countryCode = this.resolveCountryCode(address);
    if (countryCode === 'IN') {
      throw new ApiError(400, 'International shipping requires a non-India destination');
    }

    const priorShipmentCount = await prisma.shipmentHistory.count({ where: { orderId } });
    const orderRef = isRtoReship
      ? `${order.orderNumber}-RTO-${Date.now()}`
      : priorShipmentCount > 0
        ? `${order.orderNumber}-SR-${Date.now()}`
        : order.orderNumber;

    const payload = this.buildShiprocketOrderPayload(order, address, orderRef, {
      international: true,
      countryCode,
    });

    const shiprocketOrder = await shiprocketService.createInternationalForwardShipment(payload);
    const shipmentId = shiprocketService.extractShipmentId(shiprocketOrder);
    if (!shipmentId) {
      throw new ApiError(502, 'Shiprocket did not return a valid international shipment id');
    }

    const shiprocketOrderId = String(
      shiprocketOrder.order_id ||
        (shiprocketOrder.data as Record<string, unknown> | undefined)?.order_id ||
        shipmentId,
    );

    await prisma.shipping.upsert({
      where: { orderId },
      update: {
        method: 'SHIPROCKET',
        shiprocketOrderId,
        shiprocketShipmentId: String(shipmentId),
        awbCode: null,
        courierName: null,
        trackingNumber: null,
        pickupScheduled: null,
      },
      create: {
        orderId,
        method: 'SHIPROCKET',
        shiprocketOrderId,
        shiprocketShipmentId: String(shipmentId),
      },
    });

    const awbResult = await shiprocketService.assignInternationalAWB(shipmentId, options.courierId);
    const awbData =
      (awbResult.response as { data?: Record<string, unknown> } | undefined)?.data ??
      (awbResult.data as Record<string, unknown> | undefined) ??
      awbResult;
    const awbCode =
      (typeof awbData.awb_code === 'string' && awbData.awb_code) ||
      (typeof awbResult.awb_code === 'string' && (awbResult.awb_code as string)) ||
      null;
    const courierName =
      options.courierName?.trim() ||
      (typeof awbData.courier_name === 'string' && awbData.courier_name) ||
      (typeof awbData.courier_company_name === 'string' && awbData.courier_company_name) ||
      null;

    const shipping = await prisma.shipping.update({
      where: { orderId },
      data: {
        awbCode,
        courierName,
        trackingNumber: awbCode,
        pickupScheduled: pickupDay,
        ...(awbCode ? { trackingUrl: `https://shiprocket.co/tracking/${awbCode}` } : {}),
      },
    });

    if (order.status !== 'READY_TO_SHIP') {
      await prisma.order.update({ where: { id: orderId }, data: { status: 'READY_TO_SHIP' } });
      await prisma.trackingHistory.create({
        data: {
          orderId,
          status: 'READY_TO_SHIP',
          description: `International shipment created via ${courierName || 'courier'}. Pickup: ${pickupDate}`,
        },
      });
      orderEmailService.queueStatusEmail(orderId, 'READY_TO_SHIP');
    }

    await this.broadcastOrderShippingUpdate(orderId);
    return {
      shipping,
      shiprocket: shiprocketOrder,
      awb: awbResult,
      mode: 'international' as const,
    };
  }

  private async createQuickShiprocketOrder(
    orderId: string,
    options?: { courierName?: string; courierId?: number },
  ) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, deletedAt: null },
      include: { items: true, shipping: true },
    });
    if (!order) throw new ApiError(404, 'Order not found');

    const isRtoReship = order.status === 'RTO';
    if (order.status !== 'CONFIRMED' && !isRtoReship) {
      throw new ApiError(400, 'Only confirmed or RTO orders can create shipment');
    }
    if (!isRtoReship && order.shipping?.shiprocketOrderId) {
      throw new ApiError(400, 'Quick delivery already created for this order');
    }

    const address = this.parseShippingAddress(order.shippingAddress);
    if (!address.addressLine1 || !address.postalCode || !address.city) {
      throw new ApiError(400, 'Order shipping address is incomplete');
    }

    const priorShipmentCount = await prisma.shipmentHistory.count({ where: { orderId } });
    const orderRef = isRtoReship
      ? `${order.orderNumber}-Q-RTO-${Date.now()}`
      : priorShipmentCount > 0
        ? `${order.orderNumber}-Q-${Date.now()}`
        : `${order.orderNumber}-Q`;

    const quickLocation = await this.buildQuickLocationPayload(order, address);
    const deliveryAddress = [
      address.addressLine1,
      address.addressLine2,
      address.landmark,
      address.city,
      address.state,
      address.postalCode,
    ]
      .filter(Boolean)
      .join(', ');

    // Instant uses only POST /v1/external/quick/orders (no domestic fallback)
    const quickOrder = await shiprocketService.createQuickDelivery({
      ...quickLocation,
      orderRef,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      customerEmail: order.customerEmail,
      pickupAddress: env.SHIPROCKET_PICKUP_LOCATION || 'Primary',
      deliveryAddress,
      paymentMethod: 'Prepaid',
      subTotal: Number(order.subtotal),
      orderItems: order.items.map((item) => ({
        name: item.productName,
        sku: item.sku,
        units: item.quantity,
        sellingPrice: Number(item.unitPrice),
      })),
    });

    const quickOrderId = shiprocketService.extractQuickOrderId(quickOrder);
    if (!quickOrderId) {
      throw new ApiError(502, 'Shiprocket Quick did not return an order id');
    }

    const resolvedCourier = options?.courierName?.trim() || 'Shiprocket Quick';
    const shipping = await prisma.shipping.upsert({
      where: { orderId },
      update: {
        method: 'SHIPROCKET',
        shiprocketOrderId: quickOrderId,
        shiprocketShipmentId: quickOrderId,
        courierName: resolvedCourier,
        awbCode: null,
        trackingNumber: quickOrderId,
        trackingUrl: null,
        labelUrl: null,
        manifestUrl: null,
        pickupScheduled: new Date(),
      },
      create: {
        orderId,
        method: 'SHIPROCKET',
        shiprocketOrderId: quickOrderId,
        shiprocketShipmentId: quickOrderId,
        courierName: resolvedCourier,
        trackingNumber: quickOrderId,
        pickupScheduled: new Date(),
      },
    });

    if (order.status !== 'READY_TO_SHIP') {
      await prisma.order.update({ where: { id: orderId }, data: { status: 'READY_TO_SHIP' } });
      await prisma.trackingHistory.create({
        data: {
          orderId,
          status: 'READY_TO_SHIP',
          description: `Instant (Shiprocket Quick) booked via ${resolvedCourier}`,
        },
      });
      orderEmailService.queueStatusEmail(orderId, 'READY_TO_SHIP');
    }

    await this.broadcastOrderShippingUpdate(orderId);
    return { shipping, shiprocket: quickOrder, mode: 'quick' as const };
  }

  async getShiprocketInvoice(orderId: string): Promise<{ invoiceUrl: string }> {
    const order = await prisma.order.findFirst({
      where: { id: orderId, deletedAt: null },
      include: { shipping: true },
    });
    if (!order?.shipping?.shiprocketOrderId) {
      throw new ApiError(400, 'Shiprocket order not found for this shipment');
    }

    const srOrderId = parseInt(order.shipping.shiprocketOrderId, 10);
    if (!Number.isFinite(srOrderId) || srOrderId <= 0) {
      throw new ApiError(400, 'Shiprocket order id is invalid for invoice generation');
    }

    const invoiceUrl = await shiprocketService.getInvoiceUrl(srOrderId);
    return { invoiceUrl };
  }

  async getShiprocketManifest(orderId: string): Promise<{ manifestUrl: string }> {
    const order = await prisma.order.findFirst({
      where: { id: orderId, deletedAt: null },
      include: { shipping: true },
    });
    if (!order?.shipping?.shiprocketShipmentId) {
      throw new ApiError(400, 'Shiprocket shipment not found');
    }

    if (order.shipping.manifestUrl) {
      return { manifestUrl: order.shipping.manifestUrl };
    }

    const shipmentId = parseInt(order.shipping.shiprocketShipmentId, 10);
    if (!Number.isFinite(shipmentId) || shipmentId <= 0) {
      throw new ApiError(400, 'Shiprocket shipment id is invalid for manifest generation');
    }

    const manifestUrl = await shiprocketService.getManifestUrl(shipmentId);
    await prisma.shipping.update({
      where: { orderId },
      data: { manifestUrl },
    });
    return { manifestUrl };
  }

  async cancelShiprocketShipment(orderId: string): Promise<Record<string, unknown>> {
    const order = await prisma.order.findFirst({
      where: { id: orderId, deletedAt: null },
      include: { shipping: true },
    });
    if (!order?.shipping) {
      throw new ApiError(400, 'No Shiprocket shipment found for this order');
    }

    const shipping = order.shipping;
    const quickOrderId = shipping.shiprocketOrderId?.trim();
    const isQuick =
      Boolean(quickOrderId) &&
      (!shipping.awbCode ||
        shipping.shiprocketShipmentId === quickOrderId ||
        shipping.courierName?.toLowerCase().includes('quick'));

    let result: Record<string, unknown> = {};
    try {
      if (isQuick && quickOrderId) {
        result = await shiprocketService.cancelQuickDelivery(quickOrderId);
      } else if (shipping.awbCode) {
        result = await shiprocketService.cancelByAwbs([shipping.awbCode]);
      } else {
        const srOrderId = parseInt(shipping.shiprocketOrderId || '', 10);
        if (!Number.isFinite(srOrderId) || srOrderId <= 0) {
          throw new ApiError(400, 'Unable to cancel — missing Shiprocket identifiers');
        }
        result = await shiprocketService.cancelOrders([srOrderId]);
      }
    } catch (error) {
      // Still clear local shipment so admin can recreate from Confirmed
      logger.warn('Shiprocket cancel API failed — applying local cancellation anyway', {
        orderId,
        error,
      });
      result = {
        localOnly: true,
        message: error instanceof Error ? error.message : 'Shiprocket cancel failed',
      };
    }

    await this.applyShiprocketCancellationFromSync(orderId);
    return result;
  }

  async trackQuickDelivery(orderId: string): Promise<Record<string, unknown>> {
    const order = await prisma.order.findFirst({
      where: { id: orderId, deletedAt: null },
      include: { shipping: true },
    });
    const quickOrderId = order?.shipping?.shiprocketOrderId?.trim();
    if (!quickOrderId) {
      throw new ApiError(400, 'Quick delivery order id not found');
    }
    return shiprocketService.trackQuickOrder(quickOrderId);
  }

  /**
   * Preview lowest-rate courier per order (no shipment created).
   * Used so admin can see total shipping cost before confirming bulk create.
   */
  async quoteBulkShiprocketOrders(orderIds: string[]) {
    const uniqueIds = [...new Set(orderIds)];
    const quotes: Array<{
      orderId: string;
      orderNumber: string | null;
      courierId: number | null;
      courierName: string | null;
      rate: number | null;
      etd: string | null;
      error: string | null;
    }> = [];

    for (const orderId of uniqueIds) {
      const order = await prisma.order.findFirst({
        where: { id: orderId, deletedAt: null },
        select: { orderNumber: true },
      });

      try {
        const { couriers } = await this.listAvailableCouriers(orderId);
        const cheapest = couriers[0];
        if (!cheapest) {
          quotes.push({
            orderId,
            orderNumber: order?.orderNumber ?? null,
            courierId: null,
            courierName: null,
            rate: null,
            etd: null,
            error: 'No courier partners available',
          });
          continue;
        }

        quotes.push({
          orderId,
          orderNumber: order?.orderNumber ?? null,
          courierId: cheapest.courierId,
          courierName: cheapest.courierName,
          rate: cheapest.rate,
          etd: cheapest.etd,
          error: null,
        });
      } catch (error) {
        quotes.push({
          orderId,
          orderNumber: order?.orderNumber ?? null,
          courierId: null,
          courierName: null,
          rate: null,
          etd: null,
          error: error instanceof ApiError ? error.message : 'Could not quote courier',
        });
      }
    }

    const ready = quotes.filter((q) => q.error == null && q.rate != null && q.courierId != null);
    const totalRate = ready.reduce((sum, q) => sum + Number(q.rate), 0);

    return {
      quotes,
      totalRate,
      quoteCount: ready.length,
      failedCount: quotes.length - ready.length,
    };
  }

  /**
   * Create Shiprocket shipments for many orders, auto-picking the lowest-rate
   * courier available for each order's route/weight (or using confirmed selections).
   */
  async bulkCreateShiprocketOrders(
    orderIds: string[],
    pickupDate: string,
    selections?: Array<{ orderId: string; courierId: number; courierName?: string }>,
  ) {
    const uniqueIds = [...new Set(orderIds)];
    const selectionById = new Map((selections ?? []).map((row) => [row.orderId, row] as const));
    const succeeded: Array<{
      orderId: string;
      courierId: number;
      courierName: string;
      rate: number | null;
    }> = [];
    const failed: Array<{ orderId: string; message: string }> = [];

    for (const orderId of uniqueIds) {
      try {
        const preselected = selectionById.get(orderId);
        let courierId: number;
        let courierName: string;
        let rate: number | null = null;

        if (preselected) {
          courierId = preselected.courierId;
          courierName = preselected.courierName?.trim() || 'Courier';
        } else {
          const { couriers } = await this.listAvailableCouriers(orderId);
          const cheapest = couriers[0];
          if (!cheapest) {
            failed.push({ orderId, message: 'No courier partners available' });
            continue;
          }
          courierId = cheapest.courierId;
          courierName = cheapest.courierName;
          rate = cheapest.rate;
        }

        await this.createShiprocketOrder(orderId, {
          courierId,
          pickupDate,
          courierName,
        });

        succeeded.push({
          orderId,
          courierId,
          courierName,
          rate,
        });
      } catch (error) {
        failed.push({
          orderId,
          message: error instanceof ApiError ? error.message : 'Failed to create shipment',
        });
      }
    }

    return {
      succeeded,
      failed,
      successCount: succeeded.length,
      failedCount: failed.length,
    };
  }

  /**
   * Apply a cancellation that already happened in Shiprocket:
   * archive shipping and return the order to CONFIRMED for re-shipment.
   * Does NOT call Shiprocket cancel APIs.
   */
  async applyShiprocketCancellationFromSync(orderId: string): Promise<{ status: 'CONFIRMED' }> {
    const order = await prisma.order.findFirst({
      where: { id: orderId, deletedAt: null },
      include: { shipping: true },
    });
    if (!order) throw new ApiError(404, 'Order not found');

    if (order.status !== 'READY_TO_SHIP') {
      return { status: 'CONFIRMED' };
    }

    const shipping = order.shipping;

    await prisma.$transaction(async (tx) => {
      if (shipping) {
        await tx.shipmentHistory.create({
          data: {
            orderId,
            method: shipping.method,
            shiprocketOrderId: shipping.shiprocketOrderId,
            shiprocketShipmentId: shipping.shiprocketShipmentId,
            awbCode: shipping.awbCode,
            courierName: shipping.courierName,
            trackingNumber: shipping.trackingNumber,
            trackingUrl: shipping.trackingUrl,
            labelUrl: shipping.labelUrl,
            manifestUrl: shipping.manifestUrl,
            shippedAt: shipping.shippedAt,
            deliveredAt: shipping.deliveredAt,
            reason: 'Shiprocket shipment cancelled (auto-synced)',
          },
        });
        await tx.shipping.delete({ where: { orderId } });
      }

      await tx.order.update({
        where: { id: orderId },
        data: { status: 'CONFIRMED' },
      });

      await tx.trackingHistory.create({
        data: {
          orderId,
          status: 'CONFIRMED',
          description:
            'Shiprocket shipment cancelled. Order auto-returned to Confirmed — create shipment again when ready.',
        },
      });
    });

    realtime.orderStatusChanged({
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: 'CONFIRMED',
      customerPhone: order.customerPhone,
      grandTotal: Number(order.grandTotal),
    });

    invalidateCache('dashboard:');
    orderEmailService.queueStatusEmail(orderId, 'CONFIRMED');

    return { status: 'CONFIRMED' };
  }

  /** Fire-and-forget sync so fulfillment stays aligned with Shiprocket (cancel + tracking). */
  scheduleShiprocketCancellationSync(limit = 40) {
    const now = Date.now();
    if (this.cancellationSyncInFlight) return;
    if (now - this.cancellationSyncLastStartedAt < ShippingService.CANCELLATION_SYNC_COOLDOWN_MS) {
      return;
    }

    this.cancellationSyncLastStartedAt = now;
    this.cancellationSyncInFlight = this.syncFulfillmentFromShiprocket(limit)
      .catch((err) => {
        logger.warn('Shiprocket fulfillment sync failed', { err });
        return 0;
      })
      .finally(() => {
        this.cancellationSyncInFlight = null;
      });
  }

  async syncFulfillmentFromShiprocket(limit = 40): Promise<number> {
    const cancelled = await this.syncCancelledShipmentsFromShiprocket(limit);
    const advanced = await this.syncForwardTrackingFromShiprocket(limit);
    return cancelled + advanced;
  }

  async syncCancelledShipmentsFromShiprocket(limit = 40): Promise<number> {
    const orders = await prisma.order.findMany({
      where: {
        deletedAt: null,
        status: 'READY_TO_SHIP',
        shipping: {
          is: {
            method: 'SHIPROCKET',
            OR: [
              { awbCode: { not: null } },
              { shiprocketOrderId: { not: null } },
              { shiprocketShipmentId: { not: null } },
            ],
          },
        },
      },
      include: { shipping: true },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });

    let reverted = 0;
    for (const order of orders) {
      if (!order.shipping) continue;
      try {
        const cancelled = await this.isShipmentCancelledInShiprocket(order.shipping);
        if (!cancelled) continue;
        await this.applyShiprocketCancellationFromSync(order.id);
        reverted += 1;
        logger.info('Auto-reverted order after Shiprocket cancellation', {
          orderId: order.id,
          orderNumber: order.orderNumber,
        });
      } catch (error) {
        logger.warn('Failed checking Shiprocket cancellation for order', {
          orderId: order.id,
          orderNumber: order.orderNumber,
          error: error instanceof Error ? error.message : error,
        });
      }
    }

    return reverted;
  }

  /** Advance READY_TO_SHIP / SHIPPED / IN_TRANSIT from Shiprocket track API. */
  async syncForwardTrackingFromShiprocket(limit = 40): Promise<number> {
    const orders = await prisma.order.findMany({
      where: {
        deletedAt: null,
        status: { in: ['READY_TO_SHIP', 'SHIPPED', 'IN_TRANSIT'] },
        shipping: {
          is: {
            method: 'SHIPROCKET',
            awbCode: { not: null },
          },
        },
      },
      include: { shipping: true },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });

    let updated = 0;
    for (const order of orders) {
      const awb = order.shipping?.awbCode?.trim();
      if (!awb) continue;
      try {
        const track = await shiprocketService.trackShipment(awb);
        if (shiprocketService.isCancelledPayload(track)) {
          if (order.status === 'READY_TO_SHIP') {
            await this.applyShiprocketCancellationFromSync(order.id);
            updated += 1;
          }
          continue;
        }
        const nextStatus = mapShiprocketPayloadToOrderStatus(track);
        if (!nextStatus) continue;
        const applied = await this.applyShiprocketFulfillmentStatus(order.id, nextStatus, {
          awbCode: awb,
          source: 'poll',
        });
        if (applied) updated += 1;
      } catch (error) {
        logger.warn('Failed syncing Shiprocket tracking for order', {
          orderId: order.id,
          orderNumber: order.orderNumber,
          error: error instanceof Error ? error.message : error,
        });
      }
    }

    return updated;
  }

  private async isShipmentCancelledInShiprocket(shipping: {
    awbCode: string | null;
    shiprocketOrderId: string | null;
  }): Promise<boolean> {
    if (shipping.awbCode) {
      const track = await shiprocketService.trackShipment(shipping.awbCode);
      if (shiprocketService.isCancelledPayload(track)) return true;
    }

    if (shipping.shiprocketOrderId) {
      const srOrderId = parseInt(shipping.shiprocketOrderId, 10);
      if (Number.isFinite(srOrderId) && srOrderId > 0) {
        const details = await shiprocketService.getOrderDetails(srOrderId);
        if (shiprocketService.isCancelledPayload(details)) return true;
      }
    }

    return false;
  }

  /**
   * Handle Shiprocket tracking webhook — cancel → Confirmed, or advance fulfillment status.
   */
  async handleShiprocketTrackingWebhook(payload: Record<string, unknown>): Promise<void> {
    const order = await this.findOrderForShiprocketPayload(payload);
    if (!order) {
      logger.info('Shiprocket tracking webhook: no matching order', {
        awb: payload.awb ?? payload.awb_code,
        srOrderId: payload.sr_order_id,
      });
      return;
    }

    if (shiprocketService.isCancelledPayload(payload)) {
      if (order.status === 'READY_TO_SHIP') {
        await this.applyShiprocketCancellationFromSync(order.id);
        logger.info('Shiprocket cancel webhook applied', {
          orderId: order.id,
          orderNumber: order.orderNumber,
        });
      }
      return;
    }

    const nextStatus = mapShiprocketPayloadToOrderStatus(payload);
    if (!nextStatus) {
      logger.info('Shiprocket tracking webhook: no mapped status', {
        orderId: order.id,
        current_status: payload.current_status,
        shipment_status: payload.shipment_status,
      });
      return;
    }

    const awb = String(payload.awb ?? payload.awb_code ?? order.shipping?.awbCode ?? '').trim();
    const applied = await this.applyShiprocketFulfillmentStatus(order.id, nextStatus, {
      awbCode: awb || undefined,
      source: 'webhook',
    });
    if (applied) {
      logger.info('Shiprocket tracking webhook applied', {
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: nextStatus,
      });
    }
  }

  private async findOrderForShiprocketPayload(payload: Record<string, unknown>) {
    const awb = String(payload.awb ?? payload.awb_code ?? '').trim();
    const srOrderId = String(payload.sr_order_id ?? '').trim();
    const channelOrderId = String(payload.channel_order_id ?? payload.order_id ?? '').trim();

    const orFilters: Prisma.OrderWhereInput[] = [];
    if (awb) orFilters.push({ shipping: { is: { awbCode: awb } } });
    if (srOrderId && /^\d+$/.test(srOrderId)) {
      orFilters.push({ shipping: { is: { shiprocketOrderId: srOrderId } } });
    }
    if (channelOrderId) {
      const baseOrderNumber = channelOrderId.split('-SR-')[0]?.split('-RTO-')[0] || channelOrderId;
      orFilters.push({ orderNumber: channelOrderId });
      if (baseOrderNumber !== channelOrderId) {
        orFilters.push({ orderNumber: baseOrderNumber });
      }
    }

    if (orFilters.length === 0) return null;

    return prisma.order.findFirst({
      where: {
        deletedAt: null,
        status: { in: ['READY_TO_SHIP', 'SHIPPED', 'IN_TRANSIT'] },
        OR: orFilters,
      },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        shipping: { select: { awbCode: true } },
      },
    });
  }

  /**
   * Apply a Shiprocket-mapped fulfillment status and broadcast to admin + customer.
   */
  async applyShiprocketFulfillmentStatus(
    orderId: string,
    nextStatus: OrderStatus,
    options?: { awbCode?: string; source?: 'webhook' | 'poll' },
  ): Promise<boolean> {
    const order = await prisma.order.findFirst({
      where: { id: orderId, deletedAt: null },
      include: { shipping: true },
    });
    if (!order) return false;
    if (!canApplyShiprocketFulfillmentStatus(order.status, nextStatus)) return false;

    const awb = options?.awbCode || order.shipping?.awbCode || undefined;
    const trackingUrl =
      order.shipping?.trackingUrl || (awb ? `https://shiprocket.co/tracking/${awb}` : undefined);
    const now = new Date();
    const sourceLabel = options?.source === 'webhook' ? 'Shiprocket webhook' : 'Shiprocket sync';

    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: { status: nextStatus },
      });

      await tx.trackingHistory.create({
        data: {
          orderId,
          status: nextStatus,
          description: `${getOrderStatusTrackingDescription(nextStatus)} (${sourceLabel})`,
        },
      });

      if (order.shipping) {
        await tx.shipping.update({
          where: { orderId },
          data: {
            ...(trackingUrl && !order.shipping.trackingUrl ? { trackingUrl } : {}),
            ...(nextStatus === 'SHIPPED' || nextStatus === 'IN_TRANSIT'
              ? { shippedAt: order.shipping.shippedAt ?? now }
              : {}),
            ...(nextStatus === 'DELIVERED' ? { deliveredAt: now } : {}),
          },
        });
      }
    });

    realtime.orderStatusChanged({
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: nextStatus,
      customerPhone: order.customerPhone,
      grandTotal: Number(order.grandTotal),
    });
    invalidateCache('dashboard:');

    if (['SHIPPED', 'IN_TRANSIT', 'DELIVERED', 'RTO', 'CANCELLED', 'READY_TO_SHIP'].includes(nextStatus)) {
      void this.notifyFulfillmentStatus(orderId, nextStatus, trackingUrl).catch((err) =>
        logger.warn('Fulfillment WhatsApp notify failed', { orderId, nextStatus, err }),
      );
    } else {
      // Always email on any Shiprocket-driven status change, even if WhatsApp is skipped.
      orderEmailService.queueStatusEmail(orderId, nextStatus);
    }

    return true;
  }

  private async notifyFulfillmentStatus(
    orderId: string,
    status: OrderStatus,
    trackingUrl?: string | null,
  ) {
    orderEmailService.queueStatusEmail(orderId, status);

    const order = await prisma.order.findFirst({
      where: { id: orderId, deletedAt: null },
      select: {
        customerPhone: true,
        customerName: true,
        orderNumber: true,
      },
    });
    if (!order) return;

    const notificationType =
      status === 'DELIVERED'
        ? 'ORDER_DELIVERED'
        : status === 'RTO'
          ? 'ORDER_CANCELLED'
          : 'ORDER_SHIPPED';

    const { sent: waSent, message: waMessage } = await whatsAppService.sendOrderStatusUpdate({
      customerPhone: order.customerPhone,
      customerName: order.customerName,
      orderNumber: order.orderNumber,
      status,
      trackingUrl: trackingUrl || undefined,
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

  /**
   * Official Shiprocket shipping label only — never generates a homemade HTML label.
   * Requires a real Shiprocket shipment with AWB.
   */
  async getShiprocketLabel(orderId: string): Promise<{ labelUrl: string }> {
    const order = await prisma.order.findFirst({
      where: { id: orderId, deletedAt: null },
      include: { shipping: true },
    });
    if (!order) throw new ApiError(404, 'Order not found');

    const shipping = order.shipping;
    if (
      !shipping ||
      shipping.method !== 'SHIPROCKET' ||
      !shipping.shiprocketShipmentId ||
      !shipping.awbCode
    ) {
      throw new ApiError(
        400,
        'No Shiprocket AWB for this order. Create shipment in Shiprocket before opening labels.',
      );
    }

    if (shipping.labelUrl) {
      return { labelUrl: shipping.labelUrl };
    }

    const labelUrl = await shiprocketService.getLabel(parseInt(shipping.shiprocketShipmentId, 10));
    if (!labelUrl) {
      throw new ApiError(502, 'Shiprocket did not return a label URL');
    }

    await prisma.shipping.update({
      where: { orderId },
      data: { labelUrl },
    });

    return { labelUrl };
  }

  async generateAWB(orderId: string, courierId: number) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, deletedAt: null },
      include: { shipping: true },
    });
    if (!order?.shipping?.shiprocketShipmentId) {
      throw new ApiError(400, 'Shiprocket shipment not found');
    }

    const result = await shiprocketService.generateAWB(
      parseInt(order.shipping.shiprocketShipmentId, 10),
      courierId,
    );
    const awbCode = (result.response as { data?: { awb_code?: string } } | undefined)?.data
      ?.awb_code;

    await prisma.shipping.update({
      where: { orderId },
      data: {
        awbCode,
        shippedAt: new Date(),
        ...(awbCode
          ? { trackingNumber: awbCode, trackingUrl: `https://shiprocket.co/tracking/${awbCode}` }
          : {}),
      },
    });
    await prisma.order.update({ where: { id: orderId }, data: { status: 'SHIPPED' } });
    await prisma.trackingHistory.create({
      data: {
        orderId,
        status: 'SHIPPED',
        description: getOrderStatusTrackingDescription('SHIPPED'),
      },
    });

    realtime.orderStatusChanged({
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: 'SHIPPED',
      customerPhone: order.customerPhone,
      grandTotal: Number(order.grandTotal),
    });
    invalidateCache('dashboard:');

    const trackingUrl =
      awbCode != null ? `https://shiprocket.co/tracking/${awbCode}` : order.shipping?.trackingUrl;
    void this.notifyFulfillmentStatus(orderId, 'SHIPPED', trackingUrl).catch((err) =>
      logger.warn('AWB assign notification failed', { orderId, err }),
    );

    return result;
  }

  async getInventory(query: Record<string, string> = {}) {
    const { page, limit, skip } = parsePagination(query);
    const search = query.search?.trim();
    const stock = query.stock?.trim().toLowerCase();

    const stockFilter =
      stock === 'out'
        ? { quantity: { lte: prisma.inventory.fields.reserved } }
        : stock === 'low'
          ? {
              AND: [
                { quantity: { gt: prisma.inventory.fields.reserved } },
                { quantity: { lte: prisma.inventory.fields.lowStockAlert } },
              ],
            }
          : {};

    const productCreatedAt = parseCreatedAtFilter(query);
    const where = {
      deletedAt: null,
      product: {
        deletedAt: null,
        ...(productCreatedAt ? { createdAt: productCreatedAt } : {}),
      },
      productColor: { deletedAt: null },
      ...stockFilter,
      ...(search
        ? {
            OR: [
              { product: { name: { contains: search, mode: 'insensitive' as const } } },
              { product: { sku: { contains: search, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    };

    const include = {
      product: {
        select: {
          id: true,
          name: true,
          sku: true,
          category: { select: { name: true } },
          createdAt: true,
        },
      },
      productColor: { select: { id: true, name: true } },
      history: { orderBy: { createdAt: 'desc' as const }, take: 5 },
    };

    const [inventory, total] = await Promise.all([
      prisma.inventory.findMany({
        where,
        include,
        orderBy: { product: { createdAt: 'desc' } },
        skip,
        take: limit,
      }),
      prisma.inventory.count({ where }),
    ]);

    return { inventory, meta: buildPaginationMeta(page, limit, total) };
  }

  private async broadcastOrderShippingUpdate(orderId: string) {
    const updatedOrder = await prisma.order.findFirst({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        customerPhone: true,
        grandTotal: true,
      },
    });
    if (!updatedOrder) return;
    realtime.orderStatusChanged({
      orderId: updatedOrder.id,
      orderNumber: updatedOrder.orderNumber,
      status: updatedOrder.status,
      customerPhone: updatedOrder.customerPhone,
      grandTotal: Number(updatedOrder.grandTotal),
    });
    invalidateCache('dashboard:');
  }

  private parseShippingAddress(raw: Prisma.JsonValue | null): {
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
  } {
    const address = (raw ?? {}) as Record<string, unknown>;
    const preferredRaw = String(address.preferredShipping ?? '').toUpperCase();
    const preferredShipping =
      preferredRaw === 'QUICK' || preferredRaw === 'STANDARD'
        ? (preferredRaw as 'QUICK' | 'STANDARD')
        : undefined;
    return {
      country: String(address.country ?? 'India'),
      countryCode: address.countryCode ? String(address.countryCode) : undefined,
      state: String(address.state ?? ''),
      city: String(address.city ?? ''),
      postalCode: String(address.postalCode ?? ''),
      addressLine1: String(address.addressLine1 ?? ''),
      addressLine2: address.addressLine2 ? String(address.addressLine2) : undefined,
      landmark: address.landmark ? String(address.landmark) : undefined,
      latitude:
        address.latitude != null && Number.isFinite(Number(address.latitude))
          ? Number(address.latitude)
          : undefined,
      longitude:
        address.longitude != null && Number.isFinite(Number(address.longitude))
          ? Number(address.longitude)
          : undefined,
      preferredShipping,
    };
  }

  private isIndiaShippingAddress(address: {
    country?: string;
    countryCode?: string;
    postalCode?: string;
  }): boolean {
    const code = (address.countryCode || '').trim().toUpperCase();
    if (code === 'IN') return true;
    const country = (address.country || '').trim().toLowerCase();
    if (country === 'india' || country === 'in') return true;
    return /^\d{6}$/.test((address.postalCode || '').trim());
  }

  private resolveCountryCode(address: {
    country?: string;
    countryCode?: string;
    postalCode?: string;
  }): string {
    const code = (address.countryCode || '').trim().toUpperCase();
    if (code.length === 2) return code;
    if (this.isIndiaShippingAddress(address)) return 'IN';
    return code || 'IN';
  }

  private resolveShippingMode(
    order: { shippingAddress: Prisma.JsonValue | null },
    requested?: ShiprocketShippingMode,
  ): ShiprocketShippingMode {
    if (requested) return requested;
    const address = this.parseShippingAddress(order.shippingAddress);
    if (address.preferredShipping === 'QUICK') return 'quick';
    return this.isIndiaShippingAddress(address) ? 'domestic' : 'international';
  }

  private async getPickupCoordinates(): Promise<{ latitude: number; longitude: number }> {
    const coords = await settingsService.getQuickPickupCoordinates();
    if (!coords) {
      throw new ApiError(
        400,
        'Quick pickup coordinates are not set. Add latitude and longitude in Admin → Settings → Quick Pickup.',
      );
    }
    return coords;
  }

  private async buildQuickLocationPayload(
    order: {
      items: Array<{ quantity: number; weight: Prisma.Decimal | null }>;
      grandTotal: Prisma.Decimal;
    },
    address: {
      postalCode: string;
      latitude?: number;
      longitude?: number;
      addressLine1: string;
      city: string;
      state: string;
    },
  ) {
    const pickup = await this.getPickupCoordinates();
    if (address.latitude == null || address.longitude == null) {
      throw new ApiError(
        400,
        'Delivery latitude/longitude are required for Shiprocket Quick. Update the shipping address or wait for geocoding.',
      );
    }

    return {
      pickupPostalCode: env.SHIPROCKET_PICKUP_PINCODE,
      deliveryPostalCode: address.postalCode,
      pickupLatitude: pickup.latitude,
      pickupLongitude: pickup.longitude,
      deliveryLatitude: address.latitude,
      deliveryLongitude: address.longitude,
      weightKg: this.resolveOrderWeightKg(order),
      declaredValue: Number(order.grandTotal),
      cod: false,
    };
  }

  private buildShiprocketOrderPayload(
    order: {
      orderNumber: string;
      createdAt: Date;
      customerName: string;
      customerEmail: string;
      customerPhone: string;
      subtotal: Prisma.Decimal;
      items: Array<{
        productName: string;
        sku: string;
        quantity: number;
        unitPrice: Prisma.Decimal;
        weight: Prisma.Decimal | null;
        length: Prisma.Decimal | null;
        width: Prisma.Decimal | null;
        height: Prisma.Decimal | null;
      }>;
      packageLength: Prisma.Decimal | null;
      packageWidth: Prisma.Decimal | null;
      packageHeight: Prisma.Decimal | null;
    },
    address: {
      addressLine1: string;
      city: string;
      state: string;
      postalCode: string;
      country: string;
      latitude?: number;
      longitude?: number;
    },
    orderRef: string,
    options?: { international?: boolean; countryCode?: string },
  ) {
    const nameParts = order.customerName.split(' ');
    const packageDims = this.resolveOrderPackageDimensions(order);
    const totalWeightKg = this.resolveOrderWeightKg(order);
    const countryCode = options?.countryCode?.trim().toUpperCase();

    const payload: Record<string, unknown> = {
      order_id: orderRef,
      order_date: order.createdAt.toISOString().split('T')[0],
      pickup_location: env.SHIPROCKET_PICKUP_LOCATION || 'Primary',
      billing_customer_name: nameParts[0],
      billing_last_name: nameParts.slice(1).join(' ') || '.',
      billing_address: address.addressLine1,
      billing_city: address.city,
      billing_pincode: address.postalCode,
      billing_state: address.state,
      billing_country: options?.international
        ? countryCode || address.country
        : address.country || 'India',
      billing_email: order.customerEmail,
      billing_phone: order.customerPhone,
      shipping_is_billing: true,
      order_items: order.items.map((item) => ({
        name: item.productName,
        sku: item.sku,
        units: item.quantity,
        selling_price: Number(item.unitPrice),
        discount: 0,
        tax: 0,
        hsn: 5208,
      })),
      payment_method: 'Prepaid',
      sub_total: Number(order.subtotal),
      length: packageDims.length,
      breadth: packageDims.width,
      height: packageDims.height,
      weight: totalWeightKg,
    };

    if (options?.international) {
      payload.shipping_country = countryCode || address.country;
      payload.currency = 'INR';
      payload.purpose_of_shipment = 0;
    }
    if (address.latitude != null && address.longitude != null) {
      payload.latitude = address.latitude;
      payload.longitude = address.longitude;
    }

    return payload;
  }

  private resolveOrderPackageDimensions(order: {
    packageLength: Prisma.Decimal | null;
    packageWidth: Prisma.Decimal | null;
    packageHeight: Prisma.Decimal | null;
    items: Array<{
      quantity: number;
      length: Prisma.Decimal | null;
      width: Prisma.Decimal | null;
      height: Prisma.Decimal | null;
    }>;
  }) {
    if (order.packageLength && order.packageWidth && order.packageHeight) {
      return {
        length: Number(order.packageLength),
        width: Number(order.packageWidth),
        height: Number(order.packageHeight),
      };
    }

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
      width: order.packageWidth ? Number(order.packageWidth) : maxWidth || 20,
      height: order.packageHeight ? Number(order.packageHeight) : totalHeight || 5,
    };
  }

  private resolveOrderWeightKg(order: {
    items: Array<{
      quantity: number;
      weight: Prisma.Decimal | null;
    }>;
  }) {
    const grams = order.items.reduce((sum, item) => {
      if (!item.weight) return sum;
      return sum + Number(item.weight) * item.quantity;
    }, 0);

    if (grams <= 0) return 0.5;
    return Math.max(0.1, Math.round((grams / 1000) * 1000) / 1000);
  }
}

export const dashboardService = new DashboardService();
export const shippingService = new ShippingService();
