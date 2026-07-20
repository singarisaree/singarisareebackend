#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# FULL FIRST-TIME SETUP — run from your Mac once you give SSH credentials.
#
# What this does:
#   1. Installs Node 20, PostgreSQL, Nginx, PM2, Certbot on VPS
#   2. Creates PostgreSQL user + database (singari / singari_sarees)
#   3. Uploads backend code (excluding .env and uploads/)
#   4. Creates production .env with correct URLs
#   5. Runs DB migrations + seed (fresh database)
#   6. Builds + starts backend via PM2
#   7. Installs Nginx HTTP config
#   8. Gets Let's Encrypt SSL certificate
#   9. Prints final checklist
#
# Usage:
#   VPS_HOST=104.207.93.251 \
#   VPS_USER=root \
#   CERTBOT_EMAIL=singarisaree@gmail.com \
#   DB_PASSWORD=YourStrongPassword123 \
#   JWT_ACCESS_SECRET=atleast32randomcharshere123456789 \
#   JWT_REFRESH_SECRET=anotherrandomsecret32pluscharsx123 \
#   RAZORPAY_KEY_ID=rzp_live_xxx \
#   RAZORPAY_KEY_SECRET=xxx \
#   RAZORPAY_WEBHOOK_SECRET=xxx \
#   SHIPROCKET_EMAIL=cursornaveen@gmail.com \
#   SHIPROCKET_PASSWORD='D^cE3$$*!7cI1ckhqouyQU$whRDlk5z1' \
#   SHIPROCKET_WEBHOOK_TOKEN=YourRandomToken \
#   SENT_DM_API_KEY=edb11c9d-c7be-42b6-a248-3f9c2c9fb4cf \
#   SENT_DM_OTP_TEMPLATE_ID=827b29c9-3423-451d-aaa6-bcb0d3073982 \
#   WHATSAPP_CLOUD_ACCESS_TOKEN=xxx \
#   WHATSAPP_CLOUD_APP_ID=xxx \
#   WHATSAPP_CLOUD_PHONE_NUMBER_ID=xxx \
#   WHATSAPP_CLOUD_WABA_ID=xxx \
#   WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN=YourVerifyToken \
#   WHATSAPP_CLOUD_APP_SECRET=xxx \
#   SMTP_USER=singarisaree@gmail.com \
#   SMTP_PASS=egpazbgqmkwxkkde \
#   bash deploy/full-setup.sh

set -euo pipefail

# ── Required ─────────────────────────────────────────────────────────────────
VPS_HOST="${VPS_HOST:?Set VPS_HOST}"
VPS_USER="${VPS_USER:-root}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:?Set CERTBOT_EMAIL}"
DB_PASSWORD="${DB_PASSWORD:?Set DB_PASSWORD}"
JWT_ACCESS_SECRET="${JWT_ACCESS_SECRET:?Set JWT_ACCESS_SECRET (32+ chars)}"
JWT_REFRESH_SECRET="${JWT_REFRESH_SECRET:?Set JWT_REFRESH_SECRET (32+ chars)}"

# ── Optional (safe to leave blank — WhatsApp/Razorpay can be added later) ────
RAZORPAY_KEY_ID="${RAZORPAY_KEY_ID:-}"
RAZORPAY_KEY_SECRET="${RAZORPAY_KEY_SECRET:-}"
RAZORPAY_WEBHOOK_SECRET="${RAZORPAY_WEBHOOK_SECRET:-}"
SHIPROCKET_EMAIL="${SHIPROCKET_EMAIL:-}"
SHIPROCKET_PASSWORD="${SHIPROCKET_PASSWORD:-}"
SHIPROCKET_WEBHOOK_TOKEN="${SHIPROCKET_WEBHOOK_TOKEN:-}"
SENT_DM_API_KEY="${SENT_DM_API_KEY:-}"
SENT_DM_OTP_TEMPLATE_ID="${SENT_DM_OTP_TEMPLATE_ID:-}"
SENT_DM_OTP_TEMPLATE_NAME="${SENT_DM_OTP_TEMPLATE_NAME:-sent_Verify_Code_2}"
WHATSAPP_CLOUD_ACCESS_TOKEN="${WHATSAPP_CLOUD_ACCESS_TOKEN:-}"
WHATSAPP_CLOUD_APP_ID="${WHATSAPP_CLOUD_APP_ID:-}"
WHATSAPP_CLOUD_PHONE_NUMBER_ID="${WHATSAPP_CLOUD_PHONE_NUMBER_ID:-}"
WHATSAPP_CLOUD_WABA_ID="${WHATSAPP_CLOUD_WABA_ID:-}"
WHATSAPP_CLOUD_API_VERSION="${WHATSAPP_CLOUD_API_VERSION:-v25.0}"
WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN="${WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN:-}"
WHATSAPP_CLOUD_APP_SECRET="${WHATSAPP_CLOUD_APP_SECRET:-}"
SMTP_HOST="${SMTP_HOST:-smtp.gmail.com}"
SMTP_PORT="${SMTP_PORT:-587}"
SMTP_SECURE="${SMTP_SECURE:-false}"
SMTP_USER="${SMTP_USER:-}"
SMTP_PASS="${SMTP_PASS:-}"
SMTP_FROM_EMAIL="${SMTP_FROM_EMAIL:-${SMTP_USER}}"
SMTP_FROM_NAME="${SMTP_FROM_NAME:-Singari Sarees}"

APP_DIR="/var/www/singari-api"
DB_NAME="singari_sarees"
DB_USER="singari"
DOMAIN="api.singarisaree.com"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo ""
echo "══════════════════════════════════════════════════════════════"
echo " Singari Sarees — Full VPS Setup"
echo " Target: ${VPS_USER}@${VPS_HOST}  →  https://${DOMAIN}"
echo "══════════════════════════════════════════════════════════════"
echo ""

# ── Step 1: Bootstrap VPS (packages + postgres + nginx) ──────────────────────
echo "── Step 1: Bootstrapping VPS ────────────────────────────────"
ssh -o StrictHostKeyChecking=accept-new "${VPS_USER}@${VPS_HOST}" "bash -s" <<BOOTSTRAP
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "==> System packages..."
apt-get update
apt-get install -y curl git nginx certbot python3-certbot-nginx postgresql postgresql-contrib rsync ufw

echo "==> Node.js 20..."
if ! command -v node >/dev/null 2>&1 || [[ "\$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
npm install -g pm2 --quiet

echo "==> Firewall..."
ufw allow OpenSSH || ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
echo "y" | ufw enable || true

echo "==> PostgreSQL: user=${DB_USER}  db=${DB_NAME}..."
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \\\$\\\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}';
  ELSE
    ALTER ROLE ${DB_USER} WITH PASSWORD '${DB_PASSWORD}';
  END IF;
END
\\\$\\\$;
SELECT 'CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DB_NAME}')\gexec
GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};
SQL

sudo -u postgres psql -v ON_ERROR_STOP=1 -d "${DB_NAME}" <<SQL
GRANT ALL ON SCHEMA public TO ${DB_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${DB_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${DB_USER};
SQL

echo "==> App + uploads directory..."
mkdir -p ${APP_DIR}/uploads ${APP_DIR}/logs
# uploads is created with sticky-group write so files survive redeployments
chmod 775 ${APP_DIR}/uploads

echo "Bootstrap done."
BOOTSTRAP

# ── Step 2: Upload code (never uploads/) ─────────────────────────────────────
echo ""
echo "── Step 2: Uploading backend code ───────────────────────────"
rsync -avz --delete \
  --exclude node_modules \
  --exclude dist \
  --exclude .env \
  --exclude logs \
  --exclude uploads \
  "${ROOT}/" "${VPS_USER}@${VPS_HOST}:${APP_DIR}/"

# ── Step 3: Write production .env ────────────────────────────────────────────
echo ""
echo "── Step 3: Writing production .env ──────────────────────────"
ssh "${VPS_USER}@${VPS_HOST}" "cat > ${APP_DIR}/.env" <<ENV
NODE_ENV=production
PORT=5001
API_URL=https://${DOMAIN}
FRONTEND_URL=https://www.singarisaree.com
API_VERSION=v1

DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}

JWT_ACCESS_SECRET=${JWT_ACCESS_SECRET}
JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET}
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d

RAZORPAY_KEY_ID=${RAZORPAY_KEY_ID}
RAZORPAY_KEY_SECRET=${RAZORPAY_KEY_SECRET}
RAZORPAY_WEBHOOK_SECRET=${RAZORPAY_WEBHOOK_SECRET}

SHIPROCKET_EMAIL=${SHIPROCKET_EMAIL}
SHIPROCKET_PASSWORD=${SHIPROCKET_PASSWORD}
SHIPROCKET_PICKUP_LOCATION=Home
SHIPROCKET_PICKUP_PINCODE=500035
SHIPROCKET_WEBHOOK_TOKEN=${SHIPROCKET_WEBHOOK_TOKEN}

SENT_DM_API_KEY=${SENT_DM_API_KEY}
SENT_DM_OTP_TEMPLATE_ID=${SENT_DM_OTP_TEMPLATE_ID}
SENT_DM_OTP_TEMPLATE_NAME=${SENT_DM_OTP_TEMPLATE_NAME}

WHATSAPP_CLOUD_ACCESS_TOKEN=${WHATSAPP_CLOUD_ACCESS_TOKEN}
WHATSAPP_CLOUD_APP_ID=${WHATSAPP_CLOUD_APP_ID}
WHATSAPP_CLOUD_PHONE_NUMBER_ID=${WHATSAPP_CLOUD_PHONE_NUMBER_ID}
WHATSAPP_CLOUD_WABA_ID=${WHATSAPP_CLOUD_WABA_ID}
WHATSAPP_CLOUD_API_VERSION=${WHATSAPP_CLOUD_API_VERSION}
WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN=${WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN}
WHATSAPP_CLOUD_APP_SECRET=${WHATSAPP_CLOUD_APP_SECRET}

SMTP_HOST=${SMTP_HOST}
SMTP_PORT=${SMTP_PORT}
SMTP_SECURE=${SMTP_SECURE}
SMTP_USER=${SMTP_USER}
SMTP_PASS=${SMTP_PASS}
SMTP_FROM_EMAIL=${SMTP_FROM_EMAIL}
SMTP_FROM_NAME=${SMTP_FROM_NAME}
ENV
echo ".env written (permissions 600)..."
ssh "${VPS_USER}@${VPS_HOST}" "chmod 600 ${APP_DIR}/.env"

# ── Step 4: Install deps + migrate + seed + build + PM2 ──────────────────────
echo ""
echo "── Step 4: Install, migrate, seed, build, start ─────────────"
ssh "${VPS_USER}@${VPS_HOST}" "cd ${APP_DIR} && bash deploy/deploy.sh"

# Seed default admin + settings (fresh DB)
echo "==> Seeding database (default admin + settings)..."
ssh "${VPS_USER}@${VPS_HOST}" "cd ${APP_DIR} && npm run prisma:seed"

# PM2 auto-start on server reboot
ssh "${VPS_USER}@${VPS_HOST}" "pm2 startup systemd -u root --hp /root | tail -1 | bash; pm2 save"

# ── Step 5: Nginx HTTP config ─────────────────────────────────────────────────
echo ""
echo "── Step 5: Nginx HTTP config ────────────────────────────────"
ssh "${VPS_USER}@${VPS_HOST}" "cd ${APP_DIR} && bash deploy/install-nginx.sh"

# ── Step 6: SSL certificate ───────────────────────────────────────────────────
echo ""
echo "── Step 6: Let's Encrypt SSL ────────────────────────────────"
ssh "${VPS_USER}@${VPS_HOST}" "cd ${APP_DIR} && bash deploy/setup-ssl.sh --email ${CERTBOT_EMAIL} --domain ${DOMAIN}"

# ── Step 7: Final health check ────────────────────────────────────────────────
echo ""
echo "── Step 7: Health check ─────────────────────────────────────"
sleep 3
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://${DOMAIN}/api/v1/health" || echo "000")
if [[ "$HTTP_CODE" == "200" ]]; then
  echo "✓  https://${DOMAIN}/api/v1/health → 200 OK"
else
  echo "⚠  Health check returned HTTP ${HTTP_CODE} — check pm2 logs:"
  echo "   ssh ${VPS_USER}@${VPS_HOST} 'pm2 logs singari-api --lines 30'"
fi

echo ""
echo "══════════════════════════════════════════════════════════════"
echo " SETUP COMPLETE"
echo "══════════════════════════════════════════════════════════════"
echo ""
echo " API:     https://${DOMAIN}/api/v1/health"
echo " Admin:   https://www.singarisaree.com/admin/login"
echo "          Default: admin@singarisarees.com / Singari@Admin2024"
echo ""
echo " Vercel env vars (set in Vercel dashboard, then redeploy):"
echo "   NEXT_PUBLIC_API_URL=https://${DOMAIN}/api/v1"
echo "   NEXT_PUBLIC_SITE_URL=https://www.singarisaree.com"
echo ""
echo " Webhook URLs to configure:"
echo "   WhatsApp:   https://${DOMAIN}/api/v1/whatsapp/webhook"
echo "   Razorpay:   https://${DOMAIN}/api/v1/payments/webhook"
echo "   Shiprocket: https://${DOMAIN}/api/v1/fulfillment/tracking"
echo ""
echo " Images are stored at:  ${APP_DIR}/uploads/"
echo " They are NEVER deleted by redeploys (uploads/ is excluded from rsync)."
echo ""
echo " To redeploy in future:"
echo "   VPS_HOST=${VPS_HOST} VPS_USER=${VPS_USER} bash deploy/push-to-vps.sh"
echo ""
