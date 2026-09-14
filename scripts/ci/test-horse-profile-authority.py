#!/usr/bin/env python3
"""Reproduce and close horse-profile authority escalation in isolated PG17."""
from pathlib import Path
import argparse
import concurrent.futures
import json
import os
import re
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/horse-profile-authority')
args = parser.parse_args()
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=False)
pg = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
cluster = Path(tempfile.mkdtemp(prefix='horse-authority-', dir='/tmp'))
socket = cluster / 'socket'
socket.mkdir(mode=0o700)
results = {'scope': 'isolated API-role/RLS/trigger boundary, not whole-schema qualification', 'cases': [], 'passed': False}
owner = '00000000-0000-4000-8000-000000000001'
new_id = '00000000-0000-4000-8000-000000000003'
claims = json.dumps({'role': 'authenticated', 'sub': owner})
cmd = [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
       '-h', str(socket), '-p', '55689', '-U', 'postgres', '-d', 'postgres']


def command(argv, sql=None):
    return subprocess.run([str(a) for a in argv], input=sql, text=True, capture_output=True, env=env, timeout=45)


def require(value, message):
    if not value:
        raise RuntimeError(message)


def run(name, sql, error=None):
    r = command(cmd, sql)
    (out / (name + '.log')).write_text(r.stdout + r.stderr)
    passed = r.returncode == 0 if error is None else r.returncode != 0 and error in r.stderr
    results['cases'].append({'name': name, 'passed': passed, 'expectedSqlstate': error})
    require(passed, name + ': ' + r.stderr[-1500:])
    return r.stdout.strip()


def identity(role='authenticated', jwt=claims):
    return "SET LOCAL ROLE " + role + "; SELECT set_config('request.jwt.claims', '" + jwt.replace("'", "''") + "', true);\n"


def probe(name, body, error=None, role='authenticated', jwt=claims):
    return run(name, 'BEGIN;\n' + identity(role, jwt) + body + '\nROLLBACK;', error)


snapshot = "SELECT jsonb_build_object('profiles',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.profiles p),'births',(SELECT jsonb_agg(to_jsonb(b) ORDER BY profile_id) FROM public.horse_birth_markers b));"
installer = (ROOT / 'supabase/migrations/20260913171624_horse_profile_authority_is_server_only.sql').read_text()
fixture = (ROOT / 'scripts/ci/probes/horse-profile-authority/fixture.sql').read_text()
try:
    require(re.search(r'PostgreSQL\) 17\.', command([pg / 'postgres', '--version']).stdout), 'PostgreSQL 17 required')
    r = command([pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    require(r.returncode == 0, r.stderr)
    with (cluster / 'data/postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) + "'\nunix_socket_permissions=0700\nport=55689\nshared_buffers='16MB'\nmax_connections=10\n")
    r = command([pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-w', 'start'])
    require(r.returncode == 0, r.stderr)
    run('fixture', fixture)
    baseline = run('snapshot-before', snapshot)
    baseline_exploit = probe('baseline-owner-can-become-horse',
        f"UPDATE public.profiles SET is_horse=true WHERE id='{owner}'; RESET ROLE; SELECT count(*) FROM public.horse_birth_markers WHERE profile_id='{owner}';")
    require(baseline_exploit.splitlines()[-1] == '1', 'Baseline must reproduce an unauthorized horse birth')
    probe('baseline-owner-can-write-brain', f"UPDATE public.profiles SET horse_profile='{{\"mode\":\"attacker\"}}' WHERE id='{owner}';")
    probe('baseline-owner-can-write-status', f"UPDATE public.profiles SET horse_status='disabled' WHERE id='{owner}';")
    require(run('baseline-rollback', snapshot) == baseline, 'Baseline changed fixture after rollback')
    run('install', installer)
    metadata = json.loads(run('metadata', """SELECT jsonb_build_object(
      'definer',p.prosecdef,'settings',p.proconfig,
      'auth_execute',has_function_privilege('authenticated',p.oid,'EXECUTE'),
      'anon_execute',has_function_privilege('anon',p.oid,'EXECUTE'),
      'service_execute',has_function_privilege('service_role',p.oid,'EXECUTE'),
      'rls',(SELECT relrowsecurity FROM pg_class WHERE oid='public.profiles'::regclass),
      'trigger_enabled',(SELECT tgenabled FROM pg_trigger WHERE tgrelid='public.profiles'::regclass AND tgname='zzzz_guard_horse_profile_authority'),
      'auth_insert',has_table_privilege('authenticated','public.profiles','INSERT'),
      'auth_update_horse',has_column_privilege('authenticated','public.profiles','is_horse','UPDATE'))
      FROM pg_proc p WHERE oid='public.fn_guard_horse_profile_authority()'::regprocedure;"""))
    require(metadata == {'definer': False, 'settings': ['search_path=pg_catalog, pg_temp'], 'auth_execute': False,
        'anon_execute': False, 'service_execute': True, 'rls': True, 'trigger_enabled': 'O',
        'auth_insert': True, 'auth_update_horse': False}, 'Unexpected installed authority metadata')
    results['metadata'] = metadata
    values = {'is_horse': 'true', 'horse_profile': "'{\"mode\":\"attacker\"}'::jsonb", 'horse_status': "'disabled'"}
    for field, value in values.items():
        probe('deny-direct-' + field, f"UPDATE public.profiles SET {field}={value} WHERE id='{owner}';", '42501')
        probe('deny-insert-' + field, f"INSERT INTO public.profiles(id,{field}) VALUES ('{owner}',{value});", '42501')
        json_value = {'is_horse': 'true', 'horse_profile': '{"mode":"attacker"}', 'horse_status': '"disabled"'}[field]
        probe('deny-definer-' + field, f"SELECT public.fixture_legacy_profile_write('{owner}','{field}','{json_value}');", '42501')
        # Even if an old grant is accidentally restored, the trigger rejects it.
        run('deny-after-regrant-' + field, f"BEGIN; GRANT UPDATE ({field}) ON public.profiles TO authenticated;\n" + identity() + f"UPDATE public.profiles SET {field}={value} WHERE id='{owner}'; ROLLBACK;", '42501')
    probe('ordinary-owner-profile-edit', f"UPDATE public.profiles SET display_name='Updated',avatar_url='/avatars/human.png' WHERE id='{owner}' RETURNING id;")
    signup_claims = json.dumps({'role': 'authenticated', 'sub': new_id})
    probe('ordinary-signup-defaults', f"INSERT INTO public.profiles(id,display_name) VALUES ('{new_id}','New');", jwt=signup_claims)
    probe('ordinary-signup-null-legacy-defaults', f"INSERT INTO public.profiles(id,is_horse,horse_profile,horse_status) VALUES ('{new_id}',null,null,null);", jwt=signup_claims)
    probe('owner-rls-preserved', f"INSERT INTO public.profiles(id) VALUES ('{new_id}');", '42501')
    probe('anon-denied', f"INSERT INTO public.profiles(id,is_horse) VALUES ('{new_id}',true);", '42501', role='anon', jwt='{"role":"anon"}')
    for name, jwt in [('malformed', '{bad'), ('missing-role', '{}'), ('null-role', '{"role":null}'), ('no-jwt', '')]:
        probe('deny-' + name, f"SELECT public.fixture_legacy_profile_write('{owner}','is_horse','true');", '42501', jwt=jwt) if name != 'no-jwt' else probe('deny-no-jwt-direct', f"INSERT INTO public.profiles(id,is_horse) VALUES ('{owner}',true);", '42501', jwt=jwt)
    for name, jwt in [('absent', ''), ('blank', '   '), ('literal-null', 'null')]:
        probe('deny-definer-' + name + '-jwt', f"SELECT public.fixture_legacy_profile_write('{owner}','is_horse','true');", '42501', jwt=jwt)
    probe('deny-definer-browser-with-service-claim', f"SELECT public.fixture_legacy_profile_write('{owner}','is_horse','true');", '42501', jwt='{"role":"service_role"}')
    probe('mixed-human-edit-and-horse-write-rolls-back', f"UPDATE public.profiles SET display_name='Must roll back' WHERE id='{owner}'; SELECT public.fixture_legacy_profile_write('{owner}','is_horse','true');", '42501')
    service_jwt = '{"role":"service_role"}'
    probe('trusted-engine-import-and-tuner', f"INSERT INTO public.profiles(id,is_horse,horse_profile,horse_status) VALUES ('{new_id}',true,'{{\"brain\":1}}','available'); UPDATE public.profiles SET horse_profile='{{\"brain\":2}}',horse_status='disabled' WHERE id='{new_id}';", role='service_role', jwt=service_jwt)
    probe('trusted-maintenance-without-jwt', f"UPDATE public.profiles SET is_horse=true WHERE id='{owner}';", role='postgres', jwt='')
    require(run('all-rollback', snapshot) == baseline, 'Failed operation or rollback probe leaked state')
    run('repeat-install', installer)
    # The migration refuses an unreviewed authority-helper change atomically.
    run('reject-helper-drift', "BEGIN; ALTER FUNCTION public.fn_is_service_context() SET search_path=pg_catalog;\n" + installer, 'P0001')
    run('metadata-after-drift', "SELECT 1 / (CASE WHEN md5(pg_get_functiondef('public.fn_is_service_context()'::regprocedure))='182174b0de81460b135f1002062f3764' THEN 1 ELSE 0 END);")
    # A stale browser write waiting behind a real service update must fail after
    # the service commits; it cannot overwrite the newer brain or horse status.
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        service = pool.submit(run, 'concurrent-service', 'BEGIN;\n' + identity('service_role', service_jwt) +
            f"UPDATE public.profiles SET horse_profile='{{\"brain\":3}}' WHERE id='{owner}'; SELECT pg_advisory_lock(9131716); SELECT pg_sleep(1); COMMIT;")
        deadline = time.monotonic() + 5
        while True:
            ready = command(cmd, "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=9131716 AND granted);")
            if ready.stdout.strip() == 't':
                break
            require(time.monotonic() < deadline, 'Service never acquired its fixture lock')
            time.sleep(0.02)
        browser = pool.submit(probe, 'concurrent-browser-refused', f"SELECT public.fixture_legacy_profile_write('{owner}','horse_profile','{{\"brain\":999}}');", '42501')
        service.result()
        browser.result()
    final = json.loads(run('concurrent-final-state', f"SELECT horse_profile FROM public.profiles WHERE id='{owner}';"))
    require(final == {'brain': 3}, 'Browser overwrote trusted concurrent update')
    results['passed'] = True
finally:
    if (cluster / 'data/postmaster.pid').exists():
        r = command([pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
        require(r.returncode == 0, 'Could not stop owned cluster: ' + r.stderr)
    if (cluster / 'server.log').exists():
        shutil.copyfile(cluster / 'server.log', out / 'server.log')
    require(not (cluster / 'data/postmaster.pid').exists(), 'Owned cluster is still running')
    shutil.rmtree(cluster)
    results['ownedClusterRemoved'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps({'passed': results['passed'], 'cases': len(results['cases']), 'evidence': str(out)}))
