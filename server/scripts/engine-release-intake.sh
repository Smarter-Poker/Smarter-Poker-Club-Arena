#!/usr/bin/env bash
# Durable first host mutation for one Club Arena engine release.
#
# The workflow fsyncs an exact request and enables this per-run unit before it
# starts. From that point systemd owns control-generation installation and the
# handoff to the separately enabled release transaction; SSH and runner loss
# cannot strand a half-installed control plane.
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/club-arena}"
INTAKE_ROOT="${ENGINE_RELEASE_INTAKE_ROOT:-/var/lib/club-arena/engine-intake-requests}"
STAGING_ROOT="${ENGINE_CONTROL_STAGING_ROOT:-/var/lib/club-arena/control-staging}"
WANTS_DIR="/etc/systemd/system/multi-user.target.wants"

die() {
  echo "[engine-release-intake] FATAL: $*" >&2
  exit 1
}

retry() {
  echo "[engine-release-intake] RETRY: $*" >&2
  exit 75
}

fsync_directory() {
  python3 - "$1" <<'PY'
import os, sys
fd = os.open(sys.argv[1], os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try: os.fsync(fd)
finally: os.close(fd)
PY
}

[ "$(id -u)" = 0 ] || die 'must run as root'
[ "$#" = 2 ] && [ "$1" = --run-id ] \
  || die 'usage: engine-release-intake.sh --run-id RUN_ID-RUN_ATTEMPT'
RUN_ID="$2"
[[ "$RUN_ID" =~ ^[1-9][0-9]*-[1-9][0-9]*$ ]] || die 'run key is invalid'
GITHUB_RUN_ID="${RUN_ID%%-*}"
REQUEST_FILE="$INTAKE_ROOT/$RUN_ID.request"
INTENT_FILE="$INTAKE_ROOT/$RUN_ID.intent"
STAGE="$STAGING_ROOT/$RUN_ID"
INTAKE_LOCK="/var/lock/club-arena-engine-intake-$RUN_ID.lock"
case "$REQUEST_FILE" in "$INTAKE_ROOT/$RUN_ID.request") ;; *) die 'unsafe intake request path' ;; esac
case "$INTENT_FILE" in "$INTAKE_ROOT/$RUN_ID.intent") ;; *) die 'unsafe intake intent path' ;; esac
case "$STAGE" in "$STAGING_ROOT/$RUN_ID") ;; *) die 'unsafe control staging path' ;; esac
[[ "$INTAKE_LOCK" =~ ^/var/lock/club-arena-engine-intake-[1-9][0-9]*-[1-9][0-9]*\.lock$ ]] \
  || die 'unsafe intake lock path'
exec 7>"$INTAKE_LOCK"
flock -w 30 7 || retry 'another exact intake invocation still owns this run key'

if [ ! -e "$REQUEST_FILE" ]; then
  if [ -e "$INTENT_FILE" ]; then
    [ -f "$INTENT_FILE" ] && [ ! -L "$INTENT_FILE" ] \
      || die 'durable intake intent is not a regular file'
    [ "$(stat -c '%u:%a' "$INTENT_FILE")" = '0:600' ] \
      || die 'durable intake intent ownership or mode is invalid'
    # The caller deliberately queues this systemd unit before request
    # publication. The host-owned unit can therefore complete that last
    # transition from the full immutable intent by itself after SSH, runner,
    # process, or host failure.
    if ! ln -- "$INTENT_FILE" "$REQUEST_FILE" 2>/dev/null; then
      if [ ! -f "$REQUEST_FILE" ] \
        || [ -L "$REQUEST_FILE" ] \
        || ! cmp -s "$INTENT_FILE" "$REQUEST_FILE"; then
        die 'concurrent intake request differs from its durable intent'
      fi
    fi
    fsync_directory "$INTAKE_ROOT"
  else
    # Terminal cleanup removes intent, then request, then the boot edge. A
    # power loss after both records are gone may leave one final boot
    # invocation; retire that inert edge without manufacturing a retry.
    INTAKE_UNIT="club-arena-engine-intake-v1@$RUN_ID.service"
    INTAKE_PATH_UNIT="club-arena-engine-intake-v1@$RUN_ID.path"
    systemctl disable "$INTAKE_PATH_UNIT" >/dev/null
    systemctl is-enabled "$INTAKE_PATH_UNIT" >/dev/null 2>&1 \
      && die 'empty intake event unit could not retire its boot edge'
    systemctl stop "$INTAKE_PATH_UNIT" >/dev/null
    systemctl disable "$INTAKE_UNIT" >/dev/null
    systemctl is-enabled "$INTAKE_UNIT" >/dev/null 2>&1 \
      && die 'empty intake unit could not retire its boot edge'
    fsync_directory "$WANTS_DIR"
    exit 0
  fi
fi

# PathExists is only the same-boot acceptance edge. Once this service has a
# durable request, retire that edge before parsing or installing anything.
# The still-enabled service plus its request now own reboot/transient retry;
# a permanent exit 1 therefore cannot be hot-retriggered by a true path.
INTAKE_PATH_UNIT="club-arena-engine-intake-v1@$RUN_ID.path"
systemctl disable "$INTAKE_PATH_UNIT" >/dev/null \
  || retry 'claimed intake could not disable its event boot edge'
systemctl is-enabled "$INTAKE_PATH_UNIT" >/dev/null 2>&1 \
  && retry 'claimed intake event unit is still enabled'
systemctl stop "$INTAKE_PATH_UNIT" >/dev/null \
  || retry 'claimed intake could not stop its event unit'
fsync_directory "$WANTS_DIR"

[ -f "$REQUEST_FILE" ] && [ ! -L "$REQUEST_FILE" ] \
  || die 'durable intake request is not a regular file'
[ "$(stat -c '%u:%a' "$REQUEST_FILE")" = '0:600' ] \
  || die 'durable intake request ownership or mode is invalid'
mapfile -t REQUEST_LINES < "$REQUEST_FILE" || die 'durable intake request is unreadable'
[ "${#REQUEST_LINES[@]}" = 5 ] || die 'durable intake request has an invalid field count'
if [ -e "$INTENT_FILE" ]; then
  [ -f "$INTENT_FILE" ] && [ ! -L "$INTENT_FILE" ] \
    || die 'durable intake intent is not a regular file'
  [ "$(stat -c '%u:%a' "$INTENT_FILE")" = '0:600' ] \
    || die 'durable intake intent ownership or mode is invalid'
  cmp -s "$INTENT_FILE" "$REQUEST_FILE" \
    || die 'durable intake request differs from its dispatch intent'
fi
TARGET_SHA="${REQUEST_LINES[0]}"
CONTROL_SHA="${REQUEST_LINES[1]}"
RUN_URL="${REQUEST_LINES[2]}"
ACTOR="${REQUEST_LINES[3]}"
NOT_AFTER_EPOCH="${REQUEST_LINES[4]}"
[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || die 'target SHA is invalid'
[[ "$CONTROL_SHA" =~ ^[0-9a-f]{40}$ ]] || die 'control SHA is invalid'
[ "$RUN_URL" = "https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/$GITHUB_RUN_ID" ] \
  || die 'run URL does not identify this Club Arena run'
python3 - "$ACTOR" <<'PY' || die 'actor is invalid'
import sys
value = sys.argv[1]
raise SystemExit(0 if value and len(value) <= 128 and all(ord(c) >= 32 and ord(c) != 127 for c in value) else 1)
PY
[[ "$NOT_AFTER_EPOCH" =~ ^[1-9][0-9]*$ ]] && [ "${#NOT_AFTER_EPOCH}" -le 10 ] \
  || die 'release not-after epoch is invalid'
[ -x "$STAGE/server/scripts/install-engine-supervisor.sh" ] \
  || die 'staged control installer is missing'

# Bind the entrypoint itself to the requested protected-main control commit.
# The installer independently archives every generation byte from Git objects.
GIT_NO_REPLACE_OBJECTS=1 git -C "$REPO_DIR" cat-file -e "$CONTROL_SHA^{commit}"
GIT_NO_REPLACE_OBJECTS=1 git -C "$REPO_DIR" show \
  "$CONTROL_SHA:server/scripts/engine-release-intake.sh" \
  | cmp -s - "$STAGE/server/scripts/engine-release-intake.sh" \
  || die 'staged intake bytes do not match the control commit'
GIT_NO_REPLACE_OBJECTS=1 git -C "$REPO_DIR" show \
  "$CONTROL_SHA:server/scripts/install-engine-supervisor.sh" \
  | cmp -s - "$STAGE/server/scripts/install-engine-supervisor.sh" \
  || die 'staged installer bytes do not match the control commit'

set +e
INSTALL_OUTPUT="$(ENGINE_CONTROL_SHA="$CONTROL_SHA" \
ENGINE_RELEASE_RUN_ID="$RUN_ID" \
ENGINE_RELEASE_RUN_URL="$RUN_URL" \
ENGINE_RELEASE_ACTOR="$ACTOR" \
  "$STAGE/server/scripts/install-engine-supervisor.sh")"
INSTALL_RC=$?
set -e
[ "$INSTALL_RC" -eq 75 ] \
  && retry 'control-generation installation encountered a transient host dependency'
[ "$INSTALL_RC" -eq 0 ] \
  || die "control-generation installation failed permanently (status $INSTALL_RC)"
printf '%s\n' "$INSTALL_OUTPUT"
INSTALLED_SHA="$(printf '%s\n' "$INSTALL_OUTPUT" | sed -n 's/^ENGINE_CONTROL_INSTALL_SHA=//p')"
INSTALLED_GENERATION="$(printf '%s\n' "$INSTALL_OUTPUT" | sed -n 's/^ENGINE_CONTROL_INSTALL_GENERATION=//p')"
[[ "$INSTALLED_SHA" =~ ^[0-9a-f]{40}$ ]] || die 'installer emitted no unique authoritative control SHA'
[ "$INSTALLED_SHA" = "$CONTROL_SHA" ] \
  || die 'intake control SHA was superseded; this immutable request cannot adopt newer control bytes'
[ "$(printf '%s\n' "$INSTALL_OUTPUT" | grep -c '^ENGINE_CONTROL_INSTALL_SHA=')" = 1 ] \
  || die 'installer emitted an ambiguous authoritative control SHA'
[ "$(printf '%s\n' "$INSTALL_OUTPUT" | grep -c '^ENGINE_CONTROL_INSTALL_GENERATION=')" = 1 ] \
  || die 'installer emitted an ambiguous authoritative generation'
CANONICAL_GENERATION="$(readlink -e -- "$INSTALLED_GENERATION")" \
  || die 'installed authoritative control generation is unavailable'
[ "$CANONICAL_GENERATION" = "$INSTALLED_GENERATION" ] \
  || die 'installer returned a noncanonical control generation'
[ "$(tr -d '\r\n' < "$CANONICAL_GENERATION/control-sha")" = "$INSTALLED_SHA" ] \
  || die 'installed generation manifest does not match installer result'

# The installed immutable generation creates an immutable release request,
# enables its exact unit, fsyncs the boot relationship, and submits the job.
set +e
LAUNCH_OUTPUT="$(ENGINE_RELEASE_DISPATCH_ONLY=1 \
  "$CANONICAL_GENERATION/launch-engine-release.sh" \
  --sha "$TARGET_SHA" --run-id "$RUN_ID" --actor "$ACTOR" \
  --not-after-epoch "$NOT_AFTER_EPOCH")"
LAUNCH_RC=$?
set -e
[ "$LAUNCH_RC" -eq 0 ] \
  || retry "durable release-unit handoff did not complete (status $LAUNCH_RC)"
printf '%s\n' "$LAUNCH_OUTPUT"
HANDOFF="$(printf '%s\n' "$LAUNCH_OUTPUT" | sed -n 's/^ENGINE_RELEASE_HANDOFF=//p')"
[ "$(printf '%s\n' "$LAUNCH_OUTPUT" | grep -c '^ENGINE_RELEASE_HANDOFF=')" = 1 ] \
  || die 'release launcher emitted an ambiguous handoff result'
[ "$(printf '%s\n' "$LAUNCH_OUTPUT" | grep -c '^ENGINE_RELEASE_SHA=')" = 1 ] \
  || die 'release launcher emitted an ambiguous SHA result'
[ "$(printf '%s\n' "$LAUNCH_OUTPUT" | sed -n 's/^ENGINE_RELEASE_SHA=//p')" = "$TARGET_SHA" ] \
  || die 'release launcher result does not identify the intake target'

RELEASE_UNIT="club-arena-engine-release-v1@$RUN_ID.service"
case "$HANDOFF" in
  durable)
    systemctl is-enabled "$RELEASE_UNIT" | grep -qx enabled \
      || retry 'release unit was not durably enabled before intake handoff'
    ;;
  completed)
    # The exact fsynced result predates this intake replay. No new release unit
    # is required; the external observer still proves the live sealed runtime.
    ;;
  *) die 'release launcher emitted an invalid handoff result' ;;
esac

# Only the durable child may retire the intake. Intent goes first and request
# second while the unit remains enabled: a crash before request deletion
# replays the same idempotent handoff, while a crash after it leaves no durable
# work and the empty-unit branch above retires the last boot edge.
INTAKE_UNIT="club-arena-engine-intake-v1@$RUN_ID.service"
INTAKE_PATH_UNIT="club-arena-engine-intake-v1@$RUN_ID.path"
rm -f -- "$INTENT_FILE"
fsync_directory "$INTAKE_ROOT"
rm -f -- "$REQUEST_FILE"
fsync_directory "$INTAKE_ROOT"
systemctl disable "$INTAKE_PATH_UNIT" >/dev/null \
  || retry 'completed intake could not disable its event boot edge'
systemctl is-enabled "$INTAKE_PATH_UNIT" >/dev/null 2>&1 \
  && retry 'completed intake event unit is still enabled'
systemctl stop "$INTAKE_PATH_UNIT" >/dev/null \
  || retry 'completed intake could not stop its event unit'
systemctl disable "$INTAKE_UNIT" >/dev/null \
  || retry 'completed intake could not disable its service boot edge'
systemctl is-enabled "$INTAKE_UNIT" >/dev/null 2>&1 \
  && retry 'completed intake unit is still enabled'
fsync_directory "$WANTS_DIR"

echo "ENGINE_RELEASE_INTAKE_RESULT=$HANDOFF"
echo "ENGINE_RELEASE_SHA=$TARGET_SHA"
