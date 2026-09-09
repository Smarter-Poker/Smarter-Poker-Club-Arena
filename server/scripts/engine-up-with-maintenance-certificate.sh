#!/usr/bin/env bash
# Atomically authorize an engine replacement, or recover an engine that is not
# running. The shared host lock is acquired before the outgoing container is
# identified and is held through engine-up.sh's stop/remove/run sequence.
#
# There are only three legal outcomes:
#   1. A sole, correctly labelled and published running engine presents a
#      fresh, internally consistent durable maintenance certificate. It may be
#      replaced while the lock remains held.
#   2. The engine is absent and RECOVER_IF_NOT_RUNNING=1. Availability may be
#      restored without a certificate because there is no live authority to
#      interrupt. A stopped/paused exact recovery image is resumed in place;
#      transient or foreign container states are never treated as absence.
#   3. Anything else is refused before mutation with exit 75.
#
# ENSURE_RUNNING_ONLY=1 is the post-job safety mode. It leaves an exact healthy
# running engine untouched, safely unpauses that same validated identity,
# recovers an absent/non-running engine, and refuses a live engine whose image
# or canonical run spec is wrong.
set -euo pipefail

LOCK_FILE="${LOCK_FILE:-/var/lock/club-arena-engine-up.lock}"
LOCK_WAIT_S="${LOCK_WAIT_S:-180}"
MIN_BREAK_LEFT_MS="${MIN_BREAK_LEFT_MS:-180000}"
MAX_REMAINING_SKEW_MS="${MAX_REMAINING_SKEW_MS:-15000}"
MAX_DB_CLOCK_SKEW_MS="${MAX_DB_CLOCK_SKEW_MS:-5000}"
# The wrapper takes its own database-clock sample under the cutover flock. Its
# RTT and age bounds are fixed so an outgoing build with older health fields
# can bootstrap the additive measured-at publisher without weakening authority.
MAX_DB_CLOCK_MEASUREMENT_AGE_MS=120000
MAX_DB_CLOCK_SAMPLE_RTT_MS=2000
# The engine announces one fixed five-minute break. This is deliberately not
# configurable: a caller must not be able to turn an old/future certificate
# into restart authority by widening its acceptance window.
MAX_CERTIFICATE_WINDOW_MS=300000
# A promoted transaction must leave enough of the fixed break to put the exact
# rollback image back and prove it healthy if any target proof fails. The old
# engine-up path may spend 45s delivering SIGTERM and the health proof may take
# 120s, so reserve a full three minutes. Promotion is admitted only in the first
# 15 seconds of the five-minute window, leaving 105 seconds for the candidate.
PROMOTION_START_FLOOR_MS=285000
ROLLBACK_RESERVE_MS=180000
# No proof call may begin at the edge of its absolute deadline. Direct
# verification includes a ten-second health request plus local Docker identity
# reads; public health includes a ten-second HTTPS request; database proof has
# two independently bounded two-second requests. These fixed cushions keep a
# slow final attempt from borrowing time reserved for rollback.
DIRECT_PROOF_CALL_RESERVE_MS=15000
PUBLIC_PROOF_CALL_RESERVE_MS=12000
DATABASE_PROOF_CALL_RESERVE_MS=6000
CONTAINER="${CONTAINER:-club-arena-engine}"
IMAGE="${IMAGE:-club-arena-engine:current}"
# :current is not promoted until the new process has passed HTTP and database
# proof, so it is the only valid local recovery target during a cutover. A
# caller may name an equally immutable recovery pointer explicitly.
if [ -z "${ROLLBACK_IMAGE:-}" ]; then
  case "$IMAGE" in
    *:*) ROLLBACK_IMAGE="${IMAGE%:*}:current" ;;
    *) ROLLBACK_IMAGE="club-arena-engine:current" ;;
  esac
fi
PORT="${PORT:-8080}"
HEALTH_URL="http://127.0.0.1:${PORT}/health"
ENGINE_UP_SCRIPT="${ENGINE_UP_SCRIPT:-/opt/club-arena/server/scripts/engine-up.sh}"
ENV_FILE="${ENV_FILE:-/opt/club-arena/server/.env}"
# Optional environment transaction.  The env-update workflow starts the target
# from a staged candidate, keeps an immutable copy of the old canonical file for
# host-local rollback, and asks this lock holder to promote the candidate only
# after the exact target process has passed health.  Ordinary deploys leave both
# values at their defaults and behave exactly as before.
ROLLBACK_ENV_FILE="${ROLLBACK_ENV_FILE:-$ENV_FILE}"
PROMOTE_ENV_FILE_TO="${PROMOTE_ENV_FILE_TO:-}"
CERTIFICATE_ENV_FILE="${CERTIFICATE_ENV_FILE:-$ROLLBACK_ENV_FILE}"
# Fixed, host-known recovery authority for an interrupted environment
# transaction. Unlike the workflow's run-scoped files, this path survives a
# lost runner, SIGKILL, and reboot and is known to engine-supervisor.sh without
# any GitHub context. It contains the complete pre-transaction environment, not
# a pointer to another file that cleanup could remove.
ENV_ROLLBACK_SENTINEL="/opt/club-arena/server/.env.pending-rollback"
PROMOTE_IMAGE_TO="${PROMOTE_IMAGE_TO:-}"
PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL:-}"
REQUIRED_DATABASE_VERSION="${REQUIRED_DATABASE_VERSION:-}"
RECOVER_IF_NOT_RUNNING="${RECOVER_IF_NOT_RUNNING:-0}"
ENSURE_RUNNING_ONLY="${ENSURE_RUNNING_ONLY:-0}"

# Exit 75 is reserved for a pre-mutation refusal. A child failure is remapped
# to 76 because engine-up may already have stopped or removed the old engine.
CERTIFICATE_REFUSED_EXIT=75
MUTATION_STARTED=0
ROLLBACK_IMAGE_ID=""
TARGET_IMAGE_ID=""
VERIFIED_ENGINE_FINGERPRINT=""
VERIFIED_HEALTH_VERSION=""
ENV_PROMOTION_STARTED=0
IMAGE_PROMOTION_STARTED=0
CERTIFIED_BREAK_END_MS=0
TARGET_PROOF_DEADLINE_MS=0

log() { echo "[maintenance-cutover] $*"; }
refuse() {
  if [ "$MUTATION_STARTED" = "1" ]; then
    log "FAILED after mutation: $*"
    exit 76
  fi
  log "REFUSED before mutation: $*"
  exit "$CERTIFICATE_REFUSED_EXIT"
}

positive_integer() {
  case "$1" in '' | *[!0-9]*) return 1 ;; esac
  [ "$1" -gt 0 ]
}

positive_integer "$LOCK_WAIT_S" || refuse "lock wait must be a positive integer"
positive_integer "$MIN_BREAK_LEFT_MS" || refuse "break floor must be a positive integer"
positive_integer "$MAX_REMAINING_SKEW_MS" || refuse "remaining-time skew must be a positive integer"
positive_integer "$MAX_DB_CLOCK_SKEW_MS" || refuse "database-clock skew must be a positive integer"
positive_integer "$PORT" || refuse "published port must be a positive integer"
[ "$PORT" = "8080" ] || refuse "the canonical engine run spec is exactly host 8080 to container 8080"
[ "$MIN_BREAK_LEFT_MS" -ge 180000 ] || refuse "break floor must be at least 180000ms"
[ "$MIN_BREAK_LEFT_MS" -le "$MAX_CERTIFICATE_WINDOW_MS" ] \
  || refuse "break floor cannot exceed the fixed five-minute certificate window"
[ "$MAX_REMAINING_SKEW_MS" -le 15000 ] || refuse "remaining-time skew cannot exceed 15000ms"
[ "$MAX_DB_CLOCK_SKEW_MS" -le 5000 ] || refuse "database-clock skew cannot exceed 5000ms"
[ "$PROMOTION_START_FLOOR_MS" -le "$MAX_CERTIFICATE_WINDOW_MS" ] \
  || refuse "promotion start floor exceeds the fixed maintenance window"
[ "$ROLLBACK_RESERVE_MS" -lt "$PROMOTION_START_FLOOR_MS" ] \
  || refuse "rollback reserve leaves no target proof budget"
case "$RECOVER_IF_NOT_RUNNING:$ENSURE_RUNNING_ONLY" in
  0:0 | 1:0 | 1:1) ;;
  *) refuse "recovery flags must be 0/1 and ensure-only requires recovery" ;;
esac
[ -x "$ENGINE_UP_SCRIPT" ] || refuse "engine-up script is not executable: $ENGINE_UP_SCRIPT"

exec 9>"$LOCK_FILE"
flock -w "$LOCK_WAIT_S" 9 || refuse "could not acquire $LOCK_FILE within ${LOCK_WAIT_S}s"

[ -s "$ENV_FILE" ] || refuse "target environment file is missing or empty: $ENV_FILE"
[ -s "$ROLLBACK_ENV_FILE" ] \
  || refuse "rollback environment file is missing or empty: $ROLLBACK_ENV_FILE"
[ -s "$CERTIFICATE_ENV_FILE" ] \
  || refuse "certificate environment file is missing or empty: $CERTIFICATE_ENV_FILE"
if [ -n "$PROMOTE_ENV_FILE_TO" ]; then
  [ "$ENSURE_RUNNING_ONLY" = "0" ] \
    || refuse "ensure-only recovery cannot claim a staged environment promotion"
  [ "$ENV_FILE" != "$PROMOTE_ENV_FILE_TO" ] \
    || refuse "the staged candidate and canonical environment paths must differ"
  [ "$ROLLBACK_ENV_FILE" != "$PROMOTE_ENV_FILE_TO" ] \
    || refuse "environment promotion requires an immutable rollback snapshot"
  [ "$ENV_FILE" != "$ROLLBACK_ENV_FILE" ] \
    || refuse "the staged candidate and rollback environment paths must differ"
  [ "$(dirname "$ENV_FILE")" = "$(dirname "$PROMOTE_ENV_FILE_TO")" ] \
    || refuse "the staged and canonical environments must share a directory for atomic promotion"
  [ "$(dirname "$ROLLBACK_ENV_FILE")" = "$(dirname "$PROMOTE_ENV_FILE_TO")" ] \
    || refuse "the rollback and canonical environments must share a directory for atomic restoration"
  [ "$CERTIFICATE_ENV_FILE" = "$ROLLBACK_ENV_FILE" ] \
    || refuse "environment promotion must validate the outgoing certificate with rollback credentials"
  [ "$ENV_ROLLBACK_SENTINEL" != "$ENV_FILE" ] \
    && [ "$ENV_ROLLBACK_SENTINEL" != "$ROLLBACK_ENV_FILE" ] \
    && [ "$ENV_ROLLBACK_SENTINEL" != "$PROMOTE_ENV_FILE_TO" ] \
    || refuse "the fixed rollback sentinel must be distinct from all transaction environment paths"
  [ "$(dirname "$ENV_ROLLBACK_SENTINEL")" = "$(dirname "$PROMOTE_ENV_FILE_TO")" ] \
    || refuse "the fixed rollback sentinel must share the canonical environment directory"
  [ ! -e "$ENV_ROLLBACK_SENTINEL" ] \
    || refuse "a pending environment rollback already requires supervisor reconciliation"
  case "$PUBLIC_HEALTH_URL" in
    https://*) ;;
    *) refuse "environment promotion requires an https public health URL" ;;
  esac
  [ -s "$PROMOTE_ENV_FILE_TO" ] \
    || refuse "canonical environment file is missing or empty: $PROMOTE_ENV_FILE_TO"
  cmp -s "$ROLLBACK_ENV_FILE" "$PROMOTE_ENV_FILE_TO" \
    || refuse "canonical environment changed after its rollback snapshot was staged"
fi
if [ -n "$PROMOTE_IMAGE_TO" ]; then
  [ -z "$PROMOTE_ENV_FILE_TO" ] \
    || refuse "environment and image promotion must be separate transactions"
  [ "$IMAGE" != "$PROMOTE_IMAGE_TO" ] \
    || refuse "the immutable target image and canonical image pointer must differ"
  [ "$ROLLBACK_IMAGE" = "$PROMOTE_IMAGE_TO" ] \
    || refuse "image promotion must recover from the same canonical image pointer it replaces"
  case "$PUBLIC_HEALTH_URL" in
    https://*) ;;
    *) refuse "image promotion requires an https public health URL" ;;
  esac
  case "$REQUIRED_DATABASE_VERSION" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
    *) refuse "image promotion requires one exact lowercase eight-hex database leader version" ;;
  esac
fi

invoke_engine_up() {
  local target_restart_policy="always"
  prepare_target_image
  begin_mutation_transaction
  if [ -n "$PROMOTE_ENV_FILE_TO" ] || [ -n "$PROMOTE_IMAGE_TO" ]; then
    # A staged environment is not durable authority yet. If this wrapper is
    # SIGKILLed or the host reboots before promotion, Docker must not revive
    # the candidate from the environment embedded in its container config.
    target_restart_policy="no"
  fi
  set +e
  # Execute the immutable ID resolved under this lock. A concurrent tag writer
  # cannot swap the bytes between authorization and docker run.
  IMAGE="$TARGET_IMAGE_ID" ENGINE_UP_RESTART_POLICY="$target_restart_policy" \
    ENGINE_UP_LOCK_HELD=1 "$ENGINE_UP_SCRIPT"
  local engine_up_status=$?
  set -e
  if [ "$engine_up_status" != "0" ]; then
    log "engine-up failed after authorization (status=$engine_up_status)"
    exit 76
  fi
  if ! wait_for_exact_engine "$TARGET_IMAGE_ID" "$target_restart_policy" "$TARGET_PROOF_DEADLINE_MS"; then
    log "engine-up returned success but the target never became the exact healthy engine"
    exit 76
  fi
  if [ -n "$PROMOTE_ENV_FILE_TO" ] || [ -n "$PROMOTE_IMAGE_TO" ]; then
    local pending_fingerprint="$VERIFIED_ENGINE_FINGERPRINT"
    if [ -n "$REQUIRED_DATABASE_VERSION" ] \
      && [ "$VERIFIED_HEALTH_VERSION" != "$REQUIRED_DATABASE_VERSION" ]; then
      log "the immutable target image reported version $VERIFIED_HEALTH_VERSION, not required version $REQUIRED_DATABASE_VERSION"
      exit 76
    fi
    if ! wait_for_public_engine "${REQUIRED_DATABASE_VERSION:-$VERIFIED_HEALTH_VERSION}" "$TARGET_PROOF_DEADLINE_MS"; then
      log "the staged environment target never passed fresh public health"
      exit 76
    fi
    if ! deadline_allows "$TARGET_PROOF_DEADLINE_MS" "$DIRECT_PROOF_CALL_RESERVE_MS" \
      || ! verify_running_image_once "$TARGET_IMAGE_ID" "$target_restart_policy"; then
      log "target identity changed while public health was proved"
      exit 76
    fi
    if [ "$VERIFIED_ENGINE_FINGERPRINT" != "$pending_fingerprint" ]; then
      log "target process changed while public health was proved"
      exit 76
    fi
    if ! wait_for_database_leader "${REQUIRED_DATABASE_VERSION:-$VERIFIED_HEALTH_VERSION}" "$TARGET_PROOF_DEADLINE_MS"; then
      log "the staged target never became the fresh exact database leader"
      exit 76
    fi
    if ! deadline_allows "$TARGET_PROOF_DEADLINE_MS" "$DIRECT_PROOF_CALL_RESERVE_MS" \
      || ! verify_running_image_once "$TARGET_IMAGE_ID" "$target_restart_policy"; then
      log "target identity changed while database leadership was proved"
      exit 76
    fi
    if [ "$VERIFIED_ENGINE_FINGERPRINT" != "$pending_fingerprint" ]; then
      log "target process changed while database leadership was proved"
      exit 76
    fi
  fi
  if { [ -n "$PROMOTE_ENV_FILE_TO" ] || [ -n "$PROMOTE_IMAGE_TO" ]; } \
    && ! deadline_allows "$TARGET_PROOF_DEADLINE_MS" "$DIRECT_PROOF_CALL_RESERVE_MS"; then
    log "target proof budget expired before canonical promotion"
    exit 76
  fi
  promote_environment_if_requested
  if { [ -n "$PROMOTE_ENV_FILE_TO" ] || [ -n "$PROMOTE_IMAGE_TO" ]; } \
    && ! deadline_allows "$TARGET_PROOF_DEADLINE_MS" "$DIRECT_PROOF_CALL_RESERVE_MS"; then
    log "target proof budget expired during canonical promotion"
    exit 76
  fi
  promote_image_if_requested
  if { [ -n "$PROMOTE_ENV_FILE_TO" ] || [ -n "$PROMOTE_IMAGE_TO" ]; } \
    && ! deadline_allows "$TARGET_PROOF_DEADLINE_MS" "$DIRECT_PROOF_CALL_RESERVE_MS"; then
    log "target proof budget expired before restart-policy commit"
    exit 76
  fi
  commit_promoted_run_spec
  commit_mutation_transaction
}

exact_port_binding() {
  # The single-quoted body is literal Python.
  # shellcheck disable=SC2016
  printf '%s' "$1" | python3 -c '
import json, sys

port = sys.argv[1]
try:
    bindings = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
if not isinstance(bindings, dict) or set(bindings) != {"8080/tcp"}:
    raise SystemExit(1)
rows = bindings.get("8080/tcp")
if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
    raise SystemExit(1)
row = rows[0]
# `docker run -p HOST:8080` records HostIp as the empty all-interface binding.
# Refuse loopback-only, IPv6-only, duplicated, or additional publications.
if row.get("HostIp") != "" or row.get("HostPort") != port:
    raise SystemExit(1)
' "$PORT" >/dev/null 2>&1
}

direct_health_is_live() {
  printf '%s' "$1" | python3 -c '
import json, sys

try:
    body = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
if body.get("running") is not True or body.get("liveness") not in ("ok", "standby"):
    raise SystemExit(1)
' >/dev/null 2>&1
}

direct_health_status_is_acceptable() {
  printf '%s' "$2" | python3 -c '
import json, sys

code = sys.argv[1]
try:
    body = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
if body.get("running") is not True:
    raise SystemExit(1)
if code == "200" and body.get("liveness") == "ok":
    raise SystemExit(0)
if code == "503" and body.get("liveness") == "standby":
    raise SystemExit(0)
raise SystemExit(1)
' "$1" >/dev/null 2>&1
}

read_direct_health() {
  local cache_buster response http_code body
  cache_buster="$(date -u +%s%N)"
  # -q disables a host .curlrc and --noproxy prevents HTTP_PROXY from forging
  # a loopback response. Both are required before this body can be authority.
  # Do not use -f here. A healthy standby intentionally answers HTTP 503 so
  # Caddy will not route players to it; its JSON is still valid process-health
  # authority for recovery/ensure and must be parsed rather than discarded.
  response="$(curl -q --noproxy '*' -sS --max-time 10 -H 'Cache-Control: no-cache' \
    -w $'\n%{http_code}' "${HEALTH_URL}?cb=${cache_buster}" 2>/dev/null)" || return 1
  http_code="${response##*$'\n'}"
  body="${response%$'\n'*}"
  [ -n "$body" ] || return 1
  direct_health_status_is_acceptable "$http_code" "$body" || return 1
  printf '%s' "$body"
}

health_version() {
  printf '%s' "$1" | python3 -c '
import json, sys

value = json.load(sys.stdin).get("version")
if not isinstance(value, str) or not value:
    raise SystemExit(1)
sys.stdout.write(value)
' 2>/dev/null
}

read_public_health() {
  local expected_version="$1" cache_buster response http_code body
  cache_buster="$(date -u +%s%N)"
  response="$(curl -q --noproxy '*' -sS --max-time 10 -H 'Cache-Control: no-cache' \
    -w $'\n%{http_code}' "${PUBLIC_HEALTH_URL}?cb=${cache_buster}" 2>/dev/null)" || return 1
  http_code="${response##*$'\n'}"
  body="${response%$'\n'*}"
  [ -n "$body" ] || return 1
  # Public proof means the player-facing origin is actively serving. A 503
  # standby body is useful direct-process health, but it is not publication and
  # must never commit an environment or image transaction.
  [ "$http_code" = "200" ] || return 1
  printf '%s' "$body" | python3 -c '
import json, sys

expected = sys.argv[1]
value = json.load(sys.stdin)
if not (
    value.get("running") is True
    and value.get("liveness") == "ok"
    and value.get("version") == expected
):
    raise SystemExit(1)
' "$expected_version" >/dev/null 2>&1
}

wait_for_public_engine() {
  local expected_version="$1" deadline_ms="${2:-0}" attempt
  for attempt in $(seq 1 12); do
    deadline_allows "$deadline_ms" "$PUBLIC_PROOF_CALL_RESERVE_MS" || return 1
    if read_public_health "$expected_version"; then
      log "verified fresh public health for engine version $expected_version on attempt $attempt"
      return 0
    fi
    deadline_allows "$deadline_ms" 5000 || return 1
    sleep 5
  done
  return 1
}

read_database_leader() {
  local expected_version="$1" supabase_url service_key body curl_status clock_sample
  local db_clock_skew_ms db_clock_measured_at_ms
  supabase_url="$(read_env_value SUPABASE_URL)" || return 1
  service_key="$(read_env_value SUPABASE_SERVICE_ROLE_KEY)" || return 1
  case "$supabase_url" in https://*) ;; *) return 1 ;; esac
  case "$service_key" in '' | *[!A-Za-z0-9._-]*) return 1 ;; esac
  supabase_url="${supabase_url%/}"

  exec 8<<<"header = \"apikey: $service_key\"
header = \"Authorization: Bearer $service_key\""
  set +e
  body="$(curl -q --config /dev/fd/8 --noproxy '*' -sf --max-time 2 \
    -H 'Cache-Control: no-cache' \
    "${supabase_url}/rest/v1/engine_leader?select=engine_version,heartbeat_at&id=eq.true" \
    2>/dev/null)"
  curl_status=$?
  set -e
  exec 8<&-
  [ "$curl_status" = "0" ] || return 1

  # Use the database-clock sample rather than assuming the host and PostgreSQL
  # clocks agree. The leader heartbeat must be both exact and fresh; an old row
  # carrying the target version is not deployment authority.
  clock_sample="$(read_database_clock_sample)" || return 1
  IFS='|' read -r db_clock_skew_ms db_clock_measured_at_ms _ <<EOF
$clock_sample
EOF
  printf '%s' "$body" | python3 -c '
import datetime, json, math, sys, time

expected, skew_raw, measured_raw, max_age_raw = sys.argv[1:]
skew = float(skew_raw)
measured_at = float(measured_raw)
max_age = int(max_age_raw)
rows = json.load(sys.stdin)
if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
    raise SystemExit(1)
row = rows[0]
if row.get("engine_version") != expected:
    raise SystemExit(1)
heartbeat = row.get("heartbeat_at")
if not isinstance(heartbeat, str):
    raise SystemExit(1)
try:
    heartbeat_ms = datetime.datetime.fromisoformat(
        heartbeat.replace("Z", "+00:00")
    ).timestamp() * 1000
except Exception:
    raise SystemExit(1)
host_now = time.time() * 1000
db_now = host_now - skew
sample_age = host_now - measured_at
heartbeat_age = db_now - heartbeat_ms
if not all(math.isfinite(v) for v in (skew, measured_at, heartbeat_ms, sample_age, heartbeat_age)):
    raise SystemExit(1)
if sample_age < 0 or sample_age > max_age:
    raise SystemExit(1)
if heartbeat_age < -60000 or heartbeat_age > 60000:
    raise SystemExit(1)
' "$expected_version" "$db_clock_skew_ms" "$db_clock_measured_at_ms" \
    "$MAX_DB_CLOCK_MEASUREMENT_AGE_MS" >/dev/null 2>&1
}

wait_for_database_leader() {
  local expected_version="$1" deadline_ms="${2:-0}" attempt
  [ -n "$expected_version" ] || return 1
  for attempt in $(seq 1 24); do
    deadline_allows "$deadline_ms" "$DATABASE_PROOF_CALL_RESERVE_MS" || return 1
    if read_database_leader "$expected_version"; then
      log "verified fresh database leader for engine version $expected_version on attempt $attempt"
      return 0
    fi
    deadline_allows "$deadline_ms" 10000 || return 1
    sleep 10
  done
  return 1
}

now_ms() {
  python3 -c 'import time; print(round(time.time() * 1000))'
}

deadline_allows() {
  local deadline_ms="${1:-0}" reserve_ms="${2:-0}" current_ms
  [ "$deadline_ms" = "0" ] && return 0
  current_ms="$(now_ms)" || return 1
  [ $((current_ms + reserve_ms)) -lt "$deadline_ms" ]
}

read_env_value() {
  python3 -c '
import sys

path, wanted = sys.argv[1:]
found = []
with open(path, "r", encoding="utf-8") as handle:
    for raw in handle:
        line = raw.rstrip("\r\n")
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        # Docker --env-file is literal KEY=value, not a shell. Explicitly
        # reject shell-only export/quote syntax for these credentials rather
        # than silently sending quote characters as part of a key or URL.
        if line.startswith("export ") and line[7:].startswith(wanted + "="):
            raise SystemExit(1)
        key, value = line.split("=", 1)
        if key == wanted:
            quote_chars = (chr(34), chr(39))
            if value != value.strip() or value[:1] in quote_chars or value[-1:] in quote_chars:
                raise SystemExit(1)
            found.append(value)
if len(found) != 1 or not found[0]:
    raise SystemExit(1)
sys.stdout.write(found[0])
' "$CERTIFICATE_ENV_FILE" "$1"
}

read_database_clock_sample() {
  local supabase_url service_key t0_ms t1_ms body curl_status
  [ -r "$ENV_FILE" ] || return 1
  supabase_url="$(read_env_value SUPABASE_URL)" || return 1
  service_key="$(read_env_value SUPABASE_SERVICE_ROLE_KEY)" || return 1
  case "$supabase_url" in https://*) ;; *) return 1 ;; esac
  case "$service_key" in '' | *[!A-Za-z0-9._-]*) return 1 ;; esac
  supabase_url="${supabase_url%/}"
  t0_ms="$(python3 -c 'import time; print(round(time.time() * 1000))')" || return 1
  # Feed credentials through an inherited anonymous descriptor. They never
  # appear in curl argv, command output, or a persistent filesystem path.
  exec 8<<<"header = \"apikey: $service_key\"
header = \"Authorization: Bearer $service_key\""
  set +e
  body="$(curl -q --config /dev/fd/8 --noproxy '*' -sf --max-time 2 \
    -X POST -H 'Content-Type: application/json' \
    -H 'x-smarter-data-actor: service' \
    -H 'x-smarter-data-protocol: 1' \
    -d '{}' "${supabase_url}/rest/v1/rpc/fn_db_now" 2>/dev/null)"
  curl_status=$?
  set -e
  exec 8<&-
  [ "$curl_status" = "0" ] || return 1
  t1_ms="$(python3 -c 'import time; print(round(time.time() * 1000))')" || return 1
  printf '%s' "$body" | python3 -c '
import datetime, json, math, sys

t0, t1, max_rtt = map(int, sys.argv[1:])
value = json.load(sys.stdin)
if not isinstance(value, str) or t1 < t0 or t1 - t0 > max_rtt:
    raise SystemExit(1)
try:
    db_ms = datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000
except Exception:
    raise SystemExit(1)
if not math.isfinite(db_ms):
    raise SystemExit(1)
midpoint = round((t0 + t1) / 2)
print(f"{round(midpoint - db_ms)}|{midpoint}|{t1 - t0}")
' "$t0_ms" "$t1_ms" "$MAX_DB_CLOCK_SAMPLE_RTT_MS"
}

parse_fingerprint() {
  IFS='|' read -r CONTAINER_ID STARTED_AT CONTAINER_STATE ROLE_LABEL AUTOHEAL_LABEL \
    RESTART_POLICY ACTUAL_IMAGE_ID PORT_BINDINGS_JSON <<EOF
$1
EOF
}

validate_running_identity() {
  [ -n "$CONTAINER_ID" ] || refuse "$CONTAINER has no inspectable container id"
  [ -n "$STARTED_AT" ] || refuse "$CONTAINER has no inspectable start identity"
  [ "$ROLE_LABEL" = "engine" ] \
    || refuse "$CONTAINER is running without the exact sp.role=engine label"
  [ "$AUTOHEAL_LABEL" = "true" ] \
    || refuse "$CONTAINER is running without the exact autoheal=true label"
  [ "$RESTART_POLICY" = "always" ] \
    || refuse "$CONTAINER is running without the exact restart=always policy"
  exact_port_binding "$PORT_BINDINGS_JSON" \
    || refuse "$CONTAINER does not have the exact ${PORT}:8080-only published-port run spec"
}

assert_running_sets() {
  local named labelled published
  named="$(running_expected_name)" || refuse "could not enumerate running containers named $CONTAINER"
  labelled="$(running_labelled_engines)" || refuse "could not enumerate running labelled engines"
  published="$(running_port_publishers)" || refuse "could not enumerate publishers of host port $PORT"
  [ "$named" = "$CONTAINER" ] \
    || refuse "the running named-container set is not exactly $CONTAINER: ${named:-none}"
  [ "$labelled" = "$CONTAINER" ] \
    || refuse "the running labelled-engine set is not exactly $CONTAINER: ${labelled:-none}"
  [ "$published" = "$CONTAINER" ] \
    || refuse "the running publisher of host port $PORT is not exactly $CONTAINER: ${published:-none}"
}

verify_running_image_once() {
  local expected_image_id="$1" expected_restart_policy="${2:-always}"
  local fingerprint body named labelled published all_named all_labelled all_published
  fingerprint="$(container_fingerprint)"
  parse_fingerprint "$fingerprint"
  [ "$CONTAINER_STATE" = "running" ] || return 1
  [ -n "$CONTAINER_ID" ] && [ -n "$STARTED_AT" ] || return 1
  [ "$ROLE_LABEL" = "engine" ] && [ "$AUTOHEAL_LABEL" = "true" ] \
    && [ "$RESTART_POLICY" = "$expected_restart_policy" ] || return 1
  [ "$ACTUAL_IMAGE_ID" = "$expected_image_id" ] || return 1
  exact_port_binding "$PORT_BINDINGS_JSON" || return 1
  named="$(running_expected_name)" || return 1
  labelled="$(running_labelled_engines)" || return 1
  published="$(running_port_publishers)" || return 1
  all_named="$(all_expected_names)" || return 1
  all_labelled="$(all_labelled_engines)" || return 1
  all_published="$(all_port_publishers)" || return 1
  [ "$named" = "$CONTAINER" ] && [ "$labelled" = "$CONTAINER" ] \
    && [ "$published" = "$CONTAINER" ] && [ "$all_named" = "$CONTAINER" ] \
    && [ "$all_labelled" = "$CONTAINER" ] && [ "$all_published" = "$CONTAINER" ] \
    || return 1
  body="$(read_direct_health)" || return 1
  direct_health_is_live "$body" || return 1
  VERIFIED_HEALTH_VERSION="$(health_version "$body")" || return 1
  # Health is network work. Re-read both the process identity and the complete
  # authority sets afterwards so an autoheal restart or port/name handoff
  # during curl can never be certified as the process inspected before it.
  [ "$(container_fingerprint)" = "$fingerprint" ] || return 1
  named="$(running_expected_name)" || return 1
  labelled="$(running_labelled_engines)" || return 1
  published="$(running_port_publishers)" || return 1
  all_named="$(all_expected_names)" || return 1
  all_labelled="$(all_labelled_engines)" || return 1
  all_published="$(all_port_publishers)" || return 1
  [ "$named" = "$CONTAINER" ] && [ "$labelled" = "$CONTAINER" ] \
    && [ "$published" = "$CONTAINER" ] && [ "$all_named" = "$CONTAINER" ] \
    && [ "$all_labelled" = "$CONTAINER" ] && [ "$all_published" = "$CONTAINER" ] \
    || return 1
  # The inventory calls above are separate Docker RPCs. Sandwich them with the
  # same StartedAt-bearing fingerprint so an autoheal restart during those calls
  # cannot make old-process health authorize a newly started process.
  [ "$(container_fingerprint)" = "$fingerprint" ] || return 1
  VERIFIED_ENGINE_FINGERPRINT="$fingerprint"
}

wait_for_exact_engine() {
  local expected_image_id="$1" expected_restart_policy="${2:-always}" deadline_ms="${3:-0}" attempt
  for attempt in $(seq 1 24); do
    deadline_allows "$deadline_ms" "$DIRECT_PROOF_CALL_RESERVE_MS" || return 1
    if verify_running_image_once "$expected_image_id" "$expected_restart_policy"; then
      log "verified the exact healthy engine image with restart=$expected_restart_policy on attempt $attempt"
      return 0
    fi
    deadline_allows "$deadline_ms" 5000 || return 1
    sleep 5
  done
  return 1
}

recover_after_abnormal_exit() {
  local original_status="$1" recovery_status recovery_env_file="$ROLLBACK_ENV_FILE"
  # Ignore cancellation before doing anything else. A second TERM/HUP arriving
  # while EXIT is entering must not interrupt the only local rollback path.
  trap '' HUP INT TERM PIPE
  trap - EXIT
  set +e
  if [ "$ENV_PROMOTION_STARTED" = "1" ]; then
    if ! restore_canonical_environment; then
      log "FATAL: could not restore the canonical environment before host-local recovery"
      exit "$original_status"
    fi
  fi
  if [ -n "$PROMOTE_ENV_FILE_TO" ] && [ -s "$ENV_ROLLBACK_SENTINEL" ]; then
    recovery_env_file="$ENV_ROLLBACK_SENTINEL"
  fi
  if [ "$IMAGE_PROMOTION_STARTED" = "1" ]; then
    if ! restore_canonical_image_pointer; then
      log "FATAL: could not restore the canonical image pointer before host-local recovery"
      exit "$original_status"
    fi
  fi
  log "abnormal exit after mutation (status=$original_status); restoring $ROLLBACK_IMAGE under the held lock"
  # Run the immutable image ID resolved before mutation. Even an accidental
  # concurrent retag of :current cannot change what this transaction restores.
  IMAGE="$ROLLBACK_IMAGE_ID" ENV_FILE="$recovery_env_file" ENGINE_UP_RESTART_POLICY=always \
    ENGINE_UP_LOCK_HELD=1 "$ENGINE_UP_SCRIPT"
  recovery_status=$?
  if [ "$recovery_status" = "0" ]; then
    if wait_for_exact_engine "$ROLLBACK_IMAGE_ID" always "$CERTIFIED_BREAK_END_MS"; then
      log "host-local recovery verified $ROLLBACK_IMAGE healthy"
      if [ -n "$PROMOTE_ENV_FILE_TO" ]; then
        remove_env_rollback_sentinel_durably \
          || log "FATAL: verified rollback completed but the durable rollback sentinel could not be retired"
      fi
      exit "$original_status"
    fi
    log "FATAL: $ROLLBACK_IMAGE was started but never became the exact healthy engine"
  else
    log "FATAL: host-local recovery image failed to start (status=$recovery_status)"
  fi
  exit "$original_status"
}

on_mutation_signal() {
  # Make the transition to EXIT recovery single-shot before logging; logging to
  # a closing SSH pipe must not leave a window for a second signal to skip it.
  trap '' HUP INT TERM PIPE
  log "received a cancellation signal after mutation began"
  exit 76
}

on_mutation_exit() {
  local status="$?"
  # EXIT can race a second SSH cancellation signal. Disable the signal traps
  # before even testing transaction state so rollback cannot be interrupted by
  # a nested signal handler while the EXIT trap is dispatching.
  trap '' HUP INT TERM PIPE
  if [ "$MUTATION_STARTED" = "1" ] \
    && [ "$status" != "0" ]; then
    recover_after_abnormal_exit "$status"
  fi
}

prepare_target_image() {
  [ -z "$TARGET_IMAGE_ID" ] || return 0
  TARGET_IMAGE_ID="$(docker image inspect -f '{{.Id}}' "$IMAGE" 2>/dev/null)" \
    || refuse "the requested engine image is not inspectable: $IMAGE"
  [ -n "$TARGET_IMAGE_ID" ] \
    || refuse "the requested engine image has no inspectable id: $IMAGE"
}

prepare_recovery_image() {
  [ -z "$ROLLBACK_IMAGE_ID" ] || return 0
  if [ "$ROLLBACK_IMAGE" = "$IMAGE" ]; then
    prepare_target_image
    ROLLBACK_IMAGE_ID="$TARGET_IMAGE_ID"
    return 0
  fi
  ROLLBACK_IMAGE_ID="$(docker image inspect -f '{{.Id}}' "$ROLLBACK_IMAGE" 2>/dev/null)" \
    || refuse "the host-local recovery image is not inspectable: $ROLLBACK_IMAGE"
  [ -n "$ROLLBACK_IMAGE_ID" ] \
    || refuse "the host-local recovery image has no inspectable id: $ROLLBACK_IMAGE"
}

begin_mutation_transaction() {
  [ "$MUTATION_STARTED" = "0" ] || return 0
  prepare_recovery_image
  # Install catchable-signal recovery before creating any transaction state.
  # The fixed sentinel is then durably published before the container or
  # canonical environment can change. SIGKILL/reboot cannot run these traps,
  # but the supervisor sees the sentinel under the same lock and converges to
  # the pre-transaction bytes before considering boot grace or container state.
  trap on_mutation_signal HUP INT TERM PIPE
  trap on_mutation_exit EXIT
  if [ -n "$PROMOTE_ENV_FILE_TO" ]; then
    durable_copy_replace "$ROLLBACK_ENV_FILE" "$ENV_ROLLBACK_SENTINEL" \
      || { log "failed to durably publish the environment rollback sentinel"; exit 76; }
    cmp -s "$ROLLBACK_ENV_FILE" "$ENV_ROLLBACK_SENTINEL" \
      || { log "fixed rollback sentinel does not match the staged rollback bytes"; exit 76; }
  fi
  MUTATION_STARTED=1
}

commit_mutation_transaction() {
  # The exact target is healthy and the canonical environment contains the
  # bytes that process booted with. Retire the durable rollback authority before
  # disarming traps. A crash before its durable unlink conservatively rolls back;
  # a crash after it leaves the already verified committed configuration.
  if [ -n "$PROMOTE_ENV_FILE_TO" ]; then
    remove_env_rollback_sentinel_durably \
      || { log "failed to durably retire the committed environment rollback sentinel"; exit 76; }
  fi
  MUTATION_STARTED=0
  trap - HUP INT TERM PIPE EXIT
}

restore_canonical_environment() {
  local rollback_source="$ROLLBACK_ENV_FILE"
  [ -n "$PROMOTE_ENV_FILE_TO" ] || return 0
  if [ -e "$ENV_ROLLBACK_SENTINEL" ]; then
    [ -s "$ENV_ROLLBACK_SENTINEL" ] || return 1
    cmp -s "$ROLLBACK_ENV_FILE" "$ENV_ROLLBACK_SENTINEL" || return 1
    rollback_source="$ENV_ROLLBACK_SENTINEL"
  fi
  [ -s "$rollback_source" ] || return 1
  durable_copy_replace "$rollback_source" "$PROMOTE_ENV_FILE_TO" || return 1
  cmp -s "$rollback_source" "$PROMOTE_ENV_FILE_TO"
}

remove_env_rollback_sentinel_durably() {
  [ -e "$ENV_ROLLBACK_SENTINEL" ] || return 0
  rm -f -- "$ENV_ROLLBACK_SENTINEL" || return 1
  python3 - "$ENV_ROLLBACK_SENTINEL" <<'PY' || return 1
import os
import sys

directory = os.open(
    os.path.dirname(os.path.abspath(sys.argv[1])),
    os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0),
)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
}

restore_canonical_image_pointer() {
  [ -n "$PROMOTE_IMAGE_TO" ] || return 0
  [ -n "$ROLLBACK_IMAGE_ID" ] || return 1
  docker tag "$ROLLBACK_IMAGE_ID" "$PROMOTE_IMAGE_TO" >/dev/null 2>&1 || return 1
  [ "$(docker image inspect -f '{{.Id}}' "$PROMOTE_IMAGE_TO" 2>/dev/null)" = "$ROLLBACK_IMAGE_ID" ]
}

durable_copy_replace() {
  local source="$1" destination="$2" transaction_tmp
  # Source paths are run-scoped for environment transactions, which makes this
  # temporary path both collision-free under the host lock and exactly
  # removable after a SIGKILL (no secret-bearing wildcard cleanup required).
  transaction_tmp="${source}.replace"
  cp -p "$source" "$transaction_tmp" || return 1
  # Persist the new file before the atomic rename, then persist the containing
  # directory after it. A power loss can therefore expose either complete old
  # bytes or complete new bytes, never a successful-looking partial file.
  python3 - "$transaction_tmp" <<'PY' || return 1
import os
import sys

descriptor = os.open(sys.argv[1], os.O_RDONLY)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
  mv -f "$transaction_tmp" "$destination" || return 1
  python3 - "$destination" <<'PY' || return 1
import os
import sys

path = os.path.abspath(sys.argv[1])
descriptor = os.open(path, os.O_RDONLY)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
directory = os.open(os.path.dirname(path), os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
}

promote_environment_if_requested() {
  local candidate_digest
  [ -n "$PROMOTE_ENV_FILE_TO" ] || return 0
  candidate_digest="$(sha256sum "$ENV_FILE" | awk '{print $1}')" \
    || { log "failed to hash the verified candidate environment"; exit 76; }
  ENV_PROMOTION_STARTED=1
  durable_copy_replace "$ENV_FILE" "$PROMOTE_ENV_FILE_TO" \
    || { log "failed to durably promote the verified candidate environment"; exit 76; }
  [ "$(sha256sum "$PROMOTE_ENV_FILE_TO" | awk '{print $1}')" = "$candidate_digest" ] \
    || { log "canonical environment does not match the verified candidate"; exit 76; }
  log "durably promoted the environment used by the verified target process"
}

promote_image_if_requested() {
  [ -n "$PROMOTE_IMAGE_TO" ] || return 0
  IMAGE_PROMOTION_STARTED=1
  docker tag "$TARGET_IMAGE_ID" "$PROMOTE_IMAGE_TO" >/dev/null 2>&1 \
    || { log "failed to atomically promote the verified target image"; exit 76; }
  [ "$(docker image inspect -f '{{.Id}}' "$PROMOTE_IMAGE_TO" 2>/dev/null)" = "$TARGET_IMAGE_ID" ] \
    || { log "canonical image pointer does not match the verified target"; exit 76; }
  log "atomically promoted the verified target image to $PROMOTE_IMAGE_TO"
}

commit_promoted_run_spec() {
  local pending_fingerprint pending_id pending_started pending_state pending_role
  local pending_autoheal pending_restart pending_image pending_ports
  local committed_fingerprint committed_id committed_started committed_state committed_role
  local committed_autoheal committed_restart committed_image committed_ports
  if [ -z "$PROMOTE_ENV_FILE_TO" ] && [ -z "$PROMOTE_IMAGE_TO" ]; then
    return 0
  fi

  pending_fingerprint="$VERIFIED_ENGINE_FINGERPRINT"
  IFS='|' read -r pending_id pending_started pending_state pending_role pending_autoheal \
    pending_restart pending_image pending_ports <<EOF
$pending_fingerprint
EOF
  [ "$pending_restart" = "no" ] \
    || { log "verified environment candidate was unexpectedly restartable before commit"; exit 76; }

  docker update --restart always "$CONTAINER" >/dev/null 2>&1 \
    || { log "failed to commit restart=always after durable environment promotion"; exit 76; }
  if ! wait_for_exact_engine "$TARGET_IMAGE_ID" always "$TARGET_PROOF_DEADLINE_MS"; then
    log "restart-policy commit did not leave the exact healthy target engine"
    exit 76
  fi
  committed_fingerprint="$VERIFIED_ENGINE_FINGERPRINT"
  IFS='|' read -r committed_id committed_started committed_state committed_role committed_autoheal \
    committed_restart committed_image committed_ports <<EOF
$committed_fingerprint
EOF
  [ "$committed_id" = "$pending_id" ] \
    && [ "$committed_started" = "$pending_started" ] \
    && [ "$committed_state" = "$pending_state" ] \
    && [ "$committed_role" = "$pending_role" ] \
    && [ "$committed_autoheal" = "$pending_autoheal" ] \
    && [ "$committed_restart" = "always" ] \
    && [ "$committed_image" = "$pending_image" ] \
    && [ "$committed_ports" = "$pending_ports" ] \
    || { log "engine identity changed while restart=always was committed"; exit 76; }
  log "committed restart=always for the verified canonical environment and image"
}

# Read the expected container as one fingerprint. StartedAt is load-bearing:
# Docker autoheal restarts a container without changing its ID, and a
# certificate read from the process before that restart must not authorize a
# mutation of the process after it.
container_fingerprint() {
  docker container inspect \
    -f '{{.Id}}|{{.State.StartedAt}}|{{.State.Status}}|{{index .Config.Labels "sp.role"}}|{{index .Config.Labels "autoheal"}}|{{.HostConfig.RestartPolicy.Name}}|{{.Image}}|{{json .HostConfig.PortBindings}}' \
    "$CONTAINER" 2>/dev/null || true
}

running_labelled_engines() {
  docker ps --filter status=running --filter label=sp.role=engine --format '{{.Names}}' \
    2>/dev/null
}

running_port_publishers() {
  port_publishers_by_state running
}

running_expected_name() {
  docker ps --filter status=running --filter "name=^/${CONTAINER}$" --format '{{.Names}}' \
    2>/dev/null
}

all_labelled_engines() {
  docker ps -a --filter label=sp.role=engine --format '{{.Names}}' 2>/dev/null
}

all_port_publishers() {
  port_publishers_by_state all
}

port_publishers_by_state() {
  local state="$1" id_text id
  local -a ids
  if [ "$state" = "all" ]; then
    id_text="$(docker ps -aq 2>/dev/null)" || return 1
  else
    id_text="$(docker ps -q --filter status=running 2>/dev/null)" || return 1
  fi
  [ -n "$id_text" ] || return 0
  while IFS= read -r id; do
    [ -n "$id" ] && ids+=("$id")
  done <<<"$id_text"
  docker container inspect \
    -f '{{.Name}}|{{json .HostConfig.PortBindings}}' "${ids[@]}" 2>/dev/null \
    | python3 -c '
import json, sys

host_port = sys.argv[1]
for raw in sys.stdin:
    raw = raw.rstrip("\r\n")
    try:
        name, encoded = raw.split("|", 1)
        bindings = json.loads(encoded)
    except Exception:
        raise SystemExit(1)
    if not isinstance(bindings, dict):
        raise SystemExit(1)
    owns_host_port = any(
        isinstance(rows, list)
        and any(isinstance(row, dict) and row.get("HostPort") == host_port for row in rows)
        for rows in bindings.values()
    )
    if owns_host_port:
        print(name[1:] if name.startswith("/") else name)
' "$PORT"
}

all_expected_names() {
  docker ps -a --filter "name=^/${CONTAINER}$" --format '{{.Names}}' 2>/dev/null
}

assert_only_expected_authority_all_states() {
  local named labelled published
  named="$(all_expected_names)" || refuse "could not enumerate all containers named $CONTAINER"
  labelled="$(all_labelled_engines)" || refuse "could not enumerate all labelled engines"
  published="$(all_port_publishers)" || refuse "could not enumerate all configured publishers of host port $PORT"
  [ "$named" = "$CONTAINER" ] \
    && [ "$labelled" = "$CONTAINER" ] \
    && [ "$published" = "$CONTAINER" ] \
    || refuse "all-state engine authority is not exactly $CONTAINER (named=${named:-none} labelled=${labelled:-none} published=${published:-none})"
}

assert_no_authority_all_states() {
  local named labelled published
  named="$(all_expected_names)" || refuse "could not enumerate all containers named $CONTAINER"
  labelled="$(all_labelled_engines)" || refuse "could not enumerate all labelled engines"
  published="$(all_port_publishers)" || refuse "could not enumerate all configured publishers of host port $PORT"
  [ -z "$named" ] && [ -z "$labelled" ] && [ -z "$published" ] \
    || refuse "non-running engine authority still exists (named=${named:-none} labelled=${labelled:-none} published=${published:-none})"
}

FINGERPRINT_BEFORE="$(container_fingerprint)"
parse_fingerprint "$FINGERPRINT_BEFORE"
NAMED="$(running_expected_name)" || refuse "could not enumerate running containers named $CONTAINER"
LABELLED="$(running_labelled_engines)" || refuse "could not enumerate running labelled engines"
PUBLISHED="$(running_port_publishers)" || refuse "could not enumerate publishers of host port $PORT"

if [ "$CONTAINER_STATE" = "paused" ]; then
  # A paused process is suspended authority, not an absent engine. A routine
  # cutover may not destroy it. Recovery validates the same immutable process,
  # its image and its exact run spec before unpausing it under the host lock.
  [ "$RECOVER_IF_NOT_RUNNING" = "1" ] \
    || refuse "$CONTAINER is paused; cutover cannot replace suspended engine authority"
  [ -z "$PROMOTE_ENV_FILE_TO" ] \
    || refuse "a paused container did not boot from the staged environment and cannot promote it"
  validate_running_identity
  case "$NAMED" in "" | "$CONTAINER") ;; *) refuse "another running named container exists: $NAMED" ;; esac
  case "$LABELLED" in "" | "$CONTAINER") ;; *) refuse "another running labelled engine exists: $LABELLED" ;; esac
  case "$PUBLISHED" in "" | "$CONTAINER") ;; *) refuse "another running port publisher exists: $PUBLISHED" ;; esac
  assert_only_expected_authority_all_states

  prepare_target_image
  prepare_recovery_image
  [ "$ACTUAL_IMAGE_ID" = "$TARGET_IMAGE_ID" ] \
    && [ "$ACTUAL_IMAGE_ID" = "$ROLLBACK_IMAGE_ID" ] \
    || refuse "$CONTAINER is paused on an image other than the exact requested last-known-good image"

  PAUSED_ID="$CONTAINER_ID"
  PAUSED_STARTED_AT="$STARTED_AT"
  PAUSED_ROLE="$ROLE_LABEL"
  PAUSED_AUTOHEAL="$AUTOHEAL_LABEL"
  PAUSED_RESTART="$RESTART_POLICY"
  PAUSED_IMAGE_ID="$ACTUAL_IMAGE_ID"
  PAUSED_PORT_BINDINGS="$PORT_BINDINGS_JSON"
  prepare_recovery_image
  begin_mutation_transaction
  docker unpause "$CONTAINER" >/dev/null 2>&1 \
    || refuse "could not unpause the validated $CONTAINER container"

  FINGERPRINT_BEFORE="$(container_fingerprint)"
  parse_fingerprint "$FINGERPRINT_BEFORE"
  [ "$CONTAINER_STATE" = "running" ] \
    || refuse "$CONTAINER did not become running after unpause"
  [ "$CONTAINER_ID" = "$PAUSED_ID" ] \
    && [ "$STARTED_AT" = "$PAUSED_STARTED_AT" ] \
    && [ "$ROLE_LABEL" = "$PAUSED_ROLE" ] \
    && [ "$AUTOHEAL_LABEL" = "$PAUSED_AUTOHEAL" ] \
    && [ "$RESTART_POLICY" = "$PAUSED_RESTART" ] \
    && [ "$ACTUAL_IMAGE_ID" = "$PAUSED_IMAGE_ID" ] \
    && [ "$PORT_BINDINGS_JSON" = "$PAUSED_PORT_BINDINGS" ] \
    || refuse "$CONTAINER changed identity or run spec while it was unpaused"
  validate_running_identity
  assert_running_sets
  assert_only_expected_authority_all_states
  BODY="$(read_direct_health)" \
    || refuse "the unpaused engine did not expose direct health"
  direct_health_is_live "$BODY" \
    || refuse "the unpaused engine did not report exact live health"
  FINGERPRINT_AFTER="$(container_fingerprint)"
  [ "$FINGERPRINT_AFTER" = "$FINGERPRINT_BEFORE" ] \
    || refuse "$CONTAINER changed identity while unpause health was verified"
  assert_running_sets
  assert_only_expected_authority_all_states
  [ "$(container_fingerprint)" = "$FINGERPRINT_BEFORE" ] \
    || refuse "$CONTAINER changed identity while unpause authority was revalidated"
  log "$CONTAINER was safely unpaused with the exact recovery image and run spec"
  exit 0
fi

if [ -z "$CONTAINER_STATE" ]; then
  [ "$RECOVER_IF_NOT_RUNNING" = "1" ] \
    || refuse "$CONTAINER is absent, so there is no running engine to certify"
  [ -z "$NAMED" ] \
    || refuse "$CONTAINER is running but its identity could not be inspected"
  [ -z "$LABELLED" ] \
    || refuse "another running labelled engine exists while $CONTAINER is absent: $LABELLED"
  [ -z "$PUBLISHED" ] \
    || refuse "another running container publishes host port $PORT while $CONTAINER is absent: $PUBLISHED"
  assert_no_authority_all_states
  prepare_target_image
  prepare_recovery_image
  # Image inspection may take long enough for an external actor to create an
  # engine. Re-prove absence and the empty authority sets at the final boundary
  # before allowing certificate-free recovery.
  RECOVERY_FINGERPRINT="$(container_fingerprint)"
  [ -z "$RECOVERY_FINGERPRINT" ] \
    || refuse "$CONTAINER appeared while absence recovery was being prepared"
  RECOVERY_NAMED="$(running_expected_name)" \
    || refuse "could not re-enumerate named containers before absence recovery"
  RECOVERY_LABELLED="$(running_labelled_engines)" \
    || refuse "could not re-enumerate labelled engines before absence recovery"
  RECOVERY_PUBLISHED="$(running_port_publishers)" \
    || refuse "could not re-enumerate port publishers before absence recovery"
  [ -z "$RECOVERY_NAMED" ] \
    && [ -z "$RECOVERY_LABELLED" ] \
    && [ -z "$RECOVERY_PUBLISHED" ] \
    || refuse "engine authority appeared while absence recovery was being prepared"
  assert_no_authority_all_states
  log "$CONTAINER is absent and no other engine authority is running; recovering under $LOCK_FILE"
  invoke_engine_up
  exit 0
fi

if [ "$CONTAINER_STATE" = "created" ] || [ "$CONTAINER_STATE" = "exited" ]; then
  [ "$RECOVER_IF_NOT_RUNNING" = "1" ] \
    || refuse "$CONTAINER is '$CONTAINER_STATE'; cutover cannot start stopped engine authority"
  [ -z "$PROMOTE_ENV_FILE_TO" ] \
    || refuse "a stopped container did not boot from the staged environment and cannot promote it"
  validate_running_identity
  [ -z "$NAMED" ] && [ -z "$LABELLED" ] && [ -z "$PUBLISHED" ] \
    || refuse "another running authority exists while $CONTAINER is '$CONTAINER_STATE'"
  assert_only_expected_authority_all_states
  prepare_target_image
  prepare_recovery_image
  [ "$ACTUAL_IMAGE_ID" = "$TARGET_IMAGE_ID" ] \
    && [ "$ACTUAL_IMAGE_ID" = "$ROLLBACK_IMAGE_ID" ] \
    || refuse "$CONTAINER is stopped on an image other than the exact requested last-known-good image"
  STOPPED_ID="$CONTAINER_ID"
  STOPPED_ROLE="$ROLE_LABEL"
  STOPPED_AUTOHEAL="$AUTOHEAL_LABEL"
  STOPPED_RESTART="$RESTART_POLICY"
  STOPPED_IMAGE_ID="$ACTUAL_IMAGE_ID"
  STOPPED_PORT_BINDINGS="$PORT_BINDINGS_JSON"
  begin_mutation_transaction
  docker start "$CONTAINER" >/dev/null 2>&1 \
    || refuse "could not start the validated $CONTAINER container"
  wait_for_exact_engine "$TARGET_IMAGE_ID" \
    || refuse "the started engine never became the exact healthy process"
  STARTED_FINGERPRINT="$(container_fingerprint)"
  [ "$STARTED_FINGERPRINT" = "$VERIFIED_ENGINE_FINGERPRINT" ] \
    || refuse "$CONTAINER restarted after its started process passed health verification"
  parse_fingerprint "$STARTED_FINGERPRINT"
  [ "$CONTAINER_ID" = "$STOPPED_ID" ] \
    && [ "$CONTAINER_STATE" = "running" ] \
    && [ "$ROLE_LABEL" = "$STOPPED_ROLE" ] \
    && [ "$AUTOHEAL_LABEL" = "$STOPPED_AUTOHEAL" ] \
    && [ "$RESTART_POLICY" = "$STOPPED_RESTART" ] \
    && [ "$ACTUAL_IMAGE_ID" = "$STOPPED_IMAGE_ID" ] \
    && [ "$PORT_BINDINGS_JSON" = "$STOPPED_PORT_BINDINGS" ] \
    || refuse "$CONTAINER changed identity or run spec while it was started"
  assert_only_expected_authority_all_states
  [ "$(container_fingerprint)" = "$VERIFIED_ENGINE_FINGERPRINT" ] \
    || refuse "$CONTAINER changed identity while started authority was revalidated"
  log "$CONTAINER was safely started in place with the exact recovery image and run spec"
  exit 0
fi

if [ "$CONTAINER_STATE" != "running" ]; then
  refuse "$CONTAINER is in transitional or unsafe state '$CONTAINER_STATE'; refusing certificate-free recovery"
fi

# A health response from 127.0.0.1 is authoritative only when the expected
# container is both the sole labelled engine and the sole publisher of the
# port being queried. Never stop a running lookalike to repair its labels.
validate_running_identity
[ "$NAMED" = "$CONTAINER" ] \
  || refuse "the running named-container set is not exactly $CONTAINER: ${NAMED:-none}"
[ "$LABELLED" = "$CONTAINER" ] \
  || refuse "the running labelled-engine set is not exactly $CONTAINER: ${LABELLED:-none}"
[ "$PUBLISHED" = "$CONTAINER" ] \
  || refuse "the running publisher of host port $PORT is not exactly $CONTAINER: ${PUBLISHED:-none}"
assert_only_expected_authority_all_states

if [ "$ENSURE_RUNNING_ONLY" = "1" ]; then
  prepare_target_image
  [ "$ACTUAL_IMAGE_ID" = "$TARGET_IMAGE_ID" ] \
    || refuse "$CONTAINER is running an image other than the verified recovery pointer $IMAGE"
  BODY="$(read_direct_health)" \
    || refuse "the exact running engine's direct health endpoint was unreadable"
  direct_health_is_live "$BODY" \
    || refuse "the exact running engine did not report running=true with live/standby liveness"
  FINGERPRINT_AFTER="$(container_fingerprint)"
  [ "$FINGERPRINT_AFTER" = "$FINGERPRINT_BEFORE" ] \
    || refuse "$CONTAINER changed identity while ensure-only health was verified"
  assert_running_sets
  assert_only_expected_authority_all_states
  [ "$(container_fingerprint)" = "$FINGERPRINT_BEFORE" ] \
    || refuse "$CONTAINER changed identity while ensure-only authority was revalidated"
  log "$CONTAINER is the exact healthy recovery image with the canonical run spec; leaving it untouched"
  exit 0
fi

prepare_target_image
prepare_recovery_image
BODY="$(read_direct_health)" || refuse "the direct live-container health endpoint was unreadable"
DB_CLOCK_SAMPLE="$(read_database_clock_sample)" \
  || refuse "a fresh direct database-clock sample could not be obtained under the host lock"
IFS='|' read -r DIRECT_DB_CLOCK_SKEW_MS DIRECT_DB_CLOCK_MEASURED_AT_MS DIRECT_DB_CLOCK_RTT_MS <<EOF
$DB_CLOCK_SAMPLE
EOF

CERTIFICATE_FLOOR_MS="$MIN_BREAK_LEFT_MS"
if [ -n "$PROMOTE_ENV_FILE_TO" ] || [ -n "$PROMOTE_IMAGE_TO" ]; then
  CERTIFICATE_FLOOR_MS="$PROMOTION_START_FLOOR_MS"
fi

VERDICT="$(
  printf '%s' "$BODY" | python3 -c '
import json, math, sys, time

floor = int(sys.argv[1])
max_skew = int(sys.argv[2])
max_window = int(sys.argv[3])
max_db_skew = int(sys.argv[4])
db_clock_skew = float(sys.argv[5])
db_clock_measured_at = float(sys.argv[6])
db_clock_rtt = float(sys.argv[7])
max_db_age = int(sys.argv[8])
max_db_rtt = int(sys.argv[9])
d = json.load(sys.stdin)
m = d.get("maintenance")
now = int(time.time() * 1000)
end = m.get("breakEndsAt") if isinstance(m, dict) else None
remaining = m.get("remainingMs") if isinstance(m, dict) else None
unparked = m.get("unparkedTables") if isinstance(m, dict) else None
reported_db_clock_skew = m.get("dbClockSkewMs") if isinstance(m, dict) else None
reported_db_clock_measured_at = (
    m.get("dbClockSkewMeasuredAt") if isinstance(m, dict) else None
)
number = lambda value: type(value) in (int, float) and math.isfinite(value)
end_delta = end - now if number(end) else None
skew = abs(remaining - end_delta) if number(remaining) and number(end_delta) else None
# The direct sample is host-clock minus database-clock. The wrapper runs on
# that host, so endDelta + dbClockSkew is the time remaining according to
# PostgreSQL, whose freeze guards are the final authority.
db_end_delta = (
    end_delta + db_clock_skew
    if number(end_delta) and number(db_clock_skew)
    else None
)
db_clock_age = now - db_clock_measured_at if number(db_clock_measured_at) else None
db_clock_uncertainty = math.ceil(db_clock_rtt / 2) + 1 if number(db_clock_rtt) else None
reported_db_clock_age = (
    now - reported_db_clock_measured_at
    if number(reported_db_clock_measured_at)
    else None
)
# Older outgoing builds publish only dbClockSkewMs. The independently sampled
# database clock below is the authority during that additive rollout. Once a
# measured-at field exists, require that telemetry pair to be fresh, bounded,
# and consistent with the direct sample as an extra cross-check.
reported_clock_safe = (
    reported_db_clock_measured_at is None
    or (
        number(reported_db_clock_skew)
        and number(reported_db_clock_age)
        and reported_db_clock_age >= 0
        and reported_db_clock_age <= max_db_age
        and abs(reported_db_clock_skew) <= max_db_skew
        and abs(reported_db_clock_skew - db_clock_skew) <= max_db_skew
    )
)
safe = (
    d.get("running") is True
    and isinstance(m, dict)
    and m.get("active") is True
    and m.get("phase") == "counting_down"
    and m.get("durableConfirmed") is True
    and m.get("readyForRestart") is True
    and type(unparked) is int
    and unparked == 0
    and number(remaining)
    and remaining >= floor
    and remaining <= max_window
    and number(end_delta)
    and end_delta >= floor
    and end_delta <= max_window
    and number(skew)
    and skew <= max_skew
    and number(db_clock_skew)
    and number(db_clock_uncertainty)
    and abs(db_clock_skew) + db_clock_uncertainty <= max_db_skew
    and number(db_clock_age)
    and db_clock_age >= 0
    and db_clock_age <= max_db_age
    and number(db_clock_rtt)
    and db_clock_rtt >= 0
    and db_clock_rtt <= max_db_rtt
    and reported_clock_safe
    and number(db_end_delta)
    and db_end_delta - db_clock_uncertainty >= floor
    and db_end_delta + db_clock_uncertainty <= max_window
)
if safe:
    print("SAFE|%d" % round(end))
else:
    print(
        "running=%s phase=%s durable=%s ready=%s remaining=%s endDelta=%s remainingSkew=%s dbClockSkew=%s dbClockMeasuredAt=%s dbClockAge=%s dbClockRtt=%s dbClockUncertainty=%s reportedDbClockSkew=%s reportedDbClockMeasuredAt=%s reportedDbClockAge=%s dbEndDelta=%s unparked=%s"
        % (
            d.get("running"),
            m.get("phase") if isinstance(m, dict) else None,
            m.get("durableConfirmed") if isinstance(m, dict) else None,
            m.get("readyForRestart") if isinstance(m, dict) else None,
            remaining,
            end_delta,
            skew,
            db_clock_skew,
            db_clock_measured_at,
            db_clock_age,
            db_clock_rtt,
            db_clock_uncertainty,
            reported_db_clock_skew,
            reported_db_clock_measured_at,
            reported_db_clock_age,
            db_end_delta,
            unparked,
        )
    )
' "$CERTIFICATE_FLOOR_MS" "$MAX_REMAINING_SKEW_MS" "$MAX_CERTIFICATE_WINDOW_MS" "$MAX_DB_CLOCK_SKEW_MS" "$DIRECT_DB_CLOCK_SKEW_MS" "$DIRECT_DB_CLOCK_MEASURED_AT_MS" "$DIRECT_DB_CLOCK_RTT_MS" "$MAX_DB_CLOCK_MEASUREMENT_AGE_MS" "$MAX_DB_CLOCK_SAMPLE_RTT_MS" 2>/dev/null || true
)"

case "$VERDICT" in
  SAFE\|*) CERTIFIED_BREAK_END_MS="${VERDICT#SAFE|}" ;;
  *) refuse "the direct certificate was not exact, fresh, and internally consistent ($VERDICT)" ;;
esac
positive_integer "$CERTIFIED_BREAK_END_MS" \
  || refuse "the direct certificate did not carry an exact break deadline"
if [ -n "$PROMOTE_ENV_FILE_TO" ] || [ -n "$PROMOTE_IMAGE_TO" ]; then
  TARGET_PROOF_DEADLINE_MS=$((CERTIFIED_BREAK_END_MS - ROLLBACK_RESERVE_MS))
  deadline_allows "$TARGET_PROOF_DEADLINE_MS" 0 \
    || refuse "the certified break leaves no bounded target-proof budget before rollback reserve"
fi

# Re-read every piece of identity after the network/JSON work and before
# invoking engine-up. A restart, replacement, label change, or port handoff
# invalidates the certificate even if the health body itself looked perfect.
FINGERPRINT_AFTER="$(container_fingerprint)"
[ "$FINGERPRINT_AFTER" = "$FINGERPRINT_BEFORE" ] \
  || refuse "$CONTAINER changed identity while its certificate was being read"
assert_running_sets
assert_only_expected_authority_all_states
[ "$(container_fingerprint)" = "$FINGERPRINT_BEFORE" ] \
  || refuse "$CONTAINER changed identity while final certificate authority was revalidated"

log "certificate accepted for $CONTAINER under $LOCK_FILE; invoking engine-up without releasing the lock"
invoke_engine_up
