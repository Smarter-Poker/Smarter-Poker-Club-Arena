"""Native qualification for the owner-only projection admission boundary.

Controlled native row order reproduces the two observed physical inversions;
this does not pretend to replay the historical cash batch. Actual owner calls
then prove admission refusal, rollback and the supported outer timer.
"""
import hashlib,json,select,subprocess,time

def qualify(root,fix,out,cmd,run,schema):
 binding=json.loads((fix/'source-binding.json').read_text())
 candidate=(root/binding['projection_admission_migration']).read_text()
 base=cmd[:cmd.index('-c')]
 single="public.fn_ca_recognize_held_tournament_fees_by_owner_basis(held_fee_fixture.operation(),jsonb_build_array(jsonb_build_object('tournament_id',held_fee_fixture.event(),'amount',2.70)))"
 def sql(text,label,timeout='5s',ok=True):
  file=out/(label+'.sql');file.write_text(text)
  started=time.monotonic()
  result=subprocess.run(base+['-v','VERBOSITY=verbose','-c',"SET timezone='UTC';SET statement_timeout='"+timeout+"';SET lock_timeout='0';",'-f',str(file)],capture_output=True,text=True,timeout=12)
  elapsed=time.monotonic()-started
  (out/(label+'.log')).write_text(result.stdout+result.stderr)
  if ok and result.returncode:raise AssertionError(label+': '+result.stderr[-2500:])
  return result,elapsed
 def actor(initial):
  p=subprocess.Popen(base+['-At','-v','VERBOSITY=verbose'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  p.stdin.write("BEGIN;SET timezone='UTC';SET statement_timeout='8s';SET deadlock_timeout='100ms';SET lock_timeout='0';"+initial+";SELECT 'READY';\n");p.stdin.flush()
  deadline=time.monotonic()+10
  while time.monotonic()<deadline:
   if select.select([p.stdout],[],[],max(0,deadline-time.monotonic()))[0]:
    line=p.stdout.readline()
    if line.strip()=='READY':return p
    if not line:break
  p.kill();raise AssertionError('Native lock actor never became ready')
 def end(p):
  if p.poll() is None:return p.communicate('ROLLBACK;\n',timeout=10)
  return p.communicate(timeout=10)
 def snap():
  return subprocess.check_output(base+['-At',"-c","SET timezone='UTC';SELECT held_fee_fixture.snapshot()::text"],text=True).strip()
 # Existing contributor identities, zero-valued synthetic projections only.
 # Seed bookkeeping remembers exactly which rows this qualification introduced.
 sql("""CREATE TABLE held_fee_fixture.projection_rows AS
 SELECT club_id,user_id,row_number() OVER(ORDER BY club_id,user_id) n,
 EXISTS(SELECT 1 FROM public.player_stats s WHERE s.club_id=c.club_id AND s.user_id=c.user_id) had_stats,
 EXISTS(SELECT 1 FROM public.ca_club_commission_daily d WHERE d.club_id=c.club_id AND d.stat_date='2001-01-01') had_daily
 FROM (SELECT DISTINCT ON(club_id) club_id,user_id FROM held_fee_fixture.contributors ORDER BY club_id,user_id)c;
 INSERT INTO public.player_stats(user_id,club_id) SELECT user_id,club_id FROM held_fee_fixture.projection_rows ON CONFLICT(user_id,club_id) DO NOTHING;
 INSERT INTO public.ca_club_commission_daily(club_id,stat_date,amount,rows_counted,updated_at)
 SELECT club_id,'2001-01-01',0,0,now() FROM held_fee_fixture.projection_rows ON CONFLICT(club_id,stat_date) DO NOTHING;
 """,'admission-projection-scene')
 def write(kind,n):
  if kind=='commission':return "UPDATE public.agent_commissions SET amount=amount WHERE false;UPDATE public.ca_club_commission_daily SET amount=amount WHERE stat_date='2001-01-01' AND club_id=(SELECT club_id FROM held_fee_fixture.projection_rows WHERE n="+str(n)+")"
  return "UPDATE public.player_stats SET hands_played=hands_played WHERE (club_id,user_id)=(SELECT club_id,user_id FROM held_fee_fixture.projection_rows WHERE n="+str(n)+")"
 inversions=[]
 for kind in ['commission','stats']:
  a=actor(write(kind,1));b=actor(write(kind,2))
  try:
   # Both first row locks are witnessed before requesting the opposite pair.
   a.stdin.write(write(kind,2)+';ROLLBACK;\n');a.stdin.flush()
   b.stdin.write(write(kind,1)+';ROLLBACK;\n');b.stdin.flush()
   ao,ae=a.communicate(timeout=10);bo,be=b.communicate(timeout=10)
   (out/('admission-original-'+kind+'-deadlock.log')).write_text(ao+ae+bo+be)
   if '40P01' not in ae+be:raise AssertionError('Original '+kind+' inversion did not reproduce a deadlock')
   inversions.append(kind)
  finally:
   end(a);end(b)
 # Installation is full-definition guarded and leaves the old schema intact on drift.
 run("ALTER FUNCTION public.fn_ca_recognize_held_tournament_fees_by_owner_basis(uuid,jsonb) SET lock_timeout='4s';",'admission-predecessor-drift')
 before=schema();r,_=sql(candidate,'admission-install-refused',ok=False)
 if r.returncode==0 or 'held fee projection admission predecessor changed' not in r.stderr or schema()!=before:raise AssertionError('Admission predecessor drift did not refuse atomically')
 run("ALTER FUNCTION public.fn_ca_recognize_held_tournament_fees_by_owner_basis(uuid,jsonb) SET lock_timeout='5s';",'admission-predecessor-restored')
 run(candidate,'admission-install')
 for relation in ['agent_commissions','player_stats']:
  state=snap();p=actor('UPDATE public.'+relation+' SET '+('amount=amount' if relation=='agent_commissions' else 'hands_played=hands_played')+' WHERE false')
  try:
   r,elapsed=sql("SET request.jwt.claims='{\"role\":\"service_role\"}';SELECT "+single+';','admission-busy-'+relation,ok=False)
   if r.returncode==0 or '55P03' not in r.stderr or elapsed>=2 or snap()!=state:raise AssertionError('Busy '+relation+' must refuse immediately without effects')
  finally:end(p)
 # The supported post-commit cash projector banks first, then enters stats
 # in the same transaction. Hold each actual selected bank row; the owner must
 # refuse there before taking a projection relation, leaving stats admission
 # available to that still-open cash transaction.
 for relation,key in [('club_wallets','club_id'),('union_wallets','union_id')]:
  state=snap();p=actor('DO $$ BEGIN PERFORM 1 FROM public.'+relation+' WHERE '+key+'=(SELECT '+key+' FROM public.tournaments WHERE id=held_fee_fixture.event()) FOR NO KEY UPDATE;END $$')
  try:
   r,elapsed=sql("SET request.jwt.claims='{\"role\":\"service_role\"}';SELECT "+single+';','admission-bank-before-stats-'+relation,ok=False)
   if r.returncode==0 or '55P03' not in r.stderr or elapsed>=2 or snap()!=state:raise AssertionError('Busy cohort bank must refuse before projection admission: '+r.stderr[-1000:])
   p.stdin.write("SET lock_timeout='250ms';UPDATE public.player_stats SET hands_played=hands_played WHERE false;SELECT 'STATS_ADMITTED';ROLLBACK;\n");p.stdin.flush()
   po,pe=p.communicate(timeout=5)
   (out/('admission-bank-before-stats-'+relation+'-peer.log')).write_text(po+pe)
   if p.returncode or 'STATS_ADMITTED' not in po:raise AssertionError('Bank owner must still enter stats after held-fee refusal')
  finally:end(p)
 # Selected event lane is held before the writer reaches either projection.
 # While owner waits for that lane, another backend must still enter ordinary
 # DML admission. Reversed table-before-lane order fails this interleaving.
 p=actor("DO $$ BEGIN PERFORM public.fn_ca_lock_settlement_lane_for_sweep_member(held_fee_fixture.event());END $$")
 contender=None
 try:
  contender=subprocess.Popen(base+['-c',"SET timezone='UTC';SET statement_timeout='5s';SET lock_timeout='0';SET request.jwt.claims='{\"role\":\"service_role\"}';",'-c','SELECT '+single],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  deadline=time.monotonic()+3
  while time.monotonic()<deadline:
   waiting=subprocess.check_output(base+['-At','-c',"SELECT count(*) FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND query LIKE 'SELECT public.fn_ca_recognize_held%' AND wait_event_type='Lock'"],text=True).strip()
   if waiting=='1':break
   time.sleep(.02)
  else:raise AssertionError('Owner never reached the held event lane')
  sql('BEGIN;SET LOCAL lock_timeout=\'250ms\';UPDATE public.agent_commissions SET amount=amount WHERE false;UPDATE public.player_stats SET hands_played=hands_played WHERE false;ROLLBACK;','admission-event-before-projections')
  # The isolated contender is intentionally cancelled by its own armed 5s
  # deadline while its selected event lane remains held; no production backend.
  co,ce=contender.communicate(timeout=7)
  (out/'admission-event-lane-timeout.log').write_text(co+ce)
  if contender.returncode==0 or 'statement timeout' not in ce:raise AssertionError('Event lane contention did not respect the outer deadline')
 finally:
  end(p)
  if contender is not None and contender.poll() is None:contender.kill();contender.communicate()
 # Config precondition refuses an unbounded or long caller. It is deliberately
 # NOT described as detecting an internal-only SET that has no armed timer.
 for timeout in ['0','6s']:
  state=snap();r,_=sql("SET request.jwt.claims='{\"role\":\"service_role\"}';SELECT "+single+';','admission-budget-'+timeout,timeout,False)
  if r.returncode==0 or 'owner_fee_requires_top_level_five_second_budget' not in r.stderr or snap()!=state:raise AssertionError('Unsupported caller budget admitted')
 # Sleep in the real nested payer after its canonical journal write, not a
 # replacement payer. Its installed proconfig remains30s throughout this test.
 sql("""CREATE FUNCTION held_fee_fixture.admission_timeout() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.settlement_id='owner-basis:'||held_fee_fixture.operation() THEN
  IF current_setting('statement_timeout')<>'30s' THEN RAISE EXCEPTION 'nested payer30s was not reached';END IF;
  PERFORM pg_sleep(7);
 END IF;RETURN NEW;END $$;
 CREATE TRIGGER zz_held_fee_admission_timeout AFTER INSERT ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION held_fee_fixture.admission_timeout();
 """,'admission-timeout-fixture')
 state=snap();r,elapsed=sql("SET request.jwt.claims='{\"role\":\"service_role\"}';DO $$ BEGIN PERFORM "+single+";RAISE EXCEPTION 'timeout was not armed';END $$;",'admission-real-outer-timeout',ok=False)
 if r.returncode==0 or '57014' not in r.stderr or 'pg_sleep' not in r.stderr or not 4.5<=elapsed<6.5 or snap()!=state:raise AssertionError('Actual outer5s timeout did not roll back the nested30s payer: '+r.stderr[-1500:])
 sql('DROP TRIGGER zz_held_fee_admission_timeout ON public.chip_ledger;DROP FUNCTION held_fee_fixture.admission_timeout();','admission-timeout-fixture-retired')
 # Exercise the known GUC trap as a negative control: changing a setting inside
 # DO does not replace its already-armed timer. No false guard proof is claimed.
 r,internal_elapsed=sql("DO $$ BEGIN PERFORM set_config('statement_timeout','5s',true);PERFORM pg_sleep(6);END $$;",'admission-internal-set-is-not-timer','8s')
 if internal_elapsed<5.5:raise AssertionError('Internal-only SET control did not demonstrate the timer boundary')
 sql("""DELETE FROM public.player_stats s USING held_fee_fixture.projection_rows r WHERE NOT r.had_stats AND s.club_id=r.club_id AND s.user_id=r.user_id;
 DELETE FROM public.ca_club_commission_daily d USING held_fee_fixture.projection_rows r WHERE NOT r.had_daily AND d.club_id=r.club_id AND d.stat_date='2001-01-01';
 DROP TABLE held_fee_fixture.projection_rows;""",'admission-projection-scene-retired')
 result={'status':'passed','original_physical_deadlocks':inversions,'real_owner_busy_relations':['agent_commissions','player_stats'],
  'member_lanes_before_relations':True,'exact_bank_rows_before_projections':True,'full_definition_guard':True,'outer5s_nested30s_rollback_seconds':round(elapsed,3),
  'internal_set_not_armed_seconds':round(internal_elapsed,3),'limitations':'Ordinary projection row ordering is controlled in isolation. This is not a replay of the historical cash batch. Only the documented top-level5s caller route is time-bounded; arbitrary internal SET is not proof.'}
 (out/'projection-admission-evidence.json').write_text(json.dumps(result,indent=2)+'\n')
 return result
