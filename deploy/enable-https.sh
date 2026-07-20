#!/usr/bin/env bash
# Enable HTTPS for api.singarisaree.com on Ubuntu/nginx 1.24
# Run on VPS as root: bash deploy/enable-https.sh
set -euo pipefail

DOMAIN="api.singarisaree.com"
APP_DIR="/var/www/singari-api"
EMAIL="singarisaree@gmail.com"

echo "==> Open firewall port 443..."
ufw allow 443/tcp || true

echo "==> Ensure cert exists..."
if [[ ! -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]]; then
  mkdir -p /var/www/certbot
  certbot certonly --webroot -w /var/www/certbot \
    -d "${DOMAIN}" \
    --email "${EMAIL}" \
    --agree-tos --non-interactive
fi

echo "==> Write nginx SSL config (no http2 — compatible with nginx 1.24)..."
cat > /etc/nginx/sites-available/singari-api <<NGINX
upstream singari_api {
    server 127.0.0.1:5001;
    keepalive 32;
}

server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name ${DOMAIN};

    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    client_max_body_size 15m;

    location /uploads/ {
        proxy_pass http://singari_api;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    location / {
        proxy_pass http://singari_api;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_read_timeout 86400;
    }
}
NGINX

if [[ ! -f /etc/nginx/conf.d/upgrade-map.conf ]]; then
  cat > /etc/nginx/conf.d/upgrade-map.conf <<'MAP'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
MAP
fi

ln -sf /etc/nginx/sites-available/singari-api /etc/nginx/sites-enabled/singari-api
rm -f /etc/nginx/sites-enabled/default

echo "==> Test and reload nginx..."
nginx -t
systemctl reload nginx

echo "==> Verify..."
sleep 1
ss -tlnp | grep -E ':443|:80' || true
curl -sS "https://${DOMAIN}/api/v1/health" || echo "HTTPS test failed — paste output above"

echo ""
echo "Done. Open: https://${DOMAIN}/api/v1/health"
