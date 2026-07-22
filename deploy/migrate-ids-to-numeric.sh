#!/usr/bin/env bash
# Convert legacy alphanumeric order numbers and product SKUs to numeric IDs.
# Run on VPS after deploying the latest backend code:
#   bash deploy/migrate-ids-to-numeric.sh
# Preview only:
#   bash deploy/migrate-ids-to-numeric.sh --dry-run
set -euo pipefail

cd /var/www/singari-api

DRY_RUN=""
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN="--dry-run"
fi

echo "==> Checking database connection..."
node node_modules/prisma/build/index.js migrate status >/dev/null

echo "==> Migrating order numbers and SKUs to numeric format..."
node node_modules/tsx/dist/cli.mjs scripts/migrate-ids-to-numeric.ts ${DRY_RUN}

echo "==> Done."
