#!/usr/bin/env python3
"""Bounded successor qualification in the existing isolated full-schema runner."""
import hashlib,json,subprocess,sys
from pathlib import Path
root=Path(__file__).resolve().parents[2]
psql,socket,port,database,out=sys.argv[1:];out=Path(out);out.mkdir(exist_ok=True,parents=True)
fix=root/'tests/fixtures/legacy-fee-finality'
binding=json.loads((fix/'source-binding.json').read_text())
def verify_binding():
 for relative,expected in binding['repository_files'].items():
  if hashlib.sha256((root/relative).read_bytes()).hexdigest()!=expected:
   raise AssertionError('Unreviewed legacy fee source drift: '+relative)
verify_binding()
if database!='postgres' or not socket.startswith('/'):
 raise AssertionError('Private native full-schema fixture required')
cmd=[psql,'-X','-q','-v','ON_ERROR_STOP=1','-U','postgres','-h',socket,'-p',port,'-d',database,'-c',"SET timezone='UTC';SET statement_timeout='60s';SET lock_timeout='2s';"]
def run(sql,label,args=[]):
 p=out/(label+'.sql');p.write_text(sql)
 r=subprocess.run(cmd+args+['-f',str(p)],capture_output=True,text=True)
 (out/(label+'.log')).write_text(r.stdout+r.stderr)
 if r.returncode:raise AssertionError(label+': '+r.stderr[-5000:])
 print('PASS '+label,flush=True)
# Reuse the accepted full-schema activation, then install exact currently
# deployed preimages and the separately qualified original-Spin dependency.
spin=root/'tests/fixtures/spin-mixed-cutover'
rows=json.loads((spin/'captured-preimages.json').read_text())['functions']
sql=''
for r in rows:
 sql+=r['definition']+';\nREVOKE ALL ON FUNCTION public.'+r['identity']+' FROM PUBLIC,anon,authenticated,service_role;\n'
 if any(a.startswith('service_role=') for a in r['acl']):sql+='GRANT EXECUTE ON FUNCTION public.'+r['identity']+' TO service_role;\n'
run(sql,'legacy-original-accounting-preimages')
# Original managed scope definitions already exist in the full captured schema.
run(next((root/'supabase/migrations').glob('20260918085836*.sql')).read_text(),'legacy-qualified-spin-predecessor')
run((fix/'capture-bootstrap.sql').read_text(),'legacy-original-capture-relation')
access=json.loads((fix/'captured-access.json').read_text());sql='SET check_function_bodies=off;\n'
for r in access:
 name=r['identity'].split('(')[0]
 sql+=(fix/(name+'.sql')).read_text()+';\nREVOKE ALL ON FUNCTION public.'+r['identity']+' FROM PUBLIC,anon,authenticated,service_role;\n'
 if 'service_role=' in r['acl']:sql+='GRANT EXECUTE ON FUNCTION public.'+r['identity']+' TO service_role;\n'
sql+=(fix/'fn_complete_tournament_terminal.sql').read_text()+';\n'
run(sql,'legacy-exact-terminal-predecessors')
run((root/'tests/fixtures/tournament-fee-lifecycle/full-lifecycle-seed.sql').read_text(),'legacy-original-template')
def original_variable(name,path):
 raw=path.read_text().strip()
 json.loads(raw) # Validate syntax without reserializing decimal evidence.
 assert '$legacy_original_json$' not in raw
 return 'SELECT $legacy_original_json$'+raw+'$legacy_original_json$ AS '+name+' \\gset\n'
run(original_variable('legacy_original_fees',fix/'original-fees.json')+(fix/'setup.sql').read_text(),'legacy-original-opening-scene')
run("SELECT jsonb_agg(to_jsonb(q)) FROM (SELECT c.tournament_id,count(*) n,sum(r.rake_amount) net,md5(string_agg(public.fn_accounting_tournament_fee_fingerprint(r),':' ORDER BY r.id)) fingerprint,max(r.created_at) latest,count(r.terminal_closed_at) marked FROM public.rake_records r JOIN legacy_fee_fixture.cases c USING(tournament_id) GROUP BY c.tournament_id)q;",'legacy-original-source-identity')
run((fix/'positive-opening.sql').read_text(),'legacy-synthetic-original-funding')
pko_input=''.join(original_variable(name,fix/file) for name,file in [
 ('legacy_pko_original_fees','pko-original-fees.json'),
 ('legacy_pko_original_canonical','pko-original-canonical.json'),
 ('legacy_pko_original_funding','pko-original-funding-scope.json')])
run(pko_input+(fix/'pko-opening.sql').read_text(),'legacy-pko-original-opening')
supply=(fix/'fn_ca_supply_snapshot.sql').read_text()
assert hashlib.md5(supply.encode()).hexdigest()=='261db1022bd41955c49ea8248390ae92'
start=supply.index('(SELECT COALESCE(sum(\n              CASE WHEN e.tournament_id IS NOT NULL')
end=supply.index('AS tourn_liab',start)
supply_query=supply[start:end].strip()
run('CREATE TABLE legacy_fee_fixture.original_supply AS SELECT '+supply_query+' liability;','legacy-original-supply-basis')
run((fix/'before.sql').read_text(),'legacy-before-positive-fee-refusal')
subprocess.run([sys.executable,str(fix/'build-candidate.py'),'--check'],check=True)
candidate=next((root/'supabase/migrations').glob('20260918090848*.sql')).read_text()
# A late exact-preimage refusal must undo every preceding DDL and guard patch.
run("ALTER FUNCTION public.fn_ca_capture_tournament_fee_from_recorded_evidence(uuid) SET statement_timeout='31s';",'legacy-late-preimage-drift')
dump_cmd=[str(Path(psql).with_name('pg_dump')),'--schema-only','-U','postgres','-h',socket,'-p',port,'-d',database]
def schema_snapshot():
 return '\n'.join(x for x in subprocess.check_output(dump_cmd,text=True).splitlines() if not x.startswith(('\\restrict ','\\unrestrict ')))
schema_before=schema_snapshot()
path=out/'legacy-late-preimage-refusal.sql';path.write_text(candidate)
refusal=subprocess.run(cmd+['-f',str(path)],capture_output=True,text=True)
(out/'legacy-late-preimage-refusal.log').write_text(refusal.stdout+refusal.stderr)
if refusal.returncode==0 or 'fn_ca_capture_tournament_fee_from_recorded_evidence preimage changed' not in refusal.stderr:
 raise AssertionError('Exact late capture preimage drift was not refused')
if schema_snapshot()!=schema_before:raise AssertionError('Late preimage refusal failed to restore complete schema and ACL')
run("ALTER FUNCTION public.fn_ca_capture_tournament_fee_from_recorded_evidence(uuid) RESET statement_timeout;",'legacy-original-preimage-restored')
run(candidate,'legacy-custody-successor')
after=(fix/'after.sql').read_text()
marker='DO $$ DECLARE c record;state jsonb;receipt jsonb;'
cut=after.index(marker)
run(after[:cut]+'COMMIT;\n','legacy-late-custody-faults')
# Two actual first-completion backends wait on the owning event lock. The
# existing owner must create one financial result and replay that same result.
import time
interactive=[psql,'-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-h',socket,'-p',port,'-d',database]
for event in ['f370585d-40ea-4085-bb8f-c7e8c74f3fb4','1ffbd637-9241-4957-902f-3a75e09892c0']:
 locklog=(out/('legacy-concurrent-owner-lock-'+event+'.log')).open('w')
 locker=subprocess.Popen(interactive,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=locklog,text=True)
 closers=[]
 try:
  locker.stdin.write("BEGIN;SELECT 1 FROM public.tournaments WHERE id='"+event+"' FOR NO KEY UPDATE;SELECT 'LOCK_READY';\n");locker.stdin.flush()
  while True:
   line=locker.stdout.readline()
   if not line:raise AssertionError('Original tournament owner did not acquire lock')
   if line.strip()=='LOCK_READY':break
  query="SET timezone='UTC';SET request.jwt.claims='{\"role\":\"service_role\"}';SELECT public.fn_complete_tournament_terminal(tournament_id,winner_id,'places') FROM legacy_fee_fixture.cases WHERE tournament_id='"+event+"';"
  closers=[subprocess.Popen(interactive+['-c',query],env=dict(__import__('os').environ,PGAPPNAME='legacy-custody-close-'+str(i)),stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) for i in range(2)]
  time.sleep(.2)
  waiting=subprocess.check_output(cmd+['-At','-c',"SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'legacy-custody-close-%' AND wait_event_type='Lock';"],text=True).strip()
  if waiting!='2' or any(p.poll() is not None for p in closers):raise AssertionError('Both original completion requests must wait on their owning lock')
  locker.communicate('COMMIT;\n',timeout=10)
  results=[]
  for i,p in enumerate(closers):
   stdout,stderr=p.communicate(timeout=45);(out/('legacy-concurrent-close-'+event+'-'+str(i)+'.log')).write_text(stdout+stderr)
   if p.returncode:raise AssertionError(stdout+stderr)
   results.extend(json.loads(line) for line in stdout.splitlines() if line.startswith('{'))
  if len(results)!=2 or results[0]!=results[1] or results[0].get('accounting_state')!='fee_custody_unresolved':raise AssertionError('Two original completion backends did not return one identical custody terminal')
 finally:
  for p in [locker]+closers:
   if p.poll() is None:p.kill();p.wait()
  locklog.close()
 run("SELECT legacy_fee_fixture.assert((SELECT count(*)=1 FROM public.tournament_terminal_settlements WHERE tournament_id='"+event+"') AND (SELECT m.chip_balance=c.prize_amount+c.bounty_amount AND h.cash_payout_total=c.prize_amount AND h.bounty_payout_total=c.bounty_amount FROM legacy_fee_fixture.cases c JOIN public.club_members m ON m.club_id=c.club_id AND m.user_id=c.winner_id JOIN public.tournament_terminal_settlements h USING(tournament_id) WHERE c.tournament_id='"+event+"'),'Two simultaneous original closes produce one full player payment and one immutable terminal "+event+"');",'legacy-concurrent-owner-proof-'+event)

claims="BEGIN;SET LOCAL request.jwt.claims='{\"role\":\"service_role\"}';\n"
summary_cut=after.index(' quality:=')
case_sql=after[cut:summary_cut].replace('SELECT * FROM legacy_fee_fixture.cases ORDER BY tournament_id',"SELECT * FROM legacy_fee_fixture.cases WHERE tournament_id=current_setting('legacy_fee_fixture.case_id')::uuid")+'END $$;SET CONSTRAINTS ALL IMMEDIATE;COMMIT;\n'
original_case_ids=sorted(json.loads((fix/'original-fees.json').read_text()))
case_ids=sorted(original_case_ids+list(json.loads((fix/'pko-original-fees.json').read_text())))
for event in case_ids:
 run(claims+"SET LOCAL legacy_fee_fixture.case_id='"+event+"';\n"+case_sql,'legacy-finality-case-'+event)
run(claims+'DO $$ DECLARE quality jsonb;BEGIN\n'+after[summary_cut:],'legacy-finality-custody-qualification')

run('SELECT legacy_fee_fixture.assert(('+supply_query+')=(SELECT liability FROM legacy_fee_fixture.original_supply)-(SELECT sum(prize_amount+bounty_amount) FROM legacy_fee_fixture.cases),'+"'Existing actual supply reader counts all689 held fees after player completion');",'legacy-original-supply-conserved')
run((fix/'negative.sql').read_text(),'legacy-direct-negative-controls')
run((fix/'positive-restore-terms.sql').read_text(),'legacy-original-local-terms-restored')
resolution_sql=(fix/'resolution.sql').read_text()
start=resolution_sql.index('DO $$ DECLARE c record;state jsonb;original_header')
run(resolution_sql[:start]+'COMMIT;\n','legacy-resolution-late-fault')
end=resolution_sql.index("SELECT 'LEGACY_FEE_NATIVE_RESOLVED='")
case_sql=resolution_sql[start:end].replace('SELECT * FROM legacy_fee_fixture.cases ORDER BY tournament_id',"SELECT * FROM legacy_fee_fixture.cases WHERE tournament_id=current_setting('legacy_fee_fixture.case_id')::uuid")+'COMMIT;\n'
for event in original_case_ids:
 run(claims+"SET LOCAL legacy_fee_fixture.case_id='"+event+"';\n"+case_sql,'legacy-resolution-case-'+event)
run(claims+resolution_sql[end:],'legacy-original-resolution-qualification')

run("""
SELECT legacy_fee_fixture.assert(
 (SELECT count(*)=3 AND sum(e.fee_balance)=324 AND sum(e.prize_balance+e.bounty_balance)=0
 FROM public.tournament_escrow e JOIN legacy_fee_fixture.pko_expected_sources s USING(tournament_id))
 AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_custody_resolutions r
 JOIN legacy_fee_fixture.pko_expected_sources s USING(tournament_id))
 AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions r
 JOIN legacy_fee_fixture.pko_expected_sources s USING(tournament_id)),
 'Three PKOs remain final for players with exact324 retained and no invented recognition');
SELECT legacy_fee_fixture.assert(
 (SELECT jsonb_agg(to_jsonb(b) ORDER BY b.tournament_id,b.rake_record_id)
 FROM public.accounting_tournament_fee_batches b JOIN legacy_fee_fixture.pko_expected_sources s USING(tournament_id))
 IS NOT DISTINCT FROM (SELECT document->'batches' FROM legacy_fee_fixture.pko_original_canonical)
 AND (SELECT jsonb_agg(to_jsonb(f) ORDER BY f.tournament_id,f.id)
 FROM public.accounting_tournament_fee_sources f JOIN legacy_fee_fixture.pko_expected_sources s USING(tournament_id))
 IS NOT DISTINCT FROM (SELECT document->'sources' FROM legacy_fee_fixture.pko_original_canonical),
 'Player finality and five independent resolutions preserve all109 original PKO source documents');
""",'legacy-final-pko-custody-proof')
subprocess.run(['node',str(fix/'verify-native-receipts.mjs'),str(root),str(out)],check=True)
def capture(query,label):
 value=subprocess.check_output(cmd+['-At','-c',query],text=True)
 (out/(label+'.json')).write_text(json.dumps(json.loads(value),indent=2)+'\n')
function_names=sorted(set([x['identity'].split('(')[0] for x in access]+
 json.loads((root/'scripts/ci/schema-manifest.d/union-legacy-fee-finality.json').read_text())['functions']))
capture("SELECT jsonb_agg(to_jsonb(x) ORDER BY identity) FROM (SELECT p.oid::regprocedure::text identity,pg_get_functiondef(p.oid) definition,md5(pg_get_functiondef(p.oid)) definition_md5,md5(p.prosrc) source_md5,pg_get_userbyid(p.proowner) owner,p.proacl::text acl,p.proconfig config,p.prosecdef security_definer FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN("+','.join("'"+x+"'" for x in function_names)+"))x",'legacy-qualified-functions')
capture("""SELECT jsonb_agg(jsonb_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner),
 'acl',c.relacl::text,'rls',c.relrowsecurity,
 'columns',(SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT a.attname,format_type(a.atttypid,a.atttypmod) type,a.attnotnull,pg_get_expr(d.adbin,d.adrelid) default_expr FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum)x),
 'constraints',(SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT conname,pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid=c.oid ORDER BY conname)x),
 'triggers',(SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT tgname,tgenabled,pg_get_triggerdef(oid) definition FROM pg_trigger WHERE tgrelid=c.oid AND NOT tgisinternal ORDER BY tgname)x)) ORDER BY c.relname)
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
 AND c.relname IN('accounting_tournament_fee_custody_obligations','accounting_tournament_fee_custody_resolutions','accounting_tournament_fee_custody_capture_admissions','tournament_terminal_settlements')""",'legacy-qualified-relations')


verify_binding()
(out/'legacy-tested-binding.json').write_text(json.dumps(binding['repository_files'],indent=2)+'\n')
import re
count=sum(len(re.findall(r'NOTICE:\s+PASS ',p.read_text())) for p in out.glob('legacy-*.log'))
if count!=binding['expected_assertion_executions']:
 raise AssertionError(f'Legacy fee assertions expected {binding["expected_assertion_executions"]}, observed {count}')
(out/'legacy-native-evidence.json').write_text(json.dumps({'status':'passed','assertions':count,
 'first_close_races':2,'original_events':8,'original_fee_custody':'689.00',
 'remaining_pko_custody_after_five_synthetic_resolutions':'324.00',
 'unchanged_original_pko_sources':109,'actual_decoder_receipts':13,
 'late_preimage_schema_acl_rollback':True,'source_binding':'legacy-tested-binding.json',
 'limitations':'Synthetic standings and original-local terms qualify behavior only; no production outcome or historical agreement claim.'},indent=2)+'\n')
print(f'PASS {count} original player-finality assertions, two backend races and13 actual native decoder receipts',flush=True)
