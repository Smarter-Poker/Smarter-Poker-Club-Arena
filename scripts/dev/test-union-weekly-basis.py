#!/usr/bin/env python3
"""Private native qualification of original weekly P&L and existing payer wiring."""
import hashlib,importlib.util,json,os,re,subprocess,sys,tempfile
from pathlib import Path
root=Path(__file__).resolve().parents[2]
pg=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
binding=json.loads((root/'tests/fixtures/union-weekly-basis/source-binding.json').read_text())
for relative,expected in binding['repository_files'].items():
 actual=hashlib.sha256((root/relative).read_bytes()).hexdigest()
 if actual!=expected:raise AssertionError('Weekly original source binding mismatch: '+relative)
print('PASS exact-source-binding',flush=True)
base=Path(tempfile.mkdtemp(prefix='uw.',dir=os.environ.get('ACCOUNTING_FIXTURE_PARENT','/tmp')))
socket=base/'s';socket.mkdir();port='55531'
started=False
try:
 # A UTF-8 locale inherited from the shell makes Apple's libc resolve it on a
 # helper thread, and the postmaster refuses to start ('postmaster became
 # multithreaded during startup'). The cluster is already --no-locale/UTF8, so
 # declare the C locale for its own lifecycle commands rather than depending on
 # whatever the caller exported.
 native=dict(os.environ,LC_ALL='C',LANG='C')
 subprocess.run([str(pg/'initdb'),'-D',str(base/'data'),'-U','postgres','-A','trust','--no-locale','-E','UTF8'],check=True,capture_output=True,env=native)
 subprocess.run([str(pg/'pg_ctl'),'-D',str(base/'data'),'-l',str(base/'server.log'),'-o',f"-k {socket} -p {port} -h ''",'-w','start'],check=True,capture_output=True,env=native);started=True
 def run(sql,label):
  path=base/(label+'.sql');path.write_text(sql)
  result=subprocess.run([str(pg/'psql'),'-X','-q','-v','ON_ERROR_STOP=1','-U','postgres','-h',str(socket),'-p',port,'-d','postgres','-f',str(path)],capture_output=True,text=True)
  (base/(label+'.log')).write_text(result.stdout+result.stderr)
  if result.returncode: raise AssertionError(label+': '+result.stderr[-5000:])
  print('PASS '+label,flush=True)
 # Full captured table/function/constraint contracts, without unrelated triggers
 # or policies. Applicable real financial triggers are explicitly retained below.
 schema=(root/'tests/fixtures/full-weekly-accounting/schema.sql').read_text()
 schema='\n'.join(line for line in schema.splitlines() if not line.startswith('CREATE TRIGGER ') and not re.match(r'ALTER TABLE .* (?:ENABLE|DISABLE) TRIGGER ',line))
 run(schema,'captured-contracts')
 extra='\n'.join(line.replace('CREATE TABLE ','CREATE TABLE IF NOT EXISTS ',1) for line in (root/'tests/fixtures/cash-participant-funding/bootstrap.sql').read_text().splitlines() if line.startswith('CREATE TABLE '))
 run(extra,'missing-cash-contracts')
 run((root/'tests/fixtures/union-weekly-basis/accepted-document-relations.sql').read_text(),'accepted-document-relations')
 run('SET check_function_bodies=off;\n'+'\n'.join(x['definition'] for x in json.loads((root/'tests/fixtures/union-weekly-basis/captured-document-dependencies.json').read_text())),'accepted-document-dependencies')
 run('SET check_function_bodies=off;\n'+'\n'.join(x['definition'] for x in json.loads((root/'tests/fixtures/union-weekly-basis/captured-close-dependencies.json').read_text())),'accepted-close-dependencies')
 run('SET check_function_bodies=off;\n'+'\n'.join(x['definition'] for x in json.loads((root/'tests/fixtures/union-weekly-basis/captured-rake-dependencies.json').read_text())),'accepted-rake-dependencies')
 # Exact installed prerequisite function bodies and ACLs, never modeled money.
 rows=[]
 for name in ['captured-preimages.json','captured-hand-preimages.json','captured-integration-preimages.json','captured-reader-preimages.json']:
  rows+=json.loads((root/'tests/fixtures/cash-participant-funding'/name).read_text())
 sql=''
 for row in rows:
  sql+=row['definition']+';\nREVOKE ALL ON FUNCTION public.'+row['signature']+' FROM PUBLIC,anon,authenticated,service_role;\n'
  if 'service_role=' in row['acl']:sql+='GRANT EXECUTE ON FUNCTION public.'+row['signature']+' TO service_role;\n'
 run(sql,'cash-original-preimages')
 run('SET check_function_bodies=off;\n'+'\n'.join(x['definition']+';' for x in json.loads((root/'tests/fixtures/union-weekly-basis/captured-cash-dependencies.json').read_text())),'cash-original-dependencies')
 for version in ['20260917230925','20260917232243']:
  run(next((root/'supabase/migrations').glob(version+'*.sql')).read_text(),version)
 # The sealed report definition supplies the ECO successor precondition.
 s=(root/'supabase/accounting/weekly-v3/components/20260914150848_union_pnl_evidence_is_distinct_from_posted_chip_payments.sql').read_text()
 report=s[s.index('CREATE FUNCTION public.fn_union_pnl_evidence_report'):s.index('REVOKE ALL ON FUNCTION public.fn_pnl_evidence_cents')]
 run(report.replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION'),'sealed-report-preimage')
 run(next((root/'supabase/migrations').glob('20260917230515*.sql')).read_text(),'eco-original-terms')
 # Real original tournament evidence owners; original entry/prize behavior is
 # qualified in the existing registration funding fixture, then composed here.
 run((root/'tests/fixtures/tournament-accounting-provenance/new-authority.sql').read_text(),'tournament-original-evidence')
 spec=importlib.util.spec_from_file_location('tournament_candidate',root/'tests/fixtures/tournament-accounting-provenance/build-candidate.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 deps=json.loads((root/'tests/fixtures/tournament-accounting-provenance/captured-dependencies.json').read_text())
 run('SET check_function_bodies=off;\n'+';\n'.join(r['definition'] for r in deps)+';\n'+';\n'.join(module.candidate(r) for r in module.rows)+';','tournament-original-producers')
 run('\n'.join(x['definition']+';' for x in json.loads((root/'tests/fixtures/union-weekly-basis/captured-payer-preimages.json').read_text())),'installed-payer-preimages')
 quality=(root/'supabase/accounting/weekly-v3/components/20260914153000_uncertified_union_pnl_blocks_close_and_squareup.sql').read_text()
 quality=quality[quality.index('CREATE FUNCTION public.fn_union_pnl_close_quality'):quality.index('INSERT INTO public.ca_money_rpc_registry')]
 run(quality.replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION'),'original-qualification-gate')
 run('SET check_function_bodies=off;\n'+'\n'.join(x['definition']+';' for x in json.loads((root/'tests/fixtures/union-weekly-basis/captured-coordinator-preimages.json').read_text())),'installed-coordinator-preimages')
 run('\n'.join(x['definition']+';' for x in json.loads((root/'tests/fixtures/union-weekly-basis/captured-cascade-preimage.json').read_text())),'installed-cascade-preimage')
 run('SET check_function_bodies=off;\n'+(root/'tests/fixtures/union-weekly-basis/captured-refund-dependencies.sql').read_text(),'original-refund-owner')
 horse=json.loads((root/'tests/fixtures/tournament-accounting-provenance/captured-horse-preimages.json').read_text())
 original=next(r for r in horse if r['signature'].startswith('fn_register_horse_for_tournament_before_maintenance_gate('))
 run(original['definition']+'; REVOKE ALL ON FUNCTION public.'+original['signature']+' FROM PUBLIC,anon,authenticated,service_role;','original-horse-entry-predecessor')
 run(next((root/'supabase/migrations').glob('20260918002654*.sql')).read_text(),'installed-horse-entry-successor')
 run((root/'tests/fixtures/union-weekly-basis/bootstrap.sql').read_text(),'weekly-native-dependencies')
 run(next((root/'supabase/migrations').glob('20260917233148*.sql')).read_text(),'original-inventory')
 # Exact currently installed definitions, owners and ACLs bind every replaced
 # predecessor, including the immutable installed ECO and inventory successors.
 rows=json.loads((root/'tests/fixtures/union-weekly-basis/captured-installed-preconditions.json').read_text())
 sql=''
 for row in rows:
  signature='public.'+row['signature']
  sql+=row['definition']+';\nREVOKE ALL ON FUNCTION '+signature+' FROM PUBLIC,anon,authenticated,service_role;\n'
  for role in ['authenticated','service_role']:
   if role+'=' in row['acl']:sql+='GRANT EXECUTE ON FUNCTION '+signature+' TO '+role+';\n'
  sql+='ALTER FUNCTION '+signature+' OWNER TO '+row['owner']+';\n'
 run(sql,'exact-installed-weekly-predecessors')
 run(next((root/'supabase/migrations').glob('20260917234315*.sql')).read_text(),'weekly-qualified-source')
 # The club settlement floor bounds standalone discovery. Its own preimage
 # assertions name this exact installed base, so it is applied here, while the
 # predecessors are still pristine. Its fixture runs last, below.
 run(next((root/'supabase/migrations').glob('20260920232503*.sql')).read_text(),'club-settlement-floor-source')
 # A rakeback payout leg cannot be written without its source-linked document
 # and its settlement/run identity. Installed here, with the predecessors still
 # pristine, so every regression below - including the real raked weekly close -
 # runs with the constraint armed.
 run(next((root/'supabase/migrations').glob('20260921022924*.sql')).read_text(),'rakeback-payout-document-source')
 # Export the exact installed candidate before any disposable test calendar or
 # fault injection. These are installation/readback contracts, not live proof.
 migration=next((root/'supabase/migrations').glob('20260917234315*.sql')).read_text()
 names=sorted(set(re.findall(r'CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)',migration)+[r['signature'].split('(')[0] for r in rows]))
 def capture(query,label):
  output=subprocess.check_output([str(pg/'psql'),'-X','-A','-t','-U','postgres','-h',str(socket),'-p',port,'-d','postgres','-c',query],text=True)
  (base/(label+'.json')).write_text(json.dumps(json.loads(output),indent=2)+'\n')
 names_sql=','.join("'"+name+"'" for name in names)
 capture("SELECT jsonb_agg(to_jsonb(x) ORDER BY signature) FROM (SELECT p.oid::regprocedure::text AS signature,pg_get_functiondef(p.oid) AS definition,md5(pg_get_functiondef(p.oid)) AS definition_md5,md5(p.prosrc) AS body_md5,pg_get_userbyid(p.proowner) AS owner,p.proacl::text AS acl,p.prosecdef AS security_definer,p.proconfig AS configuration FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN("+names_sql+")) x",'candidate-functions')
 capture("SELECT jsonb_build_object('columns',(SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,pg_get_expr(d.adbin,d.adrelid) AS default_expr FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped AND (c.relname LIKE 'union_pnl_%' OR a.attname='transaction_id') ORDER BY c.relname,a.attnum) x),'triggers',(SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT t.tgname,c.relname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND (t.tgname LIKE '%pnl%' OR t.tgname LIKE '%receipt_frame%') ORDER BY c.relname,t.tgname) x))",'candidate-relations')
 subprocess.run([str(pg/'pg_dump'),'-U','postgres','-h',str(socket),'-p',port,'-d','postgres','--schema-only','-f',str(base/'candidate-schema.sql')],check=True,capture_output=True)
 (base/'tested-source-binding.json').write_text(json.dumps(binding,indent=2)+'\n')
 print('PASS candidate-catalog-export',flush=True)
 def qualify_moves():
  result=subprocess.run(['python3',str(root/'scripts/dev/qualify-cash-move-funding.py'),str(pg/'psql'),str(socket),port,str(base)],capture_output=True,text=True)
  (base/'cash-move-qualification.log').write_text(result.stdout+result.stderr)
  if result.returncode:raise AssertionError(result.stdout+result.stderr)
  print(result.stdout,flush=True)
 # Clone the pristine installed candidate before calendar and fault scenarios
 # mutate functions/defaults. Full and focused modes use the identical input.
 qualify_moves()
 if '--cash-move-only' in sys.argv:
  sys.exit(0)
 run((root/'tests/fixtures/union-weekly-basis/regression.sql').read_text(),'weekly-regression')
 run((root/'tests/fixtures/union-weekly-basis/negative-regression.sql').read_text(),'negative-regression')
 run((root/'tests/fixtures/union-weekly-basis/payment-regression.sql').read_text(),'payment-regression')
 run((root/'tests/fixtures/union-weekly-basis/cascade-regression.sql').read_text(),'cascade-regression')
 result=subprocess.run(['python3',str(root/'tests/fixtures/union-weekly-basis/concurrency.py'),str(pg/'psql'),str(socket),port],capture_output=True,text=True)
 (base/'concurrency.log').write_text(result.stdout+result.stderr)
 if result.returncode:raise AssertionError(result.stdout+result.stderr)
 print(result.stdout,flush=True)
 run((root/'tests/fixtures/union-weekly-basis/tournament-regression.sql').read_text(),'tournament-regression')
 run((root/'tests/fixtures/union-weekly-basis/raked-regression.sql').read_text(),'raked-regression')
 # The refusals, and the proof that the accepted weekly payout above passed the
 # same guard. Every probe rolls itself back; the money book is fingerprinted
 # before and after.
 run((root/'tests/fixtures/rakeback-payout-document/regression.sql').read_text(),'rakeback-payout-document-regression')
 result=subprocess.run(['python3',str(root/'scripts/dev/qualify-final-atomic-receipt.py'),str(pg/'psql'),str(socket),port,str(base)],capture_output=True,text=True)
 (base/'final-atomic-qualification.log').write_text(result.stdout+result.stderr)
 if result.returncode:raise AssertionError(result.stdout+result.stderr)
 print(result.stdout,flush=True)
 result=subprocess.run(['python3',str(root/'scripts/dev/qualify-installed-funding-guard-declaration.py'),str(pg/'psql'),str(socket),port,str(base)],capture_output=True,text=True)
 (base/'guard-declaration-qualification.log').write_text(result.stdout+result.stderr)
 if result.returncode:raise AssertionError(result.stdout+result.stderr)
 print(result.stdout,flush=True)
 # Last on this cluster: the club settlement floor. The declared clock seam and
 # the synthetic clubs are introduced only after every preceding assertion has
 # been made, so nothing above can be disturbed by them.
 run((root/'tests/fixtures/club-settlement-floor/load.sql').read_text(),'club-floor-clock-seam')
 run((root/'tests/fixtures/club-settlement-floor/seed.sql').read_text(),'club-floor-seed')
 run((root/'tests/fixtures/club-settlement-floor/regression.sql').read_text(),'club-floor-regression')
 # The club scope's discovery BEHAVIOUR, on this same cluster. The 2026-09-14
 # catalog capture above is union-only, so union_accounting_runs is first brought
 # to the exact installed union/standalone shape from its own reviewed source;
 # no coordinator, floor, payer or document definition is touched by that step.
 run((root/'tests/fixtures/club-settlement-floor-behaviour/installed-run-journal.sql').read_text(),'club-floor-run-journal')
 run((root/'tests/fixtures/club-settlement-floor-behaviour/seed.sql').read_text(),'club-floor-behaviour-seed')
 run((root/'tests/fixtures/club-settlement-floor-behaviour/regression.sql').read_text(),'club-floor-behaviour-regression')
finally:
 if started:subprocess.run([str(pg/'pg_ctl'),'-D',str(base/'data'),'-m','immediate','-w','stop'],check=True,capture_output=True,env=dict(os.environ,LC_ALL='C',LANG='C'))
 print('Evidence retained: '+str(base),flush=True)
