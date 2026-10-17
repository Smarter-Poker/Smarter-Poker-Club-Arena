#!/usr/bin/env bash
# Controlled engine crash drill (DA08), run only by .github/workflows/engine-drill.yml.
#
# docs/runbooks/maintenance-break-fire-drill.md retired the direct-SSH container
# kill and listed what a live crash drill must have instead. This script is that
# route. Each line of the runbook, and where it is enforced:
#
#   exact full merged SHA, pinned host     the workflow (protected-main control
#                                          commit, pinned host key); here the
#                                          expected SHA must be the sealed desired
#                                          release AND the running container
#   drill authorization                    --authorization-b64, 12-200 printable
#                                          characters, recorded in every receipt
#   one owning release lane                one drill at a time (drill lock); stands
#                                          aside while any release/intake unit or
#                                          seal pending owner exists; holds the
#                                          SAME engine mutation lock the release
#                                          transaction holds, for the whole
#                                          mutation and recovery
#   table-safe break admission             the release transaction's own certificate
#                                          predicates (scheduled break, counting
#                                          down, durable, readyForRestart,
#                                          unparkedTables == 0, handsInFlightTotal
#                                          == 0) at the ordinary and locked rungs
#   before/after provenance receipts       append-only audit plus one receipt per run
#   automatic refusal when unclear         any unreadable or unexpected fact before
#                                          the kill refuses with nothing mutated
#   cache-busted health + hand progression local and public /health (cache-busted),
#                                          the database leader, the break outcome,
#                                          the thaw and hands dealt after it
#
# THE ONE MUTATION is SIGKILL to the serving engine's process, from the host, the
# way the kernel's OOM killer ends it: no SIGTERM, no drain, no lease release.
# `docker kill` is NOT used - Docker records it as a manual stop and the restart
# policy may not fire, which would rehearse an operator, not a crash. Recovery
# must come from production supervision alone (restart=always, sp-autoheal).
# Only if it does not arrive in time does this script invoke the existing forced
# desired-runtime restore, and the drill is then recorded as FAILED.
#
# Exit 0: passed. Exit 1: refused (nothing mutated) or failed (see the receipt).
set -euo pipefail

DRILL_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DRILL_DATABASE_PROOF="$DRILL_DIR/engine-drill-database-proof.py"
CONTROL_DIR="${ENGINE_CONTROL_DIR:-/usr/local/lib/club-arena/engine-control}"
RELEASE_SEAL="$CONTROL_DIR/engine-release-seal.py"
DATABASE_PROOF="$CONTROL_DIR/engine-release-database-proof.py"
SUPERVISOR="$CONTROL_DIR/engine-supervisor.sh"
ENV_FILE="${ENV_FILE:-/opt/club-arena/server/.env}"
ENGINE_LOCK="${ENGINE_LOCK_FILE:-/var/lock/club-arena-engine-up.lock}"
DRILL_LOCK="${ENGINE_DRILL_LOCK_FILE:-/var/lock/club-arena-engine-drill.lock}"
STATE_DIR="${ENGINE_DRILL_STATE_DIR:-/var/lib/club-arena/engine-drills}"
CONTAINER=club-arena-engine
AUTOHEAL=sp-autoheal
LOCAL_HEALTH=http://127.0.0.1:8080/health
PUBLIC_URL=https://engine.smarter.poker

# The release transaction's own rungs (engine-release-transaction.sh): admit
# only with the ordinary rung left, re-certify under the lock at the locked rung.
ADMIT_MIN_REMAINING_MS=260000
LOCKED_MIN_REMAINING_MS=245000
# The kill happens only while this much break is left, so the whole recovery
# proof below fits inside the break with the forced-restore reserve intact.
KILL_MIN_REMAINING_MS=230000
# The supervisor restarts in milliseconds; a minute without a new process is a
# supervision failure, not a slow boot.
CONTAINER_RESTART_SECONDS="${ENGINE_DRILL_RESTART_SECONDS:-60}"
[[ "$CONTAINER_RESTART_SECONDS" =~ ^[0-9]+$ ]] && [ "$CONTAINER_RESTART_SECONDS" -ge 5 ] \
  && [ "$CONTAINER_RESTART_SECONDS" -le 60 ] \
  || { echo '[engine-crash-drill] FATAL: the restart wait may only be shortened (5-60 seconds)' >&2; exit 1; }
# The release transaction gives a fresh process 36 x 5 s of local health; the
# drill holds the restarted process to the same 180 s (shortening only).
HEALTH_RECOVERY_SECONDS="${ENGINE_DRILL_HEALTH_SECONDS:-180}"
[[ "$HEALTH_RECOVERY_SECONDS" =~ ^[0-9]+$ ]] && [ "$HEALTH_RECOVERY_SECONDS" -ge 5 ] \
  && [ "$HEALTH_RECOVERY_SECONDS" -le 180 ] \
  || { echo '[engine-crash-drill] FATAL: the health wait may only be shortened (5-180 seconds)' >&2; exit 1; }
# Kept back from the break end for the forced desired-runtime restore.
RECOVERY_RESERVE_SECONDS=60
# After the countdown ends: the engine must leave the break, thaw, and deal.
POST_BREAK_SECONDS=300
MIN_HANDS_AFTER_THAW=20
MIN_TABLES_AFTER_THAW=5
POLL_SECONDS="${ENGINE_DRILL_POLL_SECONDS:-5}"
[[ "$POLL_SECONDS" =~ ^[1-5]$ ]] || { echo '[engine-crash-drill] FATAL: poll interval must be 1-5 seconds' >&2; exit 1; }

PHASE=preflight
MUTATED=0
LOCK_HELD=0
RUN_ID=''
RECEIPT=''
AUDIT=''

log() { echo "[engine-crash-drill] $*" >&2; }

record() {
  # record <event> <json-object>: append to the audit and merge into the receipt.
  [ -n "$RECEIPT" ] || return 0
  python3 - "$AUDIT" "$RECEIPT" "$RUN_ID" "$1" "$2" <<'PY'
import json, os, sys, time
audit, receipt, run, event, payload = sys.argv[1:]
data = json.loads(payload)
entry = {"at": int(time.time() * 1000), "run": run, "event": event, "data": data}
with open(audit, "a", encoding="utf-8") as fh:
    fh.write(json.dumps(entry, sort_keys=True) + "\n"); fh.flush(); os.fsync(fh.fileno())
try:
    with open(receipt, encoding="utf-8") as fh: doc = json.load(fh)
except FileNotFoundError:
    doc = {"schema": 1, "run": run, "events": []}
doc["events"].append(entry)
if event in {"refused", "failed", "passed"}:
    doc["result"] = event
tmp = receipt + ".tmp"
with open(tmp, "w", encoding="utf-8") as fh:
    json.dump(doc, fh, indent=2, sort_keys=True); fh.flush(); os.fsync(fh.fileno())
os.replace(tmp, receipt)
PY
}

json_reason() { python3 -c 'import json,sys; print(json.dumps({"phase": sys.argv[1], "reason": sys.argv[2]}))' "$PHASE" "$1"; }

refuse() {
  # Nothing was mutated. Say why, keep the receipt, exit 1.
  log "REFUSED ($PHASE): $1"
  record refused "$(json_reason "$1")" || true
  echo 'ENGINE_DRILL_RESULT=refused'
  echo "ENGINE_DRILL_REASON=$1"
  exit 1
}

forced_restore() {
  # The existing desired-runtime recovery, exactly as the release transaction
  # calls it: caller-held lock, force desired, exact health, bounded deadline.
  local deadline="$1" seconds
  seconds=$(( deadline - $(date +%s) ))
  [ "$seconds" -ge 30 ] || seconds=300
  [ "$seconds" -le 300 ] || seconds=300
  log "invoking the forced desired-runtime restore (${seconds}s)"
  timeout --signal=TERM --kill-after=1s "${seconds}s" env \
    ENGINE_SUPERVISOR_LOCK_HELD=1 ENGINE_SUPERVISOR_FORCE_DESIRED=1 \
    ENGINE_SUPERVISOR_REQUIRE_EXACT_HEALTH=1 \
    ENGINE_RECOVERY_DEADLINE_EPOCH="$(( $(date +%s) + seconds ))" \
    ENGINE_CONTROL_DIR="$CONTROL_DIR" CONTAINER="$CONTAINER" ENGINE_URL="$PUBLIC_URL" \
    "$SUPERVISOR"
}

fail() {
  # The process was killed and production supervision did not prove recovery.
  # Restore the sealed desired runtime now, record the failure, exit 1.
  log "FAILED ($PHASE): $1"
  record failed "$(json_reason "$1")" || true
  if [ "$MUTATED" = 1 ] && [ "${RESTORE_ATTEMPTED:-0}" = 0 ]; then
    RESTORE_ATTEMPTED=1
    if [ "$LOCK_HELD" = 1 ]; then
      if forced_restore "$(( ${BREAK_END_EPOCH:-$(date +%s)} ))"; then
        record forced_restore '{"restored": true}' || true
      else
        record forced_restore '{"restored": false}' || true
      fi
    fi
  fi
  echo 'ENGINE_DRILL_RESULT=failed'
  echo "ENGINE_DRILL_REASON=$1"
  exit 1
}

on_exit() {
  local status=$?
  if [ "$status" -ne 0 ] && [ "$MUTATED" = 1 ] && [ "${RESTORE_ATTEMPTED:-0}" = 0 ] && [ "$LOCK_HELD" = 1 ]; then
    # An unexpected exit after the kill must never leave the engine absent.
    RESTORE_ATTEMPTED=1
    forced_restore "$(( ${BREAK_END_EPOCH:-$(date +%s)} ))" || true
  fi
  if [ "$LOCK_HELD" = 1 ]; then flock -u 9 || true; fi
}
trap on_exit EXIT
trap 'fail "interrupted by a signal"' HUP INT TERM

# ── Arguments ───────────────────────────────────────────────────────────────
[ "$(id -u)" = 0 ] || { log 'FATAL: must run as root'; exit 1; }
[ "$#" = 8 ] && [ "$1" = --run-id ] && [ "$3" = --expected-sha ] \
  && [ "$5" = --not-after-epoch ] && [ "$7" = --authorization-b64 ] \
  || { log 'FATAL: usage: --run-id RUN --expected-sha SHA --not-after-epoch EPOCH --authorization-b64 B64'; exit 1; }
RUN_ID="$2"
EXPECTED_SHA="$4"
NOT_AFTER_EPOCH="$6"
AUTHORIZATION_B64="$8"
[[ "$RUN_ID" =~ ^[1-9][0-9]*-[1-9][0-9]*$ ]] || { log 'FATAL: run key is invalid'; exit 1; }
[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]] || { log 'FATAL: expected SHA is invalid'; exit 1; }
[[ "$NOT_AFTER_EPOCH" =~ ^[1-9][0-9]{9}$ ]] || { log 'FATAL: not-after epoch is invalid'; exit 1; }
AUTHORIZATION="$(python3 - "$AUTHORIZATION_B64" <<'PY'
import base64, binascii, sys
try:
    value = base64.b64decode(sys.argv[1], validate=True).decode("utf-8")
except (binascii.Error, UnicodeDecodeError):
    raise SystemExit(1)
if not 12 <= len(value) <= 200 or any(ord(c) < 32 or ord(c) == 127 for c in value):
    raise SystemExit(1)
print(value)
PY
)" || { log 'FATAL: drill authorization must be 12-200 printable characters'; exit 1; }

install -d -m 0700 "$STATE_DIR"
RECEIPT="$STATE_DIR/$RUN_ID.json"
AUDIT="$STATE_DIR/audit.jsonl"
[ ! -e "$RECEIPT" ] || { log "FATAL: run $RUN_ID already has a drill receipt"; RECEIPT=''; exit 1; }
record requested "$(python3 -c 'import json,sys; print(json.dumps({"drill": "crash", "expectedSha": sys.argv[1], "notAfterEpoch": int(sys.argv[2]), "authorization": sys.argv[3]}))' "$EXPECTED_SHA" "$NOT_AFTER_EPOCH" "$AUTHORIZATION")"

exec 8>"$DRILL_LOCK"
flock -n 8 || refuse 'another engine drill is running on this host'

for binary in curl docker flock python3 systemctl timeout; do
  command -v "$binary" >/dev/null || refuse "missing host prerequisite: $binary"
done
for path in "$RELEASE_SEAL" "$DATABASE_PROOF" "$SUPERVISOR" "$DRILL_DATABASE_PROOF"; do
  [ -x "$path" ] || refuse "control file is not executable: $path"
done
[ -s "$ENV_FILE" ] || refuse 'the fixed engine environment is absent'

# ── Reads ───────────────────────────────────────────────────────────────────
health_json() {
  # health_json local|public: one cache-busted /health body. 503 can carry a
  # valid break certificate (see engine-release-transaction.sh), so keep it.
  local url response code
  if [ "$1" = local ]; then url="$LOCAL_HEALTH?drill=$RUN_ID-$(date +%s%N)"; else url="$PUBLIC_URL/health?drill=$RUN_ID-$(date +%s%N)"; fi
  response="$(curl -sS --max-time 10 -H 'Cache-Control: no-cache, no-store' \
    --write-out $'\n%{http_code}' "$url" 2>/dev/null)" || return 1
  code="${response##*$'\n'}"
  case "$code" in 200|503) ;; *) return 1 ;; esac
  printf '%s' "${response%$'\n'*}"
}

maintenance_active() {
  # maintenance_active <json>: prints true or false; unreadable fails.
  printf '%s' "$1" | python3 -c '
import json, sys
m = json.load(sys.stdin).get("maintenance")
if not isinstance(m, dict) or not isinstance(m.get("active"), bool): raise SystemExit(1)
print("true" if m["active"] else "false")' 2>/dev/null
}

exact_identity() {
  # exact_identity <json>: running, this release, live; prints instanceId.
  printf '%s' "$1" | EXPECTED_SHA="$EXPECTED_SHA" python3 -c '
import json, os, re, sys
d = json.load(sys.stdin); i = d.get("instanceId")
ok = d.get("running") is True and d.get("releaseSha") == os.environ["EXPECTED_SHA"] and d.get("liveness") == "ok" and isinstance(i, str) and re.fullmatch(r"[1-9][0-9]*-[0-9a-f]{8}", i)
if not ok: raise SystemExit(1)
print(i)' 2>/dev/null
}

certificate() {
  # certificate <json> <minimum ms>: the release transaction's table-safe break
  # predicates, plus the engine's own in-flight witness. Prints
  # "<remainingMs> <breakEndsAtMs>"; exit 2 means too little break left.
  printf '%s' "$1" | MIN_MS="$2" python3 -c '
import json, os, sys
d = json.load(sys.stdin); m = d.get("maintenance")
if not isinstance(m, dict): raise SystemExit(1)
window = (d.get("running") is True and m.get("active") is True
          and m.get("phase") == "counting_down" and m.get("durableConfirmed") is True)
if not window: raise SystemExit(1)
remaining = m.get("remainingMs"); ends = m.get("breakEndsAt")
if not isinstance(remaining, int) or isinstance(remaining, bool) or not isinstance(ends, int): raise SystemExit(1)
if m.get("reason") != "Scheduled Engine Maintenance": raise SystemExit(1)
hands = d.get("handsInFlightTotal")
safe = (m.get("readyForRestart") is True and m.get("unparkedTables") == 0
        and isinstance(hands, int) and not isinstance(hands, bool) and hands == 0)
if not safe: raise SystemExit(1)
# The two clocks must describe the same break: a remaining time that disagrees
# with the end instant by more than five seconds is not a certificate.
import time
if abs((ends - int(time.time() * 1000)) - remaining) > 5000: raise SystemExit(1)
if remaining < int(os.environ["MIN_MS"]): print(remaining, ends); raise SystemExit(2)
print(remaining, ends)' 2>/dev/null
}

release_lane_is_free() {
  # No release or intake unit may be live, and the seal may have no pending
  # cutover: a release always owns the break before a drill does.
  local units pending
  units="$(systemctl list-units --all --plain --no-legend \
    'club-arena-engine-release-v1@*' 'club-arena-engine-intake-v1@*' 2>/dev/null \
    | awk '$3 == "active" || $3 == "activating" || $3 == "deactivating" || $3 == "reloading" {print $1}')" || return 1
  [ -z "$units" ] || { log "release lane busy: $units"; return 1; }
  pending="$(timeout --signal=TERM --kill-after=1s 10s "$RELEASE_SEAL" pending-owner)" || return 1
  [ "$pending" = none ] || { log "release seal has a pending owner: $pending"; return 1; }
}

container_fact() {
  timeout --signal=TERM --kill-after=1s 10s docker container inspect -f "$1" "$CONTAINER" 2>/dev/null
}

# ── Preflight: the serving release is the sealed one, supervised as production ──
DESIRED_SHA="$(timeout --signal=TERM --kill-after=1s 10s "$RELEASE_SEAL" get desired-sha)" \
  || refuse 'the sealed desired release is unreadable'
DESIRED_IMAGE="$(timeout --signal=TERM --kill-after=1s 10s "$RELEASE_SEAL" get desired-image-id)" \
  || refuse 'the sealed desired image is unreadable'
[ "$DESIRED_SHA" = "$EXPECTED_SHA" ] \
  || refuse "the sealed desired release is $DESIRED_SHA, not the requested $EXPECTED_SHA"
[[ "$DESIRED_IMAGE" =~ ^sha256:[0-9a-f]{64}$ ]] || refuse 'the sealed desired image id is malformed'

check_supervision() {
  local state label image policy autoheal autoheal_label
  state="$(container_fact '{{.State.Status}}')" || return 1
  label="$(container_fact '{{index .Config.Labels "sp.release.sha"}}')" || return 1
  image="$(container_fact '{{.Image}}')" || return 1
  policy="$(container_fact '{{.HostConfig.RestartPolicy.Name}}')" || return 1
  autoheal_label="$(container_fact '{{index .Config.Labels "autoheal"}}')" || return 1
  autoheal="$(timeout --signal=TERM --kill-after=1s 10s docker container inspect -f '{{.State.Status}}' "$AUTOHEAL" 2>/dev/null)" || return 1
  [ "$state" = running ] && [ "$label" = "$EXPECTED_SHA" ] && [ "$image" = "$DESIRED_IMAGE" ] \
    && [ "$policy" = always ] && [ "$autoheal_label" = true ] && [ "$autoheal" = running ]
}
check_supervision \
  || refuse 'the serving container is not the sealed release under production supervision (restart=always, autoheal)'
release_lane_is_free || refuse 'the release lane is not free'
BODY="$(health_json local)" || refuse 'local /health is unreadable'
exact_identity "$BODY" >/dev/null || refuse 'local /health is not the exact live sealed release'
record preflight "$(python3 -c 'import json,sys; print(json.dumps({"desiredSha": sys.argv[1], "desiredImage": sys.argv[2]}))' "$DESIRED_SHA" "$DESIRED_IMAGE")"

# ── Admission: wait for a scheduled break this drill may use ────────────────
PHASE=admission
ADMISSION_DEADLINE=$(( NOT_AFTER_EPOCH - 900 ))
[ "$ADMISSION_DEADLINE" -gt "$(date +%s)" ] || refuse 'the drill budget leaves no break to use'
ADMITTED=''
while [ "$(date +%s)" -lt "$ADMISSION_DEADLINE" ]; do
  if BODY="$(health_json local)"; then
    set +e
    CERT="$(certificate "$BODY" "$ADMIT_MIN_REMAINING_MS")"
    CERT_RC=$?
    set -e
    if [ "$CERT_RC" = 0 ]; then
      if release_lane_is_free; then
        ADMITTED="$CERT"
        break
      fi
      log 'a release owns this break; standing aside'
      # Do not reconsider this break: wait for it to end.
      sleep 240
    fi
  fi
  sleep "$POLL_SECONDS"
done
[ -n "$ADMITTED" ] || refuse 'no table-safe scheduled break admitted the drill before its deadline'

# ── Locked certification: the same lock a release cutover holds ─────────────
PHASE=locked
exec 9>"$ENGINE_LOCK"
flock -w 10 9 || refuse 'the engine mutation lock is held by a release'
LOCK_HELD=1
release_lane_is_free || refuse 'a release took the lane while the drill waited for the lock'
check_supervision || refuse 'supervision changed before the drill could certify the break'
BODY="$(health_json local)" || refuse 'local /health is unreadable under the lock'
BEFORE_INSTANCE="$(exact_identity "$BODY")" || refuse 'local /health is not the exact sealed release under the lock'
set +e
CERT="$(certificate "$BODY" "$LOCKED_MIN_REMAINING_MS")"
CERT_RC=$?
set -e
[ "$CERT_RC" = 0 ] || refuse "the locked break certificate did not hold (status $CERT_RC)"
read -r REMAINING_MS BREAK_ENDS_AT_MS <<< "$CERT"
BREAK_END_EPOCH=$(( BREAK_ENDS_AT_MS / 1000 ))
BREAK_STARTED_AT_MS=$(( BREAK_ENDS_AT_MS - 300000 ))

PUBLIC_BODY="$(health_json public)" || refuse 'public /health is unreadable'
PUBLIC_BEFORE="$(exact_identity "$PUBLIC_BODY")" || refuse 'public /health is not the exact sealed release'
[ "$PUBLIC_BEFORE" = "$BEFORE_INSTANCE" ] || refuse 'public and local /health name different instances'
timeout --signal=TERM --kill-after=1s 22s "$DATABASE_PROOF" --env-file "$ENV_FILE" \
  --sha "$EXPECTED_SHA" --instance-id "$BEFORE_INSTANCE" --timeout-seconds 20 \
  --poll-seconds 5 --max-heartbeat-age-seconds 15 >/dev/null \
  || refuse 'the database leader is not the serving instance with a fresh heartbeat'
BEFORE_CONTAINER_ID="$(container_fact '{{.Id}}')" || refuse 'container id is unreadable'
BEFORE_STARTED_AT="$(container_fact '{{.State.StartedAt}}')" || refuse 'container start is unreadable'
BEFORE_RESTARTS="$(container_fact '{{.RestartCount}}')" || refuse 'restart count is unreadable'
TARGET_PID="$(container_fact '{{.State.Pid}}')" || refuse 'engine process id is unreadable'
[[ "$BEFORE_RESTARTS" =~ ^[0-9]+$ ]] || refuse 'restart count is malformed'
[[ "$TARGET_PID" =~ ^[1-9][0-9]*$ ]] && [ "$TARGET_PID" -gt 1 ] || refuse 'engine process id is malformed'
record before "$(python3 -c '
import json, sys
k = ["instanceId", "containerId", "startedAt", "restartCount", "pid", "remainingMs", "breakEndsAtMs", "breakStartedAtMs"]
print(json.dumps(dict(zip(k, sys.argv[1:]))))' \
  "$BEFORE_INSTANCE" "$BEFORE_CONTAINER_ID" "$BEFORE_STARTED_AT" "$BEFORE_RESTARTS" "$TARGET_PID" \
  "$REMAINING_MS" "$BREAK_ENDS_AT_MS" "$BREAK_STARTED_AT_MS")"

# One last fresh read immediately before the kill.
BODY="$(health_json local)" || refuse 'local /health is unreadable immediately before the kill'
set +e
CERT="$(certificate "$BODY" "$KILL_MIN_REMAINING_MS")"
CERT_RC=$?
set -e
[ "$CERT_RC" = 0 ] || refuse "the break certificate did not hold immediately before the kill (status $CERT_RC)"
[ "$(container_fact '{{.State.Pid}}')" = "$TARGET_PID" ] || refuse 'the engine process changed before the kill'

# ── The one mutation ────────────────────────────────────────────────────────
PHASE=kill
MUTATED=1
KILLED_AT_MS="$(date +%s%3N)"
kill -KILL "$TARGET_PID" || fail 'SIGKILL could not be delivered to the engine process'
record killed "$(python3 -c 'import json,sys; print(json.dumps({"pid": int(sys.argv[1]), "killedAtMs": int(sys.argv[2])}))' "$TARGET_PID" "$KILLED_AT_MS")"

# ── Recovery inside the break, by production supervision alone ──────────────
PHASE=supervisor_restart
RECOVERY_DEADLINE=$(( BREAK_END_EPOCH - RECOVERY_RESERVE_SECONDS ))
HEALTH_DEADLINE=$(( KILLED_AT_MS / 1000 + HEALTH_RECOVERY_SECONDS ))
[ "$HEALTH_DEADLINE" -le "$RECOVERY_DEADLINE" ] || HEALTH_DEADLINE="$RECOVERY_DEADLINE"
RESTART_DEADLINE=$(( $(date +%s) + CONTAINER_RESTART_SECONDS ))
[ "$RESTART_DEADLINE" -le "$RECOVERY_DEADLINE" ] || RESTART_DEADLINE="$RECOVERY_DEADLINE"
RESTARTED=''
while [ "$(date +%s)" -lt "$RESTART_DEADLINE" ]; do
  state="$(container_fact '{{.State.Status}}' || true)"
  restarts="$(container_fact '{{.RestartCount}}' || true)"
  started="$(container_fact '{{.State.StartedAt}}' || true)"
  if [ "$state" = running ] && [[ "$restarts" =~ ^[0-9]+$ ]] && [ "$restarts" -gt "$BEFORE_RESTARTS" ] \
    && [ -n "$started" ] && [ "$started" != "$BEFORE_STARTED_AT" ]; then
    RESTARTED="$restarts $started"
    break
  fi
  sleep 1
done
[ -n "$RESTARTED" ] || fail 'production supervision did not restart the engine process'
read -r AFTER_RESTARTS AFTER_STARTED_AT <<< "$RESTARTED"
[ "$(container_fact '{{.Id}}')" = "$BEFORE_CONTAINER_ID" ] || fail 'a different container replaced the drilled one'
[ "$(container_fact '{{.Image}}')" = "$DESIRED_IMAGE" ] || fail 'the restarted container is not the sealed desired image'
[ "$(container_fact '{{index .Config.Labels "sp.release.sha"}}')" = "$EXPECTED_SHA" ] || fail 'the restarted container is not the sealed release'
record restarted "$(python3 -c 'import json,sys; print(json.dumps({"restartCount": int(sys.argv[1]), "startedAt": sys.argv[2]}))' "$AFTER_RESTARTS" "$AFTER_STARTED_AT")"

PHASE=exact_health
AFTER_INSTANCE=''
while [ "$(date +%s)" -lt "$HEALTH_DEADLINE" ]; do
  if BODY="$(health_json local)" && instance="$(exact_identity "$BODY")" && [ "$instance" != "$BEFORE_INSTANCE" ]; then
    AFTER_INSTANCE="$instance"
    break
  fi
  sleep "$POLL_SECONDS"
done
[ -n "$AFTER_INSTANCE" ] || fail 'the restarted engine never reported exact live health'

PHASE=public_health
PUBLIC_AFTER=''
while [ "$(date +%s)" -lt "$HEALTH_DEADLINE" ]; do
  if PUBLIC_BODY="$(health_json public)" && instance="$(exact_identity "$PUBLIC_BODY")"; then
    PUBLIC_AFTER="$instance"
    [ "$PUBLIC_AFTER" = "$AFTER_INSTANCE" ] && break
  fi
  sleep "$POLL_SECONDS"
done
[ "$PUBLIC_AFTER" = "$AFTER_INSTANCE" ] || fail 'public /health never served the recovered instance'

PHASE=database_leader
LEADER_SECONDS=$(( HEALTH_DEADLINE - $(date +%s) ))
[ "$LEADER_SECONDS" -ge 10 ] || fail 'no break time left to prove database leadership'
timeout --signal=TERM --kill-after=1s "$(( LEADER_SECONDS + 2 ))s" "$DATABASE_PROOF" --env-file "$ENV_FILE" \
  --sha "$EXPECTED_SHA" --instance-id "$AFTER_INSTANCE" --timeout-seconds "$LEADER_SECONDS" \
  --poll-seconds 5 --max-heartbeat-age-seconds 15 >/dev/null \
  || fail 'the recovered instance did not become the fresh database leader inside the break'

PHASE=break_adopted
BODY="$(health_json local)" || fail 'local /health is unreadable after recovery'
ADOPTED="$(printf '%s' "$BODY" | python3 -c '
import json, sys
d = json.load(sys.stdin); m = d.get("maintenance") or {}
print("true" if m.get("active") is True and m.get("durableConfirmed") is True else "false")' 2>/dev/null)" \
  || fail 'the recovered engine maintenance state is unreadable'
NOW_EPOCH="$(date +%s)"
if [ "$NOW_EPOCH" -lt "$BREAK_END_EPOCH" ] && [ "$ADOPTED" != true ]; then
  fail 'the recovered engine did not adopt the durable break it was killed inside'
fi
RECOVERED_AT_MS="$(date +%s%3N)"
record recovered "$(python3 -c '
import json, sys
print(json.dumps({"instanceId": sys.argv[1], "publicInstanceId": sys.argv[2], "breakAdopted": sys.argv[3] == "true",
                  "recoveredAtMs": int(sys.argv[4]), "recoverySeconds": (int(sys.argv[4]) - int(sys.argv[5])) / 1000}))' \
  "$AFTER_INSTANCE" "$PUBLIC_AFTER" "$ADOPTED" "$RECOVERED_AT_MS" "$KILLED_AT_MS")"

# Recovery is proved; the break is too short for a release now. Free the lane.
flock -u 9
LOCK_HELD=0

# ── After the break: leave it, thaw, deal ───────────────────────────────────
PHASE=post_break
POST_DEADLINE=$(( BREAK_END_EPOCH + POST_BREAK_SECONDS ))
LEFT_BREAK=''
while [ "$(date +%s)" -lt "$POST_DEADLINE" ]; do
  if BODY="$(health_json local)" && exact_identity "$BODY" >/dev/null; then
    active="$(maintenance_active "$BODY" || echo unknown)"
    if [ "$active" = false ]; then LEFT_BREAK=1; break; fi
  fi
  sleep "$POLL_SECONDS"
done
[ -n "$LEFT_BREAK" ] || fail 'the recovered engine did not leave the break'
BODY="$(health_json local)" && [ "$(exact_identity "$BODY")" = "$AFTER_INSTANCE" ] \
  || fail 'the engine that left the break is not the recovered instance'
PROOF_SECONDS=$(( POST_DEADLINE - $(date +%s) ))
[ "$PROOF_SECONDS" -ge 30 ] || PROOF_SECONDS=30
[ "$PROOF_SECONDS" -le 300 ] || PROOF_SECONDS=300
DB_VERDICT="$(timeout --signal=TERM --kill-after=1s "$(( PROOF_SECONDS + 5 ))s" "$DRILL_DATABASE_PROOF" \
  --env-file "$ENV_FILE" --sha "$EXPECTED_SHA" --instance-id "$AFTER_INSTANCE" \
  --break-started-at-ms "$BREAK_STARTED_AT_MS" --min-hands "$MIN_HANDS_AFTER_THAW" \
  --min-tables "$MIN_TABLES_AFTER_THAW" --timeout-seconds "$PROOF_SECONDS" --poll-seconds 10)" \
  || fail 'the database did not witness the thaw and hand progression after the drilled break'
PUBLIC_BODY="$(health_json public)" && [ "$(exact_identity "$PUBLIC_BODY")" = "$AFTER_INSTANCE" ] \
  || fail 'public /health no longer serves the recovered instance after the break'

PHASE=done
record passed "$DB_VERDICT"
echo 'ENGINE_DRILL_RESULT=passed'
echo "ENGINE_DRILL_RECEIPT=$RECEIPT"
