#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════
# Prometheus + Grafana + AlertManager stack deploy — Hetzner cron-01
# Phase 5.1.3a
# ═════════════════════════════════════════════════════════════════════════
#
# Deployment payload for the Club Arena-owned monitoring workflow. It runs as
# root on the Hetzner host only after the trusted workflow has shipped an exact
# checkout. `docker compose up -d` is idempotent; credential-bearing runtime
# files are prerequisites and are never created or edited here.
#
# There is no curl, git-clone, World Hub, or workstation fallback.
# ═════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────
SRC_DIR="${SRC_DIR:-/opt/smarter-poker-monitoring-src}"
RUN_DIR="${RUN_DIR:-/opt/smarter-poker-monitoring}"

if [[ "${MONITORING_SRC_FROM_CHECKOUT:-0}" != "1" ]]; then
  echo "❌ Refusing a non-workflow monitoring deploy."
  exit 1
fi
if [[ ! "${DEPLOY_CONTROL_SHA:-}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "❌ DEPLOY_CONTROL_SHA must be one full lowercase Club Arena commit."
  exit 1
fi
AUTHORITY_FILE="$SRC_DIR/infra/monitoring/.deployed-from"
PAYLOAD_MANIFEST="$SRC_DIR/infra/monitoring/.club-arena-monitoring-payload.sha256"
RELEASE_RECEIPT="$RUN_DIR/.club-arena-monitoring-release"
STAMP_SCHEMA=$(sed -n 's/^schema=//p' "$AUTHORITY_FILE" 2>/dev/null || true)
STAMP_SHA=$(sed -n 's/^sha=//p' "$AUTHORITY_FILE" 2>/dev/null || true)
STAMP_PREVIOUS=$(sed -n 's/^previous=//p' "$AUTHORITY_FILE" 2>/dev/null || true)
STAMP_PAYLOAD=$(sed -n 's/^payload=//p' "$AUTHORITY_FILE" 2>/dev/null || true)
if [[ "$STAMP_SCHEMA" != "club-arena-monitoring-release-v1" ]] \
  || [[ ! "$STAMP_PREVIOUS" =~ ^(none|[0-9a-f]{40})$ ]] \
  || [[ ! "$STAMP_PAYLOAD" =~ ^[0-9a-f]{64}$ ]]; then
  echo "❌ Shipped monitoring release authority is malformed."
  exit 1
fi
if [[ "$STAMP_SHA" != "$DEPLOY_CONTROL_SHA" ]]; then
  echo "❌ Shipped checkout stamp '$STAMP_SHA' does not match the authorized commit."
  exit 1
fi
if [[ ! -s "$PAYLOAD_MANIFEST" ]] \
  || [[ "$(sha256sum "$PAYLOAD_MANIFEST" | cut -d' ' -f1)" != "$STAMP_PAYLOAD" ]]; then
  echo "❌ Shipped monitoring payload manifest does not match its authority."
  exit 1
fi
(cd "$SRC_DIR" && sha256sum --strict --check "$PAYLOAD_MANIFEST" >/dev/null) \
  || { echo "❌ Shipped monitoring payload bytes do not match the authorized checkout."; exit 1; }

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
  echo "   Provision it through the owning Hetzner secret-management process;"
  echo "   this deployment will not create, copy, or replace credentials."
  exit 1
fi
echo "   ✅ cron_secret present"

echo "🚀 smarter.poker monitoring stack deploy — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ─── 1. Prereqs ──────────────────────────────────────────────────────────
echo "🔎 Checking prerequisites..."
for bin in docker caddy python3 sha256sum; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "   ❌ missing: $bin"
    exit 1
  fi
done
if ! docker compose version >/dev/null 2>&1; then
  echo "   ❌ missing: docker compose plugin"
  echo "      Install: apt-get install -y docker-compose-plugin"
  exit 1
fi
echo "   ✅ docker, docker compose, caddy all present"

# ─── 2. Source: exact checkout shipped by the owning workflow ───────────
echo "📦 Using the authorized checkout at $SRC_DIR/infra/monitoring..."
if [[ ! -f "$SRC_DIR/infra/monitoring/prometheus.yml" ]]; then
  echo "   ❌ $SRC_DIR/infra/monitoring/prometheus.yml is missing - refusing."
  exit 1
fi
echo "   ✅ shipped from $(cat "$SRC_DIR/infra/monitoring/.deployed-from")"

# ─── 3. Set up run dir ───────────────────────────────────────────────────
echo "📁 Setting up run dir at $RUN_DIR..."
mkdir -p "$RUN_DIR"

# Compare-and-swap the host's last successful release before changing any
# symlink or container. The workflow proved the previous SHA is an ancestor of
# this exact current-main commit. A late runner may therefore proceed only if
# the host still names that predecessor. Replaying the same exact payload is
# idempotent; every other mismatch is a stale or divergent publisher.
if [[ -e "$RELEASE_RECEIPT" ]]; then
  [[ -f "$RELEASE_RECEIPT" && ! -L "$RELEASE_RECEIPT" ]] \
    || { echo "❌ Monitoring release receipt is not a regular file."; exit 1; }
  LIVE_SCHEMA=$(sed -n 's/^schema=//p' "$RELEASE_RECEIPT")
  LIVE_SHA=$(sed -n 's/^sha=//p' "$RELEASE_RECEIPT")
  LIVE_PAYLOAD=$(sed -n 's/^payload=//p' "$RELEASE_RECEIPT")
  [[ "$LIVE_SCHEMA" == "club-arena-monitoring-release-v1" ]] \
    && [[ "$LIVE_SHA" =~ ^[0-9a-f]{40}$ ]] \
    && [[ "$LIVE_PAYLOAD" =~ ^[0-9a-f]{64}$ ]] \
    || { echo "❌ Monitoring release receipt is malformed."; exit 1; }
  if [[ "$LIVE_SHA" == "$STAMP_SHA" && "$LIVE_PAYLOAD" == "$STAMP_PAYLOAD" ]]; then
    echo "   ✅ exact monitoring release replay authorized"
  elif [[ "$LIVE_SHA" != "$STAMP_PREVIOUS" ]]; then
    echo "❌ Monitoring release compare-and-swap failed: host advanced after this runner's proof."
    exit 1
  fi
elif [[ "$STAMP_PREVIOUS" != "none" ]]; then
  echo "❌ Monitoring release receipt disappeared after workflow authorization."
  exit 1
fi

# Symlink stack config files (keeps them git-tracked at $SRC_DIR, runnable at $RUN_DIR)
# EVERY RULE FILE prometheus.yml LOADS MUST BE IN THIS LIST (phase 7,
# 2026-09-06). It used to name four of the seven, so engine-freeze-rules.yml,
# recovery-rules.yml, tournament-rules.yml and spin-rules.yml existed on the
# box only because somebody had put them there by hand - a rule added to any of
# them in this repo could never reach production, and a deploy would leave the
# hand-written copy in place for ever. That is half of the drift phase 1 found;
# the other half was this file's own list disagreeing with docker-compose.yml's
# mounts. `tests/what-a-monitor-reads-is-what-the-repo-says.law.test.ts` now
# fails if the three lists ever disagree again.
for f in docker-compose.yml prometheus.yml alertmanager.yml \
         alert-rules.yml engine-freeze-rules.yml recovery-rules.yml \
         tournament-rules.yml spin-rules.yml slo-rules.yml slo-alerts.yml \
         grafana-provisioning grafana-dashboards; do
  ln -sfn "$SRC_DIR/infra/monitoring/$f" "$RUN_DIR/$f"
done

# The checkout intentionally retired the periodic supervisor rules. An
# in-place source copy cannot express deletion, so converge this exact legacy
# path explicitly; never use a wildcard that could erase an unrelated rule.
rm -f -- "$RUN_DIR/supervisor-rules.yml"

# Runtime credentials are provisioned out of band. A placeholder is not a
# deployable configuration and must never be written over the host.
if [[ ! -s "$RUN_DIR/.env" ]]; then
  echo "   ❌ $RUN_DIR/.env is missing or empty; refusing to deploy placeholders."
  exit 1
fi
echo "   ✅ credential-bearing runtime environment is present and unchanged"

# ─── 4. Caddy config ─────────────────────────────────────────────────────
echo "🔒 Installing Caddy config..."
CADDY_DST="/etc/caddy/Caddyfile"

# NEVER PUT A PLACEHOLDER OVER A LIVE PASSWORD (2026-09-06). The repo's
# Caddyfile carries REPLACE_WITH_CADDY_HASH_PASSWORD_OUTPUT; the box's carries
# the real hash and has since the stack went up. This block used to copy the
# repo file over the live one whenever they differed, then decline to reload
# because of the placeholder - leaving a Caddyfile on disk that the NEXT
# reload by anybody would load, locking every operator out of the monitor.
# A live Caddyfile with no placeholder is credential-bearing host state. This
# workflow verifies it and never replaces it from the repository template.
if [[ ! -s "$CADDY_DST" ]] || grep -q 'REPLACE_WITH_CADDY_HASH_PASSWORD_OUTPUT' "$CADDY_DST"; then
  echo "   ❌ Live Caddy configuration is absent or still contains a placeholder."
  exit 1
fi
echo "   ✅ live credential-bearing Caddy configuration is present and unchanged"

# The live Caddyfile is operator-managed because it contains the real
# monitoring password hash and, on engine-01, routes not present in the repo's
# placeholder template. Patch only the credential-carrying WebSocket header
# out of the runtime logger; the installer validates a candidate, preserves
# the exact live file as its rollback, reloads gracefully and proves Caddy is
# still active. The monitoring workflow ships this exact script alongside the
# monitoring checkout, so this is not a reference to a file the host may lack.
CADDY_REDACTION_INSTALLER="$SRC_DIR/server/scripts/install-caddy-websocket-log-redaction.sh"
if [[ ! -x "$CADDY_REDACTION_INSTALLER" ]]; then
  echo "   ❌ Caddy WebSocket log-redaction installer missing: $CADDY_REDACTION_INSTALLER"
  exit 1
fi
"$CADDY_REDACTION_INSTALLER"

# ─── 5. Bring up the stack ───────────────────────────────────────────────
echo "🟢 Starting stack..."
cd "$RUN_DIR"
docker compose pull --quiet
# Validate the candidate through a fresh mount before disturbing the service.
# An existing container can retain an unlinked config inode after a publisher
# replaces the host path; validating inside that container would test old bytes.
docker compose run --rm --no-deps --entrypoint /bin/amtool alertmanager \
  check-config /etc/alertmanager/alertmanager.yml
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
  read -r service_name service_url <<< "$svc"
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$service_url" || echo 000)
  if [[ "$code" == "200" ]]; then
    echo "   ✅ $service_name reloaded"
  else
    echo "   ❌ $service_name reload returned HTTP $code - the box is NOT running what was shipped"
    exit 1
  fi
done

# HTTP 200 proves only that the mounted file reloaded. On 2026-09-13 it was an
# old, detached inode: host config and release receipt had advanced while the
# process still used the old notification routes. Compare the process's own
# successful-load fingerprint with the authorized host file before publishing.
AM_VERIFIER="$SRC_DIR/infra/monitoring/verify-alertmanager-config.py"
AM_CONFIG="$SRC_DIR/infra/monitoring/alertmanager.yml"
AM_VERIFY_STATUS=0
python3 "$AM_VERIFIER" "$AM_CONFIG" || AM_VERIFY_STATUS=$?
if [[ "$AM_VERIFY_STATUS" == "2" ]]; then
  echo "🔁 Reattaching Alertmanager to the shipped configuration; retaining its named data volume..."
  docker compose up -d --no-deps --force-recreate alertmanager
  for attempt in {1..15}; do
    if curl --max-time 2 -sf http://127.0.0.1:9093/-/ready >/dev/null; then
      break
    fi
    sleep 1
  done
  python3 "$AM_VERIFIER" "$AM_CONFIG"
elif [[ "$AM_VERIFY_STATUS" != "0" ]]; then
  echo "❌ Alertmanager runtime configuration could not be verified; release is not acknowledged."
  exit "$AM_VERIFY_STATUS"
fi

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

# Publication is not acknowledged until the exact payload is healthy and its
# per-host release receipt plus containing directory are fsynced. A crash before
# this point leaves the prior receipt, so the same candidate can replay; a crash
# after it leaves an idempotent exact-release receipt.
RECEIPT_TMP=$(mktemp "$RUN_DIR/.club-arena-monitoring-release.XXXXXXXX")
trap 'rm -f -- "${RECEIPT_TMP:-}"' EXIT
printf 'schema=club-arena-monitoring-release-v1\nsha=%s\npayload=%s\n' \
  "$STAMP_SHA" "$STAMP_PAYLOAD" > "$RECEIPT_TMP"
chmod 0600 "$RECEIPT_TMP"
python3 - "$RECEIPT_TMP" "$RUN_DIR" <<'PY'
import os
import sys
for path in sys.argv[1:]:
    flags = os.O_RDONLY | (getattr(os, "O_DIRECTORY", 0) if os.path.isdir(path) else 0)
    descriptor = os.open(path, flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
PY
mv -T "$RECEIPT_TMP" "$RELEASE_RECEIPT"
RECEIPT_TMP=''
python3 - "$RUN_DIR" <<'PY'
import os
import sys
descriptor = os.open(sys.argv[1], os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
trap - EXIT

echo "🎉 Stack healthy and running the authorized Club Arena checkout $DEPLOY_CONTROL_SHA."
