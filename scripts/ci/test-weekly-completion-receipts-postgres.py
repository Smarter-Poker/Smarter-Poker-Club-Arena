#!/usr/bin/env python3
"""PG17: authentic completion SQL control flow plus exact recorded installer.

Controlled relations/helper are local only; no pricing, payment or production
runtime claim. Every byte outside the completion block must remain identical.
"""
import argparse,hashlib,json,os,re,shutil,subprocess,sys,tempfile
from pathlib import Path
R=Path(__file__).resolve().parents[2];F=R/'scripts/ci/fixtures/weekly-completion-receipts'
a=argparse.ArgumentParser();a.add_argument('--scratch',default=os.environ.get('ACCOUNTING_FIXTURE_PARENT',os.environ.get('RUNNER_TEMP',tempfile.gettempdir())));args=a.parse_args()
scratch=Path(args.scratch).resolve()
if sys.platform=='darwin' and not scratch.is_relative_to('/Volumes/SmarterWork/agent-work'):raise RuntimeError('Mac native scratch must be on owned external SSD')
if os.environ.get('DATABASE_URL'):raise RuntimeError('remote connection forbidden')
pg=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin' if sys.platform=='darwin' else '/usr/lib/postgresql/17/bin'))
C=Path(tempfile.mkdtemp(prefix='wc-',dir=scratch));D=C/'d';started=False
pins=json.loads((F/'replacement.json').read_text());before=(F/'scope-before.sql').read_text();migration=next((R/'supabase/migrations').glob('20261015234926_*')).read_text()
old=re.search(r'old text:=\$completion\$(.*?)\$completion\$;',migration,re.S).group(1);new=re.search(r'new text:=\$completion\$(.*?)\$completion\$;',migration,re.S).group(1)
assert hashlib.md5(before.encode()).hexdigest()==pins['beforeHash'] and before.count(old)==1
after=before.replace(old,new);assert hashlib.md5(after.encode()).hexdigest()==pins['afterHash'] and after.replace(new,old)==before
assert new.endswith('      END IF;\n') and new.count('public.fn_accounting_week_clubs(')==1 and new.count('unnest(v_completion_clubs) AS uc(club_id)')==3
start=before.rfind('      SELECT NOT EXISTS (',0,before.index(old));initial=before[start:before.index(old)]
assert 'generate_series(1,4)' in initial and 'INTO v_complete;' in initial
native=dict(os.environ,LC_ALL='C',LANG='C')
def run(argv,s=None,error=None):
 q=subprocess.run([str(x)for x in argv],input=s,text=True,capture_output=True,env=native,timeout=45)
 if error:assert q.returncode and error in q.stderr,(error,q.stdout,q.stderr)
 else:assert q.returncode==0,q.stdout+q.stderr
 return q.stdout.strip()
def sql(s,error=None):return run([pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',C,'-U','postgres','-d','postgres'],s,error)
def exercise(block,error=None):
 sql("TRUNCATE fixture_answer;SELECT setval('fixture_calls',1,false);")
 sql("DO $case$ DECLARE v_union record;v_from timestamptz:='2026-10-05 07:00Z';v_end timestamptz:='2026-10-12 07:00Z';v_complete boolean;v_previous jsonb;BEGIN SELECT md5('union')::uuid id INTO v_union;SELECT previous INTO v_previous FROM fixture_control;\n"+initial+block+"\nINSERT INTO fixture_answer VALUES(v_complete);END $case$;",error)
 if not error:return json.loads(sql("SELECT jsonb_build_object('complete',(SELECT value FROM fixture_answer),'calls',(SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM fixture_calls)) FROM fixture_control;"))
try:
 assert ' 17.' in run([pg/'postgres','--version'])
 run([pg/'initdb','-D',D,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8'])
 with (D/'postgresql.conf').open('a')as f:f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(C)+"'\n")
 run([pg/'pg_ctl','-D',D,'-l',C/'server.log','-w','start']);started=True
 sql("""CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
 CREATE TABLE fixture_control(calls int,reject boolean,frozen boolean,previous jsonb,max_calls int);INSERT INTO fixture_control VALUES(0,true,false,'{}',NULL);
 CREATE TABLE fixture_answer(value boolean);CREATE SEQUENCE fixture_calls;
 CREATE FUNCTION fn_platform_frozen()RETURNS boolean LANGUAGE sql AS $$SELECT frozen FROM fixture_control$$;
 CREATE FUNCTION fn_active_maintenance_release_boundary()RETURNS timestamptz LANGUAGE sql AS $$SELECT NULL::timestamptz$$;
 CREATE SCHEMA supabase_migrations;CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,statements text[]);
 SET check_function_bodies=false;
 """+before+";REVOKE ALL ON FUNCTION fn_process_weekly_accounting_scope(uuid,uuid)FROM PUBLIC;")
 parent=next((R/'supabase/migrations').glob('20261015182133_*')).read_text();sql("INSERT INTO supabase_migrations.schema_migrations VALUES('20261015182133',ARRAY[$parent$"+parent+"$parent$]);")
 assert sql("SELECT md5(pg_get_functiondef('fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure));")==pins['beforeHash']
 meta=lambda:sql("SELECT jsonb_build_array(proowner,prosecdef,provolatile,proconfig,proacl)FROM pg_proc WHERE oid='fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure;")
 authority=meta()
 for inject,error in [("UPDATE fixture_control SET frozen=true;",'completion_scan_freeze_refused'),("SET LOCAL request.jwt.claims='{}';",'completion_scan_operator_refused'),("SET LOCAL ca.break_window_migration_override='fixture';",'completion_scan_override_refused'),("INSERT INTO supabase_migrations.schema_migrations VALUES('20261015234926',ARRAY['wrong']);",'completion_scan_history_replay'),("UPDATE supabase_migrations.schema_migrations SET statements=ARRAY['wrong'];",'completion_scan_parent_history_refused'),("GRANT EXECUTE ON FUNCTION fn_process_weekly_accounting_scope(uuid,uuid)TO anon;",'completion_scan_authority_refused'),("ALTER FUNCTION fn_process_weekly_accounting_scope(uuid,uuid)STABLE;",'completion_scan_preimage_refused')]:
  sql(migration.replace('BEGIN;','BEGIN;'+inject,1),error)
 owner=subprocess.Popen([str(pg/'psql'),'-X','-qAt','-h',str(C),'-U','postgres','-d','postgres'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=native)
 try:
  owner.stdin.write("BEGIN;SELECT pg_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0));\n\\echo OWNER_HELD\n");owner.stdin.flush()
  while owner.stdout.readline().strip()!='OWNER_HELD':
   if owner.poll() is not None:raise RuntimeError('fixture lock owner exited')
  sql(migration,'completion_scan_reader_owned')
 finally:
  owner.stdin.write('ROLLBACK;\n\\q\n');owner.stdin.flush();owner.communicate(timeout=5);assert owner.returncode==0
 sql(migration.replace('COMMIT;',"DO $$BEGIN RAISE EXCEPTION 'fixture_abort';END$$;COMMIT;"),'fixture_abort')
 assert sql("SELECT md5(pg_get_functiondef('fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure));")==pins['beforeHash'] and meta()==authority
 sql("""CREATE TABLE union_settlement_rounds(union_id uuid,period_start timestamptz,period_end timestamptz,round_no int,detail jsonb);
 CREATE TABLE rakeback_periods(club_id uuid,status text,rakeback_amount numeric,period_start date,period_end date);
 CREATE TABLE settlement_invoices(club_id uuid,invoice_type text,breakdown jsonb,message_sent boolean,status text,period_id uuid);
 CREATE TABLE settlement_periods(id uuid,club_id uuid,union_id uuid,start_at timestamptz,end_at timestamptz,status text);
 CREATE TABLE ca_settlements(settlement_type text,union_id uuid,state text,totals jsonb,external_ref text);
 CREATE TABLE accounting_routed_settlement_runs(scope_kind text,scope_id uuid,period_start timestamptz,period_end timestamptz,round_no int,result jsonb);
 CREATE FUNCTION fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz)RETURNS TABLE(club_id uuid)LANGUAGE plpgsql STABLE AS $$BEGIN
 IF(SELECT reject FROM fixture_control)THEN RAISE EXCEPTION 'unnecessary_completion_scan';END IF;
 PERFORM nextval('fixture_calls');IF (SELECT max_calls FROM fixture_control) IS NOT NULL AND currval('fixture_calls')>(SELECT max_calls FROM fixture_control) THEN RAISE EXCEPTION 'unnecessary_completion_rescan';END IF;RETURN QUERY SELECT md5('club')::uuid;END$$;
 """)
 assert exercise(old)=={'complete':False,'calls':0}
 sql(migration);assert meta()==authority
 assert sql("SELECT md5(pg_get_functiondef('fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure));")==pins['afterHash']
 assert exercise(new)=={'complete':False,'calls':0}
 sql("INSERT INTO union_settlement_rounds VALUES(md5('union')::uuid,'2026-10-05 07:00Z','2026-10-12 07:00Z',1,'{\"success\":true}');")
 assert exercise(old)==exercise(new)=={'complete':False,'calls':0}
 sql("""TRUNCATE union_settlement_rounds;
 INSERT INTO union_settlement_rounds SELECT md5('union')::uuid,'2026-10-05 07:00Z','2026-10-12 07:00Z',n,'{"success":true,"amount":0,"payees":0,"shortfalls":0}' FROM generate_series(1,4)n;
 """)
 exercise(new,'unnecessary_completion_scan')
 sql("""UPDATE fixture_control SET reject=false;
 INSERT INTO settlement_periods VALUES(md5('period')::uuid,md5('club')::uuid,md5('union')::uuid,'2026-10-05 07:00Z','2026-10-12 07:00Z','settled');
 INSERT INTO settlement_invoices VALUES(md5('club')::uuid,'club_weekly_accounting','{}',true,'paid',md5('period')::uuid),(md5('club')::uuid,'union_weekly_squareup',jsonb_build_object('union_id',md5('union')::uuid,'period_start','2026-10-05 07:00Z','period_end','2026-10-12 07:00Z'),true,'paid',NULL);
 INSERT INTO ca_settlements VALUES('union_rakeback_close',md5('union')::uuid,'final','{"accounting_version":3}',md5('union')::uuid::text||':2026-10-05T07:00:00Z..2026-10-12T07:00:00Z');
 UPDATE fixture_control SET previous='{"accounting_version":3,"round2_club_to_agents":{"routing_version":3,"source_version":2,"success":true,"shortfalls":0},"round3_agents_to_players":{"routing_version":3,"source_version":2,"success":true,"shortfalls":0}}';
 INSERT INTO accounting_routed_settlement_runs SELECT 'union',md5('union')::uuid,'2026-10-05 07:00Z','2026-10-12 07:00Z',n,previous->CASE WHEN n=2 THEN 'round2_club_to_agents' ELSE 'round3_agents_to_players'END FROM fixture_control CROSS JOIN generate_series(2,3)n;
 """)
 sql('UPDATE fixture_control SET max_calls=1;')
 exercise(old,'unnecessary_completion_rescan');assert exercise(new)=={'complete':True,'calls':1}
 sql('UPDATE fixture_control SET max_calls=NULL;')
 original=exercise(old);fixed=exercise(new);assert original['complete'] is fixed['complete'] is True and original['calls']>=2 and fixed['calls']==1
 for change in ["UPDATE settlement_invoices SET message_sent=false;","DELETE FROM ca_settlements;","INSERT INTO rakeback_periods VALUES(md5('club')::uuid,'pending',1,'2026-10-05','2026-10-11');"]:
  result=sql('BEGIN;'+change+"DO $case$ DECLARE v_union record;v_from timestamptz:='2026-10-05 07:00Z';v_end timestamptz:='2026-10-12 07:00Z';v_complete boolean;v_previous jsonb;BEGIN SELECT md5('union')::uuid id INTO v_union;SELECT previous INTO v_previous FROM fixture_control;"+initial+new+"IF v_complete IS DISTINCT FROM false THEN RAISE EXCEPTION 'bad_complete';END IF;END $case$;ROLLBACK;")
 sql("INSERT INTO supabase_migrations.schema_migrations VALUES('20261015234926',ARRAY['fixture-recorded']);")
 sql(migration,'completion_scan_history_replay')
 print('PASS actual completion SQL: fail-before; missing/partial parity; completed cohort repeated-read fault fail-before/pass-after; full-receipt parity and exactly one cohort read; required errors retained; missing delivery/close refuses; exact installer/hash/ACL; freeze/JWT/history/rollback/replay')
finally:
 if started:run([pg/'pg_ctl','-D',D,'-m','fast','-w','stop'])
 shutil.rmtree(C)
