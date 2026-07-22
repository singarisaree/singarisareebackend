#!/usr/bin/env bash
# Fix Prisma client + TypeScript build on VPS.
# Run on VPS: bash deploy/vps-fix-build.sh
set -euo pipefail

cd /var/www/singari-api

echo "==> Pull latest code..."
git pull origin main

echo "==> Clean install (keeps dev deps even if NODE_ENV=production in .env)..."
rm -rf node_modules
env -u NODE_ENV HUSKY=0 npm ci --include=dev

echo "==> Generate Prisma client..."
npm run prisma:generate

echo "==> Verify Prisma client was generated..."
test -f node_modules/.prisma/client/index.d.ts
grep -q "export namespace Prisma" node_modules/.prisma/client/index.d.ts

echo "==> Run migrations..."
npm run prisma:migrate:deploy

echo "==> Build TypeScript..."
npm run build

echo "==> Restart API..."
pm2 restart singari-api

echo ""
echo "✓ Build fixed. Test:"
echo "  curl -s https://api.singarisaree.com/api/v1/health"
