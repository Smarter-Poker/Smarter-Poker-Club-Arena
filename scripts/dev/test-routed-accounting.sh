#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fixture=$(mktemp -d /tmp/routed-accounting-test.XXXXXX)
started=0
cleanup() { if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null; fi; rm -rf "$fixture"; }
trap cleanup EXIT
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" -o "-k $fixture/socket -p 55489 -h ''" start >/dev/null
started=1
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55489 -d postgres \
 -f "$root/tests/fixtures/routed-accounting/bootstrap.sql" \
 -f "$root/tests/fixtures/routed-accounting/preimage.sql" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914132449_rakeback_follows_recorded_hierarchy_in_one_funded_transaction.sql" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914135008_standalone_clubs_use_the_same_atomic_routed_stages.sql" \
 -f "$root/tests/fixtures/routed-accounting/mixed-source-schema.sql" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914140015_recognized_cash_and_tournament_sources_share_one_payment_route.sql" \
 -c "SELECT proname,md5(pg_get_functiondef(oid)) AS installed_definition_md5 FROM pg_proc WHERE proname IN('fn_settle_round2_club_to_agents','fn_settle_round3_agents_to_players','fn_settle_accounting_commission_stage','fn_settle_accounting_rakeback_stage','fn_resolve_accounting_routing_scope');" \
 -f "$root/tests/fixtures/routed-accounting/seed.sql" \
 -f "$root/tests/fixtures/routed-accounting/regression.sql" \
 -f "$root/tests/fixtures/routed-accounting/standalone-regression.sql"
python3 - "$pgbin/psql" "$fixture/socket" <<'PY'
import subprocess,sys,time
psql=[sys.argv[1],'-X','-q','-t','-A','-v','ON_ERROR_STOP=1','-h',sys.argv[2],'-p','55489','-d','postgres']
first=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
second=None
try:
 first.stdin.write("BEGIN; SELECT run_all();\\echo routing_lock_held\n");first.stdin.flush()
 while True:
  line=first.stdout.readline()
  if not line: raise RuntimeError('First routed caller exited before lock proof: '+first.stderr.read())
  if 'routing_lock_held' in line: break
 second=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 second.stdin.write("SELECT bool_and(value->>'duplicate'='true') FROM jsonb_each(run_all());\n");second.stdin.close()
 time.sleep(.15)
 if second.poll() is not None: raise RuntimeError('Competing caller bypassed the transaction lock: '+second.stdout.read()+second.stderr.read())
 first.stdin.write('COMMIT;\n');first.stdin.close();first.wait(timeout=10)
 if first.returncode: raise RuntimeError(first.stderr.read())
 second.wait(timeout=10)
 if second.returncode: raise RuntimeError(second.stderr.read())
 if second.stdout.read().strip()!='t': raise RuntimeError('Competing caller did not read the committed exact replay')
 proof=subprocess.run(psql,input="SELECT (SELECT count(*) FROM chip_ledger)=6 AND (SELECT count(*) FROM settlement_invoices)=6 AND (SELECT count(*) FROM agent_commission_settlements)=3 AND (SELECT count(*) FROM rakeback_period_payouts)=3 AND (SELECT chip_treasury FROM clubs)=153.40;",text=True,check=True,capture_output=True)
 if proof.stdout.strip()!='t': raise RuntimeError('Concurrent routed calls duplicated or lost money/receipt: '+proof.stdout)
 print('PASS: competing full waterfall callers serialize and settle each source obligation once')
finally:
 for process in (first,second):
  if process is not None and process.poll() is None: process.terminate();process.wait(timeout=10)
PY
# Independent database uses the actual source invoice, Messenger, notification and role publisher bodies.
"$pgbin/createdb" -h "$fixture/socket" -p 55489 routed_delivery
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55489 -d routed_delivery \
 -f "$root/tests/fixtures/routed-accounting/bootstrap.sql" \
 -f "$root/tests/fixtures/routed-accounting/preimage.sql" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914132449_rakeback_follows_recorded_hierarchy_in_one_funded_transaction.sql" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914135008_standalone_clubs_use_the_same_atomic_routed_stages.sql" \
 -f "$root/tests/fixtures/routed-accounting/seed.sql" \
 -c "UPDATE accounting_rakeback_period_calculations c SET source_allocations=(SELECT jsonb_agg(a-'source_type') FROM jsonb_array_elements(c.source_allocations)a);" \
 -f "$root/tests/fixtures/routed-accounting/central-delivery-schema.sql" \
 -f "$root/tests/fixtures/routed-accounting/central-delivery-preimage.sql" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914133404_routed_invoice_roles_follow_the_recorded_payment.sql" \
 -f "$root/tests/fixtures/routed-accounting/central-delivery-triggers.sql" \
 -f "$root/tests/fixtures/routed-accounting/central-delivery-regression.sql"
python3 - "$pgbin/psql" "$fixture/socket" <<'PY'
import subprocess,sys,time
psql=[sys.argv[1],'-X','-q','-t','-A','-v','ON_ERROR_STOP=1','-h',sys.argv[2],'-p','55489','-d','routed_delivery']
subprocess.run(psql,input='UPDATE accounting_cash_rake_sources SET coordinator_union_id=NULL,union_id=NULL;UPDATE accounting_rakeback_period_calculations SET coordinator_union_id=NULL;',text=True,check=True,capture_output=True)
first=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
second=None
try:
 first.stdin.write("BEGIN; SELECT run_standalone();\\echo standalone_lock_held\n");first.stdin.flush()
 while True:
  line=first.stdout.readline()
  if not line: raise RuntimeError('First standalone caller exited before lock proof: '+first.stderr.read())
  if 'standalone_lock_held' in line: break
 second=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 second.stdin.write("SELECT bool_and(value->>'duplicate'='true') FROM jsonb_each(run_standalone());\n");second.stdin.close()
 time.sleep(.15)
 if second.poll() is not None: raise RuntimeError('Competing standalone caller bypassed transaction lock: '+second.stdout.read()+second.stderr.read())
 first.stdin.write('COMMIT;\n');first.stdin.close();first.wait(timeout=10)
 if first.returncode: raise RuntimeError(first.stderr.read())
 second.wait(timeout=10)
 if second.returncode: raise RuntimeError(second.stderr.read())
 if second.stdout.read().strip()!='t': raise RuntimeError('Competing standalone caller did not read exact committed replay')
 proof=subprocess.run(psql,input="SELECT (SELECT count(*) FROM chip_ledger)=6 AND (SELECT count(*) FROM settlement_invoices)=6 AND (SELECT count(*) FROM accounting_invoice_deliveries)=10 AND (SELECT count(*) FROM social_messages)=10 AND (SELECT count(*) FROM notifications)=10 AND (SELECT chip_treasury FROM clubs)=153.40;",text=True,check=True,capture_output=True)
 if proof.stdout.strip()!='t': raise RuntimeError('Concurrent standalone calls duplicated or lost money/document: '+proof.stdout)
 print('PASS: competing standalone callers serialize full shared stages and real Messenger delivery exactly once')
finally:
 for process in (first,second):
  if process is not None and process.poll() is None: process.terminate();process.wait(timeout=10)
PY
# Forward-upgrade proof: generated scope columns preserve existing immutable paid union receipts.
"$pgbin/createdb" -h "$fixture/socket" -p 55489 routed_upgrade
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55489 -d routed_upgrade \
 -f "$root/tests/fixtures/routed-accounting/bootstrap.sql" \
 -f "$root/tests/fixtures/routed-accounting/preimage.sql" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914132449_rakeback_follows_recorded_hierarchy_in_one_funded_transaction.sql" \
 -f "$root/tests/fixtures/routed-accounting/seed.sql" \
 -c "SELECT run_all();" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914135008_standalone_clubs_use_the_same_atomic_routed_stages.sql" \
 -c "SELECT assert_true((SELECT count(*) FROM accounting_routed_settlement_runs WHERE scope_kind='union' AND scope_id=u(1) AND standalone_club_id IS NULL)=2,'scope schema upgrade preserves immutable existing paid union receipts'); SELECT assert_true(run2()->>'duplicate'='true' AND run3()->>'duplicate'='true' AND (SELECT count(*) FROM chip_ledger)=6,'shared wrappers read the original paid union run without money or document replay');"
python3 - "$pgbin/psql" "$fixture/socket" <<'PY'
import subprocess,sys,time
psql=[sys.argv[1],'-X','-q','-t','-A','-v','ON_ERROR_STOP=1','-h',sys.argv[2],'-p','55489','-d','routed_upgrade']
first=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
second=None
try:
 first.stdin.write("BEGIN; SELECT scope_key FROM fn_resolve_accounting_routing_scope('union',u(1),'2026-09-07T07:00Z','2026-09-14T07:00Z'); INSERT INTO clubs VALUES(u(12),0); INSERT INTO accounting_cash_rake_sources VALUES(u(404),u(504),u(304),u(12),NULL,u(1),'2026-09-10',0,jsonb_build_object('club_id',u(12),'tiers','[]'::jsonb));\\echo source_discovery_lock_held\n");first.stdin.flush()
 while True:
  line=first.stdout.readline()
  if not line: raise RuntimeError('Source discovery holder exited early: '+first.stderr.read())
  if 'source_discovery_lock_held' in line: break
 second=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 second.stdin.write("SELECT u(12)=ANY(club_ids) FROM fn_resolve_accounting_routing_scope('union',u(1),'2026-09-07T07:00Z','2026-09-14T07:00Z');\n");second.stdin.close()
 time.sleep(.15)
 if second.poll() is not None: raise RuntimeError('Close scope discovery bypassed its earning-period lock: '+second.stdout.read()+second.stderr.read())
 current=subprocess.run(psql,input="SELECT count(*) FROM fn_resolve_accounting_routing_scope('union',u(1),'2026-09-14T07:00Z','2026-09-21T07:00Z');",text=True,check=True,capture_output=True,timeout=3)
 if current.stdout.strip()!='1': raise RuntimeError('Current-week source scope could not resolve independently')
 print('PASS: a past-week close lock does not block current-week source scope discovery')
 first.stdin.write('COMMIT;\n');first.stdin.close();first.wait(timeout=10)
 if first.returncode: raise RuntimeError(first.stderr.read())
 second.wait(timeout=10)
 if second.returncode: raise RuntimeError(second.stderr.read())
 if second.stdout.read().strip()!='t': raise RuntimeError('Waiting resolver used stale clubs read before source commit')
 print('PASS: a waiting scope resolver discovers the newly committed historical club after acquiring the shared earning-period lock')
finally:
 for process in (first,second):
  if process is not None and process.poll() is None: process.terminate();process.wait(timeout=10)
PY
# Recognized tournaments and cash use the same actual stages and real delivery.
"$pgbin/createdb" -h "$fixture/socket" -p 55489 routed_mixed
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55489 -d routed_mixed \
 -f "$root/tests/fixtures/routed-accounting/bootstrap.sql" \
 -f "$root/tests/fixtures/routed-accounting/preimage.sql" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914132449_rakeback_follows_recorded_hierarchy_in_one_funded_transaction.sql" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914135008_standalone_clubs_use_the_same_atomic_routed_stages.sql" \
 -f "$root/tests/fixtures/routed-accounting/mixed-source-schema.sql" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914140015_recognized_cash_and_tournament_sources_share_one_payment_route.sql" \
 -f "$root/tests/fixtures/routed-accounting/seed.sql" \
 -f "$root/tests/fixtures/routed-accounting/mixed-source-seed.sql" \
 -f "$root/tests/fixtures/routed-accounting/mixed-source-rollup.sql" \
 -f "$root/tests/fixtures/routed-accounting/central-delivery-schema.sql" \
 -f "$root/tests/fixtures/routed-accounting/central-delivery-preimage.sql" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914133404_routed_invoice_roles_follow_the_recorded_payment.sql" \
 -f "$root/tests/fixtures/routed-accounting/central-delivery-triggers.sql" \
 -f "$root/tests/fixtures/routed-accounting/mixed-source-regression.sql" \
 -c "SELECT proname,md5(pg_get_functiondef(oid)) AS mixed_definition_md5 FROM pg_proc WHERE proname IN('fn_settle_accounting_commission_stage','fn_settle_accounting_rakeback_stage','fn_resolve_accounting_routing_scope');"
# Original completed cash-only certificates did not have source_type. Reading
# those exact paid receipts is allowed; no unpaid certificate receives fallback.
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55489 -d routed_delivery \
 -f "$root/tests/fixtures/routed-accounting/mixed-source-schema.sql" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914140015_recognized_cash_and_tournament_sources_share_one_payment_route.sql" \
 -c "SELECT assert_true((SELECT bool_and(value->>'duplicate'='true') FROM jsonb_each(run_standalone())) AND (SELECT count(*) FROM chip_ledger)=6,'the mixed reader preserves completed pure-cash fingerprints and untyped-certificate read-only replay'); SELECT assert_true((SELECT count(*) FROM settlement_invoices)=6 AND (SELECT count(*) FROM accounting_invoice_deliveries)=10,'the source-reader upgrade neither rewrites nor redelivers original paid cash documents');"
