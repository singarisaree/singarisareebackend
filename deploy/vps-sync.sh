#!/usr/bin/env bash
# Sync VPS backend code to match GitHub exactly, then redeploy.
# Safe: .env and uploads/ are gitignored — never touched by git.
#
# Run on VPS as root:
#   bash deploy/vps-sync.sh

set -euo pipefail

APP_DIR="/var/www/singari-api"
BRANCH="${BRANCH:-main}"

cd "$APP_DIR"

echo "==> Fetch latest from GitHub..."
git fetch origin "$BRANCH"

echo "==> Match GitHub exactly (no merge conflicts)..."
git reset --hard "origin/${BRANCH}"

echo "==> Current commit:"
git log -1 --format='  %h | %ci | %s'

echo "==> Deploy..."
bash deploy/deploy.sh

echo ""
echo "✓ VPS is in sync with GitHub."
echo "  Test: curl -s https://api.singarisaree.com/api/v1/health"
