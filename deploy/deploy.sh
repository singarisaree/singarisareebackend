#!/usr/bin/env bash
# Deploy / re-deploy backend on VPS.
# Uploads folder is NEVER touched — code and uploads are kept separate.
#
# Usage:  bash deploy/deploy.sh

set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

if [[ ! -f .env ]]; then
  echo "ERROR: Missing .env — copy .env.production.example to .env and fill secrets."
  exit 1
fi

# ── Safety: verify uploads is a real directory and make it immovable by scripts ──
UPLOADS_DIR="${APP_DIR}/uploads"
mkdir -p "$UPLOADS_DIR"
# Make sure uploads is never accidentally removed or overwritten
if [[ ! -d "$UPLOADS_DIR" ]]; then
  echo "ERROR: uploads/ directory missing and could not be created."
  exit 1
fi
echo "==> uploads/ protected at ${UPLOADS_DIR}"

echo "==> Installing dependencies..."
HUSKY=0 npm ci

echo "==> Generating Prisma client..."
npm run prisma:generate

echo "==> Running database migrations (non-destructive)..."
npm run prisma:migrate:deploy

echo "==> Building TypeScript..."
npm run build

echo "==> (Re)starting PM2..."
if pm2 describe singari-api >/dev/null 2>&1; then
  pm2 restart deploy/ecosystem.config.cjs --update-env
else
  pm2 start deploy/ecosystem.config.cjs
fi
pm2 save

echo ""
echo "✓ Deploy complete."
echo "  Health: curl -s https://api.singarisaree.com/api/v1/health"
echo "  Logs:   pm2 logs singari-api --lines 50"
echo "  Images: ls ${UPLOADS_DIR}"
