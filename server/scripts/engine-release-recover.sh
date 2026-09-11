#!/usr/bin/env bash
# Idempotent ExecStopPost fence for every one-shot engine release unit.
set -euo pipefail

CONTROL_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REQUEST_ROOT="${ENGINE_RELEASE_REQUEST_ROOT:-/var/lib/club-arena/engine-release-requests}"
PIN_ROOT="${ENGINE_RELEASE_PIN_ROOT:-/var/lib/club-arena/engine-release-generation-pins}"
LEASE_ROOT="${ENGINE_RELEASE_IMAGE_LEASE_ROOT:-/var/lib/club-arena/engine-image-leases}"
ENGINE_LOCK="${ENGINE_LOCK_FILE:-/var/lock/club-arena-engine-up.lock}"
CONTAINER="${CONTAINER:-club-arena-engine}"
PUBLIC_URL="${ENGINE_URL:-https://engine.smarter.poker}"
RECOVERY_MAX_SECONDS=300

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

fsync_directory() {
  bounded_recovery_command 10 python3 - "$1" <<'PY'
import os
import sys
fd = os.open(sys.argv[1], os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try:
    os.fsync(fd)
finally:
    os.close(fd)
PY
}

[ "$(id -u)" = 0 ] || { echo '[engine-release-recover] FATAL: must run as root' >&2; exit 1; }
[ "$#" = 4 ] && [ "$1" = --run-id ] && [ "$3" = --mode ] \
  || { echo '[engine-release-recover] FATAL: invalid arguments' >&2; exit 1; }
RUN_ID="$2"
RECOVERY_MODE="$4"
[[ "$RUN_ID" =~ ^[1-9][0-9]*(-[1-9][0-9]*)?$ ]] \
  || { echo '[engine-release-recover] FATAL: invalid run key' >&2; exit 1; }
case "$RECOVERY_MODE" in terminal|retryable) ;;
  *) echo '[engine-release-recover] FATAL: invalid recovery mode' >&2; exit 1 ;;
esac

BREAK_DEADLINE_FILE="$REQUEST_ROOT/$RUN_ID.break-deadline"
RECOVERY_DEADLINE_EPOCH=$(( $(date +%s) + RECOVERY_MAX_SECONDS ))
if [ -e "$BREAK_DEADLINE_FILE" ]; then
  [ -f "$BREAK_DEADLINE_FILE" ] && [ ! -L "$BREAK_DEADLINE_FILE" ] \
    || { echo '[engine-release-recover] FATAL: break deadline is not a regular file' >&2; exit 1; }
  [ "$(stat -c '%u:%a' "$BREAK_DEADLINE_FILE")" = '0:600' ] \
    || { echo '[engine-release-recover] FATAL: break deadline ownership or mode is invalid' >&2; exit 1; }
  mapfile -t BREAK_DEADLINE_LINES < "$BREAK_DEADLINE_FILE" \
    || { echo '[engine-release-recover] FATAL: break deadline is unreadable' >&2; exit 1; }
  [ "${#BREAK_DEADLINE_LINES[@]}" = 1 ] \
    && [[ "${BREAK_DEADLINE_LINES[0]}" =~ ^[1-9][0-9]*$ ]] \
    || { echo '[engine-release-recover] FATAL: break deadline is invalid' >&2; exit 1; }
  if [ "${BREAK_DEADLINE_LINES[0]}" -gt "$(date +%s)" ]; then
    RECOVERY_DEADLINE_EPOCH="${BREAK_DEADLINE_LINES[0]}"
  else
    # A dependency can degrade after the pre-cutover readiness proof. This is
    # emergency containment after the player-facing deadline, not evidence of
    # an in-break recovery; keep the durable request until exact desired health
    # is really proved.
    echo '[engine-release-recover] ERROR: certified break deadline expired; forcing desired recovery without claiming an in-break recovery' >&2
  fi
fi

exec 9>"$ENGINE_LOCK"
LOCK_WAIT="$(recovery_remaining)" \
  || { echo '[engine-release-recover] FATAL: recovery deadline expired before engine lock' >&2; exit 1; }
[ "$LOCK_WAIT" -le 5 ] || LOCK_WAIT=5
flock -w "$LOCK_WAIT" 9 \
  || { echo '[engine-release-recover] FATAL: engine lock unavailable; durable request retained' >&2; exit 1; }

# A Docker outage is not successful recovery. Leave request, lease, generation
# pin, and enabled unit intact so systemd can retry the same transaction after
# its required Docker service returns.
bounded_recovery_command 10 docker info >/dev/null 2>&1 \
  || { echo '[engine-release-recover] FATAL: Docker unavailable; durable request retained' >&2; exit 1; }

# Abort can only clear a pending entry owned by this exact run. It is a no-op
# after a successful commit or when the transaction failed before prepare.
set +e
bounded_recovery_command 10 \
  "$CONTROL_DIR/engine-release-seal.py" abort --run-id "$RUN_ID"
ABORT_RC=$?
set -e
SUPERVISOR_BUDGET="$(recovery_remaining)" \
  || { echo '[engine-release-recover] FATAL: recovery deadline expired before desired restoration' >&2; exit 1; }
bounded_recovery_command "$SUPERVISOR_BUDGET" env \
  ENGINE_SUPERVISOR_LOCK_HELD=1 ENGINE_SUPERVISOR_FORCE_DESIRED=1 \
  ENGINE_SUPERVISOR_REQUIRE_EXACT_HEALTH=1 \
  ENGINE_RECOVERY_DEADLINE_EPOCH="$RECOVERY_DEADLINE_EPOCH" \
  ENGINE_CONTROL_DIR="$CONTROL_DIR" CONTAINER="$CONTAINER" ENGINE_URL="$PUBLIC_URL" \
  "$CONTROL_DIR/engine-supervisor.sh" \
  || { echo '[engine-release-recover] FATAL: exact desired local and public health recovery failed' >&2; exit 1; }

if [ "$RECOVERY_MODE" = retryable ]; then
  [ "$ABORT_RC" -eq 0 ] \
    || { echo '[engine-release-recover] FATAL: retryable state retained, but abort audit failed' >&2; exit "$ABORT_RC"; }
  echo '[engine-release-recover] transient release interruption recovered; durable request retained'
  exit 0
fi

# Terminal cleanup has exactly one generation-bound owner. The commit/abort
# audit must be trustworthy before that owner retires any durable state.
[ "$ABORT_RC" -eq 0 ] \
  || { echo '[engine-release-recover] FATAL: abort audit failed; durable release state retained' >&2; exit "$ABORT_RC"; }

# Terminal retirement is authorized by one exact immutable outcome, never by a
# systemd exit code alone. Read the still-durable request before deleting any
# pin, lease, intent, deadline, or boot edge and bind the receipt to its target
# and immutable control generation. Success remains a valid historical receipt
# even if a later release has already advanced desired.
REQUEST_FILE="$REQUEST_ROOT/$RUN_ID.request"
[ -f "$REQUEST_FILE" ] && [ ! -L "$REQUEST_FILE" ] \
  || { echo '[engine-release-recover] FATAL: terminal cleanup has no regular release request' >&2; exit 1; }
[ "$(stat -c '%u:%a' "$REQUEST_FILE")" = '0:600' ] \
  || { echo '[engine-release-recover] FATAL: terminal cleanup request ownership or mode is invalid' >&2; exit 1; }
mapfile -t TERMINAL_REQUEST_LINES < "$REQUEST_FILE" \
  || { echo '[engine-release-recover] FATAL: terminal cleanup request is unreadable' >&2; exit 1; }
[ "${#TERMINAL_REQUEST_LINES[@]}" = 6 ] \
  && [[ "${TERMINAL_REQUEST_LINES[0]}" =~ ^[0-9a-f]{40}$ ]] \
  && [[ "${TERMINAL_REQUEST_LINES[4]}" =~ ^[0-9a-f]{40}$ ]] \
  && [[ "${TERMINAL_REQUEST_LINES[5]}" =~ ^[1-9][0-9]*$ ]] \
  && [ "${#TERMINAL_REQUEST_LINES[5]}" -le 10 ] \
  || { echo '[engine-release-recover] FATAL: terminal cleanup request fields are invalid' >&2; exit 1; }
bounded_recovery_command 15 "$CONTROL_DIR/engine-release-seal.py" attest-terminal \
  --sha "${TERMINAL_REQUEST_LINES[0]}" --run-id "$RUN_ID" \
  --control-sha "${TERMINAL_REQUEST_LINES[4]}" >/dev/null \
  || { echo '[engine-release-recover] FATAL: exact terminal receipt is absent; durable release state retained' >&2; exit 1; }

# Remove the generation pin first while intent, request, and the enabled boot
# edge still exist. A crash here simply replays the request and recreates the
# same validated pin; it can never strand a pin that blocks generation GC.
PIN_FILE="$PIN_ROOT/$RUN_ID.generation"
case "$PIN_FILE" in
  "$PIN_ROOT"/[1-9][0-9]*.generation|"$PIN_ROOT"/[1-9][0-9]*-[1-9][0-9]*.generation)
    bounded_recovery_command 10 rm -f -- "$PIN_FILE"
    ;;
  *) echo '[engine-release-recover] FATAL: refusing unsafe generation-pin cleanup' >&2; exit 1 ;;
esac
fsync_directory "$PIN_ROOT"

LEASE_FILE="$LEASE_ROOT/$RUN_ID.lease"
if [ -d "$LEASE_ROOT" ]; then
  case "$LEASE_FILE" in
    "$LEASE_ROOT"/[1-9][0-9]*.lease|"$LEASE_ROOT"/[1-9][0-9]*-[1-9][0-9]*.lease)
      bounded_recovery_command 10 rm -f -- "$LEASE_FILE"
      ;;
    *) echo '[engine-release-recover] FATAL: refusing unsafe image-lease cleanup' >&2; exit 1 ;;
  esac
  fsync_directory "$LEASE_ROOT"
fi

# Retire auxiliary deadline state while the immutable request still owns a
# replay. Request deletion remains the final durable state deletion, so any
# earlier fsync failure can always reconstruct its exact cleanup authority.
case "$BREAK_DEADLINE_FILE" in
  "$REQUEST_ROOT"/[1-9][0-9]*.break-deadline|"$REQUEST_ROOT"/[1-9][0-9]*-[1-9][0-9]*.break-deadline)
    bounded_recovery_command 10 rm -f -- "$BREAK_DEADLINE_FILE"
    ;;
  *) echo '[engine-release-recover] FATAL: refusing unsafe break-deadline cleanup' >&2; exit 1 ;;
esac
fsync_directory "$REQUEST_ROOT"

INTENT_FILE="$REQUEST_ROOT/$RUN_ID.intent"
case "$INTENT_FILE" in
  "$REQUEST_ROOT"/[1-9][0-9]*.intent|"$REQUEST_ROOT"/[1-9][0-9]*-[1-9][0-9]*.intent)
    bounded_recovery_command 10 rm -f -- "$INTENT_FILE"
    ;;
  *) echo '[engine-release-recover] FATAL: refusing unsafe release-intent cleanup' >&2; exit 1 ;;
esac
fsync_directory "$REQUEST_ROOT"

case "$REQUEST_FILE" in
  "$REQUEST_ROOT"/[1-9][0-9]*.request|"$REQUEST_ROOT"/[1-9][0-9]*-[1-9][0-9]*.request)
    bounded_recovery_command 10 rm -f -- "$REQUEST_FILE"
    ;;
  *) echo '[engine-release-recover] FATAL: refusing unsafe request cleanup' >&2; exit 1 ;;
esac
fsync_directory "$REQUEST_ROOT"

# This exact per-attempt unit remains enabled until pin, intent, request, and
# lease are durably gone. A crash before request deletion replays the same
# request; a crash after it produces one empty invocation that self-disables.
UNIT="club-arena-engine-release-v1@$RUN_ID.service"
bounded_recovery_command 15 systemctl disable "$UNIT" >/dev/null
bounded_recovery_command 10 systemctl is-enabled "$UNIT" >/dev/null 2>&1 \
  && { echo '[engine-release-recover] FATAL: completed release unit is still enabled' >&2; exit 1; }
fsync_directory /etc/systemd/system/multi-user.target.wants

# A failed build may have left an unsealed exact-SHA tag. Once this run's
# lease and boot edge are durably gone, collect only unleased engine tags under
# a separate build lock. Retention is non-authoritative and cannot delay the
# transaction's crash-closed retirement.
if RETENTION_BUDGET="$(recovery_remaining)" && [ "$RETENTION_BUDGET" -gt 5 ]; then
  [ "$RETENTION_BUDGET" -le 45 ] || RETENTION_BUDGET=45
  bounded_recovery_command "$RETENTION_BUDGET" env \
    ENGINE_IMAGE_RETENTION_MAX_SECONDS=$((RETENTION_BUDGET - 2)) \
    ENGINE_CONTROL_DIR="$CONTROL_DIR" CONTAINER="$CONTAINER" \
    "$CONTROL_DIR/retain-engine-images.sh" \
    || echo '[engine-release-recover] WARN: bounded post-recovery image retention failed' >&2
else
  echo '[engine-release-recover] WARN: recovery deadline left no budget for non-authoritative image retention' >&2
fi

echo '[engine-release-recover] terminal release state retired durably'
