#!/usr/bin/env bash
#
# engine-supervisor.sh - one-shot restoration of the exact sealed desired
# engine release.
#
# The filename is part of the frozen release-v1 generation contract, but this
# is not a supervisor, timer, watchdog, or background reconciler anymore. It is
# invoked synchronously only by the release transaction or its ExecStopPost
# recovery while that caller owns the engine mutation lock. Docker's
# `--restart always` policy owns crash/daemon/host restart. A manual stop stays
# intentional instead of being silently reversed by a periodic mutation.
#
set -euo pipefail

CONTAINER="${CONTAINER:-club-arena-engine}"
PORT="${PORT:-8080}"
CONTROL_DIR="${ENGINE_CONTROL_DIR:-/usr/local/lib/club-arena/engine-control}"
UP_SCRIPT="${UP_SCRIPT:-$CONTROL_DIR/engine-up.sh}"
RELEASE_SEAL="${ENGINE_RELEASE_SEAL:-$CONTROL_DIR/engine-release-seal.py}"
AUTOHEAL_CONTAINER="${AUTOHEAL_CONTAINER:-sp-autoheal}"
PUBLIC_URL="${ENGINE_URL:-https://engine.smarter.poker}"
HEALTH_TIMEOUT_SEC="${HEALTH_TIMEOUT_SEC:-15}"
RECOVERY_DEADLINE_EPOCH="${ENGINE_RECOVERY_DEADLINE_EPOCH:-0}"

log() {
  echo "[engine-supervisor] $*"
  logger -t engine-supervisor -- "$*" 2>/dev/null || true
}

die() {
  log "FATAL: $*"
  exit 1
}

# There is deliberately no autonomous mode. Every mutation must belong to the
# already-running release transaction and its absolute recovery deadline.
[ "$#" = 0 ] || die 'this one-shot recovery accepts no positional arguments'
[ "${ENGINE_SUPERVISOR_FORCE_DESIRED:-0}" = 1 ] \
  && [ "${ENGINE_SUPERVISOR_REQUIRE_EXACT_HEALTH:-0}" = 1 ] \
  && [ "${ENGINE_SUPERVISOR_LOCK_HELD:-0}" = 1 ] \
  || die 'one-shot recovery requires force-desired, exact-health, and caller-held-lock authority'
[[ "$RECOVERY_DEADLINE_EPOCH" =~ ^[1-9][0-9]*$ ]] \
  || die 'one-shot recovery requires an absolute deadline'

recovery_remaining() {
  local remaining=$((RECOVERY_DEADLINE_EPOCH - $(date +%s)))
  [ "$remaining" -gt 1 ] || return 1
  printf '%s\n' "$remaining"
}

bounded_recovery_command() {
  local requested="$1" remaining allowed
  shift
  remaining="$(recovery_remaining)" || return 124
  allowed=$((remaining - 1))
  [ "$requested" -le "$allowed" ] || requested="$allowed"
  [ "$requested" -gt 0 ] || return 124
  timeout --signal=TERM --kill-after=1s "${requested}s" "$@"
}

recovery_remaining >/dev/null \
  || die 'one-shot recovery deadline has already expired'
bounded_recovery_command 10 docker info >/dev/null 2>&1 \
  || die 'Docker is unavailable during exact desired recovery'
[ -x "$RELEASE_SEAL" ] \
  || die "release seal controller is missing or not executable: $RELEASE_SEAL"
[ -x "$UP_SCRIPT" ] \
  || die "canonical engine-up script is missing or not executable: $UP_SCRIPT"

DESIRED_SHA="$(bounded_recovery_command 10 "$RELEASE_SEAL" get desired-sha)" \
  || die 'durable desired release SHA is unreadable'
DESIRED_IMAGE_ID="$(bounded_recovery_command 10 "$RELEASE_SEAL" get desired-image-id)" \
  || die 'durable desired image ID is unreadable'
DESIRED_LEGACY_UNLABELLED="$(bounded_recovery_command 10 "$RELEASE_SEAL" get desired-legacy-unlabelled)" \
  || die 'durable legacy-bootstrap state is unreadable'
[[ "$DESIRED_SHA" =~ ^[0-9a-f]{40}$ ]] \
  || die 'durable desired release SHA is invalid'
[[ "$DESIRED_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] \
  || die 'durable desired image ID is invalid'
case "$DESIRED_LEGACY_UNLABELLED" in
  true|false) ;;
  *) die 'durable legacy-bootstrap state is invalid' ;;
esac
bounded_recovery_command 10 docker image inspect "$DESIRED_IMAGE_ID" >/dev/null 2>&1 \
  || die "sealed desired image $DESIRED_IMAGE_ID ($DESIRED_SHA) is absent"

autoheal_status() {
  bounded_recovery_command 5 docker container inspect \
    -f '{{.State.Status}}' "$AUTOHEAL_CONTAINER" 2>/dev/null || printf 'absent\n'
}

ensure_autoheal_running() {
  local status
  status="$(autoheal_status)"
  [ "$status" = running ] && return 0
  log "$AUTOHEAL_CONTAINER is '$status' during exact desired recovery - starting it"
  bounded_recovery_command 10 docker start "$AUTOHEAL_CONTAINER" >/dev/null 2>&1 \
    || return 1
  [ "$(autoheal_status)" = running ]
}

recreate() {
  local budget
  budget="$(recovery_remaining)" || return 1
  log "restoring exact sealed desired release $DESIRED_SHA"
  bounded_recovery_command "$budget" env \
    ENGINE_UP_LOCK_HELD=1 \
    ENGINE_CONTROL_DIR="$CONTROL_DIR" \
    CONTAINER="$CONTAINER" IMAGE="$DESIRED_IMAGE_ID" PORT="$PORT" \
    "$UP_SCRIPT" \
    || return 1
  ensure_autoheal_running
}

recreate_or_die() {
  recreate || die 'exact sealed desired release could not be restored'
}

health_identity() {
  local url="$1" response http_code body instance remaining curl_timeout
  remaining="$(recovery_remaining)" || return 1
  curl_timeout=$((remaining - 1))
  [ "$curl_timeout" -le "$HEALTH_TIMEOUT_SEC" ] || curl_timeout="$HEALTH_TIMEOUT_SEC"
  [ "$curl_timeout" -gt 0 ] || return 1
  # Recovery proves the already-sealed process, not a new candidate. A defect
  # in an optional subsystem can make that exact live source answer 503; the
  # release that fixes it must still be able to replace it, and a failed trial
  # must still be able to restore it. Accept only complete 200/503 responses.
  # New candidates and every publication proof remain strict routing-ready 200.
  response="$(curl -sS --max-time "$curl_timeout" \
    -H 'Cache-Control: no-cache, no-store' --write-out $'\n%{http_code}' \
    "$url" 2>/dev/null)" || return 1
  http_code="${response##*$'\n'}"
  body="${response%$'\n'*}"
  case "$http_code" in
    200|503) ;;
    *) return 1 ;;
  esac
  # A SEALED RELEASE IS PROVED WITH WHAT IT PUBLISHES (2026-09-11).
  #
  # `releaseSha` arrived with server/src/releaseIdentity.ts. The release it
  # shipped in could not deploy, because THIS function was asked to restore
  # the release already running - which predates the field - and refused it.
  # Every engine release from 15:37 UTC onward died at "sealed desired runtime
  # could not be restored before release work" while the engine on the box was
  # healthy, exact and serving. Four merges' worth of engine fixes sat on main
  # with no way onto the floor, and the loop is self-sustaining: the build that
  # would publish the field is the build that cannot ship.
  #
  # So an older sealed release proves itself with `version`, which is the first
  # eight characters of the same commit and is set by the same build. This is
  # not a weaker proof by accident: the container is separately proved to carry
  # the exact image id AND the exact `sp.release.sha` label before this is even
  # called, and the fallback is accepted ONLY when `releaseSha` is absent
  # entirely. A release that publishes the field must still match it exactly,
  # so a mismatched new build can never take the short road.
  #
  # RECOVERY ONLY. Every new-candidate and publication proof - in
  # engine-release-transaction.sh, observe-engine-release.sh and the workflow -
  # keeps the strict form, because a candidate is by definition built from
  # source that has the field.
  instance="$(printf '%s' "$body" | EXPECTED_SHA="$DESIRED_SHA" python3 -c '
import json, os, re, sys
d=json.load(sys.stdin)
instance=d.get("instanceId")
expected=os.environ["EXPECTED_SHA"]
sha=d.get("releaseSha")
identity=(sha==expected) or (sha is None and d.get("version")==expected[:8])
ok=(d.get("running") is True and identity and d.get("liveness")=="ok" and isinstance(instance,str) and re.fullmatch(r"[1-9][0-9]*-[0-9a-f]{8}",instance))
if not ok: raise SystemExit(1)
print(instance)
' 2>/dev/null)" || return 1
  printf '%s\n' "$instance"
}

prove_exact_desired_recovery() {
  local local_instance public_instance state image_id release_label autoheal_label role_label restart_policy
  while recovery_remaining >/dev/null; do
    state="$(bounded_recovery_command 5 docker container inspect \
      -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || true)"
    image_id="$(bounded_recovery_command 5 docker container inspect \
      -f '{{.Image}}' "$CONTAINER" 2>/dev/null || true)"
    release_label="$(bounded_recovery_command 5 docker container inspect \
      -f '{{index .Config.Labels "sp.release.sha"}}' "$CONTAINER" 2>/dev/null || true)"
    autoheal_label="$(bounded_recovery_command 5 docker container inspect \
      -f '{{index .Config.Labels "autoheal"}}' "$CONTAINER" 2>/dev/null || true)"
    role_label="$(bounded_recovery_command 5 docker container inspect \
      -f '{{index .Config.Labels "sp.role"}}' "$CONTAINER" 2>/dev/null || true)"
    restart_policy="$(bounded_recovery_command 5 docker container inspect \
      -f '{{.HostConfig.RestartPolicy.Name}}' "$CONTAINER" 2>/dev/null || true)"
    if [ "$state" = running ] \
      && [ "$image_id" = "$DESIRED_IMAGE_ID" ] \
      && { [ "$release_label" = "$DESIRED_SHA" ] \
        || { [ "$DESIRED_LEGACY_UNLABELLED" = true ] && [ -z "$release_label" ]; }; } \
      && [ "$autoheal_label" = true ] \
      && [ "$role_label" = engine ] \
      && [ "$restart_policy" = always ]; then
      local_instance="$(health_identity "http://127.0.0.1:${PORT}/health")" \
        || local_instance=''
      if [ -n "$local_instance" ]; then
        public_instance="$(health_identity "$PUBLIC_URL/health?nocache=$(date +%s%N)")" \
          || public_instance=''
        if [ "$public_instance" = "$local_instance" ]; then
          log "exact desired release $DESIRED_SHA is live and exact locally and publicly as $local_instance"
          return 0
        fi
      fi
    fi
    bounded_recovery_command 5 sleep 5 || break
  done
  log "FATAL: exact desired release $DESIRED_SHA did not become live and exact locally and publicly before the recovery deadline"
  return 1
}

RUNNING_IMAGE_ID="$(bounded_recovery_command 5 docker container inspect \
  -f '{{.Image}}' "$CONTAINER" 2>/dev/null || true)"
RUNNING_STATUS="$(bounded_recovery_command 5 docker container inspect \
  -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || true)"
RUNNING_RELEASE="$(bounded_recovery_command 5 docker container inspect \
  -f '{{index .Config.Labels "sp.release.sha"}}' "$CONTAINER" 2>/dev/null || true)"
RUNNING_AUTOHEAL_LABEL="$(bounded_recovery_command 5 docker container inspect \
  -f '{{index .Config.Labels "autoheal"}}' "$CONTAINER" 2>/dev/null || true)"
RUNNING_ROLE_LABEL="$(bounded_recovery_command 5 docker container inspect \
  -f '{{index .Config.Labels "sp.role"}}' "$CONTAINER" 2>/dev/null || true)"

if [ "$RUNNING_IMAGE_ID" != "$DESIRED_IMAGE_ID" ] \
  || [ "$RUNNING_AUTOHEAL_LABEL" != true ] \
  || [ "$RUNNING_ROLE_LABEL" != engine ] \
  || { [ "$RUNNING_RELEASE" != "$DESIRED_SHA" ] \
    && { [ "$DESIRED_LEGACY_UNLABELLED" != true ] || [ -n "$RUNNING_RELEASE" ]; }; }; then
  log "force-desired recovery is evicting every unsealed runtime and restoring sealed $DESIRED_SHA"
  recreate_or_die
else
  case "$RUNNING_STATUS" in
    running) ;;
    paused)
      bounded_recovery_command 10 docker unpause "$CONTAINER" >/dev/null \
        || recreate_or_die
      ;;
    created|exited)
      bounded_recovery_command 20 docker start "$CONTAINER" >/dev/null \
        || recreate_or_die
      ;;
    *) recreate_or_die ;;
  esac
fi

RUNNING_RESTART_POLICY="$(bounded_recovery_command 5 docker container inspect \
  -f '{{.HostConfig.RestartPolicy.Name}}' "$CONTAINER" 2>/dev/null || true)"
if [ "$RUNNING_RESTART_POLICY" != always ]; then
  bounded_recovery_command 10 docker update --restart always "$CONTAINER" >/dev/null \
    || die 'could not arm sealed desired restart policy'
fi
ensure_autoheal_running \
  || die "exact desired recovery could not start $AUTOHEAL_CONTAINER"
prove_exact_desired_recovery \
  || exit 1
