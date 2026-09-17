#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fixture=$(mktemp -d /tmp/settlement-integrity-test.XXXXXX)
started=0
cleanup() { if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null; fi; rm -rf "$fixture"; }
trap cleanup EXIT
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" -o "-k $fixture/socket -p 55488 -h ''" start >/dev/null
started=1
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55488 -d postgres \
 -f "$root/tests/fixtures/union-weekly-accounting/bootstrap.sql" \
 -f "$root/tests/fixtures/union-weekly-accounting/baseline.sql" \
 -f "$root/supabase/migrations/20260914110557_weekly_union_close_is_atomic_and_records_its_result.sql" \
 -f "$root/tests/fixtures/weekly-accounting-coordinator/bootstrap.sql" \
 -f "$root/tests/fixtures/weekly-accounting-coordinator/credit-writer.sql" \
 -f "$root/tests/fixtures/weekly-accounting-coordinator/preimage.sql" \
 -f "$root/supabase/migrations/20260914130411_weekly_accounting_uses_one_coordinator.sql" \
 -f "$root/tests/fixtures/settlement-integrity/bootstrap.sql" \
 -f "$root/tests/fixtures/settlement-integrity/autoledger-preimage.sql" \
 -c "CREATE TRIGGER test_actual_autoledger AFTER UPDATE OF chip_treasury ON clubs FOR EACH ROW WHEN (OLD.chip_treasury IS DISTINCT FROM NEW.chip_treasury) EXECUTE FUNCTION fn_ca_autoledger('chip_treasury=club_treasury');" \
 -f "$root/tests/fixtures/settlement-integrity/pnl-preimage.sql" \
 -f "$root/supabase/migrations/20260914132918_union_pnl_requires_full_funding_and_stable_failure_receipts.sql" \
 -c "SELECT proname,md5(pg_get_functiondef(oid)) AS installed_definition_md5 FROM pg_proc WHERE proname IN('fn_union_settle_player_pnl','fn_process_weekly_accounting');" \
 -f "$root/tests/fixtures/settlement-integrity/regression.sql"
python3 - "$pgbin/psql" "$fixture/socket" <<'PY'
import subprocess,sys,time
psql=[sys.argv[1],'-X','-q','-t','-A','-v','ON_ERROR_STOP=1','-h',sys.argv[2],'-p','55488','-d','postgres']
subprocess.run(psql,input="INSERT INTO unions VALUES(u(2)); INSERT INTO union_settlement_floor VALUES(u(2),'2026-09-07'); INSERT INTO union_wallets VALUES(u(2),0); UPDATE clubs SET chip_treasury=CASE WHEN id=u(11) THEN 100 WHEN id=u(12) THEN 20 ELSE 0 END;",text=True,check=True,capture_output=True)
query="SELECT fn_union_settle_player_pnl(u(2),'2026-09-07T07:00Z','2026-09-14T07:00Z',false)"
first=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
second=None
try:
 first.stdin.write("BEGIN; "+query+";\\echo pnl_lock_held\n");first.stdin.flush()
 while True:
  line=first.stdout.readline()
  if not line: raise RuntimeError('First P&L caller exited before lock proof: '+first.stderr.read())
  if 'pnl_lock_held' in line: break
 second=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 second.stdin.write(query+"->>'already_settled';\n");second.stdin.close()
 time.sleep(.15)
 if second.poll() is not None: raise RuntimeError('Competing P&L caller bypassed the transaction lock: '+second.stdout.read()+second.stderr.read())
 first.stdin.write('COMMIT;\n');first.stdin.close();first.wait(timeout=10)
 if first.returncode: raise RuntimeError(first.stderr.read())
 second.wait(timeout=10)
 if second.returncode: raise RuntimeError(second.stderr.read())
 if second.stdout.read().strip()!='true': raise RuntimeError('Competing caller did not read the committed exact replay')
 proof=subprocess.run(psql,input="SELECT count(*)=3 AND sum(i.net_amount)=200 FROM settlement_invoices i JOIN chip_ledger l ON l.id=i.source_ledger_id JOIN ca_settlements s ON s.id::text=l.settlement_id WHERE s.union_id=u(2);",text=True,check=True,capture_output=True)
 if proof.stdout.strip()!='t': raise RuntimeError('Concurrent P&L calls duplicated or lost a source receipt: '+proof.stdout)
 print('PASS: competing P&L calls serialize and commit each fully funded source receipt exactly once')
finally:
 for process in (first,second):
  if process is not None and process.poll() is None: process.terminate();process.wait(timeout=10)
PY
