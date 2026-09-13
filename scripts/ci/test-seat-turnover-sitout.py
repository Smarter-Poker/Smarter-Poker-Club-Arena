#!/usr/bin/env python3
"""Exercise occupant turnover and sit-out triggers in an isolated PostgreSQL 17 cluster."""
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
parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/seat-turnover-sitout')
args = parser.parse_args()
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=False)
pg = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
cluster = Path(tempfile.mkdtemp(prefix='seat-turnover-', dir='/tmp'))
socket = cluster / 'socket'
socket.mkdir(mode=0o700)
cmd = [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
       '-h', str(socket), '-p', '55692', '-U', 'postgres', '-d', 'postgres']
results = {'scope': 'sit-out and occupancy trigger composition; not full admission or economic qualification', 'cases': [], 'passed': False}
horse = '00000000-0000-4000-8000-000000000001'
human = '00000000-0000-4000-8000-000000000002'
installer = (ROOT / 'supabase/migrations/20260913183426_new_seat_occupant_has_no_inherited_sitout.sql').read_text()


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


snapshot="SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM table_seats s;"
try:
    require(re.search(r'PostgreSQL\) 17\.', command([pg / 'postgres', '--version']).stdout), 'PostgreSQL 17 required')
    r = command([pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    require(r.returncode == 0, r.stderr)
    with (cluster / 'data/postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) + "'\nunix_socket_permissions=0700\nport=55692\nshared_buffers='16MB'\nmax_connections=10\n")
    r = command([pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-w', 'start'])
    require(r.returncode == 0, r.stderr)
    run('fixture', (ROOT / 'scripts/ci/probes/seat-turnover-sitout/fixture.sql').read_text())

    before = run('snapshot-before', snapshot)
    probe('baseline-new-occupant-inherits-away', f"UPDATE table_seats SET is_sitting_out=true WHERE id=1; UPDATE table_seats SET user_id='{human}' WHERE id=1 RETURNING is_sitting_out AND sit_out_at IS NOT NULL;", 't')
    require(run('baseline-rollback', snapshot) == before, 'Baseline leaked state')
    run('predecessor-drift-refusal', "BEGIN; ALTER FUNCTION public.fn_clear_sitout_on_turnover() SET search_path=pg_catalog;\n" + installer, error='P0001')
    run('predecessor-restored', "SELECT md5(pg_get_functiondef('public.fn_clear_sitout_on_turnover()'::regprocedure));", '6adbb2ed891454b185a9092d0a43196c')
    run('install', installer)
    require(run('install-does-not-rewrite-seats', snapshot) == before, 'Migration changed seat data')
    setup="UPDATE table_seats SET is_sitting_out=true WHERE id=1; CREATE TEMP TABLE prior AS SELECT * FROM table_seats WHERE id=1; "
    for label, new_user in [('horse-to-human',human),('null-occupant',None)]:
        value='NULL' if new_user is None else "'"+new_user+"'"
        probe('replacement-'+label, setup+f"UPDATE table_seats SET user_id={value} WHERE id=1 RETURNING NOT is_sitting_out AND sit_out_at IS NULL AND stack=100 AND occupancy_id<>(SELECT occupancy_id FROM prior);", 't')
    probe('replacement-explicit-true-is-fresh', f"UPDATE table_seats SET user_id='{human}',is_sitting_out=true WHERE id=1 RETURNING NOT is_sitting_out AND sit_out_at IS NULL;", 't')
    probe('same-player-stack-holds-clock', setup+"UPDATE table_seats SET stack=stack+7 WHERE id=1 RETURNING is_sitting_out AND sit_out_at=(SELECT sit_out_at FROM prior) AND occupancy_id=(SELECT occupancy_id FROM prior) AND stack=107;", 't')
    probe('same-player-move-holds-clock', setup+"UPDATE table_seats SET seat_number=2,table_id='00000000-0000-4000-8000-000000000004' WHERE id=1 RETURNING is_sitting_out AND sit_out_at=(SELECT sit_out_at FROM prior) AND occupancy_id<>(SELECT occupancy_id FROM prior);", 't')
    probe('same-player-cannot-restart-clock', setup+"UPDATE table_seats SET sit_out_at=sit_out_at+interval '5 minutes' WHERE id=1 RETURNING sit_out_at=(SELECT sit_out_at FROM prior);", 't')
    probe('freeze-thaw-keeps-existing-contract', setup+"DO $$BEGIN PERFORM set_config('app.freeze_bypass','on',true); END$$; UPDATE table_seats SET sit_out_at=sit_out_at+interval '5 minutes' WHERE id=1 RETURNING sit_out_at=(SELECT sit_out_at+interval '5 minutes' FROM prior);", 't')
    probe('leaving-clears-away', setup+"UPDATE table_seats SET left_at=now() WHERE id=1 RETURNING NOT is_sitting_out AND sit_out_at IS NULL AND stack=100;", 't')
    probe('same-player-revival-clears-inherited', setup+"UPDATE table_seats SET left_at=now() WHERE id=1; UPDATE table_seats SET left_at=NULL WHERE id=1 RETURNING NOT is_sitting_out AND sit_out_at IS NULL;", 't')
    probe('same-player-explicit-revival-away-preserved', "UPDATE table_seats SET left_at=now() WHERE id=1; UPDATE table_seats SET left_at=NULL,is_sitting_out=true WHERE id=1 RETURNING is_sitting_out AND sit_out_at IS NOT NULL;", 't')
    probe('fresh-insert-cannot-inherit-away', f"INSERT INTO table_seats(id,user_id,table_id,seat_number,is_sitting_out,sit_out_at,stack) VALUES(2,'{human}','00000000-0000-4000-8000-000000000004',1,true,now(),42) RETURNING NOT is_sitting_out AND sit_out_at IS NULL AND stack=42;", 't')
    probe('occupancy-direct-rewrite-still-refused', "UPDATE table_seats SET occupancy_id=gen_random_uuid() WHERE id=1;", error='22023')
    run('authority-and-grants-preserved', "SELECT NOT prosecdef AND NOT has_function_privilege('authenticated',oid,'EXECUTE') AND NOT has_function_privilege('anon',oid,'EXECUTE') AND has_function_privilege('service_role',oid,'EXECUTE') FROM pg_proc WHERE oid='public.fn_clear_sitout_on_turnover()'::regprocedure;", 't')
    run('money-trigger-declared', "SELECT count(*) FROM ca_declared_money_triggers WHERE table_name='table_seats' AND trigger_name='trg_clear_sitout_on_turnover';", '1')
    require(run('all-probes-rolled-back', snapshot) == before, 'Probe leaked state')
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        writer=pool.submit(run,'concurrent-prior-occupant-away',"BEGIN; UPDATE table_seats SET is_sitting_out=true WHERE id=1; SELECT pg_advisory_lock(9131834); SELECT pg_sleep(1); COMMIT;")
        deadline=time.monotonic()+5
        while command(cmd,"SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=9131834 AND granted);").stdout.strip() != 't':
            require(time.monotonic()<deadline,'Writer did not establish native fixture barrier')
            time.sleep(0.02)
        replacement=pool.submit(run,'concurrent-replacement',f"UPDATE table_seats SET user_id='{human}' WHERE id=1 RETURNING NOT is_sitting_out AND sit_out_at IS NULL AND stack=100;",'t')
        writer.result();replacement.result()
    results['passed']=True
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
