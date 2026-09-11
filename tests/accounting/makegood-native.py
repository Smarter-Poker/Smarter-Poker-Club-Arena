#!/usr/bin/env python3
"""Isolated native PG17 integration of D8 with the sealed current accounting schema.

No network connection options or production DSN are accepted. The input archive
is the separately reviewed E2 source fixture, verified before local extraction.
"""
from pathlib import Path
import argparse, concurrent.futures, hashlib, json, os, subprocess, tarfile, tempfile, time

root=Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--fixture',type=Path,required=True)
p.add_argument('--evidence',type=Path,required=True)
p.add_argument('--d12-migration',type=Path)
p.add_argument('--accepted-settlement-migration',type=Path,required=True)
a=p.parse_args()
expected='6be71661c49edd736ad78bf62582389ecce5cf06b46eb44237ff8a69833693c1'
assert hashlib.sha256(a.fixture.read_bytes()).hexdigest()==expected
pg=Path('/opt/homebrew/opt/postgresql@17/bin')
env={k:v for k,v in os.environ.items() if not k.startswith('PG') and k!='DATABASE_URL'}
work=Path(tempfile.mkdtemp(prefix='ca-e2-owned-',dir='/tmp'))
socket=work/'socket';socket.mkdir(mode=0o700)
runtime=work/'source';runtime.mkdir()
a.evidence.mkdir(parents=True,exist_ok=True)
state={'cluster':str(work),'socket':str(socket),'port':55498,'database':'e2_bee519fa'}
with tarfile.open(a.fixture) as archive:
 for member in archive.getmembers():
  assert member.isfile() and Path(member.name).name==member.name
  (runtime/member.name).write_bytes(archive.extractfile(member).read())
(runtime/'cluster.json').write_text(json.dumps(state))
# Snapshot external in-flight dependencies once; receipts identify exactly the
# bytes actually applied even if another owned worktree advances meanwhile.
accepted_source=runtime/'accepted-settlement-dependency.sql'
accepted_source.write_bytes(a.accepted_settlement_migration.read_bytes())
d12_source=None
if a.d12_migration:
 d12_source=runtime/'d12-guard-dependency.sql'
 d12_source.write_bytes(a.d12_migration.read_bytes())
base=[str(pg/'psql'),'-X','-q','-v','ON_ERROR_STOP=1','-h',str(socket),'-p','55498','-U','postgres']
def command(args,**kw):
 r=subprocess.run(args,env=env,text=True,capture_output=True,**kw)
 if r.returncode: raise RuntimeError((r.stderr+r.stdout)[-5000:])
 return r.stdout

def sql(q,db='e2_bee519fa'):
 return command(base+['-d',db,'-Atc',q]).strip()
def query(q,db='e2_bee519fa'):
 return json.loads(sql(q,db))
def service(q,db='e2_bee519fa'):
 return query('SET ROLE service_role; '+q,db)
def refuse(q,contains,db='e2_bee519fa',role='service_role'):
 try: sql('SET ROLE '+role+'; '+q,db)
 except RuntimeError as e:
  assert contains in str(e),(contains,str(e))
  return
 raise AssertionError('Expected refusal: '+contains)

tid='bee519fa-ff07-438c-9542-d386fc821908'
ob='b1000000-0000-0000-0000-000000000001'
fundleg='b2000000-0000-0000-0000-000000000001'
results=[]
started=False
try:
 version=command([str(pg/'postgres'),'--version']).strip();assert ' 17.' in version
 command([str(pg/'initdb'),'-D',str(work/'data'),'--no-locale','-E','UTF8','-U','postgres'])
 command([str(pg/'pg_ctl'),'-D',str(work/'data'),'-l',str(work/'postgres.log'),'-o',f"-h '' -k {socket} -p 55498",'-w','start']);started=True
 sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;','postgres')
 for script in ['load-local.py','seed-local.py']:
  output=command(['python3',str(runtime/script)],cwd=runtime)
  (a.evidence/(script+'.log')).write_text(output)
 # All fixture seed writes end before tested execution. Installed triggers and
 # role constraints remain enabled throughout the actual operations below.
 for source in ['current-exact-refund.sql','fn_collect_bounty.sql','fn_mystery_bounty_pay.sql']:
  command(base+['-d','e2_bee519fa','-f',str(root/'tests/accounting/fixtures'/source)])
 migration=root/'supabase/migrations/20260911164014_audited_house_funded_makegood_authority.sql'
 command(base+['-d','e2_bee519fa','-f',str(accepted_source)])
 command(base+['-d','e2_bee519fa','-f',str(migration)])
 core=json.loads((runtime/'live-event-core.json').read_text()); support=json.loads((runtime/'live-event-support.json').read_text())
 user=core['players'][0]['user_id'];club=support['club']['id']
 # Test-only fixture construction, explicit native owner transaction. Neither
 # this nor any fixture source is part of the production migration.
 setup=f"""BEGIN; SET LOCAL session_replication_role=replica;
 UPDATE public.tournaments SET status='RUNNING',prize_pool=35,payout_structure='[{{"place":1,"percentage":100}}]',
   bubble_protection=false,bounty_pool=0,bounty_pool_paid=0,is_pko=false,is_bounty=false,is_mystery_bounty=false,
   satellite_target_id=NULL,satellite_target=NULL,variant='NLH',tournament_type='MTT' WHERE id='{tid}';
 DELETE FROM public.tournament_obligations WHERE tournament_id='{tid}';
 DELETE FROM public.tournament_payouts WHERE tournament_id='{tid}';
 UPDATE public.tournament_escrow SET prize_balance=35,gross_in=35,prize_out=0,bounty_balance=0,bounty_in=0,bounty_out=0,
 fee_balance=0,fee_entries_in=0,fee_out=0,refund_prize=0,refund_bounty=0,refund_fee=0 WHERE tournament_id='{tid}';
 UPDATE public.club_members SET chip_balance=100,role='player',status='active' WHERE club_id='{club}';
 UPDATE public.clubs SET chip_treasury=100 WHERE id='{club}';
 INSERT INTO public.chip_ledger(id,performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,idempotency_key)
 VALUES('{fundleg}','2d1cd6c3-5700-4af9-a271-d4863fdab20d','union_bank','b3000000-0000-0000-0000-000000000001','club_treasury','{club}',100,'union_settlement','{club}','fixture:funding');
 INSERT INTO public.tournament_obligations(id,tournament_id,kind,place,user_id,amount_owed,amount_paid,source)
 VALUES('{ob}','{tid}','place',1,'{user}',35,0,'engine.fixture');
 COMMIT;"""
 sql(setup)
 funding=sql("SET ROLE service_role; SELECT public.fn_ca_makegood_register_funding('"+fundleg+"','Test fixture verified treasury allocation with exact immutable journal reference; no production funding is registered by this test.');")
 sql('CREATE DATABASE makegood_template TEMPLATE e2_bee519fa','postgres')
 def database(name):
  sql('CREATE DATABASE '+name+' TEMPLATE makegood_template','postgres');return name
 def propose(db,net=35):
  return service(f"SELECT public.fn_ca_makegood_propose('place_obligation','{ob}','{funding}',{net},'Validated canonical place contract and exact paid credit receipts; house bears the evidenced positive unpaid difference.');",db)
 def pay(db,item):return service(f"SELECT public.fn_ca_makegood_pay('{item}');",db)
 def normal(db,amount):
  return service(f"SELECT public.fn_settle_tournament_obligation('{tid}','place',1,'{user}',{amount},'engine.fixture');",db)
 def test(name,fn):
  start=time.monotonic();fn();results.append({'name':name,'status':'passed','seconds':round(time.monotonic()-start,3)});(a.evidence/'progress.json').write_text(json.dumps(results,indent=2))
 def test_net():
  db=database('mg_net');r=normal(db,20);assert r['paid']==20,r
  item=propose(db,15)['item_id'];r=pay(db,item);assert r['amount']==15 and r['ordinary_paid']==20 and r['total_entitlement']==35,r
  assert pay(db,item)==r
  assert propose(db,15)['item_id']==item
  replay=normal(db,20);assert replay['paid']==0,replay
  refuse(f"SELECT public.fn_settle_tournament_obligation('{tid}','place',1,'{user}',35,'engine.fixture');",'house make-good disposition',db)
  assert query(f"SELECT jsonb_build_object('balance',chip_balance) FROM public.club_members WHERE club_id='{club}' AND user_id='{user}'",db)['balance']==135
 test('original20_total35_net15_lost_response_replay',test_net)
 def test_stale():
  db=database('mg_stale');item=propose(db)['item_id'];assert normal(db,20)['paid']==20
  refuse(f"SELECT public.fn_ca_makegood_pay('{item}');",'financial evidence changed',db)
  replacement=propose(db,15)['item_id'];assert replacement!=item
  assert pay(db,replacement)['amount']==15
 test('ordinary_payment_first_refuses_stale_item',test_stale)
 def test_concurrent():
  db=database('mg_same');item=propose(db)['item_id']
  with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
   a,b=list(pool.map(lambda _:pay(db,item),range(2)))
  assert a==b
  assert sql('SELECT count(*) FROM ca_makegood.receipts',db)=='1'
 test('concurrent_same_item_returns_one_receipt',test_concurrent)
 def test_acl():
  db=database('mg_acl');item=propose(db)['item_id']
  for role in ['anon','authenticated']:
   refuse(f"SELECT public.fn_ca_makegood_pay('{item}');",'permission denied',db,role)
  refuse('INSERT INTO ca_makegood.debts DEFAULT VALUES','permission denied',db)
  for amount in ["'-1'","'NaN'","'Infinity'","'0.001'"]:
   refuse(f"SELECT public.fn_ca_makegood_propose('place_obligation','{ob}','{funding}',{amount},repeat('r',80));",'net assertion',db)
  refuse(f"UPDATE public.ca_manual_adjustments SET amount=1 WHERE id=(SELECT adjustment_id FROM ca_makegood.items WHERE id='{item}')",'permission denied',db)
  try: sql(f"UPDATE ca_makegood.items SET amount=1 WHERE id='{item}'",db)
  except RuntimeError as e:assert 'append-only' in str(e)
  else:raise AssertionError('Immutable item changed')
 test('acl_exact_decimal_and_immutable_item',test_acl)
 def fixture(db,body):
  sql('BEGIN; SET LOCAL session_replication_role=replica; '+body+' COMMIT;',db)
 def revise(db,total):
  fixture(db,f"UPDATE public.tournaments SET prize_pool={total} WHERE id='{tid}'; UPDATE public.tournament_obligations SET amount_owed={total} WHERE id='{ob}';")
 def test_revisions():
  db=database('mg_revisions');revise(db,10);a=propose(db,10);assert pay(db,a['item_id'])['amount']==10
  revise(db,12);b=propose(db,2);assert a['debt_id']==b['debt_id'] and a['revision_id']!=b['revision_id']
  r=pay(db,b['item_id']);assert r['amount']==2 and r['makegood_paid']==12
  assert pay(db,b['item_id'])==r
  revise(db,9);c=propose(db,0);assert c.get('item_id') is None,c
  assert sql('SELECT sum(amount) FROM ca_makegood.receipts',db)=='12.00'
 test('paid10_revised_total12_increment2_downward_no_clawback',test_revisions)
 def holder(db,lock):
  proc=subprocess.Popen(base+['-d',db,'-At'],env=env,text=True,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  proc.stdin.write('BEGIN; '+lock+" SELECT 'READY';\n");proc.stdin.flush()
  while proc.stdout.readline().strip()!='READY':
   assert proc.poll() is None,'Holder exited'
  return proc
 def release(proc,body=''):
  out,err=proc.communicate(body+' COMMIT;\n',timeout=15)
  assert proc.returncode==0,err
  return out.strip()
 def waiting(db):
  deadline=time.monotonic()+5
  while time.monotonic()<deadline:
   if int(sql("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",db))>0:return
   time.sleep(.02)
  raise AssertionError('No actual blocked SQL operation observed')
 def test_race(house_first):
  db=database('mg_race_house' if house_first else 'mg_race_normal');item=propose(db)['item_id']
  proc=holder(db,f"SELECT id FROM public.tournaments WHERE id='{tid}' FOR UPDATE;")
  with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
   future=pool.submit(normal,db,35) if house_first else pool.submit(pay,db,item)
   waiting(db)
   body=f"SET ROLE service_role; SELECT public.fn_ca_makegood_pay('{item}');" if house_first else f"SET ROLE service_role; SELECT public.fn_settle_tournament_obligation('{tid}','place',1,'{user}',20,'engine.fixture');"
   release(proc,body)
   try: future.result()
   except RuntimeError as e:assert ('house make-good disposition' if house_first else 'financial evidence changed') in str(e),str(e)
   else:raise AssertionError('Competing debt payment did not refuse')
  assert sql(f"SELECT chip_balance FROM public.club_members WHERE club_id='{club}' AND user_id='{user}'",db)==('135.00' if house_first else '120.00')
 test('actual_ordinary_and_house_concurrency_house_commits_first',lambda:test_race(True))
 test('actual_ordinary_and_house_concurrency_ordinary_commits_first',lambda:test_race(False))
 def test_shared_funds():
  db=database('mg_shared');other='bee519fa-ff07-438c-9542-d386fc821909';otherob='b1000000-0000-0000-0000-000000000002';otheruser=core['players'][1]['user_id']
  revise(db,60)
  fixture(db,f"""INSERT INTO public.tournaments SELECT (jsonb_populate_record(NULL::public.tournaments,to_jsonb(t)||jsonb_build_object('id','{other}'))).* FROM public.tournaments t WHERE id='{tid}';
   INSERT INTO public.tournament_players SELECT (jsonb_populate_record(NULL::public.tournament_players,to_jsonb(t)||jsonb_build_object('id',gen_random_uuid(),'tournament_id','{other}'))).* FROM public.tournament_players t WHERE tournament_id='{tid}';
   INSERT INTO public.tournament_obligations(id,tournament_id,kind,place,user_id,amount_owed,amount_paid,source) VALUES('{otherob}','{other}','place',1,'{otheruser}',60,0,'engine.fixture');""")
  one=propose(db,60)['item_id'];two=service(f"SELECT public.fn_ca_makegood_propose('place_obligation','{otherob}','{funding}',60,repeat('r',80));",db)['item_id']
  def attempt(item):
   try:return pay(db,item)
   except RuntimeError as e:assert 'insufficient verified shared house funding' in str(e);return None
  with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:out=list(pool.map(attempt,[one,two]))
  assert sum(x is not None for x in out)==1,out
  assert sql('SELECT sum(amount) FROM ca_makegood.receipts',db)=='60.00'
  assert sql(f"SELECT chip_treasury FROM public.clubs WHERE id='{club}'",db)=='40.00'
  assert sql("SELECT count(*) FROM public.wallet_credit_idempotency WHERE key LIKE 'makegood:%'",db)=='1'
  assert sql('SELECT count(*) FROM ca_makegood.authorizations',db)=='0'
 test('different_debts_shared_bank_atomic_insufficient_funds',test_shared_funds)
 def test_lock_order():
  db=database('mg_locks');item=propose(db)['item_id'];proc=holder(db,f"SELECT id FROM public.clubs WHERE id='{club}' FOR UPDATE;")
  with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
   future=pool.submit(pay,db,item);waiting(db)
   try:sql(f"BEGIN; SELECT user_id FROM public.club_members WHERE club_id='{club}' AND user_id='{user}' FOR UPDATE NOWAIT; ROLLBACK;",db)
   except RuntimeError as e:assert 'could not obtain lock' in str(e)
   else:raise AssertionError('Payer did not own recipient before bank wait')
   release(proc);assert future.result()['amount']==35
 test('native_recipient_lock_precedes_shared_bank_lock',test_lock_order)
 def test_context_and_failure():
  db=database('mg_context');item=propose(db)['item_id']
  sql("CREATE FUNCTION public.fixture_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture receipt sink failed'; END $$; CREATE TRIGGER a_fixture_failure BEFORE INSERT ON public.wallet_transactions FOR EACH ROW EXECUTE FUNCTION public.fixture_receipt_failure();",db)
  sql(f"""SET ROLE service_role; DO $$ BEGIN
   PERFORM set_config('app.ledger_idempotency_key','ambient-key',true);
   PERFORM set_config('app.ledger_category','ambient-category',true);
   BEGIN PERFORM public.fn_ca_makegood_pay('{item}'); RAISE EXCEPTION 'unexpected success';
   EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'fixture receipt sink failed' THEN RAISE; END IF; END;
   IF current_setting('app.ledger_idempotency_key')<>'ambient-key' OR current_setting('app.ledger_category')<>'ambient-category' THEN RAISE EXCEPTION 'ambient context changed'; END IF;
  END $$;""",db)
  assert sql(f"SELECT chip_treasury FROM public.clubs WHERE id='{club}'",db)=='100.00'
  assert sql('SELECT count(*) FROM ca_makegood.authorizations',db)=='0'
  assert sql('SELECT count(*) FROM ca_makegood.receipts',db)=='0'
  assert sql("SELECT count(*) FROM public.wallet_credit_idempotency WHERE key LIKE 'makegood:%'",db)=='0'
  sql('DROP TRIGGER a_fixture_failure ON public.wallet_transactions',db)
  sql(f"SET ROLE service_role; DO $$ BEGIN PERFORM set_config('app.ledger_idempotency_key','ambient-key',true); PERFORM public.fn_ca_makegood_pay('{item}'); IF current_setting('app.ledger_idempotency_key')<>'ambient-key' THEN RAISE EXCEPTION 'success context changed'; END IF; END $$;",db)
  db=database('mg_normal_context')
  sql(f"SET ROLE service_role; DO $$ BEGIN PERFORM set_config('app.ledger_idempotency_key','ambient-key',true); PERFORM public.fn_settle_tournament_obligation('{tid}','place',1,'{user}',20,'engine.fixture'); IF current_setting('app.ledger_idempotency_key')<>'ambient-key' THEN RAISE EXCEPTION 'normal context changed'; END IF; END $$;",db)
  assert sql(f"SELECT count(*) FROM public.chip_ledger WHERE idempotency_key='tourney:{tid}:obl:{ob}:0'",db)=='1'
 test('receipt_sink_failure_atomic_rollback_and_context_restoration',test_context_and_failure)
 def test_terminal():
  db=database('mg_terminal');fixture(db,f"UPDATE public.tournaments SET status='COMPLETED' WHERE id='{tid}';")
  before=sql(f"SELECT ca_makegood.terminal_state('{tid}')",db)
  item=propose(db)['item_id'];result=pay(db,item);assert result['amount']==35
  assert sql(f"SELECT ca_makegood.terminal_state('{tid}')",db)==before
  assert sql('SELECT count(*) FROM ca_makegood.authorizations',db)=='0'
  # An ambient ledger GUC and the genuine item key are insufficient once its
  # private transaction permit is consumed. Native owner probe reaches guards.
  key=result['idempotency_key']
  try:sql(f"BEGIN; SELECT set_config('app.makegood_authorized','true',true); INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,tournament_id,idempotency_key) VALUES('2d1cd6c3-5700-4af9-a271-d4863fdab20d','club_treasury','{club}','player_wallet','{user}',35,'adjustment','{club}','{tid}','{key}'); COMMIT;",db)
  except RuntimeError as e:assert 'immutable' in str(e),str(e)
  else:raise AssertionError('Forged context authorized terminal leg')
 test('terminal_funded_payment_preserves_escrow_and_rejects_forged_context',test_terminal)
 def test_permit_adversaries():
  db=database('mg_permits');fixture(db,f"UPDATE public.tournaments SET status='COMPLETED' WHERE id='{tid}';")
  item=propose(db)['item_id']
  for q in ["INSERT INTO ca_makegood.authorizations DEFAULT VALUES", "INSERT INTO ca_makegood.ordinary_context DEFAULT VALUES", "SELECT ca_makegood.exact_funded_leg('{}',false)", "SELECT ca_makegood.settle_bounty_source(NULL,NULL,NULL,NULL,NULL,NULL,NULL)"]:
   refuse(q,'permission denied',db)
  sql("""CREATE TABLE public.fixture_permit_checks(n integer);
  CREATE FUNCTION public.fixture_check_permit() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE original jsonb:=to_jsonb(NEW); mutation jsonb; saved_xid xid8; saved_pid integer; checked integer:=0;
  BEGIN
   IF NEW.idempotency_key NOT LIKE 'makegood:%' THEN RETURN NEW; END IF;
   IF NOT ca_makegood.exact_funded_leg(original,false) THEN RAISE EXCEPTION 'real permit did not qualify'; END IF;
   FOR mutation IN SELECT value FROM jsonb_array_elements('[{"amount":-35},{"amount":0},{"amount":34},{"amount":null},{"idempotency_key":"forged"},{"to_entity_id":"00000000-0000-0000-0000-000000000001"},{"from_entity_id":"00000000-0000-0000-0000-000000000001"},{"tournament_id":"00000000-0000-0000-0000-000000000001"},{"status":"pending"},{"category":"tournament_prize"},{"terminal_closed_at":"2026-01-01T00:00:00Z"},{"metadata":{"satellite_id":"00000000-0000-0000-0000-000000000001"}}]') LOOP
    IF ca_makegood.exact_funded_leg(original||mutation,false) THEN RAISE EXCEPTION 'forged leg passed: %',mutation; END IF;
    checked:=checked+1;
   END LOOP;
   SELECT transaction_id,backend_pid INTO saved_xid,saved_pid FROM ca_makegood.authorizations;
   UPDATE ca_makegood.authorizations SET backend_pid=-1;
   IF ca_makegood.exact_funded_leg(original,false) THEN RAISE EXCEPTION 'wrong backend passed'; END IF;
   UPDATE ca_makegood.authorizations SET backend_pid=saved_pid,transaction_id='999999999'::xid8;
   IF ca_makegood.exact_funded_leg(original,false) THEN RAISE EXCEPTION 'wrong transaction passed'; END IF;
   UPDATE ca_makegood.authorizations SET transaction_id=saved_xid;
   INSERT INTO public.fixture_permit_checks VALUES(checked+2);
   RETURN NEW;
  END $$;
  CREATE TRIGGER zzz_fixture_permit_check BEFORE INSERT ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION public.fixture_check_permit();""",db)
  assert pay(db,item)['amount']==35
  assert sql('SELECT sum(n) FROM public.fixture_permit_checks',db)=='14'
  assert sql('SELECT count(*) FROM ca_makegood.authorizations',db)=='0'
  db=database('mg_permit_orphan');item=propose(db)['item_id']
  try:sql(f"INSERT INTO ca_makegood.authorizations VALUES('{item}',pg_current_xact_id(),pg_backend_pid(),gen_random_uuid(),100,100,ca_makegood.terminal_state('{tid}'));",db)
  except RuntimeError as e:assert 'lacks its exact committed balanced receipt' in str(e),str(e)
  else:raise AssertionError('Unconsumed private authorization committed')
 test('private_permit_acl_wrong_xid_backend_leg_and_deferred_cleanup',test_permit_adversaries)
 def mystery_fixture(db):
  eliminated=core['players'][2]['user_id']
  fixture(db,f"""UPDATE public.tournaments SET status='COMPLETED',is_mystery_bounty=true,is_bounty=true,bounty_pool=50,bounty_pool_paid=0 WHERE id='{tid}';
   UPDATE public.tournament_escrow SET bounty_balance=50,bounty_in=50 WHERE tournament_id='{tid}';
   DELETE FROM public.tournament_bounty_award_recipients; DELETE FROM public.tournament_bounty_awards; DELETE FROM public.tournament_bounty_chests;
   INSERT INTO public.tournament_bounty_chests(id,tournament_id,seq,tier,amount_cents,status) VALUES
    ('c1000000-0000-0000-0000-000000000001','{tid}',1,'base',500,'revealed'),
    ('c1000000-0000-0000-0000-000000000002','{tid}',2,'base',700,'revealed');
   INSERT INTO public.tournament_bounty_awards(id,tournament_id,chest_id,eliminated_user_id,amount_cents,tier,status,op_id) VALUES
    ('c2000000-0000-0000-0000-000000000001','{tid}','c1000000-0000-0000-0000-000000000001','{eliminated}',500,'base','revealed',gen_random_uuid()),
    ('c2000000-0000-0000-0000-000000000002','{tid}','c1000000-0000-0000-0000-000000000002','{core['players'][3]['user_id']}',700,'base','revealed',gen_random_uuid());
   INSERT INTO public.tournament_bounty_award_recipients(id,award_id,user_id,amount_cents) VALUES
    ('c3000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','{user}',500),
    ('c3000000-0000-0000-0000-000000000002','c2000000-0000-0000-0000-000000000002','{user}',700);""")
 def test_mystery_source():
  db=database('mg_mystery');mystery_fixture(db)
  item=service(f"SELECT public.fn_ca_makegood_propose('mystery_recipient','c3000000-0000-0000-0000-000000000001','{funding}',5,repeat('r',80));",db)['item_id']
  assert pay(db,item)['amount']==5
  # Test-only legacy reopen makes the ordinary path reachable, proving source
  # coordination independently of the terminal guards. Production never reopens.
  fixture(db,f"UPDATE public.tournaments SET status='RUNNING' WHERE id='{tid}';")
  refuse("SELECT public.fn_mystery_bounty_pay('c2000000-0000-0000-0000-000000000001');",'house make-good disposition',db)
  r=service("SELECT public.fn_mystery_bounty_pay('c2000000-0000-0000-0000-000000000002');",db)
  assert r['ok'],r
  assert sql("SELECT sum(amount) FROM ca_makegood.ordinary_receipts WHERE source_identity='award:c2000000-0000-0000-0000-000000000002'",db)=='7.00'
  assert sql(f"SELECT chip_balance FROM public.club_members WHERE club_id='{club}' AND user_id='{user}'",db)=='112.00'
  assert sql('SELECT count(*) FROM ca_makegood.ordinary_context',db)=='0'
 test('real_mystery_payer_same_award_refuses_different_award_pays',test_mystery_source)
 charge='d1000000-0000-0000-0000-000000000001';entitlement='d2000000-0000-0000-0000-000000000001'
 def refund_fixture(db):
  table=sql(f"SELECT id FROM public.tables WHERE tournament_id='{tid}' LIMIT 1",db)
  fixture(db,f"""UPDATE public.tournaments SET status='COMPLETED' WHERE id='{tid}';
  DELETE FROM public.tournament_refund_entitlements WHERE tournament_id='{tid}' AND user_id='{user}';
  DELETE FROM public.chip_ledger WHERE tournament_id='{tid}' AND from_type='player_wallet' AND from_entity_id='{user}';
  DELETE FROM public.table_seats WHERE user_id='{user}' AND table_id IN(SELECT id FROM public.tables WHERE tournament_id='{tid}');
  INSERT INTO public.chip_ledger(id,performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,tournament_id,created_at,idempotency_key)
   VALUES('{charge}','2d1cd6c3-5700-4af9-a271-d4863fdab20d','player_wallet','{user}','prize_liability','{tid}',35,'rebuy','{club}','{tid}','2027-01-02Z','fixture:rebuy:35');
  INSERT INTO public.tournament_refund_entitlements(id,tournament_id,user_id,entitlement_kind,charge_category,refund_wallet_club_id,gross,refund_prize,refund_bounty,refund_fee,source_ledger_id,escrow_bucket,evidence_kind)
   VALUES('{entitlement}','{tid}','{user}','wallet_charge','rebuy','{club}',35,35,0,0,'{charge}','wallet_gross','atomic_wallet_charge');
  INSERT INTO public.hand_atomic_commits(table_id,hand_number,hand_id,payload_hash,stack_result,committed_at)
   VALUES('{table}',999999999,'d3000000-0000-0000-0000-000000000001',repeat('a',64),'{{}}','2027-01-01Z');
  INSERT INTO public.tournament_knockout_candidates(tournament_id,eliminated_user_id,table_id,seat_id,seat_joined_at,hand_id,hand_number,stack_before,stack_after,state)
   VALUES('{tid}','{user}','{table}',gen_random_uuid(),'2026-01-01Z','d3000000-0000-0000-0000-000000000001',999999999,10,0,'eliminated');""")
 def refund_sql():
  return f"SELECT public.fn_settle_tournament_refund_exact('{tid}','{user}','{club}',35,35,0,0,'atomic_cancel_tournament','Exact fixture refund entitlement');"
 def test_refund_source():
  db=database('mg_refund');refund_fixture(db)
  item=service(f"SELECT public.fn_ca_makegood_propose('undelivered_rebuy','{charge}','{funding}',35,repeat('r',80));",db)['item_id']
  assert pay(db,item)['amount']==35
  assert sql('SELECT count(*) FROM public.tournament_refund_tranches',db)=='0'
  fixture(db,f"UPDATE public.tournaments SET status='RUNNING' WHERE id='{tid}';")
  refuse(refund_sql(),'house make-good disposition',db)
  assert sql('SELECT count(*) FROM public.tournament_refund_tranches',db)=='0'
  assert sql(f"SELECT chip_balance FROM public.club_members WHERE club_id='{club}' AND user_id='{user}'",db)=='135.00'
 test('real_exact_refund_cannot_repay_house_satisfied_charge',test_refund_source)
 def test_refund_first():
  db=database('mg_refund_first');refund_fixture(db)
  fixture(db,f"UPDATE public.tournaments SET status='RUNNING' WHERE id='{tid}';")
  r=service(refund_sql(),db);assert r['paid']==35,r
  fixture(db,f"UPDATE public.tournaments SET status='COMPLETED' WHERE id='{tid}';")
  r=service(f"SELECT public.fn_ca_makegood_propose('undelivered_rebuy','{charge}','{funding}',0,repeat('r',80));",db)
  assert r['item_id'] is None,r
  assert sql('SELECT count(*) FROM ca_makegood.receipts',db)=='0'
 test('real_exact_refund_receipt_eliminates_house_remaining_amount',test_refund_first)
 def test_knockout_source():
  db=database('mg_ko');elim1=core['players'][2]['user_id'];elim2=core['players'][3]['user_id'];table=sql(f"SELECT id FROM public.tables WHERE tournament_id='{tid}' LIMIT 1",db)
  fixture(db,f"""UPDATE public.tournaments SET status='COMPLETED',is_bounty=true,is_pko=false,is_mystery_bounty=false,bounty_amount=7,bounty_pool=50,bounty_pool_paid=0 WHERE id='{tid}';
  UPDATE public.tournament_escrow SET bounty_balance=50,bounty_in=50 WHERE tournament_id='{tid}';
  DELETE FROM public.tournament_bounty_obligations; DELETE FROM public.tournament_bounties;
  INSERT INTO public.tournament_bounty_obligations(id,tournament_id,eliminated_user_id,table_id,hand_id,hand_number,settlement_completed_at,seat_joined_at,position,prize,mode,head_amount,knocker_user_id,claimants,state) VALUES
  ('e1000000-0000-0000-0000-000000000001','{tid}','{elim1}','{table}',gen_random_uuid(),999999997,now(),now(),3,0,'regular',5,'{user}','[{{"user_id":"{user}","weight":1}}]','settled'),
  ('e1000000-0000-0000-0000-000000000002','{tid}','{elim2}','{table}',gen_random_uuid(),999999998,now(),now(),2,0,'regular',7,'{user}','[{{"user_id":"{user}","weight":1}}]','pending');
  INSERT INTO public.tournament_bounties(id,tournament_id,eliminated_player_id,collector_player_id,bounty_amount,added_to_collector_bounty,bounty_obligation_id)
  VALUES('e2000000-0000-0000-0000-000000000001','{tid}','{elim1}','{user}',5,0,'e1000000-0000-0000-0000-000000000001');
  UPDATE public.tournament_players SET current_bounty=7,status='eliminated',chips=0,chip_count=0 WHERE tournament_id='{tid}' AND user_id='{elim2}';""")
  item=service(f"SELECT public.fn_ca_makegood_propose('knockout_record','e2000000-0000-0000-0000-000000000001','{funding}',5,repeat('r',80));",db)['item_id']
  assert pay(db,item)['amount']==5
  fixture(db,f"UPDATE public.tournaments SET status='RUNNING' WHERE id='{tid}';")
  first=service(f"SELECT public.fn_collect_bounty('{tid}','{elim1}','{user}');",db);assert first['already'],first
  second=service(f"SELECT public.fn_collect_bounty('{tid}','{elim2}','{user}');",db);assert second['ok'] and second['paid_cash']==7,second
  assert sql("SELECT sum(amount) FROM ca_makegood.ordinary_receipts WHERE source_identity='knockout:e1000000-0000-0000-0000-000000000002'",db)=='7.00'
  assert sql(f"SELECT chip_balance FROM public.club_members WHERE club_id='{club}' AND user_id='{user}'",db)=='112.00'
 test('real_knockout_payer_preserves_first_marker_and_pays_distinct_ko',test_knockout_source)
 def test_imports_and_evidence():
  db=database('mg_import');assert normal(db,20)['paid']==20
  adj=sql(f"INSERT INTO public.ca_manual_adjustments(actor,actor_label,reason,amount,target_kind,target_id,tournament_id,status,asset) VALUES('2d1cd6c3-5700-4af9-a271-d4863fdab20d','fixture',repeat('r',80),15,'player_wallet','{user}','{tid}','proposed','chips') RETURNING id",db)
  r=service(f"SELECT public.fn_ca_makegood_propose('place_obligation','{ob}','{funding}',15,repeat('r',80),'{adj}');",db);assert r['adjustment_id']==adj
  assert pay(db,r['item_id'])['amount']==15
  db=database('mg_unproven');assert normal(db,20)['paid']==20
  fixture(db,f"UPDATE public.chip_ledger SET idempotency_key=NULL WHERE idempotency_key='tourney:{tid}:obl:{ob}:0';")
  refuse(f"SELECT public.fn_ca_makegood_propose('place_obligation','{ob}','{funding}',15,repeat('r',80));",'lacks exact credit and ledger evidence',db)
  db=database('mg_no_fund')
  refuse(f"SELECT public.fn_ca_makegood_propose('place_obligation','{ob}','00000000-0000-0000-0000-000000000001',35,repeat('r',80));",'funding authorization missing',db)
  refuse(f"SELECT public.fn_ca_makegood_register_funding('{ob}',repeat('r',80));",'funding',db)
 test('imported_net_is_bound_to_total_and_unproven_receipt_stays_ineligible',test_imports_and_evidence)
 def test_timezones_and_normal_error():
  db=database('mg_timezones')
  item=query(f"SET ROLE service_role; SET timezone='Pacific/Auckland'; SELECT public.fn_ca_makegood_propose('place_obligation','{ob}','{funding}',35,repeat('r',80));",db)['item_id']
  r=query(f"SET ROLE service_role; SET timezone='America/Los_Angeles'; SELECT public.fn_ca_makegood_pay('{item}');",db)
  assert r['amount']==35 and pay(db,item)==r
  db=database('mg_credit_error')
  sql("CREATE FUNCTION public.fixture_credit_error() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ordinary receipt sink failed'; END $$; CREATE TRIGGER a_fixture_error BEFORE INSERT ON public.wallet_transactions FOR EACH ROW EXECUTE FUNCTION public.fixture_credit_error();",db)
  sql(f"""SET ROLE service_role; DO $$ BEGIN
    PERFORM set_config('app.ledger_idempotency_key','prior-normal-key',true);
    BEGIN PERFORM public.fn_settle_tournament_obligation('{tid}','place',1,'{user}',20,'engine.fixture'); RAISE EXCEPTION 'unexpected credit';
    EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'ordinary receipt sink failed' THEN RAISE; END IF; END;
    IF current_setting('app.ledger_idempotency_key')<>'prior-normal-key' THEN RAISE EXCEPTION 'ordinary error leaked its key'; END IF;
   END $$;""",db)
  assert sql(f"SELECT chip_balance FROM public.club_members WHERE club_id='{club}' AND user_id='{user}'",db)=='100.00'
  assert sql(f"SELECT count(*) FROM public.wallet_credit_idempotency WHERE key LIKE 'tourney:{tid}:obl:%'",db)=='0'
 test('cross_timezone_evidence_and_ordinary_error_restore_ambient_key',test_timezones_and_normal_error)
 if a.d12_migration:
  def test_d12_exact_refund():
   db=database('mg_d12_refund');refund_fixture(db)
   fixture(db,f"UPDATE public.tournaments SET status='RUNNING' WHERE id='{tid}';")
   # Sealed E2 pg_get_functiondef capture omits ACLs. Restore separately
   # observed production ACLs before D12's strict metadata assertions.
   for signature in ['fn_settle_tournament_places(uuid,uuid)','fn_complete_tournament_terminal(uuid,uuid,text)','trg_tournament_atomic_place_completion_guard()','trg_freeze_batched_tournament_place()','fn_tournament_finish_readiness(uuid,uuid)']:
    sql(f'REVOKE ALL ON FUNCTION public.{signature} FROM PUBLIC,anon,authenticated,service_role;',db)
    if not signature.startswith('fn_tournament_finish_readiness'):
     sql(f'GRANT EXECUTE ON FUNCTION public.{signature} TO service_role;',db)
   command(base+['-d',db,'-f',str(d12_source)])
   r=service(refund_sql(),db);assert r['paid']==35,r
   snapshot=f"SELECT jsonb_build_object('tournament',(SELECT to_jsonb(t) FROM public.tournaments t WHERE id='{tid}'),'escrow',(SELECT to_jsonb(e) FROM public.tournament_escrow e WHERE tournament_id='{tid}'),'obligations',(SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM public.tournament_obligations o WHERE tournament_id='{tid}'),'tranches',(SELECT jsonb_agg(to_jsonb(t) ORDER BY wallet_transaction_id) FROM public.tournament_refund_tranches t WHERE tournament_id='{tid}'),'ledger',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM public.chip_ledger l WHERE tournament_id='{tid}'),'wallet',(SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM public.wallet_transactions w WHERE related_entity_id='{tid}'),'keys',(SELECT jsonb_agg(to_jsonb(k) ORDER BY key) FROM public.wallet_credit_idempotency k WHERE key LIKE 'tourney:{tid}:%'))"
   before=query(snapshot,db)
   refuse(refund_sql(),'do not equal newly owed amount 0.00',db)
   assert query(snapshot,db)==before
   guards=query("SELECT jsonb_agg(jsonb_build_object('name',tgname,'enabled',tgenabled) ORDER BY tgname) FROM pg_trigger WHERE tgrelid='public.tournaments'::regclass AND tgname IN('aa_guard_tournament_completing_claim','zzzz_freeze_finalized_tournament_prize_pool','zzzz_tournament_pool_finalization_window_guard','zzzz_tournaments_atomic_place_completion_guard','zzzzz_tournaments_atomic_final_table_deal_completion_guard','zzzzzz_tournaments_financial_certificate','aaa_guard_atomic_satellite_completion')",db)
   assert len(guards)==7 and all(g['enabled']=='O' for g in guards),guards
   (a.evidence/'d12-refund-composition.json').write_text(json.dumps({'status':'passed','d12_sha256':hashlib.sha256(d12_source.read_bytes()).hexdigest(),'migration_sha256':hashlib.sha256(migration.read_bytes()).hexdigest(),'refund':r,'replay':'exact authority refused already-satisfied amount; complete financial state unchanged','guards':guards},indent=2))
  test('d12_first_real_funded_exact_refund_and_no_change_refused_replay',test_d12_exact_refund)
 summary={'status':'passed','postgres':version,'fixture_sha256':expected,'migration_sha256':hashlib.sha256(migration.read_bytes()).hexdigest(),'accepted_settlement_migration_sha256':hashlib.sha256(accepted_source.read_bytes()).hexdigest(),'tests':results,'runtime':str(work)}
 (a.evidence/'result.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary))
finally:
 if started:command([str(pg/'pg_ctl'),'-D',str(work/'data'),'-m','fast','-w','stop'])
