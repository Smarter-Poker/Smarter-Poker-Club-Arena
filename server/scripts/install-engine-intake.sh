#!/usr/bin/env bash
# Atomically persist and dispatch the first root-owned host transaction.
set -euo pipefail

INTAKE_ROOT="${ENGINE_RELEASE_INTAKE_ROOT:-/var/lib/club-arena/engine-intake-requests}"
STAGING_ROOT="${ENGINE_CONTROL_STAGING_ROOT:-/var/lib/club-arena/control-staging}"
REPO_DIR="${REPO_DIR:-/opt/club-arena}"
WANTS_DIR="/etc/systemd/system/multi-user.target.wants"
UNIT_BASENAME="club-arena-engine-intake-v1@.service"
UNIT_PATH="/etc/systemd/system/$UNIT_BASENAME"
PATH_BASENAME="club-arena-engine-intake-v1@.path"
PATH_PATH="/etc/systemd/system/$PATH_BASENAME"

die() {
  echo "[install-engine-intake] FATAL: $*" >&2
  exit 1
}

retry() {
  echo "[install-engine-intake] RETRY: $*" >&2
  # The workflow treats 76 as an uncertain-but-idempotent host handoff and
  # immediately replays this exact run key before reattaching to the observer.
  exit 76
}

fsync_paths() {
  python3 - "$@" <<'PY'
import os, sys
for path in sys.argv[1:]:
    fd = os.open(path, os.O_RDONLY | (getattr(os, "O_DIRECTORY", 0) if os.path.isdir(path) else 0))
    try: os.fsync(fd)
    finally: os.close(fd)
PY
}

[ "$(id -u)" = 0 ] || die 'must run as root'
[ "$#" = 10 ] \
  || die 'usage: install-engine-intake.sh --target-sha SHA --control-sha SHA --run-id RUN --actor ACTOR --not-after-epoch EPOCH'
[ "$1" = --target-sha ] && [ "$3" = --control-sha ] \
  && [ "$5" = --run-id ] && [ "$7" = --actor ] \
  && [ "$9" = --not-after-epoch ] || die 'invalid argument order'
TARGET_SHA="$2"
CONTROL_SHA="$4"
RUN_ID="$6"
ACTOR="$8"
NOT_AFTER_EPOCH="${10}"
[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || die 'target SHA is invalid'
[[ "$CONTROL_SHA" =~ ^[0-9a-f]{40}$ ]] || die 'control SHA is invalid'
[[ "$RUN_ID" =~ ^[1-9][0-9]*-[1-9][0-9]*$ ]] || die 'run key is invalid'
[[ "$NOT_AFTER_EPOCH" =~ ^[1-9][0-9]*$ ]] && [ "${#NOT_AFTER_EPOCH}" -le 10 ] \
  || die 'release not-after epoch is invalid'
python3 - "$ACTOR" <<'PY' || die 'actor is invalid'
import sys
value = sys.argv[1]
raise SystemExit(0 if value and len(value) <= 128 and all(ord(c) >= 32 and ord(c) != 127 for c in value) else 1)
PY
RUN_URL="https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/${RUN_ID%%-*}"
STAGE="$STAGING_ROOT/$RUN_ID"
REQUEST_FILE="$INTAKE_ROOT/$RUN_ID.request"
INTENT_FILE="$INTAKE_ROOT/$RUN_ID.intent"
INTAKE_LOCK="/var/lock/club-arena-engine-intake-$RUN_ID.lock"
case "$STAGE" in "$STAGING_ROOT/$RUN_ID") ;; *) die 'unsafe staging path' ;; esac
case "$REQUEST_FILE" in "$INTAKE_ROOT/$RUN_ID.request") ;; *) die 'unsafe request path' ;; esac
case "$INTENT_FILE" in "$INTAKE_ROOT/$RUN_ID.intent") ;; *) die 'unsafe intent path' ;; esac
[[ "$INTAKE_LOCK" =~ ^/var/lock/club-arena-engine-intake-[1-9][0-9]*-[1-9][0-9]*\.lock$ ]] \
  || die 'unsafe intake lock path'
[ -x "$STAGE/server/scripts/engine-release-intake.sh" ] || die 'durable intake entrypoint is missing'
SCRIPT_PATH="$(readlink -e -- "${BASH_SOURCE[0]}" || true)"
[ "$SCRIPT_PATH" = "$STAGE/server/scripts/install-engine-intake.sh" ] \
  || die 'intake installer did not execute from the exact per-run stage'
GIT_NO_REPLACE_OBJECTS=1 git -C "$REPO_DIR" show \
  "$CONTROL_SHA:server/scripts/install-engine-intake.sh" \
  | cmp -s - "$SCRIPT_PATH" \
  || die 'intake installer bytes do not match the control commit'

TMP_REQUEST=''
NEXT_UNIT=''
NEXT_PATH=''
UNIT_STAGE_DIR=''
cleanup() {
  rm -f -- "${TMP_REQUEST:-}" "${NEXT_UNIT:-}" "${NEXT_PATH:-}"
  if [ -n "${UNIT_STAGE_DIR:-}" ]; then
    case "$UNIT_STAGE_DIR" in
      /run/club-arena-engine-intake-unit.*) rm -rf -- "$UNIT_STAGE_DIR" ;;
      *) echo '[install-engine-intake] refusing unsafe unit-stage cleanup' >&2 ;;
    esac
  fi
}
trap cleanup EXIT
trap 'exit 76' HUP INT TERM

UNIT_STAGE_DIR="$(mktemp -d /run/club-arena-engine-intake-unit.XXXXXXXX)"
UNIT_STAGE="$UNIT_STAGE_DIR/$UNIT_BASENAME"
PATH_STAGE="$UNIT_STAGE_DIR/$PATH_BASENAME"
cat > "$UNIT_STAGE" <<'UNIT'
[Unit]
Description=Club Arena Engine Durable Intake v1 %i
After=docker.service network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=oneshot
ExecStart=/var/lib/club-arena/control-staging/%i/server/scripts/engine-release-intake.sh --run-id %i
TimeoutStartSec=20min
Restart=on-failure
# Exit 75 is already a failure, so Restart=on-failure retries it naturally.
# RestartForceExitStatus is invalid for Type=oneshot on production systemd.
RestartPreventExitStatus=1
RestartSec=60s
KillMode=control-group
NoNewPrivileges=false
PrivateTmp=true
ProtectHome=tmpfs
BindReadOnlyPaths=/root/.ssh
ProtectSystem=full
ReadWritePaths=/var/lib/club-arena /var/lock /usr/local/lib/club-arena /etc/systemd/system /run

[Install]
WantedBy=multi-user.target
UNIT
cat > "$PATH_STAGE" <<'UNIT'
[Unit]
Description=Club Arena Engine Durable Intake Event v1 %i
Before=club-arena-engine-intake-v1@%i.service

[Path]
PathExists=/var/lib/club-arena/engine-intake-requests/%i.intent
Unit=club-arena-engine-intake-v1@%i.service

[Install]
WantedBy=multi-user.target
UNIT
# `systemd-analyze verify` substitutes the synthetic instance `i` for a bare
# template, which would point ExecStart at a staging directory that cannot
# exist. Verify copies named for this real staged run so %i resolves to the
# executable already authenticated above; install the canonical templates.
VERIFY_UNIT_STAGE="$UNIT_STAGE_DIR/club-arena-engine-intake-v1@$RUN_ID.service"
VERIFY_PATH_STAGE="$UNIT_STAGE_DIR/club-arena-engine-intake-v1@$RUN_ID.path"
install -m 0644 "$UNIT_STAGE" "$VERIFY_UNIT_STAGE"
install -m 0644 "$PATH_STAGE" "$VERIFY_PATH_STAGE"
systemd-analyze verify "$VERIFY_UNIT_STAGE" "$VERIFY_PATH_STAGE"
rm -f -- "$VERIFY_UNIT_STAGE" "$VERIFY_PATH_STAGE"
fsync_paths "$UNIT_STAGE" "$PATH_STAGE"
NEXT_UNIT="/etc/systemd/system/.$UNIT_BASENAME.next.$$"
install -m 0644 "$UNIT_STAGE" "$NEXT_UNIT"
fsync_paths "$NEXT_UNIT"
if ! ln -- "$NEXT_UNIT" "$UNIT_PATH" 2>/dev/null; then
  [ -f "$UNIT_PATH" ] && [ ! -L "$UNIT_PATH" ] \
    || die 'frozen intake v1 unit is not a regular file'
  [ "$(stat -c '%u:%a' "$UNIT_PATH")" = '0:644' ] \
    || die 'frozen intake v1 unit ownership or mode is invalid'
  cmp -s "$NEXT_UNIT" "$UNIT_PATH" \
    || die 'frozen intake v1 unit differs; install a new protocol version instead'
fi
rm -f -- "$NEXT_UNIT"
NEXT_UNIT=''
NEXT_PATH="/etc/systemd/system/.$PATH_BASENAME.next.$$"
install -m 0644 "$PATH_STAGE" "$NEXT_PATH"
fsync_paths "$NEXT_PATH"
if ! ln -- "$NEXT_PATH" "$PATH_PATH" 2>/dev/null; then
  [ -f "$PATH_PATH" ] && [ ! -L "$PATH_PATH" ] \
    || die 'frozen intake v1 path unit is not a regular file'
  [ "$(stat -c '%u:%a' "$PATH_PATH")" = '0:644' ] \
    || die 'frozen intake v1 path unit ownership or mode is invalid'
  cmp -s "$NEXT_PATH" "$PATH_PATH" \
    || die 'frozen intake v1 path unit differs; install a new protocol version instead'
fi
rm -f -- "$NEXT_PATH"
NEXT_PATH=''
fsync_paths /etc/systemd/system
systemctl daemon-reload || retry 'systemd daemon-reload failed'

install -d -m 0700 "$INTAKE_ROOT"
fsync_paths "$INTAKE_ROOT" "$(dirname "$INTAKE_ROOT")"
exec 7>"$INTAKE_LOCK"
flock -w 30 7 || retry 'another exact intake invocation still owns this run key'
TMP_REQUEST="$INTAKE_ROOT/.$RUN_ID.request.$$"
umask 077
printf '%s\n%s\n%s\n%s\n%s\n' \
  "$TARGET_SHA" "$CONTROL_SHA" "$RUN_URL" "$ACTOR" "$NOT_AFTER_EPOCH" > "$TMP_REQUEST"
fsync_paths "$TMP_REQUEST" "$INTAKE_ROOT"
verify_existing_record() {
  local existing_file="$1" record_name="$2"
  [ -f "$existing_file" ] && [ ! -L "$existing_file" ] \
    || die "existing intake $record_name is not a regular file"
  [ "$(stat -c '%u:%a' "$existing_file")" = '0:600' ] \
    || die "existing intake $record_name ownership or mode is invalid"
  mapfile -t EXISTING < "$existing_file" || die "existing intake $record_name is unreadable"
  mapfile -t CANDIDATE < "$TMP_REQUEST" || die 'candidate intake request is unreadable'
  [ "${#EXISTING[@]}" = 5 ] && [ "${#CANDIDATE[@]}" = 5 ] \
    || die "existing intake $record_name has an invalid field count"
  for index in 0 1 2 3 4; do
    [ "${EXISTING[$index]}" = "${CANDIDATE[$index]}" ] \
      || die "this run key is already bound to another intake $record_name"
  done
}
DURABLE_STATE_EXISTS=0
if [ -e "$REQUEST_FILE" ] || [ -L "$REQUEST_FILE" ]; then
  verify_existing_record "$REQUEST_FILE" request
  DURABLE_STATE_EXISTS=1
fi
UNIT="club-arena-engine-intake-v1@$RUN_ID.service"
PATH_UNIT="club-arena-engine-intake-v1@$RUN_ID.path"
if [ -e "$INTENT_FILE" ] || [ -L "$INTENT_FILE" ]; then
  verify_existing_record "$INTENT_FILE" intent
  DURABLE_STATE_EXISTS=1
fi
if [ "$DURABLE_STATE_EXISTS" = 1 ]; then
  # An accepted immutable intent/request belongs exclusively to the enabled
  # host service. A transport retry verifies and reattaches; it must not reset,
  # re-enable, or retrigger a transaction the child is already retiring.
  systemctl is-enabled "$UNIT" | grep -qx enabled \
    || retry 'durable intake state exists without its enabled host owner'
  rm -f -- "$TMP_REQUEST"
  TMP_REQUEST=''
  cleanup
  UNIT_STAGE_DIR=''
  trap - EXIT HUP INT TERM
  echo 'ENGINE_RELEASE_INTAKE=durable'
  echo "ENGINE_RELEASE_SHA=$TARGET_SHA"
  exit 0
fi
systemctl reset-failed "$UNIT" "$PATH_UNIT" >/dev/null 2>&1 || true
systemctl enable "$UNIT" "$PATH_UNIT" >/dev/null \
  || retry 'could not durably enable intake service and event units'
systemctl is-enabled "$UNIT" | grep -qx enabled \
  || retry 'intake service unit is not durably enabled'
systemctl is-enabled "$PATH_UNIT" | grep -qx enabled \
  || retry 'intake event unit is not durably enabled'
fsync_paths "$WANTS_DIR"
systemctl start "$PATH_UNIT" || retry 'could not arm the intake event unit'
systemctl is-active "$PATH_UNIT" | grep -qx active \
  || retry 'intake event unit is not actively armed'

# The boot edge is the ownership boundary. Publish the complete immutable
# intent only after that edge is enabled, verified, and fsynced. Before the
# intent exists the workflow still owns the handoff; after its fsync, either
# this process, the queued unit, or the next boot can finish the exact request.
ln -- "$TMP_REQUEST" "$INTENT_FILE"
fsync_paths "$INTAKE_ROOT"

# Queue the host-owned job while only the immutable intent is visible. The
# frozen unit treats intent-without-request as transient, so systemd already
# owns a retry before the actionable request can become visible. This removes
# the SSH/runner-loss gap between request publication and job submission.
systemctl start --no-block "$UNIT" || retry 'could not submit intake unit to systemd'

# The systemd child is the sole intent-to-request publisher. A delayed caller
# must never recreate a request after the child has completed and retired it.
rm -f -- "$TMP_REQUEST"
TMP_REQUEST=''
fsync_paths "$INTAKE_ROOT"

cleanup
UNIT_STAGE_DIR=''
trap - EXIT HUP INT TERM
echo 'ENGINE_RELEASE_INTAKE=durable'
echo "ENGINE_RELEASE_SHA=$TARGET_SHA"
