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
INFLIGHT_HANDS="$CONTROL_DIR/engine-release-inflight-hands.py"
LEGACY_CHECKPOINT="$CONTROL_DIR/legacy-engine-checkpoint.sh"
LEGACY_CHECKPOINT_SHA=2f4e33560bcd23bfb5cc731f31816b2c2e2847e5
CHECKPOINT_758_SHA=758610f3f844406bbbaee2f5100ced36d84fb943
CHECKPOINT_A0_SHA=a0ab287d902879280f0c915e44f5222c5db4d7df
CHECKPOINT_8825_SHA=8825af51817f379c4261658ca29ecc9d8d81932d
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
# THE LEGACY CHECKPOINT GETS THE SECONDS IT NEEDS (2026-09-21)
# ───────────────────────────────────────────────────────────
# The engine's countdown is BREAK_DURATION_MS, 300000ms, every break. The
# strict 285000ms certificate above leaves 15 seconds of entry slack, and the
# legacy 8825 checkpoint has to fit inside it: countdown detection, the
# rollback proof, the helper preamble AND the publisher's bounded work. In run
# 35615604946 the sequence reached the guard's first check 15.2 seconds into
# the countdown and it refused with insufficient_reserve, as the arithmetic
# says it always must. So the checkpoint's whole budget is written down here
# and taken out of the CANDIDATE PROOF budget, never the rollback reserve.
# The budget is what the transaction ACTUALLY PAYS between the admission and
# the guard's last check, all of it measured:
#   entry     ~15000ms  countdown detection (~4.7s, one 5s poll), the
#                       rollback proof (~5.3s) and the helper preamble
#                       (~5.2s) on run 35615604946, then the intent write
#                       and the guard's own node boot
#   work       20000ms  legacy-engine-checkpoint.mjs workBudgetMs
#   cleanup     5000ms  legacy-engine-checkpoint.mjs cleanupBudgetMs
#   budget     40000ms  LEGACY_CHECKPOINT_BUDGET_SECONDS
# The guard holds reserveMs = 285 - 40 = 245 seconds at EVERY check, and the
# certificate read after the checkpoint accepts the same 245000ms, which still
# holds the full 135-second rollback reserve and leaves 110 seconds of
# candidate proof against the 51-112 seconds sealed runs have measured: a
# proof at the top of that range now rolls back inside the untouched reserve
# instead of sealing, and the changelog says so. The checkpoint may only START
# inside the 285000ms entry slack; that entry check, and the ordinary
# certificate for every non-legacy release, do not move. The first cut of this
# (25 seconds, 260000ms) budgeted the publisher's work and left the ~15s entry
# to fit inside the 15s the break has above 285000, which is the same
# impossibility one gate later.
LEGACY_CHECKPOINT_BUDGET_SECONDS=40
# The publisher's bounded work inside that budget, from the .mjs figures
# above; what is left of the budget is the allowance for the entry.
LEGACY_CHECKPOINT_WORK_MS=25000
NON_BREAK_RECOVERY_MAX_SECONDS=300
# CLAUDE.md 13: the engine restarts inside the announced break that opens at
# :55 of every hour. This is the same minute every other surface reads, and
# tests/the-break-clocks-agree.law.test.ts pins them together.
BREAK_START_MINUTE=55
MIN_BREAK_REMAINING_MS=$(((BREAK_CUTOVER_PROOF_SECONDS + BREAK_ROLLBACK_RESERVE_SECONDS + BREAK_DEADLINE_SLACK_SECONDS) * 1000))
LEGACY_MIN_BREAK_REMAINING_MS=$(((BREAK_CUTOVER_PROOF_SECONDS + BREAK_ROLLBACK_RESERVE_SECONDS + BREAK_DEADLINE_SLACK_SECONDS - LEGACY_CHECKPOINT_BUDGET_SECONDS) * 1000))
# The engine's break is BREAK_DURATION_MS = 5 * 60 * 1000 in
# server/src/maintenance/MaintenanceBreak.ts, pinned across every surface by
# tests/the-break-clocks-agree.law.test.ts. The strict reserve above takes
# 285000 of it, so 15000ms is all the break has above the entry threshold.
BREAK_WINDOW_MS=300000
# THE ENTRY IS INSIDE THE BUDGET, NOT ABOVE THE THRESHOLD (2026-09-21).
# Four separate gates used to demand the SAME 285000ms against the same
# break: maintenance_certificate, legacy_checkpoint_countdown below, the
# physical probe in legacy-engine-checkpoint.sh, and finally the guard's own
# reserveMs. Between them sit the engine lock, a sealed-SHA read,
# prove_rollback_readiness (about twenty bounded host round trips, a loopback
# probe, a public HTTPS probe and a database leader proof) and a cold node
# boot. BREAK_DEADLINE_SLACK_SECONDS is 0, so none of that was budgeted: an
# admission at 285001ms remaining handed the LAST gate a guaranteed deficit,
# and the refusal was terminal. Run 35615604946 is the measurement - admitted
# with at least 285000ms, the guard read about 272500ms.
# PR #5026 answered by adding a measured entry budget to the ADMISSION
# threshold (285000 + up to 15000). That cannot close either: the countdown
# is 300000ms, the entry costs ~15000ms of it before the guard's first read,
# so after one miss the admission demanded a countdown the engine only offers
# at t=0, and every break deferred. The reconciliation keeps the entry cost
# INSIDE LEGACY_CHECKPOINT_BUDGET_SECONDS (its 15000ms allowance) and moves
# the guard's reserve down to 245000 instead; the admission stays at 285000.
# The allowance is derived, not chosen, and the ceiling on the admission
# headroom is what the break offers above 285000 minus what the budget
# already reserves for the entry: 15000 - 15000 = 0. legacy_checkpoint_
# countdown still takes the headroom argument and the measurement below is
# still taken and logged, so if the budget's arithmetic ever changes the
# ceiling moves with it; today it is 0 and an admission can never be more
# permissive than the strict 285000ms.
LEGACY_ENTRY_ALLOWANCE_MS=$((LEGACY_CHECKPOINT_BUDGET_SECONDS * 1000 - LEGACY_CHECKPOINT_WORK_MS))
BREAK_ENTRY_BUDGET_CEILING_MS=$((BREAK_WINDOW_MS - MIN_BREAK_REMAINING_MS - LEGACY_ENTRY_ALLOWANCE_MS))
BREAK_ENTRY_BUDGET_MS=0
# THE ORDINARY RELEASE IS ADMITTED BY A CERTIFICATE THAT CAN EXIST (2026-09-25)
# ───────────────────────────────────────────────────────────────────────────
# Everything above budgets the LEGACY checkpoint's entry. The ordinary release
# - every release now that the engine is off the four pinned predecessors -
# had no entry budget at all, and it has exactly the same shape of deficit.
#
# `beginCountdown` in server/src/maintenance/MaintenanceBreak.ts starts the
# 300000ms clock, sets breakEndsAt, broadcasts and arms the end timer, and
# only THEN awaits the countdown row's durable save; `durableConfirmed`, which
# maintenance_certificate requires, stays false until that write commits. So
# the first instant this script can observe a certificate at all is already
# several seconds into a countdown that is already running, and the 15000ms
# the strict 285000ms admission leaves has to cover every one of them.
#
# MEASURED, on the host that pays it. Runs 36155409978, 36157652866 and
# 36157811057 logged the first certifiable read of six consecutive breaks at
# 15375, 15939, 16408, 18455, 19060 and 19846ms into the countdown - six out
# of six past the allowance. All three runs then spent their whole two-hour
# deadline refusing every break they were offered, and production drifted
# eight merges behind main again, which is how the September 18-25 outage
# started. The lag is the engine's countdown write plus this script's own
# pre-certificate poll granularity (bounded_sleep 5): 19846 + 5000 = 24846,
# rounded up to the second.
BREAK_CERTIFICATE_LAG_SECONDS=25
# What the ordinary path then pays BETWEEN that admission and the locked read
# that follows it: acquire_engine_lock, source_target_is_current, the exact-
# instance probe and the certificate read itself. The locked read demanded the
# SAME 285000ms the admission had just spent seconds getting past, so a lucky
# admission was handed a guaranteed deficit one gate later - the identical
# fault #5026 and PR #5062 answered for the legacy ladder, still live here.
# The legacy budget already measures this same entry at LEGACY_ENTRY_
# ALLOWANCE_MS (15000ms, run 35615604946) and the ordinary path does strictly
# less work in it: no durable intent write, no publisher, no cold node boot.
BREAK_LOCKED_ENTRY_SECONDS=15
# The descending ladder for a release that needs no legacy checkpoint, in the
# same shape as the legacy one above: each rung is the rollback reserve plus
# the budget that still follows it, so passing an earlier gate implies the
# last one can pass. Every deduction comes out of the CANDIDATE PROOF
# (150 -> 125 -> 110 seconds), never out of BREAK_ROLLBACK_RESERVE_SECONDS,
# and the bottom rung lands on 245000ms - the same floor the legacy ladder
# already holds and the figure run 36154480502 shipped 778075b4 on.
BREAK_ADMISSION_MIN_BREAK_MS=$((MIN_BREAK_REMAINING_MS - BREAK_CERTIFICATE_LAG_SECONDS * 1000))
BREAK_LOCKED_MIN_BREAK_MS=$((BREAK_ADMISSION_MIN_BREAK_MS - BREAK_LOCKED_ENTRY_SECONDS * 1000))

die() {
  echo "[engine-release-transaction] FATAL: $*" >&2
  exit 1
}

# The ladder is derived, so assert the derivation rather than trusting it. A
# future edit that puts the admission above what a 300000ms countdown can
# offer, or takes the locked floor below the reserve the legacy path already
# holds, refuses here - loudly, once, on this host - instead of refusing every
# break in silence for a week.
[ "$BREAK_ADMISSION_MIN_BREAK_MS" -lt "$BREAK_WINDOW_MS" ] \
  || die 'the ordinary break admission demands more countdown than the engine ever offers'
[ "$BREAK_ADMISSION_MIN_BREAK_MS" -ge "$BREAK_LOCKED_MIN_BREAK_MS" ] \
  || die 'the ordinary break ladder does not descend'
[ "$BREAK_LOCKED_MIN_BREAK_MS" -ge "$LEGACY_MIN_BREAK_REMAINING_MS" ] \
  || die 'the ordinary locked floor is below the reserve the legacy ladder already holds'
[ "$BREAK_LOCKED_MIN_BREAK_MS" -gt $((BREAK_ROLLBACK_RESERVE_SECONDS * 1000)) ] \
  || die 'the ordinary locked floor no longer holds the whole rollback reserve'

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
LEGACY_CHECKPOINT_INTENT_FILE="$REQUEST_ROOT/$RUN_ID.legacy-checkpoint-intent"
LEGACY_CHECKPOINT_ATTEMPTED=0
# THE ONE-SHOT IS DURABLE; THIS VARIABLE IS NOT. A boot-resumed or re-entered
# unit is a fresh process and starts it back at 0, so process memory alone
# cannot answer "has this run key already opened the checkpoint". On 2026-09-21
# run 35626149078 proved it: a first attempt in the 16:41 break wrote its
# O_EXCL intent, the transaction was interrupted ("transient release
# interruption recovered; durable request retained"), the same run key
# re-entered, and the helper was invoked a SECOND time. The O_EXCL guard held -
# which is why nothing was double-applied - but the second invocation should
# never have happened, and what the operator saw was a Python traceback.
# Read the durable record here, once, before any of it (CLAUDE.md 10.11: fix
# the cause, not the symptom).
if [ -e "$LEGACY_CHECKPOINT_INTENT_FILE" ] || [ -L "$LEGACY_CHECKPOINT_INTENT_FILE" ]; then
  LEGACY_CHECKPOINT_ATTEMPTED=1
fi

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

# THE RESTART CERTIFICATE ASKS WHETHER A HAND IS IN THE AIR (2026-09-21)
# ─────────────────────────────────────────────────────────────────────
# This used to be one line: readyForRestart AND unparkedTables == 0. That asks
# process memory "did every engine object report itself parked", and treats
# every other answer as "a hand may be in flight". They are different
# questions, and the difference froze the platform for two and a half days.
#
# Engine 8825af51 held one tournament hand permit that could never resolve
# inside that process. Measured in engine_maintenance_break_log: of the 71
# breaks that engine lived through, 70 ended with ready_for_restart_at NULL,
# unparked_at_countdown 1 every time - while thaw_ok stayed true and ~158
# tables resumed each break. The poker was fine. The RESTART was impossible,
# including the restart carrying the build that fixes the permit.
#
# So when the gate would refuse SOLELY because of an unresolved preparation,
# it now asks the database, which can tell a hand from a corpse independently
# of any bug in the engine holding it. Three things must all agree before a
# cutover is admitted, and the first two are unchanged:
#
#   1. the countdown window is real and durable, with the full budget left;
#   2. the engine own handsInFlightTotal is present and zero;
#   3. the database finds no incomplete hand snapshot written recently.
#
# That is STRICTLY STRONGER than the old line for a real in-flight hand - it
# adds two independent witnesses to it - and weaker only for a preparation
# that is provably not a hand. Unreadable is a refusal at every step.
#
# THE SAME RULE, FOR A STOPPED BANK THE PREDECESSOR CAN NEVER RELEASE
# (2026-09-25). Engine 778075b4 had 20 tournament managers quarantined after
# lease loss; their STOPPED tournament engines answered
# hasUnretiredStoppedTimeBankCustody() true for ever (root cause fixed in
# #5254, not in that build), and /health showed readyForRestart false,
# unparkedTables 154, unparkedReasons { f06_preparation_stuck: 13,
# stopped_bank_custody_unconfirmed: 154 } at every break. Every
# auto-deploy-hetzner run since 15:59 UTC waited on a certificate that could
# not open, including the one carrying the fix.
#
# stopped_bank_custody_unconfirmed is raised ONLY by a terminal tournament
# engine, which deals no hands. What a restart discards is the in-memory
# time-bank mirror of seats that already stopped; the chips live in the
# database. That is the class the legacy checkpoint guard already calls
# DISPOSED. MaintenanceBreak now bounds it exactly like the F06 class and
# retires it into stopped_bank_custody_stuck, which joins the allow-list
# below. The RAW reason stays refused, with one self-retiring exception: when
# the serving release is one of the exact predecessors that cannot present
# the bounded class because the bound is not in that build, the raw reason is
# admitted under the SAME database in-flight proof. The moment a bounded
# engine is serving, that exception is dead code by construction.
maintenance_certificate() {
  # The minimum break remaining is the strict MIN_BREAK_REMAINING_MS unless the
  # caller names another; the only caller that does is the read straight after
  # a legacy checkpoint, which passes LEGACY_MIN_BREAK_REMAINING_MS.
  local minimum_ms="${1:-$MIN_BREAK_REMAINING_MS}"
  local response http_code body verdict status
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
  set +e
  verdict="$(printf '%s' "$body" | MIN_BREAK_MS="$minimum_ms" python3 -c '
import json, sys
d=json.load(sys.stdin); m=d.get("maintenance")
if not isinstance(m,dict): raise SystemExit(1)
remaining=int(m.get("remainingMs") or 0)
window=(d.get("running") is True and m.get("active") is True and m.get("phase")=="counting_down" and m.get("durableConfirmed") is True)
if not window: raise SystemExit(1)
# A straggler can prevent restart certification for the entire real window.
# Record that missed opportunity separately from permission to cut over. Only
# this durable health observation qualifies; missing/unreadable health does not.
if remaining<int(__import__("os").environ["MIN_BREAK_MS"]):
    print(remaining)
    raise SystemExit(2)
ok=(m.get("readyForRestart") is True and m.get("unparkedTables")==0)
if ok:
    print(remaining)
    raise SystemExit(0)
# ── Refusing. Is this "a hand is in the air", or "a preparation that can never
# resolve in this process"? Those are different facts and only the first is a
# reason not to restart. See the block comment above this function.
#
# The window, durability and time-remaining predicates above have all already
# passed against whichever rung of the ladder the caller named - 285000ms for
# the legacy admission, 260000ms for the ordinary one, 245000ms for both
# locked reads - where the engine itself demands 180000ms, so at this point the
# ONLY thing keeping readyForRestart shut is the
# unparked count. Nothing else is being relaxed.
#
# The BOUNDED classes: each is a blocker the engine itself has already aged
# past MaintenanceBreak.F06_UNRESOLVED_GATE_MS (or is the live half of one
# that the engine will age), raised only by a table that deals no hands.
BOUNDED_ONLY={"f06_preparation_unresolved","f06_preparation_stuck","stopped_bank_custody_stuck"}
# The one reason admitted UNBOUNDED, and only from these exact serving
# releases: predecessors whose MaintenanceBreak counts
# stopped_bank_custody_unconfirmed with no bound and can therefore never
# present stopped_bank_custody_stuck, however long the custody has been held.
# An allow-list of full SHAs, like the checkpoint predecessor profiles in
# legacy-engine-checkpoint.mjs. Any other serving release keeps refusing the
# raw reason, so this exception retires itself with the first bounded engine.
STOPPED_BANK_UNBOUNDED_PREDECESSORS={"778075b419d078c58565c284c0ca7c5225bb773a"}
RAW_STOPPED_BANK="stopped_bank_custody_unconfirmed"
serving=d.get("releaseSha")
predecessor=isinstance(serving,str) and serving in STOPPED_BANK_UNBOUNDED_PREDECESSORS
unparked=m.get("unparkedTables")
if not isinstance(unparked,int) or isinstance(unparked,bool) or unparked<1: raise SystemExit(1)
reasons=m.get("unparkedReasons")
if not isinstance(reasons,dict) or not reasons: raise SystemExit(1)
# An ALLOW-list, never a deny-list: a reason string this script does not
# recognise refuses. cards_in_air, the bank-durability classes (unwritten,
# unreadable, bank_park_write_incomplete) and anything a future engine invents
# are all outside the set and all keep the gate shut.
for k,v in reasons.items():
    if not isinstance(k,str): raise SystemExit(1)
    if k not in BOUNDED_ONLY and not (k==RAW_STOPPED_BANK and predecessor): raise SystemExit(1)
    if not isinstance(v,int) or isinstance(v,bool) or v<0: raise SystemExit(1)
# The engine own physical witness, which must be PRESENT and zero. Absent is
# unreadable, and unreadable is a refusal, never an assumed zero.
hands=d.get("handsInFlightTotal")
if not isinstance(hands,int) or isinstance(hands,bool) or hands!=0: raise SystemExit(1)
if RAW_STOPPED_BANK in reasons:
    sys.stderr.write("[engine-release-transaction] restart certificate is held shut by stopped-bank custody the predecessor " + serving[:8] + " can never release; the bound that retires it is not in that release; consulting the database for hands actually in the air\n")
sys.stderr.write("[engine-release-transaction] restart certificate is held shut only by " + repr(reasons) + "; consulting the database for hands actually in the air\n")
print(remaining)
raise SystemExit(4)
')"
  status=$?
  set -e
  case "$status" in
    0) printf '%s\n' "$verdict"; return 0 ;;
    2) printf '%s\n' "$verdict"; return 2 ;;
    4) ;;
    *) return 1 ;;
  esac
  # Fail closed. Exit 0 is the ONLY result that proceeds. The helper answers 1
  # for a hand in the air and 3 for "could not tell", and both refuse here.
  # There is deliberately no flag, variable or argument that skips this.
  #
  # EVERY refusal is named separately, because on 2026-09-21 they were not.
  # The helper was absent from the installed control generation, the shell
  # answered 127, and `if ...; then` reported that as the same thing as "the
  # felt is not quiet" - so five consecutive releases said the database had
  # refused when the database had never been asked. A missing helper is
  # UNKNOWN, and UNKNOWN has to say so in its own words (CLAUDE.md 10.86
  # rules 1 and 2). All four branches still refuse; only the message differs.
  # STDOUT IS THE REMAINING MILLISECONDS AND NOTHING ELSE (2026-09-26).
  # Every caller captures this function as `$(maintenance_certificate ...)`
  # and does arithmetic on it. The helper prints its verdict on stdout and the
  # admission sentence used to go there too, so the one path that admits past
  # a shut certificate handed the caller "[engine-release-inflight-hands] no
  # hand in the air ...\n294308" and bash refused the arithmetic. Runs
  # 36211686180 and 36212511823 each had 294308 and 295850 ms of break and a
  # quiet database, and died on `syntax error: operand expected` - the only
  # two times this branch has ever reached production. Narration goes to
  # stderr, where every refusal branch below already sends it.
  set +e
  "$INFLIGHT_HANDS" --env-file "$ENV_FILE" >&2
  local inflight_rc=$?
  set -e
  case "$inflight_rc" in
    0)
      echo "[engine-release-transaction] the database confirms no hand is in the air; admitting the cutover past the unresolved preparation named above" >&2
      printf '%s\n' "$verdict"
      return 0
      ;;
    1)
      echo "[engine-release-transaction] the database says a hand IS in the air; the cutover stays refused" >&2
      ;;
    3)
      echo "[engine-release-transaction] the database could not tell whether the felt is quiet; the cutover stays refused" >&2
      ;;
    126|127)
      echo "[engine-release-transaction] UNKNOWN: $INFLIGHT_HANDS is missing from this control generation or is not executable (status $inflight_rc). The database was NEVER ASKED. This is a packaging fault in install-engine-supervisor.sh REQUIRED_FILES, not a verdict about the felt; the cutover stays refused." >&2
      ;;
    *)
      echo "[engine-release-transaction] UNKNOWN: the in-flight-hands helper exited $inflight_rc, which is not one of its three defined answers; the cutover stays refused" >&2
      ;;
  esac
  return 1
}

# Entry to the exact predecessor's checkpoint, NOT restart authority. Its old
# unparked count combines physical hands with missing bank durability, and its
# saved-bank bit can remain true after the final announced write erased a row.
# The helper independently checks every physical table before writing. Only
# the unchanged maintenance_certificate below can admit a replacement.
legacy_checkpoint_countdown() {
  local response http_code body headroom
  # Required headroom for the entry work that still has to happen AFTER this
  # admission and BEFORE the guard reads the same reserve. Defaulting to 0
  # keeps the historical contract for callers that have nothing left to do.
  headroom="${1:-0}"
  response="$(curl -sS --max-time 2 --write-out $'\n%{http_code}' \
    http://127.0.0.1:8080/health 2>/dev/null)" || return 1
  http_code="${response##*$'\n'}"
  body="${response%$'\n'*}"
  case "$http_code" in 200|503) ;; *) return 1 ;; esac
  printf '%s' "$body" | MIN_BREAK_MS=$((MIN_BREAK_REMAINING_MS + headroom)) python3 -c '
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
# This is a compatibility operation for three pinned immutable predecessors, not a
# general checkpoint API. The helper rebinds the seal/image/process under the
# engine lock immediately before its one durable intent and checkpoint.
CHECKPOINT_PREDECESSOR_SHA="$(timeout --signal=TERM --kill-after=1s 10s \
  "$RELEASE_SEAL" get desired-sha)" || die 'sealed checkpoint predecessor is unreadable'
LEGACY_CHECKPOINT_REQUIRED=0
if [ "$CHECKPOINT_PREDECESSOR_SHA" = "$LEGACY_CHECKPOINT_SHA" ] \
  || [ "$CHECKPOINT_PREDECESSOR_SHA" = "$CHECKPOINT_758_SHA" ] \
  || [ "$CHECKPOINT_PREDECESSOR_SHA" = "$CHECKPOINT_A0_SHA" ] \
  || [ "$CHECKPOINT_PREDECESSOR_SHA" = "$CHECKPOINT_8825_SHA" ]; then
  LEGACY_CHECKPOINT_REQUIRED=1
fi
if [ "$LEGACY_CHECKPOINT_REQUIRED" = 1 ] && [ "$LEGACY_CHECKPOINT_ATTEMPTED" = 1 ]; then
  # Refused HERE, before a break is entered and before any lock, rather than
  # by the helper crashing on its own O_EXCL write several minutes later.
  #
  # An interrupted transaction resumes correctly for everything else it owns -
  # the sealed desired runtime, a committed-run replay, a pending owner - and
  # those paths all run above this line, so a run that really did finish still
  # reports its receipt. What cannot resume is this: the checkpoint is a
  # one-shot over a live predecessor holding seated stacks, nothing durable
  # records whether an interrupted entry completed it, and "I could not tell"
  # is a refusal, never permission (CLAUDE.md 10.86 rule 1). The intent stands;
  # it is NOT retired here. A later break cannot make it safe either, so this
  # does not wait - it ends, and the next dispatch gets a new run key.
  die 'this run key already opened the one-shot legacy checkpoint and its durable intent is still on disk; whether that entry acted is UNKNOWN, so it may not be entered again - dispatch a new run key'
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
  # The legacy ladder is derived from the strict figure and keeps it. The
  # ordinary one is admitted by the first certificate the engine can actually
  # present, which is never at t=0: see BREAK_CERTIFICATE_LAG_SECONDS.
  if [ "$LEGACY_CHECKPOINT_REQUIRED" = 1 ]; then
    ADMISSION_MIN_BREAK_MS="$MIN_BREAK_REMAINING_MS"
  else
    ADMISSION_MIN_BREAK_MS="$BREAK_ADMISSION_MIN_BREAK_MS"
  fi
  set +e
  BREAK_REMAINING_MS="$(maintenance_certificate "$ADMISSION_MIN_BREAK_MS")"
  CERTIFICATE_RC=$?
  set -e
  if [ "$LEGACY_CHECKPOINT_REQUIRED" = 1 ]; then
    # Counting down follows the final announcement. Run even when the old
    # certificate says ready: that predecessor can retain a stale saved bit.
    if ! LEGACY_COUNTDOWN_END="$(legacy_checkpoint_countdown "$BREAK_ENTRY_BUDGET_MS")"; then
      # These exact successors already implement the original bounded recovery
      # event. Retain that opportunity; the helper still needs its real durable
      # countdown, and an unknown request can never create another announcement.
      if [ "$CHECKPOINT_PREDECESSOR_SHA" = "$CHECKPOINT_758_SHA" ] \
        || [ "$CHECKPOINT_PREDECESSOR_SHA" = "$CHECKPOINT_A0_SHA" ] \
        || [ "$CHECKPOINT_PREDECESSOR_SHA" = "$CHECKPOINT_8825_SHA" ]; then
        if [ "$CERTIFICATE_RC" -eq 2 ]; then RECOVERY_ADMISSION_MISSED=1; fi
        request_recovery_window
      fi
      bounded_sleep 5
      continue
    fi
  elif [ "$CERTIFICATE_RC" -eq 2 ]; then
    RECOVERY_ADMISSION_MISSED=1
    # A predecessor or image build can consume the beginning of this break.
    # No prepare or break deadline exists yet. Keep the original request's
    # absolute deadline and source-freshness checks while waiting for a later
    # complete certificate; never reduce the candidate-and-recovery reserve.
    echo "[engine-release-transaction] the durable table break has ${BREAK_REMAINING_MS:-0}ms remaining, below the ${ADMISSION_MIN_BREAK_MS}ms candidate-and-recovery budget; refusing before mutation and waiting for a later certificate"
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
    if [ "$CHECKPOINT_PREDECESSOR_SHA" != "$LEGACY_CHECKPOINT_SHA" ] \
      && [ "$CHECKPOINT_PREDECESSOR_SHA" != "$CHECKPOINT_758_SHA" ] \
      && [ "$CHECKPOINT_PREDECESSOR_SHA" != "$CHECKPOINT_A0_SHA" ] \
      && [ "$CHECKPOINT_PREDECESSOR_SHA" != "$CHECKPOINT_8825_SHA" ]; then
      # A different release may have advanced desired while this run waited.
      # Source/high-water admission above still owns whether our target may
      # follow it. Never apply the old-image compatibility path to its successor.
      LEGACY_CHECKPOINT_REQUIRED=0
    fi
  fi
  if [ "$LEGACY_CHECKPOINT_REQUIRED" = 1 ]; then
    if ! LEGACY_COUNTDOWN_END="$(legacy_checkpoint_countdown "$BREAK_ENTRY_BUDGET_MS")"; then
      release_engine_lock
      bounded_sleep 5
      continue
    fi
    [ "$LEGACY_CHECKPOINT_ATTEMPTED" = 0 ] \
      || die 'legacy checkpoint was already attempted; refusing a retry'
    # This provisional deadline bounds predecessor proof only. It is not
    # persisted as a cutover certificate. The checkpoint and its cleanup
    # consume up to LEGACY_CHECKPOINT_BUDGET_SECONDS of the candidate-proof
    # budget; the certificate read after them demands LEGACY_MIN_BREAK_REMAINING_MS.
    BREAK_END_EPOCH="$LEGACY_COUNTDOWN_END"
    ENTRY_STARTED_MS="$(date +%s%3N)"
    prove_rollback_readiness
    # Measure the real cost of this host's rollback proof, the dominant entry
    # term, and log it against the entry allowance inside the legacy budget.
    # The admission headroom it feeds forward is doubled for margin and then
    # clamped to BREAK_ENTRY_BUDGET_CEILING_MS, which is 0 while the budget
    # already contains the entry: a threshold above 285000 can never be met
    # by a 300000ms countdown that has paid ~15000ms of entry, so demanding
    # it would defer every break for ever instead of refusing this one.
    ROLLBACK_PROOF_MS=$(( $(date +%s%3N) - ENTRY_STARTED_MS ))
    echo "[engine-release-transaction] prove_rollback_readiness took ${ROLLBACK_PROOF_MS}ms of the ${LEGACY_ENTRY_ALLOWANCE_MS}ms entry allowance inside the ${LEGACY_CHECKPOINT_BUDGET_SECONDS}s legacy checkpoint budget"
    BREAK_ENTRY_BUDGET_MS=$(( ROLLBACK_PROOF_MS * 2 ))
    [ "$BREAK_ENTRY_BUDGET_MS" -ge 0 ] || BREAK_ENTRY_BUDGET_MS=0
    [ "$BREAK_ENTRY_BUDGET_MS" -le "$BREAK_ENTRY_BUDGET_CEILING_MS" ] \
      || BREAK_ENTRY_BUDGET_MS="$BREAK_ENTRY_BUDGET_CEILING_MS"
    LEGACY_CHECKPOINT_ATTEMPTED=1
    set +e
    "$LEGACY_CHECKPOINT" "$RUN_ID"
    LEGACY_CHECKPOINT_RC=$?
    set -e
    if [ "$LEGACY_CHECKPOINT_RC" = 75 ]; then
      # The helper refused ABOVE its durable one-shot intent: this attempt
      # arrived too late in the break, and nothing was attempted. That is a
      # different fact from "the checkpoint is unsafe", and until 2026-09-21
      # both ended the release for good - so a run that merely mistimed its
      # arrival burned the whole window, roughly fifteen times in one day.
      # Prove the non-action from the filesystem rather than trusting the exit
      # code: an intent file here would mean the operation really did start,
      # and then a retry stays forbidden however the helper exited. Anything
      # other than a clean, absent intent is a die, so this fails closed.
      [ ! -e "$REQUEST_ROOT/$RUN_ID.legacy-checkpoint-intent" ] \
        || die 'legacy checkpoint deferred but its durable intent exists; refusing a retry'
      LEGACY_CHECKPOINT_ATTEMPTED=0
      BREAK_END_EPOCH=0
      release_engine_lock
      RECOVERY_ADMISSION_MISSED=1
      echo "[engine-release-transaction] the legacy checkpoint entry did not fit inside this break and nothing was attempted; waiting for a later certificate"
      bounded_sleep 15
      continue
    fi
    if [ "$LEGACY_CHECKPOINT_RC" = 70 ]; then
      # The helper's own name for "this run key already opened the one-shot".
      # Reachable only if the durable intent appeared between the check above
      # and this call, which is another process using our run key: still a
      # refusal, and still named rather than a traceback.
      die 'the legacy checkpoint refused as already entered under this run key; its durable intent exists and nothing was re-attempted - dispatch a new run key'
    fi
    [ "$LEGACY_CHECKPOINT_RC" = 0 ] \
      || die 'legacy checkpoint or cleanup refused; release cannot continue'
    BREAK_END_EPOCH=0
  fi
  set +e
  if [ "$LEGACY_CHECKPOINT_ATTEMPTED" = 1 ]; then
    # Only a legacy checkpoint that actually ran is read against the smaller
    # post-checkpoint minimum; every other locked read keeps the strict one.
    CERTIFICATE_MIN_BREAK_MS="$LEGACY_MIN_BREAK_REMAINING_MS"
    BREAK_REMAINING_MS="$(maintenance_certificate "$LEGACY_MIN_BREAK_REMAINING_MS")"
  else
    # The entry between the admission above and this read is budgeted, so this
    # rung sits BREAK_LOCKED_ENTRY_SECONDS below it. Demanding the admission's
    # own figure again is the deficit one gate later, every time.
    CERTIFICATE_MIN_BREAK_MS="$BREAK_LOCKED_MIN_BREAK_MS"
    BREAK_REMAINING_MS="$(maintenance_certificate "$BREAK_LOCKED_MIN_BREAK_MS")"
  fi
  CERTIFICATE_RC=$?
  set -e
  if [ "$LEGACY_CHECKPOINT_ATTEMPTED" = 1 ] && [ "$CERTIFICATE_RC" -ne 0 ]; then
    die "legacy checkpoint did not retain the full restart certificate and ${LEGACY_MIN_BREAK_REMAINING_MS}ms legacy reserve (${BREAK_REMAINING_MS:-0}ms remaining, certificate rc $CERTIFICATE_RC)"
  fi
  if [ "$CERTIFICATE_RC" -eq 2 ]; then
    RECOVERY_ADMISSION_MISSED=1
    release_engine_lock
    echo "[engine-release-transaction] the locked table break has ${BREAK_REMAINING_MS:-0}ms remaining, below the ${CERTIFICATE_MIN_BREAK_MS}ms candidate-and-recovery budget; waiting for a later certificate"
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
  --container-id "$CANDIDATE_CID" --started-at "$CANDIDATE_STARTED_AT" \
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
