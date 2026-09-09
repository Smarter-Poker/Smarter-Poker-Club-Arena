#!/usr/bin/env python3
"""Phase 4 transfer behavior against an isolated PostgreSQL database."""
import concurrent.futures,json,subprocess,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
PG='/opt/homebrew/opt/postgresql@17/bin/'
BASE=[PG+'psql','-h','/tmp/codex-diamond-phase2-pg','-p','55472','-v','ON_ERROR_STOP=1','-At']
DB='poker_diamond_phase4_test'
def sql(q,ok=True):
 r=subprocess.run(BASE+['-d',DB,'-c',q],text=True,capture_output=True)
 if ok and r.returncode: raise AssertionError(r.stderr)
 return r.stdout.strip() if ok else r
exists=subprocess.run(BASE+['-d','postgres','-c',"SELECT 1 FROM pg_database WHERE datname='"+DB+"'"],text=True,capture_output=True,check=True).stdout.strip()
if not exists: subprocess.run(BASE+['-d','postgres','-c','CREATE DATABASE '+DB],check=True,capture_output=True)
fixture=(ROOT/'tests/sql/poker-diamond-custody.sql').read_text().split('CREATE TEMP TABLE receipts')[0]
fixture=fixture.replace('poker_diamond_phase3_test',DB)
for line in fixture.splitlines():
 if line.startswith('\\ir '):
  fixture=fixture.replace(line,'\\ir '+str((ROOT/'tests/sql'/line[4:]).resolve()))
fixture += """
ALTER TABLE profiles ADD COLUMN created_at timestamptz DEFAULT now()-interval '180 days', ADD COLUMN is_farming_flagged boolean DEFAULT false;
CREATE TABLE friendships(id uuid DEFAULT gen_random_uuid(),user_id uuid,friend_id uuid,status text);
CREATE TABLE live_streams(id uuid,broadcaster_id uuid);
CREATE TABLE live_bans(stream_id uuid,banned_user_id uuid);
CREATE TABLE diamond_purchases(user_id uuid,status text,completed_at timestamptz,refunded_at timestamptz);
INSERT INTO profiles(id,diamonds) VALUES('10000000-0000-0000-0000-000000000002',1000),('10000000-0000-0000-0000-000000000003',1000);
INSERT INTO friendships(user_id,friend_id,status) VALUES('10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002','accepted');
"""
fixture+='\n\\ir '+str(ROOT/'tests/sql/poker-diamond-production-wallet-fixture.sql')
fixture+='\n\\ir '+str(ROOT/'tests/sql/diamond-transfer-cap-fixture.sql')
fixture+='\n\\ir '+str(ROOT/'supabase/migrations/20260909200327_atomic_wallet_diamond_transfers.sql')
r=subprocess.run(BASE+['-d',DB],input=fixture,text=True,capture_output=True)
if r.returncode: raise AssertionError(r.stderr)
A='10000000-0000-0000-0000-000000000001'; B='10000000-0000-0000-0000-000000000002'; C='10000000-0000-0000-0000-000000000003'
passed=0
def check(c,label):
 global passed
 assert c,label
 passed+=1;print('PASS',label,flush=True)
def send(amount=100,request=None,sender=A,recipient=B):
 ref=request or str(uuid.uuid4())
 r=sql("SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','"+sender+"',false); SELECT send_wallet_diamond_transfer('"+recipient+"',"+str(amount)+",NULL,'"+ref+"')",False)
 if r.returncode:return r
 return json.loads(r.stdout.strip().splitlines()[-1])
ref=str(uuid.uuid4()); first=send(request=ref)
check(isinstance(first,dict) and first['success'],'authenticated friend transfer')
check(first==send(request=ref),'response-loss replay exact receipt')
check(send(amount=101,request=ref).returncode!=0,'changed replay refused')
check(send(recipient=C).returncode!=0,'nonfriend refused')
check(send(recipient=A).returncode!=0,'self transfer refused')
check(send(amount=0).returncode!=0,'zero refused')
check(sql("SET ROLE anon; SELECT send_wallet_diamond_transfer(NULL,1,NULL,NULL)",False).returncode!=0,'anonymous refused')
check(sql('SELECT sum(amount) FROM diamond_transactions')=='0','both journals conserve')
check(sql("SELECT count(*) FROM diamond_transactions WHERE counterparty='player:unknown'")=='0','counterparties explicit')
check(sql('SELECT sum(consumed) FROM diamond_purchase_lots')=='0','purchased collateral untouched')
check(send(amount=401)['code']=='insufficient_transferable_diamonds','refund collateral not transferable')
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
 results=list(pool.map(lambda _:send(amount=300),range(2)))
check(sum(isinstance(r,dict) and r.get('success',False) for r in results)==1,'competing transfers cannot overspend')
check(sql('SELECT count(*) FROM diamond_wallet_transfers')=='2','only committed receipts exist')
sql("INSERT INTO diamond_debts(user_id,amount,reason) VALUES('"+A+"',60,'fixture reversal')")
debt=send(amount=100,sender=B,recipient=A)
check(debt['success'] and sql("SELECT count(*) FROM diamond_debts WHERE settled_at IS NOT NULL")=='1','positive transfer settles recipient debt')
check(sql("SELECT sum(amount) FROM ca_mint_ledger WHERE action='burn'")=='60','debt retirement registered')
sql("CREATE FUNCTION fixture_fail_transfer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='diamond_gift_received' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_fail_transfer BEFORE INSERT ON diamond_transactions FOR EACH ROW EXECUTE FUNCTION fixture_fail_transfer()")
before=sql('SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM profiles p')
check(send(amount=10,sender=B,recipient=A).returncode!=0,'credit journal error propagates')
check(before==sql('SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM profiles p'),'credit failure rolls back both balances')
sql('DROP TRIGGER fixture_fail_transfer ON diamond_transactions')
check(sql("SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','"+C+"',false); SELECT count(*) FROM diamond_wallet_transfers").splitlines()[-1]=='0','unrelated user cannot read receipts')
check(sql('UPDATE diamond_wallet_transfers SET amount=1',False).returncode!=0,'receipts immutable')
# Held purchased collateral must not be subtracted from available twice.
reserve=json.loads(sql("SELECT fn_poker_diamond_reserve('"+A+"','cash_seat','30000000-0000-0000-0000-000000000001','transfer-isolation',100,'"+str(uuid.uuid4())+"')"))
held=sql('SELECT jsonb_agg(to_jsonb(c)) FROM poker_diamond_custody c')
check(send(amount=10)['success'],'available promotion remains transferable with purchased custody')
check(held==sql('SELECT jsonb_agg(to_jsonb(c)) FROM poker_diamond_custody c'),'transfer leaves custody unchanged')
# Concurrent delivery and the actual existing spend writer.
ref=str(uuid.uuid4())
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
 replays=list(pool.map(lambda _:send(amount=10,request=ref,sender=B,recipient=A),range(3)))
check(all(x==replays[0] for x in replays),'concurrent delivery returns one receipt')
check(sql("SELECT count(*) FROM diamond_wallet_transfers WHERE request_id='"+ref+"'")=='1','concurrent delivery journals once')
before=sql('SELECT sum(diamonds)+fn_ca_arena_diamonds() FROM profiles')
def spend():
 return json.loads(sql("SELECT add_diamonds_to_balance('"+B+"',-700,'deduction','fixture store spend','"+str(uuid.uuid4())+"')"))
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
 a=pool.submit(send,700,None,B,A); b=pool.submit(spend)
 results=[a.result(),b.result()]
check(sum(isinstance(r,dict) and r.get('success',False) for r in results)==1,'transfer versus store spend serializes on available balance')
check(sql('SELECT min(diamonds)>=0 FROM profiles')=='t','race never overdraws')
check(sql("SELECT count(*) FROM diamond_wallet_transfers WHERE to_jsonb(diamond_wallet_transfers) ? 'recipient_balance'")=='0','receipt does not expose recipient balance')

# Exercise the actual reserve writer against the same available balance.
amount=int(sql("SELECT diamonds FROM profiles WHERE id='"+B+"'"))//2+1
before=sql('SELECT sum(diamonds)+fn_ca_arena_diamonds() FROM profiles')
def reserve_race():
 r=sql("SELECT fn_poker_diamond_reserve('"+B+"','cash_seat','30000000-0000-0000-0000-000000000001','transfer-race',"+str(amount)+",'"+str(uuid.uuid4())+"')",False)
 if r.returncode:
  assert 'insufficient_settled_diamonds' in r.stderr,r.stderr
  return r
 return json.loads(r.stdout.strip())
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
 a=pool.submit(send,amount,None,B,A); b=pool.submit(reserve_race)
 results=[a.result(),b.result()]
check(sum(isinstance(r,dict) and r.get('success',False) for r in results)==1,'transfer versus reserve spends once')
check(before==sql('SELECT sum(diamonds)+fn_ca_arena_diamonds() FROM profiles'),'reserve race conserves available plus custody')

print(str(passed)+' Phase 4 assertions passed')
