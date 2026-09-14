#!/usr/bin/env bash
# Reattach to and prove one already-dispatched systemd release transaction.
set -euo pipefail

CONTROL_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
CONTAINER="${CONTAINER:-club-arena-engine}"
PUBLIC_URL="${ENGINE_URL:-https://engine.smarter.poker}"
OBSERVE_SECONDS="${ENGINE_RELEASE_OBSERVE_SECONDS:-10200}"
INVOCATION_WAIT_SECONDS="${ENGINE_RELEASE_INVOCATION_WAIT_SECONDS:-900}"
REQUEST_ROOT="${ENGINE_RELEASE_REQUEST_ROOT:-/var/lib/club-arena/engine-release-requests}"
INTAKE_ROOT="${ENGINE_RELEASE_INTAKE_ROOT:-/var/lib/club-arena/engine-intake-requests}"
PIN_ROOT="${ENGINE_RELEASE_PIN_ROOT:-/var/lib/club-arena/engine-release-generation-pins}"
LEASE_ROOT="${ENGINE_RELEASE_IMAGE_LEASE_ROOT:-/var/lib/club-arena/engine-image-leases}"

die() {
  echo "[observe-engine-release] FATAL: $*" >&2
  exit "${2:-1}"
}

systemd_outcome_is_retryable() {
  local result="${1:-}" status="${2:-}"
  # This is the observer form of the wrapper's fail-closed tuple predicate:
  # only the two normalized terminal outcomes may stop reattachment. Signals,
  # timeouts, OOM/resource failures, status 75, and unknown future results all
  # remain retryable while the exact unit is durably enabled.
  case "$result:$status" in
    success:0|exit-code:1) return 1 ;;
    *) return 0 ;;
  esac
}

fail_if_terminal_failure() {
  local attestation failure_result failure_sha failure_control failure_invocation
  local failure_status recovered_sha recovered_image extra
  if ! attestation="$("$CONTROL_DIR/engine-release-seal.py" attest-failure \
    --sha "$SHA" --run-id "$RUN_ID" 2>/dev/null)"; then
    return 0
  fi
  read -r failure_result failure_sha failure_control failure_invocation \
    failure_status recovered_sha recovered_image extra <<< "$attestation"
  [ "$failure_result" = failed ] && [ "$failure_sha" = "$SHA" ] \
    && [[ "$failure_control" =~ ^[0-9a-f]{40}$ ]] \
    && [[ "$failure_invocation" =~ ^[0-9a-f]{32}$ ]] \
    && [[ "$failure_status" =~ ^[1-9][0-9]*$ ]] \
    && [[ "$recovered_sha" =~ ^[0-9a-f]{40}$ ]] \
    && [[ "$recovered_image" =~ ^sha256:[0-9a-f]{64}$ ]] \
    && [ -z "${extra:-}" ] \
    || die 'durable failure attestation is malformed'
  # A durable failure can be observed before the generic systemd branch below.
  # Keep its exact invocation's cause in Actions, including after unit cleanup.
  # Missing or slow journal storage must never delay or change the refusal.
  if ! timeout --signal=TERM --kill-after=1s 5s \
    journalctl "_SYSTEMD_INVOCATION_ID=$failure_invocation" --no-pager -o cat -n 200; then
    echo '[observe-engine-release] failure journal unavailable within its bounded read' >&2
  fi
  die "release attempt failed permanently (status=$failure_status); sealed desired runtime $recovered_sha was recovered"
}

[ "$(id -u)" = 0 ] || die 'must run as root'
[ "$#" = 4 ] && [ "$1" = --sha ] && [ "$3" = --run-id ] \
  || die 'usage: observe-engine-release.sh --sha SHA --run-id RUN_ID-RUN_ATTEMPT'
SHA="$2"
RUN_ID="$4"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die 'SHA must be one lowercase 40-hex commit'
[[ "$RUN_ID" =~ ^[1-9][0-9]*(-[1-9][0-9]*)?$ ]] || die 'run key is invalid'
[[ "$OBSERVE_SECONDS" =~ ^[1-9][0-9]*$ ]] && [ "$OBSERVE_SECONDS" -le 10200 ] \
  || die 'observe budget is invalid'
[[ "$INVOCATION_WAIT_SECONDS" =~ ^[1-9][0-9]*$ ]] && [ "$INVOCATION_WAIT_SECONDS" -le 1800 ] \
  || die 'invocation wait budget is invalid'
UNIT="club-arena-engine-release-v1@$RUN_ID.service"
INTAKE_UNIT="club-arena-engine-intake-v1@$RUN_ID.service"
INTAKE_PATH_UNIT="club-arena-engine-intake-v1@$RUN_ID.path"
DEADLINE=$(( $(date +%s) + OBSERVE_SECONDS ))

# A caller can lose its response after the host has durably rejected this
# exact run. Consult the immutable tombstone before looking for or waiting on a
# systemd invocation, so an uncertain replay reports the original terminal
# outcome instead of timing out or dispatching the transaction again.
fail_if_terminal_failure

# Completed unit metadata is allowed to disappear after disable/reboot. The
# fsynced run receipt is the durable completion authority; live seal/container/
# HTTP proof below remains mandatory before it can be reported as success.
COMPLETED_ATTESTATION="$("$CONTROL_DIR/engine-release-seal.py" attest-result \
  --sha "$SHA" --run-id "$RUN_ID" 2>/dev/null || true)"
RESULT_PREEXISTED=0
[ -z "$COMPLETED_ATTESTATION" ] || RESULT_PREEXISTED=1
INVOCATION_ID=''

# `systemctl start --no-block` acknowledges a queued job before systemd has to
# assign InvocationID. A durable intake may also be installing the control
# generation first. Poll the exact release unit and fail 76 only after the
# bounded handoff window proves that no invocation appeared.
INVOCATION_DEADLINE=$(( $(date +%s) + INVOCATION_WAIT_SECONDS ))
[ "$INVOCATION_DEADLINE" -le "$DEADLINE" ] || INVOCATION_DEADLINE="$DEADLINE"
while [ -z "$COMPLETED_ATTESTATION" ] && [ "$(date +%s)" -lt "$INVOCATION_DEADLINE" ]; do
  fail_if_terminal_failure
  CURRENT_INVOCATION="$(systemctl show "$UNIT" -p InvocationID --value 2>/dev/null || true)"
  if [[ "$CURRENT_INVOCATION" =~ ^[0-9a-f]{32}$ ]]; then
    INVOCATION_ID="$CURRENT_INVOCATION"
  fi
  COMPLETED_ATTESTATION="$("$CONTROL_DIR/engine-release-seal.py" attest-result \
    --sha "$SHA" --run-id "$RUN_ID" 2>/dev/null || true)"
  [ -z "$COMPLETED_ATTESTATION" ] || break
  [[ "$INVOCATION_ID" =~ ^[0-9a-f]{32}$ ]] && break
  INTAKE_STATE="$(systemctl show "$INTAKE_UNIT" -p ActiveState --value 2>/dev/null || true)"
  INTAKE_RESULT="$(systemctl show "$INTAKE_UNIT" -p Result --value 2>/dev/null || true)"
  INTAKE_STATUS="$(systemctl show "$INTAKE_UNIT" -p ExecMainStatus --value 2>/dev/null || true)"
  if [ "$INTAKE_STATE" = failed ] \
    || { [ "$INTAKE_STATE" = inactive ] && [ -n "$INTAKE_RESULT" ] && [ "$INTAKE_RESULT" != success ]; }; then
    if systemd_outcome_is_retryable "$INTAKE_RESULT" "$INTAKE_STATUS" \
      && systemctl is-enabled "$INTAKE_UNIT" 2>/dev/null | grep -qx enabled; then
      # Between attempts systemd can expose the oneshot as failed/inactive
      # while its durable boot edge owns the next exact fail-closed retry.
      sleep 5
      continue
    fi
    journalctl -u "$INTAKE_UNIT" --no-pager -o cat -n 200 2>/dev/null || true
    die "durable release intake failed (result=${INTAKE_RESULT:-unknown} status=${INTAKE_STATUS:-unknown})"
  fi
  sleep 5
done
[[ "$INVOCATION_ID" =~ ^[0-9a-f]{32}$ ]] \
  || { [ -n "$COMPLETED_ATTESTATION" ] \
    || die 'release unit has no invocation after the durable handoff deadline' 76; }

if [ -z "$COMPLETED_ATTESTATION" ]; then
  while :; do
    fail_if_terminal_failure
    CURRENT_INVOCATION="$(systemctl show "$UNIT" -p InvocationID --value 2>/dev/null || true)"
    if [[ "$CURRENT_INVOCATION" =~ ^[0-9a-f]{32}$ ]] && [ "$CURRENT_INVOCATION" != "$INVOCATION_ID" ]; then
      # A reboot/retry can supersede the invocation initially observed. Read
      # this before the receipt so a result created between polls is always
      # correlated to the invocation that produced it, never its predecessor.
      INVOCATION_ID="$CURRENT_INVOCATION"
    fi
    COMPLETED_ATTESTATION="$("$CONTROL_DIR/engine-release-seal.py" attest-result \
      --sha "$SHA" --run-id "$RUN_ID" 2>/dev/null || true)"
    [ -z "$COMPLETED_ATTESTATION" ] || break
    ACTIVE_STATE="$(systemctl show "$UNIT" -p ActiveState --value 2>/dev/null || true)"
    RESULT="$(systemctl show "$UNIT" -p Result --value 2>/dev/null || true)"
    MAIN_STATUS="$(systemctl show "$UNIT" -p ExecMainStatus --value 2>/dev/null || true)"
    case "$ACTIVE_STATE" in
      activating|active|deactivating)
        [ "$(date +%s)" -lt "$DEADLINE" ] || die 'release unit exceeded the observation deadline'
        sleep 15
        ;;
      inactive|failed)
        if systemd_outcome_is_retryable "$RESULT" "$MAIN_STATUS" \
          && systemctl is-enabled "$UNIT" 2>/dev/null | grep -qx enabled; then
          # Do not turn the intentional transient status into a false terminal
          # CI failure during RestartSec. The enabled exact unit remains the
          # authority and the shared observer deadline still bounds it.
          [ "$(date +%s)" -lt "$DEADLINE" ] \
            || die 'release unit exceeded the observation deadline while retrying'
          sleep 15
          continue
        fi
        break
        ;;
      *) die "release unit entered unexpected state ${ACTIVE_STATE:-missing}" ;;
    esac
  done

  if [ -z "$COMPLETED_ATTESTATION" ]; then
    fail_if_terminal_failure
    RESULT="$(systemctl show "$UNIT" -p Result --value 2>/dev/null || true)"
    MAIN_STATUS="$(systemctl show "$UNIT" -p ExecMainStatus --value 2>/dev/null || true)"
    UNIT_LOG="$(journalctl "_SYSTEMD_INVOCATION_ID=$INVOCATION_ID" --no-pager -o cat -n 400 2>/dev/null || true)"
    printf '%s\n' "$UNIT_LOG"
    [ "$RESULT" = success ] && [ "$MAIN_STATUS" = 0 ] \
      || die "release unit failed (result=${RESULT:-unknown} status=${MAIN_STATUS:-unknown})"
  fi
fi

unit_completed_and_disabled() {
  local unit="$1" state result
  systemctl is-enabled "$unit" >/dev/null 2>&1 && return 1
  state="$(systemctl show "$unit" -p ActiveState --value 2>/dev/null || true)"
  result="$(systemctl show "$unit" -p Result --value 2>/dev/null || true)"
  case "$state" in ''|inactive) ;; *) return 1 ;; esac
  case "$result" in ''|success) ;; *) return 1 ;; esac
}

path_stopped_and_disabled() {
  local state
  systemctl is-enabled "$INTAKE_PATH_UNIT" >/dev/null 2>&1 && return 1
  state="$(systemctl show "$INTAKE_PATH_UNIT" -p ActiveState --value 2>/dev/null || true)"
  case "$state" in ''|inactive|dead) return 0 ;; *) return 1 ;; esac
}

run_state_retired() {
  [ ! -e "$REQUEST_ROOT/$RUN_ID.intent" ] \
    && [ ! -e "$REQUEST_ROOT/$RUN_ID.request" ] \
    && [ ! -e "$REQUEST_ROOT/$RUN_ID.break-deadline" ] \
    && [ ! -e "$INTAKE_ROOT/$RUN_ID.intent" ] \
    && [ ! -e "$INTAKE_ROOT/$RUN_ID.request" ] \
    && [ ! -e "$PIN_ROOT/$RUN_ID.generation" ] \
    && [ ! -e "$LEASE_ROOT/$RUN_ID.lease" ] \
    && unit_completed_and_disabled "$UNIT" \
    && unit_completed_and_disabled "$INTAKE_UNIT" \
    && path_stopped_and_disabled
}

# The fsynced result proves the serving release, but it is written before the
# wrappers finish cleanup. Do not let CI publish SHIPPED while any boot edge,
# request, generation pin, lease, intake event, or systemd transaction remains.
while ! run_state_retired; do
  [ "$(date +%s)" -lt "$DEADLINE" ] \
    || die 'release result exists but terminal host retirement did not complete'
  sleep 5
done

# Cleanup may have taken time or another release may have advanced desired.
# Re-attest this exact result after retirement before any live proof succeeds.
COMPLETED_ATTESTATION="$("$CONTROL_DIR/engine-release-seal.py" attest-result \
  --sha "$SHA" --run-id "$RUN_ID")" \
  || die 'terminally retired release has no valid exact result receipt'

DESIRED_SHA="$("$CONTROL_DIR/engine-release-seal.py" get desired-sha)"
DESIRED_IMAGE="$("$CONTROL_DIR/engine-release-seal.py" get desired-image-id)"
ACTUAL_SHA="$(docker container inspect -f '{{index .Config.Labels "sp.release.sha"}}' "$CONTAINER")"
ACTUAL_IMAGE="$(docker container inspect -f '{{.Image}}' "$CONTAINER")"
ACTUAL_STATE="$(docker container inspect -f '{{.State.Status}}' "$CONTAINER")"
ACTUAL_CONTAINER_ID="$(docker container inspect -f '{{.Id}}' "$CONTAINER")"
ACTUAL_STARTED_AT="$(docker container inspect -f '{{.State.StartedAt}}' "$CONTAINER")"
[ "$DESIRED_SHA" = "$SHA" ] && [ "$ACTUAL_SHA" = "$SHA" ] \
  && [ "$ACTUAL_IMAGE" = "$DESIRED_IMAGE" ] && [ "$ACTUAL_STATE" = running ] \
  || die 'release unit ended without the exact sealed running container'

health_identity() {
  local url="$1" body
  body="$(curl -fsS --max-time 15 -H 'Cache-Control: no-cache, no-store' "$url")" || return 1
  printf '%s' "$body" | EXPECTED_SHA="$SHA" python3 -c '
import json, os, re, sys
d=json.load(sys.stdin); i=d.get("instanceId")
ok=(d.get("running") is True and d.get("releaseSha")==os.environ["EXPECTED_SHA"] and d.get("liveness")=="ok" and isinstance(i,str) and re.fullmatch(r"[1-9][0-9]*-[0-9a-f]{8}",i))
if not ok: raise SystemExit(1)
print(i)
' 2>/dev/null
}
LOCAL_INSTANCE="$(health_identity 'http://127.0.0.1:8080/health')" \
  || die 'release unit ended without exact local health'
PUBLIC_INSTANCE="$(health_identity "$PUBLIC_URL/health?nocache=$(date +%s%N)")" \
  || die 'release unit ended without exact public health'
[ "$LOCAL_INSTANCE" = "$PUBLIC_INSTANCE" ] \
  || die 'local and public health identify different engine processes'

if [ "$RESULT_PREEXISTED" = 1 ]; then
  RESULT_ATTESTATION="$COMPLETED_ATTESTATION"
else
  RESULT_ATTESTATION="$("$CONTROL_DIR/engine-release-seal.py" attest-result \
    --sha "$SHA" --run-id "$RUN_ID" --invocation-id "$INVOCATION_ID")" \
    || die 'release unit has no valid fsynced per-run result receipt'
fi
read -r TRANSACTION_RESULT RESULT_SHA RESULT_IMAGE RESULT_CONTAINER RESULT_STARTED \
  RESULT_INSTANCE RESULT_CONTROL EXTRA <<< "$RESULT_ATTESTATION"
case "$TRANSACTION_RESULT" in sealed|already-released) ;; *) die 'release receipt outcome is invalid' ;; esac
[ "$RESULT_SHA" = "$SHA" ] && [ "$RESULT_IMAGE" = "$ACTUAL_IMAGE" ] \
  && [[ "$RESULT_CONTROL" =~ ^[0-9a-f]{40}$ ]] && [ -z "${EXTRA:-}" ] \
  || die 'fsynced result receipt does not match the exact serving runtime generation'
if [ "$RESULT_PREEXISTED" = 0 ]; then
  [ "$RESULT_CONTAINER" = "$ACTUAL_CONTAINER_ID" ] \
    && [ "$RESULT_STARTED" = "$ACTUAL_STARTED_AT" ] \
    && [ "$RESULT_INSTANCE" = "$LOCAL_INSTANCE" ] \
    || die 'active invocation receipt does not match the serving process generation'
fi
echo 'ENGINE_RELEASE_UNIT_RESULT=success'
echo "ENGINE_RELEASE_SHA=$SHA"
echo "ENGINE_RELEASE_RESULT=$TRANSACTION_RESULT"
