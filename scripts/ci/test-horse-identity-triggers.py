#!/usr/bin/env python3
"""Exercise the installed identity triggers in an isolated PostgreSQL 17 cluster."""
import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/horse-identity-triggers')
args = parser.parse_args()
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=False)
pg = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
cluster = Path(tempfile.mkdtemp(prefix='horse-identity-', dir='/tmp'))
socket = cluster / 'socket'
socket.mkdir(mode=0o700)
cmd = [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
       '-h', str(socket), '-p', '55691', '-U', 'postgres', '-d', 'postgres']
results = {'scope': 'three identity triggers; not full economic or horse qualification', 'cases': [], 'passed': False}
horse = '00000000-0000-4000-8000-000000000001'
human = '00000000-0000-4000-8000-000000000002'
legacy = '00000000-0000-4000-8000-000000000003'
missing = '00000000-0000-4000-8000-000000000099'
installer = (ROOT / 'supabase/migrations/20260913173936_horse_identity_triggers_use_canonical_profiles.sql').read_text()


def command(argv, sql=None):
    return subprocess.run([str(a) for a in argv], input=sql, text=True, capture_output=True, env=env, timeout=45)


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def run(name, sql, expected=None, error=None):
    r = command(cmd, sql)
    (out / (name + '.log')).write_text(r.stdout + r.stderr)
    passed = (r.returncode != 0 and error in r.stderr) if error else r.returncode == 0
    if expected is not None:
        passed = passed and r.stdout.rstrip('\n') == expected
    results['cases'].append({'name': name, 'passed': passed, 'expectedSqlstate': error})
    require(passed, name + ': ' + r.stdout[-500:] + r.stderr[-1000:])
    return r.stdout.rstrip('\n')


def probe(name, body, expected=None, error=None):
    return run(name, 'BEGIN;\n' + body + '\nROLLBACK;', expected, error)


def name_write(value):
    literal = 'NULL' if value is None else "'" + value.replace("'", "''") + "'"
    return f"UPDATE profiles SET display_name={literal} WHERE id='{human}' RETURNING coalesce(display_name,'<NULL>');"


snapshot = "SELECT jsonb_build_object('profiles',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM profiles p),'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM club_members m),'seats',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM table_seats s));"
try:
    require(re.search(r'PostgreSQL\) 17\.', command([pg / 'postgres', '--version']).stdout), 'PostgreSQL 17 required')
    r = command([pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    require(r.returncode == 0, r.stderr)
    with (cluster / 'data/postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) + "'\nunix_socket_permissions=0700\nport=55691\nshared_buffers='16MB'\nmax_connections=10\n")
    r = command([pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-w', 'start'])
    require(r.returncode == 0, r.stderr)
    run('fixture', (ROOT / 'scripts/ci/probes/horse-identity-triggers/fixture.sql').read_text())
    before = run('snapshot-before', snapshot)
    probe('baseline-underscore-name-lost', name_write('Alpha_Pro'), '<NULL>')
    probe('baseline-percent-name-lost', name_write('Alpha%'), '<NULL>')
    probe('baseline-null-profile-accepts-bot-stamp', f"INSERT INTO club_members VALUES(1,'{legacy}',true) RETURNING is_bot;", 't')
    probe('baseline-direct-seat-stamp-corrupts', f"UPDATE table_seats SET horse_id='{human}' WHERE id=1 RETURNING horse_id;", human)
    require(run('baseline-rollback', snapshot) == before, 'Baseline reproduction leaked state')
    # Refuse an unreviewed predecessor and prove a failed installation is atomic.
    altered = "BEGIN; ALTER FUNCTION public.fn_stamp_seat_horse_id() SET search_path=pg_catalog;\n"
    run('drift-refusal-is-atomic', altered + installer, error='P0001')
    run('original-function-survives-refusal', "SELECT md5(pg_get_functiondef('public.fn_stamp_seat_horse_id()'::regprocedure));", '3c659ba826e3a3296cdfd74911164185')
    run('install', installer)
    require(run('install-leaves-data-alone', snapshot) == before, 'Installer rewrote player or seat data')
    for label, value, expected in [
        ('underscore', 'Alpha_Pro', 'Alpha_Pro'), ('percent', 'Alpha%', 'Alpha%'),
        ('backslash', 'Alpha\\Pro', 'Alpha\\Pro'), ('literal', '  aLpHa PrO  ', '<NULL>'),
        ('literal-special', 'literal_name%', '<NULL>'), ('ordinary', "Player O'Neil", "Player O'Neil"),
        ('null', None, '<NULL>'), ('blank', '   ', '   '),
    ]:
        probe('name-' + label, name_write(value), expected)
    probe('horse-keeps-own-name', f"UPDATE profiles SET display_name='Alpha Pro' WHERE id='{horse}' RETURNING display_name;", 'Alpha Pro')
    for label, who, supplied, expected in [
        ('horse-false', horse, 'false', 't'), ('human-true', human, 'true', 'f'),
        ('null-profile-true', legacy, 'true', 'f'), ('null-profile-null', legacy, 'null', 'f'),
        ('unassigned-true', None, 'true', 'f'),
    ]:
        occupant = 'NULL' if who is None else "'" + who + "'"
        probe('member-' + label, f"INSERT INTO club_members VALUES(1,{occupant},{supplied}) RETURNING is_bot;", expected)
    probe('member-direct-stamp', f"INSERT INTO club_members VALUES(1,'{human}',false); UPDATE club_members SET is_bot=true WHERE id=1 RETURNING is_bot;", 'f')
    probe('member-occupant-change', f"INSERT INTO club_members VALUES(1,'{horse}',true); UPDATE club_members SET user_id='{legacy}' WHERE id=1 RETURNING is_bot;", 'f')
    probe('member-missing-profile-fk', f"INSERT INTO club_members VALUES(1,'{missing}',true);", error='23503')
    probe('seat-direct-stamp-corrected', f"UPDATE table_seats SET horse_id='{human}' WHERE id=1 RETURNING horse_id;", horse)
    probe('seat-direct-null-corrected', "UPDATE table_seats SET horse_id=NULL WHERE id=1 RETURNING horse_id;", horse)
    probe('seat-human-occupant-clears', f"UPDATE table_seats SET user_id='{human}',horse_id='{horse}' WHERE id=1 RETURNING coalesce(horse_id::text,'<NULL>');", '<NULL>')
    probe('seat-null-profile-clears', f"UPDATE table_seats SET user_id='{legacy}',horse_id='{horse}' WHERE id=1 RETURNING coalesce(horse_id::text,'<NULL>');", '<NULL>')
    probe('seat-unassigned-clears', f"UPDATE table_seats SET user_id=NULL,horse_id='{horse}' WHERE id=1 RETURNING coalesce(horse_id::text,'<NULL>');", '<NULL>')
    probe('seat-insert-derived', f"INSERT INTO table_seats VALUES(2,'{horse}','{human}',42) RETURNING horse_id;", horse)
    probe('seat-missing-profile-fk', f"UPDATE table_seats SET user_id='{missing}' WHERE id=1;", error='23503')
    # A function that would fail if called proves the hot stack-only path does
    # not run the identity trigger. Rollback restores the exact real handler.
    probe('stack-only-write-does-not-read-profile', "CREATE OR REPLACE FUNCTION public.fn_stamp_seat_horse_id() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'unexpected identity read'; END $$; UPDATE table_seats SET stack=stack+7 WHERE id=1 RETURNING stack;", '107')
    run('browser-function-grants-stay-closed', "SELECT bool_and(NOT has_function_privilege('authenticated',oid,'EXECUTE') AND NOT has_function_privilege('anon',oid,'EXECUTE') AND has_function_privilege('service_role',oid,'EXECUTE')) FROM pg_proc WHERE proname IN ('fn_reject_horse_name_on_human','fn_club_members_bot_follows_horse','fn_stamp_seat_horse_id');", 't')
    run('money-trigger-declared', "SELECT count(*) FROM ca_declared_money_triggers WHERE table_name='table_seats' AND trigger_name='trg_stamp_seat_horse_id';", '1')
    require(run('all-probes-rolled-back', snapshot) == before, 'A rolled back probe leaked data')
    # A stamp update queued behind a genuine occupant change must derive from
    # the newly committed occupant, without losing the existing stack.
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        writer = pool.submit(run, 'concurrent-occupant-change', f"BEGIN; UPDATE table_seats SET user_id='{human}' WHERE id=1; SELECT pg_advisory_lock(9131739); SELECT pg_sleep(1); COMMIT;")
        deadline = time.monotonic() + 5
        while command(cmd, "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=9131739 AND granted);").stdout.strip() != 't':
            require(time.monotonic() < deadline, 'Occupant writer did not acquire fixture lock')
            time.sleep(0.02)
        stamp = pool.submit(run, 'concurrent-stale-stamp', f"UPDATE table_seats SET horse_id='{horse}' WHERE id=1 RETURNING coalesce(horse_id::text,'<NULL>');", '<NULL>')
        writer.result()
        stamp.result()
    run('concurrent-final-state', f"SELECT user_id='{human}' AND horse_id IS NULL AND stack=100 FROM table_seats WHERE id=1;", 't')
    results['passed'] = True
finally:
    if (cluster / 'data/postmaster.pid').exists():
        r = command([pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
        require(r.returncode == 0, 'Could not stop owned cluster: ' + r.stderr)
    if (cluster / 'server.log').exists():
        shutil.copyfile(cluster / 'server.log', out / 'server.log')
    require(not (cluster / 'data/postmaster.pid').exists(), 'Owned cluster still running')
    shutil.rmtree(cluster)
    results['ownedClusterRemoved'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps({'passed': results['passed'], 'cases': len(results['cases']), 'evidence': str(out)}))
