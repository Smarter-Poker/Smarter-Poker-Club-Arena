#!/usr/bin/env python3
"""Real PostgreSQL seat-lock races, with the retained production cashout bodies.

No production connection or money fixture: every accepted exit must be zero,
and the existing credit function is a tripwire that raises if ever reached.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
PG = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
base = os.environ.get('TMPDIR') or os.environ.get('RUNNER_TEMP')
if not base:
    raise RuntimeError('Set TMPDIR to task-owned external storage or use RUNNER_TEMP')
work = Path(tempfile.mkdtemp(prefix='lb-', dir=base))
sock = work / 's'
sock.mkdir()
data = work / 'd'
env = {'PATH': str(PG) + ':/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
started = False
sessions = []
U = '10000000-0000-4000-8000-000000000001'
T = '20000000-0000-4000-8000-000000000001'
O = '30000000-0000-4000-8000-000000000001'
CALL = f"SELECT fn_cashout_unfunded_seat_occupancy('{U}','{T}',1,'{O}','forced');"


def run(args, sql=None):
    r = subprocess.run([str(x) for x in args], input=sql, text=True,
                       capture_output=True, env=env, timeout=30)
    if r.returncode:
        raise RuntimeError(r.stdout + r.stderr)
    return r.stdout.strip()


def args(app='expiry-proof'):
    return [PG / 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-h', sock,
            '-U', 'postgres', '-d', 'postgres', '-c', f"SET application_name='{app}';"]


def q(sql):
    return run(args() + ['-c', sql])


def rejects(sql, reason):
    try:
        q(sql)
    except RuntimeError as e:
        assert reason in str(e), str(e)
    else:
        raise AssertionError('Expected refusal: ' + reason)


def reset():
    q(f"TRUNCATE table_pending_addons,seat_cashout_receipts,table_seats,closed_sessions; "
      f"INSERT INTO table_seats(id,user_id,table_id,seat_number,occupancy_id,stack) "
      f"VALUES(gen_random_uuid(),'{U}','{T}',1,'{O}',0);")


def wait_lock(pid):
    # Bounded observation of the test transaction, never a repair/release loop.
    for _ in range(100):
        if q(f"SELECT wait_event_type FROM pg_stat_activity WHERE pid={pid}") == 'Lock':
            return
        time.sleep(.02)
    raise AssertionError('Concurrent expiry never reached the occupied row lock')


try:
    run([PG / 'initdb', '-D', data, '-U', 'postgres', '-A', 'trust', '--no-locale'])
    run([PG / 'pg_ctl', '-D', data, '-l', work / 'postgres.log', '-o',
         f"-F -k {sock} -c listen_addresses='' -c max_connections=12", '-w', 'start'])
    started = True
    q('''CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
 SELECT nullif(current_setting('request.jwt.claim.role',true),'') $$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE TABLE clubs(id uuid PRIMARY KEY,asset text);
CREATE TABLE tables(id uuid PRIMARY KEY,club_id uuid,tournament_id uuid,current_players integer);
CREATE TABLE tournaments(id uuid PRIMARY KEY);
CREATE TABLE profiles(id uuid PRIMARY KEY);
CREATE TABLE table_seats(id uuid PRIMARY KEY,user_id uuid,table_id uuid,seat_number int,
 occupancy_id uuid,stack numeric,joined_at timestamptz DEFAULT now(),left_at timestamptz,leave_pending boolean DEFAULT false);
CREATE TABLE table_pending_addons(id uuid DEFAULT gen_random_uuid(),table_id uuid,user_id uuid,
 amount numeric,resolved_at timestamptz);
CREATE TABLE seat_cashout_receipts(occupancy_id uuid PRIMARY KEY,user_id uuid,table_id uuid,
 seat_id uuid,seat_number int,receipt jsonb,created_at timestamptz DEFAULT now());
CREATE TABLE seat_departure_requests(occupancy_id uuid,user_id uuid,table_id uuid,seat_number int,leave_mode text);
CREATE TABLE seat_admin_departure_authorizations(occupancy_id uuid,user_id uuid,table_id uuid,seat_number int);
CREATE TABLE ca_money_rpc_registry(proname text PRIMARY KEY,status text,notes text);
CREATE TABLE closed_sessions(user_id uuid,table_id uuid);
CREATE FUNCTION fn_cash_session_close(uuid,uuid,numeric,text) RETURNS void LANGUAGE sql AS $$
 INSERT INTO closed_sessions VALUES($1,$2) $$;
CREATE FUNCTION atomic_credit_wallet_and_log(uuid,numeric,text,text,uuid,uuid,uuid,text)
 RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST_MUST_NEVER_CREDIT_REAL_CHIPS'; END $$;
''')
    q(f"INSERT INTO clubs VALUES('{T}','chips'); INSERT INTO tables VALUES('{T}','{T}',NULL,1)")
    fixture = ROOT / 'scripts/ci/fixtures/lightning-rebuy-expiry'
    for name in ['fn_caller_is_engine', 'atomic_seat_cashout_locked', 'fn_cashout_seat_occupancy']:
        q((fixture / (name + '.sql')).read_text())
    q((ROOT / 'supabase/migrations/20261028171228_lightning_bust_expiry_preserves_a_concurrent_paid_rebuy.sql').read_text())
    reset()
    rejects("SET request.jwt.claim.role='authenticated'; " + CALL, 'Engine authority required')
    assert q("SELECT has_function_privilege('authenticated','fn_cashout_unfunded_seat_occupancy(uuid,uuid,integer,uuid,text)','execute')") == 'f'
    q('UPDATE table_seats SET stack=400')
    rejects(CALL, 'BUST_REBUY_FUNDED')
    assert q('SELECT count(*) FROM table_seats WHERE left_at IS NULL') == '1'
    reset()
    q(f"INSERT INTO table_pending_addons(table_id,user_id,amount) VALUES('{T}','{U}',400)")
    # Negative control: the retained original production transaction alone
    # accepts an engine's stale zero-stack decision despite the paid row.
    old = json.loads(q(CALL.replace('fn_cashout_unfunded_seat_occupancy', 'fn_cashout_seat_occupancy')))
    assert old['ok'] is True
    assert q('SELECT count(*) FROM table_seats WHERE left_at IS NULL') == '0'
    assert q('SELECT amount FROM table_pending_addons WHERE resolved_at IS NULL') == '400'
    reset()
    q(f"INSERT INTO table_pending_addons(table_id,user_id,amount) VALUES('{T}','{U}',400)")
    rejects(CALL, 'BUST_REBUY_PENDING')
    assert q('SELECT amount FROM table_pending_addons WHERE resolved_at IS NULL') == '400'
    assert q('SELECT count(*) FROM seat_cashout_receipts') == '0'
    reset()
    first = json.loads(q(CALL))
    assert first['ok'] is True and first['stack'] == 0 and first['credited'] is False
    assert json.loads(q(CALL)) == first
    assert q('SELECT count(*) FROM closed_sessions') == '1'
    assert q('SELECT count(*) FROM seat_cashout_receipts') == '1'
    q("UPDATE table_seats SET occupancy_id='30000000-0000-4000-8000-000000000002',stack=400,left_at=NULL")
    assert json.loads(q(CALL)) == first
    assert q('SELECT stack FROM table_seats WHERE left_at IS NULL') == '400'
    assert q('SELECT count(*) FROM closed_sessions') == '1'
    rejects(CALL.replace(U, '10000000-0000-4000-8000-000000000002'), 'CASHOUT_OCCUPANCY_SCOPE_MISMATCH')
    # Rebuy commits while expiry waits on the seat. The locked predicate must
    # see its newly committed obligation, not the engine's earlier empty read.
    for funded in [False, True]:
        reset()
        holder = subprocess.Popen([str(x) for x in args('rebuy-holder')[:-2]], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        sessions.append(holder)
        holder.stdin.write(f"BEGIN; SELECT stack FROM table_seats WHERE occupancy_id='{O}' FOR UPDATE;\\echo LOCKED\n".replace(';\\echo',';\n\\echo'))
        holder.stdin.flush()
        while holder.stdout.readline().strip() != 'LOCKED':
            if holder.poll() is not None: raise AssertionError('Rebuy holder failed')
        expiry = subprocess.Popen([str(x) for x in args('expiry-race') + ['-c', CALL]],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        sessions.append(expiry)
        # Find the test connection by its unique application name, not a delay.
        for _ in range(100):
            pid = q("SELECT pid FROM pg_stat_activity WHERE application_name='expiry-race' AND query LIKE '%fn_cashout_unfunded%'")
            if pid: break
            time.sleep(.02)
        assert pid
        wait_lock(int(pid))
        change = 'UPDATE table_seats SET stack=400;' if funded else f"INSERT INTO table_pending_addons(table_id,user_id,amount) VALUES('{T}','{U}',400);"
        holder.stdin.write(change + ' COMMIT;\n\\q\n'); holder.stdin.flush()
        holder.communicate(timeout=10)
        out, err = expiry.communicate(timeout=10)
        assert expiry.returncode != 0 and ('BUST_REBUY_FUNDED' if funded else 'BUST_REBUY_PENDING') in err, out + err
        assert q('SELECT count(*) FROM table_seats WHERE left_at IS NULL') == '1'
        assert q('SELECT count(*) FROM seat_cashout_receipts') == '0'
    print('PASS: real seat-lock races preserve paid/funded rebuys; zero exit replays one original receipt; unauthorized and stale requests refused; no credit/refund path invoked.')
finally:
    for p in sessions:
        if p.poll() is None:
            p.kill(); p.wait(timeout=5)
    if started:
        subprocess.run([str(PG / 'pg_ctl'), '-D', str(data), '-m', 'immediate', '-w', 'stop'],
                       env=env, capture_output=True, timeout=15)
    shutil.rmtree(work)
