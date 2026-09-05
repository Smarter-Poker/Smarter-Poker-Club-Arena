#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════
# Prometheus + Grafana + AlertManager stack deploy — Hetzner cron-01
# Phase 5.1.3a
# ═════════════════════════════════════════════════════════════════════════
#
# One-shot deploy for the smarter.poker monitoring stack. Run as root on
# cron-01 after the initial checkout. Safe to re-run — docker compose
# up -d is idempotent and .env / Caddyfile are copied only if they do not
# already exist at the destination.
#
# Usage (on cron-01):
#   curl -fsSL https://raw.githubusercontent.com/Smarter-Poker/Smarter-Poker-Club-Arena/main/infra/monitoring/deploy.sh | bash
#   # — OR, after manual git clone:
#   cd /opt/smarter-poker-monitoring-src/infra/monitoring && sudo bash deploy.sh
# ═════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────
SRC_REPO_URL="${SRC_REPO_URL:-https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena.git}"
SRC_DIR="${SRC_DIR:-/opt/smarter-poker-monitoring-src}"
RUN_DIR="${RUN_DIR:-/opt/smarter-poker-monitoring}"
WH_REPO_URL="${WH_REPO_URL:-https://github.com/Smarter-Poker/Smarter-Poker-World-Hub.git}"
WH_SRC_DIR="${WH_SRC_DIR:-$SRC_DIR/Smarter-Poker-World-Hub}"

if [[ $EUID -ne 0 ]]; then
  echo "❌ Must run as root (needs docker, systemctl caddy)."
  exit 1
fi

echo "🚀 smarter.poker monitoring stack deploy — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ─── 1. Prereqs ──────────────────────────────────────────────────────────
echo "🔎 Checking prerequisites..."
for bin in docker git caddy; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "   ❌ missing: $bin"
    echo "      Install:"
    echo "        curl -fsSL https://get.docker.com | sh"
    echo "        apt-get install -y git caddy"
    exit 1
  fi
done
if ! docker compose version >/dev/null 2>&1; then
  echo "   ❌ missing: docker compose plugin"
  echo "      Install: apt-get install -y docker-compose-plugin"
  exit 1
fi
echo "   ✅ docker, docker compose, git, caddy all present"

# ─── 2. Pull / update source repo ────────────────────────────────────────
echo "📦 Syncing source repo at $SRC_DIR..."
if [[ -d "$SRC_DIR/.git" ]]; then
  git -C "$SRC_DIR" fetch --quiet origin main
  git -C "$SRC_DIR" reset --hard origin/main
else
  git clone --depth=1 "$SRC_REPO_URL" "$SRC_DIR"
fi
echo "   ✅ $(git -C "$SRC_DIR" rev-parse --short HEAD) — $(git -C "$SRC_DIR" log -1 --format=%s)"

# ─── 2b. Pull World Hub repo for runbook serving ────────────────────────
echo "📚 Syncing World Hub runbooks at $WH_SRC_DIR..."
if [[ -d "$WH_SRC_DIR/.git" ]]; then
  git -C "$WH_SRC_DIR" fetch --quiet origin main
  git -C "$WH_SRC_DIR" reset --hard origin/main
else
  git clone --depth=1 "$WH_REPO_URL" "$WH_SRC_DIR"
fi
echo "   ✅ runbooks: $(ls "$WH_SRC_DIR/docs/runbooks/" 2>/dev/null | wc -l) files"

# ─── 3. Set up run dir ───────────────────────────────────────────────────
echo "📁 Setting up run dir at $RUN_DIR..."
mkdir -p "$RUN_DIR"

# Symlink stack config files (keeps them git-tracked at $SRC_DIR, runnable at $RUN_DIR)
for f in docker-compose.yml prometheus.yml alert-rules.yml alertmanager.yml \
         slo-rules.yml slo-alerts.yml grafana-provisioning grafana-dashboards; do
  ln -sfn "$SRC_DIR/infra/monitoring/$f" "$RUN_DIR/$f"
done

# The 3am pager (2026-09-04): Alertmanager posts page=sms alerts to the World
# Hub with CRON_SECRET as a bearer, read from this file. Without it the pager
# receiver fails every notification and the six alerts Dan asked to be woken
# for reach email only. Refuse to proceed rather than deploy a silent pager.
if [[ ! -s "$RUN_DIR/cron_secret" ]]; then
  echo "   ❌ $RUN_DIR/cron_secret is missing or empty. Write the World Hub CRON_SECRET to it, then chown nobody + chmod 400 like resend_key - the container runs as nobody."
  exit 1
fi

# First-run: seed .env from the example. Re-runs leave it alone.
if [[ ! -f "$RUN_DIR/.env" ]]; then
  cp "$SRC_DIR/infra/monitoring/.env.example" "$RUN_DIR/.env"
  chmod 600 "$RUN_DIR/.env"
  echo "   ⚠️  Wrote $RUN_DIR/.env from example — YOU MUST EDIT IT before alerts work:"
  echo "      \$EDITOR $RUN_DIR/.env"
  echo "      (set GRAFANA_ADMIN_PASSWORD, SLACK_ALERT_URL, PAGERDUTY_SERVICE_KEY)"
else
  echo "   ✅ $RUN_DIR/.env already exists — not overwriting"
fi

# ─── 4. Caddy config ─────────────────────────────────────────────────────
echo "🔒 Installing Caddy config..."
CADDY_SRC="$SRC_DIR/infra/monitoring/Caddyfile"
CADDY_DST="/etc/caddy/Caddyfile"

if [[ ! -f "$CADDY_DST" ]] || ! diff -q "$CADDY_SRC" "$CADDY_DST" >/dev/null 2>&1; then
  # Back up existing first.
  [[ -f "$CADDY_DST" ]] && cp "$CADDY_DST" "$CADDY_DST.bak.$(date +%s)"
  cp "$CADDY_SRC" "$CADDY_DST"
  echo "   ✅ Copied $CADDY_SRC → $CADDY_DST"
  echo "   ⚠️  Caddyfile has a REPLACE_WITH_CADDY_HASH_PASSWORD_OUTPUT placeholder."
  echo "      Generate a hash with:   caddy hash-password --plaintext 'your-pw'"
  echo "      Then replace both placeholders in $CADDY_DST and re-run this script."

  if grep -q 'REPLACE_WITH_CADDY_HASH_PASSWORD_OUTPUT' "$CADDY_DST"; then
    echo "   ⚠️  Placeholder still present — NOT reloading Caddy"
  else
    systemctl reload caddy
    echo "   ✅ Reloaded Caddy"
  fi
else
  echo "   ✅ $CADDY_DST already up-to-date"
fi

# ─── 5. Bring up the stack ───────────────────────────────────────────────
echo "🟢 Starting stack..."
cd "$RUN_DIR"
docker compose pull --quiet
docker compose up -d

# ─── 6. Health check ─────────────────────────────────────────────────────
echo "⏳ Waiting 8s for services to become ready..."
sleep 8

FAIL=0
check() {
  local label="$1" url="$2"
  if curl -sf "$url" >/dev/null 2>&1; then
    echo "   ✅ $label — $url"
  else
    echo "   ❌ $label — $url FAILED"
    FAIL=$((FAIL + 1))
  fi
}

check "Prometheus ready"   "http://127.0.0.1:9090/-/ready"
check "AlertManager ready" "http://127.0.0.1:9093/-/ready"
check "Grafana health"     "http://127.0.0.1:3001/api/health"

# Targets up?
echo "🎯 Scrape targets:"
curl -s http://127.0.0.1:9090/api/v1/targets 2>/dev/null | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
for t in data.get('data', {}).get('activeTargets', []):
    print(f\"   {t['health']:8s} {t['labels'].get('job','?'):20s} {t['scrapeUrl']}\")" || \
  echo "   (could not query targets — stack may still be warming up)"

echo ""
if [[ $FAIL -gt 0 ]]; then
  echo "❌ $FAIL health check(s) failed. Recent logs:"
  docker compose logs --tail=20
  exit 1
fi

echo "🎉 Stack healthy. Next steps:"
echo "   1. Edit $RUN_DIR/.env with real creds (if you haven't already)"
echo "   2. Replace the Caddyfile basic-auth placeholder, then: systemctl reload caddy"
echo "   3. Browse to https://monitor.smarter.poker/grafana"
echo "   4. Verify all scrape targets show UP above (engine-01:9100, engine-01:9256, etc.)"
