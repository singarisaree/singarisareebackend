#!/usr/bin/env bash
# Deploy / update backend on VPS. Run from backend/ as the app user.
# First time: cp .env.production.example .env and fill secrets + DATABASE_URL
#
# Usage:  bash deploy/deploy.sh

set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

if [[ ! -f .env ]]; then
  echo "Missing .env — copy .env.production.example to .env and configure it first."
  exit 1
fi

echo "==> Installing dependencies..."
npm ci

echo "==> Generating Prisma client..."
npm run prisma:generate

echo "==> Running database migrations..."
npm run prisma:migrate:deploy

echo "==> Building..."
npm run build

echo "==> Restarting PM2..."
if pm2 describe singari-api >/dev/null 2>&1; then
  pm2 restart deploy/ecosystem.config.cjs --update-env
else
  pm2 start deploy/ecosystem.config.cjs
  pm2 save
fi

echo ""
echo "Deploy complete. Health check:"
echo "  curl -s https://api.singarisaree.com/api/v1/health"
