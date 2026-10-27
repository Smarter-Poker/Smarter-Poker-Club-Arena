#!/usr/bin/env python3
import argparse,json,os,socket,subprocess,tempfile,shutil,hashlib,sys
from pathlib import Path
from datetime import datetime,timedelta
R=Path(__file__).resolve().parents[2];W=R/'scripts/ci/fixtures/weekly-fee-preparation'
p=argparse.ArgumentParser(description='Actual original fee prefix and complete coordinator control-flow qualification; not a monetary-writer or capacity certificate.')
p.add_argument('--pg-bin',type=Path,default=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin' if sys.platform=='darwin' else '/usr/lib/postgresql/17/bin')))
p.add_argument('--scratch',type=Path,required=True);p.add_argument('--base-fixtures',type=Path,default=R/'scripts/ci/fixtures/fees-before-club-books');p.add_argument('--candidate',type=Path);p.add_argument('--output',type=Path);a=p.parse_args();PG=a.pg_bin
assert a.scratch.is_dir(),'existing owned scratch required'
if sys.platform=='darwin':assert str(a.scratch.resolve()).startswith('/Volumes/SmarterWork/agent-work/'),'Mac scratch must use the external work SSD'
if a.candidate is None:
 candidates=list((R/'supabase/migrations').glob('*_weekly_fee_preparation_starts_when_the_week_closes.sql'));assert len(candidates)==1,'exact migration candidate required';a.candidate=candidates[0]
B=Path(tempfile.mkdtemp(prefix='aw-',dir=a.scratch.resolve()));started=False
with socket.socket() as s:s.bind(('127.0.0.1',0));port=str(s.getsockname()[1])
env={k:v for k,v in os.environ.items()if not k.startswith('PG')};env['TMPDIR']=str(B);env.pop('DATABASE_URL',None)
def run(argv,s=None,error=None):
 r=subprocess.run(list(map(str,argv)),input=s,text=True,capture_output=True,env=env,timeout=45)
 if error:assert r.returncode and error in r.stderr,(error,r.stdout+r.stderr)
 else:assert r.returncode==0,r.stdout+r.stderr
 return r.stdout.strip()
def q(s,error=None):return run([PG/'psql','-XqAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','postgres'],"SET statement_timeout='240s';SET app.weekly_accounting_chunked='on';SET app.accounting_close_memo='on';SET app.weekly_accounting_scope_budget='3 minutes';SET app.weekly_accounting_scope_deadline='2026-10-26 08:03Z';"+s,error)
def controlled(s):return s.replace('clock_timestamp()','public.fixture_clock()').replace('now()','public.fixture_clock()').replace('statement_timestamp()','public.fixture_clock()')
def check(s):assert q('SELECT ('+s+')')=='t',s
owners=json.loads((W/'original-owners.json').read_text());changes=json.loads((W/'replacement-contracts.json').read_text());helpers=json.loads((W/'original-helpers.json').read_text());report=[]
def rec(s):report.append(s)
for c in changes:
 c['before']=next(f['definition'] for f in owners if 'public.'+f['signature']==c['signature']);c['after']=c['before']
 assert hashlib.md5(c['before'].encode()).hexdigest()==c['before_md5']
 for item in c['replacements']:
  if len(item)==2:old,new=item;expected=1
  else:marker,old,new=item;expected=2 if marker=='__BOTH_UNION_DUE_PREDICATES__' else 1
  assert c['after'].count(old)==expected,'exact reviewed replacement count changed';c['after']=c['after'].replace(old,new)
 assert hashlib.md5(c['after'].encode()).hexdigest()==c['after_md5']
try:
 assert ' 17.'in run([PG/'postgres','--version']),'native PostgreSQL17 required'
 run([PG/'initdb','-D',B/'d','-U','postgres','-A','trust','--no-locale','-E','UTF8']);run([PG/'pg_ctl','-D',B/'d','-l',B/'log','-o',f"-h 127.0.0.1 -k '' -p {port}",'-w','start']);started=True
 q((a.base_fixtures/'bootstrap.sql').read_text());q((W/'bootstrap.sql').read_text())
 for f in helpers:
  if not f['signature'].startswith('fn_process_weekly_accounting('):q(f['definition'])
 for f in owners:
  if f['signature'].split('(')[0]in['fn_prepare_accounting_week','fn_process_weekly_accounting_scope','fn_weekly_close_first_visits_pending','fn_accounting_union_earned_plan_advance','fn_accounting_union_earned_plan','fn_accounting_close_windows','fn_weekly_accounting_attempt_begin','fn_union_settlement_cascade_due','fn_accounting_close_windows_advance_due']:
   q(f['definition']);assert q("SELECT md5(pg_get_functiondef('public."+f['signature']+"'::regprocedure))")==f['md5'];q('REVOKE ALL ON FUNCTION public.'+f['signature']+' FROM PUBLIC,anon,authenticated,service_role')
 for f in helpers:
  if f['signature'].startswith('fn_process_weekly_accounting('):q(f['definition'])
 meta=lambda:q("SELECT jsonb_agg(jsonb_build_array(oid::regprocedure::text,proowner,provolatile,prosecdef,proconfig,proacl::text)ORDER BY oid::regprocedure::text)FROM pg_proc WHERE oid IN("+','.join("'"+c['signature']+"'::regprocedure" for c in changes)+')')
 # Reproduce original behavior before applying: no bounded fee prefix is
 # driven by preparation, so the real earned-plan owner falls back whole-week.
 check("NOT EXISTS(SELECT FROM accounting_close_partials)")
 baseline=json.loads(q("SELECT fn_prepare_accounting_week(u(),NULL,'2026-10-19 07:00Z','2026-10-26 07:00Z')"));assert baseline['success']
 q("SELECT fn_accounting_union_earned_plan(u(),'2026-10-19 07:00Z','2026-10-26 07:00Z')",'unexpected_whole_week_fallback')
 check("NOT EXISTS(SELECT FROM accounting_close_partials)");rec('original_missing_fee_prefix_reproduces_whole_week_fallback')
 oldscope=next(f for f in owners if f['signature'].startswith('fn_process_weekly_accounting_scope('))
 q(controlled(oldscope['definition']))
 baseline=json.loads(q("SET test.now='2026-10-26 07:00Z';SELECT fn_process_weekly_accounting_scope(u(),NULL)"));assert baseline['checked']==0
 q(oldscope['definition']);q("TRUNCATE accounting_period_recompute_requests,phase_trace;")
 rec('original_scope_does_not_prepare_closed_week_at02')
 before=meta();migration=a.candidate.read_text();q('BEGIN;'+migration.split('BEGIN;',1)[1].rsplit('COMMIT;',1)[0]+'ROLLBACK;')
 for c in changes:assert q("SELECT md5(pg_get_functiondef('"+c['signature']+"'::regprocedure))")==c['before_md5']
 rec('exact_installer_atomic_rollback_original_hashes')
 q(migration);assert meta()==before;q(migration,'weekly_fee_preparation_owner_changed');rec('exact_installer_metadata_and_replay_refusal')
 # Controlled time is the only substitution in these actual owner definitions.
 for f in helpers:q(controlled(f['definition']))
 for f in owners:
  name=f['signature'].split('(')[0]
  if name in['fn_accounting_union_earned_plan_advance','fn_accounting_union_earned_plan','fn_accounting_close_windows','fn_weekly_accounting_attempt_begin','fn_union_settlement_cascade_due','fn_accounting_close_windows_advance_due']:q(controlled(f['definition']))
 for c in changes:q(controlled(c['after']))
 prep="SELECT fn_prepare_accounting_week(u(),NULL,'2026-10-19 07:00Z','2026-10-26 07:00Z')"
 # Source refusal precedes every proof window and payer.
 x=json.loads(q("SET test.source_bad='on';"+prep));assert x['problems'][0]['reason']=='cash_source_refusals_pending';check("NOT EXISTS(SELECT FROM accounting_close_partials)");rec('source_refusal_precedes_fee_progress')
 q("UPDATE accounting_cash_accrual_cutover SET starts_at='2026-10-20';")
 x=json.loads(q(prep));assert x['success'];check("NOT EXISTS(SELECT FROM accounting_close_partials)");rec('pre_cutover_legacy_preparation_does_not_enter_new_fee_prefix')
 q("UPDATE accounting_cash_accrual_cutover SET starts_at='2026-09-01';TRUNCATE accounting_period_recompute_requests;")
 # Force one original prefix window; next attempt resumes from its exact row.
 x=json.loads(q("SET app.weekly_accounting_scope_deadline='2026-10-26 07:00Z';"+prep));assert x['problems'][0]['reason']=='earned_fee_certification_in_progress';check("(SELECT count(*)FROM accounting_close_partials)=1");rec('original_prefix_one_window_durable_restart')
 x=json.loads(q(prep));assert x['problems'][0]['reason']=='earned_fee_certification_in_progress';check("(SELECT count(*)FROM accounting_close_partials)=84");rec('all84_original_prefix_windows_no_later_book_entry')
 x=json.loads(q(prep));assert x['success'];rec('complete_windows_skip_coupled_advance')
 x=json.loads(q("SELECT fn_accounting_union_earned_plan(u(),'2026-10-19 07:00Z','2026-10-26 07:00Z')"));assert float(x['period_rake'])==84 and float(x['earned_rake'])==84;rec('actual_combine_and_earned_owner_avoid_whole_week_fallback')
 # Receipt bounds and freshness are exact: wrong end/expired are re-proved.
 q("TRUNCATE fixture_certificates;UPDATE accounting_close_partials SET window_end=window_end-interval '1 minute' WHERE window_start='2026-10-19 07:00Z';")
 x=json.loads(q("SET app.weekly_accounting_scope_deadline='2026-10-26 07:00Z';"+prep));assert x['problems'][0]['reason']=='earned_fee_certification_in_progress';check("(SELECT window_end='2026-10-19 09:00Z' FROM accounting_close_partials WHERE window_start='2026-10-19 07:00Z')");rec('wrong_window_bounds_reproved')
 q("UPDATE accounting_close_partials SET computed_at=fixture_clock()-interval '9 days' WHERE window_start='2026-10-19 07:00Z';")
 x=json.loads(q("SET app.weekly_accounting_scope_deadline='2026-10-26 07:00Z';"+prep));assert x['problems'][0]['reason']=='earned_fee_certification_in_progress';rec('expired_window_reproved')
 q("TRUNCATE accounting_close_partials;");q("SET test.window_refused='on';"+prep,'original_window_source_refused');check('NOT EXISTS(SELECT FROM accounting_close_partials)');rec('original_window_refusal_atomic')
 # Exact current coordinator, exercising union branch with time controlled.
 scope="SELECT fn_process_weekly_accounting_scope(u(),NULL)"
 for instant,expected in [('2026-10-26 06:59Z','before_boundary'),('2026-10-26 07:00Z','certifying'),('2026-10-26 08:59Z','prepared')]:
  out=json.loads(q("SET test.now='"+instant+"';"+scope));None
  if expected=='before_boundary':assert out['checked']==0,out
  else:assert out['detail'][0]['result']['stage']==expected and out['detail'][0]['result'].get('committed_round')==0,out
 rec('actual_scope_before02_closed02_and_before04_no_payment')
 check("(SELECT last_value=0 AND NOT is_called FROM fixture_financial_calls)")
 # A prepared tick at04 reaches only the controlled actual financial boundary.
 out=json.loads(q("SET test.now='2026-10-26 09:00Z';"+scope));assert out['detail'][0]['result']['error']=='fixture_financial_boundary_reached',out
 check("(SELECT is_called FROM fixture_financial_calls)");rec('actual04_financial_due_boundary_retained')
 q("SELECT setval('fixture_financial_calls',0,false);")
 out=json.loads(q("SET test.now='2026-10-26 09:00Z';SET test.frozen='on';"+scope));assert out['reason']=='maintenance_window';check("(SELECT NOT is_called FROM fixture_financial_calls)");rec('actual_scope_freeze_stops_all_work')
 q("SET test.engine='false';"+scope,'not_authorised');rec('actual_scope_authorization_preserved')
 out=json.loads(q("SET test.now='2026-10-26 08:00Z';SET app.weekly_accounting_chunked='off';"+scope));assert out['checked']==0;rec('legacy_unchunked_pre04_gate_unchanged')
 # Native current automatic selector and recursive scope visitor, not a copied
 # query: the default job reaches02 preparation with its normal scope budget.
 out=json.loads(q("SET test.now='2026-10-26 08:00Z';SET app.weekly_accounting_attempt_budget='1';SELECT fn_process_weekly_accounting_scope(NULL,NULL)"));assert out['checked']==1 and out['failed']==0 and out['detail'][0]['result'].get('committed_round')==0,out
 check("(SELECT NOT is_called FROM fixture_financial_calls)");rec('actual_automatic_selector_and_recursive_visitor_prepare_before04')
 # First-visits gate admits the existing job from02, not before, across DST.
 q("TRUNCATE weekly_accounting_scheduler_visits;INSERT INTO weekly_accounting_scheduler_visits VALUES('union',u(),'2026-10-25 12:00Z','visited',NULL,0);")
 for instant,want in [('2026-10-26 06:59Z',False),('2026-10-26 07:00Z',True),('2026-10-26 08:59Z',True),('2026-10-26 09:00Z',True),('2026-10-26 21:00Z',False)]:
  assert q("SET test.now='"+instant+"';SELECT fn_weekly_close_first_visits_pending()")==('t' if want else 'f'),instant
 rec('existing_job_admission02_to_original04_plus12h_end')
 # Older fully paid book stays visibly failed while the same owner reaches
 # current unpaid fees even with attempt_budget1.
 q("TRUNCATE union_accounting_runs,accounting_routed_settlement_runs;UPDATE union_settlement_floor SET earliest_period_start='2026-10-12 07:00Z';INSERT INTO union_accounting_runs(union_id,period_start,period_end,scheduled_at,status,attempts,started_at,result)VALUES(u(),'2026-10-12 07:00Z','2026-10-19 07:00Z','2026-10-19 09:00Z','failed',9,'2026-10-19 09:00Z','{\"error\":\"union_pnl_basis_uncertified\"}');INSERT INTO accounting_routed_settlement_runs(union_id,scope_kind,scope_id,period_start,period_end,round_no,result)VALUES(u(),'union',u(),'2026-10-12 07:00Z','2026-10-19 07:00Z',3,'{\"success\":true,\"routing_version\":3,\"source_version\":2,\"shortfalls\":0}');")
 out=json.loads(q("SET test.now='2026-10-26 08:00Z';SET app.weekly_accounting_attempt_budget='1';"+scope));assert out['checked']==1 and out['failed']==0 and out['detail'][0]['result']['period_start'].startswith('2026-10-19'),out
 check("(SELECT attempts=9 AND status='failed' AND result->>'error'='union_pnl_basis_uncertified' FROM union_accounting_runs WHERE period_start='2026-10-12 07:00Z')");rec('older_paid_book_does_not_withhold_current_fees_or_claim_old_book_complete')
 q("UPDATE accounting_routed_settlement_runs SET result=jsonb_set(result,'{success}','false') WHERE period_start='2026-10-12 07:00Z';")
 out=json.loads(q("SET test.now='2026-10-26 08:00Z';SET app.weekly_accounting_attempt_budget='1';"+scope));assert out['detail'][0]['result']['error']=='weekly_accounting_calculation_incomplete' and out['detail'][0]['period_start'].startswith('2026-10-12'),out
 rec('invalid_or_unpaid_older_receipt_never_skipped')
 # November DST week: exact original calendar yields02CST08Z and04CST10Z.
 q("TRUNCATE union_accounting_runs,accounting_routed_settlement_runs,accounting_close_partials,fixture_certificates,accounting_period_recompute_requests;UPDATE union_settlement_floor SET earliest_period_start='2026-10-26 07:00Z';UPDATE daemon_state SET high_water_mark='2026-11-02 08:00Z';")
 for instant,want in [('2026-11-02 07:59Z',0),('2026-11-02 08:00Z',1),('2026-11-02 09:59Z',1)]:
  out=json.loads(q("SET test.now='"+instant+"';"+scope));assert out['checked']==want and out['failed']==0,out
  if want:assert out['detail'][0]['result'].get('committed_round')==0,out
 check("(SELECT NOT is_called FROM fixture_financial_calls)")
 out=json.loads(q("SET test.now='2026-11-02 10:00Z';"+scope));assert out['detail'][0]['result']['error']=='fixture_financial_boundary_reached',out
 rec('actual_DST_fall_week_closed02CST_payment04CST')
 # Standalone alternate path respects the same02-preparation/04 money gate.
 q("TRUNCATE union_accounting_runs,accounting_routed_settlement_runs,accounting_close_partials,fixture_certificates,accounting_period_recompute_requests;SELECT setval('fixture_financial_calls',0,false);INSERT INTO accounting_cash_rake_sources(club_id,coordinator_union_id,earned_at)VALUES(c(),NULL,'2026-10-19 12:00Z');")
 clubscope="SELECT fn_process_weekly_accounting_scope(NULL,c())"
 out=json.loads(q("SET test.now='2026-10-26 08:59Z';"+clubscope));assert out['checked']==1 and out['failed']==0 and out['detail'][0]['result'].get('committed_round')==0,out
 check("(SELECT NOT is_called FROM fixture_financial_calls)")
 out=json.loads(q("SET test.now='2026-10-26 09:00Z';"+clubscope));assert out['detail'][0]['result']['error']=='fixture_standalone_financial_boundary_reached',out
 rec('actual_standalone02_preparation04_money_gate')
 q("SELECT setval('fixture_financial_calls',0,false);TRUNCATE union_accounting_runs,accounting_routed_settlement_runs;INSERT INTO union_accounting_runs(standalone_club_id,period_start,period_end,scheduled_at,status,attempts,started_at,result)VALUES(c(),'2026-10-12 07:00Z','2026-10-19 07:00Z','2026-10-19 09:00Z','failed',9,'2026-10-19 09:00Z','{\"error\":\"club_statement_pending\"}');INSERT INTO accounting_routed_settlement_runs(union_id,scope_kind,scope_id,period_start,period_end,round_no,result)VALUES(NULL,'club',c(),'2026-10-12 07:00Z','2026-10-19 07:00Z',3,'{\"success\":true,\"routing_version\":3,\"source_version\":2,\"shortfalls\":0}');")
 out=json.loads(q("SET test.now='2026-10-26 08:00Z';SET test.club_floor='2026-10-12 07:00Z';SET app.weekly_accounting_attempt_budget='1';"+clubscope));assert out['checked']==1 and out['failed']==0 and out['detail'][0]['period_start'].startswith('2026-10-19'),out
 check("(SELECT attempts=9 AND status='failed' FROM union_accounting_runs WHERE period_start='2026-10-12 07:00Z')");check("(SELECT NOT is_called FROM fixture_financial_calls)");rec('older_paid_standalone_book_yields_without_false_completion')
 # The unchanged original scheduler lock owns concurrency and duplicates.
 holder=subprocess.Popen(list(map(str,[PG/'psql','-XqAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','postgres'])),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
 try:
  holder.stdin.write("BEGIN;SELECT pg_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0));\n\\echo HELD\n");holder.stdin.flush()
  while holder.stdout.readline().strip()!='HELD':
   assert holder.poll() is None,'native lock holder exited'
  out=json.loads(q("SET test.now='2026-10-26 08:00Z';"+scope));assert out['skipped'] and out['reason']=='already_running',out
 finally:
  holder.stdin.write('ROLLBACK;\n\\q\n');holder.stdin.flush();holder.communicate(timeout=5);assert holder.returncode==0
 rec('actual_original_scheduler_lock_refuses_competing_scope')
 # Execute the exact stored job command through the actual original due
 # wrapper, promo due gate, round2-proof advance, SQL delegate and selector.
 # Promo's original before04 gate is real; an already-paid fixture promo
 # isolates fee wiring after04. The monetary writer boundary remains controlled.
 job=json.loads((W/'original-business-job.json').read_text())
 q("TRUNCATE union_accounting_runs,accounting_routed_settlement_runs,accounting_close_partials,fixture_certificates,accounting_period_recompute_requests,accounting_cash_rake_sources,weekly_accounting_scheduler_visits;UPDATE union_settlement_floor SET earliest_period_start='2026-10-19 07:00Z';UPDATE daemon_state SET high_water_mark='2026-10-26 07:00Z';SELECT setval('fixture_financial_calls',0,false);INSERT INTO weekly_accounting_scheduler_visits VALUES('union',u(),'2026-10-25 12:00Z','visited',NULL,0);")
 fresh_job_context="SET app.weekly_accounting_chunked='off';SET app.accounting_close_memo='';SET app.weekly_accounting_scope_deadline='';SET app.weekly_accounting_scope_budget='';"
 snapshot="SELECT jsonb_build_object('runs',(SELECT count(*)FROM union_accounting_runs),'paid_boundary',(SELECT is_called FROM fixture_financial_calls),'stage',(SELECT result->>'stage'FROM union_accounting_runs ORDER BY period_start DESC LIMIT 1),'error',(SELECT result->>'error'FROM union_accounting_runs ORDER BY period_start DESC LIMIT 1));"
 for instant,want in [('2026-10-26 06:59Z',None),('2026-10-26 07:00Z','certifying'),('2026-10-26 08:59Z','prepared')]:
  output=q("SET test.now='"+instant+"';"+fresh_job_context+controlled(job['command'])+snapshot).splitlines();snap=json.loads(output[-1]);assert not snap['paid_boundary'],snap
  if want:assert snap['runs']==1 and snap['stage']==want,snap
  else:assert snap['runs']==0,snap
 output=q("SET test.now='2026-10-26 09:00Z';"+fresh_job_context+controlled(job['command'])+snapshot).splitlines();snap=json.loads(output[-1]);assert snap['paid_boundary'] and snap['error']=='fixture_financial_boundary_reached',snap
 rec('actual_captured_business_job_and_dispatch_chain_prepare02_pay_not_before04')
 # Follow-up: actual original windows_pending in the actual whole Scope.
 # R2/R3 producers below are explicit controlled NONFINANCIAL boundaries.
 q((W/'original-windows-pending.sql').read_text())
 windows_owner_md5=q("SELECT md5(pg_get_functiondef('fn_accounting_close_windows_pending(uuid,uuid,timestamptz,timestamptz)'::regprocedure))")
 q(controlled((W/'original-windows-pending.sql').read_text()))
 q(controlled((W/'original-deadline-check.sql').read_text().replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1)))
 q("""CREATE FUNCTION fixture_proof_advance(rnd int,k text,s uuid,p_from timestamptz,p_to timestamptz)RETURNS boolean LANGUAGE plpgsql AS $$
 DECLARE w record;did boolean:=false;v_proof_kind text:='round'||rnd||'_'||k||'_window';deadline timestamptz:=NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'')::timestamptz;
 BEGIN
  IF p_to>fixture_clock()THEN RAISE EXCEPTION 'proof_requires_closed_week';END IF;
  IF current_setting('test.proof_source_bad',true)='round'||rnd THEN RAISE EXCEPTION 'original_round_source_refused';END IF;
  IF deadline IS NULL OR fixture_clock()>=deadline THEN RETURN false;END IF;
  INSERT INTO phase_trace(event)VALUES('proof_round'||rnd);
  FOR w IN SELECT * FROM fn_accounting_close_windows(p_from,p_to)LOOP
   IF NOT EXISTS(SELECT FROM accounting_close_partials p WHERE p.kind=v_proof_kind AND p.union_id=s AND p.period_start=p_from AND p.period_end=p_to
    AND p.window_start=w.window_start AND p.window_end=w.window_end AND p.computed_at>=p_to AND p.computed_at>fixture_clock()-fn_accounting_close_proof_lifetime())THEN
    INSERT INTO accounting_close_partials(kind,union_id,period_start,period_end,window_start,window_end,value,computed_at)
    VALUES(v_proof_kind,s,p_from,p_to,w.window_start,w.window_end,'{"controlled_nonfinancial_source":true}',fixture_clock())
    ON CONFLICT(kind,union_id,period_start,period_end,window_start)DO UPDATE SET window_end=EXCLUDED.window_end,value=EXCLUDED.value,computed_at=EXCLUDED.computed_at;
    did:=true;
   END IF;
  END LOOP;
  RETURN did;
 END$$;
 CREATE OR REPLACE FUNCTION fn_settle_accounting_commission_advance(text,uuid,timestamptz,timestamptz)RETURNS boolean LANGUAGE sql AS $$SELECT fixture_proof_advance(2,$1,$2,$3,$4)$$;
 CREATE OR REPLACE FUNCTION fn_settle_accounting_rakeback_advance(text,uuid,timestamptz,timestamptz)RETURNS boolean LANGUAGE sql AS $$SELECT fixture_proof_advance(3,$1,$2,$3,$4)$$;
 CREATE OR REPLACE FUNCTION fn_union_settlement_cascade(uuid,timestamptz,timestamptz)RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN PERFORM fn_weekly_accounting_deadline_check();PERFORM nextval('fixture_financial_calls');RAISE EXCEPTION 'fixture_financial_boundary_reached';END$$;
 CREATE OR REPLACE FUNCTION fn_bank_standalone_week_rake(uuid,timestamptz,timestamptz)RETURNS void LANGUAGE plpgsql AS $$BEGIN PERFORM fn_weekly_accounting_deadline_check();PERFORM nextval('fixture_financial_calls');RAISE EXCEPTION 'fixture_standalone_financial_boundary_reached';END$$;
 """)
 def reset_for_proofs(start='2026-10-19 07:00Z',end='2026-10-26 07:00Z',instant='2026-10-26 08:30Z'):
  q("TRUNCATE union_accounting_runs,accounting_routed_settlement_runs,accounting_close_partials,fixture_certificates,accounting_period_recompute_requests,phase_trace;UPDATE union_settlement_floor SET earliest_period_start='"+start+"';UPDATE daemon_state SET high_water_mark='"+end+"';SELECT setval('fixture_financial_calls',0,false);")
  prime_deadline=(datetime.fromisoformat(instant.replace('Z','+00:00'))+timedelta(minutes=3)).isoformat()
  for attempt in range(2):
   prepared=json.loads(q("SET test.now='"+instant+"';SET app.weekly_accounting_scope_deadline='"+prime_deadline+"';SELECT fn_prepare_accounting_week(u(),NULL,'"+start+"','"+end+"')"))
  assert prepared['success'],prepared
 def part_count(rnd):return int(q("SELECT count(*)FROM accounting_close_partials WHERE kind='round"+str(rnd)+"_union_window'"))
 reset_for_proofs()
 # Demonstrate the frozen269f gap before qualifying this new Scope body.
 old_scope=json.loads((W/'scope-pre-proof-windows.json').read_text())['definition'];assert hashlib.md5(old_scope.encode()).hexdigest()=='6821fb176cf93637cc2820602d93cd56'
 q(controlled(old_scope));out=json.loads(q("SET test.now='2026-10-26 08:30Z';"+scope));assert out['detail'][0]['result'].get('committed_round')==0 and out['detail'][0]['result'].get('stage')=='prepared' and part_count(2)==part_count(3)==0,out
 rec('frozen269f_reproduces_ready_pre04_scope_without_R2_R3_progress')
 q(controlled(next(c for c in changes if'fn_process_weekly_accounting_scope('in c['signature'])['after']))
 for expected2,expected3 in[(84,0),(84,84),(84,84)]:
  out=json.loads(q("SET test.now='2026-10-26 08:30Z';"+scope));assert out['detail'][0]['result'].get('committed_round')==0 and out['failed']==0,out
  assert(part_count(2),part_count(3))==(expected2,expected3),(expected2,expected3,part_count(2),part_count(3))
 check("(SELECT NOT is_called FROM fixture_financial_calls)")
 rec('actual_windows_pending_pre04_union_advances_R2_then_R3_and_ready_no_money')
 out=json.loads(q("SET test.now='2026-10-26 09:00Z';"+scope));assert out['detail'][0]['result']['error']=='fixture_financial_boundary_reached',out
 rec('actual_windows_pending_ready_original04_money_gate_retained')
 q("SELECT setval('fixture_financial_calls',0,false)")
 out=json.loads(q("SET test.now='2026-10-26 09:00Z';SET app.weekly_accounting_scope_budget='-1 second';"+scope));assert out['failed']==1 and out['detail'][0]['result']['error']=='weekly_scope_time_budget_exhausted',out
 check("(SELECT NOT is_called FROM fixture_financial_calls)");rec('actual_original_deadline_refuses_ready_proofs_before_money')
 reset_for_proofs();before=q('SELECT count(*)FROM accounting_close_partials')
 out=json.loads(q("SET test.now='2026-10-26 08:30Z';SET test.source_bad='on';"+scope));assert out['failed']==1 and part_count(2)==part_count(3)==0,out
 check("(SELECT NOT is_called FROM fixture_financial_calls)");rec('full_original_preparation_source_refusal_precedes_pre04_proof_windows')
 reset_for_proofs()
 out=json.loads(q("SET test.now='2026-10-26 08:30Z';SET test.proof_source_bad='round2';"+scope));assert out['failed']==1 and part_count(2)==part_count(3)==0,out
 rec('original_nonfinancial_R2_source_failure_refuses_before_money')
 q("SET test.now='2026-10-26 08:30Z';"+scope)
 out=json.loads(q("SET test.now='2026-10-26 08:30Z';SET test.proof_source_bad='round3';"+scope));assert out['failed']==1 and part_count(3)==0,out
 check("(SELECT NOT is_called FROM fixture_financial_calls)");rec('original_nonfinancial_R3_source_failure_refuses_before_money')
 reset_for_proofs()
 out=json.loads(q("SET test.now='2026-10-26 08:30Z';SET app.weekly_accounting_scope_budget='0 seconds';"+scope));assert part_count(2)==part_count(3)==0,out
 check("(SELECT NOT is_called FROM fixture_financial_calls)");rec('original_attempt_deadline_not_extended_for_pre04_proofs')
 out=json.loads(q("SET test.now='2026-10-26 08:30Z';SET test.frozen='on';"+scope));assert out['reason']=='maintenance_window'and part_count(2)==part_count(3)==0,out
 q("SET test.now='2026-10-26 08:30Z';SET test.engine='false';"+scope,'not_authorised');assert part_count(2)==part_count(3)==0
 rec('actual_scope_freeze_and_authorization_precede_original_pre04_proof_owner')
 # Real expired/wrong-bound R2 partials cannot masquerade as proof-ready.
 q("SET test.now='2026-10-26 08:30Z';"+scope)
 q("UPDATE accounting_close_partials SET computed_at='2026-10-01Z'WHERE kind='round2_union_window';")
 q("SET test.now='2026-10-26 08:30Z';"+scope);check("(SELECT bool_and(computed_at>='2026-10-26 07:00Z')FROM accounting_close_partials WHERE kind='round2_union_window')")
 q("UPDATE accounting_close_partials SET window_end=window_end-interval '1 minute'WHERE kind='round2_union_window';")
 q("SET test.now='2026-10-26 08:30Z';"+scope);check("NOT EXISTS(SELECT FROM accounting_close_partials p JOIN fn_accounting_close_windows('2026-10-19 07:00Z','2026-10-26 07:00Z')w USING(window_start)WHERE p.kind='round2_union_window'AND p.window_end<>w.window_end)")
 rec('actual_pending_owner_rejects_expired_or_wrong_bound_R2_windows')
 reset_for_proofs()
 q("INSERT INTO accounting_cash_rake_sources(club_id,coordinator_union_id,earned_at)VALUES(c(),NULL,'2026-10-19 12:00Z');")
 for attempt in range(2):
  out=json.loads(q("SET test.now='2026-10-26 08:30Z';"+clubscope));assert out['failed']==0 and out['detail'][0]['result'].get('committed_round')==0,out
 check("(SELECT count(*)=84 FROM accounting_close_partials WHERE kind='round2_club_window')AND(SELECT count(*)=84 FROM accounting_close_partials WHERE kind='round3_club_window')")
 check("(SELECT NOT is_called FROM fixture_financial_calls)");rec('actual_windows_pending_pre04_standalone_advances_both_rounds_no_money')
 reset_for_proofs('2026-10-26 07:00Z','2026-11-02 08:00Z','2026-11-02 09:30Z')
 for attempt in range(2):
  out=json.loads(q("SET test.now='2026-11-02 09:30Z';"+scope));assert out['failed']==0 and out['detail'][0]['result'].get('committed_round')==0,out
 assert(part_count(2),part_count(3))==(85,85),(part_count(2),part_count(3))
 check("(SELECT NOT is_called FROM fixture_financial_calls)");rec('actual_windows_pending_DST169hour_week_pre04_all85windows_no_money')
 out=json.loads(q("SET test.now='2026-11-02 10:00Z';"+scope));assert out['detail'][0]['result']['error']=='fixture_financial_boundary_reached',out
 rec('actual_windows_pending_DST04CST_financial_gate_unchanged')
 result={'passed':True,'case_count':len(report),'cases':report,'migration_sha256':hashlib.sha256(a.candidate.read_bytes()).hexdigest(),'actual_windows_pending_source_md5':windows_owner_md5,'owner_postimages':{c['signature']:c['after_md5'] for c in changes},'limits':'Actual changed owner definitions; only clock substitutions, controlled source-window and downstream monetary boundaries. Not whole monetary-stage, wall-clock cron, or capacity qualification.'}
 print(json.dumps(result))
 if a.output:
  assert not a.output.exists(),'new output required';a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(result,indent=2)+'\n')
finally:
 if started:run([PG/'pg_ctl','-D',B/'d','-m','immediate','-w','stop'])
 shutil.rmtree(B)
