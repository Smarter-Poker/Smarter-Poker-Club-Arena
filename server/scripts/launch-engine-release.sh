#!/usr/bin/env bash
# Validate and durably hand one release request to its systemd transaction.
set -euo pipefail

CONTROL_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REQUEST_ROOT="${ENGINE_RELEASE_REQUEST_ROOT:-/var/lib/club-arena/engine-release-requests}"
GENERATION_ROOT="${ENGINE_CONTROL_GENERATION_ROOT:-$(dirname "$CONTROL_DIR")}"
WANTS_DIR="/etc/systemd/system/multi-user.target.wants"

die() {
  echo "[launch-engine-release] FATAL: $*" >&2
  exit 1
}

[ "$(id -u)" = 0 ] || die 'must run as root'
[ "$#" = 8 ] || die 'usage: launch-engine-release.sh --sha SHA --run-id RUN_ID-RUN_ATTEMPT --actor ACTOR --not-after-epoch EPOCH'
[ "$1" = --sha ] && [ "$3" = --run-id ] && [ "$5" = --actor ] \
  && [ "$7" = --not-after-epoch ] || die 'invalid argument order'
SHA="$2"
RUN_ID="$4"
ACTOR="$6"
NOT_AFTER_EPOCH="$8"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die 'SHA must be one lowercase 40-hex commit'
[[ "$RUN_ID" =~ ^[1-9][0-9]*(-[1-9][0-9]*)?$ ]] || die 'run key is invalid'
[[ "$NOT_AFTER_EPOCH" =~ ^[1-9][0-9]*$ ]] && [ "${#NOT_AFTER_EPOCH}" -le 10 ] \
  || die 'release not-after epoch is invalid'
python3 - "$ACTOR" <<'PY' || die 'actor is invalid'
import sys
actor = sys.argv[1]
valid = bool(actor) and len(actor) <= 128 and all(ord(char) >= 32 and ord(char) != 127 for char in actor)
raise SystemExit(0 if valid else 1)
PY
GITHUB_RUN_ID="${RUN_ID%%-*}"
RUN_URL="https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/$GITHUB_RUN_ID"
CONTROL_SHA="$(tr -d '\r\n' < "$CONTROL_DIR/control-sha")" \
  || die 'active control generation has no SHA manifest'
[[ "$CONTROL_SHA" =~ ^[0-9a-f]{40}$ ]] || die 'active control generation SHA is invalid'
CANONICAL_GENERATION="$(readlink -e -- "$CONTROL_DIR")" \
  || die 'active control generation is unavailable'
CANONICAL_ROOT="$(readlink -e -- "$GENERATION_ROOT")" \
  || die 'control generation root is unavailable'
[ "$CANONICAL_GENERATION" = "$CONTROL_DIR" ] || die 'launcher did not resolve to an immutable generation'
case "$CANONICAL_GENERATION/" in
  "$CANONICAL_ROOT"/*/) ;;
  *) die 'active control generation escaped the managed generation root' ;;
esac

install -d -m 0700 "$REQUEST_ROOT"
python3 - "$REQUEST_ROOT" "$(dirname "$REQUEST_ROOT")" <<'PY'
import os
import sys
for value in sys.argv[1:]:
    fd = os.open(value, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
PY
REQUEST_FILE="$REQUEST_ROOT/$RUN_ID.request"
INTENT_FILE="$REQUEST_ROOT/$RUN_ID.intent"
TMP_FILE="$REQUEST_ROOT/.$RUN_ID.request.$$"
case "$REQUEST_FILE" in "$REQUEST_ROOT/$RUN_ID.request") ;; *) die 'unsafe request path' ;; esac
case "$INTENT_FILE" in "$REQUEST_ROOT/$RUN_ID.intent") ;; *) die 'unsafe intent path' ;; esac

# A workflow response can be lost after the exact run already wrote its
# durable result and terminal cleanup removed its request. Do not manufacture
# a second request bound to a newer compatible control generation. The result
# attestation also proves that this SHA is still the sealed desired runtime;
# the observer will independently re-prove its live process and public path.
if FAILURE_ATTESTATION="$("$CONTROL_DIR/engine-release-seal.py" attest-failure \
  --sha "$SHA" --run-id "$RUN_ID" 2>/dev/null)"; then
  read -r FAILURE_RESULT FAILURE_SHA FAILURE_CONTROL FAILURE_INVOCATION \
    FAILURE_STATUS FAILURE_RECOVERED_SHA FAILURE_RECOVERED_IMAGE EXTRA \
    <<< "$FAILURE_ATTESTATION"
  [ "$FAILURE_RESULT" = failed ] && [ "$FAILURE_SHA" = "$SHA" ] \
    && [[ "$FAILURE_CONTROL" =~ ^[0-9a-f]{40}$ ]] \
    && [[ "$FAILURE_INVOCATION" =~ ^[0-9a-f]{32}$ ]] \
    && [[ "$FAILURE_STATUS" =~ ^[1-9][0-9]*$ ]] \
    && [[ "$FAILURE_RECOVERED_SHA" =~ ^[0-9a-f]{40}$ ]] \
    && [[ "$FAILURE_RECOVERED_IMAGE" =~ ^sha256:[0-9a-f]{64}$ ]] \
    && [ -z "${EXTRA:-}" ] \
    || die 'durable failure attestation is malformed'
  # The durable intake uses the launcher only as a handoff boundary. Return a
  # completed handoff there so it can retire its own request/path/unit edges;
  # the independent observer consumes ENGINE_RELEASE_RESULT and the tombstone
  # and fails the workflow. A direct launcher caller receives a nonzero status.
  if [ "${ENGINE_RELEASE_DISPATCH_ONLY:-0}" = 1 ]; then
    echo 'ENGINE_RELEASE_HANDOFF=completed'
  else
    echo 'ENGINE_RELEASE_HANDOFF=failed'
  fi
  echo "ENGINE_RELEASE_SHA=$SHA"
  echo 'ENGINE_RELEASE_RESULT=failed'
  echo "[launch-engine-release] terminal failure already recorded for run $RUN_ID; refusing replay" >&2
  [ "${ENGINE_RELEASE_DISPATCH_ONLY:-0}" = 1 ] && exit 0
  exit 1
fi
if "$CONTROL_DIR/engine-release-seal.py" attest-result \
  --sha "$SHA" --run-id "$RUN_ID" >/dev/null 2>&1; then
  echo 'ENGINE_RELEASE_HANDOFF=completed'
  echo "ENGINE_RELEASE_SHA=$SHA"
  exit 0
fi

umask 077
trap 'rm -f -- "${TMP_FILE:-}"' EXIT
trap 'exit 75' HUP INT TERM
printf '%s\n%s\n%s\n%s\n%s\n%s\n' \
  "$SHA" "$RUN_URL" "$ACTOR" "$CANONICAL_GENERATION" "$CONTROL_SHA" \
  "$NOT_AFTER_EPOCH" > "$TMP_FILE"
python3 - "$TMP_FILE" "$REQUEST_ROOT" <<'PY'
import os
import sys
for value in sys.argv[1:]:
    fd = os.open(value, os.O_RDONLY | (getattr(os, "O_DIRECTORY", 0) if os.path.isdir(value) else 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
PY
# A run key is an immutable identity. Every retry must prove every field is
# identical; neither the pre-dispatch intent nor the actionable request may be
# rebound to another SHA, actor, or control generation.
verify_existing_record() {
  local existing_file="$1" record_name="$2"
  [ -f "$existing_file" ] && [ ! -L "$existing_file" ] \
    || die "existing release $record_name is not a regular file"
  [ "$(stat -c '%u:%a' "$existing_file")" = '0:600' ] \
    || die "existing release $record_name ownership or mode is invalid"
  mapfile -t EXISTING_LINES < "$existing_file" || die "existing release $record_name is unreadable"
  mapfile -t CANDIDATE_LINES < "$TMP_FILE" || die 'candidate release request is unreadable'
  [ "${#EXISTING_LINES[@]}" = 6 ] && [ "${#CANDIDATE_LINES[@]}" = 6 ] \
    || die "existing release $record_name has an invalid field count"
  for index in 0 1 2 3 4 5; do
    [ "${EXISTING_LINES[$index]}" = "${CANDIDATE_LINES[$index]}" ] \
      || die "this run key is already bound to a different release $record_name"
  done
}
if [ -e "$REQUEST_FILE" ] || [ -L "$REQUEST_FILE" ]; then
  verify_existing_record "$REQUEST_FILE" request
fi
if [ -e "$INTENT_FILE" ] || [ -L "$INTENT_FILE" ]; then
  verify_existing_record "$INTENT_FILE" intent
else
  ln -- "$TMP_FILE" "$INTENT_FILE"
  python3 - "$REQUEST_ROOT" <<'PY'
import os
import sys
fd = os.open(sys.argv[1], os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try:
    os.fsync(fd)
finally:
    os.close(fd)
PY
fi

# Enable and submit the exact host-owned job while only its immutable intent is
# public. Missing request + present intent is the frozen transient state, so
# systemd owns a retry before the actionable request can become visible.
UNIT="club-arena-engine-release-v1@$RUN_ID.service"
systemctl reset-failed "$UNIT" >/dev/null 2>&1 || true
systemctl enable "$UNIT" >/dev/null
systemctl is-enabled "$UNIT" | grep -qx enabled
python3 - "$WANTS_DIR" <<'PY'
import os
import sys
fd = os.open(sys.argv[1], os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try:
    os.fsync(fd)
finally:
    os.close(fd)
PY
systemctl start --no-block "$UNIT"

# The host-owned wrapper is the sole intent-to-request publisher. This caller
# cannot wake late and recreate a request after terminal recovery removed it.
rm -f -- "$TMP_FILE"
python3 - "$REQUEST_ROOT" <<'PY'
import os
import sys
fd = os.open(sys.argv[1], os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try:
    os.fsync(fd)
finally:
    os.close(fd)
PY
trap - EXIT HUP INT TERM

if [ "${ENGINE_RELEASE_DISPATCH_ONLY:-0}" = 1 ]; then
  echo 'ENGINE_RELEASE_HANDOFF=durable'
  echo "ENGINE_RELEASE_SHA=$SHA"
  exit 0
fi
exec "$CONTROL_DIR/observe-engine-release.sh" --sha "$SHA" --run-id "$RUN_ID"
