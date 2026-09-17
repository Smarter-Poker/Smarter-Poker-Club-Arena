#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fixture=$(mktemp -d /tmp/agent-agreement-integrity.XXXXXX)
started=0
cleanup() { if [ "$started" = 1 ];then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null;fi;rm -rf "$fixture"; }
trap cleanup EXIT
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" -o "-k $fixture/socket -p 55513 -h ''" start >/dev/null
started=1
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55513 -d postgres \
 -f "$root/tests/fixtures/agent-agreement-integrity/bootstrap.sql" \
 -f "$root/tests/fixtures/agent-agreement-integrity/create-preimage.sql" \
 -f "$root/tests/fixtures/agent-agreement-integrity/update-preimage.sql" \
 -f "$root/tests/fixtures/agent-agreement-integrity/downline-preimage.sql" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914150500_agent_agreements_preserve_club_scope_and_atomic_role_changes.sql" \
 -f "$root/tests/fixtures/agent-agreement-integrity/regression.sql"
python3 - "$pgbin/psql" "$fixture/socket" <<'PY'
import subprocess,sys,time
psql=[sys.argv[1],'-X','-q','-t','-A','-v','ON_ERROR_STOP=1','-h',sys.argv[2],'-p','55513','-d','postgres']
first=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
second=None
try:
 first.stdin.write("BEGIN; UPDATE agents SET commission_rate=.4 WHERE id=u(100);\\echo agreement_lock_held\n");first.stdin.flush()
 while True:
  line=first.stdout.readline()
  if not line: raise RuntimeError('Parent writer exited early: '+first.stderr.read())
  if 'agreement_lock_held' in line: break
 second=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 second.stdin.write("UPDATE agents SET commission_rate=.5 WHERE id=u(101);\n");second.stdin.close()
 time.sleep(.15)
 if second.poll() is not None: raise RuntimeError('Competing child write did not wait for its club agreement lock')
 unrelated=subprocess.run(psql,input="UPDATE agents SET commission_rate=.55 WHERE id=u(200);",text=True,capture_output=True,timeout=3)
 if unrelated.returncode: raise RuntimeError('Unrelated club edit was blocked: '+unrelated.stderr)
 print('PASS: another club can edit its agreement while this club is serialized')
 first.stdin.write('COMMIT;\n');first.stdin.close();first.wait(timeout=10)
 if first.returncode: raise RuntimeError(first.stderr.read())
 second.wait(timeout=10)
 if second.returncode==0 or 'parent cap' not in second.stderr.read(): raise RuntimeError('Competing child writer did not reject the freshly committed lower cap')
 proof=subprocess.run(psql,input="SELECT c.commission_rate<=p.commission_rate FROM agents c JOIN agents p ON p.id=c.parent_agent_id WHERE c.id=u(101);",text=True,check=True,capture_output=True)
 if proof.stdout.strip()!='t': raise RuntimeError('Concurrent agreement edits left an invalid parent cap')
 print('PASS: waiting direct child write rechecks the committed parent cap and cannot create a conflict')
finally:
 for process in (first,second):
  if process is not None and process.poll() is None: process.terminate();process.wait(timeout=10)
PY
