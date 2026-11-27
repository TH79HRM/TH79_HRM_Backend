#!/bin/bash
# =====================================================
# TH79 HRM Backend - VPS Deployment Script
# Usage: bash deploy/deploy.sh
# =====================================================
set -euo pipefail

APP_NAME="th79-hrm"
APP_DIR="/var/www/th79-hrm-backend"
BRANCH="${1:-main}"
LOG_FILE="/var/log/th79-hrm-deploy.log"

log() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

log "=========================================="
log "🚀 Starting deployment from branch: $BRANCH"
log "=========================================="

cd "$APP_DIR" || { log "❌ Project directory not found: $APP_DIR"; exit 1; }

# Backup current version
log "📦 Creating backup..."
BACKUP_TAG="pre-deploy-$(date +%Y%m%d-%H%M%S)"
git tag "$BACKUP_TAG" 2>/dev/null || true

# Pull latest changes
log "⬇️ Pulling latest code..."
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

# Install dependencies
log "📥 Installing production dependencies..."
npm ci --production

# Run database migrations/seeds if needed
if [ -f "scripts/migrate.js" ]; then
  log "🗄️ Running migrations..."
  node scripts/migrate.js
fi

# Restart application
log "🔄 Restarting application..."
if pm2 describe "$APP_NAME" > /dev/null 2>&1; then
  pm2 restart "$APP_NAME" --update-env
else
  pm2 start src/server.js --name "$APP_NAME" \
    --max-memory-restart 512M \
    --env production \
    --merge-logs \
    --log-date-format "YYYY-MM-DD HH:mm:ss"
fi
pm2 save

# Health check
log "🏥 Running health check..."
sleep 5
for i in 1 2 3; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:5000/api 2>/dev/null || echo "000")
  if [ "$STATUS" -ge 200 ] && [ "$STATUS" -lt 400 ]; then
    log "✅ Health check passed (HTTP $STATUS)"
    break
  fi
  if [ "$i" -eq 3 ]; then
    log "❌ Health check failed after 3 attempts"
    log "🔙 Rolling back..."
    git reset --hard "$BACKUP_TAG"
    npm ci --production
    pm2 restart "$APP_NAME" --update-env
    log "⚠️ Rolled back to previous version"
    exit 1
  fi
  log "⏳ Attempt $i failed, retrying in 5s..."
  sleep 5
done

log "=========================================="
log "✅ Deployment completed successfully!"
log "=========================================="