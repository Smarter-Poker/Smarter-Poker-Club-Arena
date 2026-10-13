#!/usr/bin/env python3
"""Isolated PG17: exact global selector outputs and original helper call bounds. No money RPC."""
import datetime
import select
import argparse,hashlib,json,os,pathlib,re,shutil,subprocess,sys,tempfile,time
P=pathlib.Path(__file__).resolve().parent;R=P.parents[2]
a=argparse.ArgumentParser();a.add_argument('--output',type=pathlib.Path,required=True);a.add_argument('--installer-only',action='store_true');args=a.parse_args();O=args.output.resolve();O.mkdir(parents=True,exist_ok=True)
for name,pin in json.loads((P/'source-binding.json').read_text())['files'].items():
 raw=(R/name).read_bytes()
 if len(raw)!=pin['bytes'] or hashlib.sha256(raw).hexdigest()!=pin['sha256']:raise RuntimeError('qualification source input differs: '+name)
if os.environ.get('DATABASE_URL'):raise RuntimeError('remote connection forbidden')
pg=pathlib.Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin' if sys.platform=='darwin' else str(pathlib.Path(shutil.which('psql')).parent)))
assert ' 17.' in subprocess.check_output([str(pg/'postgres'),'--version'],text=True)
base=pathlib.Path('/Volumes/SmarterWork/agent-work/weekly-first-week-aggregate-01a13099') if sys.platform=='darwin' else O.parent
C=pathlib.Path(tempfile.mkdtemp(prefix='native-',dir=base));S=C/'s';S.mkdir();port='56629';started=False;db='postgres'
def run(cmd,name,input=None,expect=None):
 q=subprocess.run([str(v) for v in cmd],input=input,text=True,capture_output=True,timeout=60)
 (O/(name+'.stdout')).write_text(q.stdout);(O/(name+'.stderr')).write_text(q.stderr)
 if input is not None:(O/(name+'.sql')).write_text(input)
 if expect:assert q.returncode!=0 and expect in q.stderr,(name,q.stderr[-2000:])
 else:assert q.returncode==0,(name,q.stderr[-3000:])
 return q.stdout.strip()
def sql(s,name,expect=None):return run([pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',S,'-p',port,'-U','postgres','-d',db],name,s,expect)
def aggregate(s):return 'SELECT COALESCE(jsonb_agg(to_jsonb(t)),\'[]\'::jsonb) FROM ('+s.rstrip().rstrip(';')+')t;'
def body(s):return s.split('$function$')[1]
try:
 run([pg/'initdb','-D',C/'d','-U','postgres','-A','trust','--no-locale','-E','UTF8'],'init')
 run([pg/'pg_ctl','-D',C/'d','-l',C/'server.log','-o',f"-k {S} -p {port} -h '' -c track_functions=all",'-w','start'],'start');started=True
 auth=json.loads((P/'authorities.json').read_text());auth['functions'].sort(key=lambda x:'fn_ca_launch_accounting_cutoff' not in x['signature']);forty=json.loads((R/'scripts/qualification/original-flow-eligibility/current-source40.json').read_text())
 week=next(x['definition'] for x in forty if x['signature'].startswith('public.fn_union_week_start('))
 if not args.installer_only:
  setup=(P/'selector-fixture.sql').read_text()+week+';'+(P/'calendar-support.sql').read_text()
  setup+='\n'.join(x['full_definition'].rstrip()+';' for x in auth['functions'])
  setup+='CREATE OR REPLACE VIEW public.accounting_payable_earning_sources WITH(security_invoker=true) AS '+auth['view']+';'
  sql(setup,'actual-selector-bootstrap')
  # Authentic103f error equivalence including accepted historical/DST/lower bounds.
  grid=json.loads(sql('SELECT version();','pg17-version') and sql((P/'calendar-grid.sql').read_text(),'calendar-edge-grid').splitlines()[0]);assert grid['mismatches']==0 and grid['same_errors']>0,grid
  sql("SELECT pg_get_functiondef('fn_union_week_start(timestamptz)'::regprocedure),md5(pg_get_functiondef('fn_union_week_start(timestamptz)'::regprocedure));",'authentic-calendar-full')

  queries={n:(P/(n+'-global-selector.sql')).read_text() for n in ['before','after']};results={}
  before="SELECT id FROM accounting_cash_rake_sources s WHERE coordinator_union_id IS NULL AND earned_at<'2026-10-12 07:00Z' AND public.fn_ca_launch_accounting_accepts(club_id,earned_at) ORDER BY id"
  after="WITH cash_clubs AS MATERIALIZED(SELECT DISTINCT club_id FROM accounting_cash_rake_sources WHERE coordinator_union_id IS NULL AND earned_at<'2026-10-12 07:00Z'),cash_cutoffs AS MATERIALIZED(SELECT club_id,fn_ca_launch_accounting_cutoff('club',club_id) cutoff FROM cash_clubs) SELECT s.id FROM accounting_cash_rake_sources s LEFT JOIN cash_cutoffs c ON c.club_id=s.club_id WHERE s.coordinator_union_id IS NULL AND s.earned_at<'2026-10-12 07:00Z' AND CASE WHEN c.cutoff IS NULL THEN true ELSE s.earned_at IS NOT NULL AND isfinite(s.earned_at) AND s.earned_at>=c.cutoff END ORDER BY s.id"
  cases={'no-cutoff':'','active-cutoff':"INSERT INTO ca_launch_accounting_boundaries VALUES('club',md5('club1')::uuid,'2026-10-01 07:00Z',NULL),('club',md5('club2')::uuid,'2026-09-28 07:00Z',NULL);",'undone-cutoff':"UPDATE ca_launch_accounting_boundaries SET undone_at=clock_timestamp();",'mixed-cutoff':"UPDATE ca_launch_accounting_boundaries SET undone_at=NULL WHERE scope_id=md5('club2')::uuid;"}
  for name,change in cases.items():
   if change:sql(change,name+'-input')
   b=json.loads(sql(aggregate(queries['before']),name+'-before'));a=json.loads(sql(aggregate(queries['after']),name+'-after'));assert b==a,(name,b,a);results[name]=a
   primitive_before=json.loads(sql(aggregate((P/'before-primitive.sql').read_text()),name+'-primitive-before'));primitive_after=json.loads(sql(aggregate((P/'after-primitive.sql').read_text()),name+'-primitive-after'));assert primitive_before==primitive_after
   prefix=(P/'before-primitive.sql').read_text().rsplit(' SELECT s.club_id,',1)[0];sql(prefix+" SELECT coalesce(jsonb_agg(to_jsonb(s)ORDER BY s.club_id,s.earned_at),'[]'::jsonb)FROM standalone_earned s;",name+'-accepted-earning-raw')
   left=json.loads(sql(aggregate(before),name+'-cash-before'));right=json.loads(sql(aggregate(after),name+'-cash-after'));assert left==right
   raw=json.loads(sql('SELECT jsonb_agg(to_jsonb(s)) FROM accounting_cash_rake_sources s;',name+'-independent-cash-inputs'))
   cuts={} if name in ['no-cutoff','undone-cutoff'] else {hashlib.md5(b'club2').hexdigest():'2026-09-28T07:00:00+00:00'}
   if name=='active-cutoff':cuts[hashlib.md5(b'club1').hexdigest()]='2026-10-01T07:00:00+00:00'
   expected=[];end=datetime.datetime.fromisoformat('2026-10-12T07:00:00+00:00')
   for r in raw:
    if r['coordinator_union_id'] is not None or r['earned_at'] is None or r['earned_at']=='infinity':continue
    t=None if r['earned_at']=='-infinity' else datetime.datetime.fromisoformat(r['earned_at'])
    cutoff=cuts.get((r['club_id'] or '').replace('-',''))
    if (t is None or t<end) and (cutoff is None or t is not None and t>=datetime.datetime.fromisoformat(cutoff)):expected.append({'id':r['id']})
   expected.sort(key=lambda r:r['id']);assert left==expected,(name,len(left),len(expected))
   results[name+'-independent_cash_count']=len(expected)
  # Exact accepted cash rows, including NULL clubs and infinity, independent of downstream week arithmetic.
  sql("INSERT INTO accounting_cash_rake_sources VALUES(md5('negative-infinity')::uuid,NULL,NULL,md5('club1')::uuid,NULL,NULL,'-infinity',1,'{}'),(md5('negative-infinity-active')::uuid,NULL,NULL,md5('club2')::uuid,NULL,NULL,'-infinity',1,'{}'),(md5('nullclub-infinity')::uuid,NULL,NULL,NULL,NULL,NULL,'-infinity',1,'{}');",'infinite-input')

  assert json.loads(sql(aggregate(before),'cash-null-infinite-before'))==json.loads(sql(aggregate(after),'cash-null-infinite-after'))
  sql("DELETE FROM accounting_cash_rake_sources WHERE id IN(md5('negative-infinity')::uuid,md5('negative-infinity-active')::uuid,md5('nullclub-infinity')::uuid);",'infinite-cleanup')
  counts={};plans={}
  for n in ['before','after']:
   sql('SELECT pg_stat_reset();',n+'-reset-counts')
   plans[n]=json.loads(sql('EXPLAIN(ANALYZE TRUE,BUFFERS TRUE,TIMING FALSE,FORMAT JSON) '+queries[n],n+'-actual-global-plan'))
   counts[n]=json.loads(sql("SELECT jsonb_object_agg(funcname,calls) FROM pg_stat_user_functions WHERE funcname IN('fn_ca_launch_accounting_accepts','fn_ca_launch_accounting_cutoff');",n+'-actual-helper-counts'))
  assert counts['before']['fn_ca_launch_accounting_cutoff']==counts['after']['fn_ca_launch_accounting_cutoff']==19,counts
  # Original tournament view still calls its authentic predicates. Cash bounds independently measured.
  for n,q in [('before',before),('after',after)]:
   sql('SELECT pg_stat_reset();','cash-'+n+'-reset');sql(q,'cash-'+n+'-rows')
   counts['cash-'+n]=json.loads(sql("SELECT jsonb_object_agg(funcname,calls) FROM pg_stat_user_functions WHERE funcname IN('fn_ca_launch_accounting_accepts','fn_ca_launch_accounting_cutoff');",'cash-'+n+'-helper-counts'))
  assert counts['cash-after']['fn_ca_launch_accounting_cutoff']==5,counts
  assert counts['cash-before']['fn_ca_launch_accounting_cutoff']>1000,counts
  # Transparent native-only PL wrapper counts; authentic output/calendar proof above is separate.
  original_week=week
  sql("CREATE OR REPLACE FUNCTION public.fn_union_week_start(p_at timestamptz DEFAULT now())RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE SET search_path TO public,extensions AS $$BEGIN RETURN date_trunc('week',p_at AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'America/Los_Angeles';END$$;",'calendar-counter-wrapper')
  measured={}
  for label in ['before','after']:
   sql('SELECT pg_stat_reset();','calendar-'+label+'-reset');sql((P/(label+'-primitive.sql')).read_text(),'calendar-'+label+'-primitive')
   measured[label]=int(sql("SELECT calls FROM pg_stat_user_functions WHERE funcname='fn_union_week_start';",'calendar-'+label+'-calls'))
  primitive_rows=json.loads(sql(aggregate((P/'after-primitive.sql').read_text()),'calendar-counted-cohorts'))
  assert measured['after']==len(primitive_rows) and measured['before']>measured['after'],measured
  sql(original_week+';','calendar-counter-restore');assert sql("SELECT md5(pg_get_functiondef('fn_union_week_start(timestamptz)'::regprocedure));",'calendar-restored-full')=='103f192a228084dad0e4268c36c82c4b'
  (O/'calendar-operand-call-counts.json').write_text(json.dumps({'native_only_equivalent_PL_wrapper':True,'actual_counts':measured,'group_count':len(primitive_rows),'restored_authentic103f':True,'limits':'Only changed primitive measured; no production timing claim'},indent=2))
  (O/'semantic-result.json').write_text(json.dumps({'global_selector_outputs':results,'outputs_exact':True,'actual_helper_counts':counts,'NULL_infinite_cash_rows_exact':True,'no_money_rpc':True,'limits':'2400-row real-component selector fixture; no production timing/full financial proof'},indent=2))
 # Metadata/installer qualification in a separate isolated database, using genuine current source40.
 run([pg/'createdb','-h',S,'-p',port,'-U','postgres','installer'],'create-installer');db='installer'
 roles="CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA smarter_private;SET check_function_bodies=false;"
 bootstrap=roles+(R/'scripts/qualification/original-flow-eligibility/maintenance-type-source.sql').read_text()
 for x in forty:
  bootstrap+=x['definition'].rstrip()+';REVOKE ALL ON FUNCTION '+x['signature']+' FROM PUBLIC,anon,authenticated,service_role;'
  if 'anon=X/postgres' in x['acl']:bootstrap+='GRANT EXECUTE ON FUNCTION '+x['signature']+' TO anon;'
  if 'authenticated=X/postgres' in x['acl']:bootstrap+='GRANT EXECUTE ON FUNCTION '+x['signature']+' TO authenticated;'
  if 'service_role=X/postgres' in x['acl']:bootstrap+='GRANT EXECUTE ON FUNCTION '+x['signature']+' TO service_role;'
 bootstrap+=(R/'scripts/qualification/original-flow-eligibility/after-flow.sql').read_text()+';'+(R/'scripts/qualification/original-flow-eligibility/after-matcher.sql').read_text()+';'
 bootstrap+='REVOKE ALL ON FUNCTION smarter_private.original_inventory_proof_sources_match() FROM PUBLIC,anon,authenticated,service_role;'
 bootstrap+=(P/'selector-fixture.sql').read_text().replace('CREATE SCHEMA extensions;','CREATE SCHEMA IF NOT EXISTS extensions;')+week+';'+(P/'calendar-support.sql').read_text()
 bootstrap+='\n'.join(x['full_definition'].rstrip()+';REVOKE ALL ON FUNCTION '+x['signature']+' FROM PUBLIC,anon,authenticated,service_role;'+('GRANT EXECUTE ON FUNCTION '+x['signature']+' TO authenticated,service_role;' if x['security_definer'] else '') for x in auth['functions'])
 bootstrap+='REVOKE ALL ON FUNCTION fn_union_accounting_run_at(timestamptz) FROM PUBLIC,anon;GRANT EXECUTE ON FUNCTION fn_union_prev_week_start(timestamptz) TO anon;GRANT EXECUTE ON FUNCTION fn_union_accounting_run_at(timestamptz),fn_union_prev_week_start(timestamptz) TO authenticated,service_role;'
 bootstrap+='CREATE OR REPLACE VIEW public.accounting_payable_earning_sources WITH(security_invoker=true) AS '+auth['view']+';'
 bootstrap+=(P/'before-scope.sql').read_text()+';REVOKE ALL ON FUNCTION public.fn_process_weekly_accounting_scope(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;'
 bootstrap+='CREATE SCHEMA supabase_migrations;CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,statements text[]);'
 for v in ['20261012181905','20261013084856','20261013133012','20261013163310']:
  s=next((R/'supabase/migrations').glob(v+'_*')).read_text();bootstrap+="INSERT INTO supabase_migrations.schema_migrations VALUES('"+v+"',ARRAY[$parent$"+s+'$parent$]);'
 sql(bootstrap,'installer-authentic-bootstrap')
 sql("SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'full_md5',md5(pg_get_functiondef(p.oid)),'secdef',p.prosecdef,'volatility',p.provolatile,'acl',p.proacl::text,'config',p.proconfig)) FROM pg_proc p WHERE p.proname IN('fn_process_weekly_accounting_scope','fn_ca_launch_accounting_accepts','fn_ca_launch_accounting_cutoff','fn_club_settlement_floor_week','fn_union_week_start','fn_union_prev_week_start','fn_union_accounting_run_at');",'preimage-diagnosis')
 migration=next((R/'supabase/migrations').glob('20261013182759_*')).read_text();pre='BEGIN;'
 controls=[("SET LOCAL ca.break_window_migration_override='native-unapproved';",'weekly_selector_override_refused','override'),("INSERT INTO supabase_migrations.schema_migrations VALUES('20261013182759',ARRAY['other']);",'weekly_selector_history_replay','own-history'),("SET LOCAL request.jwt.claims='{\"role\":\"service_role\"}';",'weekly_selector_operator_refused','jwt'),('SET LOCAL ROLE service_role;','weekly_selector_operator_refused','role'),("UPDATE supabase_migrations.schema_migrations SET statements=ARRAY['wrong'] WHERE version='20261012181905';",'weekly_selector_parent_history_refused','parent-bytes'),('ALTER VIEW accounting_payable_earning_sources SET(security_invoker=false);','weekly_selector_view_refused','view-security'),('ALTER FUNCTION fn_ca_launch_accounting_accepts(uuid,timestamptz) SECURITY INVOKER;','weekly_selector_preimage_refused','accept-security'),('GRANT EXECUTE ON FUNCTION fn_process_weekly_accounting_scope(uuid,uuid) TO anon;','weekly_selector_preimage_refused','scope-acl'),('ALTER FUNCTION fn_union_week_start(timestamptz) VOLATILE;','weekly_selector_source40_refused','source40-calendar')]
 for inject,error,n in controls:sql(migration.replace('BEGIN;',pre+inject,1),'refuse-'+n,error)
 sql("INSERT INTO engine_maintenance_break VALUES(true,'counting_down',clock_timestamp()-interval '3 minutes',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '3 minutes','native',NULL,clock_timestamp(),true,gen_random_uuid());",'freeze-on');sql(migration,'refuse-freeze','weekly_selector_freeze_refused');sql('DELETE FROM engine_maintenance_break;','freeze-off')
 for lock,error,n in [("hashtextextended('union-accounting-scheduler',0)",'weekly_selector_reader_owned','scheduler'),('530090,1','weekly_selector_settlement_lane_owned','settlement-lane')]:
  cmd=[str(pg/'psql'),'-X','-qAt','-h',str(S),'-p',port,'-U','postgres','-d',db]
  owner=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
  try:
   owner.stdin.write('BEGIN;DO $$BEGIN PERFORM pg_advisory_xact_lock('+lock+');END$$;\n\\echo OWNER_HELD\n');owner.stdin.flush()
   assert select.select([owner.stdout],[],[],5)[0] and owner.stdout.readline().strip()=='OWNER_HELD'
   sql(migration,'refuse-owned-'+n,error)
  finally:
   owner.stdin.write('ROLLBACK;\n\\q\n');owner.stdin.flush();owner.communicate(timeout=5);assert owner.returncode==0
 sql(migration.replace('BEGIN;',pre,1).replace('COMMIT;','ROLLBACK;'),'exact-installer-rollback')
 assert sql("SELECT md5(pg_get_functiondef('fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure));",'rollback-full-hash')=='f176429b58caf30468e0d1b681f8291f'
 sql(migration.replace('BEGIN;',pre,1),'exact-installer-commit')
 meta=json.loads(sql("SELECT jsonb_build_object('full_hash',md5(pg_get_functiondef(p.oid)),'body_hash',md5(p.prosrc),'owner',pg_get_userbyid(proowner),'security_definer',prosecdef,'acl',proacl::text,'config',proconfig,'volatility',provolatile) FROM pg_proc p WHERE p.oid='fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure;",'postimage'))
 sql(migration,'replay-source-refused','weekly_selector_preimage_refused')
 (O/'installer-result.json').write_text(json.dumps({'postimage':meta,'refusals':[x[2] for x in controls]+['freeze','replay'],'rollback_exact':True,'active_owners_refused':['scheduler','settlement-lane'],'exact_installer_bytes':True,'source40_bootstrap_only_check_function_bodies_false':True,'source40':sql('SELECT smarter_private.original_inventory_proof_sources_match();','source40-after')},indent=2))
 print('PASS exact installer/source40/security/rollback/replay/active owners' if args.installer_only else 'PASS exact global selector + NULL/infinite cash equivalence; cash helper count bounded to five cohorts; actual source40/installer/security/rollback/replay')
finally:
 if started:run([pg/'pg_ctl','-D',C/'d','-m','immediate','-w','stop'],'stop')
 if (C/'server.log').exists():shutil.copyfile(C/'server.log',O/'server.log')
 shutil.rmtree(C);(O/'cleanup.json').write_text(json.dumps({'own_cluster_stopped':True,'own_cluster_removed':True,'production_calls':False}))
