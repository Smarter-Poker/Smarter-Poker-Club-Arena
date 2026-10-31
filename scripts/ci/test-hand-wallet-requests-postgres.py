#!/usr/bin/env python3
"""Private PG17 qualification for the owner's October 21 cashier requests."""
import os, json, shutil, subprocess, tempfile, sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
PG=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin' if Path('/Volumes/SmarterWork').exists() else '/usr/lib/postgresql/17/bin'))
parent=os.environ.get('TMPDIR',os.environ.get('RUNNER_TEMP'))
cluster=Path(tempfile.mkdtemp(prefix='request-wallet-',dir=parent)); sock=cluster/'s';sock.mkdir()
def run(cmd,text=None):
 p=subprocess.run([str(v) for v in cmd],input=text,text=True,capture_output=True,timeout=60)
 if p.returncode: raise RuntimeError(p.stderr[-6000:]+p.stdout[-2000:])
 return p.stdout.strip()
def q(text):return run([PG/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',sock,'-U','postgres','-d','postgres'],text)
def f(name):return (ROOT/name).read_text()
started=False
try:
 run([PG/'initdb','-D',cluster/'data','-U','postgres','-A','trust','--no-locale','-E','UTF8'])
 run([PG/'pg_ctl','-D',cluster/'data','-l',cluster/'log','-o',f"-h '' -k {sock}",'-w','start']);started=True
 assert q("select inet_server_addr() is null and current_setting('listen_addresses')='';")=='t'
 q(f('scripts/ci/fixtures/chip-wallet-choice/setup.sql'))
 q(f('scripts/ci/fixtures/chip-wallet-choice/selected-setup.sql'))
 q(f('scripts/ci/fixtures/chip-wallet-choice/fn_agent_wallet_send_core_20261004.sql'))
 q(f('tests/fixtures/hand-wallet/agent-before.sql'))
 q(f('tests/fixtures/hand-wallet/intent-guard.sql'))
 q('CREATE TRIGGER cashier_operation_intent_guard BEFORE INSERT ON chip_transactions FOR EACH ROW EXECUTE FUNCTION fn_cashier_operation_intent_guard();')
 q("""CREATE FUNCTION fn_union_can_manage_wallets(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $2='00000000-0000-0000-0000-000000000003'::uuid $$;
 CREATE FUNCTION fn_club_cashier_scope(uuid,uuid) RETURNS text LANGUAGE sql AS $$ SELECT CASE WHEN EXISTS(SELECT 1 FROM club_members WHERE club_id=$1 AND user_id=$2 AND role IN ('owner','agent') AND status='active') THEN 'downline' ELSE 'none' END $$;
 CREATE FUNCTION fn_club_active_cashier_edges(uuid) RETURNS TABLE(child uuid,parent uuid) LANGUAGE sql AS $$ SELECT user_id,agent_id FROM club_members WHERE club_id=$1 AND status='active' $$;
 CREATE FUNCTION fn_cashier_member_is_active(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT EXISTS(SELECT 1 FROM club_members WHERE club_id=$1 AND user_id=$2 AND status='active') $$;
 CREATE TABLE profiles(id uuid,alias text,username text,display_name text,first_name text,last_name text,full_name text,player_number text,avatar_url text,arena_avatar_url text);
 CREATE FUNCTION fn_arena_name(text,text,text,text,text,text) RETURNS text LANGUAGE sql AS $$ SELECT coalesce($1,$2,$3,$6) $$;
 INSERT INTO profiles(id,username) SELECT user_id,role||user_id::text FROM club_members;
 SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',false);""")
 def send(amount=25,dest='player_wallet',op='11111111-1111-4111-8111-111111111111',target='00000000-0000-0000-0000-000000000003'):
  return json.loads(q("SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',false); SELECT fn_agent_wallet_send('00000000-0000-0000-0000-000000000001','%s',%s,'%s','Self Funding','%s');"%(target,amount,dest,op)).splitlines()[-1])
 assert not send()['success'],'baseline must reproduce self refusal'
 q(f('supabase/migrations/20261021172828_agent_wallet_can_fund_own_player_wallet.sql'))
 assert send()['success']
 assert send()['replayed']
 assert q("SELECT agent_wallet_balance=975 FROM agents WHERE user_id='00000000-0000-0000-0000-000000000003';")=='t'
 assert q("SELECT chip_balance=25 FROM club_members WHERE user_id='00000000-0000-0000-0000-000000000003';")=='t'
 assert q("SELECT count(*)=1 FROM chip_transactions WHERE transaction_type='agent_wallet_send';")=='t'
 with ThreadPoolExecutor(max_workers=2) as pool:
  raced=list(pool.map(lambda _:send(1,op='66666666-6666-4666-8666-666666666666'),range(2)))
 assert all(result['success'] for result in raced) and sum(bool(result.get('replayed')) for result in raced)==1
 assert q("SELECT agent_wallet_balance=974 FROM agents WHERE user_id='00000000-0000-0000-0000-000000000003';")=='t'
 assert q("SELECT chip_balance=26 FROM club_members WHERE user_id='00000000-0000-0000-0000-000000000003';")=='t'
 assert q("SELECT count(*)=2 FROM chip_transactions WHERE transaction_type='agent_wallet_send';")=='t'
 assert not send(26)['success'],'changed retry intent must refuse'
 assert not send(1,'agent_wallet','22222222-2222-4222-8222-222222222222')['success']
 assert not send(1,'promo_wallet','33333333-3333-4333-8333-333333333333')['success']
 assert not send(2000,op='44444444-4444-4444-8444-444444444444')['success']
 assert not send(1,op='55555555-5555-4555-8555-555555555555',target='00000000-0000-0000-0000-000000000002')['success']
 assert q("SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',false); SELECT count(*)=3 FROM fn_club_cashier_members('00000000-0000-0000-0000-000000000001');").splitlines()[-1]=='t'
 # Every agent tier takes the same public send chain, not just the agent fixture.
 import uuid
 from decimal import Decimal
 for tier in ['super_agent','agent','sub_agent']:
  q("UPDATE club_members SET role='%s' WHERE user_id='00000000-0000-0000-0000-000000000003';"%tier)
  before=q("SELECT chip_balance+agent_wallet_balance FROM club_members m JOIN agents a USING(club_id,user_id) WHERE user_id='00000000-0000-0000-0000-000000000003';")
  op=str(uuid.uuid4()); result=send(0.01,op=op)
  assert result['success'],(tier,result)
  assert send(0.01,op=op)['replayed'],tier
  assert Decimal(q("SELECT chip_balance+agent_wallet_balance FROM club_members m JOIN agents a USING(club_id,user_id) WHERE user_id='00000000-0000-0000-0000-000000000003';"))==Decimal(before),tier
  assert not send(0.001,op=str(uuid.uuid4()))['success'],tier
  assert not send(0.01,'promo_wallet',str(uuid.uuid4()))['success'],tier
  assert not send(0.01,'agent_wallet',str(uuid.uuid4()))['success'],tier
 q("UPDATE club_members SET role='agent' WHERE user_id='00000000-0000-0000-0000-000000000003';")
 print('PASS: all three agent tiers public self-send, cent conservation, exact replay, precision, self-promo and same-wallet refusal')
 q(f('supabase/migrations/20261021172727_union_wallet_intents_survive_unavailable_browser_storage.sql'))
 reserve="SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',false); SELECT fn_union_wallet_reserve_intent('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','chips','exact intent',NULL);"
 with ThreadPoolExecutor(max_workers=4) as pool:
  reserved=list(pool.map(lambda _:q(reserve).splitlines()[-1],range(4)))
 assert len(set(reserved))==1,'simultaneous tabs must share one operation ID'
 first=reserved[0];assert q(reserve).splitlines()[-1]==first
 # A different scope cannot overwrite the first, and a stale acknowledgement cannot retire it.
 q("SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',false); SELECT fn_union_wallet_acknowledge_intent('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','chips','exact intent','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');")
 assert q(reserve).splitlines()[-1]==first
 q("SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',false); SELECT fn_union_wallet_acknowledge_intent('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','chips','exact intent','"+first+"');")
 assert q(reserve).splitlines()[-1]!=first
 try:q("SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000005',false); SELECT fn_union_wallet_reserve_intent('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','chips','exact intent',NULL);")
 except RuntimeError as e: assert 'Union Wallet Access Is Required' in str(e)
 else: raise AssertionError('unauthorized reservation accepted')
 assert q("SELECT has_table_privilege('authenticated','union_wallet_browser_intents','SELECT');")=='f'
 q("""CREATE TABLE ca_declared_money_triggers(table_name text,trigger_name text,note text,PRIMARY KEY(table_name,trigger_name));
 CREATE TABLE tournaments(id integer,status text,tournament_type text,variant text,blind_speed text,accelerated_mtt boolean,blind_structure text,late_reg_levels integer,late_reg_mins integer,buy_in_amount numeric,prize_pool numeric);
 CREATE TABLE tournament_schedules(id integer,active boolean,config jsonb);
 INSERT INTO tournaments VALUES (1,'REGISTERING','MTT','freezeout','turbo',false,'[{"smallBlind":25,"bigBlind":50,"durationMinutes":2}]',1,2,20,100),
 (2,'RUNNING','MTT','freezeout','standard',false,'[{"smallBlind":25,"bigBlind":50,"duration":120}]',1,2,20,100),
 (3,'RUNNING','MTT','freezeout','turbo',true,'[{"smallBlind":25,"bigBlind":50,"duration_minutes":2}]',1,2,20,100),
 (4,'COMPLETED','MTT','freezeout','turbo',false,'[{"smallBlind":25,"bigBlind":50,"durationMinutes":2}]',1,2,20,100);
 INSERT INTO tournament_schedules VALUES (1,true,'{"blindPreset":"TURBO","blindStructure":[{"smallBlind":25,"bigBlind":50,"durationMinutes":2}]}');""")
 q(f('supabase/migrations/20261021173101_tournament_levels_have_a_five_minute_floor.sql'))
 assert json.loads(q("SELECT json_agg((blind_structure::jsonb->0->>'durationMinutes')::int ORDER BY id) FROM tournaments WHERE id<4;"))==[5,8,10]
 assert q("SELECT late_reg_mins=5 AND buy_in_amount=20 AND prize_pool=100 FROM tournaments WHERE id=1;")=='t'
 assert q("SELECT blind_structure::jsonb->0->>'durationMinutes'='2' FROM tournaments WHERE id=4;")=='t'
 assert q("SELECT config->'blindStructure'->0->>'durationMinutes'='5' FROM tournament_schedules WHERE id=1;")=='t'
 q("""INSERT INTO tournaments(id,status,tournament_type,variant,blind_structure) VALUES(5,'REGISTERING','SPIN','spin','[{"duration":180}]');""")
 assert q("SELECT (blind_structure::jsonb->0->>'duration')::int=300 FROM tournaments WHERE id=5;")=='t'
 q("UPDATE tournaments SET late_reg_levels=4,blind_structure='[{\"durationMinutes\":2}]' WHERE id=1;")
 assert q("SELECT late_reg_mins=20 FROM tournaments WHERE id=1;")=='t'
 q("UPDATE tournaments SET late_reg_levels=4,blind_structure='[{\"durationMinutes\":2},{\"isBreak\":true,\"durationMinutes\":3}]' WHERE id=1;")
 assert q("SELECT late_reg_mins=15 FROM tournaments WHERE id=1;")=='t'
 print('PASS: all 205 newest-player rows across three cursor pages and full export, ties, persisted clock correction, aliases, standard eight-minute floor, acceleration compatibility, future Spin floor, settled history and amounts unchanged')
 print('PASS: self-player funding, exact replay, changed intent refusal, source conservation, other destinations refused, downline privacy, durable union reservation, compare-and-delete, authorization and table ACL')
finally:
 if started:run([PG/'pg_ctl','-D',cluster/'data','-m','fast','-w','stop'])
 shutil.rmtree(cluster)

# Same maintained native gate qualifies browser-independent recovery as well.
subprocess.run([sys.executable,str(ROOT/'scripts/ci/test-cashier-browser-recoveries-postgres.py')],check=True,timeout=60)
