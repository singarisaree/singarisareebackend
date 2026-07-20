#!/usr/bin/env bash
# Obtain Let's Encrypt certificate and switch Nginx to HTTPS config.
# Run on VPS as root AFTER:
#   - DNS api.singarisaree.com → this server's IP
#   - HTTP config installed (deploy/nginx/api.http.conf)
#   - Backend running on port 5001 (optional for cert, required for API)
#
# Usage:  sudo bash deploy/setup-ssl.sh
#         sudo bash deploy/setup-ssl.sh --email you@example.com

set -euo pipefail

DOMAIN="${DOMAIN:-api.singarisaree.com}"
EMAIL="${CERTBOT_EMAIL:-}"
WEBROOT="/var/www/certbot"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NGINX_AVAILABLE="/etc/nginx/sites-available/singari-api"
NGINX_ENABLED="/etc/nginx/sites-enabled/singari-api"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo bash deploy/setup-ssl.sh"
  exit 1
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --email) EMAIL="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo "==> Installing certbot + nginx plugin..."
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y certbot python3-certbot-nginx

echo "==> WebSocket upgrade map (if missing)..."
if [[ ! -f /etc/nginx/conf.d/upgrade-map.conf ]]; then
  cat > /etc/nginx/conf.d/upgrade-map.conf <<'MAP'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
MAP
fi

echo "==> Certbot webroot + HTTP nginx config..."
mkdir -p "$WEBROOT"
chmod 755 "$WEBROOT"

if [[ -f "${SCRIPT_DIR}/nginx/api.http.conf" ]]; then
  cp "${SCRIPT_DIR}/nginx/api.http.conf" "$NGINX_AVAILABLE"
else
  cp "${SCRIPT_DIR}/nginx-api.singarisaree.com.conf" "$NGINX_AVAILABLE"
fi

ln -sf "$NGINX_AVAILABLE" "$NGINX_ENABLED"
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "==> Requesting certificate for ${DOMAIN}..."
CERTBOT_ARGS=(
  certonly
  --webroot
  -w "$WEBROOT"
  -d "$DOMAIN"
  --agree-tos
  --non-interactive
  --keep-until-expiring
)
if [[ -n "$EMAIL" ]]; then
  CERTBOT_ARGS+=(--email "$EMAIL")
else
  CERTBOT_ARGS+=(--register-unsafely-without-email)
fi

certbot "${CERTBOT_ARGS[@]}"

echo "==> Installing HTTPS nginx config..."
cp "${SCRIPT_DIR}/nginx/api.ssl.conf" "$NGINX_AVAILABLE"
nginx -t
systemctl reload nginx

echo "==> Certbot auto-renewal timer..."
systemctl enable certbot.timer 2>/dev/null || true
systemctl start certbot.timer 2>/dev/null || true

# Renew hook: reload nginx after certificate renewal
if [[ ! -f /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh ]]; then
  mkdir -p /etc/letsencrypt/renewal-hooks/deploy
  cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'HOOK'
#!/bin/sh
nginx -t && systemctl reload nginx
HOOK
  chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
fi

echo ""
echo "SSL ready: https://${DOMAIN}/api/v1/health"
echo "Test:      curl -sI https://${DOMAIN}/api/v1/health | head -5"
echo "Renewal:   certbot renew --dry-run"
