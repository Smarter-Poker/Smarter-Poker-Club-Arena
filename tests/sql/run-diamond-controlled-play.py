#!/usr/bin/env python3
"""One connected local-only buy-in -> real NLH hand -> accepted SQL -> cash-out."""
import json
import os
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
SQL = ROOT / 'tests/sql'
DB = 'poker_diamond_phase6_play_test'
PG_BIN = os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin')
BIN = PG_BIN + '/'
CONN = ['-h', '/tmp/codex-diamond-phase2-pg', '-p', '55472']
CMD = [BIN+'psql', '-X', '-q', '-At', *CONN, '-d', DB,
       '-v', 'ON_ERROR_STOP=1', '-P', 'pager=off']
T = '30000000-0000-0000-0000-000000000001'
C = '20000000-0000-0000-0000-000000000001'
A = '10000000-0000-0000-0000-000000000001'
B = '10000000-0000-0000-0000-000000000002'
LEASE = '70000000-0000-0000-0000-000000000001'
SESSION = '60000000-0000-0000-0000-000000000001'

def run(sql):
    with tempfile.NamedTemporaryFile(mode='w', suffix='.sql', dir=SQL) as f:
        f.write(sql)
        f.flush()
        r = subprocess.run(CMD+['-f', f.name], text=True, capture_output=True,
                           cwd=SQL, timeout=60)
    if r.returncode:
        raise RuntimeError(r.stderr+r.stdout)
    return r.stdout.strip()

def read(name):
    return (SQL/name).read_text()

def prefix(text, marker):
    assert text.count(marker) == 1, marker
    return text.split(marker)[0]

def literal(value):
    return "'"+str(value).replace("'", "''")+"'"

def json_sql(value):
    return literal(json.dumps(value))+'::jsonb'

def actor(uid):
    claims=json.dumps({'role':'authenticated','session_id':SESSION})
    return (f"SET ROLE authenticated; SET request.jwt.claim.role='authenticated'; "
            f"SET request.jwt.claim.sub='{uid}'; SET request.jwt.claims={literal(claims)};")

def check(condition, label):
    assert json.loads(run('SELECT to_json('+condition+');')) is True, label
    print('PASS: '+label, flush=True)

# This fixed socket and reserved database name cannot be redirected via an env var.
exists=subprocess.run([BIN+'psql','-X','-q','-At',*CONN,'-d','postgres',
    '-c',f"SELECT 1 FROM pg_database WHERE datname='{DB}'"],
    text=True,capture_output=True,check=True,timeout=10).stdout.strip()
if exists != '1':
    subprocess.run([BIN+'createdb',*CONN,DB],check=True,timeout=10)
base=prefix(read('poker-diamond-custody.sql'),'CREATE TEMP TABLE receipts AS')
assert base.count('poker_diamond_phase3_test') == 1
base=base.replace('poker_diamond_phase3_test',DB)
base=base.replace('DROP SCHEMA IF EXISTS public CASCADE;',
                  "SET client_min_messages='warning'; DROP SCHEMA IF EXISTS public CASCADE;")
foundation=prefix(read('poker-diamond-cash-custody-setup.sql'),'CREATE TEMP TABLE game_custody AS')
admission=prefix(read('poker-diamond-cash-admission-setup.sql'),'CREATE FUNCTION fixture_diamond_buyin')
assert admission.count('poker_diamond_phase6_test') == 1
admission=admission.replace('poker_diamond_phase6_test',DB)
schema=read('poker-diamond-accepted-hand-schema.sql')
duplicate='ADD COLUMN status text,'
assert schema.count(duplicate) == 1
schema=schema.replace(duplicate,'')
accepted_setup=prefix(read('poker-diamond-accepted-hand-setup.sql'),'CREATE TABLE fixture_accepted_payload AS')
run(base+foundation+admission+schema+
    '\n\\ir poker-diamond-accepted-hand-prerequisites.sql\n'
    '\\ir ../../supabase/migrations/20260910030442_diamond_accepted_hands_retain_history_without_chip_obligatio.sql\n'
    +accepted_setup+
    f"\nUPDATE ca_arena_settings SET cash_games_enabled=true; INSERT INTO auth.sessions(id) VALUES('{SESSION}');")
initial=json.loads(run('SELECT to_json(sum(diamonds)) FROM profiles;'))
assert initial == 2000
for uid,seat,key in [(A,1,'40000000-0000-0000-0000-000000000016'),
                     (B,2,'40000000-0000-0000-0000-000000000017')]:
    buy=f"SELECT atomic_table_buyin('{uid}','{T}',{seat},100,false,'{C}','{key}');"
    run(actor(uid)+buy)
    receipt=run(actor(uid)+f"SELECT fn_ca_cash_buyin_receipt('{key}','{T}');")
    assert json.loads(receipt)['status']=='confirmed'
    run(actor(uid)+buy)
    assert receipt==run(actor(uid)+f"SELECT fn_ca_cash_buyin_receipt('{key}','{T}');")
check('(SELECT sum(diamonds)=1800 FROM profiles) AND (SELECT sum(balance)=200 FROM poker_diamond_custody)',
      'two authenticated purchases and response-loss retries fund exactly 200 Diamonds')
seats=json.loads(run("SELECT jsonb_agg(to_jsonb(s) ORDER BY seat_number) FROM table_seats s WHERE left_at IS NULL;"))
with tempfile.TemporaryDirectory(prefix='diamond-controlled-play-') as temp:
    temp=pathlib.Path(temp)
    inp=temp/'seats.json'; out=temp/'played-hand.json'; cfg=temp/'vitest.config.mjs'
    inp.write_text(json.dumps(seats))
    cfg.write_text('export default '+json.dumps({'test':{
        'include':[str(SQL/'diamond-controlled-play-driver.ts')],
        'pool':'forks','maxWorkers':1,'minWorkers':1}}))
    env=dict(os.environ,DIAMOND_PLAY_INPUT=str(inp),DIAMOND_PLAY_OUTPUT=str(out))
    subprocess.run([str(ROOT/'server/node_modules/.bin/vitest'),'run','--config',str(cfg)],
                   cwd=ROOT,env=env,check=True,timeout=60)
    played=json.loads(out.read_text())
stacks=played['stacks']; hand=played['handRow']
print('Actual shared HandController awards: '+json.dumps(stacks),flush=True)
assert len(stacks)==2 and sum(s['stack'] for s in stacks)==200
obligations={'version':1,'rake':None,'bbj_contribution':None,'insurance':[],
             'promo_playthrough':[],'pending_addons':None,'time_banks':[
                 {'user_id':s['user_id'],'seat_id':s['id'],'seat_joined_at':s['joined_at'],
                  'uses_remaining':3,'seconds_remaining':30} for s in seats]}
# Feed the exact shared controller output into the existing twelve-argument door.
run("UPDATE engine_table_leases SET heartbeat_at=now();")
commit=(f"SELECT fn_ca_commit_hand_settlement('{T}',1000010,{json_sql(stacks)},"
        f"0,0,null,0,{json_sql(hand)},'[]'::jsonb,'fixture-engine','{LEASE}',{json_sql(obligations)});")
first=json.loads(run(commit))
assert first['success'] and first['atomic_hand_commit']
replay=json.loads(run(commit))
assert replay['success'] and replay['replay']
check('(SELECT count(*)=1 FROM hand_atomic_commits) AND (SELECT count(*)=1 FROM poker_diamond_hand_receipts)',
      'real played hand is accepted once and response-loss replay does not resettle')
for s in stacks:
    check(f"(SELECT stack={s['stack']} FROM table_seats WHERE user_id='{s['user_id']}')",
          'persisted seat stack equals the actual controller award for '+s['user_id'])
run("SELECT fn_project_hand_side_effects(hand_id) FROM hand_atomic_commits;")
check('(SELECT count(*)=2 FROM ca_hand_player_idx) AND (SELECT count(*)=0 FROM hand_projection_outbox)',
      'accepted real hand projects both players and completes post-commit obligations')
for s in seats:
    call=(f"SELECT fn_cashout_seat_occupancy('{s['user_id']}','{T}',{s['seat_number']},"
          f"'{s['occupancy_id']}','voluntary');")
    auth="SET request.jwt.claim.role='service_role'; SET request.jwt.claim.sub='';"
    receipt=run(auth+call)
    assert receipt==run(auth+call)
    own=json.loads(run(actor(s['user_id'])+
        f"SELECT fn_poker_diamond_cashout_receipt('{T}','{s['occupancy_id']}');"))
    final=next(p['stack'] for p in stacks if p['user_id']==s['user_id'])
    assert own['amount']==final
    check(f"(SELECT diamonds={900+final} FROM profiles WHERE id='{s['user_id']}')",
          'cash-out pays actual final stack and exact retry cannot pay twice for '+s['user_id'])
check(f'(SELECT sum(diamonds)={initial} FROM profiles) AND (SELECT sum(balance)=0 FROM poker_diamond_custody)'
      ' AND (SELECT count(*)=0 FROM table_seats WHERE left_at IS NULL)',
      'full connected play/cash-out returns all 2000 Diamonds with zero stranded custody')
check('(SELECT count(*)=0 FROM club_members) AND (SELECT count(*)=0 FROM ca_mint_ledger)'
      ' AND (SELECT sum(amount)=0 FROM diamond_transactions)',
      'no chip membership or mint writes and Diamond movement journals net to zero')
print('CONTROLLED PLAY PASSED: authenticated funding -> real shared NLH -> accepted SQL -> cash-out.',
      flush=True)
print('Public gameplay remains closed. Transport/UI and live publication require separate evidence.',
      flush=True)
