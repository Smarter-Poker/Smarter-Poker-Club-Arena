#!/usr/bin/env python3
"""Exact migrated bodies, concurrent PostgreSQL sessions, no production access."""
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
PG = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
ENV = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
AS_PG = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
MIGRATION = ROOT / 'supabase/migrations/20261026174122_certification_cleanup_reserves_a_turn_before_retention.sql'
PREIMAGE = ROOT / 'scripts/ci/fixtures/certification-retention-admission/preimage.sql'
OUT = Path(os.environ.get('CERTIFICATION_ADMISSION_EVIDENCE', ROOT / 'artifacts/certification-retention-admission'))
OUT.mkdir(parents=True, exist_ok=True)
work = Path(tempfile.mkdtemp(prefix='cert-admission-'))
if AS_PG:
    shutil.chown(work, 'postgres')
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = str(sock.getsockname()[1])
started = False
completed = False
cases = []
threads = []


def command(args, **kw):
    return subprocess.run(args, env=ENV, text=True, capture_output=True, **kw)


def sql(text, check=True, timeout=50):
    r = command([str(PG / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                 '-h', '127.0.0.1', '-p', port, '-U', 'postgres', '-d', 'postgres'],
                input=text, timeout=timeout)
    if check and r.returncode:
        raise RuntimeError(r.stderr)
    return r


def expect(name, condition, **data):
    cases.append({'case': name, 'passed': bool(condition), **data})
    if not condition:
        raise AssertionError(name + ': ' + json.dumps(data))


def background(query):
    result = []
    def run():
        result.append(sql(query, check=False))
    t = threading.Thread(target=run)
    t.start()
    threads.append(t)
    return t, result


def lock_seen(key, mode, granted=True):
    return sql(f"SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=530090 "
               f"AND objid={key} AND objsubid=2 AND mode='{mode}' AND granted IS {'true' if granted else 'false'});").stdout.strip() == 't'


def await_lock(key, mode, granted=True):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if lock_seen(key, mode, granted):
            return
        time.sleep(.02)
    raise AssertionError(f'Expected advisory lock {key}/{mode}/{granted}')


try:
    r = command(AS_PG + [str(PG / 'initdb'), '-D', str(work / 'data'), '-U', 'postgres', '-A', 'trust'])
    if r.returncode:
        raise RuntimeError(r.stderr)
    r = command(AS_PG + [str(PG / 'pg_ctl'), '-D', str(work / 'data'), '-l', str(work / 'postgres.log'),
                        '-w', '-o', f"-p {port} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off", 'start'])
    if r.returncode:
        raise RuntimeError(r.stderr)
    started = True
    sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA smarter_private; CREATE TABLE public.clubs(id uuid);'
        + PREIMAGE.read_text())
    sql("CREATE FUNCTION public.fn_platform_frozen() RETURNS boolean LANGUAGE sql AS 'SELECT false';")
    # BEFORE: the exact old admission prefix lets a successor retention batch
    # enter while cleanup is already trying the platform gate (the root cause).
    old_fixture = sql("SELECT prosrc FROM pg_proc WHERE proname='fn_ca_prepare_unused_welcome_certification_board_leases';").stdout
    old_gate = re.search(r'  DECLARE\n    v_gate_tries.*?  END;\n', old_fixture, re.S).group(0)
    old_retention = sql("SELECT prosrc FROM pg_proc WHERE proname='sp_prune_hand_history';").stdout
    old_prefix = old_retention.split('BEGIN\n', 1)[1].split('  SELECT greatest', 1)[0]
    sql('CREATE FUNCTION public.old_fixture() RETURNS void LANGUAGE plpgsql AS $old$ BEGIN\n' + old_gate + 'END $old$;')
    sql('CREATE FUNCTION public.old_retention(seconds double precision) RETURNS integer LANGUAGE plpgsql AS $old$ BEGIN\n'
        + old_prefix + 'PERFORM pg_sleep(seconds); RETURN 1; END $old$;')
    batch, br = background('SELECT public.old_retention(3);')
    await_lock(1, 'ShareLock')
    fixture, fr = background('SELECT public.old_fixture();')
    deadline = time.monotonic() + 5
    while sql("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE query='SELECT public.old_fixture();' AND state='active');").stdout.strip() != 't':
        if time.monotonic() > deadline:
            raise AssertionError('Old fixture did not start')
        time.sleep(.02)
    # This query and the existing retention both retain shared admission, so
    # the old fixture has no reserved turn. The after-case must return zero.
    expect('BEFORE successor retention barges ahead of cleanup',
           sql('SELECT public.old_retention(0);').stdout.strip() == '1')
    batch.join(); fixture.join()
    # Apply the exact shipped migration to the complete catalog preimages.
    sql(MIGRATION.read_text())
    expect('exact migration applies with all pre/post hashes and ACL assertions', True)
    definitions = json.loads(sql("SELECT json_agg(json_build_object('name',proname,'body',prosrc)) FROM pg_proc "
                                "WHERE proname IN ('fn_ca_prepare_post_reset_welcome_certification_fixture',"
                                "'fn_ca_prepare_unused_welcome_certification_board_leases',"
                                "'fn_ca_prepare_unused_welcome_certification_board_games',"
                                "'fn_ca_prepare_unused_welcome_certification_board_origins','sp_prune_hand_history');").stdout)
    for d in definitions:
        if d['name'] == 'sp_prune_hand_history':
            # Execute the migrated admission prefix, before any business-table read.
            prefix = d['body'].split('BEGIN\n', 1)[1].split('  SELECT greatest', 1)[0]
            sql("CREATE FUNCTION public.test_retention(seconds double precision) RETURNS integer LANGUAGE plpgsql AS $test$ BEGIN\n"
                + prefix + 'PERFORM pg_sleep(seconds); RETURN 1; END $test$;')
        else:
            gate = re.search(r'  DECLARE\n    v_gate_tries.*?  END;\n', d['body'], re.S).group(0)
            expect('platform gate remains nonqueueing and bounded: ' + d['name'],
                   'pg_advisory_xact_lock(530090,1)' not in gate and '>= 600' in gate and "pg_sleep(0.05)" in gate)
            sql(f'CREATE FUNCTION public.test_{d["name"]}(seconds double precision) RETURNS void LANGUAGE plpgsql AS $test$ BEGIN\n'
                + gate + 'PERFORM pg_sleep(seconds); END $test$;')
    fx = 'public.test_fn_ca_prepare_unused_welcome_certification_board_leases'
    # An existing retention batch may finish, but a queued fixture prevents its
    # successor from barging. Purchases do not use the reservation lane.
    retention, rr = background('SELECT public.test_retention(3);')
    await_lock(2, 'ShareLock')
    fixture, fr = background(f'SELECT {fx}(2);')
    await_lock(2, 'ExclusiveLock', False)
    t0 = time.monotonic()
    skipped = sql('SELECT public.test_retention(0);').stdout.strip()
    purchase = sql('BEGIN; SELECT pg_advisory_xact_lock_shared(530090,1); COMMIT;')
    expect('next retention yields and purchases proceed while fixture reserves a turn',
           skipped == '0' and time.monotonic() - t0 < 1 and purchase.returncode == 0)
    await_lock(1, 'ExclusiveLock')
    expect('fixture still holds original platform gate exclusively through its transaction',
           sql('SELECT pg_try_advisory_xact_lock_shared(530090,1);').stdout.strip() == 'f')
    retention.join(); fixture.join()
    expect('fixture finishes after admitted retention drains', bool(fr) and fr[0].returncode == 0, stderr=fr[0].stderr)
    expect('retention resumes after fixture commit', sql('SELECT public.test_retention(0);').stdout.strip() == '1')
    expect('helper restores caller lock timeout after reserving the transaction lane',
           sql("BEGIN; SET LOCAL lock_timeout='15s'; SELECT smarter_private.certification_retention_admission(); SELECT current_setting('lock_timeout')='15s'; ROLLBACK;").stdout.strip().endswith('t'))
    # Every alternate cleanup branch uses the same reservation and releases it.
    for d in definitions:
        if d['name'] != 'sp_prune_hand_history':
            sql(f'SELECT public.test_{d["name"]}(0);')
    expect('all four cleanup gate blocks execute', True)
    # The maintenance gate continues to own admission. The fixture only TRIES it.
    maintenance, mr = background('BEGIN; SELECT pg_advisory_xact_lock(530090,1); SELECT pg_sleep(2); COMMIT;')
    await_lock(1, 'ExclusiveLock')
    fixture, fr = background(f'SELECT {fx}(0);')
    await_lock(2, 'ExclusiveLock')
    expect('fixture never queues on maintenance/platform gate', not lock_seen(1, 'ExclusiveLock', False))
    maintenance.join(); fixture.join()
    expect('cleanup proceeds only after maintenance releases', fr[0].returncode == 0)
    # PostgreSQL's real configured 32s reservation timeout must fail closed.
    holder, hr = background('BEGIN; SELECT pg_advisory_xact_lock_shared(530090,2); SELECT pg_sleep(34); COMMIT;')
    await_lock(2, 'ShareLock')
    t0 = time.monotonic()
    busy = sql('\\set VERBOSITY verbose\nSELECT smarter_private.certification_retention_admission();', check=False)
    elapsed = time.monotonic() - t0
    expect('reservation is bounded and refuses without global platform lock',
           busy.returncode != 0 and '55P03' in busy.stderr and 31 <= elapsed <= 35
           and not lock_seen(1, 'ExclusiveLock'), seconds=round(elapsed, 3))
    holder.join()
    sql("CREATE OR REPLACE FUNCTION public.fn_platform_frozen() RETURNS boolean LANGUAGE sql AS 'SELECT true';")
    expect('frozen platform refuses retention before reservation or ledger access',
           sql('SELECT public.test_retention(0);').stdout.strip() == '0' and not lock_seen(2, 'ShareLock'))
    sql("CREATE OR REPLACE FUNCTION public.fn_platform_frozen() RETURNS boolean LANGUAGE sql AS 'SELECT false';")
    # Cancellation rolls back the reservation too; no session or durable marker.
    cancelled = sql(f"SET statement_timeout='200ms'; SELECT {fx}(1);", check=False)
    expect('cancellation releases reservation and original platform gate', cancelled.returncode != 0
           and sql('SELECT pg_try_advisory_xact_lock(530090,2) AND pg_try_advisory_xact_lock(530090,1);').stdout.strip() == 't')
    expect('helper cannot be called by an untrusted role',
           sql('SET ROLE authenticated; SELECT smarter_private.certification_retention_admission();', check=False).returncode != 0)
    # Drift must abort, and even the newly created helper must roll back with it.
    sql('DROP FUNCTION smarter_private.certification_retention_admission();')
    sql("ALTER FUNCTION public.sp_prune_hand_history(integer) SET application_name='drift';")
    refused = sql(MIGRATION.read_text(), check=False)
    expect('changed source fails closed and migration is atomic', refused.returncode != 0
           and 'CERTIFICATION_RETENTION_PREIMAGE_CHANGED' in refused.stderr
           and sql("SELECT to_regprocedure('smarter_private.certification_retention_admission()') IS NULL;").stdout.strip() == 't')
    completed = True
finally:
    for t in threads:
        t.join(timeout=50)
    if started:
        command(AS_PG + [str(PG / 'pg_ctl'), '-D', str(work / 'data'), '-m', 'immediate', '-w', 'stop'])
    shutil.rmtree(work)
    report = {'passed': completed and bool(cases) and all(c['passed'] for c in cases), 'cases': cases,
              'clusterRemoved': not work.exists(), 'migration': MIGRATION.name}
    (OUT / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
