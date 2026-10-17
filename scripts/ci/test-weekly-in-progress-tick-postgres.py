#!/usr/bin/env python3
"""Exact whole-function installer proof and scope-ordering parity for the in-progress tick fast path (PG17, native only)."""
import argparse,hashlib,json,os,random,shutil,subprocess,sys,tempfile,time
from pathlib import Path
R=Path(__file__).resolve().parents[2];F=R/'scripts/ci/fixtures/weekly-in-progress-tick'
ap=argparse.ArgumentParser();ap.add_argument('--pg-bin',default=os.getenv('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'if sys.platform=='darwin'else'/usr/lib/postgresql/17/bin'));ap.add_argument('--scratch',type=Path);ap.add_argument('--migration',type=Path)
a=ap.parse_args();scratch=a.scratch or Path(tempfile.gettempdir());scratch.mkdir(parents=True,exist_ok=True)
if sys.platform=='darwin':assert str(scratch).startswith('/Volumes/SmarterWork/agent-work/')
C=Path(tempfile.mkdtemp(prefix='native-',dir=scratch));D=C/'d';PG=Path(a.pg_bin);started=False
PS=[PG/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',C,'-U','postgres','-d','postgres']
def run(cmd,s=None,error=None):
 r=subprocess.run(list(map(str,cmd)),input=s,text=True,capture_output=True,timeout=120)
 if error:assert r.returncode and error in r.stderr,(error,r.stdout+r.stderr)
 else:assert r.returncode==0,r.stdout+r.stderr
 return r.stdout.strip()
def q(s,error=None):return run(PS,s,error)
SIG='public.fn_process_weekly_accounting_scope(uuid,uuid)'
before=(F/'scope-before.sql').read_text();after=(F/'scope-after.sql').read_text();pin=json.loads((F/'replacements.json').read_text())[0]
md5=lambda x:hashlib.md5(x.encode()).hexdigest()
assert md5(before)==pin['before'] and md5(after)==pin['after'] and before.count(pin['old'])==1 and before.replace(pin['old'],pin['new'])==after
NOW="'2026-10-17 11:05:00Z'::timestamptz"
def scan(defn):
 s=defn.index('        WITH cash_clubs AS MATERIALIZED');e=defn.index('      LOOP',s)
 return defn[s:e].replace('v_to',f'public.fn_union_week_start({NOW})').replace('v_now',NOW)
QB,QA=scan(before),scan(after)
def rows(x):return json.loads(q("SELECT coalesce(json_agg(z),'[]') FROM (\n"+x+"\n) z;"))
report={}
try:
 assert ' 17.'in run([PG/'postgres','--version']);run([PG/'initdb','-D',D,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
 with(D/'postgresql.conf').open('a')as f:f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(C)+"'\nshared_buffers='16MB'\n")
 run([PG/'pg_ctl','-D',D,'-l',C/'server.log','-w','start']);started=True
 q("""CREATE TABLE fixture_control(frozen boolean DEFAULT false,boundary timestamptz,sourceok boolean DEFAULT true,generation text DEFAULT 'preserved');INSERT INTO fixture_control DEFAULT VALUES;
 CREATE FUNCTION fn_platform_frozen()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT frozen FROM fixture_control$$;
 CREATE FUNCTION fn_active_maintenance_release_boundary()RETURNS timestamptz LANGUAGE sql STABLE AS $$SELECT boundary FROM fixture_control$$;
 CREATE SCHEMA smarter_private;CREATE SCHEMA supabase_migrations;CREATE TABLE supabase_migrations.schema_migrations(version text);
 CREATE FUNCTION smarter_private.original_inventory_proof_sources_match()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT sourceok FROM fixture_control$$;
 CREATE FUNCTION smarter_private.original_inventory_basis_generation()RETURNS text LANGUAGE sql STABLE AS $$SELECT generation FROM fixture_control$$;
 CREATE ROLE fixture_owner;
 CREATE FUNCTION fn_union_week_start(timestamptz)RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$SELECT date_trunc('week',$1 AT TIME ZONE 'America/Los_Angeles')AT TIME ZONE 'America/Los_Angeles'$$;
 CREATE FUNCTION fn_union_prev_week_start(timestamptz)RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$SELECT fn_union_week_start(fn_union_week_start($1)-interval '1 day')$$;
 CREATE FUNCTION fn_union_accounting_run_at(timestamptz)RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$SELECT $1+interval '2 hours'$$;
 CREATE TABLE fixture_cutoffs(club_id uuid PRIMARY KEY,cutoff_at timestamptz);CREATE TABLE fixture_floors(club_id uuid PRIMARY KEY,floor_week timestamptz);
 CREATE FUNCTION fn_ca_launch_accounting_cutoff(text,uuid)RETURNS timestamptz LANGUAGE sql STABLE AS $$SELECT cutoff_at FROM fixture_cutoffs WHERE club_id=$2$$;
 CREATE FUNCTION fn_club_settlement_floor_week(uuid)RETURNS timestamptz LANGUAGE sql STABLE AS $$SELECT floor_week FROM fixture_floors WHERE club_id=$1$$;
 CREATE TABLE unions(id uuid PRIMARY KEY);CREATE TABLE union_settlement_floor(union_id uuid PRIMARY KEY,earliest_period_start timestamptz);
 CREATE TABLE clubs(id uuid PRIMARY KEY,is_union boolean);CREATE TABLE union_clubs(union_id uuid,club_id uuid);
 CREATE TABLE agents(club_id uuid,is_prepaid boolean,credit_used numeric);
 CREATE TABLE rakeback_periods(club_id uuid,status text,period_start date,period_end date,rakeback_amount numeric);
 CREATE TABLE accounting_cash_rake_sources(club_id uuid,coordinator_union_id uuid,earned_at timestamptz);
 CREATE INDEX accounting_cash_rake_sources_coordinator_period ON accounting_cash_rake_sources(coordinator_union_id,earned_at,club_id);
 CREATE TABLE accounting_payable_earning_sources(source_type text,club_id uuid,coordinator_union_id uuid,earned_at timestamptz);
 CREATE TABLE union_accounting_runs(union_id uuid,standalone_club_id uuid,period_start timestamptz,period_end timestamptz,status text,result jsonb,started_at timestamptz,last_scheduler_visit_at timestamptz,
  scope_kind text GENERATED ALWAYS AS (CASE WHEN union_id IS NOT NULL THEN 'union' ELSE 'club' END) STORED,scope_id uuid GENERATED ALWAYS AS (COALESCE(union_id,standalone_club_id)) STORED);
 CREATE TABLE weekly_accounting_scheduler_visits(scope_kind text,scope_id uuid,last_visit_at timestamptz,last_outcome text,last_error jsonb,unfinished_visits int,PRIMARY KEY(scope_kind,scope_id));""")
 # Whole-function installer proof against the exact production pre-image.
 q(before+';\nREVOKE ALL ON FUNCTION '+SIG+' FROM PUBLIC;')
 assert q(f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure));")==pin['before']
 meta=f"SELECT jsonb_build_array(proowner::regrole,prosecdef,provolatile,proconfig,proacl::text) FROM pg_proc WHERE oid='{SIG}'::regprocedure;"
 m0=q(meta)
 mp=a.migration or R/'supabase/migrations/20261017121500_an_in_progress_close_is_visited_without_the_whole_scan.sql';mig=mp.read_text()
 refusals=[("SET LOCAL request.jwt.claims='{}';",'operator_refused'),("SET LOCAL request.jwt.claim.role='service_role';",'operator_refused'),('SET LOCAL ROLE fixture_owner;','operator_refused'),
  ("SET LOCAL ca.break_window_migration_override='x';",'freeze_or_override_refused'),('UPDATE fixture_control SET frozen=true;','freeze_or_override_refused'),("UPDATE fixture_control SET boundary=now();",'freeze_or_override_refused'),
  ("INSERT INTO supabase_migrations.schema_migrations VALUES('20261017121500');",'history_replay'),('UPDATE fixture_control SET sourceok=false;','inventory_seal_required'),('UPDATE fixture_control SET generation=NULL;','inventory_seal_required'),
  (f'ALTER FUNCTION {SIG} SECURITY INVOKER;','preimage_authority_refused'),(f'ALTER FUNCTION {SIG} SET search_path=pg_catalog;','preimage_authority_refused'),(f'GRANT EXECUTE ON FUNCTION {SIG} TO PUBLIC;','preimage_authority_refused'),(f'ALTER FUNCTION {SIG} OWNER TO fixture_owner;','preimage_authority_refused')]
 for inject,err in refusals:
  q(mig.replace('BEGIN;','BEGIN;'+inject,1),'in_progress_tick_'+err)
  assert q(f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure));")==pin['before'] and q(meta)==m0
 q(mig.replace('COMMIT;',"DO $$BEGIN RAISE EXCEPTION 'native_forced_rollback';END$$;COMMIT;"),'native_forced_rollback')
 assert q(f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure));")==pin['before']
 holder=subprocess.Popen(list(map(str,PS)),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 holder.stdin.write("BEGIN;SELECT pg_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0));SELECT pg_sleep(2);COMMIT;\n");holder.stdin.close()
 for _ in range(200):
  if q("SELECT count(*)FROM pg_locks WHERE locktype='advisory' AND granted;")!='0':break
  time.sleep(.01)
 q(mig,'in_progress_tick_scheduler_owned');holder.wait(timeout=10);assert holder.returncode==0
 q(mig)
 assert q(f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure));")==pin['after'] and q(meta)==m0
 q(mig,'in_progress_tick_preimage_authority_refused')
 report.update(actual_migration_sha256=hashlib.sha256(mig.encode()).hexdigest(),guard_refusals=len(refusals)+3,atomic_rollback=True,metadata_unchanged=True,source40_generation_preserved=True)
 # Ordering parity: the new scan is the full scan, or exactly its in-progress prefix.
 rnd=random.Random(20261017);U=lambda n:str(__import__('uuid').UUID(md5(n)));weeks=['2026-09-21 07:00Z','2026-09-28 07:00Z','2026-10-05 07:00Z','2026-10-12 07:00Z']
 end=lambda w:f"fn_union_week_start('{w}'::timestamptz+interval '8 days')"
 cases=owned=0
 for case in range(400):
  sql=["TRUNCATE unions,union_settlement_floor,clubs,union_clubs,agents,rakeback_periods,accounting_cash_rake_sources,accounting_payable_earning_sources,union_accounting_runs,weekly_accounting_scheduler_visits,fixture_cutoffs,fixture_floors;"]
  for i in range(rnd.randint(1,3)):
   u=U(f'u{i}');sql.append(f"INSERT INTO unions VALUES('{u}');INSERT INTO clubs VALUES('{u}',true);")
   if rnd.random()<.7:sql.append(f"INSERT INTO union_settlement_floor VALUES('{u}',{rnd.choice(['NULL',repr(weeks[0]),repr(weeks[1]),repr('2026-09-23 00:00Z')])});")
   for w in rnd.sample(weeks,rnd.randint(0,3)):
    st=rnd.choice(['running','complete','failed']);cc=rnd.choice(['true','false'])
    sql.append(f"INSERT INTO union_accounting_runs(union_id,period_start,period_end,status,result,started_at,last_scheduler_visit_at)VALUES('{u}','{w}',{end(w)},'{st}',jsonb_build_object('chunk_committed',{cc},'success',{rnd.choice(['true','false'])},'accounting_version','3'),'{w}'::timestamptz+interval '{rnd.randint(1,900)} hours',{rnd.choice(['NULL',repr('2026-10-17 10:%02d:00Z'%rnd.randint(0,59))])});")
   if rnd.random()<.8:
    o=rnd.choice(['visited','error','statement_timeout']);ipv=rnd.choice(['NULL',"'{\"in_progress_visit\":true}'","'{\"x\":1}'"])
    sql.append(f"INSERT INTO weekly_accounting_scheduler_visits VALUES('union','{u}','2026-10-17 10:%02d:00Z','{o}',{ipv},1);"%rnd.randint(0,59))
  for j in range(rnd.randint(0,3)):
   c=U(f'c{j}');sql.append(f"INSERT INTO clubs VALUES('{c}',{rnd.choice(['false','NULL'])});")
   if rnd.random()<.4:sql.append(f"INSERT INTO fixture_floors VALUES('{c}','{rnd.choice(weeks)}');")
   if rnd.random()<.3:sql.append(f"INSERT INTO fixture_cutoffs VALUES('{c}','{rnd.choice(weeks)}');")
   for k in range(rnd.randint(0,4)):sql.append(f"INSERT INTO accounting_cash_rake_sources VALUES('{c}',NULL,'{rnd.choice(weeks)}'::timestamptz+interval '{rnd.randint(0,200)} hours');")
   if rnd.random()<.4:sql.append(f"INSERT INTO accounting_payable_earning_sources VALUES('tournament_fee_accrual','{c}',NULL,'{rnd.choice(weeks)}'::timestamptz+interval '5 hours');")
   if rnd.random()<.3:sql.append(f"INSERT INTO rakeback_periods VALUES('{c}','pending','2026-09-28','2026-10-04',1);")
   if rnd.random()<.2:sql.append(f"INSERT INTO agents VALUES('{c}',false,5);")
   for w in rnd.sample(weeks,rnd.randint(0,2)):
    sql.append(f"INSERT INTO union_accounting_runs(standalone_club_id,period_start,period_end,status,result,started_at)VALUES('{c}','{w}',{end(w)},'{rnd.choice(['running','complete','failed'])}',jsonb_build_object('chunk_committed',{rnd.choice(['true','false'])}),'{w}');")
   if rnd.random()<.6:sql.append(f"INSERT INTO weekly_accounting_scheduler_visits VALUES('club','{c}','2026-10-17 10:%02d:00Z','{rnd.choice(['visited','error','statement_timeout'])}',NULL,0);"%rnd.randint(0,59))
  q(''.join(sql));B=rows(QB);A=rows(QA)
  club_busy=q(f"SELECT EXISTS(SELECT 1 FROM union_accounting_runs WHERE scope_kind='club' AND status='running' AND result->>'chunk_committed'='true' AND period_end<={NOW});")=='t'
  expect_owned=(not club_busy) and any(r['in_progress'] for r in B)
  if expect_owned:
   prefix=[];[prefix.append(r) for r in B if r['in_progress']]
   assert all(r['in_progress'] for r in B[:len(prefix)]),B
   assert A==B[:len(prefix)] and A[0]==B[0],(A,B);owned+=1
  else:assert A==B,(A,B)
  cases+=1
 assert owned>=50 and cases-owned>=50,(owned,cases)
 # Plan proof: an owned tick reads none of the standalone earning scan.
 q("TRUNCATE unions,union_settlement_floor,clubs,union_accounting_runs,weekly_accounting_scheduler_visits,accounting_cash_rake_sources,accounting_payable_earning_sources;"
   f"INSERT INTO unions VALUES('{U('u')}');INSERT INTO union_settlement_floor VALUES('{U('u')}','2026-09-21 07:00Z');"
   f"INSERT INTO union_accounting_runs(union_id,period_start,period_end,status,result,started_at)VALUES('{U('u')}','2026-10-05 07:00Z',{end('2026-10-05 07:00Z')},'running','{{\"chunk_committed\":true,\"stage\":\"certifying\"}}','2026-10-17 10:05Z');"
   f"INSERT INTO clubs VALUES('{U('s')}',false);INSERT INTO accounting_cash_rake_sources SELECT '{U('s')}',NULL,'2026-09-25 07:00Z'::timestamptz+n*interval '1 second' FROM generate_series(1,20000)n;"
   f"INSERT INTO accounting_payable_earning_sources SELECT 'tournament_fee_accrual','{U('s')}',NULL,'2026-09-25 07:00Z'::timestamptz+n*interval '1 second' FROM generate_series(1,20000)n;ANALYZE;")
 pb=json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)'+QB))[0];pa=json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)'+QA))[0]
 def nodes(n):
  yield n
  for c in n.get('Plans',[]):yield from nodes(c)
 big=lambda p:[n for n in nodes(p['Plan'])if n.get('Relation Name')in('accounting_cash_rake_sources','accounting_payable_earning_sources')]
 assert sum(n.get('Actual Rows',0)*n.get('Actual Loops',0) for n in big(pb))>=40000
 assert all(n.get('Actual Loops',0)==0 for n in big(pa)),big(pa)
 blocks=lambda p:p['Plan'].get('Shared Hit Blocks',0)+p['Plan'].get('Shared Read Blocks',0)
 assert blocks(pa)*10<blocks(pb),(blocks(pa),blocks(pb))
 assert rows(QA)==[r for r in rows(QB) if r['in_progress']] and len(rows(QA))==1
 report.update(qualification='passed',ordering_cases=cases,owned_ticks=owned,full_scan_ticks=cases-owned,owned_tick_scan_never_executed=True,
  owned_tick_blocks=blocks(pa),full_scan_blocks=blocks(pb),production_financial_operation_qualified=False)
 (scratch/'weekly-in-progress-tick-native-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
finally:
 if started:run([PG/'pg_ctl','-D',D,'-m','fast','-w','stop'])
 shutil.rmtree(C,ignore_errors=True)
