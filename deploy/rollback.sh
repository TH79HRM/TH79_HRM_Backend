#!/bin/bash
# =====================================================
# TH79 HRM Backend - Rollback Script
# Usage: bash deploy/rollback.sh [tag]
# =====================================================
set -euo pipefail

APP_NAME="th79-hrm"
APP_DIR="/var/www/th79-hrm-backend"

cd "$APP_DIR" || { echo "❌ Project directory not found"; exit 1; }

if [ -n "${1:-}" ]; then
  TARGET="$1"
else
  # Find latest pre-deploy tag
  TARGET=$(git tag -l "pre-deploy-*" --sort=-creatordate | head -1)
  if [ -z "$TARGET" ]; then
    echo "❌ No backup tags found"
    exit 1
  fi
fi

echo "🔙 Rolling back to: $TARGET"
git reset --hard "$TARGET"
npm ci --production
pm2 restart "$APP_NAME" --update-env
pm2 save

echo "✅ Rollback completed to $TARGET"