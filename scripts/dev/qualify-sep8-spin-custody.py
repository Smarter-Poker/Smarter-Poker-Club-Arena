#!/usr/bin/env python3
"""Exact September 8 Spin continuation in the maintained native runner."""
import hashlib,json,subprocess,sys
from pathlib import Path
root=Path(__file__).resolve().parents[2]
psql,socket,port,database,out=sys.argv[1:];out=Path(out);out.mkdir(parents=True,exist_ok=True)
fix=root/'tests/fixtures/sep8-spin-custody'
binding=json.loads((fix/'source-binding.json').read_text())
def verify_binding():
 for relative,expected in binding['repository_files'].items():
  if hashlib.sha256((root/relative).read_bytes()).hexdigest()!=expected:
   raise AssertionError('Unreviewed original Spin source drift: '+relative)
verify_binding()
if database!='postgres' or not socket.startswith('/'):raise AssertionError('Private native fixture required')
cmd=[psql,'-X','-q','-v','ON_ERROR_STOP=1','-U','postgres','-h',socket,'-p',port,'-d',database,'-c',"SET timezone='UTC';SET statement_timeout='60s';SET lock_timeout='2s';"]
def run(sql,label):
 p=out/(label+'.sql');p.write_text(sql)
 r=subprocess.run(cmd+['-f',str(p)],capture_output=True,text=True)
 (out/(label+'.log')).write_text(r.stdout+r.stderr)
 if r.returncode:raise AssertionError(label+': '+r.stderr[-5000:])
 print('PASS '+label,flush=True)
# Use the maintained exact captured entry-receipt schema/ACL composer. Breakfast
# declares this original row type even when the five Spin branch does not reprice.
sys.path.insert(0,str(root/'scripts/ci'))
from satellite_qualifier_fixture import table_sql,function_sql,exact_table_sql,ident
satellite=root/'scripts/ci/fixtures/satellite-qualifiers'
entry=json.loads((satellite/'current-entry-close-table-20260917.json').read_text())['tables'][0]
entry_sql='BEGIN;\n'+table_sql(entry)+'\n'
for constraint in entry['constraints']:
 if constraint['type']=='f':entry_sql+='ALTER TABLE public.'+ident(entry['name'])+' ADD CONSTRAINT '+ident(constraint['name'])+' '+constraint['definition']+';\n'
for name in ['current-entry-close-functions-20260917.json','current-committed-terms-20260917.json']:
 entry_sql+='\n'.join(function_sql(r) for r in json.loads((satellite/name).read_text())['rows'])+'\n'
for trigger in entry['triggers']:
 if trigger['enabled']!='O':raise AssertionError('Captured entry-receipt guard differs')
 entry_sql+=trigger['definition']+';\n'
entry_sql+=exact_table_sql(entry)+'COMMIT;\n'
run(entry_sql,'sep8-original-entry-receipt-schema')
# Exact production physical guards and their two private dependencies. Reuse
# the maintained semantic table/ACL verifier with explicit private qualification.
physical=json.loads((fix/'physical-catalog.json').read_text())
physical_sql='BEGIN;\n'
def private_relation(sql,name):
 return sql.replace('public.'+ident(name),'smarter_private.'+ident(name)).replace('public.'+name,'smarter_private.'+name)
for rows,private in [(physical['tables'],False),(physical['private_tables'],True)]:
 for row in rows:
  sql=table_sql(row)
  physical_sql+=(private_relation(sql,row['name']) if private else sql)+'\n'
for captured in physical['trigger_functions']:
 row=dict(captured);schema,row['signature']=row['signature'].split('.',1)
 if schema!='smarter_private':raise AssertionError('Unexpected physical trigger schema')
 physical_sql+=function_sql(row).replace('public.'+row['signature'],schema+'.'+row['signature'])+'\n'
for rows,private in [(physical['tables'],False),(physical['private_tables'],True)]:
 for row in rows:
  schema='smarter_private' if private else 'public'
  for constraint in row['constraints'] or []:
   if constraint['type']=='f':physical_sql+='ALTER TABLE '+schema+'.'+ident(row['name'])+' ADD CONSTRAINT '+ident(constraint['name'])+' '+constraint['definition']+';\n'
  for trigger in row['triggers'] or []:
   if trigger['enabled']!='O':raise AssertionError('Captured physical trigger not enabled')
   physical_sql+=trigger['definition']+';\n'
  sql=exact_table_sql(row)
  physical_sql+=(private_relation(sql,row['name']) if private else sql)+'\n'
physical_sql+='COMMIT;\n'
run(physical_sql,'sep8-original-physical-schema')
run((fix/'breakfast-bootstrap.sql').read_text(),'sep8-breakfast-captured-dependencies')
run((fix/'breakfast-predecessor.sql').read_text(),'sep8-installed-breakfast-predecessor')
# These two recorded metadata columns postdate the financial baseline. Reuse
# their exact maintained column, constraint and unique-index clauses. Their
# INSERT/identity-column triggers do not fire in the terminal status transition.
format_source=(root/'supabase/migrations/20260917060000_mtt_persisted_format_preparation.sql').read_text()
format_columns=format_source[format_source.index('ALTER TABLE public.tournaments ADD COLUMN format_contract text;'):format_source.index('-- Metadata qualification')]
restart_source=(root/'supabase/migrations/20260917070000_mtt_dual_satellite_restart_preparation.sql').read_text()
restart_columns=restart_source[restart_source.index('ALTER TABLE public.tournaments ADD COLUMN restart_source_id uuid'):restart_source.index('CREATE FUNCTION public.fn_ca_guard_tournament_restart_source()')]
run('BEGIN;\n'+format_columns+restart_columns+'COMMIT;\n','sep8-original-tournament-metadata-columns')
current_tournament=json.loads((fix/'tournament-catalog.json').read_text())['tables'][0]
checks=[r for r in current_tournament['constraints'] if r['name'] in ['tournament_prize_math_contract_valid','tournaments_recorded_entry_capacity']]
if len(checks)!=2 or any(not r['validated'] or r['type']!='c' for r in checks):raise AssertionError('Current format checks differ')
check_sql='BEGIN;\n'
for row in checks:
 check_sql+='ALTER TABLE public.tournaments DROP CONSTRAINT IF EXISTS '+ident(row['name'])+';\nALTER TABLE public.tournaments ADD CONSTRAINT '+ident(row['name'])+' '+row['definition']+';\n'
run(check_sql+'COMMIT;\n','sep8-current-format-checks')
raw=(fix/'originals.json').read_text().strip();json.loads(raw)
run('SELECT $sep8_raw$'+raw+'$sep8_raw$ AS sep8_originals \\gset\n'+(fix/'setup.sql').read_text(),'sep8-original-scene')
subprocess.run([sys.executable,str(fix/'build-candidate.py'),'--check'],check=True)
candidate=next((root/'supabase/migrations').glob('20260918095320*.sql')).read_text()
# A drift in the last patched definition must roll back the new helper and
# every earlier patch, including ACLs. No successful migration is replayed.
run("ALTER FUNCTION public.fn_ca_tournament_terminal_receipt(uuid,uuid) SET statement_timeout='31s';",'sep8-late-preimage-drift')
dump=[str(Path(psql).with_name('pg_dump')),'--schema-only','-U','postgres','-h',socket,'-p',port,'-d',database]
def schema():return '\n'.join(x for x in subprocess.check_output(dump,text=True).splitlines() if not x.startswith(('\\restrict ','\\unrestrict ')))
before=schema();p=out/'sep8-late-preimage-refusal.sql';p.write_text(candidate)
r=subprocess.run(cmd+['-f',str(p)],capture_output=True,text=True);(out/'sep8-late-preimage-refusal.log').write_text(r.stdout+r.stderr)
if r.returncode==0 or 'sep8 Spin predecessor changed: fn_ca_tournament_terminal_receipt' not in r.stderr or schema()!=before:raise AssertionError('Late exact preimage refusal failed schema/ACL atomic rollback')
preimage=next(r['definition'] for r in json.loads((fix/'predecessor-functions.json').read_text()) if r['identity']=='fn_ca_tournament_terminal_receipt(uuid,uuid)')
run(preimage+';','sep8-preimage-restored')
run(candidate,'sep8-successor')
run((fix/'proof.sql').read_text(),'sep8-original-proof')
names=[r['identity'].split('(')[0] for r in json.loads((fix/'predecessor-functions.json').read_text())]+['fn_ca_sep8_spin_original_fee_proof','fn_complete_sep8_spin_original_standings']
catalog_query="SELECT jsonb_agg(to_jsonb(x) ORDER BY identity) FROM (SELECT p.oid::regprocedure::text identity,pg_get_functiondef(p.oid) definition,md5(pg_get_functiondef(p.oid)) definition_md5,md5(p.prosrc) source_md5,pg_get_userbyid(p.proowner) owner,p.proacl::text acl,p.proconfig config FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN("+','.join("'"+n+"'" for n in names)+"))x"
value=subprocess.check_output(cmd+['-At','-c',catalog_query],text=True)
(out/'sep8-independent-native-functions.json').write_text(json.dumps(json.loads(value),indent=2)+'\n')
authority=next((root/'supabase/migrations').glob('20260918122532*.sql'))
seed=fix/'g8-original-standings-seed.sql'
if not authority.exists() or not seed.exists():
 raise AssertionError('Source remains unqualified: original G8 standings authority and joined payer fixture required')
subprocess.run([sys.executable,str(fix/'build-standings-candidate.py'),'--check'],check=True)
run(authority.read_text(),'sep8-g8-original-authority')
run((fix/'original-physical-support.sql').read_text(),'sep8-original-physical-support')
try:
 run(seed.read_text(),'sep8-g8-original-standings')
except AssertionError:
 diagnostic="SELECT jsonb_agg(jsonb_build_object('id',s.tournament_id,'expected',s.document,'actual',smarter_private.spin_original_current_case(s.tournament_id))) FROM sep8_spin_fixture.standings_sources s"
 value=subprocess.check_output(cmd+['-At','-c',diagnostic],text=True)
 (out/'sep8-original-seed-diagnostic.json').write_text(value)
 raise
# Qualify the additive installed reader before the unchanged real payer path.
import runpy
reader_proof=runpy.run_path(str(fix/'qualify-current-case-reader.py'))['qualify'](root,fix,out,cmd,run,schema)
lane_proof=runpy.run_path(str(fix/'qualify-legacy-custody-lane.py'))['qualify'](root,fix,out,cmd,run,schema)
clock_proof=runpy.run_path(str(fix/'qualify-clock-comparison.py'))['qualify'](root,fix,out,cmd,run,schema)
run((fix/'standings-negative.sql').read_text(),'sep8-standings-negative')
run((fix/'late-fault.sql').read_text(),'sep8-late-terminal-fault')
# Two first-completion backends for one Union and one standalone original event.
import os,time
interactive=[psql,'-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-h',socket,'-p',port,'-d',database]
for event in ['199a71a9-f364-4e90-a3ba-3cdcfb7755bc','b60c7add-6b38-4549-b091-601f64d118a0']:
 log=(out/('sep8-concurrent-lock-'+event+'.log')).open('w')
 locker=subprocess.Popen(interactive,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True);closers=[]
 try:
  locker.stdin.write("BEGIN;SELECT 1 FROM public.tournaments WHERE id='"+event+"' FOR NO KEY UPDATE;SELECT 'LOCK_READY';\n");locker.stdin.flush()
  while True:
   line=locker.stdout.readline()
   if not line:raise AssertionError('Original owner did not acquire event lock')
   if line.strip()=='LOCK_READY':break
  query="SET timezone='UTC';SET request.jwt.claims='{\"role\":\"service_role\"}';SELECT public.fn_complete_sep8_spin_original_standings(s.operation_id,s.expected) FROM sep8_spin_fixture.standings_cases s WHERE s.tournament_id='"+event+"';"
  competing=event.startswith('b60c')
  queries=[query,query.replace('s.operation_id,','md5(s.operation_id::text)::uuid,') if competing else query]
  closers=[subprocess.Popen(interactive+['-c',q],env=dict(os.environ,PGAPPNAME='sep8-native-close-'+str(i)),stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) for i,q in enumerate(queries)]
  deadline=time.monotonic()+10
  while True:
   waiting=subprocess.check_output(cmd+['-At','-c',"SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'sep8-native-close-%' AND wait_event_type='Lock';"],text=True).strip()
   if waiting=='2':break
   if time.monotonic()>deadline or any(p.poll() is not None for p in closers):raise AssertionError('Both original completions must reach the owning lock')
   time.sleep(.02)
  locker.communicate('COMMIT;\n',timeout=10);results=[];refused=0
  for i,p in enumerate(closers):
   stdout,stderr=p.communicate(timeout=45);(out/('sep8-concurrent-close-'+event+'-'+str(i)+'.log')).write_text(stdout+stderr)
   if p.returncode:
    if competing and 'SPIN_ORIGINAL_REPLAY_MISMATCH' in stderr:refused+=1;continue
    raise AssertionError(stdout+stderr)
   results.extend(json.loads(line) for line in stdout.splitlines() if line.startswith('{'))
  if competing:
   if len(results)!=1 or refused!=1:raise AssertionError('Competing operation must refuse exactly one request')
   run("UPDATE sep8_spin_fixture.standings_cases s SET operation_id=r.operation_id FROM smarter_private.spin_original_standings r WHERE s.tournament_id=r.tournament_id AND s.tournament_id='"+event+"';",'sep8-retain-committed-operation')
  elif len(results)!=2 or results[0]!=results[1]:raise AssertionError('Same-operation original completions disagree')
  if results[0].get('accounting_state')!='fee_custody_unresolved':raise AssertionError('Original completion accounting state differs')
 finally:
  for p in [locker]+closers:
   if p.poll() is None:p.kill();p.wait()
  log.close()
events=subprocess.check_output(cmd+['-At','-c','SELECT tournament_id FROM sep8_spin_fixture.cases ORDER BY tournament_id'],text=True).splitlines()
if len(events)!=5:raise AssertionError('Exactly five original transactions required')
for event in events:
 run("SET sep8_fixture.event_id='"+event+"';\n"+(fix/'player-finality.sql').read_text(),'sep8-player-finality-'+event)
run("SELECT 'SEP8_NATIVE_RECEIPTS='||jsonb_agg(public.fn_ca_tournament_terminal_receipt(c.tournament_id,c.winner_id) ORDER BY c.tournament_id)::text FROM sep8_spin_fixture.cases c;",'sep8-player-finality')
run((fix/'terminal-negative.sql').read_text(),'sep8-terminal-negative')
run((fix/'restore-synthetic-terms.sql').read_text(),'sep8-local-synthetic-terms')
run((fix/'union-journal-guard.sql').read_text(),'sep8-union-journal-guards')
run((fix/'resolution-late-fault.sql').read_text(),'sep8-late-recognition-fault')
for event in events:
 run("SET sep8_fixture.event_id='"+event+"';\n"+(fix/'resolution.sql').read_text(),'sep8-original-resolution-'+event)
run("SELECT 'SEP8_NATIVE_RESOLVED='||jsonb_agg(public.fn_ca_tournament_terminal_receipt(c.tournament_id,c.winner_id) ORDER BY c.tournament_id)::text FROM sep8_spin_fixture.cases c;",'sep8-original-resolution')
run((fix/'union-journal-after.sql').read_text(),'sep8-union-journal-finality')
subprocess.run(['node',str(root/'tests/fixtures/legacy-fee-finality/verify-native-receipts.mjs'),str(root),str(out),'--sep8-spin-custody'],check=True)
value=subprocess.check_output(cmd+['-At','-c',catalog_query],text=True)
(out/'sep8-qualified-functions.json').write_text(json.dumps(json.loads(value),indent=2)+'\n')
witness_query="SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT p.oid::regprocedure::text identity,pg_get_functiondef(p.oid) definition,md5(pg_get_functiondef(p.oid)) definition_md5,md5(p.prosrc) source_md5,pg_get_userbyid(p.proowner) owner,p.proacl::text acl,p.proconfig config FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='smarter_private' AND p.proname LIKE 'spin_original_%')x"
value=subprocess.check_output(cmd+['-At','-c',witness_query],text=True)
(out/'sep8-qualified-private-functions.json').write_text(json.dumps(json.loads(value),indent=2)+'\n')
private_dump=subprocess.check_output([str(Path(psql).with_name('pg_dump')),'--schema-only','--table=smarter_private.spin_original_standings','-U','postgres','-h',socket,'-p',port,'-d',database],text=True)
(out/'sep8-qualified-private-table.sql').write_text('\n'.join(line for line in private_dump.splitlines() if not line.startswith(('\\restrict ','\\unrestrict ')))+'\n')
readback=subprocess.check_output(cmd+['-At','-f',str(fix/'final-readback.sql')],text=True)
(out/'sep8-final-readback.json').write_text(readback)
verify_binding()
(out/'sep8-tested-binding.json').write_text(json.dumps(binding['repository_files'],indent=2)+'\n')
import re
count=sum(len(re.findall(r'NOTICE:\s+PASS ',p.read_text())) for p in out.glob('sep8-*.log'))
(out/'sep8-native-evidence.json').write_text(json.dumps({'status':'passed','assertion_notices':count,'events':5,
 'original_raw_sources':5,'recognized_contributors':15,'original_fee_total':'11.52','original_prize_total':'96',
 'first_close_races':2,'actual_decoder_receipts':10,'late_preimage_schema_acl_rollback':True,'current_case_reader':reader_proof,'legacy_custody_lane':lane_proof,'clock_comparison':clock_proof,
 'source_binding':'sep8-tested-binding.json','limitations':'Original standings and financial records are retained; account support and restored original agreements are explicitly synthetic. No production history or outcome is certified.'},indent=2)+'\n')
print('PASS exact five original Spin payer, custody and canonical continuation',flush=True)
