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
# Usage:
#   FROM CI (.github/workflows/deploy-monitoring.yml, the normal path):
#     the runner ships its checkout's infra/monitoring/ to $SRC_DIR on the
#     box and runs   MONITORING_SRC_FROM_CHECKOUT=1 bash deploy.sh
#   BY HAND, after a git clone WITH CREDENTIALS on the box:
#     cd /opt/smarter-poker-monitoring-src/infra/monitoring && sudo bash deploy.sh
#
# THE curl | bash FORM IS GONE (2026-09-06). This repository is PRIVATE, so
# raw.githubusercontent.com answers 404, `bash` reads an empty stdin and exits
# 0, and the workflow step that did this reported SUCCESS having deployed
# nothing - on the first run of deploy-monitoring.yml, the same morning the
# cluster controller was down for 65 minutes with ClusterPassErrors declared
# in this repo and not loaded on the box. The git clone below has the same
# problem on a box with no credentials, which is why the checkout mode exists.
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

# ─── cron_secret guard ───────────────────────────────────────────────────
# The alertmanager-page Hub route authenticates every POST with the value
# in this file (CRON_SECRET env var). Without it, Alertmanager fires into
# a 401 on every page attempt — the pager silently fails every notification.
# A monitoring stack that cannot page is worse than none.
# This guard was added 2026-09-04 after resend_key was found unprotected on
# the host (never gitignored — one `git add -A` from a leaked key).
if [[ ! -f "$RUN_DIR/cron_secret" ]] || [[ ! -s "$RUN_DIR/cron_secret" ]]; then
  echo "❌ $RUN_DIR/cron_secret is missing or empty."
  echo "   The alertmanager-page webhook authenticates with this secret."
  echo "   Without it every page attempt returns 401 and no one gets woken up."
  echo ""
  echo "   Create it now:"
  echo "     echo 'your-cron-secret-here' > $RUN_DIR/cron_secret"
  echo "     chmod 600 $RUN_DIR/cron_secret"
  echo ""
  echo "   The value must match the CRON_SECRET env var in Vercel."
  exit 1
fi
echo "   ✅ cron_secret present"

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

# ─── 2. Source: the CI checkout, or a git clone ──────────────────────────
# MONITORING_SRC_FROM_CHECKOUT=1 means the caller has already put the files
# it wants deployed at $SRC_DIR/infra/monitoring (the workflow ships its own
# checkout over ssh). Nothing is fetched; what is there is what ships, and
# the version stamp says which commit it was. A box with no git credentials
# cannot clone a private repo, and a deploy that cloned nothing must not
# symlink an empty tree over the live stack.
if [[ "${MONITORING_SRC_FROM_CHECKOUT:-0}" == "1" ]]; then
  echo "📦 Using the shipped checkout at $SRC_DIR/infra/monitoring..."
  if [[ ! -f "$SRC_DIR/infra/monitoring/prometheus.yml" ]]; then
    echo "   ❌ $SRC_DIR/infra/monitoring/prometheus.yml is missing - nothing was shipped. Refusing."
    exit 1
  fi
  echo "   ✅ shipped from $(cat "$SRC_DIR/infra/monitoring/.deployed-from" 2>/dev/null || echo 'an unstamped checkout')"
else
  echo "📦 Syncing source repo at $SRC_DIR..."
  if [[ -d "$SRC_DIR/.git" ]]; then
    git -C "$SRC_DIR" fetch --quiet origin main
    git -C "$SRC_DIR" reset --hard origin/main
  else
    git clone --depth=1 "$SRC_REPO_URL" "$SRC_DIR"
  fi
  echo "   ✅ $(git -C "$SRC_DIR" rev-parse --short HEAD) — $(git -C "$SRC_DIR" log -1 --format=%s)"

  # ─── 2b. Pull World Hub repo for runbook serving ──────────────────────
  echo "📚 Syncing World Hub runbooks at $WH_SRC_DIR..."
  if [[ -d "$WH_SRC_DIR/.git" ]]; then
    git -C "$WH_SRC_DIR" fetch --quiet origin main
    git -C "$WH_SRC_DIR" reset --hard origin/main
  else
    git clone --depth=1 "$WH_REPO_URL" "$WH_SRC_DIR"
  fi
  echo "   ✅ runbooks: $(ls "$WH_SRC_DIR/docs/runbooks/" 2>/dev/null | wc -l) files"
fi

# ─── 3. Set up run dir ───────────────────────────────────────────────────
echo "📁 Setting up run dir at $RUN_DIR..."
mkdir -p "$RUN_DIR"

# Symlink stack config files (keeps them git-tracked at $SRC_DIR, runnable at $RUN_DIR)
# EVERY RULE FILE prometheus.yml LOADS MUST BE IN THIS LIST (phase 7,
# 2026-09-06). It used to name four of the seven, so engine-freeze-rules.yml,
# supervisor-rules.yml, tournament-rules.yml and spin-rules.yml existed on the
# box only because somebody had put them there by hand - a rule added to any of
# them in this repo could never reach production, and a deploy would leave the
# hand-written copy in place for ever. That is half of the drift phase 1 found;
# the other half was this file's own list disagreeing with docker-compose.yml's
# mounts. `tests/what-a-monitor-reads-is-what-the-repo-says.law.test.ts` now
# fails if the three lists ever disagree again.
for f in docker-compose.yml prometheus.yml alertmanager.yml \
         alert-rules.yml engine-freeze-rules.yml supervisor-rules.yml \
         tournament-rules.yml spin-rules.yml slo-rules.yml slo-alerts.yml \
         grafana-provisioning grafana-dashboards; do
  ln -sfn "$SRC_DIR/infra/monitoring/$f" "$RUN_DIR/$f"
done

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

# NEVER PUT A PLACEHOLDER OVER A LIVE PASSWORD (2026-09-06). The repo's
# Caddyfile carries REPLACE_WITH_CADDY_HASH_PASSWORD_OUTPUT; the box's carries
# the real hash and has since the stack went up. This block used to copy the
# repo file over the live one whenever they differed, then decline to reload
# because of the placeholder - leaving a Caddyfile on disk that the NEXT
# reload by anybody would load, locking every operator out of the monitor.
# A live Caddyfile with no placeholder is the operator's, and is left alone.
if [[ -f "$CADDY_DST" ]] && ! grep -q 'REPLACE_WITH_CADDY_HASH_PASSWORD_OUTPUT' "$CADDY_DST" \
   && grep -q 'REPLACE_WITH_CADDY_HASH_PASSWORD_OUTPUT' "$CADDY_SRC"; then
  echo "   ✅ $CADDY_DST carries a real password hash and the repo copy a placeholder - leaving the live file alone"
elif [[ ! -f "$CADDY_DST" ]] || ! diff -q "$CADDY_SRC" "$CADDY_DST" >/dev/null 2>&1; then
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

# ─── 4b. Reload, and prove the reload took ──────────────────────────────
# `docker compose up -d` recreates a container only when its compose entry
# changed; a rule file that changed under an unchanged mount is not reloaded
# by it. Both services run with --web.enable-lifecycle, so ask them. A reload
# that fails is a deploy that shipped nothing, and says so.
echo "🔁 Reloading Prometheus and Alertmanager..."
for svc in "Prometheus http://127.0.0.1:9090/-/reload" "AlertManager http://127.0.0.1:9093/-/reload"; do
  set -- $svc
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$2" || echo 000)
  if [[ "$code" == "200" ]]; then
    echo "   ✅ $1 reloaded"
  else
    echo "   ❌ $1 reload returned HTTP $code - the box is NOT running what was shipped"
    exit 1
  fi
done

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
