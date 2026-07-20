import { z } from 'zod';

const addressSchema = z.object({
  country: z.string().min(2),
  /** ISO 3166-1 alpha-2 (IN, US, GB, …) */
  countryCode: z
    .string()
    .trim()
    .length(2)
    .transform((v) => v.toUpperCase())
    .optional(),
  state: z.string().min(2),
  city: z.string().min(2),
  postalCode: z.string().min(2).max(16),
  addressLine1: z.string().min(1),
  addressLine2: z.string().min(2),
  landmark: z.string().min(2),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  preferredShipping: z.enum(['QUICK', 'STANDARD']).optional(),
});

function isIndiaAddress(address: { country?: string; countryCode?: string }): boolean {
  const code = (address.countryCode || '').trim().toUpperCase();
  if (code === 'IN') return true;
  const country = (address.country || '').trim().toLowerCase();
  return country === 'india' || country === 'in' || country === 'bharat';
}

const checkoutBaseSchema = z.object({
  customerName: z.string().min(2).max(100),
  customerPhone: z.string().min(8).max(20),
  customerEmail: z.string().email(),
  shippingAddress: addressSchema,
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        productColorId: z.string().uuid(),
        quantity: z.number().int().min(1).max(10),
      }),
    )
    .min(1),
  couponCode: z.string().optional(),
});

export const checkoutSchema = checkoutBaseSchema.superRefine((data, ctx) => {
  const phone = data.customerPhone.replace(/[\s-]/g, '');
  if (isIndiaAddress(data.shippingAddress)) {
    if (!/^[6-9]\d{9}$/.test(phone)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['customerPhone'],
        message: 'Invalid Indian phone number',
      });
    }
  } else if (!/^\+?[0-9]{8,18}$/.test(phone)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['customerPhone'],
      message: 'Enter a valid phone number with country code',
    });
  }
});

export const calculateTotalsSchema = z.object({
  items: checkoutBaseSchema.shape.items,
  couponCode: z.string().optional(),
  phone: z.string().min(8).max(20).optional(),
  shippingAddress: addressSchema.partial().optional(),
});

export const shippingQuoteSchema = z.object({
  items: checkoutBaseSchema.shape.items,
  shippingAddress: addressSchema.partial().extend({
    country: z.string().min(2),
    state: z.string().min(2),
    city: z.string().min(2),
    postalCode: z.string().min(2),
  }),
});

export const quickQuoteSchema = z.object({
  items: checkoutBaseSchema.shape.items,
  delivery: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    postalCode: z.string().min(2).max(16).optional(),
    city: z.string().min(2).optional(),
  }),
});

export const adminCreateOrderSchema = checkoutBaseSchema
  .extend({
    status: z.enum([
      'PLACED', 'PAYMENT_PENDING', 'CONFIRMED', 'READY_TO_SHIP', 'SHIPPED', 'IN_TRANSIT',
      'DELIVERED', 'RETURNED', 'CANCELLED',
    ]).optional(),
    notes: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    const phone = data.customerPhone.replace(/[\s-]/g, '');
    if (isIndiaAddress(data.shippingAddress)) {
      if (!/^[6-9]\d{9}$/.test(phone)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['customerPhone'],
          message: 'Invalid Indian phone number',
        });
      }
    } else if (!/^\+?[0-9]{8,18}$/.test(phone)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['customerPhone'],
        message: 'Enter a valid phone number with country code',
      });
    }
  });

export const orderQuerySchema = z.object({
  page: z.string().optional().default('1'),
  limit: z.string().optional().default('20'),
  status: z
    .string()
    .optional()
    .transform((value) => {
      if (!value) return undefined;
      const normalized = value.trim().toUpperCase();
      if (!normalized || normalized === 'ALL') return undefined;
      return normalized;
    })
    .pipe(
      z
        .enum([
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
        ])
        .optional(),
    ),
  search: z.string().optional(),
  deliveryType: z.enum(['ALL', 'INDIA', 'QUICK', 'INTERNATIONAL']).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  isAdminOrder: z.string().optional(),
  sortBy: z
    .enum(['createdAt', 'updatedAt', 'grandTotal', 'orderNumber'])
    .optional()
    .default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
});

export const updateOrderStatusSchema = z.object({
  status: z.enum([
    'PLACED', 'PAYMENT_PENDING', 'CONFIRMED', 'READY_TO_SHIP', 'SHIPPED', 'IN_TRANSIT',
    'DELIVERED', 'RETURNED', 'CANCELLED', 'FAILED', 'RTO', 'REFUNDED',
  ]),
  notes: z.string().optional(),
});

export const bulkUpdateOrderStatusSchema = z.object({
  orderIds: z.array(z.string().uuid()).min(1).max(100),
  status: z.enum([
    'PLACED', 'PAYMENT_PENDING', 'CONFIRMED', 'READY_TO_SHIP', 'SHIPPED', 'IN_TRANSIT',
    'DELIVERED', 'RETURNED', 'CANCELLED', 'FAILED', 'RTO', 'REFUNDED',
  ]),
  notes: z.string().optional(),
});

export const bulkFetchOrdersSchema = z.object({
  orderIds: z.array(z.string().uuid()).min(1).max(100),
});

export const updateOrderDetailsSchema = z
  .object({
    customerName: z.string().min(2).max(100).optional(),
    customerPhone: z
      .string()
      .regex(/^[6-9]\d{9}$/, 'Invalid Indian phone number')
      .optional(),
    customerEmail: z.string().email().optional(),
    shippingAddress: addressSchema
      .extend({
        addressLine2: z.string().optional(),
        landmark: z.string().optional(),
      })
      .optional(),
    status: z
      .enum([
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
      ])
      .optional(),
    notes: z.string().optional(),
    items: z
      .array(
        z.object({
          id: z.string().uuid(),
          weight: z.number().min(0).nullable().optional(),
          length: z.number().min(0).nullable().optional(),
          width: z.number().min(0).nullable().optional(),
          height: z.number().min(0).nullable().optional(),
        }),
      )
      .optional(),
  })
  .refine(
    (data) =>
      data.customerName !== undefined ||
      data.customerPhone !== undefined ||
      data.customerEmail !== undefined ||
      data.shippingAddress !== undefined ||
      data.status !== undefined ||
      data.notes !== undefined ||
      (data.items !== undefined && data.items.length > 0),
    { message: 'No changes provided' },
  );

export const guestOrderLookupSchema = z.object({
  phone: z.string().regex(/^[6-9]\d{9}$/, 'Invalid phone number'),
});

export const validateCouponSchema = z.object({
  code: z.string().min(1),
  subtotal: z.number().positive(),
  phone: z.string().min(8).max(20).optional(),
  shippingCharge: z.number().min(0).optional(),
});

export const availableCouponsQuerySchema = z.object({
  subtotal: z.string().optional(),
  phone: z.string().min(8).max(20).optional(),
  shippingCharge: z.string().optional(),
});

export const cartSyncSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        productColorId: z.string().uuid(),
        quantity: z.number().int().min(1).max(10),
      }),
    )
    .min(1),
});

export const manualShippingSchema = z.object({
  courierName: z.string().min(2),
  trackingNumber: z.string().min(3),
  trackingUrl: z.string().url().optional(),
});

export const shiprocketShippingSchema = z.object({
  method: z.literal('SHIPROCKET'),
});

const allOrderStatuses = [
  'PLACED',
  'PAYMENT_PENDING',
  'CONFIRMED',
  'READY_TO_SHIP',
  'SHIPPED',
  'IN_TRANSIT',
  'DELIVERED',
  'RETURNED',
  'REFUNDED',
  'CANCELLED',
  'FAILED',
  'RTO',
] as const;

export const escalationSearchSchema = z.object({
  q: z.string().trim().min(1).max(120),
});

export const escalationUpdateSchema = z
  .object({
    status: z.enum(allOrderStatuses).optional(),
    customerName: z.string().trim().min(1).max(100).optional(),
    customerPhone: z.string().trim().min(5).max(20).optional(),
    customerEmail: z.string().trim().email().optional(),
    shippingAddress: z
      .object({
        country: z.string().optional(),
        countryCode: z.string().optional(),
        state: z.string().optional(),
        city: z.string().optional(),
        postalCode: z.string().optional(),
        addressLine1: z.string().optional(),
        addressLine2: z.string().optional(),
        landmark: z.string().optional(),
        latitude: z.number().min(-90).max(90).optional().nullable(),
        longitude: z.number().min(-180).max(180).optional().nullable(),
      })
      .optional(),
    notes: z.string().max(5000).optional(),
    clearRefundMarkers: z.boolean().optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .refine(
    (data) =>
      data.status !== undefined ||
      data.customerName !== undefined ||
      data.customerPhone !== undefined ||
      data.customerEmail !== undefined ||
      data.shippingAddress !== undefined ||
      data.notes !== undefined ||
      data.clearRefundMarkers === true,
    { message: 'Provide at least one field to update' },
  );