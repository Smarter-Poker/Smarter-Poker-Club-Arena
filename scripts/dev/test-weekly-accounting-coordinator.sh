#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fixture=$(mktemp -d "${TMPDIR:-/tmp}/weekly-coordinator-test.XXXXXX")
started=0
cleanup() { if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null; fi; rm -rf "$fixture"; }
trap cleanup EXIT
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" -o "-k $fixture/socket -p 55487 -h ''" start >/dev/null
started=1
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55487 -d postgres \
 -f "$root/tests/fixtures/union-weekly-accounting/bootstrap.sql" \
 -f "$root/tests/fixtures/union-weekly-accounting/baseline.sql" \
 -f "$root/supabase/migrations/20260914110557_weekly_union_close_is_atomic_and_records_its_result.sql" \
 -f "$root/tests/fixtures/weekly-accounting-coordinator/bootstrap.sql" \
 -f "$root/tests/fixtures/weekly-accounting-coordinator/credit-writer.sql" \
 -f "$root/tests/fixtures/weekly-accounting-coordinator/preimage.sql" \
 -f "$root/supabase/migrations/20260914130411_weekly_accounting_uses_one_coordinator.sql" \
 -f "$root/tests/fixtures/weekly-accounting-coordinator/regression.sql"
python3 - "$pgbin/psql" "$fixture/socket" <<'PY'
import subprocess,sys
psql=[sys.argv[1],'-X','-q','-t','-A','-v','ON_ERROR_STOP=1','-h',sys.argv[2],'-p','55487','-d','postgres']
first=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
try:
 first.stdin.write("BEGIN; SET test.clock='2026-09-14T09:20:00Z'; SELECT fn_union_settlement_cascade_due();\\echo coordinator_lock_held\n")
 first.stdin.flush()
 while True:
  line=first.stdout.readline()
  if not line: raise RuntimeError('First coordinator exited before lock proof: '+first.stderr.read())
  if 'coordinator_lock_held' in line: break
 second=subprocess.run(psql,input="SET test.clock='2026-09-14T09:20:00Z'; SELECT fn_union_weekly_rakeback_close_all(NULL)->>'reason';",capture_output=True,text=True,check=True,timeout=10)
 if second.stdout.strip()!='already_running': raise RuntimeError('Concurrent legacy caller bypassed coordinator: '+second.stdout)
 first.stdin.write('COMMIT;\n');first.stdin.close()
 first.wait(timeout=10)
 if first.returncode: raise RuntimeError(first.stderr.read())
 print('PASS: concurrent scheduled and legacy callers share one transaction lock')
finally:
 if first.poll() is None: first.terminate();first.wait(timeout=10)
PY
