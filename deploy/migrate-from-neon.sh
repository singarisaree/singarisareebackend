#!/usr/bin/env bash
# Export data from Neon (or any remote Postgres) and import into local VPS Postgres.
# Run on your Mac/laptop where you have pg_dump access, OR on VPS with network to Neon.
#
# Usage:
#   NEON_URL='postgresql://...' VPS_URL='postgresql://singari:pass@127.0.0.1:5432/singari_sarees' bash deploy/migrate-from-neon.sh
#
# Requires: pg_dump, psql (brew install libpq  OR  apt install postgresql-client)

set -euo pipefail

NEON_URL="${NEON_URL:?Set NEON_URL to your current Neon connection string}"
VPS_URL="${VPS_URL:?Set VPS_URL to your local VPS postgres URL}"

DUMP_FILE="$(mktemp /tmp/singari-neon-XXXXXX.dump)"

echo "==> Dumping from Neon..."
pg_dump "$NEON_URL" --format=custom --no-owner --no-acl -f "$DUMP_FILE"

echo "==> Restoring to VPS PostgreSQL..."
pg_restore --dbname="$VPS_URL" --clean --if-exists --no-owner --no-acl "$DUMP_FILE" || true

rm -f "$DUMP_FILE"

echo ""
echo "Done. On VPS run:  npm run prisma:migrate:deploy"
echo "(Applies any migrations newer than the dump.)"
