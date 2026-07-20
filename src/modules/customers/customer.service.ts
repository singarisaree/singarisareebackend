import { CustomerSource, Prisma } from '@prisma/client';
import { prisma } from '@/config/database';
import { ApiError } from '@/shared/api-response';
import { buildPaginationMeta } from '@/shared/api-response';
import { parsePagination, parseCreatedAtFilter } from '@/utils/helpers';
import { ADMIN_LIST_CACHE_TTL_MS, invalidateCache, withCache } from '@/utils/memory-cache';

function normalizePhone(phone: string): string {
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.length === 12 && cleaned.startsWith('91')) return cleaned.slice(2);
  return cleaned;
}

export class CustomerService {
  private invalidateCustomerListCache() {
    invalidateCache('customers:list:');
  }

  async upsertFromOrder(data: {
    name: string;
    phone: string;
    email?: string;
  }) {
    const phone = normalizePhone(data.phone);
    if (!/^[6-9]\d{9}$/.test(phone)) return null;

    const customer = await prisma.customer.upsert({
      where: { phone },
      create: {
        name: data.name.trim(),
        phone,
        email: data.email?.trim() || null,
        source: CustomerSource.ORDER,
      },
      update: {
        name: data.name.trim(),
        ...(data.email ? { email: data.email.trim() } : {}),
        deletedAt: null,
      },
    });
    this.invalidateCustomerListCache();
    return customer;
  }

  /** Backfill users from orders that are not yet in the customers table. */
  async ensureCustomersFromOrders() {
    const [existingCustomers, orders] = await Promise.all([
      prisma.customer.findMany({
        where: { deletedAt: null },
        select: { phone: true },
      }),
      prisma.order.findMany({
        where: { deletedAt: null },
        select: {
          customerName: true,
          customerPhone: true,
          customerEmail: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const existingPhones = new Set(existingCustomers.map((c) => c.phone));
    const seen = new Set<string>();
    let synced = 0;

    for (const order of orders) {
      const phone = normalizePhone(order.customerPhone);
      if (seen.has(phone)) continue;
      seen.add(phone);
      if (existingPhones.has(phone)) continue;

      const result = await this.upsertFromOrder({
        name: order.customerName,
        phone: order.customerPhone,
        email: order.customerEmail,
      });
      if (result) {
        synced += 1;
        existingPhones.add(phone);
      }
    }

    if (synced > 0) {
      this.invalidateCustomerListCache();
    }

    return { synced };
  }

  async syncFromOrders() {
    const orders = await prisma.order.findMany({
      where: { deletedAt: null },
      select: {
        customerName: true,
        customerPhone: true,
        customerEmail: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const seen = new Set<string>();
    let synced = 0;

    for (const order of orders) {
      const phone = normalizePhone(order.customerPhone);
      if (seen.has(phone)) continue;
      seen.add(phone);

      const result = await this.upsertFromOrder({
        name: order.customerName,
        phone: order.customerPhone,
        email: order.customerEmail,
      });
      if (result) synced += 1;
    }

    if (synced > 0) {
      this.invalidateCustomerListCache();
    }

    return { synced, total: seen.size };
  }

  async findAll(query: Record<string, string>) {
    const cacheKey = `customers:list:${JSON.stringify(query)}`;
    return withCache(cacheKey, ADMIN_LIST_CACHE_TTL_MS, () => this.fetchAll(query));
  }

  private async fetchAll(query: Record<string, string>) {
    const { page, limit, skip } = parsePagination(query);
    const search = query.search?.trim();
    const source = query.source === 'ALL' ? undefined : query.source;
    const createdAt = parseCreatedAtFilter(query);

    const where: Prisma.CustomerWhereInput = {
      deletedAt: null,
      ...(source ? { source: source as CustomerSource } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search } },
              { email: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(createdAt ? { createdAt } : {}),
    };

    const [customers, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.customer.count({ where }),
    ]);

    const phones = customers.map((c) => c.phone);
    const customerIds = customers.map((c) => c.id);
    const [orderCountsRaw, marketingCounts, latestMarketingMessages] = await Promise.all([
      phones.length
        ? prisma.order.groupBy({
            by: ['customerPhone'],
            where: { customerPhone: { in: phones }, deletedAt: null },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      customerIds.length
        ? prisma.marketingMessageLog.groupBy({
            by: ['customerId'],
            where: { customerId: { in: customerIds } },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      customerIds.length
        ? prisma.marketingMessageLog.findMany({
            where: { customerId: { in: customerIds } },
            distinct: ['customerId'],
            orderBy: [{ customerId: 'asc' }, { createdAt: 'desc' }],
            select: {
              id: true,
              customerId: true,
              status: true,
              createdAt: true,
              campaign: { select: { heading: true } },
            },
          })
        : Promise.resolve([]),
    ]);

    const orderCountByPhone = new Map<string, number>();
    for (const entry of orderCountsRaw) {
      const normalized = normalizePhone(entry.customerPhone);
      orderCountByPhone.set(normalized, (orderCountByPhone.get(normalized) ?? 0) + entry._count._all);
    }

    const marketingCountByCustomer = new Map<string, number>();
    for (const entry of marketingCounts) {
      if (!entry.customerId) continue;
      marketingCountByCustomer.set(entry.customerId, entry._count._all);
    }

    const latestMessageByCustomer = new Map<string, (typeof latestMarketingMessages)[number]>();
    for (const msg of latestMarketingMessages) {
      if (!msg.customerId) continue;
      latestMessageByCustomer.set(msg.customerId, msg);
    }

    const enriched = customers.map((customer) => {
      const customerOrderCount = orderCountByPhone.get(customer.phone) ?? 0;
      const customerMarketingCount = marketingCountByCustomer.get(customer.id) ?? 0;
      const latestMessage = latestMessageByCustomer.get(customer.id);
      return {
        ...customer,
        orderCount: customerOrderCount,
        marketingMessageCount: customerMarketingCount,
        latestMarketingMessage: latestMessage
          ? {
              id: latestMessage.id,
              status: latestMessage.status,
              createdAt: latestMessage.createdAt,
              campaignHeading: latestMessage.campaign.heading,
            }
          : null,
      };
    });

    return {
      customers: enriched,
      meta: buildPaginationMeta(page, limit, total),
    };
  }

  async findById(id: string) {
    const customer = await prisma.customer.findFirst({
      where: { id, deletedAt: null },
    });
    if (!customer) throw new ApiError(404, 'Customer not found');

    const [orders, marketingMessages] = await Promise.all([
      prisma.order.findMany({
        where: { customerPhone: customer.phone, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          grandTotal: true,
          createdAt: true,
          items: {
            select: {
              productName: true,
              colorName: true,
              quantity: true,
              totalPrice: true,
            },
          },
        },
      }),
      prisma.marketingMessageLog.findMany({
        where: { customerId: customer.id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          errorMessage: true,
          createdAt: true,
          campaign: { select: { heading: true, templateKey: true } },
        },
      }),
    ]);

    return {
      ...customer,
      orders: orders.map((o) => ({
        ...o,
        grandTotal: Number(o.grandTotal),
        items: o.items.map((i) => ({ ...i, totalPrice: Number(i.totalPrice) })),
      })),
      orderCount: orders.length,
      marketingMessageCount: marketingMessages.length,
      marketingMessages: marketingMessages.map((m) => ({
        id: m.id,
        status: m.status,
        errorMessage: m.errorMessage,
        createdAt: m.createdAt,
        campaignHeading: m.campaign.heading,
        templateKey: m.campaign.templateKey,
      })),
    };
  }

  async create(data: {
    name: string;
    phone: string;
    email?: string;
    notes?: string;
    allowMarketing?: boolean;
  }) {
    const phone = normalizePhone(data.phone);
    const existing = await prisma.customer.findFirst({ where: { phone } });
    if (existing && !existing.deletedAt) {
      throw new ApiError(409, 'A customer with this phone number already exists');
    }

    if (existing?.deletedAt) {
      const customer = await prisma.customer.update({
        where: { id: existing.id },
        data: {
          name: data.name.trim(),
          email: data.email?.trim() || null,
          notes: data.notes?.trim() || null,
          allowMarketing: data.allowMarketing ?? true,
          source: CustomerSource.MANUAL,
          deletedAt: null,
        },
      });
      this.invalidateCustomerListCache();
      return customer;
    }

    const customer = await prisma.customer.create({
      data: {
        name: data.name.trim(),
        phone,
        email: data.email?.trim() || null,
        notes: data.notes?.trim() || null,
        allowMarketing: data.allowMarketing ?? true,
        source: CustomerSource.MANUAL,
      },
    });
    this.invalidateCustomerListCache();
    return customer;
  }

  async update(
    id: string,
    data: Partial<{
      name: string;
      phone: string;
      email: string;
      notes: string;
      allowMarketing: boolean;
    }>,
  ) {
    await this.findById(id);

    if (data.phone) {
      const phone = normalizePhone(data.phone);
      const duplicate = await prisma.customer.findFirst({
        where: { phone, id: { not: id }, deletedAt: null },
      });
      if (duplicate) throw new ApiError(409, 'Phone number already in use');
      data.phone = phone;
    }

    const customer = await prisma.customer.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name.trim() }),
        ...(data.phone !== undefined && { phone: data.phone }),
        ...(data.email !== undefined && { email: data.email.trim() || null }),
        ...(data.notes !== undefined && { notes: data.notes.trim() || null }),
        ...(data.allowMarketing !== undefined && { allowMarketing: data.allowMarketing }),
      },
    });
    this.invalidateCustomerListCache();
    return customer;
  }

  async softDelete(id: string) {
    await this.findById(id);
    const customer = await prisma.customer.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    this.invalidateCustomerListCache();
    return customer;
  }

  async joinVipList(phoneInput: string, nameInput?: string) {
    const phone = normalizePhone(phoneInput);
    if (!/^[6-9]\d{9}$/.test(phone)) {
      throw new ApiError(400, 'Enter valid 10-digit Indian mobile number');
    }

    const name = (nameInput || '').trim();
    if (name.length < 2) {
      throw new ApiError(400, 'Enter your name');
    }

    const existing = await prisma.customer.findFirst({ where: { phone } });

    if (existing) {
      if (existing.deletedAt) {
        const customer = await prisma.customer.update({
          where: { id: existing.id },
          data: {
            name,
            source: CustomerSource.VIP,
            allowMarketing: true,
            deletedAt: null,
          },
        });
        this.invalidateCustomerListCache();
        return customer;
      }

      if (existing.source === CustomerSource.VIP) {
        const customer = await prisma.customer.update({
          where: { id: existing.id },
          data: {
            name,
            allowMarketing: true,
          },
        });
        this.invalidateCustomerListCache();
        return customer;
      }

      const customer = await prisma.customer.update({
        where: { id: existing.id },
        data: {
          ...(existing.name === 'Madam' || !existing.name?.trim() ? { name } : {}),
          allowMarketing: true,
        },
      });
      this.invalidateCustomerListCache();
      return customer;
    }

    const customer = await prisma.customer.create({
      data: {
        name,
        phone,
        source: CustomerSource.VIP,
        allowMarketing: true,
      },
    });
    this.invalidateCustomerListCache();
    return customer;
  }
}

export const customerService = new CustomerService();
