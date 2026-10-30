"""Measured player-lock convoy in the existing isolated purchase-funding runner.
No database URL, production data, new money writer or scheduler.
"""
from pathlib import Path
from contextlib import contextmanager
import ast, json, subprocess, time, sys
ROOT=Path(__file__).resolve().parents[2]
FIX=ROOT/'scripts/dev/fixtures/mtt-player-lock/installed-functions.json'
MIG=ROOT/'supabase/migrations/20261030003124_tournament_rebuy_player_contention_releases_the_event_lane.sql'
ROWS={r['identity']:r for r in json.loads(FIX.read_text())}
USER='c1000000-0000-4000-8000-000000000001'
EVENT='c3000000-0000-4000-8000-000000000001'
FINANCIAL_ONLY='--mtt-player-lock-financial-only' in sys.argv
MISSION_ONLY='--mtt-player-lock-mission-convoy-only' in sys.argv
REBUY='process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)'
def configure(command,environment):
 global command_for,environment_for
 command_for,environment_for=command,environment

drift_checked=False
def prepare(q):
 global drift_checked
 for role in ['anon','authenticated','service_role']:
  q("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='"+role+"') THEN CREATE ROLE "+role+"; END IF; END $$;")
 # Empty operator/admission fixtures: no production hold or format lifecycle
 # is synthesized. The actual lock/financial bodies below remain exact.
 q("CREATE TABLE tournament_felt_supply_acknowledgements(tournament_id uuid PRIMARY KEY,chips numeric); CREATE TABLE tournament_stage_resume_receipts(tournament_id uuid,completed_at timestamptz,resume_id uuid); CREATE TABLE ca_operator_floor_hold(operation_id uuid,mode text); CREATE TABLE ca_launch_operator_scopes(operation_id uuid,club_ids uuid[]); CREATE TABLE ca_mtt_admission_contract(singleton boolean PRIMARY KEY,abi text); INSERT INTO ca_mtt_admission_contract VALUES(true,'legacy-capacity-v1');")
 q((FIX.parent/'diamond-schema.sql').read_text())
 q("ALTER TABLE clubs ADD COLUMN IF NOT EXISTS asset text DEFAULT 'chips'; ALTER TABLE clubs ADD COLUMN IF NOT EXISTS is_platform boolean DEFAULT false; ALTER TABLE profiles ADD COLUMN IF NOT EXISTS diamonds integer DEFAULT 0; ALTER TABLE profiles ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();")
 for sig in ['fn_ca_tournament_chip_supply(uuid)','fn_ca_tournament_felt_total(uuid)','fn_ca_assert_tournament_chip_grant(uuid,uuid,uuid,numeric,text)','fn_ca_capture_tournament_charge_entitlement()','fn_ca_record_tournament_participant_funding(uuid,text,text,numeric,text,uuid,uuid,jsonb)','fn_ca_unit_floor_cents(bigint,integer)','fn_ca_recovery_fee_cents(bigint,numeric,integer)','fn_ca_tournament_fee_ratio(numeric,numeric)','fn_ca_tournament_purchase_fee_ratio(numeric,numeric,integer)','fn_ca_tournament_unit_cents(uuid)','fn_poker_diamond_tournament_escrow(uuid)','fn_poker_diamond_tournament_custody(uuid)','fn_poker_diamond_tournament_custody_add(uuid,numeric,uuid)','fn_poker_diamond_tournament_charge(uuid,uuid,text,numeric,numeric,numeric,numeric,uuid,text)','fn_ca_process_tournament_chip_purchase_money_v1(uuid,uuid,text,numeric,numeric,integer,text)','fn_tournament_live_seat_acquisition_requires_authority()','fn_ca_lock_mtt_admission_contract()','fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)','fn_lock_daily_mission_user(uuid)',
             'fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)',REBUY,'fn_ca_horse_claim_due(integer)']:
  q(ROWS[sig]['definition']+';')
  assert q("SELECT md5(pg_get_functiondef('public."+sig+"'::regprocedure));")==ROWS[sig]['definition_md5'],sig
 if not drift_checked and not FINANCIAL_ONLY and not MISSION_ONLY:
  for sig in ['fn_ca_horse_claim_due(integer)',REBUY,'fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)','fn_lock_daily_mission_user(uuid)','fn_ca_lock_mtt_admission_contract()','fn_ca_tournament_unit_cents(uuid)','fn_ca_process_tournament_chip_purchase_money_v1(uuid,uuid,text,numeric,numeric,integer,text)','fn_poker_diamond_tournament_charge(uuid,uuid,text,numeric,numeric,numeric,numeric,uuid,text)','fn_poker_diamond_tournament_custody_add(uuid,numeric,uuid)']:
   source=ROWS[sig]['definition']
   q(source.replace('AS $function$','AS $function$\n-- isolated drift negative',1)+';')
   snapshot="SELECT jsonb_object_agg(oid::regprocedure::text,md5(pg_get_functiondef(oid))) FROM pg_proc WHERE oid IN ('public.fn_ca_horse_claim_due(integer)'::regprocedure,'public."+REBUY+"'::regprocedure);"
   before_drift=q(snapshot)
   q(MIG.read_text(),expected_error=('installed authority drift: public.' if sig in ['fn_ca_horse_claim_due(integer)',REBUY] else 'lock dependency drift: ')+sig)
   assert q(snapshot)==before_drift,'failed dependency/preimage migration partially changed an authority'
   q(source+';')
  drift_checked=True
 q("REVOKE ALL ON FUNCTION fn_ca_horse_claim_due(integer) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION fn_ca_horse_claim_due(integer) TO service_role; REVOKE ALL ON FUNCTION process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text) TO authenticated,service_role;")
 metadata="SELECT jsonb_agg(jsonb_build_array(proowner,proacl,proconfig,prosecdef) ORDER BY oid) FROM pg_proc WHERE oid IN ('public.fn_ca_horse_claim_due(integer)'::regprocedure,'public."+REBUY+"'::regprocedure);"
 before_metadata=q(metadata)
 q(MIG.read_text())
 assert q(metadata)==before_metadata,'migration changed owner, ACL, settings or security mode'
 # The isolated cluster's owning superuser is registration_test, not postgres.
 # Normalize only that owner/ACL identity; execute the exact postimage predicate.
 for line in MIG.read_text().splitlines():
  if line.startswith('-- @live-proof: '):
   assert q('SELECT '+line.removeprefix('-- @live-proof: ').replace('postgres','registration_test')+';')=='t','declared installed postimage proof failed'
 q("SET ROLE anon;SELECT fn_ca_horse_claim_due(500);",expected_error='permission denied')
 q("SET ROLE anon;SELECT process_tournament_rebuy(NULL,NULL,NULL,NULL,NULL,NULL,NULL);",expected_error='permission denied')

@contextmanager
def holder(q,sql):
 p=subprocess.Popen(command_for(),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=environment_for())
 try:
  p.stdin.write("BEGIN; "+sql+"; SELECT pg_advisory_lock(30003124);\n");p.stdin.flush()
  end=time.monotonic()+5
  while q("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=30003124 AND granted);")!='t':
   assert p.poll() is None and time.monotonic()<end,'holder did not acquire lock'
   time.sleep(.02)
  yield
 finally:
  if p.poll() is None:
   p.stdin.write('ROLLBACK;\n');p.stdin.close();p.wait(timeout=5)
  assert p.returncode==0,p.stderr.read()

def verify_claim_fk(q,setup,check):
 setup('rebuy','claim_fk')
 # Reuse the maintained reduced claim body (real mission/profile locks and
 # unique reward journal); it does not certify all Diamond issuance policy.
 tree=ast.parse((ROOT/'scripts/ci/test-horse-claim-lock-order.py').read_text())
 schema=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='SCHEMA' for t in n.targets))
 q("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS diamonds integer NOT NULL DEFAULT 0; ALTER TABLE profiles ADD COLUMN IF NOT EXISTS total_hands_played integer NOT NULL DEFAULT 0;")
 q("CREATE FUNCTION public.fn_platform_frozen() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;")
 claim_schema=schema[schema.index('CREATE TABLE public.user_daily_challenges'):]
 import re
 claim_schema=re.sub(r'CREATE TABLE public.diamond_transactions[\s\S]*?;','',claim_schema,count=1)
 q(claim_schema)
 q("ALTER TABLE diamond_transactions ALTER COLUMN transaction_type SET DEFAULT 'challenge_reward'; ALTER TABLE diamond_transactions ALTER COLUMN type SET DEFAULT 'challenge_reward'; ALTER TABLE diamond_transactions ALTER COLUMN balance_after SET DEFAULT 0;")
 q(f"UPDATE profiles SET is_horse=true WHERE id='{USER}'; INSERT INTO user_daily_challenges(id,user_id,completed,completed_at,diamond_reward_snapshot) VALUES('00000000-0000-0000-0000-000000000001','{USER}',true,now(),10); CREATE TABLE probe_hand_fk(user_id uuid REFERENCES profiles(id));")
 sig='fn_ca_horse_claim_due(integer)'
 candidate=q("SELECT pg_get_functiondef('public."+sig+"'::regprocedure);")
 for label,source in [('baseline',ROWS[sig]['definition']),('candidate',candidate)]:
  q(source+';')
  with holder(q,"SET LOCAL test.jwt_role='service_role'; SELECT * FROM fn_ca_horse_claim_due(500)"):
   sql=f"SET lock_timeout='300ms'; INSERT INTO probe_hand_fk VALUES('{USER}');"
   if label=='baseline': q(sql,expected_error='lock timeout')
   else: q(sql)
  check(label+' actual claim wrapper '+('blocks' if label=='baseline' else 'permits')+' unrelated profile foreign key')
 q("SET test.jwt_role='service_role'; SELECT * FROM fn_ca_horse_claim_due(500); SELECT * FROM fn_ca_horse_claim_due(500);")
 assert q("SELECT count(*)::text||':'||sum(amount)::text FROM diamond_transactions;")=='1:10'
 assert q(f"SELECT diamonds FROM profiles WHERE id='{USER}';")=='10'
 check('corrected claim preserves one exact credit across duplicate runs')

def verify_diamond_addon(q,setup,call,state,check):
 def seed(name,kind='addon'):
  setup(kind,'diamond_'+name)
  q(f"""UPDATE clubs SET asset='diamonds',is_platform=true,union_id=NULL WHERE id='c2000000-0000-4000-8000-000000000001';
  INSERT INTO ca_arena_settings(id,club_id,tournaments_enabled) VALUES(1,'c2000000-0000-4000-8000-000000000001',true);
  UPDATE profiles SET diamonds=500 WHERE id='{USER}';
  INSERT INTO poker_diamond_custody(id,user_id,arena_id,purpose,target_id,entry_key,balance,state)
   VALUES('d6000000-0000-4000-8000-000000000001','{USER}','c2000000-0000-4000-8000-000000000001','tournament_entry','{EVENT}','fixture-original-entry',200,'active');
  INSERT INTO poker_diamond_tournament_ledger(tournament_id,arena_id,user_id,custody_id,kind,amount,prize_part,fee_part,idempotency_key,wallet_journal_id,request)
   VALUES('{EVENT}','c2000000-0000-4000-8000-000000000001','{USER}','d6000000-0000-4000-8000-000000000001','entry',200,180,20,'fixture-original-entry',gen_random_uuid(),'{{}}');
  INSERT INTO diamond_purchase_lots(user_id,purchase_id,issued,created_at) VALUES('{USER}',gen_random_uuid(),500,now()-interval '30 days');""")
 def book():
  return q("SELECT jsonb_build_object('profiles',(SELECT jsonb_agg(to_jsonb(p)) FROM profiles p),'custody',(SELECT jsonb_agg(to_jsonb(p)) FROM poker_diamond_custody p),'movements',(SELECT jsonb_agg(to_jsonb(p)) FROM poker_diamond_movements p),'ledger',(SELECT jsonb_agg(to_jsonb(p)) FROM poker_diamond_tournament_ledger p),'journal',(SELECT jsonb_agg(to_jsonb(p)) FROM diamond_transactions p),'lots',(SELECT jsonb_agg(to_jsonb(p)) FROM diamond_purchase_lots p),'reservations',(SELECT jsonb_agg(to_jsonb(p)) FROM poker_diamond_lot_reservations p),'funding',(SELECT jsonb_agg(to_jsonb(p)) FROM tournament_participant_funding_receipts p));")
 for baseline_kind,baseline_mode in ([] if FINANCIAL_ONLY else [('addon','NO KEY UPDATE'),('rebuy','KEY SHARE')]):
  seed('baseline_'+baseline_kind,baseline_kind)
  candidate=q("SELECT pg_get_functiondef('public."+REBUY+"'::regprocedure);")
  q(ROWS[REBUY]['definition']+';')
  before=(state(),book())
  with holder(q,f"SELECT 1 FROM profiles WHERE id='{USER}' FOR {baseline_mode}"):
   p=subprocess.Popen(command_for(),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=environment_for())
   try:
    p.stdin.write("SET lock_timeout='2s'; "+call(baseline_kind)+'\n');p.stdin.close();p.stdin=None
    end=time.monotonic()+5
    while q(f"SELECT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1:{EVENT}',0));")!='f':
     assert p.poll() is None and time.monotonic()<end,'old addon convoy not observed'
     time.sleep(.02)
    out,err=p.communicate(timeout=5);assert p.returncode==0,err
    assert json.loads(out.strip().splitlines()[-1]).get('sqlstate')=='55P03',out
   finally:
    if p.poll() is None:p.kill();p.wait()
  assert (state(),book())==before
  check('old Diamond '+baseline_kind+' holds exclusive event behind '+baseline_mode)
  q(candidate+';')
 for kind,lock in [('addon','custody'),('addon','profile'),('rebuy','key-share')]:
  seed(lock,kind);before=(state(),book())
  sql=("SELECT 1 FROM poker_diamond_custody FOR UPDATE" if lock=='custody' else f"SELECT 1 FROM profiles WHERE id='{USER}' FOR {'KEY SHARE' if lock=='key-share' else 'NO KEY UPDATE'}")
  with holder(q,sql):
   start=time.monotonic();answer=json.loads(q(call(kind)))
   assert answer.get('sqlstate')=='55P03',answer
   assert time.monotonic()-start<2
   assert (state(),book())==before,'contention changed Diamond or purchase receipts'
   assert q(f"SELECT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1:{EVENT}',0));")=='t'
   if lock=='custody':q(f"BEGIN;SELECT 1 FROM profiles WHERE id='{USER}' FOR UPDATE NOWAIT;ROLLBACK;")
  answer=json.loads(q(call(kind)));assert answer.get('success') is True,answer
  assert q(f"SELECT diamonds FROM profiles WHERE id='{USER}';")=='485'
  assert q("SELECT balance FROM poker_diamond_custody;")=='215'
  assert q("SELECT count(*)::text||':'||sum(amount)::text FROM diamond_transactions;")=='1:-15'
  assert q("SELECT count(*) FROM poker_diamond_movements;")=='1'
  assert q("SELECT count(*) FROM tournament_participant_funding_receipts WHERE asset='diamonds' AND operation='"+kind+"';")=='1'
  after=(state(),book());assert json.loads(q(call(kind)))==answer and (state(),book())==after
  q("UPDATE ca_arena_settings SET tournaments_enabled=false;")
  with holder(q,f"SELECT 1 FROM profiles WHERE id='{USER}' FOR UPDATE"):
   assert json.loads(q(call(kind)))==answer and (state(),book())==after,'historical receipt lost precedence over current gate or player lock'
  check('Diamond '+kind+' '+lock+' contention rolls back; original token later funds exact custody/journal/stack once')
 for name,mutation,error in [('disabled','UPDATE ca_arena_settings SET tournaments_enabled=false','diamond_tournaments_not_open'),('missing','DELETE FROM poker_diamond_tournament_ledger;DELETE FROM poker_diamond_custody','diamond_tournament_entry_not_held'),('reserved',"UPDATE poker_diamond_custody SET state='reserved'",'diamond_tournament_custody_not_open'),('released',"UPDATE poker_diamond_custody SET balance=0,state='released',released_at=now()",'diamond_tournament_entry_not_held')]:
  seed(name);q(mutation);before=(state(),book());result=json.loads(q(call('addon')))
  assert result.get('error')==error,result
  assert (state(),book())==before
  check('Diamond addon preserves '+name+' refusal and all financial state')

def verify_contention(q,setup,call,state,check):
 if not MISSION_ONLY:
  if not FINANCIAL_ONLY: verify_claim_fk(q,setup,check)
  verify_diamond_addon(q,setup,call,state,check)
 for lock in (['daily-missions-user'] if MISSION_ONLY else ['table_cap','daily-missions-user','profile']):
  setup('rebuy','busy_'+lock.replace('-','_'))
  before=state()
  sql=(f"SELECT 1 FROM profiles WHERE id='{USER}' FOR NO KEY UPDATE" if lock=='profile'
       else f"SELECT pg_advisory_xact_lock(hashtextextended('{lock}:{USER}',0))")
  with holder(q,sql):
   start=time.monotonic(); answer=json.loads(q(call('rebuy')))
   assert answer.get('sqlstate')=='55P03',answer
   assert time.monotonic()-start<2,'busy admission waited'
   assert state()==before,'busy request changed financial/custody/receipt rows'
   assert q(f"SELECT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1:{EVENT}',0));")=='t'
  answer=json.loads(q(call('rebuy')));assert answer.get('success') is True,answer
  after=state(); replay=json.loads(q(call('rebuy')))
  assert replay==answer and state()==after,'same token paid more than once'
  check('real '+lock+' holder refuses before funds, releases event, exact token later succeeds once')
 for name,lock_sql in ([] if MISSION_ONLY else [('operator',"SELECT pg_advisory_xact_lock(530093)"),('admission',"SELECT 1 FROM ca_mtt_admission_contract FOR UPDATE")]):
  setup('rebuy','order_'+name)
  with holder(q,lock_sql):
   p=subprocess.Popen(command_for(),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=environment_for())
   p.stdin.write(call('rebuy')+'\n');p.stdin.close();p.stdin=None
   end=time.monotonic()+5
   while q("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock');")!='t':
    assert p.poll() is None and time.monotonic()<end,'earlier lane wait absent'
    time.sleep(.02)
   q(f"BEGIN; SELECT 1 FROM profiles WHERE id='{USER}' FOR NO KEY UPDATE NOWAIT; ROLLBACK;")
  out,err=p.communicate(timeout=5);assert p.returncode==0,err
  assert json.loads(out.strip().splitlines()[-1]).get('success') is True,out
  check(name+' admission wait does not hold player profile out of order')
 if FINANCIAL_ONLY: return
 # Old exact public RPC must demonstrate the convoy before the same correction.
 setup('rebuy','old_convoy');q(ROWS[REBUY]['definition']+';')
 with holder(q,f"SELECT pg_advisory_xact_lock(hashtextextended('daily-missions-user:{USER}',0))"):
  # A separate process retains the exclusive event root while blocked below.
  p=subprocess.Popen(command_for(),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=environment_for())
  try:
   p.stdin.write("SET lock_timeout='2s'; "+call('rebuy')+'\n');p.stdin.close()
   end=time.monotonic()+3
   while q(f"SELECT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1:{EVENT}',0));")!='f':
    assert p.poll() is None and time.monotonic()<end,'old convoy not observed'
    time.sleep(.02)
   p.stdin=None
   out,err=p.communicate(timeout=5)
   assert p.returncode==0,err
   result=json.loads(out.strip().splitlines()[-1]);assert result.get('sqlstate')=='55P03',result
   check('old exact rebuy holds exclusive event while waiting on unrelated mission holder')
  finally:
   if p.poll() is None:p.kill();p.wait()
