#!/usr/bin/env bash
# Upload backend from your Mac to VPS and deploy.
# Usage (after SSH works):
#   VPS_HOST=104.207.93.251 VPS_USER=root bash deploy/push-to-vps.sh
#
# Requires: rsync, ssh access to VPS

set -euo pipefail

VPS_HOST="${VPS_HOST:?Set VPS_HOST e.g. 104.207.93.251}"
VPS_USER="${VPS_USER:-root}"
APP_DIR="${APP_DIR:-/var/www/singari-api}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Syncing backend to ${VPS_USER}@${VPS_HOST}:${APP_DIR} ..."
rsync -avz --delete \
  --exclude node_modules \
  --exclude dist \
  --exclude .env \
  --exclude logs \
  --exclude uploads \
  --exclude '.git' \
  ./ "${VPS_USER}@${VPS_HOST}:${APP_DIR}/"

echo "==> Running deploy on VPS..."
ssh "${VPS_USER}@${VPS_HOST}" "cd ${APP_DIR} && bash deploy/deploy.sh"

echo ""
echo "Done. Test: curl -s https://api.singarisaree.com/api/v1/health"
