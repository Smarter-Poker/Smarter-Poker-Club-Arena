#!/usr/bin/env bash
set -euo pipefail
BIN="${POKER_AUDIT_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIX="$ROOT/scripts/dev/fixtures/terminal-bounty-candidate-coverage"
MIG="$ROOT/supabase/migrations/20260914135625_terminal_bounty_residual_requires_complete_candidate_coverag.sql"
TMP=$(mktemp -d /tmp/ca-r38-terminal.XXXXXX)
cleanup() { "$BIN/pg_ctl" -D "$TMP/data" -m fast -w stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
"$BIN/initdb" -D "$TMP/data" -U postgres -A trust --locale=en_US.UTF-8 >"$TMP/initdb.log"
mkdir "$TMP/sock"
"$BIN/pg_ctl" -D "$TMP/data" -o "-k $TMP/sock -c listen_addresses='' -p 55443 -c fsync=off" -l "$TMP/pg.log" -w start >/dev/null
P() { "$BIN/psql" -h "$TMP/sock" -p 55443 -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 "$@"; }
P -f "$FIX/bootstrap.sql"
P -f "$FIX/counterexample.sql"
P -f "$MIG"
P -f "$FIX/qualification.sql"
P -f "$FIX/extra-qualification.sql"
P -f "$FIX/scope.sql"
P -f "$FIX/concurrent-setup.sql"
P -f "$FIX/concurrent-claim.sql" >"$TMP/claim.log" 2>&1 &
claim_pid=$!
ready=false
for i in $(seq 1 50); do
 if [ "$(P -Atc "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=783138 AND objid=1 AND granted")" = 1 ]; then ready=true; break; fi
 sleep 0.02
done
$ready || { echo 'FAIL: concurrent claimant did not hold its witness lock'; exit 1; }
P -f "$FIX/concurrent-finalize.sql"
wait "$claim_pid"
cat "$TMP/claim.log"
pids=()
for i in 1 2 3 4 5; do
 P -f "$FIX/concurrent-finalize.sql" >"$TMP/replay-$i.log" 2>&1 &
 pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid"; done
cat "$TMP"/replay-*.log
P -f "$FIX/concurrent-verify.sql"
P -f "$MIG"
P -f "$FIX/concurrent-finalize.sql"
P -f "$FIX/concurrent-verify.sql"
P -Atc "SELECT pg_get_functiondef(oid)||';' FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('fn_bounty_candidate_completion_status_v1','fn_finalize_bounty_pool','fn_mystery_bounty_settle') ORDER BY proname" >"$TMP/postimages.sql"
for signature in 'public.fn_bounty_candidate_completion_status_v1(uuid)' 'public.fn_finalize_bounty_pool(uuid,uuid)' 'public.fn_mystery_bounty_settle(uuid,uuid)'; do
 P -c "SET fixture.drift_target='$signature'" -f - <<'SQL'
DO $$ BEGIN
 EXECUTE replace(pg_get_functiondef(current_setting('fixture.drift_target')::regprocedure),
  'AS $function$','AS $function$'||chr(10)||'-- Unreviewed native test drift'||chr(10));
END $$;
SQL
 if P -f "$MIG" >"$TMP/drift-refusal.log" 2>&1; then
  echo 'FAIL: changed terminal source accepted' >&2; exit 1
 fi
 grep -q 'Terminal candidate unreviewed source or metadata' "$TMP/drift-refusal.log"
 P -f "$TMP/postimages.sql"
done
P -c 'GRANT EXECUTE ON FUNCTION public.fn_bounty_candidate_completion_status_v1(uuid) TO service_role'
if P -f "$MIG" >"$TMP/acl-refusal.log" 2>&1; then
 echo 'FAIL: unexpected terminal helper grant accepted' >&2; exit 1
fi
grep -q 'Terminal candidate unreviewed source or metadata' "$TMP/acl-refusal.log"
P -c 'REVOKE EXECUTE ON FUNCTION public.fn_bounty_candidate_completion_status_v1(uuid) FROM service_role'
for role in anon authenticated service_role; do
 if P -c "SET ROLE $role" -c 'SELECT public.fn_bounty_candidate_completion_status_v1(NULL)' >"$TMP/role-refusal.log" 2>&1; then
  echo 'FAIL: private coverage helper callable outside original authorities' >&2; exit 1
 fi
 grep -q 'permission denied' "$TMP/role-refusal.log"
done
for role in anon authenticated; do
 for signature in 'fn_finalize_bounty_pool' 'fn_mystery_bounty_settle'; do
  if P -c "SET ROLE $role" -c "SELECT public.$signature(NULL,NULL)" >"$TMP/role-refusal.log" 2>&1; then
   echo 'FAIL: browser can call terminal money authority' >&2; exit 1
  fi
  grep -q 'permission denied' "$TMP/role-refusal.log"
 done
done
P -f "$MIG"
echo 'PASS: terminal source/metadata guards, exact replay and seven private role refusals'
