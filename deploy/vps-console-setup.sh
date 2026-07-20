#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# RUN THIS ENTIRE SCRIPT IN YOUR VPS WEB CONSOLE (as root)
#
# Does everything:
#   - Node 20, PostgreSQL, Nginx, PM2, Git
#   - Fresh PostgreSQL database (password: Singari@143)
#   - Clones backend from GitHub
#   - npm install + build
#   - Creates admin: singarisaree@gmail.com / Singari@143
#   - Starts API on port 5001
#   - Nginx + SSL for api.singarisaree.com
#   - uploads/ folder is permanent (never deleted on updates)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR="/var/www/singari-api"
UPLOADS_DIR="/var/www/singari-uploads"
DB_NAME="singari_sarees"
DB_USER="singari"
DB_PASS="Singari@143"
DB_PASS_ENCODED="Singari%40143"
DOMAIN="api.singarisaree.com"
REPO="https://github.com/singarisaree/singarisareebackend.git"
CERTBOT_EMAIL="singarisaree@gmail.com"

echo "══════════════════════════════════════════════════════════"
echo " Singari Sarees VPS Setup"
echo "══════════════════════════════════════════════════════════"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl git nginx certbot python3-certbot-nginx postgresql postgresql-contrib ufw build-essential

echo "==> Node.js 20..."
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
npm install -g pm2

echo "==> SSH + firewall..."
apt-get install -y openssh-server || true
systemctl enable ssh || true
systemctl start ssh || true
ufw allow OpenSSH 2>/dev/null || ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
echo "y" | ufw enable || true

echo "==> PostgreSQL..."
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}';
  ELSE
    ALTER ROLE ${DB_USER} WITH PASSWORD '${DB_PASS}';
  END IF;
END
\$\$;
SELECT 'CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DB_NAME}')\gexec
GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};
SQL

sudo -u postgres psql -v ON_ERROR_STOP=1 -d "${DB_NAME}" <<SQL
GRANT ALL ON SCHEMA public TO ${DB_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${DB_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${DB_USER};
SQL

echo "==> Permanent uploads folder (outside app — survives all updates)..."
mkdir -p "${UPLOADS_DIR}"
chmod 775 "${UPLOADS_DIR}"

echo "==> Clone backend..."
mkdir -p "$(dirname "${APP_DIR}")"
if [[ -d "${APP_DIR}/.git" ]]; then
  cd "${APP_DIR}" && git pull origin main
else
  git clone "${REPO}" "${APP_DIR}"
fi
cd "${APP_DIR}"

# Symlink uploads so images never live inside the git folder
rm -rf "${APP_DIR}/uploads"
ln -sfn "${UPLOADS_DIR}" "${APP_DIR}/uploads"

echo "==> Production .env (add API keys later in nano .env)..."
JWT_ACCESS="$(openssl rand -base64 32 | tr -d '/+=' | head -c 40)"
JWT_REFRESH="$(openssl rand -base64 32 | tr -d '/+=' | head -c 40)"
SHIPROCKET_TOKEN="$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)"

cat > "${APP_DIR}/.env" <<ENV
NODE_ENV=production
PORT=5001
API_URL=https://${DOMAIN}
FRONTEND_URL=https://www.singarisaree.com
API_VERSION=v1

DATABASE_URL=postgresql://${DB_USER}:${DB_PASS_ENCODED}@127.0.0.1:5432/${DB_NAME}

JWT_ACCESS_SECRET=${JWT_ACCESS}
JWT_REFRESH_SECRET=${JWT_REFRESH}
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d

RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=

SHIPROCKET_EMAIL=
SHIPROCKET_PASSWORD=
SHIPROCKET_PICKUP_LOCATION=Home
SHIPROCKET_PICKUP_PINCODE=500035
SHIPROCKET_WEBHOOK_TOKEN=${SHIPROCKET_TOKEN}

SENT_DM_API_KEY=
SENT_DM_OTP_TEMPLATE_ID=
SENT_DM_OTP_TEMPLATE_NAME=sent_Verify_Code_2

WHATSAPP_CLOUD_ACCESS_TOKEN=
WHATSAPP_CLOUD_APP_ID=
WHATSAPP_CLOUD_PHONE_NUMBER_ID=
WHATSAPP_CLOUD_WABA_ID=
WHATSAPP_CLOUD_API_VERSION=v25.0
WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN=
WHATSAPP_CLOUD_APP_SECRET=

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM_EMAIL=singarisaree@gmail.com
SMTP_FROM_NAME=Singari Sarees
ENV
chmod 600 "${APP_DIR}/.env"

echo "==> npm install..."
HUSKY=0 npm ci

echo "==> Database migrate..."
npm run prisma:generate
npm run prisma:migrate:deploy

echo "==> Create admin user (singarisaree@gmail.com)..."
ADMIN_EMAIL="singarisaree@gmail.com" ADMIN_PASSWORD="Singari@143" \
  npx tsx prisma/seed-minimal.ts 2>/dev/null || npx tsx -e "
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
(async () => {
  const p = new PrismaClient();
  const hash = await bcrypt.hash('Singari@143', 12);
  await p.admin.upsert({
    where: { email: 'singarisaree@gmail.com' },
    update: { passwordHash: hash, name: 'Singari Admin', role: 'super_admin', isActive: true },
    create: { email: 'singarisaree@gmail.com', passwordHash: hash, name: 'Singari Admin', role: 'super_admin' },
  });
  console.log('Admin created: singarisaree@gmail.com');
  await p.\$disconnect();
})();
"

echo "==> Build..."
npm run build

echo "==> Start PM2..."
pm2 delete singari-api 2>/dev/null || true
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | bash || true

echo "==> Nginx HTTP..."
mkdir -p /var/www/certbot
cat > /etc/nginx/conf.d/upgrade-map.conf <<'MAP'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
MAP

if [[ -f "${APP_DIR}/deploy/nginx/api.http.conf" ]]; then
  cp "${APP_DIR}/deploy/nginx/api.http.conf" /etc/nginx/sites-available/singari-api
else
  cat > /etc/nginx/sites-available/singari-api <<'NGINX'
upstream singari_api { server 127.0.0.1:5001; keepalive 32; }
server {
    listen 80; listen [::]:80;
    server_name api.singarisaree.com;
    client_max_body_size 15m;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / {
        proxy_pass http://singari_api;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 86400;
    }
}
NGINX
fi

ln -sf /etc/nginx/sites-available/singari-api /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "==> SSL certificate..."
certbot certonly --webroot -w /var/www/certbot \
  -d "${DOMAIN}" \
  --email "${CERTBOT_EMAIL}" \
  --agree-tos --non-interactive --keep-until-expiring \
  || echo "SSL skipped — DNS may not be ready yet. Run later: certbot --nginx -d ${DOMAIN}"

if [[ -f /etc/letsencrypt/live/${DOMAIN}/fullchain.pem ]] && [[ -f "${APP_DIR}/deploy/nginx/api.ssl.conf" ]]; then
  cp "${APP_DIR}/deploy/nginx/api.ssl.conf" /etc/nginx/sites-available/singari-api
  nginx -t && systemctl reload nginx
fi

echo ""
echo "══════════════════════════════════════════════════════════"
echo " DONE"
echo "══════════════════════════════════════════════════════════"
echo ""
echo " API:    http://${DOMAIN}/api/v1/health"
echo " Admin:  https://www.singarisaree.com/admin/login"
echo "         Email:    singarisaree@gmail.com"
echo "         Password: Singari@143"
echo ""
echo " Images stored at: ${UPLOADS_DIR}  (never deleted on updates)"
echo ""
echo " Add API keys later:"
echo "   nano ${APP_DIR}/.env"
echo "   pm2 restart singari-api"
echo ""
echo " Vercel frontend env:"
echo "   NEXT_PUBLIC_API_URL=https://${DOMAIN}/api/v1"
echo "   NEXT_PUBLIC_SITE_URL=https://www.singarisaree.com"
echo ""
curl -s "http://127.0.0.1:5001/api/v1/health" || true
echo ""
