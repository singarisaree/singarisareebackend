#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# First-time VPS bootstrap — run ON THE SERVER as root (web console or SSH):
#   curl -fsSL https://raw.githubusercontent.com/YOUR_REPO/main/backend/deploy/vps-bootstrap.sh | bash
# Or copy this file to the VPS and run:  sudo bash vps-bootstrap.sh
#
# Before running, set APP_DIR where code will live (default /var/www/singari-api)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/singari-api}"
DB_NAME="${DB_NAME:-singari_sarees}"
DB_USER="${DB_USER:-singari}"
NODE_MAJOR="${NODE_MAJOR:-20}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo bash vps-bootstrap.sh"
  exit 1
fi

echo "==> System packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl git nginx certbot python3-certbot-nginx postgresql postgresql-contrib rsync ufw

echo "==> Node.js ${NODE_MAJOR}..."
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt "$NODE_MAJOR" ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
npm install -g pm2

echo "==> Firewall (SSH + HTTP + HTTPS)..."
ufw allow OpenSSH || ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
echo "y" | ufw enable || true

echo "==> PostgreSQL database..."
if [[ -z "${DB_PASSWORD:-}" ]]; then
  DB_PASSWORD="$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 24)"
fi

sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}';
  ELSE
    ALTER ROLE ${DB_USER} WITH PASSWORD '${DB_PASSWORD}';
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

echo "==> App directory ${APP_DIR}..."
mkdir -p "$APP_DIR"/logs "$APP_DIR"/uploads
chown -R "${SUDO_USER:-root}:${SUDO_USER:-root}" "$APP_DIR" 2>/dev/null || true

echo "==> Nginx (HTTP — ready for certbot)..."
mkdir -p /var/www/certbot
if [[ ! -f /etc/nginx/conf.d/upgrade-map.conf ]]; then
  cat > /etc/nginx/conf.d/upgrade-map.conf <<'MAP'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
MAP
fi

if [[ -f "${APP_DIR}/deploy/nginx/api.http.conf" ]]; then
  cp "${APP_DIR}/deploy/nginx/api.http.conf" /etc/nginx/sites-available/singari-api
elif [[ -f "./deploy/nginx/api.http.conf" ]]; then
  cp "./deploy/nginx/api.http.conf" /etc/nginx/sites-available/singari-api
else
  echo "Warning: deploy/nginx/api.http.conf not found; run install-nginx.sh after uploading code."
fi

ln -sf /etc/nginx/sites-available/singari-api /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo ""
echo "════════════════════════════════════════════════════════════"
echo " VPS bootstrap complete."
echo "════════════════════════════════════════════════════════════"
echo ""
echo "DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}"
echo ""
echo "Next steps:"
echo "  1. Upload backend code to ${APP_DIR} (rsync or git clone)"
echo "  2. cp .env.production.example .env  &&  nano .env"
echo "     - Paste DATABASE_URL above"
echo "     - Set API_URL=https://api.singarisaree.com"
echo "     - Set FRONTEND_URL=https://www.singarisaree.com"
echo "     - Fill Razorpay, WhatsApp, SMTP secrets"
echo "  3. cd ${APP_DIR} && bash deploy/deploy.sh"
echo "  4. SSL:  sudo bash deploy/setup-ssl.sh --email you@example.com"
echo "  5. Vercel: NEXT_PUBLIC_API_URL=https://api.singarisaree.com/api/v1"
echo ""
