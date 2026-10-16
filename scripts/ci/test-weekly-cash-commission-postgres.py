#!/usr/bin/env python3
"""Exact commission reader PG17 qualification. No remote database."""
import argparse,hashlib,json,os,shutil,subprocess,sys,tempfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--pg-bin',required=True);p.add_argument('--scratch',required=True);a=p.parse_args()
if os.environ.get('DATABASE_URL'):raise RuntimeError('remote database forbidden')
R=Path(__file__).resolve().parents[2];F=R/'scripts/ci/fixtures/weekly-cash-access';scratch=Path(a.scratch).resolve()
if sys.platform=='darwin' and not str(scratch).startswith('/Volumes/SmarterWork/agent-work/'):raise RuntimeError('external scratch required')
C=Path(tempfile.mkdtemp(prefix='cc-',dir=scratch));D=C/'d';pg=Path(a.pg_bin);started=False
psql=[pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',C,'-U','postgres','-d','postgres']
def run(cmd,s=None):
 r=subprocess.run(list(map(str,cmd)),input=s,text=True,capture_output=True,timeout=90)
 assert r.returncode==0,r.stdout+r.stderr
 return r.stdout.strip()
def q(s):return run(psql,s)
u="md5('union')::uuid";c="md5('club')::uuid";f="'2026-10-05 07:00Z'::timestamptz";t="'2026-10-12 07:00Z'::timestamptz"
before=(F/'commission-before.sql').read_text();after=(F/'commission-after.sql').read_text()
assert hashlib.md5(before.encode()).hexdigest()=='3143ddd4ec0f5eb3312700a1dd2b5b83'
assert hashlib.md5(after.encode()).hexdigest()=='0df1c3e9fe3e1a0e53a043baf57127d7'
try:
 assert ' 17.' in run([pg/'postgres','--version'])
 run([pg/'initdb','-D',D,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
 with (D/'postgresql.conf').open('a') as h:h.write("\nlisten_addresses=''\nunix_socket_directories='"+str(C)+"'\n")
 run([pg/'pg_ctl','-D',D,'-l',C/'server.log','-w','start']);started=True
 q("""CREATE ROLE service_role;CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid()RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULL::uuid$$;
 CREATE FUNCTION fn_caller_is_engine()RETURNS boolean LANGUAGE plpgsql STABLE AS $$BEGIN RETURN true;END$$;
 CREATE FUNCTION fn_is_union_overseer(uuid,uuid)RETURNS boolean LANGUAGE plpgsql STABLE AS $$BEGIN RETURN false;END$$;
 CREATE TABLE rake_records(id uuid PRIMARY KEY,club_id uuid,hand_id uuid,table_id uuid,metadata jsonb,created_at timestamptz,rake_amount numeric,is_tournament boolean,tournament_id uuid);
 CREATE INDEX idx_rake_records_date ON rake_records(created_at);
 CREATE INDEX rake_records_cash_positive_created ON rake_records(created_at,id) WHERE rake_amount>0 AND is_tournament IS NOT TRUE AND tournament_id IS NULL;
 CREATE TABLE accounting_cash_accrual_batches(rake_record_id uuid PRIMARY KEY,status text,payload text);
 CREATE TABLE union_clubs(union_id uuid,club_id uuid);
 CREATE TABLE rake_attributions(rake_record_id uuid,club_id uuid);
 CREATE INDEX rake_attributions_club_record ON rake_attributions(club_id,rake_record_id);
 CREATE TABLE fixture_cutoffs(club_id uuid PRIMARY KEY,at timestamptz);
 CREATE FUNCTION fn_rake_record_is_ghost_twin(uuid,uuid,jsonb)RETURNS boolean LANGUAGE plpgsql STABLE AS $$BEGIN RETURN coalesce($3->>'ghost','false')='true';END$$;
 CREATE FUNCTION fn_ca_launch_accounting_accepts(uuid,timestamptz)RETURNS boolean LANGUAGE plpgsql STABLE AS $$DECLARE c timestamptz;BEGIN SELECT at INTO c FROM fixture_cutoffs WHERE club_id=$1;RETURN c IS NULL OR $2>=c;END$$;
 """+before+";REVOKE ALL ON FUNCTION fn_assert_cash_commission_period(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC;GRANT EXECUTE ON FUNCTION fn_assert_cash_commission_period(uuid,uuid,timestamptz,timestamptz) TO service_role;"+before.replace('public.fn_assert_cash_commission_period','public.fixture_before',1))
 authority=q("SELECT jsonb_build_array(proowner,prosecdef,provolatile,proacl,proconfig) FROM pg_proc WHERE oid='fn_assert_cash_commission_period(uuid,uuid,timestamptz,timestamptz)'::regprocedure;")
 q(after)
 assert q("SELECT md5(pg_get_functiondef('fn_assert_cash_commission_period(uuid,uuid,timestamptz,timestamptz)'::regprocedure));")=='0df1c3e9fe3e1a0e53a043baf57127d7'
 assert authority==q("SELECT jsonb_build_array(proowner,prosecdef,provolatile,proacl,proconfig) FROM pg_proc WHERE oid='fn_assert_cash_commission_period(uuid,uuid,timestamptz,timestamptz)'::regprocedure;")
 base="INSERT INTO rake_records VALUES(md5('r')::uuid,md5('club')::uuid,md5('hand')::uuid,md5('table')::uuid,'{}','2026-10-08 07:00Z',1,false,NULL);INSERT INTO union_clubs VALUES(md5('union')::uuid,md5('club')::uuid);"
 # Expected refusal is specified independently for each input mutation.
 cases=[('missing batch','',True),('null tournament',"UPDATE rake_records SET is_tournament=NULL",True),('true tournament',"UPDATE rake_records SET is_tournament=true",False),('non-null event',"UPDATE rake_records SET tournament_id=md5('event')::uuid",False),('zero rake',"UPDATE rake_records SET rake_amount=0",False),('null rake',"UPDATE rake_records SET rake_amount=NULL",False),('negative rake',"UPDATE rake_records SET rake_amount=-1",False),('start inclusive',"UPDATE rake_records SET created_at='2026-10-05 07:00Z'",True),('end excluded',"UPDATE rake_records SET created_at='2026-10-12 07:00Z'",False),('before excluded',"UPDATE rake_records SET created_at='2026-10-05 06:59:59.999999Z'",False),('null time',"UPDATE rake_records SET created_at=NULL",False),('accrued batch',"INSERT INTO accounting_cash_accrual_batches VALUES(md5('r')::uuid,'accrued','')",False),('pending batch',"INSERT INTO accounting_cash_accrual_batches VALUES(md5('r')::uuid,'pending','')",True),('null batch status',"INSERT INTO accounting_cash_accrual_batches VALUES(md5('r')::uuid,NULL,'')",True),('union owns directly',"TRUNCATE union_clubs;UPDATE rake_records SET club_id=md5('union')::uuid",True),('outside union',"TRUNCATE union_clubs",False),('attributed member',"UPDATE rake_records SET club_id=md5('outside')::uuid;INSERT INTO rake_attributions VALUES(md5('r')::uuid,md5('club')::uuid)",True),('attributed outside',"UPDATE rake_records SET club_id=md5('outside')::uuid;INSERT INTO rake_attributions VALUES(md5('r')::uuid,md5('outside')::uuid)",False),('null hand real',"UPDATE rake_records SET hand_id=NULL",True),('null hand ghost',"UPDATE rake_records SET hand_id=NULL,metadata='{\"ghost\":true}'",False),('nonnull hand ghost flag ignored',"UPDATE rake_records SET metadata='{\"ghost\":true}'",True),('cutoff equal',"INSERT INTO fixture_cutoffs VALUES(md5('club')::uuid,'2026-10-08 07:00Z')",True),('cutoff after',"INSERT INTO fixture_cutoffs VALUES(md5('club')::uuid,'2026-10-08 07:00:00.000001Z')",False),('null cutoff',"INSERT INTO fixture_cutoffs VALUES(md5('club')::uuid,NULL)",True)]
 def check(name,change,expected,union=u,club='NULL::uuid'):
  calls=''
  for func in ['fixture_before','fn_assert_cash_commission_period']:
   calls+=f" got:=false;BEGIN PERFORM {func}({union},{club},{f},{t});EXCEPTION WHEN SQLSTATE '55000' THEN got:=true;END;IF got IS DISTINCT FROM {'true' if expected else 'false'} THEN RAISE EXCEPTION 'independent expected mismatch: {name} {func}';END IF;"
  q('BEGIN;TRUNCATE rake_records,accounting_cash_accrual_batches,union_clubs,rake_attributions,fixture_cutoffs;'+base+change+';DO $$DECLARE got boolean;BEGIN '+calls+'END$$;ROLLBACK;')
 for name,change,expected in cases:check(name,change,expected)
 check('direct club outside union','TRUNCATE union_clubs',True,'NULL::uuid',c)
 check('attributed direct club',"TRUNCATE union_clubs;UPDATE rake_records SET club_id=md5('outside')::uuid;INSERT INTO rake_attributions VALUES(md5('r')::uuid,md5('club')::uuid)",True,'NULL::uuid',c)
 check('unrelated direct club',"UPDATE rake_records SET club_id=md5('outside')::uuid",False,'NULL::uuid',c)
 # All historical rows are already accrued: no rake heap rows or per-row functions are needed.
 q("INSERT INTO rake_records SELECT md5(n::text)::uuid,md5('club')::uuid,md5(n::text)::uuid,md5('table')::uuid,jsonb_build_object('large',repeat('x',1000)),'2026-10-08 07:00Z',1,false,NULL FROM generate_series(1,50000)n;INSERT INTO accounting_cash_accrual_batches SELECT id,'accrued',repeat('z',500) FROM rake_records;VACUUM ANALYZE rake_records;VACUUM ANALYZE accounting_cash_accrual_batches;")
 def sqlpred(src):
  start=src.index('  WITH unaccrued');s=src[start:src.index('\n THEN RAISE',start)].rstrip();assert s.endswith(')');s=s[:-1]
  for x,y in [('p_union_id',u),('p_club_id','NULL::uuid'),('p_from',f),('p_to',t)]:s=s.replace(x,y)
  return 'SELECT EXISTS('+s+')'
 plans=[json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+sqlpred(s)))[0] for s in [before,after]]
 def nodes(n):
  yield n
  for child in n.get('Plans',[]):yield from nodes(child)
 oldnodes=list(nodes(plans[0]['Plan']));newnodes=list(nodes(plans[1]['Plan']))
 assert not any(n['Node Type']=='Index Only Scan' and n.get('Index Name')=='rake_records_cash_positive_created' for n in oldnodes)
 assert any(n['Node Type']=='Index Only Scan' and n.get('Index Name')=='rake_records_cash_positive_created' and n.get('Heap Fetches')==0 for n in newnodes)
 assert all(n['Actual Loops']==0 for n in newnodes if n.get('Index Name')=='rake_records_pkey')
 assert any(n.get('Index Name')=='rake_records_pkey' for n in newnodes)
 q("INSERT INTO rake_records VALUES(md5('missing')::uuid,md5('club')::uuid,NULL,md5('table')::uuid,'{}','2026-10-08 07:00Z',1,false,NULL);INSERT INTO union_clubs VALUES(md5('union')::uuid,md5('club')::uuid);")
 assert q(sqlpred(after))=='t'
 mixed=json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+sqlpred(after)))[0]
 mixednodes=list(nodes(mixed['Plan']))
 assert any(n.get('Index Name')=='rake_records_pkey' and n['Actual Loops']==1 for n in mixednodes)
 assert any(n.get('CTE Name')=='unaccrued' and n.get('Actual Rows')==1 for n in mixednodes)
 plans.append(mixed)
 result={'qualification':'passed','independent_expected_cases':len(cases)+3,'mostly_accrued_rows':50000,'actual_before_after':True,'before_not_partial_index_only':True,'after_partial_index_only_zero_heap':True,'outer_rake_heap_and_helpers_never_executed_when_accrued':True,'mixed_scale_only_one_unaccrued_heap_lookup':True,'metadata_unchanged':True,'production_close_qualified':False}
 print(json.dumps(result))
finally:
 if started:run([pg/'pg_ctl','-D',D,'-m','fast','-w','stop'])
 shutil.rmtree(C)
