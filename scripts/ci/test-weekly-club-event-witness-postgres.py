#!/usr/bin/env python3
"""PG17 actual installed helper and guarded replacement; no remote connections."""
import argparse,hashlib,json,os,shutil,subprocess,sys,tempfile
from pathlib import Path
R=Path(__file__).resolve().parents[2];F=R/'scripts/ci/fixtures/weekly-club-event-witness'
p=argparse.ArgumentParser();p.add_argument('--pg-bin',default=os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin'));p.add_argument('--scratch',required=True);a=p.parse_args()
if os.environ.get('DATABASE_URL'):raise RuntimeError('remote connection forbidden')
scratch=Path(a.scratch).resolve()
if sys.platform=='darwin' and not str(scratch).startswith('/Volumes/SmarterWork/agent-work/'):raise RuntimeError('owned external scratch required')
C=Path(tempfile.mkdtemp(prefix='cw-',dir=scratch));D=C/'d';pg=Path(a.pg_bin);started=False
psql=[pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',C,'-U','postgres','-d','postgres']
def run(cmd,text=None,error=None):
 r=subprocess.run([str(x) for x in cmd],input=text,text=True,capture_output=True,timeout=90)
 if error:assert r.returncode and error in r.stderr,r.stdout+r.stderr
 else:assert r.returncode==0,r.stdout+r.stderr
 return r.stdout.strip()
def q(s,error=None):return run(psql,s,error)
u="md5('union')::uuid";c="md5('club')::uuid";a0="'2026-10-05 07:00Z'::timestamptz";b0="'2026-10-12 07:00Z'::timestamptz"
call=lambda name:f"SELECT coalesce(jsonb_agg(club_id ORDER BY club_id),'[]') FROM {name}({u},NULL,{a0},{b0});"
pins=json.loads((F/'replacement.json').read_text());before=(F/'before.sql').read_text();migration=next((R/'supabase/migrations').glob('20261016173058_*')).read_text()
assert hashlib.md5(before.encode()).hexdigest()==pins['before']
try:
 assert ' 17.' in run([pg/'postgres','--version'])
 run([pg/'initdb','-D',D,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
 with (D/'postgresql.conf').open('a') as h:h.write("\nlisten_addresses=''\nunix_socket_directories='"+str(C)+"'\n")
 run([pg/'pg_ctl','-D',D,'-l',C/'server.log','-w','start']);started=True
 q("""CREATE TABLE fixture_control(frozen boolean,caller boolean);INSERT INTO fixture_control VALUES(false,true);
 CREATE FUNCTION fn_platform_frozen()RETURNS boolean LANGUAGE sql AS $$SELECT frozen FROM fixture_control$$;
 CREATE FUNCTION fn_caller_is_engine()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT caller FROM fixture_control$$;
 CREATE FUNCTION fn_active_maintenance_release_boundary()RETURNS timestamptz LANGUAGE sql AS $$SELECT NULL::timestamptz$$;
 CREATE TABLE fixture_cutoffs(club_id uuid PRIMARY KEY,at timestamptz);
 CREATE FUNCTION fn_ca_launch_accounting_cutoff(text,uuid)RETURNS timestamptz LANGUAGE sql STABLE AS $$SELECT at FROM fixture_cutoffs WHERE club_id=$2$$;
 CREATE TABLE clubs(id uuid,is_union boolean);
 CREATE TABLE accounting_cash_rake_sources(club_id uuid,coordinator_union_id uuid,earned_at timestamptz);
 CREATE TABLE accounting_tournament_fee_sources(id uuid PRIMARY KEY,club_id uuid,coordinator_union_id uuid,tournament_id uuid,charged_at timestamptz,union_id uuid,rake_credit numeric);
 CREATE INDEX accounting_tournament_fee_sources_coordinator_club ON accounting_tournament_fee_sources(coordinator_union_id,club_id) WHERE coordinator_union_id IS NOT NULL;
 CREATE INDEX fixture_club_event ON accounting_tournament_fee_sources(club_id,tournament_id);
 CREATE TABLE accounting_tournament_recognized_sources(source_id uuid PRIMARY KEY,tournament_id uuid,recognized_at timestamptz,disposition text,rake_credit numeric);
 CREATE INDEX fixture_recognized_week ON accounting_tournament_recognized_sources(recognized_at,tournament_id);
 CREATE TABLE accounting_tournament_fee_recognitions(tournament_id uuid PRIMARY KEY,recognized_at timestamptz,status text,union_id uuid);
 CREATE INDEX fixture_events_week ON accounting_tournament_fee_recognitions(recognized_at,tournament_id);
 CREATE TABLE accounting_agreement_history(id bigint,entity_key text,entity_type text,observed_at timestamptz,after_terms jsonb);
 CREATE TABLE accounting_rakeback_period_calculations(club_id uuid,coordinator_union_id uuid,period_start date,period_end date);
 CREATE TABLE settlement_periods(club_id uuid,union_id uuid,start_at timestamptz,end_at timestamptz);
 CREATE SCHEMA supabase_migrations;CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY);
 """+before+";REVOKE ALL ON FUNCTION fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC;"+before.replace('public.fn_accounting_week_clubs','public.fixture_before',1))
 authority=q("SELECT jsonb_build_array(proowner,prosecdef,provolatile,proconfig,proacl) FROM pg_proc WHERE oid='fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz)'::regprocedure;")
 for inject,error in [("UPDATE fixture_control SET frozen=true;",'club_witness_freeze_or_override_refused'),("SET LOCAL request.jwt.claims='{}';",'club_witness_operator_refused'),("SET LOCAL ca.break_window_migration_override='fixture';",'club_witness_freeze_or_override_refused'),("INSERT INTO supabase_migrations.schema_migrations VALUES('20261016173058');",'club_witness_history_replay'),("GRANT EXECUTE ON FUNCTION fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz) TO PUBLIC;",'club_witness_preimage_authority_refused')]:q(migration.replace('BEGIN;','BEGIN;'+inject,1),error)
 q(migration.replace('COMMIT;',"DO $$BEGIN RAISE EXCEPTION 'fixture_abort';END$$;COMMIT;"),'fixture_abort')
 assert q("SELECT md5(pg_get_functiondef('fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz)'::regprocedure));")==pins['before']
 q(migration)
 assert q("SELECT md5(pg_get_functiondef('fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz)'::regprocedure));")==pins['after']
 assert authority==q("SELECT jsonb_build_array(proowner,prosecdef,provolatile,proconfig,proacl) FROM pg_proc WHERE oid='fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz)'::regprocedure;")
 def parity(expected):
  old=q(call('fixture_before'));new=q(call('fn_accounting_week_clubs'));assert old==new,(old,new)
  assert len(json.loads(new))==expected,new
 parity(0)
 # One original event; half-open recognition boundaries, NULL equality and cutoff rules.
 q("INSERT INTO accounting_tournament_fee_sources VALUES(md5('source')::uuid,md5('club')::uuid,md5('union')::uuid,md5('event')::uuid,'2026-10-04 07:00Z',md5('union')::uuid,3);INSERT INTO accounting_tournament_recognized_sources VALUES(md5('source')::uuid,md5('event')::uuid,'2026-10-08 07:00Z','earned',3);INSERT INTO accounting_tournament_fee_recognitions VALUES(md5('event')::uuid,'2026-10-08 07:00Z','recognized',md5('union')::uuid);")
 parity(1)
 cases=[("UPDATE accounting_tournament_recognized_sources SET disposition='refused'",0),("UPDATE accounting_tournament_recognized_sources SET rake_credit=4",0),("UPDATE accounting_tournament_recognized_sources SET tournament_id=md5('wrong')::uuid",0),("UPDATE accounting_tournament_fee_recognitions SET status='pending'",0),("UPDATE accounting_tournament_fee_recognitions SET union_id=NULL",0),("UPDATE accounting_tournament_fee_recognitions SET union_id=NULL;UPDATE accounting_tournament_fee_sources SET union_id=NULL",1),("UPDATE accounting_tournament_recognized_sources SET recognized_at='2026-10-12 07:00Z';UPDATE accounting_tournament_fee_recognitions SET recognized_at='2026-10-12 07:00Z'",0),("UPDATE accounting_tournament_recognized_sources SET recognized_at='2026-10-05 07:00Z';UPDATE accounting_tournament_fee_recognitions SET recognized_at='2026-10-05 07:00Z'",1),("UPDATE accounting_tournament_fee_recognitions SET recognized_at=NULL",0),("UPDATE accounting_tournament_fee_sources SET coordinator_union_id=md5('other')::uuid",0),("UPDATE accounting_tournament_fee_sources SET club_id=NULL",0),("INSERT INTO fixture_cutoffs VALUES(md5('club')::uuid,'2026-10-05 07:00Z')",0),("INSERT INTO fixture_cutoffs VALUES(md5('club')::uuid,'2026-10-04 07:00Z')",1),("INSERT INTO fixture_cutoffs VALUES(md5('club')::uuid,'-infinity');UPDATE accounting_tournament_fee_sources SET charged_at='-infinity'",0),("INSERT INTO fixture_cutoffs VALUES(md5('club')::uuid,'-infinity')",1),("UPDATE accounting_tournament_fee_sources SET charged_at=NULL",1),("INSERT INTO fixture_cutoffs VALUES(md5('club')::uuid,'2026-10-04 07:00Z');UPDATE accounting_tournament_fee_sources SET charged_at=NULL",0)]
 for change,expected in cases:
  q('BEGIN;'+change+';DO $$DECLARE x jsonb;y jsonb;BEGIN '+call('fixture_before').replace('SELECT coalesce','SELECT coalesce').replace(' FROM fixture_before',' INTO x FROM fixture_before')+call('fn_accounting_week_clubs').replace(' FROM fn_accounting_week_clubs',' INTO y FROM fn_accounting_week_clubs')+f"IF x IS DISTINCT FROM y OR jsonb_array_length(y)<>{expected} THEN RAISE EXCEPTION 'boundary_parity_failed';END IF;END$$;ROLLBACK;")
 # Independent cohort sources and foreign/null union sources are not lost.
 q("TRUNCATE accounting_tournament_fee_sources,accounting_tournament_recognized_sources,accounting_tournament_fee_recognitions;INSERT INTO accounting_cash_rake_sources VALUES(md5('cash')::uuid,md5('union')::uuid,'2026-10-05 07:00Z'),(md5('excluded')::uuid,md5('other')::uuid,'2026-10-08 07:00Z');INSERT INTO accounting_agreement_history VALUES(1,'old','union_clubs','2026-10-01 07:00Z',jsonb_build_object('club_id',md5('member')::uuid,'union_id',md5('union')::uuid)),(2,'during','union_clubs','2026-10-08 07:00Z',jsonb_build_object('club_id',md5('during')::uuid,'union_id',md5('union')::uuid));INSERT INTO accounting_rakeback_period_calculations VALUES(md5('calc')::uuid,md5('union')::uuid,'2026-10-05','2026-10-11');INSERT INTO settlement_periods VALUES(md5('period')::uuid,md5('union')::uuid,'2026-10-05 07:00Z','2026-10-12 07:00Z');")
 parity(5)
 # Large duplicate fee history: actual DISTINCT scans all rows; the exact replacement walks keys.
 q("INSERT INTO accounting_tournament_fee_sources SELECT md5(n::text)::uuid,md5((n%4)::text)::uuid,md5('union')::uuid,md5('event')::uuid,NULL,NULL,0 FROM generate_series(1,50000)n;ANALYZE accounting_tournament_fee_sources;")
 parity(5)
 old=pins['old1'].replace('p_union_id',u);new=pins['new1'].replace('p_union_id',u)
 plans=[json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+sql))[0] for sql in [old,new]]
 def nodes(n):
  yield n
  for c0 in n.get('Plans',[]):yield from nodes(c0)
 assert any(n['Node Type']=='Recursive Union' for n in nodes(plans[1]['Plan']))
 before_blocks=sum(plans[0]['Plan'].get(k,0) for k in ['Shared Hit Blocks','Shared Read Blocks']);after_blocks=sum(plans[1]['Plan'].get(k,0) for k in ['Shared Hit Blocks','Shared Read Blocks']);assert before_blocks>after_blocks*5,(before_blocks,after_blocks)
 q("UPDATE fixture_control SET caller=false;")
 q(call('fn_accounting_week_clubs'),'service_role_required')
 q("INSERT INTO supabase_migrations.schema_migrations VALUES('20261016173058');")
 q(migration,'club_witness_history_replay')
 print(json.dumps({'qualification':'passed','actual_installed_helper_and_migration':True,'boundary_cases':len(cases),'independent_cohort_sources':5,'duplicate_history_rows':50000,'old_distinct_blocks':before_blocks,'new_key_walk_blocks':after_blocks,'whole_rollback_and_replay_refusal':True,'metadata_unchanged':True,'production_financial_close_qualified':False}))
finally:
 if started:run([pg/'pg_ctl','-D',D,'-m','fast','-w','stop'])
 shutil.rmtree(C)
