#!/usr/bin/env bash
# deploy-hetzner.sh — One-command deploy to Hetzner VPS
# Usage: ./server/deploy-hetzner.sh
set -euo pipefail

HETZNER_IP="178.156.160.206"
SSH_USER="root"
REMOTE="$SSH_USER@$HETZNER_IP"
CONTAINER="club-arena-engine"
REPO_DIR="/opt/club-arena"

echo "🚀 Deploying Club Arena to Hetzner ($HETZNER_IP)..."

# 0. Pre-flight — warn if Sentry DSN is not set in the host .env.
# initSentry() handles this gracefully but a production engine without Sentry
# means no error telemetry. Surface it loudly at deploy time.
echo "🔎 Pre-flight: checking SENTRY_DSN on host..."
if ssh "$REMOTE" "grep -q '^SENTRY_DSN=..' /opt/club-arena/server/.env 2>/dev/null"; then
  echo "   ✅ SENTRY_DSN present"
else
  echo "   ⚠️  SENTRY_DSN is EMPTY or missing in /opt/club-arena/server/.env"
  echo "      Engine errors will NOT reach Sentry. Set before the next deploy:"
  echo "      ssh $REMOTE 'echo SENTRY_DSN=https://... >> /opt/club-arena/server/.env'"
fi

# 1. Pull latest code on server
echo "📦 Pulling latest code..."
ssh "$REMOTE" "cd $REPO_DIR && git pull origin main"

# 2. Rebuild Docker image
echo "🔨 Rebuilding Docker image..."
ssh "$REMOTE" "cd $REPO_DIR/server && docker build -t $CONTAINER ."

# 3. Stop & remove old container (if running)
echo "🛑 Stopping old container..."
ssh "$REMOTE" "docker stop $CONTAINER 2>/dev/null || true && docker rm $CONTAINER 2>/dev/null || true"

# 4. Start new container with env vars
echo "🟢 Starting new container..."
ssh "$REMOTE" "docker run -d \
  --name $CONTAINER \
  --restart always \
  -p 8080:8080 \
  --env-file /opt/club-arena/server/.env \
  $CONTAINER"

# 5. Wait for health check
echo "⏳ Waiting for health check..."
sleep 3
HEALTH=$(curl -sf "https://engine.smarter.poker/health" || echo "FAILED")

if echo "$HEALTH" | grep -q '"running":true'; then
  echo "✅ Deploy successful! Server is healthy."
  echo "$HEALTH" | python3 -m json.tool 2>/dev/null || echo "$HEALTH"
else
  echo "❌ Health check FAILED!"
  echo "$HEALTH"
  ssh "$REMOTE" "docker logs --tail 30 $CONTAINER"
  exit 1
fi

# 6. Prune old images
echo "🧹 Cleaning up old images..."
ssh "$REMOTE" "docker image prune -f"

echo "🎉 Done! https://engine.smarter.poker"
