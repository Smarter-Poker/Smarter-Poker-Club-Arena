#!/usr/bin/env bash
# Bind one engine drill to one release run key, then hand that run key to the
# unchanged durable intake.
#
# .github/workflows/engine-drill.yml runs this from the exact per-run control
# stage, after proving the stage bytes equal the control commit. It writes ONE
# root-only record, $REQUEST_ROOT/$RUN_ID.drill, beside the release request the
# intake will create. engine-release-transaction.sh reads that record: a run
# key without one is an ordinary release. Every existing record format, frozen
# systemd template and validator is untouched, so a drill cannot change what an
# ordinary release does. See docs/runbooks/maintenance-break-fire-drill.md.
set -euo pipefail

REQUEST_ROOT="${ENGINE_RELEASE_REQUEST_ROOT:-/var/lib/club-arena/engine-release-requests}"
STAGING_ROOT="${ENGINE_CONTROL_STAGING_ROOT:-/var/lib/club-arena/control-staging}"
REPO_DIR="${REPO_DIR:-/opt/club-arena}"

die() {
  echo "[install-engine-drill] FATAL: $*" >&2
  exit 1
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
[ "$#" = 14 ] \
  || die 'usage: install-engine-drill.sh --mode MODE --target-sha SHA --control-sha SHA --run-id RUN --actor ACTOR --reason-b64 REASON --not-after-epoch EPOCH'
[ "$1" = --mode ] && [ "$3" = --target-sha ] && [ "$5" = --control-sha ] \
  && [ "$7" = --run-id ] && [ "$9" = --actor ] && [ "${11}" = --reason-b64 ] \
  && [ "${13}" = --not-after-epoch ] || die 'invalid argument order'
MODE="$2"
TARGET_SHA="$4"
CONTROL_SHA="$6"
RUN_ID="$8"
ACTOR="${10}"
REASON_B64="${12}"
NOT_AFTER_EPOCH="${14}"
case "$MODE" in
  crash|rollback|rollforward) ;;
  *) die 'drill mode must be crash, rollback or rollforward' ;;
esac
[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || die 'target SHA is invalid'
[[ "$CONTROL_SHA" =~ ^[0-9a-f]{40}$ ]] || die 'control SHA is invalid'
[[ "$RUN_ID" =~ ^[1-9][0-9]*-[1-9][0-9]*$ ]] || die 'run key is invalid'
[[ "$NOT_AFTER_EPOCH" =~ ^[1-9][0-9]*$ ]] && [ "${#NOT_AFTER_EPOCH}" -le 10 ] \
  || die 'drill not-after epoch is invalid'
[[ "$REASON_B64" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || die 'drill reason encoding is invalid'
REASON="$(printf '%s' "$REASON_B64" | base64 -d 2>/dev/null)" || die 'drill reason is not valid base64'
python3 - "$REASON" <<'PY' || die 'drill reason must be 12 to 128 printable characters'
import sys
value = sys.argv[1]
raise SystemExit(0 if 12 <= len(value) <= 128 and all(ord(c) >= 32 and ord(c) != 127 for c in value) else 1)
PY

STAGE="$STAGING_ROOT/$RUN_ID"
case "$STAGE" in "$STAGING_ROOT/$RUN_ID") ;; *) die 'unsafe staging path' ;; esac
SCRIPT_PATH="$(readlink -e -- "${BASH_SOURCE[0]}" || true)"
[ "$SCRIPT_PATH" = "$STAGE/server/scripts/install-engine-drill.sh" ] \
  || die 'drill installer did not execute from the exact per-run stage'
for script in install-engine-drill.sh install-engine-intake.sh; do
  GIT_NO_REPLACE_OBJECTS=1 git -C "$REPO_DIR" show "$CONTROL_SHA:server/scripts/$script" \
    | cmp -s - "$STAGE/server/scripts/$script" \
    || die "staged $script bytes do not match the control commit"
done

install -d -m 0700 "$REQUEST_ROOT"
fsync_paths "$REQUEST_ROOT" "$(dirname "$REQUEST_ROOT")"
DRILL_FILE="$REQUEST_ROOT/$RUN_ID.drill"
case "$DRILL_FILE" in "$REQUEST_ROOT/$RUN_ID.drill") ;; *) die 'unsafe drill record path' ;; esac
# The record must exist before the release request does. A request already on
# disk for this run key without a drill record would mean the transaction may
# already be running as an ordinary release; binding a drill to it now could
# change a live run's meaning, so refuse.
if { [ -e "$REQUEST_ROOT/$RUN_ID.request" ] || [ -e "$REQUEST_ROOT/$RUN_ID.intent" ]; } \
  && [ ! -e "$DRILL_FILE" ]; then
  die 'this run key already has a release request and no drill record'
fi

TMP_FILE="$REQUEST_ROOT/.$RUN_ID.drill.$$"
trap 'rm -f -- "${TMP_FILE:-}"' EXIT
trap 'exit 76' HUP INT TERM
umask 077
printf '%s\n%s\n%s\n%s\n%s\n' \
  engine-drill-v1 "$MODE" "$TARGET_SHA" "$CONTROL_SHA" "$REASON" > "$TMP_FILE"
fsync_paths "$TMP_FILE"
if ! ln -- "$TMP_FILE" "$DRILL_FILE" 2>/dev/null; then
  [ -f "$DRILL_FILE" ] && [ ! -L "$DRILL_FILE" ] \
    || die 'existing drill record is not a regular file'
  [ "$(stat -c '%u:%a' "$DRILL_FILE")" = '0:600' ] \
    || die 'existing drill record ownership or mode is invalid'
  cmp -s "$TMP_FILE" "$DRILL_FILE" \
    || die 'this run key is already bound to a different drill'
fi
rm -f -- "$TMP_FILE"
TMP_FILE=''
fsync_paths "$REQUEST_ROOT"
trap - EXIT HUP INT TERM
echo "ENGINE_DRILL_BOUND=$MODE $TARGET_SHA $RUN_ID"

exec "$STAGE/server/scripts/install-engine-intake.sh" \
  --target-sha "$TARGET_SHA" --control-sha "$CONTROL_SHA" \
  --run-id "$RUN_ID" --actor "$ACTOR" \
  --not-after-epoch "$NOT_AFTER_EPOCH"
