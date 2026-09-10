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
CONTROL_DIR="${ENGINE_CONTROL_DIR:-/usr/local/lib/club-arena/engine-control}"
RELEASE_SEAL="${ENGINE_RELEASE_SEAL:-$CONTROL_DIR/engine-release-seal.py}"

# HEALTHCHECK is also an availability control: sp-autoheal restarts the whole
# engine when Docker marks it unhealthy. Under a saturated event loop the
# health handler has taken longer than the old five-second deadline even while
# tables were still making progress. Three false negatives then disconnected
# every table. Give the lightweight semantic probe enough time to be scheduled,
# and give a restarted engine the same five-minute cold-boot grace as the host
# supervisor. After that grace, three failures at 20-second intervals still
# recover a genuinely wedged engine in about one minute.
HEALTH_INTERVAL="${HEALTH_INTERVAL:-20s}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-15s}"
HEALTH_START_PERIOD="${HEALTH_START_PERIOD:-300s}"
HEALTH_RETRIES="${HEALTH_RETRIES:-3}"

log() { echo "[engine-up] $*"; }

# Where outgoing engine logs are kept. Read by nothing automated; read by the
# next agent asking "what did the engine do before it died at 16:52".
LOG_DIR="${LOG_DIR:-/var/log/club-arena-engine}"
LOG_KEEP_DAYS="${LOG_KEEP_DAYS:-14}"
LOG_KEEP_MB="${LOG_KEEP_MB:-6144}"

save_outgoing_log() {
  local c="$1" id img started stamp out
  mkdir -p "$LOG_DIR" || return 1
  id="$(docker inspect -f '{{.Id}}' "$c" 2>/dev/null | cut -c1-12)" || return 1
  img="$(docker inspect -f '{{.Config.Image}}' "$c" 2>/dev/null | sed 's#.*[:/]##' | cut -c1-8 | tr -c 'A-Za-z0-9._\n-' '_')"
  started="$(docker inspect -f '{{.State.StartedAt}}' "$c" 2>/dev/null | cut -c1-19 | tr -d ':-')"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  out="$LOG_DIR/engine-${stamp}-started${started:-unknown}-${id:-unknown}-${img:-unknown}.log.gz"
  # -t: every line carries the daemon's timestamp, so the file is usable
  # without the process's own clock.
  if timeout --signal=TERM --kill-after=5s 20s \
    bash -c 'set -o pipefail; docker logs -t "$1" 2>&1 | gzip -6 > "$2"' \
    _ "$c" "$out"; then
    log "saved the outgoing log to $out ($(du -h "$out" | cut -f1))"
  else
    rm -f "$out"; return 1
  fi
  # Retention: age first, then total size (oldest first) so a chatty week
  # cannot fill the disk the engine and the database probes share.
  find "$LOG_DIR" -name 'engine-*.log.gz' -mtime +"$LOG_KEEP_DAYS" -delete 2>/dev/null || true
  local total
  total="$(du -sm "$LOG_DIR" 2>/dev/null | cut -f1)"
  while [ "${total:-0}" -gt "$LOG_KEEP_MB" ]; do
    local oldest
    # Never delete the file just written: the newest log is the one the next
    # investigation needs, whatever the cap says.
    [ "$(ls -1 "$LOG_DIR"/engine-*.log.gz 2>/dev/null | wc -l)" -gt 1 ] || break
    oldest="$(ls -1tr "$LOG_DIR"/engine-*.log.gz 2>/dev/null | head -1)"
    [ -n "$oldest" ] || break
    rm -f "$oldest"
    total="$(du -sm "$LOG_DIR" 2>/dev/null | cut -f1)"
  done
  return 0
}

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

# GIT_COMMIT_SHA is an image property. Docker applies --env-file after image
# ENV, so allowing either version key here would let old bytes claim the sealed
# SHA to /health and engine_leader. Refuse before stopping the serving engine.
if grep -Eq '^[[:space:]]*(GIT_COMMIT_SHA|ENGINE_VERSION)[[:space:]]*=' "$ENV_FILE"; then
  log "FATAL: $ENV_FILE overrides a reserved image-version key — refusing to touch the running engine"
  exit 1
fi

# Mutable tags are only caches. The root-owned seal outside /opt/club-arena is
# the authority for the exact image ID and full commit that recovery may run.
# A deploy candidate needs the one-use token issued by the audited prepare
# step; the already-sealed desired image is always allowed for recovery.
if [ ! -x "$RELEASE_SEAL" ]; then
  log "FATAL: release authority is missing or not executable: $RELEASE_SEAL"
  exit 1
fi
AUTH_ARGS=(authorize --image "$IMAGE")
TOKEN_VALUE=''
[ -z "${ENGINE_RELEASE_TOKEN:-}" ] \
  || { log 'FATAL: release tokens in environment variables are forbidden'; exit 1; }
if [ -n "${ENGINE_RELEASE_TOKEN_FD:-}" ]; then
  [[ "$ENGINE_RELEASE_TOKEN_FD" =~ ^[3-9]$ ]] \
    || { log 'FATAL: release token descriptor is invalid'; exit 1; }
  IFS= read -r TOKEN_VALUE <&"$ENGINE_RELEASE_TOKEN_FD" \
    || { log 'FATAL: release token descriptor is unreadable'; exit 1; }
  AUTH_ARGS+=(--token-stdin)
fi
if [ -n "$TOKEN_VALUE" ]; then
  AUTHORIZATION="$(printf '%s' "$TOKEN_VALUE" | "$RELEASE_SEAL" "${AUTH_ARGS[@]}")"
  TOKEN_VALUE=''
else
  AUTHORIZATION="$("$RELEASE_SEAL" "${AUTH_ARGS[@]}")"
fi \
  || { log "FATAL: release seal rejected image $IMAGE — refusing to touch the running engine"; exit 1; }
read -r AUTHORIZED_CLASS AUTHORIZED_SHA AUTHORIZED_IMAGE_ID EXTRA <<< "$AUTHORIZATION"
case "$AUTHORIZED_CLASS" in
  desired) RESTART_POLICY=always ;;
  pending)
    # A prepared candidate is a compatibility trial, not a durable release.
    # If the host or daemon restarts before every proof commits the seal, Docker
    # must leave these bytes stopped so the supervisor restores the old desired
    # release.  The workflow promotes the policy only after that commit.
    RESTART_POLICY=no
    ;;
  *) log "FATAL: release authority returned an invalid release class"; exit 1 ;;
esac
[[ "$AUTHORIZED_SHA" =~ ^[0-9a-f]{40}$ ]] \
  || { log "FATAL: release authority returned an invalid SHA"; exit 1; }
[[ "$AUTHORIZED_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] \
  || { log "FATAL: release authority returned an invalid image ID"; exit 1; }
[ -z "${EXTRA:-}" ] \
  || { log "FATAL: release authority returned an ambiguous identity"; exit 1; }
docker image inspect "$AUTHORIZED_IMAGE_ID" >/dev/null 2>&1 \
  || { log "FATAL: authorized image $AUTHORIZED_IMAGE_ID disappeared before cutover"; exit 1; }

log "replacing $CONTAINER with $AUTHORIZED_CLASS image $AUTHORIZED_IMAGE_ID ($AUTHORIZED_SHA; requested as $IMAGE)"
# STOP, then remove. NOT `docker rm -f`, which is SIGKILL with no grace period.
# The engine drains its table engines and flushes hand-state snapshots on
# SIGTERM; killing it outright loses whatever was mid-flush. Docker's default
# grace is 10s, which was already found to be too short — it SIGKILLed the
# engine partway through the flush — hence -t 45.
if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  log "stopping $CONTAINER (SIGTERM, 45s grace for snapshot flush)"
  docker stop -t 45 "$CONTAINER" >/dev/null 2>&1 || true
  # THE OUTGOING ENGINE'S LOG SURVIVES IT (2026-09-07). `docker rm` deletes the
  # json-file log with the container, and the container is replaced every
  # hour, so the log of whatever went wrong in the previous hour was gone the
  # moment anyone could look: on 2026-09-07 the engine was unreachable for a
  # minute at 16:52 and resurfaced inside an off-schedule break, and there was
  # nothing left to read. Dump the whole retained log (json-file keeps up to
  # 5 x 50 MB) to disk, compressed, named by stop time + short id + image, and
  # keep fourteen days or 6 GB, whichever is hit first. Never fatal: a failed
  # dump must not stop the deploy.
  save_outgoing_log "$CONTAINER" || log "WARN: could not save the outgoing log (continuing)"
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
  --restart "$RESTART_POLICY" \
  --health-interval="$HEALTH_INTERVAL" \
  --health-timeout="$HEALTH_TIMEOUT" \
  --health-start-period="$HEALTH_START_PERIOD" \
  --health-retries="$HEALTH_RETRIES" \
  --health-cmd="node -e \"const fs=require('fs');const s=fs.readFileSync('/proc/1/stat','utf8');const f=s.slice(s.lastIndexOf(')')+2).trim().split(' ').filter(Boolean);const u=Number(fs.readFileSync('/proc/uptime','utf8').split(' ')[0]);const a=u-Number(f[19])/100;if(a<300)process.exit(0);fetch('http://0.0.0.0:8080/health').then(r=>r.json()).then(j=>{const l=j.liveness;process.exit(j.running===true&&(l==='ok'||l==='standby')?0:1)}).catch(()=>process.exit(1))\"" \
  --label autoheal=true \
  --label sp.role=engine \
  --label "sp.release.sha=$AUTHORIZED_SHA" \
  --log-driver json-file \
  --log-opt max-size=50m \
  --log-opt max-file=5 \
  -p "${PORT}:8080" \
  --env-file "$ENV_FILE" \
  "$AUTHORIZED_IMAGE_ID"

log "started $(docker inspect -f '{{.Id}}' "$CONTAINER" | cut -c1-12) from $AUTHORIZED_IMAGE_ID (restart=$RESTART_POLICY)"
