#!/usr/bin/env bash
# One crash-contained Club Arena engine release transaction.
#
# The root-owned systemd unit keeps this transaction alive if SSH or its
# GitHub runner disappears. It owns prepare, cutover, all three compatibility
# witnesses, the fsynced release seal, and deterministic recovery.
set -euo pipefail

CONTROL_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
RELEASE_SEAL="$CONTROL_DIR/engine-release-seal.py"
ENGINE_UP="$CONTROL_DIR/engine-up.sh"
IMAGE_BUILDER="$CONTROL_DIR/build-engine-image.sh"
DATABASE_PROOF="$CONTROL_DIR/engine-release-database-proof.py"
LEGACY_CHECKPOINT="$CONTROL_DIR/legacy-engine-checkpoint.sh"
LEGACY_CHECKPOINT_SHA=2f4e33560bcd23bfb5cc731f31816b2c2e2847e5
REPO_DIR="${REPO_DIR:-/opt/club-arena}"
ENV_FILE="${ENV_FILE:-$REPO_DIR/server/.env}"
REQUEST_ROOT="${ENGINE_RELEASE_REQUEST_ROOT:-/var/lib/club-arena/engine-release-requests}"
LEASE_ROOT="${ENGINE_RELEASE_IMAGE_LEASE_ROOT:-/var/lib/club-arena/engine-image-leases}"
ENGINE_LOCK="${ENGINE_LOCK_FILE:-/var/lock/club-arena-engine-up.lock}"
SOURCE_LOCK="${SOURCE_LOCK_FILE:-/var/lock/club-arena-source.lock}"
CONTAINER="${CONTAINER:-club-arena-engine}"
IMAGE_REPO="${IMAGE_REPO:-club-arena-engine}"
PUBLIC_URL="${ENGINE_URL:-https://engine.smarter.poker}"
MAX_RUNTIME_SECONDS="${ENGINE_RELEASE_MAX_RUNTIME_SECONDS:-8400}"
CERTIFICATE_RESERVE_SECONDS=720
# Five-to-eight-minute boots have occurred while the database was degraded, so
# a fixed five-minute break cannot promise recovery from every external outage.
# It can support an ordinary release only when the currently sealed engine is
# demonstrably the exact live local/public process AND the fresh database leader
# immediately before mutation. Recent healthy releases complete the whole
# candidate proof in about two minutes. Give candidate proof 150 seconds,
# reserve 135 seconds for exact desired recovery, and require that this
# 285-second budget still exists under the engine lock. The remaining nominal
# 15 seconds are entry slack for lock/freshness/certificate work. Every command
# after the certificate shares the absolute break deadline; if dependencies
# degrade after the readiness proof, recovery fails loudly rather than claiming
# an impossible in-break guarantee.
BREAK_CUTOVER_PROOF_SECONDS=150
BREAK_ROLLBACK_RESERVE_SECONDS=135
BREAK_DEADLINE_SLACK_SECONDS=0
NON_BREAK_RECOVERY_MAX_SECONDS=300
# CLAUDE.md 13: the engine restarts inside the announced break that opens at
# :55 of every hour. This is the same minute every other surface reads, and
# tests/the-break-clocks-agree.law.test.ts pins them together.
BREAK_START_MINUTE=55
MIN_BREAK_REMAINING_MS=$(((BREAK_CUTOVER_PROOF_SECONDS + BREAK_ROLLBACK_RESERVE_SECONDS + BREAK_DEADLINE_SLACK_SECONDS) * 1000))

die() {
  echo "[engine-release-transaction] FATAL: $*" >&2
  exit 1
}

[ "$(id -u)" = 0 ] || die 'must run as root'
[ "$#" = 2 ] && [ "$1" = --run-id ] \
  || die 'usage: engine-release-transaction.sh --run-id RUN_ID-RUN_ATTEMPT'
RUN_ID="$2"
[[ "$RUN_ID" =~ ^[1-9][0-9]*(-[1-9][0-9]*)?$ ]] || die 'run key is invalid'
GITHUB_RUN_ID="${RUN_ID%%-*}"
[[ "$MAX_RUNTIME_SECONDS" =~ ^[1-9][0-9]*$ ]] || die 'runtime budget must be a positive integer'
[ "$MAX_RUNTIME_SECONDS" -ge 1200 ] && [ "$MAX_RUNTIME_SECONDS" -le 8400 ] \
  || die 'runtime budget must be between twenty minutes and two hours twenty minutes'
STARTED_EPOCH="$(date +%s)"
SUPERSEDED_BY=""
DEADLINE=0
CERTIFICATE_DEADLINE=0

remaining_seconds() {
  local remaining=$((DEADLINE - $(date +%s)))
  [ "$remaining" -gt 0 ] || return 1
  printf '%s\n' "$remaining"
}

assert_time_remaining() {
  remaining_seconds >/dev/null || die 'the end-to-end release deadline expired'
}

bounded_sleep() {
  local requested="$1" remaining proof_remaining
  remaining="$(remaining_seconds)" || die 'the end-to-end release deadline expired while waiting'
  if [ "${BREAK_END_EPOCH:-0}" -gt 0 ]; then
    proof_remaining="$(break_proof_seconds)" \
      || die 'maintenance break proof budget expired while waiting'
    [ "$remaining" -le "$proof_remaining" ] || remaining="$proof_remaining"
  fi
  [ "$requested" -le "$remaining" ] || requested="$remaining"
  sleep "$requested"
}

validate_actor() {
  python3 - "$1" <<'PY'
import sys
actor = sys.argv[1]
valid = bool(actor) and len(actor) <= 128 and all(ord(char) >= 32 and ord(char) != 127 for char in actor)
raise SystemExit(0 if valid else 1)
PY
}

REQUEST_FILE="$REQUEST_ROOT/$RUN_ID.request"
mapfile -t REQUEST_LINES < "$REQUEST_FILE" || die 'release request is missing'
[ "${#REQUEST_LINES[@]}" = 6 ] || die 'release request has an invalid field count'
SHA="${REQUEST_LINES[0]}"
RUN_URL="${REQUEST_LINES[1]}"
ACTOR="${REQUEST_LINES[2]}"
REQUEST_GENERATION="${REQUEST_LINES[3]}"
REQUEST_CONTROL_SHA="${REQUEST_LINES[4]}"
REQUEST_NOT_AFTER_EPOCH="${REQUEST_LINES[5]}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die 'request SHA must be one lowercase 40-hex commit'
[ "$RUN_URL" = "https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/$GITHUB_RUN_ID" ] \
  || die 'request URL does not identify this Club Arena run'
validate_actor "$ACTOR" || die 'request actor is invalid'
[[ "$REQUEST_CONTROL_SHA" =~ ^[0-9a-f]{40}$ ]] || die 'request control SHA is invalid'
[[ "$REQUEST_NOT_AFTER_EPOCH" =~ ^[1-9][0-9]*$ ]] \
  && [ "${#REQUEST_NOT_AFTER_EPOCH}" -le 10 ] \
  || die 'request not-after epoch is invalid'
[ "$REQUEST_GENERATION" = "$CONTROL_DIR" ] \
  || die 'release request does not identify this immutable control generation'
CONTROL_SHA="$(tr -d '\r\n' < "$CONTROL_DIR/control-sha")" \
  || die 'control generation SHA manifest is missing'
[ "$CONTROL_SHA" = "$REQUEST_CONTROL_SHA" ] || die 'control generation SHA does not match the request'
# The workflow chooses this once, before any network or host handoff. Every
# systemd retry reads the same immutable request byte and can never extend the
# CI-owned mutation window. A shorter per-invocation cap is permitted; a later
# one is not.
MUTATION_DEADLINE_EPOCH="$REQUEST_NOT_AFTER_EPOCH"
LOCAL_RUNTIME_DEADLINE=$((STARTED_EPOCH + MAX_RUNTIME_SECONDS))
[ "$MUTATION_DEADLINE_EPOCH" -le "$LOCAL_RUNTIME_DEADLINE" ] \
  || MUTATION_DEADLINE_EPOCH="$LOCAL_RUNTIME_DEADLINE"
if [ "$MUTATION_DEADLINE_EPOCH" -gt "$STARTED_EPOCH" ]; then
  DEADLINE="$MUTATION_DEADLINE_EPOCH"
else
  # An expired invocation may only restore/finalize exact durable state. Give
  # that recovery path a fresh bounded clock without reopening release work.
  DEADLINE=$((STARTED_EPOCH + NON_BREAK_RECOVERY_MAX_SECONDS))
fi
CERTIFICATE_DEADLINE=$((MUTATION_DEADLINE_EPOCH - CERTIFICATE_RESERVE_SECONDS))
INVOCATION_ID="${INVOCATION_ID:-}"
[[ "$INVOCATION_ID" =~ ^[0-9a-f]{32}$ ]] || die 'systemd invocation identity is missing or invalid'
IMAGE_REF="$IMAGE_REPO:$SHA"
LEASE_FILE="$LEASE_ROOT/$RUN_ID.lease"
BREAK_DEADLINE_FILE="$REQUEST_ROOT/$RUN_ID.break-deadline"

LOCK_HELD=0
PREPARED=0
MUTATION_STARTED=0
LEGACY_CHECKPOINT_ATTEMPTED=0

recover_on_exit() {
  local rc=$? recovery_deadline recovery_remaining non_break_deadline
  trap - EXIT HUP INT TERM
  set +e
  recovery_deadline="${BREAK_END_EPOCH:-0}"
  if [ "$recovery_deadline" -le "$(date +%s)" ]; then
    # Recovery is deliberately allowed after the immutable release mutation
    # cutoff. It may restore sealed desired state, never prepare or cut over a
    # new candidate.
    non_break_deadline=$(( $(date +%s) + NON_BREAK_RECOVERY_MAX_SECONDS ))
    recovery_deadline="$non_break_deadline"
  fi
  recovery_remaining=$((recovery_deadline - $(date +%s)))
  if [ "$rc" -ne 0 ] && [ "$PREPARED" = 1 ]; then
    if [ "$recovery_remaining" -gt 2 ]; then
      [ "$recovery_remaining" -le 10 ] || recovery_remaining=10
      timeout --signal=TERM --kill-after=1s "${recovery_remaining}s" \
        "$RELEASE_SEAL" abort --run-id "$RUN_ID" \
        || echo '[engine-release-transaction] FATAL: break-bounded immediate seal abort failed' >&2
    else
      echo '[engine-release-transaction] FATAL: no certified break time remained for seal abort' >&2
    fi
  fi
  if [ "$rc" -ne 0 ] && [ "$MUTATION_STARTED" = 1 ] && [ "$LOCK_HELD" = 1 ]; then
    recovery_remaining=$((recovery_deadline - $(date +%s)))
    if [ "$recovery_remaining" -gt 2 ]; then
      timeout --signal=TERM --kill-after=1s "${recovery_remaining}s" env \
        ENGINE_SUPERVISOR_LOCK_HELD=1 ENGINE_SUPERVISOR_FORCE_DESIRED=1 \
        ENGINE_SUPERVISOR_REQUIRE_EXACT_HEALTH=1 \
        ENGINE_RECOVERY_DEADLINE_EPOCH="$recovery_deadline" \
        ENGINE_CONTROL_DIR="$CONTROL_DIR" CONTAINER="$CONTAINER" \
        ENGINE_URL="$PUBLIC_URL" "$CONTROL_DIR/engine-supervisor.sh" \
        || echo '[engine-release-transaction] FATAL: break-bounded exact desired recovery failed' >&2
    else
      # The cutover gate below makes this unreachable for new transactions.
      # Keep the failure loud for a transaction started by older control bytes.
      echo '[engine-release-transaction] FATAL: certified recovery deadline already expired' >&2
    fi
  elif [ "$rc" -ne 0 ] && [ "$MUTATION_STARTED" = 1 ]; then
    echo '[engine-release-transaction] WARN: deferred recovery to ExecStopPost because the engine lock is not held' >&2
  fi
  if [ "$LOCK_HELD" = 1 ]; then
    flock -u 9
  fi
  exit "$rc"
}
trap recover_on_exit EXIT
trap 'exit 75' HUP
trap 'exit 130' INT
trap 'exit 75' TERM

acquire_engine_lock() {
  local label="$1" remaining wait_seconds
  remaining="$(remaining_seconds)" || die "deadline expired before $label"
  wait_seconds="$remaining"
  [ "$wait_seconds" -le 600 ] || wait_seconds=600
  exec 9>"$ENGINE_LOCK"
  flock -w "$wait_seconds" 9 || die "could not acquire the engine mutation lock for $label"
  LOCK_HELD=1
}

release_engine_lock() {
  [ "$LOCK_HELD" = 1 ] || return 0
  flock -u 9
  LOCK_HELD=0
}

# Whole-hour arithmetic only: the break opens on a fixed minute of every hour
# and runs to the top of the next one, so the answer never depends on the local
# timezone or on the engine being reachable. Zero means a break is open NOW -
# the wrap-around reading it replaced said the next break was an hour away at
# :56, which is inside the break this transaction is trying to use.
seconds_to_next_break() {
  local past break_at
  past=$(( $(date -u +%s) % 3600 ))
  break_at=$(( BREAK_START_MINUTE * 60 ))
  if [ "$past" -ge "$break_at" ]; then
    echo 0
  else
    echo $(( break_at - past ))
  fi
}

source_target_is_current() {
  local main_sha latest remaining lock_wait fetch_wait attempt fetched source_deadline
  local high_water high_water_contained
  remaining="$(remaining_seconds)" || die 'deadline expired before protected-main verification'
  source_deadline="$DEADLINE"
  if [ "${BREAK_END_EPOCH:-0}" -gt 0 ]; then
    local proof_remaining
    proof_remaining="$(break_proof_seconds)" \
      || die 'maintenance break proof budget expired before protected-main verification'
    [ "$remaining" -le "$proof_remaining" ] || remaining="$proof_remaining"
    source_deadline=$(( $(date +%s) + remaining ))
  fi
  lock_wait="$remaining"
  [ "$lock_wait" -le 90 ] || lock_wait=90
  exec 8>"$SOURCE_LOCK"
  flock -w "$lock_wait" 8 || die 'could not acquire the source-object lock'
  fetched=0
  for attempt in 1 2 3; do
    remaining=$((source_deadline - $(date +%s)))
    [ "$remaining" -gt 6 ] || die 'source verification deadline expired before protected-main fetch'
    fetch_wait=$((remaining - 5))
    [ "$fetch_wait" -le 20 ] || fetch_wait=20
    if GIT_NO_REPLACE_OBJECTS=1 GIT_HTTP_LOW_SPEED_LIMIT=1024 GIT_HTTP_LOW_SPEED_TIME=15 \
      timeout --signal=TERM --kill-after=5s "${fetch_wait}s" \
      git -C "$REPO_DIR" fetch --no-tags origin '+refs/heads/main:refs/remotes/origin/main'; then
      fetched=1
      break
    fi
    if [ "$attempt" != 3 ]; then
      remaining=$((source_deadline - $(date +%s)))
      [ "$remaining" -gt 3 ] || die 'source verification deadline expired between fetch attempts'
      sleep 3
    fi
  done
  [ "$fetched" = 1 ] || die 'bounded protected-main fetch failed after three attempts'
  remaining=$((source_deadline - $(date +%s)))
  [ "$remaining" -gt 2 ] || die 'source verification deadline expired before protected-main inspection'
  [ "$remaining" -le 10 ] || remaining=10
  main_sha="$(timeout --signal=TERM --kill-after=1s "${remaining}s" env GIT_NO_REPLACE_OBJECTS=1 \
    git -C "$REPO_DIR" rev-parse --verify 'origin/main^{commit}')" \
    || die 'bounded protected-main revision lookup failed'
  remaining=$((source_deadline - $(date +%s)))
  [ "$remaining" -gt 2 ] || die 'source verification deadline expired before target object proof'
  [ "$remaining" -le 10 ] || remaining=10
  timeout --signal=TERM --kill-after=1s "${remaining}s" env GIT_NO_REPLACE_OBJECTS=1 \
    git -C "$REPO_DIR" cat-file -e "$SHA^{commit}" \
    || die 'bounded target object proof failed'
  remaining=$((source_deadline - $(date +%s)))
  [ "$remaining" -gt 2 ] || die 'source verification deadline expired before ancestry proof'
  [ "$remaining" -le 10 ] || remaining=10
  timeout --signal=TERM --kill-after=1s "${remaining}s" env GIT_NO_REPLACE_OBJECTS=1 \
    git -C "$REPO_DIR" merge-base --is-ancestor "$SHA" "$main_sha" \
    || die "target $SHA is no longer contained in protected main"
  remaining=$((source_deadline - $(date +%s)))
  [ "$remaining" -gt 2 ] || die 'source verification deadline expired before component high-water lookup'
  [ "$remaining" -le 10 ] || remaining=10
  latest="$(timeout --signal=TERM --kill-after=1s "${remaining}s" env GIT_NO_REPLACE_OBJECTS=1 \
    git -C "$REPO_DIR" log "$main_sha" -1 --format=%H -- \
      'server/**' ':(exclude)server/**/*.test.ts' ':(exclude)server/sim/**')" \
    || die 'bounded engine component high-water lookup failed'
  remaining=$((source_deadline - $(date +%s)))
  [ "$remaining" -gt 2 ] || die 'source verification deadline expired before server tree lookup'
  [ "$remaining" -le 10 ] || remaining=10
  EXPECTED_SERVER_TREE="$(timeout --signal=TERM --kill-after=1s "${remaining}s" env \
    GIT_NO_REPLACE_OBJECTS=1 git -C "$REPO_DIR" rev-parse --verify "$SHA:server")" \
    || die 'bounded target server tree lookup failed'
  # A normal deploy must contain the durable high-water release, including
  # after an intentional rollback moved desired-sha backwards. New protected-main
  # merges do not revoke an otherwise forward target. The engine-lock rechecks
  # and seal prepare repeat this ordering proof before any cutover can commit.
  remaining=$((source_deadline - $(date +%s)))
  [ "$remaining" -gt 2 ] || die 'source verification deadline expired before forward-only proof'
  [ "$remaining" -le 10 ] || remaining=10
  high_water="$(timeout --signal=TERM --kill-after=1s 5s "$RELEASE_SEAL" get high-water-sha 2>/dev/null || true)"
  high_water_contained=0
  if [[ "$high_water" =~ ^[0-9a-f]{40}$ ]]; then
    if timeout --signal=TERM --kill-after=1s "${remaining}s" env GIT_NO_REPLACE_OBJECTS=1 \
      git -C "$REPO_DIR" merge-base --is-ancestor "$high_water" "$SHA" 2>/dev/null; then
      high_water_contained=1
    fi
  fi
  flock -u 8
  [[ "$latest" =~ ^[0-9a-f]{40}$ ]] || die 'latest engine component SHA is unreadable'
  [[ "$EXPECTED_SERVER_TREE" =~ ^[0-9a-f]{40}$ ]] || die 'target server tree is unreadable'
  [[ "$high_water" =~ ^[0-9a-f]{40}$ ]] \
    || die "target $SHA cannot prove the sealed high-water release"
  [ "$high_water_contained" = 1 ] \
    || die "target $SHA does not contain the sealed high-water release $high_water"
  SUPERSEDED_BY=''
  if [ "$latest" != "$SHA" ]; then
    SUPERSEDED_BY="$latest"
    echo "ENGINE_RELEASE_SUPERSEDED_BY=$latest"
    echo "[engine-release-transaction] FORWARD TARGET BEHIND MAIN: latest engine $latest; target $SHA contains sealed high-water $high_water. The maintenance certificate and every cutover proof remain mandatory." >&2
  fi
}

parse_health_instance_for_sha() {
  local expected_sha="$1"
  EXPECTED_SHA="$expected_sha" python3 -c '
import json, os, re, sys
d=json.load(sys.stdin)
instance=d.get("instanceId")
ok=(d.get("running") is True and d.get("releaseSha")==os.environ["EXPECTED_SHA"] and d.get("liveness")=="ok" and isinstance(instance,str) and re.fullmatch(r"[1-9][0-9]*-[0-9a-f]{8}",instance))
if not ok: raise SystemExit(1)
print(instance)
' 2>/dev/null
}

health_instance_for_sha() {
  local url="$1" expected_sha="$2" response http_code body curl_timeout=15 proof_remaining
  if [ "${BREAK_END_EPOCH:-0}" -gt 0 ]; then
    proof_remaining="$(break_proof_seconds)" || return 1
    [ "$proof_remaining" -gt 1 ] || return 1
    curl_timeout=$((proof_remaining - 1))
    [ "$curl_timeout" -le 5 ] || curl_timeout=5
  fi
  response="$(curl -sS --max-time "$curl_timeout" -H 'Cache-Control: no-cache, no-store' \
    --write-out $'\n%{http_code}' "$url" 2>/dev/null)" || return 1
  http_code="${response##*$'\n'}"
  body="${response%$'\n'*}"
  [ "$http_code" = 200 ] || return 1
  printf '%s' "$body" | parse_health_instance_for_sha "$expected_sha"
}

parse_sealed_source_instance_for_sha() {
  EXPECTED_SHA="$1" python3 -c '
import json,os,re,sys
d=json.load(sys.stdin)
expected=os.environ["EXPECTED_SHA"]
instance=d.get("instanceId")
identity=(d.get("releaseSha")==expected) or ("releaseSha" not in d and d.get("version")==expected[:8])
ok=(d.get("running") is True and identity and d.get("liveness")=="ok" and isinstance(instance,str) and re.fullmatch(r"[1-9][0-9]*-[0-9a-f]{8}",instance))
if not ok: raise SystemExit(1)
print(instance)
' 2>/dev/null
}

source_instance_for_sha() {
  local url="$1" expected_sha="$2" response http_code body curl_timeout=15 proof_remaining
  if [ "${BREAK_END_EPOCH:-0}" -gt 0 ]; then
    proof_remaining="$(break_proof_seconds)" || return 1
    [ "$proof_remaining" -gt 1 ] || return 1
    curl_timeout=$((proof_remaining - 1))
    [ "$curl_timeout" -le 5 ] || curl_timeout=5
  fi
  # The serving rollback source may be non-routing-ready because an optional
  # subsystem is the defect this release replaces. Accept only a complete 200
  # or 503 response, then prove exact process identity and liveness from the
  # common JSON body. The caller first binds the image's unique full source
  # identity to the durable seal. Only this predecessor path may read the
  # absent-field legacy version; candidate/pre-commit/final stay strict.
  response="$(curl -sS --max-time "$curl_timeout" -H 'Cache-Control: no-cache, no-store' \
    --write-out $'\n%{http_code}' "$url" 2>/dev/null)" || return 1
  http_code="${response##*$'\n'}"
  body="${response%$'\n'*}"
  case "$http_code" in
    200|503) ;;
    *) return 1 ;;
  esac
  printf '%s' "$body" | parse_sealed_source_instance_for_sha "$expected_sha"
}

health_instance() {
  health_instance_for_sha "$1" "$SHA"
}

maintenance_certificate() {
  local response http_code body
  # A degraded optional subsystem can correctly make /health return 503 while
  # the engine is still running and has durably parked every table for this
  # certified break. Preserve that JSON so the certificate predicates below,
  # rather than curl's HTTP-success policy, remain the restart authority.
  response="$(curl -sS --max-time 10 --write-out $'\n%{http_code}' \
    http://127.0.0.1:8080/health 2>/dev/null)" || return 1
  http_code="${response##*$'\n'}"
  body="${response%$'\n'*}"
  case "$http_code" in
    200|503) ;;
    *) return 1 ;;
  esac
  printf '%s' "$body" | MIN_BREAK_MS="$MIN_BREAK_REMAINING_MS" python3 -c '
import json, sys
d=json.load(sys.stdin); m=d.get("maintenance")
remaining=int(m.get("remainingMs") or 0) if isinstance(m,dict) else 0
window=(d.get("running") is True and isinstance(m,dict) and m.get("active") is True and m.get("phase")=="counting_down" and m.get("durableConfirmed") is True)
if not window: raise SystemExit(1)
# A straggler can prevent restart certification for the entire real window.
# Record that missed opportunity separately from permission to cut over. Only
# this durable health observation qualifies; missing/unreadable health does not.
if remaining<int(__import__("os").environ["MIN_BREAK_MS"]):
    print(remaining)
    raise SystemExit(2)
ok=(m.get("readyForRestart") is True and m.get("unparkedTables")==0)
if not ok: raise SystemExit(1)
print(remaining)
' 2>/dev/null
}

# Entry to the exact predecessor's checkpoint, NOT restart authority. Its old
# unparked count combines physical hands with missing bank durability, and its
# saved-bank bit can remain true after the final announced write erased a row.
# The helper independently checks every physical table before writing. Only
# the unchanged maintenance_certificate below can admit a replacement.
legacy_checkpoint_countdown() {
  local response http_code body
  response="$(curl -sS --max-time 2 --write-out $'\n%{http_code}' \
    http://127.0.0.1:8080/health 2>/dev/null)" || return 1
  http_code="${response##*$'\n'}"
  body="${response%$'\n'*}"
  case "$http_code" in 200|503) ;; *) return 1 ;; esac
  printf '%s' "$body" | MIN_BREAK_MS="$MIN_BREAK_REMAINING_MS" python3 -c '
import json, math, os, sys, time
d=json.load(sys.stdin); m=d.get("maintenance")
if not isinstance(m,dict): raise SystemExit(1)
remaining=m.get("remainingMs"); ends=m.get("breakEndsAt")
valid_number=lambda n: isinstance(n,(int,float)) and not isinstance(n,bool) and math.isfinite(n)
if not (d.get("running") is True and m.get("active") is True and m.get("phase")=="counting_down" and m.get("durableConfirmed") is True and valid_number(remaining) and valid_number(ends)):
    raise SystemExit(1)
minimum=int(os.environ["MIN_BREAK_MS"])
if remaining<minimum or ends-time.time()*1000<minimum:
    raise SystemExit(1)
print(math.floor(ends/1000))
' 2>/dev/null
}

# This is one optional event in the existing bounded transaction, not a
# background retry owner. The immutable seal reservation survives SSH loss,
# systemd retries and unknown HTTP outcomes without sliding the break end.
RECOVERY_REQUESTED=0
RECOVERY_CHECKED_CAUSE=-1
RECOVERY_ADMISSION_MISSED=0
request_recovery_window() {
  local health minute stamp outcome
  local reserve_args
  [ "$RECOVERY_REQUESTED" = 0 ] || return 0
  minute=$(( ($(date +%s) % 3600) / 60 ))
  # Leave the normal announcement and its database buffer intact.
  [ "$minute" -ge 3 ] && [ "$minute" -lt 45 ] || return 0
  [ "$RECOVERY_CHECKED_CAUSE" != "$RECOVERY_ADMISSION_MISSED" ] || return 0
  health="$(curl -sS --max-time 5 http://127.0.0.1:8080/health 2>/dev/null)" || return 0
  printf '%s' "$health" | python3 -c '
import json,sys
d=json.load(sys.stdin); m=d.get("maintenance") or {}
raise SystemExit(0 if d.get("running") is True and m.get("active") is False and m.get("recoveryWindowReady") is True and m.get("recoveryWindowProtocol")=="engine-recovery-window-v1" else 1)
' || return 0
  acquire_engine_lock 'one recovery announcement'
  source_target_is_current
  if EXACT_INSTANCE="$(exact_runtime_instance)"; then
    emit_already_released "$EXACT_INSTANCE"
  fi
  reserve_args=(--sha "$SHA" --run-id "$RUN_ID" --repo "$REPO_DIR")
  [ "$RECOVERY_ADMISSION_MISSED" = 0 ] || reserve_args+=(--missed-window)
  if ! stamp="$(timeout --signal=TERM --kill-after=1s 15s "$RELEASE_SEAL" reserve-recovery-window \
    "${reserve_args[@]}")"; then
    release_engine_lock
    die 'recovery announcement reservation could not be established'
  fi
  RECOVERY_CHECKED_CAUSE="$RECOVERY_ADMISSION_MISSED"
  if [ "$stamp" = unavailable ]; then
    release_engine_lock
    return 0
  fi
  [[ "$stamp" =~ ^[1-9][0-9]{12}$ ]] || die 'invalid recovery announcement timestamp'
  RECOVERY_REQUESTED=1
  # The configured key stays inside the running engine container. The API is
  # loopback-only and has the same maintenance/database owner as hourly work.
  # A lost response is UNKNOWN; observe the certificate, never allocate a new
  # timestamp or send another announcement in this invocation.
  outcome="$(timeout --signal=TERM --kill-after=1s 20s docker exec -i "$CONTAINER" \
    node - "$stamp" <<'NODE'
const announcedAt=Number(process.argv[2]);
const key=process.env.INTERNAL_API_KEY;
if (!key) process.exit(1);
fetch('http://127.0.0.1:8080/internal/maintenance-recovery-window', {
  method:'POST', headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},
  body:JSON.stringify({announcedAt}), signal:AbortSignal.timeout(15000)
}).then(async r=>{
  const d=await r.json();
  if (!r.ok || !['accepted','active','pending','busy','expired','use_hourly','unavailable'].includes(d.status)) process.exit(1);
  console.log(d.status);
}).catch(()=>process.exit(1));
NODE
)" || outcome=unknown
  release_engine_lock
  echo "[engine-release-transaction] fixed recovery announcement $stamp: $outcome; existing certificate and rollback budget remain required"
}

persist_break_deadline() {
  local temporary
  temporary="$REQUEST_ROOT/.$RUN_ID.break-deadline.$$"
  trap 'rm -f -- "${temporary:-}"' RETURN
  umask 077
  printf '%s\n' "$BREAK_END_EPOCH" > "$temporary"
  bounded_break_command 10 python3 - "$temporary" "$REQUEST_ROOT" <<'PY'
import os, sys
for path in sys.argv[1:]:
    flags = os.O_RDONLY | (getattr(os, "O_DIRECTORY", 0) if os.path.isdir(path) else 0)
    fd = os.open(path, flags)
    try: os.fsync(fd)
    finally: os.close(fd)
PY
  bounded_break_command 10 mv -fT -- "$temporary" "$BREAK_DEADLINE_FILE"
  bounded_break_command 10 python3 - "$REQUEST_ROOT" <<'PY'
import os, sys
fd = os.open(sys.argv[1], os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try: os.fsync(fd)
finally: os.close(fd)
PY
  trap - RETURN
}

clear_break_deadline() {
  local remaining
  remaining=$((BREAK_END_EPOCH - $(date +%s)))
  [ "$remaining" -gt 2 ] || return 1
  [ "$remaining" -le 10 ] || remaining=10
  timeout --signal=TERM --kill-after=1s "${remaining}s" rm -f -- "$BREAK_DEADLINE_FILE" \
    || return 1
  remaining=$((BREAK_END_EPOCH - $(date +%s)))
  [ "$remaining" -gt 2 ] || return 1
  [ "$remaining" -le 10 ] || remaining=10
  timeout --signal=TERM --kill-after=1s "${remaining}s" python3 - "$REQUEST_ROOT" <<'PY'
import os, sys
fd = os.open(sys.argv[1], os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try: os.fsync(fd)
finally: os.close(fd)
PY
}

break_proof_seconds() {
  local remaining=$((BREAK_END_EPOCH - $(date +%s) - BREAK_ROLLBACK_RESERVE_SECONDS))
  [ "$remaining" -gt 0 ] || return 1
  printf '%s\n' "$remaining"
}

assert_break_proof_time() {
  break_proof_seconds >/dev/null \
    || die 'maintenance break no longer has the reserved proof and rollback budget'
}

bounded_break_command() {
  local requested="$1" proof_remaining overall_remaining allowed
  shift
  proof_remaining="$(break_proof_seconds)" || return 124
  overall_remaining="$(remaining_seconds)" || return 124
  [ "$proof_remaining" -le "$overall_remaining" ] \
    || proof_remaining="$overall_remaining"
  # GNU timeout may spend one additional second between TERM and KILL. Leave
  # another second for the shell to enter the recovery trap before the fixed
  # rollback reserve begins.
  [ "$proof_remaining" -gt 2 ] || return 124
  allowed=$((proof_remaining - 2))
  [ "$requested" -le "$allowed" ] || requested="$allowed"
  timeout --signal=TERM --kill-after=1s "${requested}s" "$@"
}

persist_result() {
  local result="$1" instance="$2" image_id container_id started_at recorded result_timeout
  local -a recovery_args=()
  result_timeout=10
  if [ "$result" = already-released ] && [ "${BREAK_END_EPOCH:-0}" -eq 0 ]; then
    # Only the existing duplicate-completion event can retire an orphaned
    # foreign finalization; the seal independently proves both native owners,
    # the actual inherited lock and fresh same-image runtime/database proof.
    recovery_args=(--recover-orphan-finalization-fd 9)
    result_timeout="$(remaining_seconds)" || die 'deadline expired before completion proof'
    [ "$result_timeout" -le 60 ] || result_timeout=60
  fi
  if [ "${BREAK_END_EPOCH:-0}" -gt 0 ]; then
    image_id="$(bounded_break_command 10 "$RELEASE_SEAL" get desired-image-id)"
    container_id="$(bounded_break_command 10 docker container inspect -f '{{.Id}}' "$CONTAINER")"
    started_at="$(bounded_break_command 10 docker container inspect -f '{{.State.StartedAt}}' "$CONTAINER")"
  else
    image_id="$(timeout --signal=TERM --kill-after=2s 10s \
      "$RELEASE_SEAL" get desired-image-id)"
    container_id="$(timeout --signal=TERM --kill-after=2s 10s \
      docker container inspect -f '{{.Id}}' "$CONTAINER")"
    started_at="$(timeout --signal=TERM --kill-after=2s 10s \
      docker container inspect -f '{{.State.StartedAt}}' "$CONTAINER")"
  fi
  [[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || die 'result container ID is invalid'
  [ -n "$started_at" ] || die 'result container start generation is missing'
  if [ "${BREAK_END_EPOCH:-0}" -gt 0 ]; then
    recorded="$(bounded_break_command 10 "$RELEASE_SEAL" record-result \
      --sha "$SHA" --image-id "$image_id" --result "$result" \
      --instance-id "$instance" --container-id "$container_id" --started-at "$started_at" \
      --run-id "$RUN_ID" --control-sha "$CONTROL_SHA" --invocation-id "$INVOCATION_ID")" \
      || die 'durable per-run release result could not be recorded'
  else
    recorded="$(timeout --signal=TERM --kill-after=2s "${result_timeout}s" \
      "$RELEASE_SEAL" record-result \
      --sha "$SHA" --image-id "$image_id" --result "$result" \
      --instance-id "$instance" --container-id "$container_id" --started-at "$started_at" \
      --run-id "$RUN_ID" --control-sha "$CONTROL_SHA" --invocation-id "$INVOCATION_ID" \
      "${recovery_args[@]}")" \
      || die 'durable per-run release result could not be recorded'
  fi
  case "$recorded" in sealed|already-released) ;; *) die 'durable result returned an invalid outcome' ;; esac
  echo "ENGINE_RELEASE_RESULT=$recorded"
  echo "ENGINE_RELEASE_SHA=$SHA"
  echo "ENGINE_RELEASE_IMAGE_ID=$image_id"
  echo "ENGINE_RELEASE_CONTAINER_ID=$container_id"
  echo "ENGINE_RELEASE_STARTED_AT=$started_at"
}

exact_runtime_instance() {
  local desired desired_image actual actual_image state local_instance public_instance
  desired="$($RELEASE_SEAL get desired-sha 2>/dev/null)" || return 1
  [ "$desired" = "$SHA" ] || return 1
  desired_image="$($RELEASE_SEAL get desired-image-id 2>/dev/null)" || return 1
  actual="$(docker container inspect -f '{{index .Config.Labels "sp.release.sha"}}' "$CONTAINER" 2>/dev/null)" || return 1
  state="$(docker container inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null)" || return 1
  actual_image="$(docker container inspect -f '{{.Image}}' "$CONTAINER" 2>/dev/null)" || return 1
  [ "$actual" = "$SHA" ] && [ "$state" = running ] && [ "$actual_image" = "$desired_image" ] \
    || return 1
  local_instance="$(health_instance 'http://127.0.0.1:8080/health')" || return 1
  public_instance="$(health_instance "$PUBLIC_URL/health?nocache=$(date +%s%N)")" || return 1
  [ "$local_instance" = "$public_instance" ] || return 1
  printf '%s\n' "$local_instance"
}

prove_rollback_readiness() {
  local rollback_sha rollback_image rollback_legacy rollback_cid rollback_started_at
  local actual_image actual_release state autoheal_label role_label restart_policy autoheal_state
  local local_instance public_instance final_cid final_started_at final_local final_public image_source

  [ -s "$ENV_FILE" ] || die 'rollback readiness refused an absent or empty engine environment'
  if grep -Eq '^[[:space:]]*(GIT_COMMIT_SHA|ENGINE_VERSION)[[:space:]]*=' "$ENV_FILE"; then
    die 'rollback readiness refused a reserved image-version override in the engine environment'
  fi
  bounded_break_command 8 docker info >/dev/null \
    || die 'rollback readiness could not reach Docker before mutation'
  rollback_sha="$(bounded_break_command 8 "$RELEASE_SEAL" get desired-sha)" \
    || die 'rollback readiness could not read the sealed desired SHA'
  rollback_image="$(bounded_break_command 8 "$RELEASE_SEAL" get desired-image-id)" \
    || die 'rollback readiness could not read the sealed desired image'
  rollback_legacy="$(bounded_break_command 8 "$RELEASE_SEAL" get desired-legacy-unlabelled)" \
    || die 'rollback readiness could not read the sealed legacy state'
  [[ "$rollback_sha" =~ ^[0-9a-f]{40}$ ]] \
    && [[ "$rollback_image" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || die 'rollback readiness found an invalid sealed desired identity'
  case "$rollback_legacy" in true|false) ;; *) die 'rollback readiness found invalid legacy state' ;; esac
  bounded_break_command 8 docker image inspect "$rollback_image" >/dev/null \
    || die 'rollback readiness found the sealed desired image absent'
  image_source="$(bounded_break_command 8 docker image inspect \
    --format '{{json .Config.Env}}' "$rollback_image" | python3 -c '
import json,re,sys
entries=json.load(sys.stdin)
if not isinstance(entries,list): raise SystemExit(1)
values=[v.split("=",1)[1] for v in entries if isinstance(v,str) and v.startswith("GIT_COMMIT_SHA=")]
if len(values)!=1 or not re.fullmatch(r"[0-9a-f]{40}",values[0]): raise SystemExit(1)
print(values[0])
')" || die 'rollback readiness found no unique full image source'
  [ "$image_source" = "$rollback_sha" ] \
    || die 'rollback readiness found image source different from the durable seal'

  rollback_cid="$(bounded_break_command 8 docker container inspect -f '{{.Id}}' "$CONTAINER")" \
    || die 'rollback readiness could not identify the serving desired container'
  rollback_started_at="$(bounded_break_command 8 docker container inspect -f '{{.State.StartedAt}}' "$CONTAINER")" \
    || die 'rollback readiness could not identify the serving desired generation'
  actual_image="$(bounded_break_command 8 docker container inspect -f '{{.Image}}' "$CONTAINER")"
  actual_release="$(bounded_break_command 8 docker container inspect -f '{{index .Config.Labels "sp.release.sha"}}' "$CONTAINER")"
  state="$(bounded_break_command 8 docker container inspect -f '{{.State.Status}}' "$CONTAINER")"
  autoheal_label="$(bounded_break_command 8 docker container inspect -f '{{index .Config.Labels "autoheal"}}' "$CONTAINER")"
  role_label="$(bounded_break_command 8 docker container inspect -f '{{index .Config.Labels "sp.role"}}' "$CONTAINER")"
  restart_policy="$(bounded_break_command 8 docker container inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$CONTAINER")"
  autoheal_state="$(bounded_break_command 8 docker container inspect -f '{{.State.Status}}' sp-autoheal)"
  [[ "$rollback_cid" =~ ^[0-9a-f]{64}$ ]] && [ -n "$rollback_started_at" ] \
    && [ "$actual_image" = "$rollback_image" ] && [ "$state" = running ] \
    && { [ "$actual_release" = "$rollback_sha" ] \
      || { [ "$rollback_legacy" = true ] && [ -z "$actual_release" ]; }; } \
    && [ "$autoheal_label" = true ] && [ "$role_label" = engine ] \
    && [ "$restart_policy" = always ] && [ "$autoheal_state" = running ] \
    || die 'rollback readiness found the sealed desired run specification inexact or not live'

  local_instance="$(source_instance_for_sha 'http://127.0.0.1:8080/health' "$rollback_sha")" \
    || die 'rollback readiness found no exact desired local identity and liveness'
  public_instance="$(source_instance_for_sha "$PUBLIC_URL/health?nocache=$(date +%s%N)" "$rollback_sha")" \
    || die 'rollback readiness found no exact desired public identity and liveness'
  [ "$local_instance" = "$public_instance" ] \
    || die 'rollback readiness found different local and public desired processes'
  bounded_break_command 18 "$DATABASE_PROOF" --env-file "$ENV_FILE" \
    --sha "$rollback_sha" --instance-id "$local_instance" --timeout-seconds 15 \
    --poll-seconds 3 --max-heartbeat-age-seconds 15 \
    || die 'rollback readiness found no fresh exact desired database leader'

  final_cid="$(bounded_break_command 8 docker container inspect -f '{{.Id}}' "$CONTAINER")"
  final_started_at="$(bounded_break_command 8 docker container inspect -f '{{.State.StartedAt}}' "$CONTAINER")"
  final_local="$(source_instance_for_sha 'http://127.0.0.1:8080/health' "$rollback_sha")" \
    || die 'rollback readiness lost exact desired local identity and liveness'
  final_public="$(source_instance_for_sha "$PUBLIC_URL/health?nocache=$(date +%s%N)" "$rollback_sha")" \
    || die 'rollback readiness lost exact desired public identity and liveness'
  [ "$final_cid" = "$rollback_cid" ] && [ "$final_started_at" = "$rollback_started_at" ] \
    && [ "$final_local" = "$local_instance" ] && [ "$final_public" = "$local_instance" ] \
    || die 'rollback readiness changed generation during its proof'
  echo "[engine-release-transaction] exact desired rollback source $rollback_sha is live locally and publicly with a fresh database leader as $local_instance"
}

emit_already_released() {
  local instance="$1" remaining proof_timeout
  remaining="$(remaining_seconds)" || die 'deadline expired before duplicate database proof'
  proof_timeout="$remaining"
  [ "$proof_timeout" -le 45 ] || proof_timeout=45
  [ "$proof_timeout" -ge 17 ] || die 'insufficient time for duplicate database proof'
  proof_timeout=$((proof_timeout - 2))
  timeout --signal=TERM --kill-after=1s "${proof_timeout}s" \
    "$DATABASE_PROOF" --env-file "$ENV_FILE" --sha "$SHA" --instance-id "$instance" \
    --timeout-seconds "$proof_timeout" --poll-seconds 5 \
    || die 'exact runtime is not the freshly elected database leader'
  persist_result already-released "$instance"
  exit 0
}

create_image_lease() {
  local temporary existing
  install -d -m 0700 "$LEASE_ROOT"
  python3 - "$LEASE_ROOT" "$(dirname "$LEASE_ROOT")" <<'PY'
import os, sys
for path in sys.argv[1:]:
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try: os.fsync(fd)
    finally: os.close(fd)
PY
  temporary="$LEASE_ROOT/.$RUN_ID.lease.$$"
  trap 'rm -f -- "${temporary:-}"' RETURN
  umask 077
  printf '%s\n' "$SHA" > "$temporary"
  python3 - "$temporary" "$LEASE_ROOT" <<'PY'
import os, sys
for path in sys.argv[1:]:
    fd = os.open(path, os.O_RDONLY | (getattr(os, "O_DIRECTORY", 0) if os.path.isdir(path) else 0))
    try: os.fsync(fd)
    finally: os.close(fd)
PY
  if ! ln -- "$temporary" "$LEASE_FILE" 2>/dev/null; then
    mapfile -t existing < "$LEASE_FILE" || die 'existing image lease is unreadable'
    [ "${#existing[@]}" = 1 ] && [ "${existing[0]}" = "$SHA" ] \
      || die 'this run key already leases a different image SHA'
  fi
  rm -f -- "$temporary"
  python3 - "$LEASE_ROOT" <<'PY'
import os, sys
fd = os.open(sys.argv[1], os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try: os.fsync(fd)
finally: os.close(fd)
PY
  trap - RETURN
}

validate_candidate_image() {
  local identity
  identity="$(bounded_break_command 10 docker image inspect --format '{{json .}}' "$IMAGE_REF")" \
    || die 'candidate image tag is absent'
  mapfile -t IMAGE_FIELDS < <(printf '%s' "$identity" \
    | EXPECTED_SHA="$SHA" EXPECTED_TREE="$EXPECTED_SERVER_TREE" python3 -c '
import json, os, re, sys
d=json.load(sys.stdin)
labels=(d.get("Config") or {}).get("Labels") or {}
image_id=str(d.get("Id") or "")
revision=str(labels.get("org.opencontainers.image.revision") or "")
tree=str(labels.get("com.smarterpoker.engine.source-tree") or "")
contract=str(labels.get("com.smarterpoker.engine.build-contract") or "")
ok=(re.fullmatch(r"sha256:[0-9a-f]{64}",image_id) and revision==os.environ["EXPECTED_SHA"] and tree==os.environ["EXPECTED_TREE"] and contract=="clean-server-archive-v1")
if not ok: raise SystemExit(1)
print(image_id)
print(revision)
print(tree)
print(contract)
' 2>/dev/null) || die 'candidate image identity or provenance is invalid'
  [ "${#IMAGE_FIELDS[@]}" = 4 ] || die 'candidate image identity has an invalid field count'
  TARGET_IMAGE_ID="${IMAGE_FIELDS[0]}"
}

read_pending_owner() {
  local description remaining
  if [ "${BREAK_END_EPOCH:-0}" -gt 0 ]; then
    description="$(bounded_break_command 10 "$RELEASE_SEAL" pending-owner)" \
      || die 'release seal pending owner exceeded the shared break deadline'
  else
    remaining="$(remaining_seconds)" || die 'deadline expired before pending-owner read'
    [ "$remaining" -le 10 ] || remaining=10
    description="$(timeout --signal=TERM --kill-after=1s "${remaining}s" \
      "$RELEASE_SEAL" pending-owner)" \
      || die 'bounded release seal pending owner is unreadable'
  fi
  PENDING_STATE=''
  PENDING_RUN=''
  PENDING_USED=''
  PENDING_EXPIRES=''
  PENDING_EXTRA=''
  read -r PENDING_STATE PENDING_RUN PENDING_USED PENDING_EXPIRES PENDING_EXTRA <<< "$description"
  if [ "$PENDING_STATE" = none ]; then
    [ -z "$PENDING_RUN$PENDING_USED$PENDING_EXPIRES$PENDING_EXTRA" ] \
      || die 'release seal returned a malformed empty pending owner'
    return
  fi
  case "$PENDING_STATE" in active|expired) ;; *) die 'release seal returned an invalid pending lifecycle' ;; esac
  [[ "$PENDING_RUN" =~ ^[1-9][0-9]*(-[1-9][0-9]*)?$ ]] \
    || die 'release seal returned an invalid pending run key'
  case "$PENDING_USED" in true|false) ;; *) die 'release seal returned an invalid pending use state' ;; esac
  [[ "$PENDING_EXPIRES" =~ ^[1-9][0-9]*$ ]] && [ -z "$PENDING_EXTRA" ] \
    || die 'release seal returned an invalid pending expiry'
}

recover_pending_owner() {
  local owner="$1" abort_rc recovery_deadline recovery_remaining non_break_deadline
  MUTATION_STARTED=1
  recovery_deadline="${BREAK_END_EPOCH:-$DEADLINE}"
  if [ "${BREAK_END_EPOCH:-0}" -eq 0 ]; then
    non_break_deadline=$(( $(date +%s) + NON_BREAK_RECOVERY_MAX_SECONDS ))
    [ "$recovery_deadline" -le "$non_break_deadline" ] || recovery_deadline="$non_break_deadline"
  fi
  set +e
  recovery_remaining=$((recovery_deadline - $(date +%s)))
  if [ "$recovery_remaining" -gt 2 ]; then
    [ "$recovery_remaining" -le 10 ] || recovery_remaining=10
    timeout --signal=TERM --kill-after=1s "${recovery_remaining}s" \
      "$RELEASE_SEAL" abort --run-id "$owner"
  else
    false
  fi
  abort_rc=$?
  set -e
  recovery_remaining=$((recovery_deadline - $(date +%s)))
  [ "$recovery_remaining" -gt 2 ] \
    || die "pending release $owner exhausted its exact desired recovery deadline"
  if [ "${BREAK_END_EPOCH:-0}" -gt 0 ]; then
    [ "$recovery_remaining" -le "$BREAK_ROLLBACK_RESERVE_SECONDS" ] \
      || recovery_remaining="$BREAK_ROLLBACK_RESERVE_SECONDS"
  else
    [ "$recovery_remaining" -le "$NON_BREAK_RECOVERY_MAX_SECONDS" ] \
      || recovery_remaining="$NON_BREAK_RECOVERY_MAX_SECONDS"
  fi
  timeout --signal=TERM --kill-after=1s "${recovery_remaining}s" env \
    ENGINE_SUPERVISOR_LOCK_HELD=1 ENGINE_SUPERVISOR_FORCE_DESIRED=1 \
    ENGINE_SUPERVISOR_REQUIRE_EXACT_HEALTH=1 \
    ENGINE_RECOVERY_DEADLINE_EPOCH="$recovery_deadline" \
    ENGINE_CONTROL_DIR="$CONTROL_DIR" CONTAINER="$CONTAINER" ENGINE_URL="$PUBLIC_URL" \
    "$CONTROL_DIR/engine-supervisor.sh" \
    || die "pending release $owner did not restore exact desired local and public health before its recovery deadline"
  [ "$abort_rc" -eq 0 ] \
    || die "pending release $owner was recovered but its abort audit failed"
}

# A duplicate dispatch is certified immediately. It cannot wait for a later
# maintenance break, and HTTP identity alone is not enough: the exact process
# must also be the fresh elected database leader.
acquire_engine_lock 'duplicate certification'
while :; do
  read_pending_owner
  # A boot-resumed unit owns its exact interrupted receipt. Expired receipts
  # and this run's interrupted receipt are recovered before Git/network work.
  if [ "$PENDING_STATE" = expired ] \
    || { [ "$PENDING_STATE" = active ] && [ "$PENDING_RUN" = "$RUN_ID" ]; }; then
    recover_pending_owner "$PENDING_RUN"
    continue
  fi
  [ "$PENDING_STATE" = active ] || break

  # Never leave a terminal foreign candidate with restart disabled while this
  # run builds or waits for a table break. A genuinely live owner gets a
  # bounded chance to finish; a missing/terminal owner is repaired now.
  FOREIGN_STATE="$(systemctl show "club-arena-engine-release-v1@$PENDING_RUN.service" \
    -p ActiveState --value 2>/dev/null || true)"
  case "$FOREIGN_STATE" in
    active|activating|deactivating)
      release_engine_lock
      bounded_sleep 15
      acquire_engine_lock 'prior release completion'
      ;;
    *)
      recover_pending_owner "$PENDING_RUN"
      ;;
  esac
done
# Commit/abort responses can be interrupted after the fsynced seal mutation
# and before restart policy or desired-container restoration. With no foreign
# pending candidate, repair the sealed desired runtime immediately under the
# mutation lock—never build or wait for another hourly break while service is
# absent merely because a prior response was lost.
MUTATION_STARTED=1
PREWORK_RECOVERY_REMAINING="$(remaining_seconds)" \
  || die 'deadline expired before sealed desired runtime recovery'
[ "$PREWORK_RECOVERY_REMAINING" -le "$NON_BREAK_RECOVERY_MAX_SECONDS" ] \
  || PREWORK_RECOVERY_REMAINING="$NON_BREAK_RECOVERY_MAX_SECONDS"
PREWORK_RECOVERY_DEADLINE=$(( $(date +%s) + PREWORK_RECOVERY_REMAINING ))
timeout --signal=TERM --kill-after=1s "${PREWORK_RECOVERY_REMAINING}s" env \
  ENGINE_SUPERVISOR_LOCK_HELD=1 ENGINE_SUPERVISOR_FORCE_DESIRED=1 \
  ENGINE_SUPERVISOR_REQUIRE_EXACT_HEALTH=1 \
  ENGINE_RECOVERY_DEADLINE_EPOCH="$PREWORK_RECOVERY_DEADLINE" \
  ENGINE_CONTROL_DIR="$CONTROL_DIR" CONTAINER="$CONTAINER" ENGINE_URL="$PUBLIC_URL" \
  "$CONTROL_DIR/engine-supervisor.sh" \
  || die 'sealed desired runtime could not be restored before release work'
MUTATION_STARTED=0
# Once this exact run crossed the fsynced commit boundary, mutable protected
# main can no longer decide whether its missing result receipt is recoverable.
# Certify the restored exact runtime and elected-leader identity first. This is
# deliberately run-owned: an ordinary duplicate still has to pass freshness.
COMMITTED_IMAGE="$(timeout --signal=TERM --kill-after=2s 10s \
  "$RELEASE_SEAL" get desired-image-id)" \
  || die 'durable desired image is unreadable before committed-run replay'
if "$RELEASE_SEAL" attest-commit \
  --sha "$SHA" --image-id "$COMMITTED_IMAGE" --run-id "$RUN_ID" >/dev/null 2>&1; then
  EXACT_INSTANCE="$(exact_runtime_instance)" \
    || die 'this run committed, but its exact serving runtime could not be certified'
  emit_already_released "$EXACT_INSTANCE"
fi
[ "$(date +%s)" -lt "$MUTATION_DEADLINE_EPOCH" ] \
  || die 'immutable release not-after epoch expired before new release mutation'
source_target_is_current
if EXACT_INSTANCE="$(exact_runtime_instance)"; then
  emit_already_released "$EXACT_INSTANCE"
fi
release_engine_lock

# The durable unit, not the SSH session, owns image construction. The outer
# timeout bounds both the host build-lock wait and Docker itself. A source
# check after the build repeats protected-main containment and the sealed
# high-water ordering before the candidate waits for a certified table break.
assert_time_remaining
create_image_lease
# The builder owns up to 1,800s of FIFO lock wait and 1,500s of bounded Docker
# work. Its parent must cover both phases; otherwise a current SHA queued
# behind a stale long build can be killed five minutes into its own build and
# leave no surviving release for the next certified break.
BUILD_REMAINING="$(remaining_seconds)" \
  || die 'immutable release not-after epoch expired before image construction'
[ "$BUILD_REMAINING" -gt 16 ] \
  || die 'immutable release not-after epoch has no bounded image-build budget'
BUILD_TIMEOUT=$((BUILD_REMAINING - 16))
[ "$BUILD_TIMEOUT" -le 3450 ] || BUILD_TIMEOUT=3450
timeout --signal=TERM --kill-after=15s "${BUILD_TIMEOUT}s" \
  "$IMAGE_BUILDER" "$REPO_DIR" "$SHA" "$IMAGE_REF" \
  || die 'bounded immutable engine image build failed'
source_target_is_current
NEXT_FRESHNESS_CHECK=$(( $(date +%s) + 60 ))
# This is a compatibility operation for one immutable predecessor, not a
# general checkpoint API. The helper rebinds the seal/image/process under the
# engine lock immediately before its one durable intent and checkpoint.
CHECKPOINT_PREDECESSOR_SHA="$(timeout --signal=TERM --kill-after=1s 10s \
  "$RELEASE_SEAL" get desired-sha)" || die 'sealed checkpoint predecessor is unreadable'
LEGACY_CHECKPOINT_REQUIRED=0
if [ "$CHECKPOINT_PREDECESSOR_SHA" = "$LEGACY_CHECKPOINT_SHA" ]; then
  LEGACY_CHECKPOINT_REQUIRED=1
fi

while :; do
  [ "$(date +%s)" -lt "$CERTIFICATE_DEADLINE" ] \
    || die 'the engine did not present a restart certificate with enough proof time remaining'
  if [ "$(date +%s)" -ge "$NEXT_FRESHNESS_CHECK" ]; then
    # Recheck containment and sealed high-water while waiting. A newer sealed
    # release revokes an older target; a newer unshipped merge alone does not.
    source_target_is_current
    NEXT_FRESHNESS_CHECK=$(( $(date +%s) + 60 ))
  fi
  set +e
  BREAK_REMAINING_MS="$(maintenance_certificate)"
  CERTIFICATE_RC=$?
  set -e
  if [ "$LEGACY_CHECKPOINT_REQUIRED" = 1 ]; then
    # Counting down follows the final announcement. Run even when the old
    # certificate says ready: that predecessor can retain a stale saved bit.
    if ! LEGACY_COUNTDOWN_END="$(legacy_checkpoint_countdown)"; then
      bounded_sleep 5
      continue
    fi
  elif [ "$CERTIFICATE_RC" -eq 2 ]; then
    RECOVERY_ADMISSION_MISSED=1
    # A predecessor or image build can consume the beginning of this break.
    # No prepare or break deadline exists yet. Keep the original request's
    # absolute deadline and source-freshness checks while waiting for a later
    # complete certificate; never reduce the candidate-and-recovery reserve.
    echo "[engine-release-transaction] the durable table break has ${BREAK_REMAINING_MS:-0}ms remaining, below the ${MIN_BREAK_REMAINING_MS}ms candidate-and-recovery budget; refusing before mutation and waiting for a later certificate"
    bounded_sleep 15
    continue
  fi
  if [ "$LEGACY_CHECKPOINT_REQUIRED" != 1 ] && [ "$CERTIFICATE_RC" -ne 0 ]; then
    request_recovery_window
    bounded_sleep 5
    continue
  fi

  acquire_engine_lock 'maintenance cutover'
  source_target_is_current
  if EXACT_INSTANCE="$(exact_runtime_instance)"; then
    emit_already_released "$EXACT_INSTANCE"
  fi
  if [ "$LEGACY_CHECKPOINT_REQUIRED" = 1 ]; then
    CHECKPOINT_PREDECESSOR_SHA="$(timeout --signal=TERM --kill-after=1s 10s \
      "$RELEASE_SEAL" get desired-sha)" || die 'locked checkpoint predecessor is unreadable'
    if [ "$CHECKPOINT_PREDECESSOR_SHA" != "$LEGACY_CHECKPOINT_SHA" ]; then
      # A different release may have advanced desired while this run waited.
      # Source/high-water admission above still owns whether our target may
      # follow it. Never apply the old-image compatibility path to its successor.
      LEGACY_CHECKPOINT_REQUIRED=0
    fi
  fi
  if [ "$LEGACY_CHECKPOINT_REQUIRED" = 1 ]; then
    if ! LEGACY_COUNTDOWN_END="$(legacy_checkpoint_countdown)"; then
      release_engine_lock
      bounded_sleep 5
      continue
    fi
    [ "$LEGACY_CHECKPOINT_ATTEMPTED" = 0 ] \
      || die 'legacy checkpoint was already attempted; refusing a retry'
    # This provisional deadline bounds predecessor proof only. It is not
    # persisted as a cutover certificate. Checkpoint cleanup may consume entry
    # slack; it must complete before the strict 285000ms certificate is read.
    BREAK_END_EPOCH="$LEGACY_COUNTDOWN_END"
    prove_rollback_readiness
    LEGACY_CHECKPOINT_ATTEMPTED=1
    "$LEGACY_CHECKPOINT" "$RUN_ID" \
      || die 'legacy checkpoint or cleanup refused; release cannot continue'
    BREAK_END_EPOCH=0
  fi
  set +e
  BREAK_REMAINING_MS="$(maintenance_certificate)"
  CERTIFICATE_RC=$?
  set -e
  if [ "$LEGACY_CHECKPOINT_ATTEMPTED" = 1 ] && [ "$CERTIFICATE_RC" -ne 0 ]; then
    die 'legacy checkpoint did not retain the full restart certificate and 285000ms reserve'
  fi
  if [ "$CERTIFICATE_RC" -eq 2 ]; then
    RECOVERY_ADMISSION_MISSED=1
    release_engine_lock
    echo "[engine-release-transaction] the locked table break has ${BREAK_REMAINING_MS:-0}ms remaining, below the ${MIN_BREAK_REMAINING_MS}ms candidate-and-recovery budget; waiting for a later certificate"
    bounded_sleep 15
    continue
  fi
  if [ "$CERTIFICATE_RC" -ne 0 ]; then
    release_engine_lock
    bounded_sleep 15
    continue
  fi
  BREAK_END_EPOCH=$(( $(date +%s) + (BREAK_REMAINING_MS / 1000) ))
  persist_break_deadline
  assert_break_proof_time

  # The five-minute lane is conditional on an immediately measurable live,
  # exact rollback source with a fresh elected database leader.
  # It is not pre-started. This proof is deliberately before
  # prepare, token consumption, autoheal fencing, or serving-process replacement.
  prove_rollback_readiness
  validate_candidate_image
  STRANGERS="$(bounded_break_command 10 docker ps --filter label=sp.role=engine --format '{{.Names}}' \
    | grep -v "^$CONTAINER$" || true)"
  [ -z "$STRANGERS" ] || die 'an unmanaged engine container is running on this host'

  set +e
  PREPARE_OUTPUT="$(bounded_break_command 10 "$RELEASE_SEAL" prepare \
    --sha "$SHA" --image "$TARGET_IMAGE_ID" --mode deploy --repo "$REPO_DIR" \
    --run-id "$RUN_ID" --run-url "$RUN_URL" --actor "$ACTOR" \
    --reason 'normal protected-main engine release' 2>&1)"
  PREPARE_RC=$?
  set -e
  if [ "$PREPARE_RC" -eq 0 ]; then
    TOKEN="$PREPARE_OUTPUT"
    break
  fi

  read_pending_owner
  FOREIGN_RUN="$PENDING_RUN"
  if [ "$PENDING_STATE" != active ]; then
    die 'release seal refused the candidate (output withheld because the prepare channel may contain a token)'
  fi
  if [ "$FOREIGN_RUN" = "$RUN_ID" ]; then
    # The prepare process may have been interrupted after fsyncing its receipt
    # but before returning the one-use token. No candidate can have consumed a
    # token this shell never received, so clear exactly this run and retry from
    # a fresh certified boundary instead of waiting on itself until expiry.
    recover_pending_owner "$RUN_ID"
    MUTATION_STARTED=0
    release_engine_lock
    clear_break_deadline || die 'could not durably retire the abandoned break deadline'
    BREAK_END_EPOCH=0
    continue
  fi
  FOREIGN_STATE="$(bounded_break_command 5 systemctl show "club-arena-engine-release-v1@$FOREIGN_RUN.service" \
    -p ActiveState --value 2>/dev/null || true)"
  case "$FOREIGN_STATE" in
    active|activating|deactivating)
      echo "[engine-release-transaction] prior release $FOREIGN_RUN is $FOREIGN_STATE; yielding the engine lock"
      release_engine_lock
      clear_break_deadline || die 'could not durably retire the yielded break deadline'
      BREAK_END_EPOCH=0
      bounded_sleep 15
      ;;
    *)
      # The previous unit is terminal or missing but its exact pending receipt
      # survived a crash. Clear only that owner, restore the durable desired
      # release under this already-held engine lock, then re-read the break.
      recover_pending_owner "$FOREIGN_RUN"
      MUTATION_STARTED=0
      release_engine_lock
      clear_break_deadline || die 'could not durably retire the recovered break deadline'
      BREAK_END_EPOCH=0
      ;;
  esac
done

[[ "$TOKEN" =~ ^[0-9a-f]{64}$ ]] || die 'release seal did not issue a valid one-use token'
PREPARED=1
MUTATION_STARTED=1
assert_time_remaining
assert_break_proof_time

bounded_break_command 10 docker container inspect sp-autoheal >/dev/null
bounded_break_command 20 docker stop -t 15 sp-autoheal >/dev/null
[ "$(bounded_break_command 10 docker container inspect -f '{{.State.Status}}' sp-autoheal)" = exited ] \
  || die 'autoheal did not stop before the compatibility trial'

bounded_break_command 75 env \
  ENGINE_UP_LOCK_HELD=1 ENGINE_RELEASE_TOKEN_FD=3 IMAGE="$TARGET_IMAGE_ID" \
  CONTAINER="$CONTAINER" ENV_FILE="$ENV_FILE" "$ENGINE_UP" 3<<<"$TOKEN" \
  || die 'candidate replacement exceeded its bounded cutover budget'
unset TOKEN

CANDIDATE_CID="$(bounded_break_command 10 docker container inspect -f '{{.Id}}' "$CONTAINER")"
CANDIDATE_STARTED_AT="$(bounded_break_command 10 docker container inspect -f '{{.State.StartedAt}}' "$CONTAINER")"
[[ "$CANDIDATE_CID" =~ ^[0-9a-f]{64}$ ]] || die 'candidate container ID is invalid'
[ -n "$CANDIDATE_STARTED_AT" ] || die 'candidate start generation is missing'

for attempt in $(seq 1 36); do
  assert_time_remaining
  assert_break_proof_time
  CANDIDATE_INSTANCE="$(health_instance 'http://127.0.0.1:8080/health')" && break
  [ "$attempt" = 36 ] && die 'candidate never served exact local release health'
  bounded_sleep 5
done
for attempt in $(seq 1 18); do
  assert_time_remaining
  assert_break_proof_time
  PUBLIC_INSTANCE="$(health_instance "$PUBLIC_URL/health?nocache=$(date +%s%N)")" || PUBLIC_INSTANCE=''
  [ "$PUBLIC_INSTANCE" = "$CANDIDATE_INSTANCE" ] && break
  [ "$attempt" = 18 ] && die 'public proxy never served the exact candidate release'
  bounded_sleep 5
done

# Main and the durable high-water may advance during the cold-start/public
# proof. Recheck containment and forward ordering before committing this seal.
source_target_is_current
assert_break_proof_time
ACTUAL_CID="$(bounded_break_command 10 docker container inspect -f '{{.Id}}' "$CONTAINER")"
ACTUAL_STARTED_AT="$(bounded_break_command 10 docker container inspect -f '{{.State.StartedAt}}' "$CONTAINER")"
ACTUAL_IMAGE_ID="$(bounded_break_command 10 docker container inspect -f '{{.Image}}' "$CONTAINER")"
ACTUAL_RELEASE="$(bounded_break_command 10 docker container inspect -f '{{index .Config.Labels "sp.release.sha"}}' "$CONTAINER")"
[ "$ACTUAL_CID" = "$CANDIDATE_CID" ] \
  && [ "$ACTUAL_STARTED_AT" = "$CANDIDATE_STARTED_AT" ] \
  && [ "$ACTUAL_IMAGE_ID" = "$TARGET_IMAGE_ID" ] \
  && [ "$ACTUAL_RELEASE" = "$SHA" ] \
  || die 'candidate generation changed during compatibility proof'
PRECOMMIT_LOCAL_INSTANCE="$(health_instance 'http://127.0.0.1:8080/health')" \
  || die 'candidate lost exact local health before seal commit'
PRECOMMIT_PUBLIC_INSTANCE="$(health_instance "$PUBLIC_URL/health?nocache=$(date +%s%N)")" \
  || die 'candidate lost exact public health before seal commit'
[ "$PRECOMMIT_LOCAL_INSTANCE" = "$CANDIDATE_INSTANCE" ] \
  && [ "$PRECOMMIT_PUBLIC_INSTANCE" = "$CANDIDATE_INSTANCE" ] \
  || die 'candidate process identity changed before seal commit'

# The elected-leader witness is deliberately last. Source freshness can wait
# on Git and must never age a previously accepted heartbeat before the seal
# moves. A 15-second maximum heartbeat age binds this exact process identity
# to the database immediately before the bounded commit.
REMAINING="$(remaining_seconds)" || die 'deadline expired before final database proof'
DB_TIMEOUT="$REMAINING"
BREAK_PROOF_REMAINING="$(break_proof_seconds)" \
  || die 'maintenance break proof budget expired before final database proof'
[ "$DB_TIMEOUT" -le "$BREAK_PROOF_REMAINING" ] || DB_TIMEOUT="$BREAK_PROOF_REMAINING"
[ "$DB_TIMEOUT" -le 60 ] || DB_TIMEOUT=60
[ "$DB_TIMEOUT" -ge 17 ] || die 'insufficient maintenance-break budget for final database proof'
DB_TIMEOUT=$((DB_TIMEOUT - 2))
timeout --signal=TERM --kill-after=1s "${DB_TIMEOUT}s" \
  "$DATABASE_PROOF" --env-file "$ENV_FILE" --sha "$SHA" --instance-id "$CANDIDATE_INSTANCE" \
  --timeout-seconds "$DB_TIMEOUT" --poll-seconds 5 --max-heartbeat-age-seconds 15
assert_time_remaining
assert_break_proof_time

set +e
SEAL_REASON='local, public, and elected-leader compatibility proofs passed'
if [ -n "$SUPERSEDED_BY" ]; then
  # Written into the durable seal and therefore into engine-release-audit.jsonl.
  # Record which newer engine commit was known when this forward release sealed.
  SEAL_REASON="$SEAL_REASON; forward release behind protected-main engine $SUPERSEDED_BY"
fi
bounded_break_command 10 "$RELEASE_SEAL" commit \
  --sha "$SHA" --image "$TARGET_IMAGE_ID" --container "$CONTAINER" \
  --run-id "$RUN_ID" --run-url "$RUN_URL" --actor "$ACTOR" \
  --reason "$SEAL_REASON"
COMMIT_RC=$?
set -e
[ "$COMMIT_RC" -eq 0 ] \
  || echo '[engine-release-transaction] seal response uncertain; requiring fsynced receipt'
bounded_break_command 10 "$RELEASE_SEAL" attest-commit \
  --sha "$SHA" --image-id "$TARGET_IMAGE_ID" --run-id "$RUN_ID" >/dev/null \
  || die 'durable seal does not attest this exact release transaction'

bounded_break_command 10 docker tag "$TARGET_IMAGE_ID" "$IMAGE_REPO:current"
bounded_break_command 10 docker update --restart always "$CONTAINER" >/dev/null
bounded_break_command 10 docker start sp-autoheal >/dev/null
[ "$(bounded_break_command 10 \
  docker container inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$CONTAINER")" = always ]
[ "$(bounded_break_command 10 \
  docker container inspect -f '{{.State.Status}}' sp-autoheal)" = running ]
FINAL_LOCAL_INSTANCE="$(health_instance 'http://127.0.0.1:8080/health')" \
  || die 'sealed engine failed final local health proof'
FINAL_PUBLIC_INSTANCE="$(health_instance "$PUBLIC_URL/health?nocache=$(date +%s%N)")" \
  || die 'sealed engine failed final public proof'
[ "$FINAL_LOCAL_INSTANCE" = "$CANDIDATE_INSTANCE" ] \
  && [ "$FINAL_PUBLIC_INSTANCE" = "$CANDIDATE_INSTANCE" ] \
  || die 'sealed engine identity changed after commit'
[ "$(date +%s)" -lt "$BREAK_END_EPOCH" ] \
  || die 'sealed candidate proof escaped the announced maintenance break'
persist_result sealed "$FINAL_LOCAL_INSTANCE"
timeout --signal=TERM --kill-after=3s 65s "$CONTROL_DIR/retain-engine-images.sh" \
  || echo '[engine-release-transaction] WARN: post-receipt image retention failed' >&2
