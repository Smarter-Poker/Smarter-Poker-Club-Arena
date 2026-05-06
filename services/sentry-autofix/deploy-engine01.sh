#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════
# Bring up the Sentry autofix webhook on engine-01.
# Idempotent; safe to re-run.
# ═════════════════════════════════════════════════════════════════════
set -euo pipefail

TARGET_HOST="${TARGET_HOST:-root@engine.smarter.poker}"
REPO_ROOT="${REPO_ROOT:-/opt/club-arena}"
SERVICE_DIR="${SERVICE_DIR:-/opt/sentry-autofix}"
CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"

echo "==> Syncing service files to $SERVICE_DIR"
ssh "$TARGET_HOST" "mkdir -p $SERVICE_DIR"
rsync -a --delete --exclude node_modules --exclude .env \
  "$(dirname "$0")"/ "$TARGET_HOST:$SERVICE_DIR/"

echo "==> Ensuring .env exists (mode 600)"
ssh "$TARGET_HOST" "
  if [ ! -f $SERVICE_DIR/.env ]; then
    cp $SERVICE_DIR/.env.example $SERVICE_DIR/.env
    chmod 600 $SERVICE_DIR/.env
    echo '!! Fill in $SERVICE_DIR/.env with real secrets before first use.'
  fi
"

echo "==> Docker compose up"
ssh "$TARGET_HOST" "cd $SERVICE_DIR && docker compose up -d --build"

echo "==> Wait for health"
for i in 1 2 3 4 5 6; do
  if ssh "$TARGET_HOST" "curl -fsS http://127.0.0.1:8787/health >/dev/null 2>&1"; then
    echo "   healthy"
    break
  fi
  sleep 2
done

echo "==> Extending Caddyfile with /webhooks/sentry (if not already present)"
ssh "$TARGET_HOST" "bash -s" <<'REMOTE'
set -euo pipefail
CF=/etc/caddy/Caddyfile
if grep -q 'handle /webhooks/sentry' "$CF"; then
  echo '   already present — skipping'
else
  cp "$CF" "$CF.bak.\$(date +%s)"
  # Insert a handle block just before the default "handle {" in the
  # engine.smarter.poker vhost. Use awk to be explicit.
  awk '
    /engine\.smarter\.poker \{/ { in_vhost = 1 }
    in_vhost && !injected && /^    handle \{/ {
      print "    # ─── Sentry autofix webhook ──────────────────────────────────────"
      print "    handle /webhooks/sentry {"
      print "        reverse_proxy 127.0.0.1:8787"
      print "    }"
      print ""
      injected = 1
    }
    { print }
  ' "$CF" > "$CF.new"
  mv "$CF.new" "$CF"
  caddy validate --config "$CF" && systemctl reload caddy
  echo '   Caddyfile patched + reloaded'
fi
REMOTE

echo "==> External smoke (expect 401 bad-signature, confirms route is wired)"
code=$(curl -sko /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -H 'sentry-hook-signature: x' \
  -d '{}' https://engine.smarter.poker/webhooks/sentry)
echo "   /webhooks/sentry -> HTTP $code"

echo "==> Done"
