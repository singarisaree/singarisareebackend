#!/usr/bin/env bash
# Create PostgreSQL database + user on Ubuntu/Debian VPS.
# Run once as root:  sudo bash deploy/setup-postgres.sh
#
# After this, set DATABASE_URL in .env:
#   postgresql://singari:YOUR_PASSWORD@127.0.0.1:5432/singari_sarees

set -euo pipefail

DB_NAME="${DB_NAME:-singari_sarees}"
DB_USER="${DB_USER:-singari}"

if [[ -z "${DB_PASSWORD:-}" ]]; then
  DB_PASSWORD="$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 24)"
  GENERATED=1
else
  GENERATED=0
fi

echo "==> Installing PostgreSQL (if needed)..."
if ! command -v psql >/dev/null 2>&1; then
  apt-get update
  apt-get install -y postgresql postgresql-contrib
fi

echo "==> Creating role and database..."
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}';
  ELSE
    ALTER ROLE ${DB_USER} WITH PASSWORD '${DB_PASSWORD}';
  END IF;
END
\$\$;

SELECT 'CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DB_NAME}')\gexec

GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};
SQL

# PostgreSQL 15+ needs schema grants on the database itself
sudo -u postgres psql -v ON_ERROR_STOP=1 -d "${DB_NAME}" <<SQL
GRANT ALL ON SCHEMA public TO ${DB_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${DB_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${DB_USER};
SQL

echo ""
echo "PostgreSQL is ready."
echo ""
echo "DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}"
echo ""
if [[ "$GENERATED" -eq 1 ]]; then
  echo "Save the password above — it was generated automatically."
fi
echo ""
echo "Next on the VPS (in backend folder):"
echo "  cp .env.production.example .env   # paste DATABASE_URL + secrets"
echo "  npm run prisma:migrate:deploy"
echo "  npm run prisma:seed               # optional: default admin + settings"
