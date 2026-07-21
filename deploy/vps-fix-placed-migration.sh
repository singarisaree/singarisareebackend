#!/usr/bin/env bash
# Recover from failed 20260721103000_add_order_status_placed migration, then apply pending migrations.
#
# Run on VPS as root:
#   cd /var/www/singari-api && bash deploy/vps-fix-placed-migration.sh

set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

FAILED="20260721103000_add_order_status_placed"

echo "==> Mark failed migration as rolled back: ${FAILED}"
npx prisma migrate resolve --rolled-back "$FAILED"

echo "==> Apply pending migrations..."
npm run prisma:migrate:deploy

echo ""
echo "✓ Migration recovery complete."
echo "  Restart API: pm2 restart singari-api"
