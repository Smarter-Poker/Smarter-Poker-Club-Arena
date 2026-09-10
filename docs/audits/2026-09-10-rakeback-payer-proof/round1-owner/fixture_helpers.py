"""Shared NATIVE ONLY actual-owner helper with explicitly synthetic calendar stamps."""
import os,subprocess,json
from pathlib import Path
psql=os.environ['COMMISSION_PSQL']
here=Path(os.environ['ROUND1_HERE'])
def sql(s,ok=True,actor=100):
 auth=f"SELECT set_config('request.jwt.claim.sub',test_id({actor})::text,false);"
 r=subprocess.run([psql,'-X','-qAt','-v','ON_ERROR_STOP=1','-c',auth+s],text=True,capture_output=True)
 if ok and r.returncode: raise RuntimeError(r.stderr+'\nSQL:'+s[:800])
 if not ok and not r.returncode: raise AssertionError('Expected failure: '+s[:500])
 return '\n'.join(r.stdout.strip().splitlines()[1:]) if ok else r.stderr
def setup():
 body=(Path(os.environ['ROUND1_INPUT'])/'source-authority/owner-composition/exercise.sql').read_text()
 body=body[body.index('CREATE FUNCTION public.test_owner('):body.index('SELECT (test_owner(1000001)')]
 body=body.replace('test_owner(p_hand bigint)','test_owner_amount(p_hand bigint,p_rake numeric)')
 for old,new in [("saved->'stacks',2,0","saved->'stacks',p_rake,0"),
  ('THEN 98 ELSE','THEN (100-p_rake) ELSE'),("'rake_amount',2,","'rake_amount',p_rake,"),
  ("'amount',198","'amount',200-p_rake"),("'amount',2,'bbj'","'amount',p_rake,'bbj'"),
  ('p_hand,stacks,2,0','p_hand,stacks,p_rake,0')]:
  assert old in body,old
  body=body.replace(old,new)
 sql(body)
 sql("""CREATE FUNCTION public.test_funding_state() RETURNS jsonb LANGUAGE plpgsql AS $f$
 DECLARE t record;j jsonb;result jsonb:='{}';
 BEGIN FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename LOOP
 EXECUTE format('SELECT coalesce(jsonb_agg(j ORDER BY j::text),''[]'') FROM (SELECT to_jsonb(x) j FROM public.%I x) z',t.tablename) INTO j;
 result:=result||jsonb_build_object(t.tablename,j);END LOOP;RETURN result;END $f$;""")
def source(n,rake,accepted_at=None,bank_at=None):
 # rate/route changes are separate explicit setup, captured by the actual owner.
 def setting(k,v): return "SELECT set_config('"+k+"','"+(v or '')+"',false);"
 settings=setting('test.funding_accepted_at',accepted_at)+setting('test.funding_bank_at',bank_at)
 sql(settings+f"SELECT test_owner_amount({n},{rake});")
 result=sql(settings+f"""SELECT row_to_json(b) FROM atomic_distribute_rake(test_id(950),test_id(900),test_id({n}),{n},{rake},0,200,2,
 jsonb_build_object(test_id(201)::text,100,test_id(202)::text,100),NULL,'{{}}','WEIGHTED_CONTRIBUTED') b;""")
 return json.loads(result.splitlines()[-1])
def admit(n):
 return json.loads(sql(f"SELECT fn_ca_admit_source_funding(test_id({n}),test_id(900));"))
def pool(n):
 return sql(f"SELECT pool_id FROM ca_source_funding_lots WHERE hand_id=test_id({n}) LIMIT 1;")
def release(p,cutoff,request):
 return json.loads(sql(f"SELECT fn_release_captured_club_funding('{p}','{cutoff}',test_id({request}),test_id(100));"))
def state(): return sql("SELECT test_funding_state();")
