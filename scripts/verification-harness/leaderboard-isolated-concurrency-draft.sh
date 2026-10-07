#!/usr/bin/env bash
# UNQUALIFIED DRAFT. Builds its own exact committed synthetic fixture using the
# guarded authorization draft and explicit companion; payout draft untouched.
# The owning one-shot harness must destroy the whole container
# on success/failure, rather than delete immutable programs or payment receipts.
# EXPECTED POSSIBLE BASELINE FAILURE: current payout reads the existing batch
# before taking the funding-row lock; concurrent admission can unique-violate
# in one caller. Safe no-double-payment alone is not successful replay behavior.
set -euo pipefail
[[ $# == 2 ]] || { echo 'Required: owned isolated container and private scratch directory' >&2; exit 1; }
readonly container="$1" scratch="$2" bootstrap='leaderboard_qualification_bootstrap'
[[ "$container" =~ ^leaderboard-isolation-[A-Za-z0-9_-]+$ && -d "$scratch" ]] || exit 1
[[ -z "${DATABASE_URL:-}" && -z "${PGDATABASE:-}" ]] || { echo 'Source connection environment must be removed' >&2; exit 1; }
umask 077
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly here
readonly auth="$here/leaderboard-isolated-authorization-draft.sql"
readonly fixture="$here/leaderboard-isolated-concurrency-fixture-draft.sql"
[[ "$(docker inspect --format '{{.Config.Image}}' "$container")" == 'supabase/postgres:17.6.1.063' ]] || exit 1
[[ "$(docker network inspect --format '{{.Internal}}' "$container-network")" == true ]] || exit 1
readonly -a client=(docker exec -i "$container" psql -h /tmp -XAtq -U "$bootstrap" -d postgres -v ON_ERROR_STOP=1)
sql() { timeout 75 "${client[@]}"; }
declare -A owned_start=()
diagnostic_stage='fixture'
process_start() {
  # Linux /proc start ticks survive exec, and distinguish reused PID/group IDs.
  [[ -r "/proc/$1/stat" ]] || return 1
  awk '{sub(/^[^)]*\) /, ""); print $20}' "/proc/$1/stat"
}
register_child() {
  local token
  token="$(process_start "$1")" || return 1
  [[ "$token" =~ ^[0-9]+$ ]] || return 1
  owned_start["$1"]="$token"
}
await_child() {
  local pid="$1" status=0
  wait "$pid" || status=$?
  # Do not retain reaped PID/group identifiers and later signal a reuse.
  unset 'owned_start[$pid]'
  if kill -0 -- "-$pid" 2>/dev/null; then
    echo 'Draft client group remains after its owned leader terminated' >&2
    [[ "$status" != 0 ]] || status=1
  fi
  return "$status"
}
cleanup_children() {
  local original=$? failed=false pid actual pgid status
  trap - EXIT
  { exec 9>&-; } 2>/dev/null
  for pid in "${!owned_start[@]}"; do
    actual="$(process_start "$pid")" || actual=''
    if [[ "$actual" == "${owned_start[$pid]}" ]]; then
      pgid="$(ps -o pgid= -p "$pid" | tr -d ' ')" || pgid=''
      # Group-wide signaling requires its original live leader and exact PGID.
      # A not-yet-setsid child is signaled by its verified PID, never our group.
      if [[ "$pgid" == "$pid" ]]; then
        kill -KILL -- "-$pid" 2>/dev/null || failed=true
      else
        kill -KILL "$pid" 2>/dev/null || failed=true
      fi
    elif [[ -n "$actual" ]]; then
      failed=true # Reused identity: never signal it.
    elif kill -0 -- "-$pid" 2>/dev/null; then
      failed=true # No live original leader proves ownership of this group.
    fi
    # Reap only the child Bash actually owns. A signal exit is expected here.
    status=0
    wait "$pid" || status=$?
    if [[ "$status" == 127 ]]; then failed=true; fi
    unset 'owned_start[$pid]'
    if kill -0 -- "-$pid" 2>/dev/null; then failed=true; fi
  done
  if [[ "$failed" == true ]]; then
    diagnostic_stage='own_cleanup'
    echo 'Owned draft client cleanup failed; owning container cleanup required' >&2
    [[ "$original" != 0 ]] || original=1
  fi
  if [[ "$original" != 0 ]]; then printf 'FINANCIAL_DRIVER|f||%s\n' "$diagnostic_stage"; fi
  exit "$original"
}
trap cleanup_children EXIT
# PostgreSQL dollar quoting is deliberately literal.
# shellcheck disable=SC2016
guard='DO $guard$ BEGIN IF session_user <> '\''leaderboard_qualification_bootstrap'\'' OR current_user <> '\''leaderboard_qualification_bootstrap'\'' OR current_database() <> '\''postgres'\'' OR inet_server_addr() IS NOT NULL THEN RAISE EXCEPTION '\''Isolated bootstrap socket required'\''; END IF; END $guard$;'
printf '%s\n' "$guard" | sql >"$scratch/concurrency-guard.log" 2>&1
[[ "$(tail -n 1 "$auth")" == 'ROLLBACK;' && "$(grep -c '^ROLLBACK;$' "$auth")" == 1 ]] || exit 1
! grep -q '^COMMIT;' "$auth" || exit 1
test -s "$fixture"
# Replace ONLY the verified single final ROLLBACK in this isolated input stream.
# ON_ERROR_STOP ensures a failing real authorization matrix never reaches COMMIT.
sed '$d' "$auth" >"$scratch/concurrency-authorization.sql"
cat "$scratch/concurrency-authorization.sql" "$fixture" >"$scratch/concurrency-complete.sql"
chmod 600 "$scratch/concurrency-authorization.sql" "$scratch/concurrency-complete.sql"
sql <"$scratch/concurrency-complete.sql" >"$scratch/concurrency-create.log" 2>&1
# Refuse absent/rollback-only/wrong fixtures before invoking any financial RPC.
sql >"$scratch/concurrency-fixture.log" 2>&1 <<'SQL'
DO $fixture$
DECLARE starts date; ends date; plan jsonb;
BEGIN
  SELECT start_date,end_date INTO starts,ends FROM public.fn_leaderboard_period_window('weekly',-1);
  plan := public.fn_get_leaderboard_reward_plan('92000000-0000-4000-8000-000000000002','weekly',starts);
  IF (SELECT count(*) FROM auth.users) <> 5
     OR EXISTS(SELECT 1 FROM auth.users WHERE id::text NOT LIKE '90000000-0000-4000-8000-%')
     OR (SELECT count(*) FROM public.clubs) <> 3
     OR EXISTS(SELECT 1 FROM public.leaderboard_payout_batches)
     OR EXISTS(SELECT 1 FROM public.leaderboard_payouts)
     OR (SELECT promo_balance FROM public.clubs WHERE id='92000000-0000-4000-8000-000000000002') IS DISTINCT FROM 20
     OR (SELECT chip_treasury FROM public.clubs WHERE id='92000000-0000-4000-8000-000000000002') IS DISTINCT FROM 99980
     OR COALESCE((plan->>'rewards_enabled')::boolean,false) <> true
     OR plan->'prizes' IS DISTINCT FROM '[{"rank":1,"amount":10}]'::jsonb
     OR (SELECT count(*) FROM public.player_stats_snapshots WHERE club_id='92000000-0000-4000-8000-000000000002' AND snapshot_date IN(starts,ends)) <> 4
     OR (SELECT count(*) FROM public.player_stats_snapshots) <> 6
     OR EXISTS(SELECT 1 FROM public.club_opening_setups WHERE leaderboard_seed_remaining<>0)
     OR EXISTS(SELECT 1 FROM public.club_members WHERE chip_balance<>0) THEN
    RAISE EXCEPTION 'Exact committed synthetic concurrency fixture unavailable';
  END IF;
END;
$fixture$;
SQL

# Hold the real standalone funding row. The pinned installed function reads
diagnostic_stage='funding_barrier'
# existing batches before this lock; both blocked calls therefore crossed that
# read. A changed function must be reviewed before this source-specific proof.
sql <<'SQL'
DO $source$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_payout_leaderboard(uuid,text,text,timestamp with time zone,timestamp with time zone)'::regprocedure)
       IS DISTINCT FROM '2ba8db49240eac826b2f3efe0e262648' THEN
    RAISE EXCEPTION 'Concurrency funding barrier requires reviewed payout source';
  END IF;
END;
$source$;
SQL
mkfifo "$scratch/concurrency-holder.fifo"
setsid timeout 75 "${client[@]}" <"$scratch/concurrency-holder.fifo" >"$scratch/concurrency-holder.log" 2>&1 &
holder_pid=$!
register_child "$holder_pid"
exec 9>"$scratch/concurrency-holder.fifo"
printf '%s\nBEGIN; SET LOCAL application_name='\''lb-funding-holder'\''; SELECT id FROM public.clubs WHERE id='\''92000000-0000-4000-8000-000000000002'\'' FOR UPDATE;\n' "$guard" >&9
request() {
  printf '%s\nBEGIN; SET LOCAL application_name = '\''lb-concurrency-%s'\'';\n' "$guard" "$1"
  cat <<'SQL'
SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='30s';
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT set_config('request.jwt.claim.sub','',true);
SELECT set_config('request.jwt.claim.role','service_role',true);
SET LOCAL ROLE service_role;
DO $result$
DECLARE response jsonb; expected uuid;
BEGIN
  SELECT public.fn_payout_leaderboard('92000000-0000-4000-8000-000000000002','weekly','profit',
    start_date::timestamp AT TIME ZONE 'UTC',end_date::timestamp AT TIME ZONE 'UTC')
  INTO response FROM public.fn_leaderboard_period_window('weekly',-1);
  IF (response->>'success')::boolean IS DISTINCT FROM true
     OR jsonb_typeof(response->'already_settled') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'Real concurrent payout did not return successful settlement: %',response;
  END IF;
  SELECT id INTO STRICT expected FROM public.leaderboard_payout_batches;
  IF response->>'batch_id' IS DISTINCT FROM expected::text THEN
    RAISE EXCEPTION 'Concurrent response did not identify the durable shared batch';
  END IF;
  RAISE NOTICE 'CONCURRENT_RESULT %',response;
END;
$result$;
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;
SQL
}
# Prove holder lock acquired before contenders are launched.
ready=false
for _attempt in {1..100}; do
  count="$(printf "SELECT count(*) FROM pg_stat_activity a WHERE application_name='lb-funding-holder' AND state='idle in transaction' AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND l.relation='public.clubs'::regclass AND l.granted AND l.mode='RowShareLock');\n" | sql)"
  if [[ "$count" == 1 ]]; then ready=true; break; fi
  sleep 0.1
done
[[ "$ready" == true ]] || exit 1
diagnostic_stage='concurrent_callers'
request A | setsid timeout 75 "${client[@]}" >"$scratch/concurrency-A.log" 2>&1 & a_pid=$!
register_child "$a_pid"
request B | setsid timeout 75 "${client[@]}" >"$scratch/concurrency-B.log" 2>&1 & b_pid=$!
register_child "$b_pid"
ready=false
for _attempt in {1..100}; do
  count="$(printf "WITH RECURSIVE blocked AS (SELECT pid FROM pg_stat_activity WHERE application_name='lb-funding-holder' UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.application_name IN ('lb-concurrency-A','lb-concurrency-B')) SELECT count(DISTINCT a.pid) FROM blocked b JOIN pg_stat_activity a USING(pid) WHERE a.application_name IN ('lb-concurrency-A','lb-concurrency-B') AND a.wait_event_type='Lock' AND a.wait_event IN ('transactionid','tuple');\n" | sql)"
  if [[ "$count" == 2 ]]; then ready=true; break; fi
  sleep 0.1
done
[[ "$ready" == true ]] || exit 1
printf 'COMMIT;\n\\q\n' >&9
exec 9>&-
await_child "$holder_pid"
await_child "$a_pid"
await_child "$b_pid"
# Require both actual responses: one new settlement and one replay, sharing
# the same durable batch. A unique violation or JSON failure never passes.
sed -n 's/^.*CONCURRENT_RESULT //p' "$scratch/concurrency-A.log" "$scratch/concurrency-B.log" |
  jq -es 'length == 2 and all(.[]; .success == true and (.batch_id | type) == "string") and (map(.batch_id) | unique | length) == 1 and (map(.already_settled) | sort) == [false,true]' >"$scratch/concurrency-responses.log"
# A separate bootstrap connection independently validates the committed result.
diagnostic_stage='reconciliation'
sql >"$scratch/concurrency-reconcile.log" 2>&1 <<'SQL'
DO $reconcile$
BEGIN
  IF (SELECT count(*) FROM public.leaderboard_payout_batches) <> 1
     OR (SELECT sum(total_paid) FROM public.leaderboard_payout_batches) IS DISTINCT FROM 10
     OR (SELECT sum(seed_funded+overlay_funded) FROM public.leaderboard_payout_batches) IS DISTINCT FROM 0
     OR (SELECT sum(promo_funded) FROM public.leaderboard_payout_batches) IS DISTINCT FROM 10
     OR (SELECT count(*) FROM public.leaderboard_payouts) <> 1
     OR (SELECT sum(payout_amount) FROM public.leaderboard_payouts) IS DISTINCT FROM 10
     OR (SELECT sum(chip_balance) FROM public.club_members) IS DISTINCT FROM 10
     OR (SELECT sum(amount) FROM public.chip_ledger WHERE category='leaderboard_payout' AND to_type='leaderboard_round') IS DISTINCT FROM 10
     OR (SELECT sum(amount) FROM public.chip_ledger WHERE category='leaderboard_payout' AND from_type='leaderboard_round') IS DISTINCT FROM 10
     OR (SELECT count(*) FROM public.wallet_credit_idempotency WHERE key LIKE 'leaderboard:%') <> 1
     OR (SELECT promo_balance FROM public.clubs WHERE id='92000000-0000-4000-8000-000000000002') IS DISTINCT FROM 10
     OR (SELECT chip_treasury FROM public.clubs WHERE id='92000000-0000-4000-8000-000000000002') IS DISTINCT FROM 99980 THEN
    RAISE EXCEPTION 'Concurrent payout independent reconciliation failed';
  END IF;
END;
$reconcile$;
SQL
# This is acknowledged committed-result replay, not unknown-ack recovery.
diagnostic_stage='replay'
sql >"$scratch/concurrency-replay.log" 2>&1 <<'SQL'
DO $replay$
DECLARE before_state text; after_state text; response jsonb; expected uuid;
BEGIN
  SELECT id INTO STRICT expected FROM public.leaderboard_payout_batches;
  SELECT md5(jsonb_build_object(
    'clubs',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.clubs t),
    'members',(SELECT jsonb_agg(to_jsonb(t) ORDER BY club_id,user_id) FROM public.club_members t),
    'batches',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.leaderboard_payout_batches t),
    'receipts',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.leaderboard_payouts t),
    'ledger',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.chip_ledger t),
    'keys',(SELECT jsonb_agg(to_jsonb(t) ORDER BY key) FROM public.wallet_credit_idempotency t),
    'history',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.wallet_transactions t)
  )::text) INTO before_state;
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  PERFORM set_config('request.jwt.claim.sub','',true);
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  SET LOCAL ROLE service_role;
  SELECT public.fn_payout_leaderboard('92000000-0000-4000-8000-000000000002','weekly','profit',
    start_date::timestamp AT TIME ZONE 'UTC',end_date::timestamp AT TIME ZONE 'UTC')
  INTO response FROM public.fn_leaderboard_period_window('weekly',-1);
  RESET ROLE;
  SELECT md5(jsonb_build_object(
    'clubs',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.clubs t),
    'members',(SELECT jsonb_agg(to_jsonb(t) ORDER BY club_id,user_id) FROM public.club_members t),
    'batches',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.leaderboard_payout_batches t),
    'receipts',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.leaderboard_payouts t),
    'ledger',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.chip_ledger t),
    'keys',(SELECT jsonb_agg(to_jsonb(t) ORDER BY key) FROM public.wallet_credit_idempotency t),
    'history',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.wallet_transactions t)
  )::text) INTO after_state;
  IF before_state IS DISTINCT FROM after_state
     OR response->>'batch_id' IS DISTINCT FROM expected::text
     OR (response->>'already_settled')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Acknowledged committed-result replay changed state';
  END IF;
END;
$replay$;
SQL

# A separate holder owns the ACTUAL worker transaction lock, not a mock lock.
diagnostic_stage='worker_exclusion'
setsid timeout 75 "${client[@]}" <"$scratch/concurrency-holder.fifo" >"$scratch/concurrency-worker-holder.log" 2>&1 &
holder_pid=$!
register_child "$holder_pid"
exec 9>"$scratch/concurrency-holder.fifo"
printf '%s\nBEGIN; SET LOCAL application_name='\''lb-worker-lock-holder'\''; SELECT pg_advisory_xact_lock(hashtext('\''settle-due-leaderboards'\''));\n' "$guard" >&9
ready=false
for _attempt in {1..100}; do
  count="$(printf "SELECT count(*) FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE a.application_name='lb-worker-lock-holder' AND l.locktype='advisory' AND l.granted;\n" | sql)"
  if [[ "$count" == 1 ]]; then ready=true; break; fi
  sleep 0.1
done
[[ "$ready" == true ]] || exit 1
sql >"$scratch/concurrency-worker-lock.log" 2>&1 <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT set_config('request.jwt.claim.sub','',true);
SELECT set_config('request.jwt.claim.role','service_role',true);
SET LOCAL ROLE service_role;
DO $worker$
DECLARE response jsonb;
BEGIN
  response:=public.fn_settle_due_leaderboards();
  IF (response->>'success')::boolean IS DISTINCT FROM true
     OR response->>'skipped' IS DISTINCT FROM 'Already Running' THEN
    RAISE EXCEPTION 'Worker actual advisory-lock exclusion failed';
  END IF;
END;
$worker$;
ROLLBACK;
SQL
printf 'ROLLBACK;\n\\q\n' >&9
exec 9>&-
await_child "$holder_pid"
# With the actual worker lock released, settle the remaining earlier round.
diagnostic_stage='worker_settlement'
sql >"$scratch/concurrency-worker-settlement.log" 2>&1 <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT set_config('request.jwt.claim.sub','',true);
SELECT set_config('request.jwt.claim.role','service_role',true);
SET LOCAL ROLE service_role;
DO $worker$
DECLARE response jsonb;
BEGIN
  response:=public.fn_settle_due_leaderboards();
  IF (response->>'success')::boolean IS DISTINCT FROM true
     OR (response->>'settled')::integer IS DISTINCT FROM 1
     OR (response->>'failed')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'Worker did not settle exactly the remaining earlier round';
  END IF;
END;
$worker$;
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;
SQL
diagnostic_stage='worker_reconciliation'
sql >"$scratch/concurrency-worker-reconcile.log" 2>&1 <<'SQL'
DO $audit$
DECLARE starts date;
BEGIN
  SELECT start_date INTO starts FROM public.fn_leaderboard_period_window('weekly',-1);
  IF (SELECT count(*) FROM public.leaderboard_payout_batches)<>2
     OR (SELECT count(*) FROM public.leaderboard_payout_batches WHERE period='weekly' AND period_start IN(starts-7,starts))<>2
     OR (SELECT sum(total_paid) FROM public.leaderboard_payout_batches) IS DISTINCT FROM 20
     OR (SELECT sum(seed_funded+overlay_funded) FROM public.leaderboard_payout_batches) IS DISTINCT FROM 0
     OR (SELECT sum(promo_funded) FROM public.leaderboard_payout_batches) IS DISTINCT FROM 20
     OR (SELECT count(*) FROM public.leaderboard_payouts)<>2
     OR (SELECT sum(payout_amount) FROM public.leaderboard_payouts) IS DISTINCT FROM 20
     OR (SELECT sum(chip_balance) FROM public.club_members) IS DISTINCT FROM 20
     OR (SELECT sum(amount) FROM public.chip_ledger WHERE category='leaderboard_payout' AND to_type='leaderboard_round') IS DISTINCT FROM 20
     OR (SELECT sum(amount) FROM public.chip_ledger WHERE category='leaderboard_payout' AND from_type='leaderboard_round') IS DISTINCT FROM 20
     OR (SELECT count(*) FROM public.wallet_credit_idempotency WHERE key LIKE 'leaderboard:%')<>2
     OR (SELECT promo_balance FROM public.clubs WHERE id='92000000-0000-4000-8000-000000000002') IS DISTINCT FROM 0
     OR (SELECT chip_treasury FROM public.clubs WHERE id='92000000-0000-4000-8000-000000000002') IS DISTINCT FROM 99980
     OR EXISTS(SELECT 1 FROM public.leaderboard_payout_failures WHERE resolved_at IS NULL) THEN
    RAISE EXCEPTION 'Independent worker two-round reconciliation failed';
  END IF;
END;
$audit$;
SQL
echo 'DRAFT concurrent payout, committed replay, worker exclusion and remaining-round assertions passed; owning container cleanup required.'
