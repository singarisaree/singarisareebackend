#!/usr/bin/env bash
# Reset PostgreSQL and apply schema on a fresh VPS (no existing data).
# Run on VPS: bash deploy/vps-fresh-db.sh
set -euo pipefail

cd /var/www/singari-api

DB_NAME="singari_sarees"
DB_USER="singari"

echo "==> Dropping and recreating database ${DB_NAME}..."
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS ${DB_NAME};
CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};
SQL

sudo -u postgres psql -d "${DB_NAME}" -v ON_ERROR_STOP=1 <<SQL
GRANT ALL ON SCHEMA public TO ${DB_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${DB_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${DB_USER};
SQL

echo "==> Applying schema (db push — best for fresh empty DB)..."
node node_modules/prisma/build/index.js db push

echo "==> Create admin + settings..."
npm run prisma:seed:minimal

echo "==> Done. Run: npm run build && pm2 restart singari-api"
