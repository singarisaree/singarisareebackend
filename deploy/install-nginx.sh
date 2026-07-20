#!/usr/bin/env bash
# Install Nginx site config (HTTP phase — before SSL).
# Usage: sudo bash deploy/install-nginx.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NGINX_AVAILABLE="/etc/nginx/sites-available/singari-api"
NGINX_ENABLED="/etc/nginx/sites-enabled/singari-api"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo bash deploy/install-nginx.sh"
  exit 1
fi

mkdir -p /var/www/certbot

if [[ ! -f /etc/nginx/conf.d/upgrade-map.conf ]]; then
  cat > /etc/nginx/conf.d/upgrade-map.conf <<'MAP'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
MAP
fi

cp "${SCRIPT_DIR}/nginx/api.http.conf" "$NGINX_AVAILABLE"
ln -sf "$NGINX_AVAILABLE" "$NGINX_ENABLED"
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl enable nginx
systemctl reload nginx

echo "Nginx HTTP config installed for api.singarisaree.com"
echo "Next: sudo bash deploy/setup-ssl.sh --email your@email.com"
