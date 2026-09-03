#!/usr/bin/env bash
#
# engine-supervisor.sh — the last line of defence for "the game is never down".
#
# Everything else in the recovery stack depends on something else staying alive:
#
#   --restart always   depends on Docker deciding the stop was involuntary.
#                      `docker stop`/`docker kill` are recorded as MANUAL stops,
#                      so the policy does not fire. An operator, or a deploy that
#                      dies between stop and run, leaves the engine down forever.
#   sp-autoheal        depends on the container EXISTING and reporting unhealthy,
#                      and on it carrying --label autoheal=true. A removed or
#                      mislabelled container reports nothing.
#   GitHub Actions     depends on GitHub being up and a runner being available.
#
# This depends on nothing but systemd and the local Docker daemon. It runs every
# 60s and enforces one invariant: the engine container exists, carries the right
# labels, is running, and is answering /health.
#
# Always exits 0 unless it could not act at all, so the timer never enters a
# failed state that would stop future runs.
#
set -uo pipefail

CONTAINER="${CONTAINER:-club-arena-engine}"
IMAGE="${IMAGE:-club-arena-engine:current}"
PORT="${PORT:-8080}"
UP_SCRIPT="${UP_SCRIPT:-/opt/club-arena/server/scripts/engine-up.sh}"
STATE_DIR="${STATE_DIR:-/var/lib/club-arena}"
STATE_FILE="$STATE_DIR/supervisor-fails"
COUNTER_FILE="$STATE_DIR/recoveries"
LAST_START_FILE="$STATE_DIR/last-started-at"
LAST_CID_FILE="$STATE_DIR/last-container-id"
CHURN_FILE="$STATE_DIR/boot-churn"
RESTARTING_FILE="$STATE_DIR/restarting-samples"
LOCK_FILE="${LOCK_FILE:-/var/lock/club-arena-engine-up.lock}"

# /health must fail this many consecutive runs (60s apart) before we restart.
# The engine's own HEALTHCHECK + autoheal react faster; this is the backstop for
# when autoheal itself is dead.
FAIL_THRESHOLD="${FAIL_THRESHOLD:-3}"
# Grace after container start. Must exceed --health-start-period (90s).
#
# 2026-08-30: raised 120 -> 300. During the Supabase resize outage the engine's
# cold boot legitimately ran 5-8 minutes (repair sweeps + loaders against a
# cold-cache database), and a 120s grace made the supervisor one of the THREE
# things restarting the engine mid-boot (with the deploy train and the
# leadership standby->leader exit). Every kill restarted the boot from zero and
# the fleet went ~80 minutes without dealing a hand. The supervisor exists to
# recover a dead engine, not to cap how long a live boot may take: a healthy
# warm boot clears in under 2 minutes and is unaffected; a genuinely wedged
# boot is still caught, 3 minutes later than before, by FAIL_THRESHOLD or
# CHURN_THRESHOLD.
BOOT_GRACE_SEC="${BOOT_GRACE_SEC:-300}"
# Consecutive runs that may find the container inside boot grace before we call
# it a crash loop. Without this the supervisor is blind forever to an engine
# that restarts faster than BOOT_GRACE_SEC — every sample looks like a healthy
# boot, /health is never called, and the metrics report all-clear throughout.
CHURN_THRESHOLD="${CHURN_THRESHOLD:-3}"
# Consecutive samples in Docker's `restarting` state before we escalate.
# `docker start` on a restarting container is a no-op (Docker short-circuits
# 304 Not Modified because .State.Running is already true), so naively
# "recovering" it logs a recovery every 60s forever while nothing happens.
RESTARTING_THRESHOLD="${RESTARTING_THRESHOLD:-3}"

TEXTFILE_DIR="${TEXTFILE_DIR:-/var/lib/node-exporter-textfile}"
METRIC_FILE="$TEXTFILE_DIR/club_arena_supervisor.prom"

mkdir -p "$STATE_DIR" 2>/dev/null || true

log() { echo "[engine-supervisor] $*"; logger -t engine-supervisor -- "$*" 2>/dev/null || true; }

# ── small integer-file helpers (all tolerate a missing/corrupt file) ─────────
readnum() { local n; n=$(cat "$1" 2>/dev/null || echo 0); case "$n" in ''|*[!0-9]*) n=0 ;; esac; echo "$n"; }
writenum() { echo "$2" > "$1" 2>/dev/null || true; }
bump() { local n; n=$(readnum "$1"); n=$((n + 1)); writenum "$1" "$n"; echo "$n"; }

act() {
  # Records an intervention in the journal AND in Prometheus. A supervisor that
  # silently papers over a crash loop is worse than no supervisor, because it
  # converts a loud outage into a quiet one.
  log "RECOVERY: $1"
  bump "$COUNTER_FILE" >/dev/null
}

# Written on EVERY run, including clean no-ops, so the heartbeat stays fresh.
# Temp file + mv: node-exporter reads this concurrently and a half-written file
# is a parse error that drops all of these series at once.
#   serving: 1 up, 0 down, -1 unknown (inside boot grace — NOT an all-clear)
emit_metrics() {
  local serving="$1" running="$2"
  local recoveries churn restarting
  recoveries=$(readnum "$COUNTER_FILE")
  churn=$(readnum "$CHURN_FILE")
  restarting=$(readnum "$RESTARTING_FILE")
  mkdir -p "$TEXTFILE_DIR" 2>/dev/null || return 0
  local tmp="$METRIC_FILE.$$"
  {
    echo "# HELP club_arena_supervisor_last_run_timestamp_seconds Unix time of the last supervisor run."
    echo "# TYPE club_arena_supervisor_last_run_timestamp_seconds gauge"
    echo "club_arena_supervisor_last_run_timestamp_seconds $(date +%s)"
    echo "# HELP club_arena_supervisor_recoveries_total Times the supervisor had to intervene."
    echo "# TYPE club_arena_supervisor_recoveries_total counter"
    echo "club_arena_supervisor_recoveries_total $recoveries"
    echo "# HELP club_arena_engine_serving 1 serving, 0 not serving, -1 unknown (inside boot grace)."
    echo "# TYPE club_arena_engine_serving gauge"
    echo "club_arena_engine_serving $serving"
    echo "# HELP club_arena_engine_container_running 1 when the container state is 'running'."
    echo "# TYPE club_arena_engine_container_running gauge"
    echo "club_arena_engine_container_running $running"
    echo "# HELP club_arena_engine_boot_churn Consecutive supervisor runs that found the engine still inside boot grace."
    echo "# TYPE club_arena_engine_boot_churn gauge"
    echo "club_arena_engine_boot_churn $churn"
    echo "# HELP club_arena_engine_restarting_samples Consecutive supervisor runs that found the container in Docker's 'restarting' state."
    echo "# TYPE club_arena_engine_restarting_samples gauge"
    echo "club_arena_engine_restarting_samples $restarting"
  } > "$tmp" 2>/dev/null && mv -f "$tmp" "$METRIC_FILE" 2>/dev/null || rm -f "$tmp" 2>/dev/null
}

recreate() {
  # ENGINE_UP_LOCK_HELD=1: this process already holds $LOCK_FILE (taken below).
  # engine-up.sh would otherwise open the same path on a fresh descriptor,
  # which is a DIFFERENT lock as far as flock is concerned, and block on its
  # own parent for the full 180s timeout before failing — turning every
  # supervisor recovery into a guaranteed no-op.
  export ENGINE_UP_LOCK_HELD=1
  if [ -x "$UP_SCRIPT" ]; then
    CONTAINER="$CONTAINER" IMAGE="$IMAGE" PORT="$PORT" "$UP_SCRIPT" || log "engine-up.sh failed"
  elif [ -f "$UP_SCRIPT" ]; then
    # `git reset --hard` used to strip the exec bit (the scripts were 100644 in
    # the index until 2026-08-15). Recover rather than give up: being unable to
    # chmod our own recovery script is not a reason to leave the engine down.
    log "WARN: $UP_SCRIPT is not executable — restoring the exec bit"
    chmod +x "$UP_SCRIPT" 2>/dev/null
    if [ -x "$UP_SCRIPT" ]; then
      CONTAINER="$CONTAINER" IMAGE="$IMAGE" PORT="$PORT" "$UP_SCRIPT" || log "engine-up.sh failed"
    else
      log "FATAL: cannot make $UP_SCRIPT executable — cannot recreate"
    fi
  else
    log "FATAL: $UP_SCRIPT missing — cannot recreate"
  fi
}

if ! docker info >/dev/null 2>&1; then
  log "docker daemon unreachable — nothing this script can do; leaving it to docker.service"
  emit_metrics 0 0
  exit 0
fi

# ── Mutual exclusion with the deploy ─────────────────────────────────────────
# engine-up.sh takes this same lock. Without it, a supervisor tick landing in
# the deploy's window between `docker rm` and `docker run` sees "container
# absent", starts its own engine-up.sh, and ends up stopping and recreating the
# container the deploy had just created — which fails the deploy's health
# verification and rolls back a perfectly good build.
exec 9>"$LOCK_FILE" 2>/dev/null
if ! flock -n 9 2>/dev/null; then
  log "engine-up.sh is running elsewhere (deploy in progress) — skipping this tick"
  exit 0
fi

# ── 1. Does the container exist at all? ──────────────────────────────────────
if ! docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  act "container '$CONTAINER' does not exist — recreating from $IMAGE"
  recreate
  writenum "$STATE_FILE" 0; writenum "$CHURN_FILE" 0; writenum "$RESTARTING_FILE" 0
  emit_metrics 0 0
  exit 0
fi

STATUS=$(docker container inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo unknown)

# ── 2. Wrong run-spec is as bad as no container ──────────────────────────────
# A container created by any path other than engine-up.sh may be missing
# --label autoheal=true. Docker's HEALTHCHECK only sets a status field; the
# sp-autoheal sidecar is what acts on it, and it selects by this label. An
# engine without it looks perfectly healthy while its self-healing is off.
LABEL=$(docker container inspect -f '{{index .Config.Labels "autoheal"}}' "$CONTAINER" 2>/dev/null || echo "")
if [ "$LABEL" != "true" ]; then
  act "container is missing autoheal=true (label='$LABEL') — its healthcheck is wired to nothing; recreating from $IMAGE"
  recreate
  writenum "$STATE_FILE" 0; writenum "$CHURN_FILE" 0; writenum "$RESTARTING_FILE" 0
  emit_metrics 0 1
  exit 0
fi

case "$STATUS" in
  # ── 3. Crash loop. `docker start` here is a documented no-op, so treating
  #      this like a plain stopped container logs a recovery every 60s forever
  #      while achieving nothing. Let Docker's backoff work, but escalate.
  restarting)
    N=$(bump "$RESTARTING_FILE")
    log "container is 'restarting' (crash loop, sample ${N}/${RESTARTING_THRESHOLD}) — letting Docker's backoff run"
    if [ "$N" -ge "$RESTARTING_THRESHOLD" ]; then
      act "container has been crash-looping for ${N} consecutive checks — capturing logs and recreating from $IMAGE"
      docker logs --tail 120 "$CONTAINER" 2>&1 | tail -120 | sed 's/^/[crashloop-log] /' || true
      recreate
      writenum "$RESTARTING_FILE" 0
    fi
    writenum "$STATE_FILE" 0
    emit_metrics 0 0
    exit 0
    ;;

  # ── 4. Paused. `docker start` errors on a paused container, and falling
  #      through to a recreate means `docker stop -t 45` against a frozen
  #      cgroup that cannot receive SIGTERM: 45s of nothing, then SIGKILL
  #      mid-snapshot-flush. Unpause is instant and lossless.
  paused)
    act "container is paused — unpausing"
    docker unpause "$CONTAINER" >/dev/null 2>&1 || { act "unpause failed — recreating"; recreate; }
    writenum "$STATE_FILE" 0; writenum "$RESTARTING_FILE" 0
    emit_metrics 0 1
    exit 0
    ;;

  # ── 5. Unrecoverable container object. engine-up.sh's `docker rm` fails on
  #      a 'dead' container, so a plain recreate name-conflicts every tick and
  #      the supervisor wedges permanently. Force-remove first.
  dead|removing)
    act "container state='$STATUS' — force-removing the container object, then recreating"
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || log "docker rm -f failed on a '$STATUS' container — may need a dockerd restart"
    recreate
    writenum "$STATE_FILE" 0; writenum "$RESTARTING_FILE" 0
    emit_metrics 0 0
    exit 0
    ;;

  # ── 6. Exists but stopped. THE `docker stop` HOLE: --restart always
  #      deliberately does not cover a manual stop.
  created|exited)
    act "container state='$STATUS' (restart policy does not cover manual stops) — starting"
    if ! docker start "$CONTAINER" >/dev/null 2>&1; then
      act "docker start failed — recreating from $IMAGE"
      recreate
    fi
    writenum "$STATE_FILE" 0; writenum "$RESTARTING_FILE" 0
    emit_metrics 0 1
    exit 0
    ;;

  running) : ;;   # fall through

  *)
    log "unhandled container state '$STATUS' — taking no action, but recording it"
    emit_metrics 0 0
    exit 0
    ;;
esac

writenum "$RESTARTING_FILE" 0

# ── 7. Running. Give it boot grace before judging /health — but detect churn.
STARTED_AT=$(docker container inspect -f '{{.State.StartedAt}}' "$CONTAINER" 2>/dev/null || echo "")
START_EPOCH=0
if [ -n "$STARTED_AT" ]; then
  START_EPOCH=$(date -d "$STARTED_AT" +%s 2>/dev/null || echo 0)
fi

if [ "$START_EPOCH" -gt 0 ]; then
  AGE=$(( $(date +%s) - START_EPOCH ))
  if [ "$AGE" -lt "$BOOT_GRACE_SEC" ]; then
    # An engine restarting faster than BOOT_GRACE_SEC would otherwise look like
    # a healthy boot on EVERY sample: /health never called, serving reported as
    # 1, and the alert that exists to catch this actively suppressed. Count
    # consecutive in-grace samples and escalate; report serving as -1 (unknown)
    # rather than 1, so nothing downstream reads boot grace as an all-clear.
    LAST=$(readnum "$LAST_START_FILE")
    writenum "$LAST_START_FILE" "$START_EPOCH"
    # A DEPLOY is not a crash loop. engine-up.sh removes the container and
    # creates a new one, so the container ID changes; Docker's restart policy
    # restarts the SAME container, so the ID is stable and RestartCount climbs.
    # Without this, four back-to-back deploys looked identical to a crash loop
    # and tripped the churn escalation (observed 2026-08-16: supervisor logged
    # "crash loop hiding inside the grace window" while RestartCount was 0).
    CID=$(docker container inspect -f '{{.Id}}' "$CONTAINER" 2>/dev/null | cut -c1-12)
    LAST_CID=$(cat "$LAST_CID_FILE" 2>/dev/null || echo "")
    echo "$CID" > "$LAST_CID_FILE" 2>/dev/null || true
    if [ -n "$LAST_CID" ] && [ "$CID" != "$LAST_CID" ]; then
      log "container was replaced (deploy/recreate: ${LAST_CID:-none} -> $CID) — not churn"
      writenum "$CHURN_FILE" 0
      writenum "$STATE_FILE" 0
      emit_metrics -1 1
      exit 0
    fi
    if [ "$LAST" != "$START_EPOCH" ] && [ "$LAST" != "0" ]; then
      N=$(bump "$CHURN_FILE")
      log "container restarted again within boot grace (age ${AGE}s, churn ${N}/${CHURN_THRESHOLD})"
      if [ "$N" -ge "$CHURN_THRESHOLD" ]; then
        act "engine has restarted ${N} times without ever clearing boot grace — this is a crash loop hiding inside the grace window"
        docker logs --tail 120 "$CONTAINER" 2>&1 | tail -120 | sed 's/^/[boot-churn-log] /' || true
        writenum "$CHURN_FILE" 0
      fi
    else
      log "running for ${AGE}s (< ${BOOT_GRACE_SEC}s boot grace) — not judging health yet"
    fi
    writenum "$STATE_FILE" 0
    emit_metrics -1 1
    exit 0
  fi
  writenum "$LAST_START_FILE" "$START_EPOCH"
  writenum "$CHURN_FILE" 0
fi
# START_EPOCH == 0 means the timestamp did not parse; skip grace and judge on
# /health, which fails safe (we act) rather than staying blind forever.

# ── 8. Is it actually serving? "running" is not the same as "working". ───────
BODY=$(curl -sf --max-time 5 "http://127.0.0.1:${PORT}/health" 2>/dev/null || echo "")
if [ -n "$BODY" ] && echo "$BODY" | grep -q '"running":true'; then
  PREV=$(readnum "$STATE_FILE")
  [ "$PREV" != "0" ] && log "health recovered after $PREV consecutive failures"
  writenum "$STATE_FILE" 0
  emit_metrics 1 1
  exit 0
fi

FAILS=$(bump "$STATE_FILE")
log "health check failed (${FAILS}/${FAIL_THRESHOLD} consecutive)"

if [ "$FAILS" -ge "$FAIL_THRESHOLD" ]; then
  act "engine unresponsive on /health for ${FAILS} consecutive checks — restarting container"
  docker logs --tail 60 "$CONTAINER" 2>&1 | tail -60 | sed 's/^/[pre-restart-log] /' || true
  if ! docker restart -t 45 "$CONTAINER" >/dev/null 2>&1; then
    act "docker restart failed — recreating from $IMAGE"
    recreate
  fi
  writenum "$STATE_FILE" 0
fi

emit_metrics 0 1
exit 0
