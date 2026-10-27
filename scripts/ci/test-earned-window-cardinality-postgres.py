#!/usr/bin/env python3
"""Actual old/new cardinality proof over the maintained effective earning view."""
import argparse,os,socket,tempfile,subprocess,json,re,hashlib,shutil
from pathlib import Path
ap=argparse.ArgumentParser();ap.add_argument('--pg-bin',type=Path,required=True);ap.add_argument('--scratch',type=Path,required=True);a=ap.parse_args();root=Path(__file__).resolve().parents[2]
b=Path(tempfile.mkdtemp(prefix='earned-cardinality-',dir=a.scratch.resolve()));pg=a.pg_bin
with socket.socket()as s:s.bind(('127.0.0.1',0));port=str(s.getsockname()[1])
env={**os.environ,'TMPDIR':str(b)};started=False
original=(root/'scripts/ci/fixtures/earned-plan-window-original.sql').read_text()
migration=(root/'supabase/migrations/20261026232607_earned_window_checks_each_hand_cardinality_once.sql').read_text()
def run(argv,sql=None,error=None):
 r=subprocess.run([str(x)for x in argv],input=sql,text=True,capture_output=True,env=env,timeout=90)
 if error:assert r.returncode and error in r.stderr,r.stdout+r.stderr
 else:assert r.returncode==0,r.stdout+r.stderr
 return r.stdout.strip()
def q(s,error=None):return run([pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','postgres'],s,error)
def q3(body):return '(SELECT count(*) FROM cw c LEFT JOIN rw r'+body.split('(SELECT count(*) FROM cw c LEFT JOIN rw r',1)[1].split(' AS q3,',1)[0]
def meta():return q("SELECT jsonb_build_array(proowner,provolatile,prosecdef,proisstrict,proconfig,proacl::text) FROM pg_proc WHERE oid='fn_accounting_union_earned_plan_window(uuid,timestamptz,timestamptz)'::regprocedure")
try:
 run([pg/'initdb','-D',b/'d','-U','postgres','-A','trust','--no-locale','-E','UTF8']);run([pg/'pg_ctl','-D',b/'d','-l',b/'log','-o',f"-h 127.0.0.1 -k '' -p {port}",'-w','start']);started=True
 q("CREATE TABLE accounting_cash_accrual_cutover(singleton boolean,starts_at timestamptz);CREATE TABLE accounting_cash_rake_sources(id uuid PRIMARY KEY,rake_record_id uuid,player_id uuid,club_id uuid,union_id uuid,coordinator_union_id uuid,earned_at timestamptz,rake_credit numeric,contract jsonb,recorded_at timestamptz);CREATE INDEX ON accounting_cash_rake_sources(rake_record_id);CREATE TABLE accounting_cash_atomic_contract_admissions(source_id uuid PRIMARY KEY,admitted_contract jsonb,admitted_at timestamptz);CREATE TABLE accounting_cash_funding_contract_admissions(source_id uuid PRIMARY KEY,funding_club_id uuid,admitted_contract jsonb,admitted_at timestamptz);")
 view=re.search(r'CREATE OR REPLACE VIEW public.accounting_effective_cash_rake_sources AS.*?;', (root/'supabase/migrations/20261026161532_unpaid_lightning_earnings_follow_the_original_funding_club.sql').read_text(),re.S).group(0);q(view)
 q(original);assert q("SELECT md5(pg_get_functiondef('fn_accounting_union_earned_plan_window(uuid,timestamptz,timestamptz)'::regprocedure))")=='5fedbe9c2594648f8999d8a427aebcfc'
 q('REVOKE ALL ON FUNCTION fn_accounting_union_earned_plan_window(uuid,timestamptz,timestamptz) FROM PUBLIC');before=meta();old=q("SELECT pg_get_functiondef('fn_accounting_union_earned_plan_window(uuid,timestamptz,timestamptz)'::regprocedure)")
 q('BEGIN;'+migration.split('BEGIN;',1)[1].rsplit('COMMIT;',1)[0]+'ROLLBACK;');assert meta()==before;assert q("SELECT md5(pg_get_functiondef('fn_accounting_union_earned_plan_window(uuid,timestamptz,timestamptz)'::regprocedure))")=='5fedbe9c2594648f8999d8a427aebcfc'
 q(migration);new=q("SELECT pg_get_functiondef('fn_accounting_union_earned_plan_window(uuid,timestamptz,timestamptz)'::regprocedure)");assert meta()==before
 q(migration,'earned_window_cardinality_original_changed')
 cte='source_cardinalities AS MATERIALIZED ('+new.split('source_cardinalities AS MATERIALIZED (',1)[1].split('  ), counts AS (',1)[0]+')'
 q("INSERT INTO accounting_cash_rake_sources SELECT md5(('s'||n)::text)::uuid,md5(('h'||n%1000)::text)::uuid,md5(('p'||n)::text)::uuid,md5(('c'||n%4)::text)::uuid,md5('union')::uuid,md5('union')::uuid,'2026-10-19 08:00Z',.01,'{}','2026-10-26 08:00Z' FROM generate_series(1,10000)n;INSERT INTO accounting_cash_atomic_contract_admissions SELECT id,'{}',now() FROM accounting_cash_rake_sources WHERE id::text<'8';INSERT INTO accounting_cash_funding_contract_admissions SELECT id,md5('funding')::uuid,'{}',now() FROM accounting_cash_rake_sources WHERE id::text>'4' AND id::text<'c';")
 q("CREATE TABLE cw AS SELECT rake_record_id,sum(rake_credit) amount,min(earned_at) banked_at FROM accounting_effective_cash_rake_sources GROUP BY rake_record_id;CREATE TABLE rw AS SELECT rake_record_id id,amount rake_amount,banked_at created_at FROM cw;CREATE TABLE bw AS SELECT rake_record_id,'accrued'::text status,banked_at earned_at FROM cw;CREATE TABLE xw AS SELECT rake_record_id,count(*)::bigint n,sum(rake_credit) total,min(earned_at) min_e,max(earned_at) max_e FROM accounting_effective_cash_rake_sources GROUP BY rake_record_id;ANALYZE;")
 key="(SELECT rake_record_id FROM cw ORDER BY rake_record_id LIMIT 1)"
 cases=[('',0),("DELETE FROM cw",0),("DELETE FROM rw WHERE id="+key,1),("UPDATE bw SET status='blocked' WHERE rake_record_id="+key,1),("DELETE FROM xw WHERE rake_record_id="+key,1),("UPDATE xw SET n=NULL WHERE rake_record_id="+key,1),("UPDATE xw SET n=0 WHERE rake_record_id="+key,1),("UPDATE xw SET total=total+.01 WHERE rake_record_id="+key,1),("UPDATE xw SET min_e=min_e-interval '1 second' WHERE rake_record_id="+key,1),("INSERT INTO cw VALUES(NULL,.1,'2026-10-19 08:00Z')",1),("DELETE FROM accounting_cash_rake_sources WHERE rake_record_id="+key,1),("INSERT INTO accounting_cash_rake_sources SELECT md5('extra')::uuid,rake_record_id,md5('extra-player')::uuid,club_id,md5('foreign-union')::uuid,md5('foreign-union')::uuid,'2026-10-18 08:00Z',.01,'{}',now() FROM accounting_cash_rake_sources WHERE rake_record_id="+key+" LIMIT 1",1),("INSERT INTO accounting_cash_funding_contract_admissions VALUES(md5('orphan')::uuid,md5('orphan-club')::uuid,'{}',now())",0),("UPDATE cw SET amount=-1 WHERE rake_record_id="+key+";INSERT INTO cw SELECT * FROM cw WHERE rake_record_id="+key,2)]
 for flag in ['on','off']:
  for change,want in cases:
   value=q("BEGIN;SET LOCAL enable_indexscan='"+flag+"';SET LOCAL enable_nestloop='"+flag+"';"+change+";SELECT "+q3(old)+";WITH "+cte+" SELECT "+q3(new)+";ROLLBACK;")
   assert value.splitlines()==[str(want),str(want)],(flag,change,value,want)
 print(json.dumps({'passed':True,'cases':len(cases)*2,'sources':10000,'same_effective_view':True,'extra_outside_scope_detected':True,'missing_null_duplicate_guards':True,'metadata_and_acl_preserved':True,'rollback_and_replay_refusal':True,'migration_sha256':hashlib.sha256(migration.encode()).hexdigest()}))
finally:
 if started:run([pg/'pg_ctl','-D',b/'d','-m','immediate','-w','stop'])
 shutil.rmtree(b)
