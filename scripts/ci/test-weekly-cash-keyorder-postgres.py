#!/usr/bin/env python3
"""Local PG17 current complete earning-club owner, authentic competing indexes, skew and key order."""
import argparse,hashlib,json,os,shutil,subprocess,sys,tempfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--pg-bin',required=True);p.add_argument('--scratch',required=True);a=p.parse_args();R=Path(__file__).resolve().parents[2];F=R/'scripts/ci/fixtures/weekly-cash-access'
if os.environ.get('DATABASE_URL'):raise RuntimeError('remote connection forbidden')
S=Path(a.scratch).resolve()
if sys.platform=='darwin' and not str(S).startswith('/Volumes/SmarterWork/agent-work/'):raise RuntimeError('external scratch required')
C=Path(tempfile.mkdtemp(prefix='ck-',dir=S));D=C/'d';pg=Path(a.pg_bin);started=False
psql=[pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',C,'-U','postgres','-d','postgres']
def run(cmd,text=None):
 r=subprocess.run([str(x) for x in cmd],input=text,text=True,capture_output=True,timeout=90);assert r.returncode==0,r.stdout+r.stderr;return r.stdout.strip()
def q(s):return run(psql,s)
u="md5('union')::uuid";other="md5('other')::uuid";start="'2026-10-05 07:00Z'::timestamptz";end="'2026-10-12 07:00Z'::timestamptz"
helper=(F/'helper-current.sql').read_text();assert hashlib.md5(helper.encode()).hexdigest()=='2d861ca48eea9aba964cda9b4d45f456'
cash=(F/'cash-query.sql').read_text().replace('p_union_id',u).replace('p_from',start).replace('p_to',end)
call=f"SELECT coalesce(jsonb_agg(club_id ORDER BY club_id),'[]') FROM fn_accounting_week_clubs({u},NULL,{start},{end});"
try:
 assert ' 17.' in run([pg/'postgres','--version'])
 run([pg/'initdb','-D',D,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
 with (D/'postgresql.conf').open('a') as h:h.write("\nlisten_addresses=''\nunix_socket_directories='"+str(C)+"'\n")
 run([pg/'pg_ctl','-D',D,'-l',C/'server.log','-w','start']);started=True
 q("""CREATE FUNCTION fn_caller_is_engine()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
 CREATE TABLE fixture_cutoffs(club_id uuid PRIMARY KEY,at timestamptz);
 CREATE FUNCTION fn_ca_launch_accounting_cutoff(text,uuid)RETURNS timestamptz LANGUAGE sql STABLE AS $$SELECT at FROM fixture_cutoffs WHERE club_id=$2$$;
 CREATE TABLE clubs(id uuid,is_union boolean);
 CREATE TABLE accounting_cash_rake_sources(id uuid PRIMARY KEY,club_id uuid,coordinator_union_id uuid,earned_at timestamptz,player_id uuid,recorded_at timestamptz);
 CREATE INDEX accounting_cash_rake_sources_period ON accounting_cash_rake_sources(club_id,earned_at,player_id);
 CREATE INDEX accounting_cash_rake_sources_coordinator_period ON accounting_cash_rake_sources(coordinator_union_id,earned_at,club_id);
 CREATE INDEX accounting_cash_rake_sources_club_recorded ON accounting_cash_rake_sources(club_id,recorded_at) INCLUDE(earned_at);
 CREATE TABLE accounting_tournament_fee_sources(id uuid PRIMARY KEY,club_id uuid,coordinator_union_id uuid,tournament_id uuid,charged_at timestamptz,union_id uuid,rake_credit numeric);
 CREATE INDEX accounting_tournament_fee_sources_coordinator_club ON accounting_tournament_fee_sources(coordinator_union_id,club_id) WHERE coordinator_union_id IS NOT NULL;
 CREATE INDEX accounting_tournament_fee_sources_club_event ON accounting_tournament_fee_sources(club_id,tournament_id);
 CREATE TABLE accounting_tournament_recognized_sources(source_id uuid PRIMARY KEY,tournament_id uuid,recognized_at timestamptz,disposition text,rake_credit numeric);
 CREATE INDEX accounting_tournament_recognized_sources_week ON accounting_tournament_recognized_sources(recognized_at,tournament_id);
 CREATE TABLE accounting_tournament_fee_recognitions(tournament_id uuid PRIMARY KEY,recognized_at timestamptz,status text,union_id uuid);
 CREATE TABLE accounting_agreement_history(id bigint,entity_key text,entity_type text,observed_at timestamptz,after_terms jsonb);
 CREATE TABLE accounting_rakeback_period_calculations(club_id uuid,coordinator_union_id uuid,period_start date,period_end date);
 CREATE TABLE settlement_periods(club_id uuid,union_id uuid,start_at timestamptz,end_at timestamptz);
 """+helper+";REVOKE ALL ON FUNCTION fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC;")
 q("""INSERT INTO accounting_cash_rake_sources SELECT md5('current'||n)::uuid,md5('cash')::uuid,md5('union')::uuid,'2026-10-08 07:00Z'::timestamptz+n*interval '0.1seconds',md5(n::text)::uuid,'2026-10-16 07:00Z' FROM generate_series(1,100000)n;
 INSERT INTO accounting_cash_rake_sources SELECT md5('foreign'||n)::uuid,md5('foreign')::uuid,md5('other')::uuid,'2026-10-08 07:00Z'::timestamptz+n*interval '0.1seconds',md5(n::text)::uuid,'2026-10-16 07:00Z' FROM generate_series(1,50000)n;
 INSERT INTO accounting_cash_rake_sources SELECT md5('old'||n)::uuid,md5('before')::uuid,md5('union')::uuid,'2026-10-01 07:00Z'::timestamptz+n*interval '0.1seconds',md5(n::text)::uuid,'2026-10-16 07:00Z' FROM generate_series(1,50000)n;
 INSERT INTO accounting_cash_rake_sources VALUES
 (md5('change1')::uuid,md5('change')::uuid,md5('union')::uuid,'2026-10-07 07:00Z',NULL,now()),
 (md5('change2')::uuid,md5('change')::uuid,md5('other')::uuid,'2026-10-09 07:00Z',NULL,now()),
 (md5('nullcoord')::uuid,md5('nullcoord')::uuid,NULL,'2026-10-08 07:00Z',NULL,now()),
 (md5('nullclub')::uuid,NULL,md5('union')::uuid,'2026-10-08 07:00Z',NULL,now()),
 (md5('nulltime')::uuid,md5('nulltime')::uuid,md5('union')::uuid,NULL,NULL,now()),
 (md5('cutmiss')::uuid,md5('cutmiss')::uuid,md5('union')::uuid,'2026-10-06 07:00Z',NULL,now()),
 (md5('cuthit')::uuid,md5('cuthit')::uuid,md5('union')::uuid,'2026-10-08 07:00Z',NULL,now()),
 (md5('start')::uuid,md5('start')::uuid,md5('union')::uuid,'2026-10-05 07:00Z',NULL,now()),
 (md5('end')::uuid,md5('end')::uuid,md5('union')::uuid,'2026-10-12 07:00Z',NULL,now()),
 (md5('minus')::uuid,md5('minus')::uuid,md5('union')::uuid,'-infinity',NULL,now()),
 (md5('plus')::uuid,md5('plus')::uuid,md5('union')::uuid,'infinity',NULL,now());
 INSERT INTO fixture_cutoffs VALUES(md5('cutmiss')::uuid,'2026-10-07 07:00Z'),(md5('cuthit')::uuid,'2026-10-07 07:00Z');
 INSERT INTO accounting_agreement_history VALUES(1,'membership','union_clubs','2026-10-01 07:00Z',jsonb_build_object('club_id',md5('history')::uuid,'union_id',md5('union')::uuid));
 INSERT INTO accounting_tournament_fee_sources VALUES(md5('fee')::uuid,md5('tournament')::uuid,md5('union')::uuid,md5('event')::uuid,'2026-10-06 07:00Z',md5('union')::uuid,1);
 INSERT INTO accounting_tournament_recognized_sources VALUES(md5('fee')::uuid,md5('event')::uuid,'2026-10-08 07:00Z','earned',1);
 INSERT INTO accounting_tournament_fee_recognitions VALUES(md5('event')::uuid,'2026-10-08 07:00Z','recognized',md5('union')::uuid);
 INSERT INTO accounting_rakeback_period_calculations VALUES(md5('calculation')::uuid,md5('union')::uuid,'2026-10-05','2026-10-11');
 INSERT INTO settlement_periods VALUES(md5('period')::uuid,md5('union')::uuid,'2026-10-05 07:00Z','2026-10-12 07:00Z');
 VACUUM ANALYZE accounting_cash_rake_sources;
 """)
 metadata="SELECT jsonb_build_array(md5(pg_get_functiondef(oid)),proowner,prosecdef,provolatile,proconfig,proacl) FROM pg_proc WHERE oid='fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz)'::regprocedure"
 authority=q(metadata)
 # Independent aggregate oracle retains maximum of qualifying coordinator/week rows, then cutoff.
 oracle=f"SELECT coalesce(jsonb_agg(jsonb_build_object('club_id',club_id,'latest',latest) ORDER BY club_id),'[]') FROM (SELECT club_id,max(earned_at) latest FROM accounting_cash_rake_sources WHERE coordinator_union_id={u} AND earned_at>={start} AND earned_at<{end} AND club_id IS NOT NULL GROUP BY club_id)x"
 discovery="SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY club_id),'[]') FROM ("+cash+")x"
 expected=q(oracle);assert q(discovery)==expected
 whole_before=q(call)
 expected_clubs=q("SELECT jsonb_agg(md5(x)::uuid ORDER BY md5(x)::uuid) FROM unnest(ARRAY['cash','change','cuthit','start','history','tournament','calculation','period']) x")
 assert whole_before==expected_clubs,(whole_before,expected_clubs)
 plans=[json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+cash))[0]]
 migration=next((R/'supabase/migrations').glob('20261016200904_*')).read_text()
 index_sql=migration[migration.index('CREATE INDEX CONCURRENTLY'):migration.index('BEGIN;')].strip()
 q(index_sql)
 assert q(metadata)==authority
 assert q(discovery)==expected and q(call)==whole_before
 plans.append(json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+cash))[0])
 def nodes(n):
  yield n
  for x in n.get('Plans',[]):yield from nodes(x)
 after=[n for n in nodes(plans[1]['Plan']) if n.get('Index Name')=='accounting_cash_rake_sources_club_coordinator_earned' and 'coordinator_union_id' in n.get('Index Cond','') and 'earned_at' in n.get('Index Cond','')]
 assert after and all('club_id' in n['Index Cond'] for n in after),plans[1]
 blocks=lambda plan:sum(plan['Plan'].get(k,0) for k in ['Shared Hit Blocks','Shared Read Blocks'])
 assert blocks(plans[0])>blocks(plans[1])*5,(blocks(plans[0]),blocks(plans[1]))
 result={'qualification':'passed','actual_full_helper_md5':'2d861ca48eea9aba964cda9b4d45f456','unchanged_function_authority':True,'authentic_existing_competing_indexes':3,'all_cash_maxima_match_independent_grouped_oracle':True,'whole_helper_matches_independent_eight_club_cohort':True,'foreign_only_absent_week_coordinator_change_null_cutoff_halfopen_boundaries':True,'new_index_uses_both_equalities_and_time_range':True,'old_blocks':blocks(plans[0]),'new_blocks':blocks(plans[1]),'old_ms':plans[0]['Execution Time'],'new_ms':plans[1]['Execution Time'],'production_installation':False,'financial_close_qualified':False}
 print(json.dumps(result))
finally:
 if started:run([pg/'pg_ctl','-D',D,'-m','fast','-w','stop'])
 shutil.rmtree(C)
