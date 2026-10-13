#!/usr/bin/env python3
"""Isolated PG17: exact global selector outputs and original helper call bounds. No money RPC."""
import datetime
import select
import argparse,hashlib,json,os,pathlib,re,shutil,subprocess,sys,tempfile,time
P=pathlib.Path(__file__).resolve().parent;R=P.parents[2]
a=argparse.ArgumentParser();a.add_argument('--output',type=pathlib.Path,required=True);args=a.parse_args();O=args.output.resolve();O.mkdir(parents=True,exist_ok=True)
for name,pin in json.loads((P/'source-binding.json').read_text())['files'].items():
 raw=(R/name).read_bytes()
 if len(raw)!=pin['bytes'] or hashlib.sha256(raw).hexdigest()!=pin['sha256']:raise RuntimeError('qualification source input differs: '+name)
if os.environ.get('DATABASE_URL'):raise RuntimeError('remote connection forbidden')
pg=pathlib.Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin' if sys.platform=='darwin' else str(pathlib.Path(shutil.which('psql')).parent)))
assert ' 17.' in subprocess.check_output([str(pg/'postgres'),'--version'],text=True)
base=pathlib.Path('/Volumes/SmarterWork/agent-work/weekly-standalone-selector-01a13099') if sys.platform=='darwin' else O.parent
C=pathlib.Path(tempfile.mkdtemp(prefix='native-',dir=base));S=C/'s';S.mkdir();port='56637';started=False;db='postgres'
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
 run([pg/'pg_ctl','-D',C/'d','-l',C/'server.log','-o',f"-k {S} -p {port} -h ''",'-w','start'],'start');started=True
 auth=json.loads((P/'authorities.json').read_text());auth['functions'].sort(key=lambda x:'fn_ca_launch_accounting_cutoff' not in x['signature']);forty=json.loads((R/'scripts/qualification/original-flow-eligibility/current-source40.json').read_text())
 week=next(x['definition'] for x in forty if x['signature'].startswith('public.fn_union_week_start('))
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
 bootstrap+=(R/'scripts/qualification/weekly-first-week-aggregate/selector-fixture.sql').read_text().replace('CREATE SCHEMA extensions;','CREATE SCHEMA IF NOT EXISTS extensions;')+week+';'+(R/'scripts/qualification/weekly-first-week-aggregate/calendar-support.sql').read_text()
 bootstrap+='\n'.join(x['full_definition'].rstrip()+';REVOKE ALL ON FUNCTION '+x['signature']+' FROM PUBLIC,anon,authenticated,service_role;'+('GRANT EXECUTE ON FUNCTION '+x['signature']+' TO authenticated,service_role;' if x['security_definer'] else '') for x in auth['functions'])
 bootstrap+='REVOKE ALL ON FUNCTION fn_union_accounting_run_at(timestamptz) FROM PUBLIC,anon;GRANT EXECUTE ON FUNCTION fn_union_prev_week_start(timestamptz) TO anon;GRANT EXECUTE ON FUNCTION fn_union_accounting_run_at(timestamptz),fn_union_prev_week_start(timestamptz) TO authenticated,service_role;'
 bootstrap+='CREATE OR REPLACE VIEW public.accounting_payable_earning_sources WITH(security_invoker=true) AS '+auth['view']+';'
 bootstrap+=(R/'scripts/qualification/weekly-first-week-aggregate/after-scope.sql').read_text()+';REVOKE ALL ON FUNCTION public.fn_process_weekly_accounting_scope(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;' + (R/'scripts/qualification/weekly-cohort-cutoff/after-helper.sql').read_text()+';REVOKE ALL ON FUNCTION public.fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;' + 'CREATE SCHEMA IF NOT EXISTS auth;CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULL::text $$;' + (P/'caller-source.sql').read_text()+';REVOKE ALL ON FUNCTION public.fn_caller_is_engine() FROM PUBLIC,anon;GRANT EXECUTE ON FUNCTION public.fn_caller_is_engine() TO authenticated,service_role;'
 bootstrap+='CREATE SCHEMA supabase_migrations;CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,statements text[]);'
 for v in ['20261012181905','20261013084856','20261013133012','20261013163310','20261013182759','20261013195428']:
  s=next((R/'supabase/migrations').glob(v+'_*')).read_text();bootstrap+="INSERT INTO supabase_migrations.schema_migrations VALUES('"+v+"',ARRAY[$parent$"+s+'$parent$]);'
 sql(bootstrap,'installer-authentic-bootstrap')
 sql("SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'full_md5',md5(pg_get_functiondef(p.oid)),'secdef',p.prosecdef,'volatility',p.provolatile,'acl',p.proacl::text,'config',p.proconfig)) FROM pg_proc p WHERE p.proname IN('fn_process_weekly_accounting_scope','fn_ca_launch_accounting_accepts','fn_ca_launch_accounting_cutoff','fn_club_settlement_floor_week','fn_union_week_start','fn_union_prev_week_start','fn_union_accounting_run_at');",'preimage-diagnosis')
 migration=next((R/'supabase/migrations').glob('20261013212336_*')).read_text();pre='BEGIN;'
 controls=[("SET LOCAL ca.break_window_migration_override='native-unapproved';",'weekly_standalone_selector_override_refused','override'),("INSERT INTO supabase_migrations.schema_migrations VALUES('20261013212336',ARRAY['other']);",'weekly_standalone_selector_history_replay','own-history'),("SET LOCAL request.jwt.claims='{\"role\":\"service_role\"}';",'weekly_standalone_selector_operator_refused','jwt'),('SET LOCAL ROLE service_role;','weekly_standalone_selector_operator_refused','role'),("UPDATE supabase_migrations.schema_migrations SET statements=ARRAY['wrong'] WHERE version='20261012181905';",'weekly_standalone_selector_parent_history_refused','parent-bytes'),('ALTER VIEW accounting_payable_earning_sources SET(security_invoker=false);','weekly_standalone_selector_view_refused','view-security'),('ALTER FUNCTION fn_ca_launch_accounting_accepts(uuid,timestamptz) SECURITY INVOKER;','weekly_standalone_selector_preimage_refused','accept-security'),('GRANT EXECUTE ON FUNCTION fn_process_weekly_accounting_scope(uuid,uuid) TO anon;','weekly_standalone_selector_preimage_refused','scope-acl'),('ALTER FUNCTION fn_union_week_start(timestamptz) VOLATILE;','weekly_standalone_selector_source40_refused','source40-calendar'),('ALTER FUNCTION fn_caller_is_engine() VOLATILE;','weekly_standalone_selector_preimage_refused','caller-source'),('GRANT EXECUTE ON FUNCTION fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz) TO anon;','weekly_standalone_selector_preimage_refused','helper-acl'),('ALTER FUNCTION fn_ca_launch_accounting_cutoff(text,uuid) VOLATILE;','weekly_standalone_selector_preimage_refused','cutoff-source'),('ALTER FUNCTION fn_process_weekly_accounting_scope(uuid,uuid) SECURITY INVOKER;','weekly_standalone_selector_preimage_refused','scope-security'),("UPDATE supabase_migrations.schema_migrations SET statements=ARRAY['wrong'] WHERE version='20261013195428';",'weekly_standalone_selector_parent_history_refused','cohort-parent-bytes')]
 # Every remaining pinned authority receives an actual before-write drift refusal.
 controls.extend([
  ('ALTER FUNCTION smarter_private.original_inventory_proof_sources_match() VOLATILE;','weekly_standalone_selector_gate_authority_refused','matcher-source'),
  ('ALTER FUNCTION fn_active_maintenance_release_boundary() STABLE;','weekly_standalone_selector_gate_authority_refused','maintenance-source'),
  ('ALTER FUNCTION fn_platform_frozen() STABLE;','weekly_standalone_selector_gate_authority_refused','freeze-source'),
  ('ALTER FUNCTION fn_club_settlement_floor_week(uuid) VOLATILE;','weekly_standalone_selector_preimage_refused','floor-source'),
  ('ALTER FUNCTION fn_union_prev_week_start(timestamptz) VOLATILE;','weekly_standalone_selector_preimage_refused','prev-calendar-source'),
  ('ALTER FUNCTION fn_union_accounting_run_at(timestamptz) VOLATILE;','weekly_standalone_selector_preimage_refused','run-at-source'),
  ('ALTER FUNCTION fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz) VOLATILE;','weekly_standalone_selector_preimage_refused','helper-source'),
 ])
 for inject,error,n in controls:sql(migration.replace('BEGIN;',pre+inject,1),'refuse-'+n,error)
 sql("INSERT INTO engine_maintenance_break VALUES(true,'counting_down',clock_timestamp()-interval '3 minutes',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '3 minutes','native',NULL,clock_timestamp(),true,gen_random_uuid());",'freeze-on');sql(migration,'refuse-freeze','weekly_standalone_selector_freeze_refused');sql('DELETE FROM engine_maintenance_break;','freeze-off')
 for lock,error,n in [("hashtextextended('union-accounting-scheduler',0)",'weekly_standalone_selector_reader_owned','scheduler'),('530090,1','weekly_standalone_selector_settlement_lane_owned','settlement-lane')]:
  cmd=[str(pg/'psql'),'-X','-qAt','-h',str(S),'-p',port,'-U','postgres','-d',db]
  owner=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
  try:
   owner.stdin.write('BEGIN;DO $$BEGIN PERFORM pg_advisory_xact_lock('+lock+');END$$;\n\\echo OWNER_HELD\n');owner.stdin.flush()
   assert select.select([owner.stdout],[],[],5)[0] and owner.stdout.readline().strip()=='OWNER_HELD'
   sql(migration,'refuse-owned-'+n,error)
  finally:
   owner.stdin.write('ROLLBACK;\n\\q\n');owner.stdin.flush();owner.communicate(timeout=5);assert owner.returncode==0
 sql(migration.replace('BEGIN;',pre,1).replace('COMMIT;','ROLLBACK;'),'exact-installer-rollback')
 assert sql("SELECT md5(pg_get_functiondef('fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure));",'rollback-full-hash')=='91caaaf89b89f0978069461010c3eeb9'
 record="INSERT INTO supabase_migrations.schema_migrations VALUES('20261013212336',ARRAY[$exact$"+migration+"$exact$]);"
 sql(migration.replace('BEGIN;',pre,1).rsplit('COMMIT;',1)[0]+record+'COMMIT;','exact-installer-recorded-commit')
 assert sql("SELECT cardinality(statements)=1 AND octet_length(statements[1])="+str(len(migration.encode()))+" AND md5(statements[1])='"+hashlib.md5(migration.encode()).hexdigest()+"' FROM supabase_migrations.schema_migrations WHERE version='20261013212336';",'exact-recorded-history')=='t'
 meta=json.loads(sql("SELECT jsonb_build_object('full_hash',md5(pg_get_functiondef(p.oid)),'body_hash',md5(p.prosrc),'owner',pg_get_userbyid(proowner),'security_definer',prosecdef,'acl',proacl::text,'config',proconfig,'volatility',provolatile) FROM pg_proc p WHERE p.oid='fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure;",'postimage'))
 sql(migration,'replay-history-refused','weekly_standalone_selector_history_replay')
 (O/'installer-result.json').write_text(json.dumps({'postimage':meta,'refusals':[x[2] for x in controls]+['freeze','replay'],'rollback_exact':True,'active_owners_refused':['scheduler','settlement-lane'],'exact_installer_bytes':True,'source40_bootstrap_only_check_function_bodies_false':True,'source40':sql('SELECT smarter_private.original_inventory_proof_sources_match();','source40-after')},indent=2))
 print('PASS exact guarded recorded helper installation/rollback/security/refusals/source40')
finally:
 if started:run([pg/'pg_ctl','-D',C/'d','-m','immediate','-w','stop'],'stop')
 if (C/'server.log').exists():shutil.copyfile(C/'server.log',O/'server.log')
 shutil.rmtree(C);(O/'cleanup.json').write_text(json.dumps({'own_cluster_stopped':True,'own_cluster_removed':True,'production_calls':False}))
