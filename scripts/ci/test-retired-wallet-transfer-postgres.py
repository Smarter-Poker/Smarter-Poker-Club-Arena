#!/usr/bin/env python3
"""Prove the retired transfer moves only before its fix, on private PostgreSQL."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
pg = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
base = Path(tempfile.mkdtemp(prefix='retired-wallet-', dir=os.environ.get('RUNNER_TEMP', tempfile.gettempdir())))
data, sock = base / 'data', base / 's'
sock.mkdir()
started = False

def command(args, sql=None):
    result = subprocess.run([str(x) for x in args], input=sql, text=True, capture_output=True, timeout=60)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()

def query(sql):
    return command([pg / 'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-U', 'postgres'], sql)

try:
    command([pg / 'initdb', '-D', data, '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale'])
    with (data / 'postgresql.conf').open('a') as config:
        config.write("\nlisten_addresses=''\nunix_socket_directories='" + str(sock) + "'\n")
    started = True
    command([pg / 'pg_ctl', '-D', data, '-l', base / 'log', '-w', 'start'])
    query("""
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '00000000-0000-4000-8000-000000000001'::uuid $$;
      CREATE TABLE wallets(user_id uuid, wallet_type text, balance numeric, updated_at timestamptz, UNIQUE(user_id,wallet_type));
      CREATE TABLE wallet_transactions(user_id uuid,wallet_type text,type text,amount numeric,category text,description text,balance_after numeric);
      INSERT INTO wallets VALUES ('00000000-0000-4000-8000-000000000001','PLAYER',100,now());
    """)
    query((root / 'supabase/migrations/20260723235307_ca_sweep4_wallet_type_transfer_category_fix.sql').read_text())
    call = "SELECT public.fn_wallet_type_transfer('00000000-0000-4000-8000-000000000001','PLAYER','BUSINESS',10);"
    before = json.loads(query('BEGIN;' + call + 'ROLLBACK;'))
    assert before['success'] is True and before['from_balance'] == 90 and before['to_balance'] == 10, before
    migration = root / 'supabase/migrations/20261005161344_the_global_wallet_transfer_cannot_move_retired_chips.sql'
    query(migration.read_text())
    query("""
      DO $proof$ BEGIN
        BEGIN
          PERFORM public.fn_wallet_type_transfer('00000000-0000-4000-8000-000000000001','PLAYER','BUSINESS',10);
          RAISE EXCEPTION 'retired transfer unexpectedly returned';
        EXCEPTION WHEN SQLSTATE '55000' THEN
          IF SQLERRM NOT LIKE 'WALLET_POOL_RETIRED:%' THEN RAISE; END IF;
        END;
      END $proof$;
    """)
    assert query('SELECT count(*) || \'/\' || sum(balance) FROM wallets;') == '1/100'
    assert query('SELECT count(*) FROM wallet_transactions;') == '0'
    assert query("SELECT prosecdef FROM pg_proc WHERE oid='public.fn_wallet_type_transfer(uuid,text,text,numeric,text)'::regprocedure;") == 'f'
    print(json.dumps({'ok': True, 'before': 'retired balances moved', 'after': '55000 refusal', 'wallets': '1/100', 'journal_rows': 0}))
finally:
    if started:
        subprocess.run([str(pg / 'pg_ctl'), '-D', str(data), '-m', 'immediate', 'stop'], capture_output=True, timeout=60)
    shutil.rmtree(base)
