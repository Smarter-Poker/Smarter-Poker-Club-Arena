#!/usr/bin/env bash
#
# engine-supervisor.sh — the last line of defence for "the game is never down".
#
# Everything else in the recovery stack depends on something staying alive:
#
#   --restart always   depends on Docker deciding the stop was involuntary.
#                      `docker stop` and `docker kill` are recorded as MANUAL
#                      stops, so the policy does not fire. An operator, or a
#                      deploy that dies between `stop` and `run`, leaves the
#                      engine down forever.
#   sp-autoheal        depends on the container EXISTING and reporting
#                      unhealthy. A removed container reports nothing.
#   GitHub Actions     depends on GitHub being up and a runner being available.
#
# This script depends on nothing but systemd and the local Docker daemon. It
# runs every 60s and enforces one invariant: the engine container exists, is
# running, and is answering /health.
#
# Exit codes: always 0 unless it could not act at all (so the timer never
# enters a failed state that stops future runs).
#
set -uo pipefail

CONTAINER="${CONTAINER:-club-arena-engine}"
IMAGE="${IMAGE:-club-arena-engine:current}"
PORT="${PORT:-8080}"
UP_SCRIPT="${UP_SCRIPT:-/opt/club-arena/server/scripts/engine-up.sh}"
STATE_DIR="${STATE_DIR:-/var/lib/club-arena}"
STATE_FILE="$STATE_DIR/supervisor-fails"
# /health must fail this many consecutive runs (60s apart) before we restart.
# The engine's own Docker HEALTHCHECK + autoheal react faster; this is the
# backstop for the case where autoheal itself is dead.
FAIL_THRESHOLD="${FAIL_THRESHOLD:-3}"
# Grace after container start, must exceed --health-start-period.
BOOT_GRACE_SEC="${BOOT_GRACE_SEC:-120}"

mkdir -p "$STATE_DIR" 2>/dev/null || true

log() { echo "[engine-supervisor] $*"; logger -t engine-supervisor -- "$*" 2>/dev/null || true; }

act() {
  # $1 = reason. Records the recovery so it shows up in journalctl and can be
  # alerted on — a supervisor that silently papers over a crash-loop is worse
  # than no supervisor.
  log "RECOVERY: $1"
}

reset_fails() { echo 0 > "$STATE_FILE" 2>/dev/null || true; }
bump_fails() {
  local n
  n=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
  case "$n" in ''|*[!0-9]*) n=0 ;; esac
  n=$((n + 1))
  echo "$n" > "$STATE_FILE" 2>/dev/null || true
  echo "$n"
}

if ! docker info >/dev/null 2>&1; then
  log "docker daemon unreachable — nothing this script can do; leaving to systemd/docker.service"
  exit 0
fi

# ── 1. Does the container exist at all? ──────────────────────────────────────
if ! docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  act "container '$CONTAINER' does not exist — recreating from $IMAGE"
  if [ -x "$UP_SCRIPT" ]; then
    CONTAINER="$CONTAINER" IMAGE="$IMAGE" PORT="$PORT" "$UP_SCRIPT" || log "engine-up.sh failed"
  else
    log "FATAL: $UP_SCRIPT missing or not executable — cannot recreate"
  fi
  reset_fails
  exit 0
fi

STATUS=$(docker container inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo unknown)

# ── 2. Exists but not running. This is the `docker stop`/`docker kill` hole:
#       --restart always deliberately does NOT fire here. ───────────────────
if [ "$STATUS" != "running" ]; then
  act "container state='$STATUS' (restart policy does not cover manual stops) — starting"
  if ! docker start "$CONTAINER" >/dev/null 2>&1; then
    act "docker start failed — recreating from $IMAGE"
    [ -x "$UP_SCRIPT" ] && CONTAINER="$CONTAINER" IMAGE="$IMAGE" PORT="$PORT" "$UP_SCRIPT" || log "engine-up.sh failed"
  fi
  reset_fails
  exit 0
fi

# ── 3. Running. Give it boot grace before judging /health. ───────────────────
STARTED_AT=$(docker container inspect -f '{{.State.StartedAt}}' "$CONTAINER" 2>/dev/null || echo "")
if [ -n "$STARTED_AT" ]; then
  START_EPOCH=$(date -d "$STARTED_AT" +%s 2>/dev/null || echo 0)
  NOW_EPOCH=$(date +%s)
  AGE=$((NOW_EPOCH - START_EPOCH))
  if [ "$START_EPOCH" -gt 0 ] && [ "$AGE" -lt "$BOOT_GRACE_SEC" ]; then
    log "running for ${AGE}s (< ${BOOT_GRACE_SEC}s boot grace) — not judging health yet"
    reset_fails
    exit 0
  fi
fi

# ── 4. Is it actually serving? `running` is not the same as `working`. ───────
BODY=$(curl -sf --max-time 5 "http://127.0.0.1:${PORT}/health" 2>/dev/null || echo "")
SERVING=0
if [ -n "$BODY" ] && echo "$BODY" | grep -q '"running":true'; then
  SERVING=1
fi

if [ "$SERVING" = "1" ]; then
  PREV=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
  [ "$PREV" != "0" ] && log "health recovered after $PREV consecutive failures"
  reset_fails
  exit 0
fi

FAILS=$(bump_fails)
log "health check failed (${FAILS}/${FAIL_THRESHOLD} consecutive)"

if [ "$FAILS" -ge "$FAIL_THRESHOLD" ]; then
  act "engine unresponsive on /health for ${FAILS} consecutive checks — restarting container"
  docker logs --tail 60 "$CONTAINER" 2>&1 | tail -60 | sed 's/^/[pre-restart-log] /' || true
  if ! docker restart -t 45 "$CONTAINER" >/dev/null 2>&1; then
    act "docker restart failed — recreating from $IMAGE"
    [ -x "$UP_SCRIPT" ] && CONTAINER="$CONTAINER" IMAGE="$IMAGE" PORT="$PORT" "$UP_SCRIPT" || log "engine-up.sh failed"
  fi
  reset_fails
fi

exit 0
