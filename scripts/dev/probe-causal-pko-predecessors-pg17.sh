#!/usr/bin/env bash
# Private PostgreSQL17 only. No database URL, production row, or provider call.
set -euo pipefail
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
BIN="${POKER_AUDIT_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIX="$ROOT/scripts/dev/fixtures/causal-pko-predecessors"
MIG="$ROOT/supabase/migrations/20260914133503_pko_heads_follow_accepted_knockout_dependencies.sql"
ACL_MIG="$ROOT/supabase/migrations/20260914135834_preserve_explicit_private_pko_claim_and_collector_grants.sql"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/ca-pko-causal.XXXXXX")"
cluster_start_attempted=false
cleanup() {
  local original_status=$? cleanup_failed=0 status_code=0
  trap - EXIT
  set +e
  if [[ "$cluster_start_attempted" == true ]]; then
    "$BIN/pg_ctl" -D "$TMP/data" status >"$TMP/cleanup-before.log" 2>&1
    status_code=$?
    if [[ "$status_code" == 0 ]]; then
      "$BIN/pg_ctl" -D "$TMP/data" -m fast -w -t 60 stop >"$TMP/cleanup-stop.log" 2>&1
      if [[ "$?" != 0 ]]; then cleanup_failed=1; fi
      "$BIN/pg_ctl" -D "$TMP/data" status >"$TMP/cleanup-after.log" 2>&1
      if [[ "$?" != 3 ]]; then cleanup_failed=1; fi
    elif [[ "$status_code" != 3 ]]; then
      cleanup_failed=1
    fi
  fi
  if [[ "$original_status" != 0 || "$cleanup_failed" != 0 ]]; then
    printf 'FAIL: probe status=%s cleanup_failed=%s; diagnostics retained at %s\n' \
      "$original_status" "$cleanup_failed" "$TMP" >&2
    for log in "$TMP"/*.log; do
      if [[ -f "$log" ]]; then
        printf '\n--- %s ---\n' "${log##*/}" >&2
        cat "$log" >&2
      fi
    done
    if [[ "$original_status" != 0 ]]; then exit "$original_status"; fi
    exit 1
  fi
  if ! rm -rf -- "$TMP"; then
    printf 'FAIL: could not remove confirmed-stopped fixture %s\n' "$TMP" >&2
    exit 1
  fi
  exit 0
}
trap cleanup EXIT
"$BIN/postgres" --version | grep -q ' 17\.' || { echo 'PostgreSQL17 required' >&2; exit 2; }
"$BIN/initdb" -D "$TMP/data" -U postgres -A trust --locale=en_US.UTF-8 >"$TMP/initdb.log"
mkdir "$TMP/sock"
cluster_start_attempted=true
"$BIN/pg_ctl" -D "$TMP/data" -o "-k $TMP/sock -c listen_addresses='' -p 55442 -c fsync=off" -l "$TMP/pg.log" -w start >/dev/null
P() { "$BIN/psql" -h "$TMP/sock" -p 55442 -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 "$@"; }
P -f "$FIX/bootstrap.sql"
P -f "$FIX/counterexample.sql"
P -f "$FIX/inverted-hand-counterexample.sql"
P -f "$FIX/capture-preimage.sql"
P -f "$MIG"
P -f "$ACL_MIG"
P -f "$FIX/helpers.sql"
for scenario in qualification evidence-matrix pending-snapshot independent-pending multiple-predecessors scope-cost; do
  P -f "$FIX/$scenario.sql"
done
P -f "$FIX/concurrent-setup.sql"
pids=()
for i in 1 2 3 4 5; do
  P -f "$FIX/concurrent-call.sql" >"$TMP/concurrent-$i.log" 2>&1 &
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid"; done
cat "$TMP"/concurrent-*.log
P -f "$FIX/concurrent-verify.sql"
P -f "$MIG"
P -Atc "SELECT pg_get_functiondef(oid)||';' FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('fn_claim_bounty_legacy_candidate_20260907','fn_collect_bounty','fn_pko_candidate_accepted_scope_v1','fn_pko_claim_predecessor_status_v1','fn_pko_watermark_admission_status_v1') ORDER BY proname" >"$TMP/postimages.sql"
for signature in \
  'public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)' \
  'public.fn_collect_bounty(uuid,uuid,uuid,jsonb)' \
  'public.fn_pko_candidate_accepted_scope_v1(uuid,uuid)' \
  'public.fn_pko_claim_predecessor_status_v1(uuid,uuid,uuid,uuid,bigint,timestamptz)' \
  'public.fn_pko_watermark_admission_status_v1(uuid,uuid,uuid,uuid,bigint,timestamptz,jsonb)'; do
  P -c "SET fixture.drift_target='$signature'" -f - <<'SQL'
DO $$ BEGIN
 EXECUTE replace(pg_get_functiondef(current_setting('fixture.drift_target')::regprocedure),
  'AS $function$','AS $function$'||chr(10)||'-- Unreviewed test drift'||chr(10));
END $$;
SQL
  if P -f "$MIG" >"$TMP/drift-refusal.log" 2>&1; then
    echo 'FAIL: unreviewed function body accepted' >&2; exit 1
  fi
  grep -q 'PKO dependency unreviewed source or metadata' "$TMP/drift-refusal.log"
  P -f "$TMP/postimages.sql"
done
P -c 'GRANT EXECUTE ON FUNCTION public.fn_pko_candidate_accepted_scope_v1(uuid,uuid) TO service_role'
if P -f "$MIG" >"$TMP/acl-refusal.log" 2>&1; then
  echo 'FAIL: unexpected private helper grant accepted' >&2; exit 1
fi
grep -q 'PKO dependency unreviewed source or metadata' "$TMP/acl-refusal.log"
P -c 'REVOKE EXECUTE ON FUNCTION public.fn_pko_candidate_accepted_scope_v1(uuid,uuid) FROM service_role'
for role in anon authenticated service_role; do
  if P -c "SET ROLE $role" -c 'SELECT public.fn_pko_candidate_accepted_scope_v1(NULL,NULL)' >"$TMP/private-refusal.log" 2>&1; then
    echo 'FAIL: private helper callable outside original authorities' >&2; exit 1
  fi
  grep -q 'permission denied' "$TMP/private-refusal.log"
done
P -f "$MIG"
echo 'PASS: five body guards, metadata guard, migration replay and three private-role refusals'
P -f "$ACL_MIG"
for role in anon authenticated service_role; do
  if P -c "SET ROLE $role" -c 'SELECT public.fn_claim_bounty_legacy_candidate_20260907(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,false)' >"$TMP/claim-private-refusal.log" 2>&1; then
    echo 'FAIL: private claim callable outside its original authority' >&2; exit 1
  fi
  grep -q 'permission denied' "$TMP/claim-private-refusal.log"
done
for role in anon authenticated; do
  if P -c "SET ROLE $role" -c 'SELECT public.fn_collect_bounty(NULL,NULL,NULL,NULL)' >"$TMP/collector-private-refusal.log" 2>&1; then
    echo 'FAIL: collector callable from a browser role' >&2; exit 1
  fi
  grep -q 'permission denied' "$TMP/collector-private-refusal.log"
done
echo 'PASS: explicit caller privileges replay and five original-authority refusals'
echo 'PASS: causal PKO admission, immutable replay and bounded native concurrency'
