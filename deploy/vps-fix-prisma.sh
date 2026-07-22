#!/usr/bin/env bash
# Fix missing prisma on VPS — run from /var/www/singari-api as root
set -euo pipefail
cd /var/www/singari-api

echo "==> Pull latest..."
git pull origin main

echo "==> Clean install (ignore NODE_ENV from .env)..."
rm -rf node_modules
set +u
unset NODE_ENV
set -u
export HUSKY=0
npm install

echo "==> Check prisma package..."
if [[ ! -f node_modules/prisma/build/index.js ]]; then
  echo "Installing prisma directly..."
  npm install prisma@6.19.3 typescript@5.8.2 tsc-alias@1.8.13 tsx@4.19.3 --save
fi
ls -la node_modules/prisma/build/index.js

echo "==> Prisma generate + migrate..."
npm run prisma:generate
npm run prisma:migrate:deploy

echo "==> Done. Continue with: npm run build && pm2 restart singari-api"
echo "Or run the full fix: bash deploy/vps-fix-build.sh"
