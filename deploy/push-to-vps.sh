#!/usr/bin/env bash
# Sync backend code from Mac → VPS then run deploy.
# NEVER touches uploads/ on the VPS.
#
# Usage:  VPS_HOST=104.207.93.251 VPS_USER=root bash deploy/push-to-vps.sh

set -euo pipefail

VPS_HOST="${VPS_HOST:?Set VPS_HOST to your VPS IP, e.g. 104.207.93.251}"
VPS_USER="${VPS_USER:-root}"
APP_DIR="${APP_DIR:-/var/www/singari-api}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Syncing code to ${VPS_USER}@${VPS_HOST}:${APP_DIR}  (uploads/ is excluded)"
rsync -avz --delete \
  --exclude node_modules \
  --exclude dist \
  --exclude .env \
  --exclude logs \
  --exclude uploads \
  ./ "${VPS_USER}@${VPS_HOST}:${APP_DIR}/"

echo "==> Running deploy on VPS..."
ssh "${VPS_USER}@${VPS_HOST}" "cd ${APP_DIR} && bash deploy/deploy.sh"

echo ""
echo "✓ Push + deploy done."
echo "  Test: curl -s https://api.singarisaree.com/api/v1/health"
