#!/usr/bin/env bash
# Version-one stable systemd boundary for one crash-contained engine release.
# The immutable release request already binds the run key to one canonical
# control generation and commit. This wrapper durably pins that binding before
# ExecStart and makes ExecStopPost recover with those same bytes even if a newer
# control generation becomes active while this transaction builds or waits.
set -euo pipefail

WRAPPER_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
GENERATION_ROOT="${ENGINE_CONTROL_GENERATION_ROOT:-$WRAPPER_DIR/engine-control-generations}"
PIN_ROOT="${ENGINE_RELEASE_PIN_ROOT:-/var/lib/club-arena/engine-release-generation-pins}"
REQUEST_ROOT="${ENGINE_RELEASE_REQUEST_ROOT:-/var/lib/club-arena/engine-release-requests}"
CONTAINER="${CONTAINER:-club-arena-engine}"
WANTS_DIR="/etc/systemd/system/multi-user.target.wants"
PROTOCOL_V1_FILE="engine-release-protocol-v1.schema"
PROTOCOL_V1_SHA256="7c5aba4d2bc572edc5ef84c5280e1ffe517e5949b41788c18eeb003abea74044"

die() {
  echo "[engine-release-unit-wrapper] FATAL: $*" >&2
  # Every wrapper failure before the transaction's normalized terminal return
  # is infrastructure/validation state. Preserve the immutable request and
  # force systemd to retry instead of misclassifying it as an application
  # failure whose durable records may be retired.
  exit 75
}

fsync_path() {
  python3 - "$1" <<'PY'
import os
import sys

path = sys.argv[1]
flags = os.O_RDONLY
if os.path.isdir(path):
    flags |= getattr(os, "O_DIRECTORY", 0)
descriptor = os.open(path, flags)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

validate_v1_protocol() {
  local generation="$1" declaration digest manifest_count
  declaration="$generation/$PROTOCOL_V1_FILE"
  [ -f "$declaration" ] && [ ! -L "$declaration" ] \
    || die "pinned control generation has no regular $PROTOCOL_V1_FILE declaration"
  digest="$(python3 - "$declaration" <<'PY'
import hashlib
import pathlib
import sys

print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest())
PY
)" || die 'could not hash the pinned release protocol declaration'
  [ "$digest" = "$PROTOCOL_V1_SHA256" ] \
    || die 'pinned control generation is incompatible with the frozen release v1 protocol'
  [ -f "$generation/generation-files" ] && [ ! -L "$generation/generation-files" ] \
    || die 'pinned control generation has no regular immutable file manifest'
  manifest_count="$(awk -v expected="$PROTOCOL_V1_FILE" '$0 == expected { count += 1 } END { print count + 0 }' \
    "$generation/generation-files")" \
    || die 'could not read the pinned generation file manifest'
  [ "$manifest_count" = 1 ] \
    || die 'pinned generation manifest does not declare the release v1 protocol exactly once'
}

validate_generation() {
  local generation="$1" canonical root_canonical control_sha
  canonical="$(readlink -e -- "$generation")" || die 'pinned control generation does not exist'
  root_canonical="$(readlink -e -- "$GENERATION_ROOT")" || die 'control generation root does not exist'
  [ "$canonical" = "$generation" ] || die 'pinned control generation is not canonical'
  case "$canonical/" in
    "$root_canonical"/*/) ;;
    *) die 'pinned control generation escaped the managed generation root' ;;
  esac
  [ -d "$canonical" ] && [ ! -L "$canonical" ] \
    || die 'pinned control generation is not an immutable directory'
  [ -r "$canonical/control-sha" ] || die 'pinned control generation has no SHA manifest'
  control_sha="$(tr -d '\r\n' < "$canonical/control-sha")"
  [[ "$control_sha" =~ ^[0-9a-f]{40}$ ]] || die 'pinned control generation has an invalid SHA manifest'
  # The globally frozen v1 wrapper may execute newer immutable generations,
  # but only when they explicitly retain its exact request, CLI, result, and
  # shared-seal contract. An added or reordered field requires wrapper/unit v2.
  validate_v1_protocol "$canonical"
  [ -x "$canonical/engine-release-transaction.sh" ] \
    || die 'pinned control generation has no transaction executable'
  [ -x "$canonical/engine-release-recover.sh" ] \
    || die 'pinned control generation has no recovery executable'
}

[ "$(id -u)" = 0 ] || die 'must run as root'
[ "$#" -ge 2 ] || die 'usage: engine-release-unit-wrapper.sh start|recover RUN_KEY [SERVICE_RESULT EXIT_CODE EXIT_STATUS]'
ACTION="$1"
RUN_KEY="$2"
# GitHub reruns reuse run_id. New callers therefore use run_id-run_attempt;
# numeric-only keys remain valid so an in-flight pre-upgrade unit can recover.
[[ "$RUN_KEY" =~ ^[1-9][0-9]*(-[1-9][0-9]*)?$ ]] \
  || die 'run key must be RUN_ID or RUN_ID-RUN_ATTEMPT'
case "$ACTION" in
  start) [ "$#" = 2 ] || die 'start requires exactly one run key' ;;
  recover) { [ "$#" = 2 ] || [ "$#" = 5 ]; } \
    || die 'recover requires a run key and optional systemd result tuple' ;;
  *) die 'action must be start or recover' ;;
esac

install -d -m 0700 "$PIN_ROOT"
fsync_path "$PIN_ROOT"
fsync_path "$(dirname "$PIN_ROOT")"
PIN_FILE="$PIN_ROOT/$RUN_KEY.generation"
case "$PIN_FILE" in
  "$PIN_ROOT/$RUN_KEY.generation") ;;
  *) die 'refusing an unsafe generation-pin path' ;;
esac

if [ "$ACTION" = start ]; then
  REQUEST_FILE="$REQUEST_ROOT/$RUN_KEY.request"
  INTENT_FILE="$REQUEST_ROOT/$RUN_KEY.intent"
  case "$REQUEST_FILE" in
    "$REQUEST_ROOT/$RUN_KEY.request") ;;
    *) die 'refusing an unsafe release-request path' ;;
  esac
  case "$INTENT_FILE" in
    "$REQUEST_ROOT/$RUN_KEY.intent") ;;
    *) die 'refusing an unsafe release-intent path' ;;
  esac
  if [ ! -e "$REQUEST_FILE" ]; then
    if [ -e "$INTENT_FILE" ]; then
      [ -f "$INTENT_FILE" ] && [ ! -L "$INTENT_FILE" ] \
        || die 'release intent is not a regular file'
      [ "$(stat -c '%u:%a' "$INTENT_FILE")" = '0:600' ] \
        || die 'release intent ownership or mode is invalid'
      # The caller deliberately submits this host unit before request
      # publication. Intent contains the complete immutable request, so the
      # host can finish that transition itself after caller/runner/host loss.
      if ! ln -- "$INTENT_FILE" "$REQUEST_FILE" 2>/dev/null; then
        if [ ! -f "$REQUEST_FILE" ] \
          || [ -L "$REQUEST_FILE" ] \
          || ! cmp -s "$INTENT_FILE" "$REQUEST_FILE"; then
          die 'concurrent release request differs from its durable intent'
        fi
      fi
      fsync_path "$REQUEST_ROOT"
    elif [ -e "$PIN_FILE" ]; then
      # Pin without request or intent is never enough authority to infer or
      # delete work. Preserve it for the exact recovery owner.
      exit 75
    else
      # Terminal cleanup removes pin, intent, then request while this boot edge
      # is still enabled. A crash after the records are gone may cause one
      # final boot invocation; retire that inert edge instead of retrying.
      systemctl disable "club-arena-engine-release-v1@$RUN_KEY.service" >/dev/null
      systemctl is-enabled "club-arena-engine-release-v1@$RUN_KEY.service" >/dev/null 2>&1 \
        && die 'empty release unit could not retire its boot edge'
      fsync_path "$WANTS_DIR"
      exit 0
    fi
  fi
  [ -f "$REQUEST_FILE" ] && [ ! -L "$REQUEST_FILE" ] \
    || die 'release request is not a regular file'
  [ "$(stat -c '%u:%a' "$REQUEST_FILE")" = '0:600' ] \
    || die 'release request ownership or mode is invalid'
  if [ -e "$INTENT_FILE" ]; then
    [ -f "$INTENT_FILE" ] && [ ! -L "$INTENT_FILE" ] \
      || die 'release intent is not a regular file'
    [ "$(stat -c '%u:%a' "$INTENT_FILE")" = '0:600' ] \
      || die 'release intent ownership or mode is invalid'
    cmp -s "$INTENT_FILE" "$REQUEST_FILE" \
      || die 'release request differs from its dispatch intent'
  fi
  mapfile -t REQUEST_LINES < "$REQUEST_FILE" || die 'release request is missing'
  [ "${#REQUEST_LINES[@]}" = 6 ] || die 'release request has an invalid field count'
  GENERATION="${REQUEST_LINES[3]}"
  REQUEST_CONTROL_SHA="${REQUEST_LINES[4]}"
  REQUEST_NOT_AFTER_EPOCH="${REQUEST_LINES[5]}"
  [[ "$REQUEST_CONTROL_SHA" =~ ^[0-9a-f]{40}$ ]] \
    || die 'release request control SHA is invalid'
  [[ "$REQUEST_NOT_AFTER_EPOCH" =~ ^[1-9][0-9]*$ ]] \
    && [ "${#REQUEST_NOT_AFTER_EPOCH}" -le 10 ] \
    || die 'release request not-after epoch is invalid'
  validate_generation "$GENERATION"
  [ "$(tr -d '\r\n' < "$GENERATION/control-sha")" = "$REQUEST_CONTROL_SHA" ] \
    || die 'release request generation does not match its control SHA'
  # A permanent failure is recorded only after the sealed desired runtime has
  # been restored. If power failed after that fsynced tombstone but before
  # terminal cleanup, this exact request may still exist. Finish cleanup from
  # the pinned generation without ever re-entering the failed transaction.
  if "$GENERATION/engine-release-seal.py" attest-failure \
    --sha "${REQUEST_LINES[0]}" --run-id "$RUN_KEY" \
    --control-sha "$REQUEST_CONTROL_SHA" >/dev/null 2>&1; then
    set +e
    ENGINE_CONTROL_DIR="$GENERATION" \
      "$GENERATION/engine-release-recover.sh" --run-id "$RUN_KEY" --mode terminal
    FAILURE_CLEANUP_RC=$?
    set -e
    [ "$FAILURE_CLEANUP_RC" -eq 0 ] || exit 75
    echo '[engine-release-unit-wrapper] retired a durably failed release without replaying it' >&2
    exit 1
  fi
  if [ -e "$PIN_FILE" ]; then
    mapfile -t PIN_LINES < "$PIN_FILE" || die 'could not read the existing generation pin'
    [ "${#PIN_LINES[@]}" = 2 ] \
      && [ "${PIN_LINES[0]}" = "$GENERATION" ] \
      && [ "${PIN_LINES[1]}" = "$REQUEST_CONTROL_SHA" ] \
      || die 'this run key is already pinned to a different control generation'
  else
    TMP_PIN="$PIN_ROOT/.$RUN_KEY.generation.$$"
    trap 'rm -f -- "${TMP_PIN:-}"' EXIT HUP INT TERM
    umask 077
    printf '%s\n%s\n' "$GENERATION" "$REQUEST_CONTROL_SHA" > "$TMP_PIN"
    fsync_path "$TMP_PIN"
    # A hard link is an atomic create-if-absent operation. Never overwrite a
    # pin if an unexpected concurrent/manual invocation used the same run key.
    if ! ln -- "$TMP_PIN" "$PIN_FILE"; then
      mapfile -t PIN_LINES < "$PIN_FILE" || die 'could not read the concurrently created generation pin'
      [ "${#PIN_LINES[@]}" = 2 ] \
        && [ "${PIN_LINES[0]}" = "$GENERATION" ] \
        && [ "${PIN_LINES[1]}" = "$REQUEST_CONTROL_SHA" ] \
        || die 'a concurrent invocation pinned this run key to a different control generation'
    fi
    rm -f -- "$TMP_PIN"
    fsync_path "$PIN_ROOT"
    trap - EXIT HUP INT TERM
  fi
  set +e
  env ENGINE_CONTROL_DIR="$GENERATION" \
    "$GENERATION/engine-release-transaction.sh" --run-id "$RUN_KEY"
  TRANSACTION_RC=$?
  set -e
  # Exit 75 is the explicit transient interruption contract (for example a
  # Docker dependency outage). Every application/proof failure is normalized
  # to one terminal code so systemd cannot turn a bad release into a loop.
  [ "$TRANSACTION_RC" -eq 75 ] && exit 75
  # A commit is the irreversible high-water mark. If the child failed after
  # committing but before its result receipt, force the retry path so the next
  # exact invocation reconstructs the DB/live proof and receipt before cleanup.
  DESIRED_IMAGE="$("$GENERATION/engine-release-seal.py" get desired-image-id 2>/dev/null || true)"
  if [ "$TRANSACTION_RC" -ne 0 ] \
    && [[ "$DESIRED_IMAGE" =~ ^sha256:[0-9a-f]{64}$ ]] \
    && "$GENERATION/engine-release-seal.py" attest-commit \
      --sha "${REQUEST_LINES[0]}" --image-id "$DESIRED_IMAGE" --run-id "$RUN_KEY" >/dev/null 2>&1; then
    exit 75
  fi

  # Success has already written its own immutable proof receipt. Complete
  # recovery and durable cleanup before returning it to systemd.
  if [ "$TRANSACTION_RC" -eq 0 ]; then
    set +e
    ENGINE_CONTROL_DIR="$GENERATION" \
      "$GENERATION/engine-release-recover.sh" --run-id "$RUN_KEY" --mode terminal
    TERMINAL_RECOVERY_RC=$?
    set -e
    [ "$TERMINAL_RECOVERY_RC" -eq 0 ] || exit 75
    exit 0
  fi

  # A permanent proof/application failure first restores the sealed desired
  # runtime while retaining every request/pin/boot edge. Only after that
  # succeeds may the seal atomically publish an immutable failure tombstone.
  # This closes the uncertain-response hole: a crash after the tombstone can
  # only converge through the no-replay branch above.
  set +e
  ENGINE_CONTROL_DIR="$GENERATION" \
    "$GENERATION/engine-release-recover.sh" --run-id "$RUN_KEY" --mode retryable
  FAILURE_RECOVERY_RC=$?
  set -e
  [ "$FAILURE_RECOVERY_RC" -eq 0 ] || exit 75
  INVOCATION_ID="${INVOCATION_ID:-}"
  [[ "$INVOCATION_ID" =~ ^[0-9a-f]{32}$ ]] || exit 75
  set +e
  timeout --signal=TERM --kill-after=2s 45s \
    "$GENERATION/engine-release-seal.py" record-failure \
      --sha "${REQUEST_LINES[0]}" --run-id "$RUN_KEY" \
      --control-sha "$REQUEST_CONTROL_SHA" --invocation-id "$INVOCATION_ID" \
      --exit-status "$TRANSACTION_RC" --container "$CONTAINER" >/dev/null
  FAILURE_RECORD_RC=$?
  set -e
  # The response can be lost after the atomic replace. Require the exact
  # attestation rather than inferring failure from the command's exit status.
  if [ "$FAILURE_RECORD_RC" -ne 0 ]; then
    echo '[engine-release-unit-wrapper] failure receipt response was uncertain; attesting durable state' >&2
  fi
  timeout --signal=TERM --kill-after=2s 20s \
    "$GENERATION/engine-release-seal.py" attest-failure \
      --sha "${REQUEST_LINES[0]}" --run-id "$RUN_KEY" \
      --control-sha "$REQUEST_CONTROL_SHA" --invocation-id "$INVOCATION_ID" >/dev/null \
    || exit 75

  # The tombstone now owns this exact terminal outcome. Cleanup is idempotent;
  # a crash anywhere below returns through the no-replay branch on next boot.
  set +e
  ENGINE_CONTROL_DIR="$GENERATION" \
    "$GENERATION/engine-release-recover.sh" --run-id "$RUN_KEY" --mode terminal
  TERMINAL_RECOVERY_RC=$?
  set -e
  [ "$TERMINAL_RECOVERY_RC" -eq 0 ] || exit 75
  exit 1
fi

RECOVERY_MODE=retryable
if [ "$#" = 5 ]; then
  SERVICE_RESULT="$3"
  EXIT_CODE="$4"
  EXIT_STATUS="$5"
  case "$SERVICE_RESULT:$EXIT_CODE:$EXIT_STATUS" in
    success:exited:0|exit-code:exited:1) RECOVERY_MODE=terminal ;;
    exit-code:exited:75|signal:*:*|core-dump:*:*|timeout:*:*|watchdog:*:*|oom-kill:*:*|resources:*:*)
      RECOVERY_MODE=retryable
      ;;
    # Only the two normalized application outcomes above may retire durable
    # state. Unknown or future systemd infrastructure results fail closed and
    # preserve the exact request for recovery by the next invocation/boot.
    *) RECOVERY_MODE=retryable ;;
  esac
fi

if [ ! -f "$PIN_FILE" ]; then
  # The generation-bound recovery script is the sole owner of terminal
  # cleanup. A request/intent without a pin is not enough authority to delete
  # anything; fail closed so the next start can recreate and validate the pin.
  [ ! -e "$REQUEST_ROOT/$RUN_KEY.request" ] \
    && [ ! -e "$REQUEST_ROOT/$RUN_KEY.intent" ] \
    || die 'durable release state exists without its immutable generation pin'
  exit 0
fi
mapfile -t PIN_LINES < "$PIN_FILE" || die 'could not read the generation pin'
[ "${#PIN_LINES[@]}" = 2 ] || die 'generation pin has an invalid field count'
GENERATION="${PIN_LINES[0]}"
PINNED_CONTROL_SHA="${PIN_LINES[1]}"
[[ "$PINNED_CONTROL_SHA" =~ ^[0-9a-f]{40}$ ]] || die 'pinned control SHA is invalid'
validate_generation "$GENERATION"
[ "$(tr -d '\r\n' < "$GENERATION/control-sha")" = "$PINNED_CONTROL_SHA" ] \
  || die 'pinned generation no longer matches its control SHA'

set +e
ENGINE_CONTROL_DIR="$GENERATION" \
  "$GENERATION/engine-release-recover.sh" --run-id "$RUN_KEY" --mode "$RECOVERY_MODE"
RECOVERY_RC=$?
set -e
if [ "$RECOVERY_RC" -eq 0 ]; then
  [ "$RECOVERY_MODE" = retryable ] \
    && echo '[engine-release-unit-wrapper] retryable release state retained for the next exact invocation' >&2
  exit 0
fi

echo '[engine-release-unit-wrapper] recovery failed; preserving the immutable generation pin for diagnosis' >&2
# ExecStopPost is an infrastructure boundary. Any cleanup/recovery failure is
# retryable even when a child happened to return the ordinary terminal code 1.
exit 75
