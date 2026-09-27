#!/usr/bin/env python3
"""Real PG17 roles, FK/locking and rollback; never connects to a provider.

The Auth transition below models the documented GoTrue atomic soft-delete
contract. The actual HTTP call is qualified separately by the owning live job.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'scripts/ci/fixtures/certification-retirement'
MIGRATION = ROOT / 'supabase/migrations/20260927005508_reserved_certification_ledger_actors_are_retired_not_deleted.sql'
parser = argparse.ArgumentParser()
parser.add_argument('--pg-bin', default=os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
parser.add_argument('--scratch', default=os.environ.get('RUNNER_TEMP', tempfile.gettempdir()))
parser.add_argument('--baseline', action='store_true')
args = parser.parse_args()
pg = Path(args.pg_bin).resolve()
env = {'PATH': str(pg) + ':/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'PGCONNECT_TIMEOUT': '5'}
cluster = Path(tempfile.mkdtemp(prefix='ca-cert-retire-', dir=args.scratch))
data = cluster / 'data'
socket = cluster / 's'
socket.mkdir(mode=0o700)
start_attempted = False
USER = '00000000-0000-4000-8000-000000000099'
EMAIL = 'ca-customization-cert-postdeploy-native@example.invalid'
CLUB = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'

def run(argv, sql=None, expect_error=None):
    result = subprocess.run([str(v) for v in argv], input=sql, text=True,
                            capture_output=True, env=env, timeout=60)
    if expect_error:
        assert result.returncode != 0 and expect_error in result.stderr, result
        return result.stderr
    if result.returncode:
        raise RuntimeError(result.stderr + result.stdout)
    return result.stdout.strip()

def query(sql, expect_error=None):
    return run([pg/'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At', '-h', socket,
                '-U', 'postgres', '-d', 'postgres', '-p', '5432'], sql, expect_error)

def seed():
    query(f"INSERT INTO auth.users(id,email) VALUES('{USER}','{EMAIL}');"
          f"INSERT INTO public.profiles(id,email) VALUES('{USER}','{EMAIL}');"
          f"INSERT INTO public.users(id) VALUES('{USER}');"
          f"INSERT INTO public.diamond_wallets(user_id) VALUES('{USER}');"
          f"INSERT INTO public.chip_ledger(performed_by,amount) VALUES('{USER}',100000),('{USER}',100000);"
          f"INSERT INTO auth.sessions(user_id) VALUES('{USER}');"
          f"INSERT INTO auth.refresh_tokens(user_id) VALUES('{USER}');")

def cleanup():
    return json.loads(query(f"SET ROLE service_role; SELECT public.cleanup_reserved_certification_account('{USER}');"))

def auth_soft_delete():
    # Documented provider contract, never used outside this private fixture.
    query(f"BEGIN; UPDATE auth.users SET email='deleted-{USER}',encrypted_password='',deleted_at=now() WHERE id='{USER}';"
          f"DELETE FROM auth.sessions WHERE user_id='{USER}'; DELETE FROM auth.refresh_tokens WHERE user_id='{USER}'; COMMIT;")

def ledger():
    return query("SELECT md5(jsonb_agg(to_jsonb(l) ORDER BY id)::text) FROM public.chip_ledger l;")

def refused(setup, reason, undo):
    query(setup)
    query(f"SELECT public.cleanup_reserved_certification_account('{USER}');", reason)
    query(undo)

try:
    assert ' 17.' in run([pg/'postgres', '--version'])
    run([pg/'initdb', '-D', data, '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    with (data/'postgresql.conf').open('a') as conf:
        conf.write("\nlisten_addresses = ''\nunix_socket_directories = '" + str(socket) + "'\nautovacuum = off\n")
    start_attempted = True
    run([pg/'pg_ctl', '-D', data, '-l', cluster/'server.log', '-w', 'start'])
    endpoint = json.loads(query("select json_build_object('address',inet_server_addr(),'data',current_setting('data_directory'),'listen',current_setting('listen_addresses'));"))
    assert endpoint == {'address': None, 'data': str(data), 'listen': ''}
    query((FIXTURE/'setup.sql').read_text())
    captured = json.loads((FIXTURE/'baseline.json').read_text())
    assert query("SELECT md5(pg_get_functiondef('public.cleanup_reserved_certification_account(uuid)'::regprocedure));") == captured['definition_md5']
    seed()
    before = ledger()
    if args.baseline:
        # Must fail at the real immutable actor FK, not a mocked predicate.
        cleanup()
        raise AssertionError('Baseline unexpectedly removed a referenced actor')
    query(MIGRATION.read_text())
    assert ledger() == before
    for role in ['anon', 'authenticated']:
        for fn, arg in [('cleanup_reserved_certification_account', f"'{USER}'"),
                        ('fn_ca_certification_identity_retired', f"'{USER}'"),
                        ('fn_ca_stale_certification_accounts', 'now()')]:
            query(f'SET ROLE {role}; SELECT public.{fn}({arg});', 'permission denied')
    assert cleanup()['reason'] == 'auth_soft_delete_required'
    assert ledger() == before
    assert query(f"SELECT balance FROM public.diamond_wallets WHERE user_id='{USER}';") == '500'
    query("UPDATE public.freeze_fixture SET active=true;")
    assert cleanup() == {'success': False, 'reason': 'platform_is_frozen'}
    query("UPDATE public.freeze_fixture SET active=false;")
    refused(f"UPDATE auth.users SET email='person@example.com' WHERE id='{USER}';",
            'CERTIFICATION_RETIREMENT_IDENTITY_REFUSED',
            f"UPDATE auth.users SET email='{EMAIL}' WHERE id='{USER}';")
    for column, value, undo in [('is_horse','true','false'),('is_admin','true','false'),('role',"'god'","'user'"),('email',"'spoof@example.com'",f"'{EMAIL}'")]:
        refused(f'UPDATE public.profiles SET {column}={value};',
                'CERTIFICATION_RETIREMENT_PROFILE_REFUSED', f'UPDATE public.profiles SET {column}={undo};')
    for table, column in [('clubs','owner_id'),('unions','owner_id'),('agents','user_id'),('table_seats','user_id'),('tournament_players','user_id')]:
        refused(f"INSERT INTO public.{table}({column}) VALUES('{USER}');",
                'CERTIFICATION_RETIREMENT_HAS_AUTHORITY_OR_CUSTODY', f'DELETE FROM public.{table};')
    refused(f"INSERT INTO public.wallets(user_id,locked_balance) VALUES('{USER}',1);",
            'CERTIFICATION_RETIREMENT_HAS_AUTHORITY_OR_CUSTODY', 'DELETE FROM public.wallets;')
    for club, role, chips in [(CLUB,'admin',1),(CLUB,'member',0),('00000000-0000-4000-8000-000000000001','admin',0)]:
        refused(f"INSERT INTO public.club_members VALUES('{club}','{USER}','{role}',{chips},0);",
                'CERTIFICATION_RETIREMENT_HAS_AUTHORITY_OR_CUSTODY','DELETE FROM public.club_members;')
    refused(f"INSERT INTO public.club_members VALUES('{CLUB}','{USER}',NULL,0,0);",
            'CERTIFICATION_RETIREMENT_HAS_AUTHORITY_OR_CUSTODY','DELETE FROM public.club_members;')
    query(f"INSERT INTO public.club_members VALUES('{CLUB}','{USER}','admin',0,0);")
    with ThreadPoolExecutor(max_workers=2) as workers:
        outcomes = list(workers.map(lambda _: cleanup(), range(2)))
    assert all(r['reason']=='auth_soft_delete_required' for r in outcomes)
    assert query('SELECT count(*) FROM public.club_members;') == '0'
    # The actual cleanup holds auth + profile row locks to COMMIT. Foreign-key
    # checks for a concurrent membership/seat/agent must wait, not race through
    # the custody preflight. Synchronize on the observed holder, not a sleep.
    with ThreadPoolExecutor(max_workers=4) as workers:
        holder = workers.submit(query, f"SET application_name='cert-retirement-holder'; BEGIN; SELECT public.cleanup_reserved_certification_account('{USER}'); SELECT pg_sleep(2); COMMIT;")
        for attempt in range(100):
            if query("SELECT count(*) FROM pg_stat_activity WHERE application_name='cert-retirement-holder' AND wait_event='PgSleep';") == '1':
                break
            time.sleep(0.02)
        else:
            raise AssertionError('Native lock holder never reached guarded boundary')
        inserts = [f"INSERT INTO public.club_members VALUES('{CLUB}','{USER}','admin',0,0);",
                   f"INSERT INTO public.table_seats(user_id) VALUES('{USER}');",
                   f"INSERT INTO public.agents(user_id) VALUES('{USER}');"]
        blocked = [workers.submit(query, "SET lock_timeout='100ms';" + statement, 'lock timeout') for statement in inserts]
        for future in blocked:
            future.result()
        holder.result()
    assert query('SELECT count(*) FROM public.club_members;') == '0'
    assert query('SELECT count(*) FROM public.table_seats;') == '0'
    assert query('SELECT count(*) FROM public.agents;') == '0'
    assert ledger() == before
    assert query("SELECT count(*) FROM public.fn_ca_stale_certification_accounts(now());") == '1'
    # A late operation in the RPC/Auth gap remains visible after retirement.
    query(f"INSERT INTO public.club_members VALUES('{CLUB}','{USER}','admin',7,0);")
    auth_soft_delete()
    assert query("SELECT count(*) FROM public.fn_ca_stale_certification_accounts(now());") == '1'
    query(f"SELECT public.cleanup_reserved_certification_account('{USER}');", 'CERTIFICATION_RETIREMENT_IDENTITY_REFUSED')
    assert query("SELECT chip_balance FROM public.club_members;") == '7'
    assert ledger() == before
    # Remove only isolated fixture state to qualify the independent clean path.
    query('DELETE FROM public.club_members;')
    assert cleanup() == {'success': True, 'disposition': 'retained_ledger_actor', 'user_id': USER}
    assert cleanup()['success'] is True
    assert ledger() == before
    assert query("SELECT count(*) FROM public.fn_ca_stale_certification_accounts(now());") == '0'
    assert query(f"SELECT diamond_balance FROM public.profiles WHERE id='{USER}';") == '500'
    assert query(f"SELECT balance FROM public.diamond_wallets WHERE user_id='{USER}';") == '500'
    # A post-retirement stale JWT racing a join is not hidden or certified.
    query(f"INSERT INTO public.club_members VALUES('{CLUB}','{USER}','admin',0,0);")
    assert query("SELECT count(*) FROM public.fn_ca_stale_certification_accounts(now());") == '1'
    query(f"SELECT public.cleanup_reserved_certification_account('{USER}');", 'CERTIFICATION_RETIREMENT_IDENTITY_REFUSED')
    query('DELETE FROM public.club_members;')
    # A partial Auth transition must remain visible and cannot return success.
    query(f"INSERT INTO auth.sessions(user_id) VALUES('{USER}');")
    assert query(f"SELECT public.fn_ca_certification_identity_retired('{USER}');") == 'f'
    query(f"SELECT public.cleanup_reserved_certification_account('{USER}');", 'CERTIFICATION_RETIREMENT_IDENTITY_REFUSED')
    query('DELETE FROM auth.sessions;')
    # Bounded inventory keeps partial states, enforces 40-minute age even if a
    # caller asks for the future, and returns only the 21-row refusal envelope.
    query("INSERT INTO auth.users(id,email,created_at) SELECT gen_random_uuid(),'ca-customization-cert-postdeploy-bounded-'||n||'@example.invalid', now()-interval '2 hours' FROM generate_series(1,25) n;")
    query("INSERT INTO public.profiles(id,email,created_at) SELECT id,email,created_at FROM auth.users WHERE email LIKE '%bounded-%';")
    assert query("SELECT count(*) FROM public.fn_ca_stale_certification_accounts(now()+interval '1 day');") == '21'
    query("DELETE FROM auth.users WHERE email LIKE '%bounded-%';")
    query("INSERT INTO auth.users(id,email,created_at) VALUES(gen_random_uuid(),'ca-customization-cert-postdeploy-young@example.invalid',now());")
    query("INSERT INTO public.profiles(id,email,created_at) SELECT id,email,created_at FROM auth.users WHERE email LIKE '%young@%';")
    assert query("SELECT count(*) FROM public.fn_ca_stale_certification_accounts(now()+interval '1 day');") == '0'
    # Existing disposable non-ledger behavior, including hard deletion, is retained.
    spare='00000000-0000-4000-8000-000000000098'
    query(f"INSERT INTO auth.users(id,email) VALUES('{spare}','ca-customization-cert-native@example.invalid');"
          f"INSERT INTO public.profiles(id,email) VALUES('{spare}','ca-customization-cert-native@example.invalid');")
    assert json.loads(query(f"SELECT public.cleanup_reserved_certification_account('{spare}');"))['success']
    assert query(f"SELECT count(*) FROM auth.users WHERE id='{spare}';") == '0'
    # Replaying or drifting a recorded patch fails before any schema change.
    installed=query("SELECT md5(pg_get_functiondef('public.cleanup_reserved_certification_account(uuid)'::regprocedure));")
    query(MIGRATION.read_text(), 'CERTIFICATION_CLEANUP_PREIMAGE_CHANGED')
    assert query("SELECT md5(pg_get_functiondef('public.cleanup_reserved_certification_account(uuid)'::regprocedure));") == installed
    assert ledger() == before
    print('certification-retirement-native-acceptance-passed')
finally:
    if start_attempted and (data/'postmaster.pid').exists():
        run([pg/'pg_ctl', '-D', data, '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(cluster)
