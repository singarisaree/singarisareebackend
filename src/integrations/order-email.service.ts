import { OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '@/config/database';
import { env } from '@/config/env';
import { logger } from '@/utils/logger';
import { formatCurrency, formatShortOrderNumber } from '@/utils/helpers';
import { emailService } from '@/integrations/email.service';

type OrderEmailItem = {
  name: string;
  color?: string | null;
  quantity: number;
  price: string;
};

type OrderEmailPayload = {
  orderId: string;
  orderNumber: string;
  shortOrderNumber: string;
  customerName: string;
  customerEmail: string;
  status: OrderStatus;
  grandTotal: string;
  items: OrderEmailItem[];
  trackingUrl?: string | null;
  estimatedDelivery?: string | null;
  myOrdersUrl: string;
};

const EMAIL_STATUSES = new Set<OrderStatus>([
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
]);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDateLabel(value?: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
}

function statusCopy(status: OrderStatus): {
  eyebrow: string;
  headline: string;
  body: string;
  subject: string;
  ctaLabel: string;
} {
  switch (status) {
    case 'PAYMENT_PENDING':
      return {
        eyebrow: 'Payment pending',
        headline: 'Complete payment to confirm your order',
        body: 'Your order is reserved. Finish payment soon so we can start preparing your sarees.',
        subject: 'Complete payment for your Singari Sarees order',
        ctaLabel: 'View order',
      };
    case 'PLACED':
      return {
        eyebrow: 'Order placed',
        headline: 'Thank you — your order is placed',
        body: 'We received your order and payment. Our team will carefully prepare your sarees for dispatch.',
        subject: 'Order placed · Singari Sarees',
        ctaLabel: 'Track your order',
      };
    case 'CONFIRMED':
      return {
        eyebrow: 'Order confirmed',
        headline: 'We’re getting your order ready',
        body: 'Your order is confirmed and moving into packing. You will hear from us again when it ships.',
        subject: 'Your order is confirmed · Singari Sarees',
        ctaLabel: 'View order details',
      };
    case 'READY_TO_SHIP':
      return {
        eyebrow: 'Packed & ready',
        headline: 'Your order is packed and ready to ship',
        body: 'Everything is packed with care. Pickup is being arranged with our delivery partner.',
        subject: 'Packed and ready to ship · Singari Sarees',
        ctaLabel: 'Track your order',
      };
    case 'SHIPPED':
      return {
        eyebrow: 'On the way',
        headline: 'Your order has shipped',
        body: 'Good news — your Singari Sarees order is with the courier and on its way to you.',
        subject: 'Your order has shipped · Singari Sarees',
        ctaLabel: 'Track shipment',
      };
    case 'IN_TRANSIT':
      return {
        eyebrow: 'In transit',
        headline: 'Your order is in transit',
        body: 'Your parcel is moving through the courier network. You will get another update when it is delivered.',
        subject: 'Order in transit · Singari Sarees',
        ctaLabel: 'Track shipment',
      };
    case 'DELIVERED':
      return {
        eyebrow: 'Delivered',
        headline: 'Your order was delivered',
        body: 'We hope you love your sarees. If anything feels off, reply to this email — we are happy to help.',
        subject: 'Delivered · Singari Sarees',
        ctaLabel: 'View order',
      };
    case 'CANCELLED':
      return {
        eyebrow: 'Cancelled',
        headline: 'Your order was cancelled',
        body: 'This order has been cancelled. If a payment was taken, refunds (if applicable) follow your payment method timeline.',
        subject: 'Order cancelled · Singari Sarees',
        ctaLabel: 'View order',
      };
    case 'REFUNDED':
      return {
        eyebrow: 'Refunded',
        headline: 'Your refund has been processed',
        body: 'We have processed a refund for this order. Bank timelines can take a few business days to show the credit.',
        subject: 'Refund processed · Singari Sarees',
        ctaLabel: 'View order',
      };
    case 'RTO':
      return {
        eyebrow: 'Returned to origin',
        headline: 'Your shipment returned to us',
        body: 'The courier returned this shipment to our warehouse. Our team will review next steps and may contact you.',
        subject: 'Shipment returned · Singari Sarees',
        ctaLabel: 'View order',
      };
    case 'RETURNED':
      return {
        eyebrow: 'Return received',
        headline: 'We’ve received your return',
        body: 'Your return has been recorded. We will update you once inspection and any refund steps are complete.',
        subject: 'Return received · Singari Sarees',
        ctaLabel: 'View order',
      };
    case 'FAILED':
      return {
        eyebrow: 'Payment failed',
        headline: 'Payment for your order didn’t go through',
        body: 'No worries — nothing was confirmed. You can place the order again whenever you’re ready.',
        subject: 'Payment unsuccessful · Singari Sarees',
        ctaLabel: 'Shop again',
      };
    default:
      return {
        eyebrow: 'Order update',
        headline: 'There’s an update on your order',
        body: 'Your Singari Sarees order status has changed. Open your order for the latest details.',
        subject: 'Order update · Singari Sarees',
        ctaLabel: 'View order',
      };
  }
}

function buildEmailHtml(payload: OrderEmailPayload): string {
  const copy = statusCopy(payload.status);
  const name = escapeHtml(payload.customerName.split(' ')[0] || payload.customerName);
  const orderNo = escapeHtml(payload.shortOrderNumber);
  const itemsHtml = payload.items
    .map(
      (item) => `
      <tr>
        <td style="padding:12px 0;border-bottom:1px solid #efe8dc;color:#3d2f24;font-size:14px;">
          ${escapeHtml(item.name)}${item.color ? `<br/><span style="color:#8a7a6b;font-size:12px;">${escapeHtml(item.color)}</span>` : ''}
        </td>
        <td style="padding:12px 0;border-bottom:1px solid #efe8dc;color:#8a7a6b;font-size:13px;text-align:center;">${item.quantity}</td>
        <td style="padding:12px 0;border-bottom:1px solid #efe8dc;color:#3d2f24;font-size:14px;text-align:right;">${escapeHtml(item.price)}</td>
      </tr>`,
    )
    .join('');

  const trackingBlock = payload.trackingUrl
    ? `<p style="margin:20px 0 0;"><a href="${escapeHtml(payload.trackingUrl)}" style="color:#b8944a;font-weight:600;text-decoration:none;">Track with courier →</a></p>`
    : '';

  const etaBlock = payload.estimatedDelivery
    ? `<p style="margin:8px 0 0;color:#8a7a6b;font-size:13px;">Estimated delivery: <strong style="color:#3d2f24;">${escapeHtml(payload.estimatedDelivery)}</strong></p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(copy.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f6f1ea;font-family:Georgia,'Times New Roman',serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f1ea;padding:28px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #ebe3d6;">
          <tr>
            <td style="background:#1c1612;padding:28px 28px 24px;text-align:center;">
              <p style="margin:0;color:#c9a96e;letter-spacing:0.28em;font-size:12px;text-transform:uppercase;">Singari Sarees</p>
              <p style="margin:10px 0 0;color:#f7efe3;font-size:13px;letter-spacing:0.04em;">Handcrafted elegance, delivered with care</p>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 28px 8px;">
              <p style="margin:0;color:#b8944a;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;">${escapeHtml(copy.eyebrow)}</p>
              <h1 style="margin:10px 0 0;color:#1c1612;font-size:24px;line-height:1.35;font-weight:normal;">${escapeHtml(copy.headline)}</h1>
              <p style="margin:14px 0 0;color:#5c4c3f;font-size:15px;line-height:1.6;">Hi ${name},</p>
              <p style="margin:8px 0 0;color:#5c4c3f;font-size:15px;line-height:1.6;">${escapeHtml(copy.body)}</p>
              <div style="margin:22px 0;padding:16px 18px;background:#faf7f2;border-radius:12px;border:1px solid #efe8dc;">
                <p style="margin:0;color:#8a7a6b;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;">Order</p>
                <p style="margin:6px 0 0;color:#1c1612;font-size:20px;letter-spacing:0.04em;">#${orderNo}</p>
                ${etaBlock}
              </div>
              ${
                payload.items.length
                  ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:8px 0 4px;">
                <tr>
                  <td style="padding:0 0 8px;color:#8a7a6b;font-size:12px;text-transform:uppercase;letter-spacing:0.08em;">Item</td>
                  <td style="padding:0 0 8px;color:#8a7a6b;font-size:12px;text-align:center;text-transform:uppercase;letter-spacing:0.08em;">Qty</td>
                  <td style="padding:0 0 8px;color:#8a7a6b;font-size:12px;text-align:right;text-transform:uppercase;letter-spacing:0.08em;">Price</td>
                </tr>
                ${itemsHtml}
                <tr>
                  <td colspan="2" style="padding:16px 0 0;color:#3d2f24;font-size:14px;text-align:right;font-weight:bold;">Total</td>
                  <td style="padding:16px 0 0;color:#b8944a;font-size:16px;text-align:right;font-weight:bold;">${escapeHtml(payload.grandTotal)}</td>
                </tr>
              </table>`
                  : ''
              }
              ${trackingBlock}
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 8px;">
                <tr>
                  <td style="background:#1c1612;border-radius:999px;">
                    <a href="${escapeHtml(payload.myOrdersUrl)}" style="display:inline-block;padding:12px 22px;color:#f7efe3;text-decoration:none;font-size:13px;letter-spacing:0.06em;">${escapeHtml(copy.ctaLabel)}</a>
                  </td>
                </tr>
              </table>
              <p style="margin:24px 0 0;color:#8a7a6b;font-size:13px;line-height:1.6;">With warmth,<br/>The Singari Sarees team</p>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 28px 24px;border-top:1px solid #efe8dc;">
              <p style="margin:0;color:#a09386;font-size:11px;line-height:1.5;">You’re receiving this because you placed an order at Singari Sarees. Questions? Just reply to this email.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildEmailText(payload: OrderEmailPayload): string {
  const copy = statusCopy(payload.status);
  const lines = [
    `Singari Sarees`,
    ``,
    `Hi ${payload.customerName.split(' ')[0] || payload.customerName},`,
    ``,
    copy.headline,
    copy.body,
    ``,
    `Order #${payload.shortOrderNumber}`,
    `Total: ${payload.grandTotal}`,
  ];
  if (payload.estimatedDelivery) lines.push(`Estimated delivery: ${payload.estimatedDelivery}`);
  if (payload.trackingUrl) lines.push(`Track: ${payload.trackingUrl}`);
  lines.push(``, `View order: ${payload.myOrdersUrl}`, ``, `— Singari Sarees`);
  return lines.join('\n');
}

function notificationTypeForStatus(
  status: OrderStatus,
):
  | 'ORDER_CONFIRMATION'
  | 'ORDER_PACKED'
  | 'ORDER_SHIPPED'
  | 'ORDER_DELIVERED'
  | 'ORDER_CANCELLED'
  | 'PAYMENT_SUCCESS'
  | 'PAYMENT_FAILED' {
  switch (status) {
    case 'PLACED':
    case 'CONFIRMED':
      return 'ORDER_CONFIRMATION';
    case 'READY_TO_SHIP':
      return 'ORDER_PACKED';
    case 'SHIPPED':
    case 'IN_TRANSIT':
      return 'ORDER_SHIPPED';
    case 'DELIVERED':
      return 'ORDER_DELIVERED';
    case 'CANCELLED':
    case 'RTO':
    case 'RETURNED':
    case 'REFUNDED':
      return 'ORDER_CANCELLED';
    case 'FAILED':
    case 'PAYMENT_PENDING':
      return 'PAYMENT_FAILED';
    default:
      return 'ORDER_SHIPPED';
  }
}

class OrderEmailService {
  /**
   * Fire-and-forget order status email. Never throws to callers.
   * Safe to call from request handlers without awaiting.
   */
  queueStatusEmail(orderId: string, status: OrderStatus): void {
    if (!EMAIL_STATUSES.has(status)) return;
    setImmediate(() => {
      void this.sendStatusEmail(orderId, status).catch((err) =>
        logger.warn('Background order email failed', {
          orderId,
          status,
          err: err instanceof Error ? err.message : err,
        }),
      );
    });
  }

  async sendStatusEmail(orderId: string, status: OrderStatus): Promise<boolean> {
    if (!EMAIL_STATUSES.has(status)) return false;
    if (!emailService.isConfigured()) {
      logger.warn('Order email skipped — SMTP not configured', { orderId, status });
      return false;
    }

    const order = await prisma.order.findFirst({
      where: { id: orderId, deletedAt: null },
      select: {
        id: true,
        orderNumber: true,
        customerName: true,
        customerEmail: true,
        grandTotal: true,
        estimatedDelivery: true,
        items: {
          select: {
            productName: true,
            colorName: true,
            quantity: true,
            unitPrice: true,
          },
        },
        shipping: { select: { trackingUrl: true } },
      },
    });

    if (!order?.customerEmail?.trim()) {
      logger.warn('Order email skipped — no customer email', { orderId, status });
      return false;
    }

    const shortOrderNumber = formatShortOrderNumber(order.orderNumber);
    const copy = statusCopy(status);
    const payload: OrderEmailPayload = {
      orderId: order.id,
      orderNumber: order.orderNumber,
      shortOrderNumber,
      customerName: order.customerName,
      customerEmail: order.customerEmail.trim(),
      status,
      grandTotal: formatCurrency(Number(order.grandTotal)),
      items: order.items.map((item) => ({
        name: item.productName,
        color: item.colorName,
        quantity: item.quantity,
        price: formatCurrency(Number(item.unitPrice) * item.quantity),
      })),
      trackingUrl: order.shipping?.trackingUrl,
      estimatedDelivery: formatDateLabel(order.estimatedDelivery),
      myOrdersUrl: `${env.FRONTEND_URL.replace(/\/$/, '')}/my-orders`,
    };

    const subject = `${copy.subject} (#${shortOrderNumber})`;
    const html = buildEmailHtml(payload);
    const text = buildEmailText(payload);
    const sent = await emailService.send({
      to: payload.customerEmail,
      subject,
      html,
      text,
    });

    try {
      await prisma.notification.create({
        data: {
          orderId: order.id,
          type: notificationTypeForStatus(status),
          channel: 'EMAIL',
          recipient: payload.customerEmail,
          message: subject,
          status: sent ? 'sent' : 'failed',
          sentAt: sent ? new Date() : undefined,
        },
      });
    } catch (error) {
      logger.warn('Failed to record email notification', {
        orderId,
        status,
        error: error instanceof Error ? error.message : error,
      });
    }

    return sent;
  }
}

export const orderEmailService = new OrderEmailService();

/** Type helper for Prisma notification creates */
export type OrderEmailNotificationCreate = Prisma.NotificationCreateInput;
