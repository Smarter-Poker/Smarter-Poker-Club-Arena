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
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

docker run -d \
  --name "$CONTAINER" \
  --restart always \
  --health-start-period=90s \
  --label autoheal=true \
  --label sp.role=engine \
  --log-driver json-file \
  --log-opt max-size=50m \
  --log-opt max-file=5 \
  -p "${PORT}:8080" \
  --env-file "$ENV_FILE" \
  "$IMAGE"

log "started $(docker inspect -f '{{.Id}}' "$CONTAINER" | cut -c1-12) from $IMAGE"
