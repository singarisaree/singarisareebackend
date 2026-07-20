import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/** Treat blank .env values as unset (optional fields). */
function emptyToUndefined(value: unknown) {
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}

const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const optionalEmail = z.preprocess(emptyToUndefined, z.string().email().optional());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('5001'),
  API_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  API_VERSION: z.string().default('v1'),
  FRONTEND_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  RAZORPAY_KEY_ID: optionalString,
  RAZORPAY_KEY_SECRET: optionalString,
  RAZORPAY_WEBHOOK_SECRET: optionalString,
  SHIPROCKET_EMAIL: optionalEmail,
  SHIPROCKET_PASSWORD: optionalString,
  SHIPROCKET_PICKUP_LOCATION: z.string().default('Primary'),
  SHIPROCKET_PICKUP_PINCODE: z.string().default('500035'),
  /** Optional x-api-key for Shiprocket tracking webhook */
  SHIPROCKET_WEBHOOK_TOKEN: optionalString,
  // Sent.dm — customer login OTP only
  SENT_DM_API_KEY: optionalString,
  SENT_DM_OTP_TEMPLATE_ID: optionalString,
  SENT_DM_OTP_TEMPLATE_NAME: optionalString,
  // Official Meta WhatsApp Cloud API — orders, shipping, and marketing
  WHATSAPP_CLOUD_ACCESS_TOKEN: optionalString,
  WHATSAPP_CLOUD_APP_ID: optionalString,
  WHATSAPP_CLOUD_PHONE_NUMBER_ID: optionalString,
  WHATSAPP_CLOUD_WABA_ID: optionalString,
  WHATSAPP_CLOUD_API_VERSION: z.string().default('v25.0'),
  WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN: optionalString,
  WHATSAPP_CLOUD_APP_SECRET: optionalString,
  // SMTP (Nodemailer) — order status emails (background, non-blocking)
  SMTP_HOST: optionalString,
  SMTP_PORT: z.string().default('587'),
  SMTP_SECURE: z.string().default('false'),
  SMTP_USER: optionalString,
  SMTP_PASS: optionalString,
  SMTP_FROM_EMAIL: optionalEmail,
  SMTP_FROM_NAME: z.string().default('Singari Sarees'),
  REDIS_URL: optionalString,
  RATE_LIMIT_WINDOW_MS: z.string().default('900000'),
  RATE_LIMIT_MAX_REQUESTS: z.string().default('100'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

export const apiBaseUrl = env.API_URL || `http://localhost:${env.PORT}`;

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
