#!/usr/bin/env python3
"""Private PG17 qualification for the owner's October 21 cashier requests."""
import os, json, shutil, subprocess, tempfile
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
 assert not send(26)['success'],'changed retry intent must refuse'
 assert not send(1,'agent_wallet','22222222-2222-4222-8222-222222222222')['success']
 assert not send(1,'promo_wallet','33333333-3333-4333-8333-333333333333')['success']
 assert not send(2000,op='44444444-4444-4444-8444-444444444444')['success']
 assert not send(1,op='55555555-5555-4555-8555-555555555555',target='00000000-0000-0000-0000-000000000002')['success']
 assert q("SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',false); SELECT count(*)=3 FROM fn_club_cashier_members('00000000-0000-0000-0000-000000000001');").splitlines()[-1]=='t'
 q(f('supabase/migrations/20261021172727_union_wallet_intents_survive_unavailable_browser_storage.sql'))
 reserve="SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',false); SELECT fn_union_wallet_reserve_intent('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','chips','exact intent',NULL);"
 first=q(reserve).splitlines()[-1];assert q(reserve).splitlines()[-1]==first
 # A different scope cannot overwrite the first, and a stale acknowledgement cannot retire it.
 q("SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',false); SELECT fn_union_wallet_acknowledge_intent('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','chips','exact intent','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');")
 assert q(reserve).splitlines()[-1]==first
 q("SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',false); SELECT fn_union_wallet_acknowledge_intent('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','chips','exact intent','"+first+"');")
 assert q(reserve).splitlines()[-1]!=first
 try:q("SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000005',false); SELECT fn_union_wallet_reserve_intent('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','chips','exact intent',NULL);")
 except RuntimeError as e: assert 'Union Wallet Access Is Required' in str(e)
 else: raise AssertionError('unauthorized reservation accepted')
 assert q("SELECT has_table_privilege('authenticated','union_wallet_browser_intents','SELECT');")=='f'
 q("""CREATE TABLE roster_values(user_id uuid,management_club_id uuid,home_club_id uuid,home_club_name text,player_number text,alias text,username text,display_name text,avatar_url text,role text,role_rank integer,is_online boolean,is_seated boolean,chip_balance numeric,player_wallet numeric,agent_wallet numeric,promo_wallet numeric,total_fees numeric,downline_fees numeric,total_hands bigint,downline_direct integer,downline_total integer,upline_user_id uuid,upline_name text,joined_at timestamptz,last_login timestamptz,nickname text,remark text,can_view_financials boolean,can_view_notes boolean,in_viewer_downline boolean);
 CREATE FUNCTION ca_club_roster_rows(uuid) RETURNS SETOF roster_values LANGUAGE sql AS $$ SELECT * FROM roster_values WHERE management_club_id=$1 $$;
 CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'authenticated'::text $$;
 CREATE FUNCTION fn_club_scope_ids(uuid) RETURNS uuid[] LANGUAGE sql AS $$ SELECT ARRAY[$1] $$;
 CREATE FUNCTION fn_is_union_overseer(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
 CREATE FUNCTION fn_club_role_rank(text) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
 ALTER TABLE profiles ADD COLUMN is_admin boolean DEFAULT false;
 CREATE TABLE audit_trail(id uuid DEFAULT gen_random_uuid(),actor_id uuid,actor_role text,action text,target_type text,target_id uuid,club_id uuid,after_state jsonb,reason text);
 INSERT INTO roster_values(user_id,management_club_id,alias,username,role,role_rank,joined_at,can_view_financials)
 SELECT ('10000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'00000000-0000-0000-0000-000000000001',lpad((206-i)::text,3,'0'),'P'||i,'player',1,'2026-10-01'::timestamptz-(i%7)*interval '1 day',true FROM generate_series(1,205) i;""")
 q(f('tests/fixtures/hand-wallet/roster-before.sql'))
 roster_call="SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false); SELECT ca_club_members_page('00000000-0000-0000-0000-000000000001','','all','newest',%s,80);"
 expected=json.loads(q("SELECT json_agg(user_id ORDER BY joined_at DESC,user_id) FROM roster_values;"))
 before=json.loads(q(roster_call%'NULL').splitlines()[-1])
 assert [r['user_id'] for r in before['items']]!=expected[:80]
 q(f('supabase/migrations/20261021172603_newest_joined_roster_ordering.sql'))
 collected=[];cursor='NULL'
 while True:
  page=json.loads(q(roster_call%cursor).splitlines()[-1]);collected += [r['user_id'] for r in page['items']]
  if not page['has_more']:break
  cursor="'"+json.dumps(page['next_cursor']).replace("'","''")+"'::jsonb"
 assert collected==expected and len(set(collected))==205
 exported=json.loads(q("SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false); SELECT ca_club_members_export('00000000-0000-0000-0000-000000000001','','all','newest',NULL);").splitlines()[-1])
 assert [r['user_id'] for r in exported['rows']]==expected
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
