#!/usr/bin/env python3
"""Actual PG17 wrapper/calculator/recognizer lock ordering, on private local PG only."""
import hashlib,json,os,select,shutil,subprocess,tempfile,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
FIX=ROOT/'tests/fixtures/mixed-rake-period/request-lock'
MIGRATION=ROOT/'supabase/migrations/20260927154806_open_week_pages_lock_the_recompute_request_after_calculation.sql'
PG=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
ENV={'PATH':str(PG)+':/usr/bin:/bin','LANG':'C','LC_ALL':'C'}
CLUSTER=Path(tempfile.mkdtemp(prefix='request-lock-',dir=os.environ.get('TMPDIR')))
SOCKET=Path(tempfile.mkdtemp(prefix='rw-sock-',dir='/tmp'))
started=False; children=[]
def run(argv,sql=None,expected=None,timeout=90):
 p=subprocess.run(list(map(str,argv)),input=sql,text=True,capture_output=True,env=ENV,timeout=timeout)
 if expected: assert p.returncode and expected in p.stderr,p.stdout+p.stderr
 elif p.returncode: raise RuntimeError(p.stdout+p.stderr)
 return p

def args(user='postgres'):
 return [str(PG/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(SOCKET),'-U',user,'-d','postgres']
def q(sql,user='postgres',expected=None):return run(args(user),sql,expected).stdout.strip()
def file(path,user='postgres'):return run(args(user)+['-f',str(path)]).stdout

def ok(cond,label):
 assert cond,label
 print('PASS: '+label,flush=True)
def session(sql,user='postgres'):
 p=subprocess.Popen(args(user),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=ENV,bufsize=1)
 children.append(p); p.stdin.write(sql+'\n');p.stdin.flush();return p

def marker(p,word,timeout=12):
 until=time.monotonic()+timeout; collected=b''
 while time.monotonic()<until:
  if select.select([p.stdout],[],[],.1)[0]:
   chunk=os.read(p.stdout.fileno(),65536)
   if not chunk:raise RuntimeError(p.stderr.read())
   collected+=chunk
   if word.encode() in collected:return
 raise AssertionError('missing marker '+word)

def finish(p,sql='COMMIT;'):
 if p.poll() is None:p.stdin.write(sql+'\n');p.stdin.close()
 p.wait(timeout=20)
 out=p.stdout.read();err=p.stderr.read()
 if p.returncode:raise RuntimeError(out+err)
 return out.strip()
def await_sql(sql,label,timeout=12):
 until=time.monotonic()+timeout
 while time.monotonic()<until:
  if q(sql,user='fixture_admin')=='t':return
  time.sleep(.04)
 raise AssertionError(label)
def catalog():
 return json.loads(q("SELECT jsonb_object_agg(proname,jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,'volatility',provolatile,'definition',pg_get_functiondef(oid))) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('fn_rakeback_recompute_periods','fn_calculate_cash_rakeback_periods','fn_accounting_tournament_week_quality','fn_recognize_accounting_tournament_fees','fn_lock_accounting_tournament_recognition_week','fn_union_week_start','fn_caller_is_engine','fn_rake_record_is_ghost_twin')"))

def page_call(start,ids="ARRAY[u(503)]"):
 return f"SELECT fn_rakeback_recompute_periods(u(20),'{start}'::date,'{start}'::date+6,{ids})"
def recognition(n):
 return f"""BEGIN;SET LOCAL statement_timeout='3s';
 INSERT INTO tournament_rake_settlements VALUES(u({n+1000}),u(20),u(40),10,transaction_timestamp());
 SELECT fn_recognize_accounting_tournament_fees(u({n+1000}),transaction_timestamp(),u(20),NULL,NULL);
 COMMIT;"""
def lock_case(original,n,week,seed_request=True):
 # Unchanged actual calculator blocks on its week-source read. No calculator
 # sleeps or test branch, and no timeout/lock behavior altered in production.
 file(FIX/('fn_rakeback_recompute_periods.sql' if original else 'wrapper-after.sql'))
 q(f"SELECT test_fee_source({n},503,20,10,clock_timestamp()-interval '10 minutes'); INSERT INTO tournaments VALUES(u({n+1000}),u(20),u(40),false);;")
 if seed_request:q(f"INSERT INTO accounting_period_recompute_requests(club_id,period_start,period_end) VALUES(u(20),'{week}','{week}'::date+6) ON CONFLICT DO NOTHING;")
 held=session("BEGIN;LOCK accounting_cash_rake_sources IN ACCESS EXCLUSIVE MODE;\\echo source_held")
 marker(held,'source_held')
 page=session("SET application_name='fixture-open-page';"+page_call(week)+';')
 page.stdin.close()
 await_sql("SELECT EXISTS(SELECT 1 FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE a.application_name='fixture-open-page' AND l.relation='accounting_cash_rake_sources'::regclass AND NOT l.granted)",'page did not reach real source read',14)
 if not seed_request:ok(q(f"SELECT NOT EXISTS(SELECT 1 FROM accounting_period_recompute_requests WHERE club_id=u(20) AND period_start='{week}')")=='t','page has not inserted a speculative request while calculation is running')
 duplicate=None
 if not original:
  duplicate=session("SET application_name='fixture-duplicate-page';"+page_call(week)+';');duplicate.stdin.close()
  await_sql("SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE a.application_name='fixture-duplicate-page' AND a.wait_event='advisory')",'duplicate page did not retain original advisory serialization',14)
 actor=session("SET application_name='fixture-recognition';"+recognition(n));actor.stdin.close()
 if original:
  await_sql("SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE a.application_name='fixture-recognition' AND cardinality(pg_blocking_pids(a.pid))>0)",'original recognizer did not block')
  actor.wait(timeout=8)
  ok(actor.returncode!=0 and 'statement timeout' in actor.stderr.read(),'baseline original request-row order blocks actual terminal recognizer')
  ok(q(f"SELECT NOT EXISTS(SELECT 1 FROM accounting_tournament_fee_recognitions WHERE tournament_id=u({n+1000})) AND NOT EXISTS(SELECT 1 FROM fixture_financial_calls WHERE identity=u({n+1000}))")=='t','blocked recognition rolls back its entire isolated financial transaction')
 else:
  actor.wait(timeout=8)
  response=actor.stdout.read();error=actor.stderr.read()
  ok(actor.returncode==0 and '"replayed": false' in response,'actual terminal recognizer commits while the page calculation remains blocked: '+error)
  ok(page.poll() is None,'recognition was not merely measured after page finished')
 finish(held)
 page.wait(timeout=20);response=page.stdout.read();error=page.stderr.read()
 ok(page.returncode==0,'actual page completes after source unlock: '+error)
 result=json.loads(response.strip())
 ok(result['request_recorded'] and result['request_state']=='pending' and result['status']=='ready','page leaves the durable book pending, never complete')
 if not original:
  duplicate.wait(timeout=20);dup=json.loads(duplicate.stdout.read().strip());err=duplicate.stderr.read()
  ok(duplicate.returncode==0 and dup['written']==0 and dup['request_state']=='pending','concurrent duplicate page reuses the certificate and remains pending: '+err)
  replay=q(f"SELECT fn_recognize_accounting_tournament_fees(u({n+1000}),transaction_timestamp(),u(20),NULL,NULL)")
  ok('"replayed": true' in replay,'actual terminal duplicate recognition reuses its original authority')
  row=json.loads(q(f"SELECT row_to_json(r) FROM accounting_period_recompute_requests r WHERE id='{result['request_id']}'"))
  ok(row['status']=='pending' and row['last_result']['status']=='ready' and row['attempts']>=1,'lost client acknowledgment is recovered from the original durable row')
 return result

def retained_request_first(start,ids,label):
 q(f"INSERT INTO accounting_period_recompute_requests(club_id,period_start,period_end) VALUES(u(20),'{start}','{start}'::date+6) ON CONFLICT DO NOTHING")
 held=session("BEGIN;LOCK accounting_cash_rake_sources IN ACCESS EXCLUSIVE MODE;\\echo closed_source_held")
 marker(held,'closed_source_held')
 page=session("SET application_name='fixture-retained-order';"+page_call(start,ids)+';');page.stdin.close()
 await_sql("SELECT EXISTS(SELECT 1 FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE a.application_name='fixture-retained-order' AND l.relation='accounting_cash_rake_sources'::regclass AND NOT l.granted)",'retained-order calculation did not block',14)
 q(f"SET lock_timeout='300ms'; UPDATE accounting_period_recompute_requests SET status=status WHERE club_id=u(20) AND period_start='{start}';",expected='lock timeout')
 finish(held);page.wait(timeout=20)
 ok(page.returncode==0,label+' retains original request-row lock before calculation: '+page.stderr.read())

def safety_cases(week):
 # Real PostgREST-like service/authenticator roles, no fake browser authority.
 q("SET ROLE authenticated; SET request.jwt.claim.role='authenticated'; SELECT fn_rakeback_recompute_periods(u(20),'2026-08-24','2026-08-30');",user='authenticator',expected='permission denied')
 q("SET ROLE service_role; SET request.jwt.claim.role='authenticated'; SELECT fn_rakeback_recompute_periods(u(20),'2026-08-24','2026-08-30');",user='authenticator',expected='accounting_period_not_authorised')
 result=json.loads(q(f"SET ROLE service_role; SET request.jwt.claim.role='service_role';{page_call(week,'ARRAY[]::uuid[]')};",user='authenticator'))
 ok(result['request_state']=='pending' and result['written']==0,'supported service role and empty page retain original scope/result')
 for expression in ["NULL,'2026-08-24','2026-08-30',NULL", "u(20),'2026-08-25','2026-08-31',NULL", "u(20),'2026-08-24','2026-08-30',ARRAY[NULL]::uuid[]", "u(20),'2026-08-24','2026-08-30',array_fill(u(503),ARRAY[2001])"]:
  q('SELECT fn_rakeback_recompute_periods('+expression+');',expected='invalid_accounting_period_request')
 ok(True,'invalid/null/oversized request guards unchanged')
 # Two actual original-order paths. Current whole-book NULL remains authoritative.
 retained_request_first('2026-08-24','ARRAY[u(503)]','closed-week page')
 retained_request_first(week,'NULL','whole current week')
 original=(FIX/'fn_rakeback_recompute_periods.sql').read_text()
 q('BEGIN;'+original+'ROLLBACK;')
 ok(q("SELECT md5(pg_get_functiondef('fn_rakeback_recompute_periods(uuid,date,date,uuid[])'::regprocedure))")==hashlib.md5((FIX/'wrapper-after.sql').read_text()[:-2].encode()).hexdigest(),'transaction rollback preserves exact installed candidate')
 q(MIGRATION.read_text(),expected='OPEN_WEEK_REQUEST_SOURCE_CHANGED')
 ok(True,'exact preimage refuses replay')
 # End-of-week predicates and full/page result transitions independently checked.
 ok(q("SELECT bool_and((c>=f AND c<t)=expected) FROM (VALUES ('2026-09-21T07:00:00Z'::timestamptz,'2026-09-28T07:00:00Z'::timestamptz,'2026-09-21T06:59:59.999999Z'::timestamptz,false),('2026-09-21T07:00:00Z','2026-09-28T07:00:00Z','2026-09-21T07:00:00Z',true),('2026-09-21T07:00:00Z','2026-09-28T07:00:00Z','2026-09-28T06:59:59.999999Z',true),('2026-09-21T07:00:00Z','2026-09-28T07:00:00Z','2026-09-28T07:00:00Z',false)) x(f,t,c,expected)")=='t','exact week start/end and future-week admission boundaries')
 ok(q(f"SELECT rake_generated=20 AND rakeback_amount=2 FROM rakeback_periods WHERE club_id=u(20) AND user_id=u(503) AND period_start='{week}'")=='t','real current calculator preserves 10 cash plus 10 recognized fees and exact 2 liability')

def drift_and_abort_cases(week):
 candidate=catalog()
 original=(FIX/'fn_rakeback_recompute_periods.sql').read_text()
 for statement,expected in [
  ("GRANT EXECUTE ON FUNCTION fn_rakeback_recompute_periods(uuid,date,date,uuid[]) TO authenticated;",'OPEN_WEEK_REQUEST_AUTHORITY_CHANGED'),
  ("ALTER FUNCTION fn_rakeback_recompute_periods(uuid,date,date,uuid[]) OWNER TO fixture_admin;",'OPEN_WEEK_REQUEST_AUTHORITY_CHANGED'),
  ("ALTER FUNCTION fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[]) SET statement_timeout='299s';",'OPEN_WEEK_REQUEST_SOURCE_CHANGED'),
  ("ALTER TABLE accounting_period_recompute_requests DISABLE ROW LEVEL SECURITY;",'OPEN_WEEK_REQUEST_TABLE_CHANGED')]:
  q('BEGIN;'+original+statement+MIGRATION.read_text(),user='fixture_admin',expected=expected)
  ok(catalog()==candidate,'failed preflight rolls back authority/source drift: '+expected)
 before=q("SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM accounting_period_recompute_requests r")
 q("SET statement_timeout='350ms';"+page_call(week)+';',expected='statement timeout')
 ok(q("SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM accounting_period_recompute_requests r")==before,'definite canceled call leaves no attempted result or false completion')
 # Empty starting request: recognition may become its original creator, and
 # the page must return that same durable identity after it completes.
 q(f"DELETE FROM accounting_period_recompute_requests WHERE club_id=u(20) AND period_start='{week}'")
 result=lock_case(False,3003,week,seed_request=False)
 ok(q(f"SELECT count(*)=1 AND min(id::text)='{result['request_id']}' FROM accounting_period_recompute_requests WHERE club_id=u(20) AND period_start='{week}'")=='t','recognizer-created request remains unique and page returns its original identity')

def rollover_case(week):
 # The only model is clock_timestamp. The generated sibling body is otherwise
 # byte-identical to the candidate; all locks/reads/financial functions are real.
 q("CREATE TABLE fixture_clock_value(value timestamptz); CREATE FUNCTION fixture_clock() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$SELECT value FROM fixture_clock_value$$;")
 q(f"INSERT INTO fixture_clock_value VALUES((('{week}'::date+7)::timestamp AT TIME ZONE 'America/Los_Angeles')-interval '1 microsecond'); INSERT INTO rake_records(id,hand_id,club_id,table_id,rake_amount,is_tournament,created_at,metadata) SELECT u(9501),u(10501),u(20),u(401),1,false,value-interval '10 seconds','{{}}' FROM fixture_clock_value; INSERT INTO rake_attributions VALUES(u(11501),u(9501),u(10501),u(503),u(20),1);")
 body=(FIX/'wrapper-after.sql').read_text().replace('public.fn_rakeback_recompute_periods(', 'public.fixture_clocked_request(',1).replace('clock_timestamp()','public.fixture_clock()')
 q(body)
 lock_key=f"hashtextextended('accounting_rakeback_period:'||u(20)::text||':{week}',0)"
 gate=session('BEGIN;SELECT pg_advisory_xact_lock('+lock_key+');\\echo admission_held');marker(gate,'admission_held')
 page=session("SET application_name='fixture-rollover';SELECT fixture_clocked_request(u(20),'"+week+"','"+week+"'::date+6,ARRAY[u(503)]);");page.stdin.close()
 await_sql("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='fixture-rollover' AND wait_event='advisory')",'rollover page did not wait for advisory admission')
 # Original witness is accrued while the caller is waiting; it must now reach
 # the real calculator, and the week crosses its boundary before admission.
 q("INSERT INTO accounting_cash_accrual_batches(rake_record_id,hand_id,earned_at,source_fingerprint,status,plan) SELECT id,hand_id,created_at,'clock-fixture','accrued','{}' FROM rake_records WHERE id=u(9501); UPDATE fixture_clock_value SET value=value+interval '1 microsecond';")
 held=session('BEGIN;LOCK accounting_cash_rake_sources IN ACCESS EXCLUSIVE MODE;\\echo rollover_source_held');marker(held,'rollover_source_held')
 finish(gate)
 await_sql("SELECT EXISTS(SELECT 1 FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE a.application_name='fixture-rollover' AND l.relation='accounting_cash_rake_sources'::regclass AND NOT l.granted)",'rollover page did not reach calculator')
 q(f"SET lock_timeout='300ms'; UPDATE accounting_period_recompute_requests SET status=status WHERE club_id=u(20) AND period_start='{week}';",expected='lock timeout')
 finish(held);page.wait(timeout=20)
 ok(page.returncode==0,'rollover caller finished through unchanged result path: '+page.stderr.read())
 result=json.loads(page.stdout.read().strip())
 ok(result['request_state']=='blocked' and result['written']==0,'week rolled over while waiting: retained early request lock and durable refusal, no complete book')
 q('DROP FUNCTION fixture_clocked_request(uuid,date,date,uuid[]); DROP FUNCTION fixture_clock(); DROP TABLE fixture_clock_value;')

def main():
 global started
 run([PG/'initdb','-D',CLUSTER/'data','-A','trust','-U','fixture_admin','--no-locale','-E','UTF8'])
 run([PG/'pg_ctl','-D',CLUSTER/'data','-l',CLUSTER/'server.log','-o',f"-k {SOCKET} -h ''",'start']);started=True
 q('CREATE ROLE postgres LOGIN SUPERUSER;',user='fixture_admin')
 paths=['tests/fixtures/accounting-agreement-history/bootstrap.sql',
 'supabase/migrations/20260914120926_accounting_agreements_preserve_observed_history.sql',
 'tests/fixtures/cash-rake-earning-evidence/bootstrap.sql',
 'supabase/migrations/20260914132929_cash_rakeback_reads_observed_earning_evidence.sql',
 'tests/fixtures/cash-rake-earning-evidence/period-writer-bootstrap.sql',
 'supabase/accounting/weekly-v3/components/20260914132216_cash_rakeback_periods_require_one_certified_week.sql',
 'tests/fixtures/mixed-rake-period/schema.sql','tests/fixtures/mixed-rake-period/tournament-authority.sql',
 'supabase/accounting/weekly-v3/components/20260914141013_weekly_player_certificates_include_recognized_tournament_fees.sql']
 for p in paths:file(ROOT/p)
 q("CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role',nullif(current_setting('request.jwt.claim.role',true),''))$$; CREATE TABLE accounting_mixed_cutover_spin_fee_proofs(rake_record_id uuid,tournament_id uuid,original_batch jsonb,cutover_at timestamptz,canonical_sources jsonb); CREATE TABLE accounting_tournament_fee_cutover(singleton boolean,starts_at timestamptz); ALTER TABLE accounting_tournament_fee_batches ADD COLUMN source_manifest jsonb;")
 file(FIX/'fn_accounting_mixed_cutover_spin_proof_valid.sql')
 for name in ['fn_caller_is_engine','fn_union_week_start','fn_rake_record_is_ghost_twin','fn_accounting_tournament_week_quality','fn_calculate_cash_rakeback_periods','fn_rakeback_recompute_periods']:file(FIX/(name+'.sql'))
 # Full existing financial oracle against the captured current calculator/quality.
 for name in ['cash-regression.sql','helpers.sql','regression.sql']:
  try:
   if name=='helpers.sql':
    text=(ROOT/'tests/fixtures/mixed-rake-period'/name).read_text().replace('INSERT INTO accounting_tournament_fee_batches VALUES','INSERT INTO accounting_tournament_fee_batches(rake_record_id,tournament_id,source_fingerprint,status,rake_amount) VALUES')
    q(text)
   else:
    text=(ROOT/'tests/fixtures/mixed-rake-period'/name).read_text().replace("set_config('test.engine','false',false)","set_config('request.jwt.claim.role','authenticated',false)").replace("set_config('test.engine','true',false)","set_config('request.jwt.claim.role','service_role',false)")
    q(text)
  except RuntimeError:
   print(q("SELECT fn_rakeback_recompute_periods(u(10),'2026-09-07','2026-09-13')"),flush=True)
   raise
 ok(True,'current captured calculator/quality pass full cash + mixed fee financial oracle')
 file(FIX/'adapters.sql')
 for name in ['fn_lock_accounting_tournament_recognition_week','fn_recognize_accounting_tournament_fees']:file(FIX/(name+'.sql'))
 q("GRANT ALL ON SCHEMA public TO postgres; CREATE ROLE authenticator LOGIN NOINHERIT; GRANT anon,authenticated,service_role TO authenticator; GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role; ALTER ROLE postgres NOSUPERUSER BYPASSRLS;",user='fixture_admin')
 baseline=json.loads((FIX/'baseline.json').read_text())
 for item in baseline['functions']:
  # Capture exact ACL rather than relying on broad bootstrap defaults.
  signature=item['identity']
  q(f'REVOKE ALL ON FUNCTION {signature} FROM PUBLIC,anon,authenticated,service_role;')
  if 'authenticated=' in item['acl']:q(f'GRANT EXECUTE ON FUNCTION {signature} TO authenticated;')
  if 'service_role=' in item['acl']:q(f'GRANT EXECUTE ON FUNCTION {signature} TO service_role;')
  ok(q(f"SELECT md5(pg_get_functiondef('{signature}'::regprocedure))") == item['md5'],'exact live definition '+item['name'])
 q("REVOKE ALL ON FUNCTION fn_lock_accounting_tournament_recognition_week(uuid,timestamptz) FROM PUBLIC,anon,authenticated,service_role")
 # Baseline and candidate are exercised below; snapshots are the real catalog.
 before=catalog()
 file(MIGRATION)
 after=catalog()
 for name,c in before.items():
  if name=='fn_rakeback_recompute_periods':
   ok({k:v for k,v in c.items() if k!='definition'}=={k:v for k,v in after[name].items() if k!='definition'},'wrapper OID/owner/ACL/config unchanged')
  else:ok(c==after[name],'unchanged dependency '+name)
 ok(q("SELECT NOT rolsuper AND rolbypassrls FROM pg_roles WHERE rolname='postgres'")=='t','production NOSUPERUSER BYPASSRLS owner')
 week=q("SELECT (date_trunc('week',clock_timestamp() AT TIME ZONE 'America/Los_Angeles'))::date")
 q("SELECT test_source(1201,503,20,10,clock_timestamp()-interval '1 hour')")
 old=lock_case(True,3001,week)
 new=lock_case(False,3002,week)
 ok(old['request_id']==new['request_id'] and old['requested_at']==new['requested_at'],'same request identity survives recognition and page attempts')
 safety_cases(week)
 drift_and_abort_cases(week)
 rollover_case(week)
 print('PASS: all local request-lock qualifications',flush=True)

try:main()
finally:
 for p in children:
  if p.poll() is None:p.terminate();p.wait(timeout=10)
 if started:run([PG/'pg_ctl','-D',CLUSTER/'data','-m','immediate','stop'])
 shutil.rmtree(CLUSTER);shutil.rmtree(SOCKET)
