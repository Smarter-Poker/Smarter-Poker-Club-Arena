#!/usr/bin/env bash
#
# engine-up.sh — THE single source of truth for how the Club Arena engine
# container is run.
#
# Why this file exists
# ────────────────────
# The run-spec used to live only inside .github/workflows/auto-deploy-hetzner.yml.
# That meant anything which restarted the engine outside of CI (an operator, the
# host supervisor, a recovery after a half-finished deploy) had to re-derive the
# flags from memory. Every one of those flags is load-bearing:
#
#   --label autoheal=true   Docker's HEALTHCHECK only sets .State.Health.Status.
#                           Plain Docker NEVER restarts an unhealthy container.
#                           The sp-autoheal sidecar watches for this label and
#                           performs the restart. Without it the healthcheck is
#                           a status light wired to nothing.
#   --restart always        Covers process crash + daemon restart + host reboot.
#                           It does NOT cover `docker stop`/`docker kill`, which
#                           Docker records as a manual stop — that hole is
#                           covered by engine-supervisor.sh, not by this flag.
#   --log-opt max-size      Unbounded json-file logs fill the disk, and a full
#                           disk wedges the engine in exactly the way this whole
#                           workstream exists to prevent.
#
# Callers: auto-deploy-hetzner.yml (deploy) and engine-supervisor.sh (recovery).
# Both must go through here so the two can never drift apart.
#
set -euo pipefail

# ── Mutual exclusion ─────────────────────────────────────────────────────────
# engine-supervisor.sh takes this same lock (non-blocking; it skips its tick if
# held). Without it, a supervisor tick landing in the window between the
# `docker rm` and `docker run` below sees "container absent", launches its own
# copy of this script, and ends up stopping and recreating the container the
# deploy had just created — which fails the deploy's health verification and
# rolls back a build that was fine. The mirror case is two simultaneous
# `docker run`s, where the loser dies on "container name already in use".
LOCK_FILE="${LOCK_FILE:-/var/lock/club-arena-engine-up.lock}"
if [ "${ENGINE_UP_LOCK_HELD:-0}" != "1" ]; then
  exec 9>"$LOCK_FILE"
  # Wait rather than fail: the caller wants the engine up, and the other holder
  # is about to put it up. 180s comfortably exceeds `docker stop -t 45` plus a
  # container start.
  flock -w 180 9 || { echo "[engine-up] FATAL: could not acquire $LOCK_FILE within 180s"; exit 1; }
fi

CONTAINER="${CONTAINER:-club-arena-engine}"
IMAGE="${IMAGE:-club-arena-engine:current}"
ENV_FILE="${ENV_FILE:-/opt/club-arena/server/.env}"
PORT="${PORT:-8080}"

log() { echo "[engine-up] $*"; }

# Fail BEFORE touching the running container. A missing env file or image used
# to be discovered only after the old container was already destroyed, which
# turned a recoverable mistake into an outage.
if [ ! -s "$ENV_FILE" ]; then
  log "FATAL: env file missing or empty: $ENV_FILE — refusing to touch the running engine"
  exit 1
fi
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  log "FATAL: image not present: $IMAGE — refusing to touch the running engine"
  exit 1
fi

log "replacing $CONTAINER with image $IMAGE"
# STOP, then remove. NOT `docker rm -f`, which is SIGKILL with no grace period.
# The engine drains its table engines and flushes hand-state snapshots on
# SIGTERM; killing it outright loses whatever was mid-flush. Docker's default
# grace is 10s, which was already found to be too short — it SIGKILLed the
# engine partway through the flush — hence -t 45.
if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  log "stopping $CONTAINER (SIGTERM, 45s grace for snapshot flush)"
  docker stop -t 45 "$CONTAINER" >/dev/null 2>&1 || true
  docker rm "$CONTAINER" >/dev/null 2>&1 || docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
fi

# 2026-08-23: OVERRIDE THE IMAGE'S HEALTHCHECK ADDRESS.
#
# The Dockerfile probes 127.0.0.1, but `httpServer.listen(PORT)` passes no host,
# so Node binds the unspecified address and answers on :: in a dual-stack
# container. The IPv4 loopback probe was REFUSED, every time.
#
# Docker then marked the container unhealthy after 3 tries, sp-autoheal saw the
# autoheal=true label and killed it, --restart always brought it back, and the
# cycle repeated about every 5 minutes. A perfectly healthy engine was being
# executed by its own self-healing -- and every restart voids the in-flight
# hands on every table it owns.
#
# The Dockerfile is fixed too, so the image is not born broken. This override
# stays because THIS FILE IS THE RUN-SPEC (design note 4): the deploy and the
# host supervisor must start the container identically, and this is the one
# place both of them read.
docker run -d \
  --name "$CONTAINER" \
  --restart always \
  --health-start-period=90s \
  --health-cmd="node -e \"fetch('http://0.0.0.0:8080/health').then(r=>r.json()).then(j=>process.exit(j.liveness==='dead'?1:0)).catch(()=>process.exit(1))\"" \
  --label autoheal=true \
  --label sp.role=engine \
  --log-driver json-file \
  --log-opt max-size=50m \
  --log-opt max-file=5 \
  -p "${PORT}:8080" \
  --env-file "$ENV_FILE" \
  "$IMAGE"

log "started $(docker inspect -f '{{.Id}}' "$CONTAINER" | cut -c1-12) from $IMAGE"
