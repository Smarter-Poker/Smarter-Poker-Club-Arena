#!/usr/bin/env python3
"""Exact river-call migration proof in a disposable socket-only PostgreSQL 17.

Uses the retained observation-window preimage chain, never a production DSN.
On macOS TMPDIR must name the assigned external SSD task scratch directory.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'tests/sql/fixtures/horse-observation-window'
PREVIOUS = ROOT / 'supabase/migrations/20260930233329_horse_observation_window_persistence.sql'
MIGRATION = ROOT / 'supabase/migrations/20261026033405_horse_mind_river_call_reads.sql'
PREIMAGES = ['648dd5565a2e07e320cf7e8ff6a84f0b', 'd0c06a49e33ea919e8dabf87020bc0da']
PORT = '55483'
DB = 'horse_river_call_test'


def literal(value):
    return "'" + json.dumps(value).replace("'", "''") + "'::jsonb"


def window(lo, hi, coverage='complete'):
    return {'version': 1, 'coverage': coverage, 'fromMs': lo, 'toMs': hi}


def main():
    if not __debug__:
        raise RuntimeError('optimized qualification forbidden')
    base = Path(os.environ.get('TMPDIR') or os.environ.get('RUNNER_TEMP') or tempfile.gettempdir()).resolve()
    if sys.platform == 'darwin' and not str(base).startswith('/Volumes/SmarterWork/agent-work/'):
        raise RuntimeError('Set TMPDIR to the assigned external SSD task scratch directory')
    base.mkdir(parents=True, exist_ok=True)
    pg = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
    for name in ('initdb', 'pg_ctl', 'psql', 'createdb'):
        if not (pg / name).is_file():
            raise RuntimeError(f'PG17 tool missing: {pg / name}')
    env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
    checks = []
    with tempfile.TemporaryDirectory(prefix='rc-', dir=base) as raw:
        work = Path(raw)
        socket = work / 's'
        socket_owner = None
        if len(str(socket / f'.s.PGSQL.{PORT}').encode()) >= 104:
            socket_owner = tempfile.TemporaryDirectory(prefix='rc-', dir=base.parent)
            socket = Path(socket_owner.name)
        socket.mkdir(exist_ok=True)
        if len(str(socket / f'.s.PGSQL.{PORT}').encode()) >= 104:
            raise RuntimeError('Assigned scratch path too long for private PostgreSQL socket')
        data = work / 'data'
        started = False

        def command(args, **kwargs):
            return subprocess.run([str(a) for a in args], env=env, text=True,
                                  capture_output=True, timeout=120, **kwargs)

        def sql(text, succeeds=True):
            result = command([pg / 'psql', '-X', '-qAt', '-h', socket, '-p', PORT,
                              '-U', 'postgres', '-d', DB, '-v', 'ON_ERROR_STOP=1'], input=text)
            if succeeds and result.returncode:
                raise AssertionError(result.stderr)
            if not succeeds and not result.returncode:
                raise AssertionError('Expected refusal unexpectedly succeeded')
            return result.stdout.strip() if succeeds else result.stderr

        def check(text, expected, name):
            actual = sql(text)
            assert actual == expected, f'{name}: {actual!r} != {expected!r}'
            checks.append(name)

        def call(row, scoped=False):
            name = 'upsert_horse_mind_stats' + ('_scoped' if scoped else '')
            return f'SELECT public.{name}({literal(row)});'

        def row(key, scoped=False):
            table = 'horse_mind_stats' + ('_scoped' if scoped else '')
            return json.loads(sql(f"SELECT to_jsonb(t) FROM public.{table} t WHERE user_id='{key}';"))

        def security():
            return sql("""SELECT jsonb_agg(jsonb_build_array(proname,proowner,proacl::text,
                prosecdef,proconfig,pg_get_function_identity_arguments(oid),pg_get_function_result(oid))
                ORDER BY proname) FROM pg_proc WHERE oid IN
                ('public.upsert_horse_mind_stats(jsonb)'::regprocedure,
                 'public.upsert_horse_mind_stats_scoped(jsonb)'::regprocedure);""")

        try:
            for args in ([pg / 'initdb', '-D', data, '-U', 'postgres', '-A', 'trust'],
                         [pg / 'pg_ctl', '-D', data, '-l', work / 'postgres.log',
                          '-o', f"-k {socket} -p {PORT} -c listen_addresses=''", '-w', 'start']):
                result = command(args)
                if result.returncode:
                    raise RuntimeError(result.stderr + result.stdout)
            started = True
            result = command([pg / 'createdb', '-h', socket, '-p', PORT, '-U', 'postgres', DB])
            if result.returncode:
                raise RuntimeError(result.stderr)
            check("SELECT inet_server_addr() IS NULL AND current_setting('server_version_num')::int BETWEEN 170000 AND 179999;",
                  't', 'private socket-only PostgreSQL 17')
            sql((FIXTURE / 'schema.sql').read_text())
            sql((FIXTURE / 'installed-rpc-preimage.sql').read_text())
            sql(PREVIOUS.read_text())
            actual = json.loads(sql("SELECT jsonb_build_array(md5(pg_get_functiondef('public.upsert_horse_mind_stats(jsonb)'::regprocedure)),md5(pg_get_functiondef('public.upsert_horse_mind_stats_scoped(jsonb)'::regprocedure)));"))
            assert actual == PREIMAGES, f'preimage chain differs: {actual}'
            checks.append('retained fixture chain reproduces both exact installed RPC preimages')
            before_security = security()
            table_security = sql("SELECT jsonb_agg(jsonb_build_array(relname,relowner,relacl::text,relrowsecurity,relforcerowsecurity) ORDER BY relname) FROM pg_class WHERE oid IN ('public.horse_mind_stats'::regclass,'public.horse_mind_stats_scoped'::regclass);")
            for scoped in (False, True):
                payload = {'user_id': 'before', 'hands': 3, 'river_call_sd': 4, 'river_call_sd_weak': 2}
                if scoped:
                    payload['scope'] = 'holdem:hu'
                check(call([payload], scoped), '1', f'old RPC accepts new engine payload scoped={scoped}')
                assert 'river_call_sd' not in row('before', scoped)
            checks.append('before migration both RPCs drop river evidence, reproducing missing persistence')
            # Refusals are inside one transaction so even fixture drift is undone.
            for function in ('upsert_horse_mind_stats', 'upsert_horse_mind_stats_scoped'):
                drift = f"CREATE OR REPLACE FUNCTION public.{function}(rows jsonb) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$ BEGIN RETURN -1; END $$;"
                candidate = MIGRATION.read_text().replace('BEGIN;', '', 1)
                refusal = sql('BEGIN;\n' + drift + '\n' + candidate, succeeds=False)
                assert 'preimage drift' in refusal, refusal
                check("SELECT count(*) FROM information_schema.columns WHERE table_name IN ('horse_mind_stats','horse_mind_stats_scoped') AND column_name IN ('river_call_sd','river_call_sd_weak');",
                      '0', f'{function} drift refuses before DDL and rolls back')
            sql(MIGRATION.read_text())
            assert security() == before_security
            check("SELECT jsonb_agg(jsonb_build_array(relname,relowner,relacl::text,relrowsecurity,relforcerowsecurity) ORDER BY relname) FROM pg_class WHERE oid IN ('public.horse_mind_stats'::regclass,'public.horse_mind_stats_scoped'::regclass);",
                  table_security, 'table grants and RLS unchanged')
            checks.append('RPC signatures owners ACLs SECURITY DEFINER and search_path unchanged')
            for scoped in (False, True):
                tag = 'scoped' if scoped else 'pooled'
                scope = {'scope': 'holdem:hu'} if scoped else {}
                assert row('before', scoped)['river_call_sd'] == 0
                key = tag + '-live'
                payload = {'user_id': key, **scope, 'hands': 4, 'river_call_sd': 12,
                           'river_call_sd_weak': 8, 'source_window': window(100, 200)}
                check('SET ROLE service_role; ' + call([payload], scoped), '1', tag + ' new counters persisted through service RPC')
                sql(call([{**payload, 'hands': 2, 'river_call_sd': 5, 'river_call_sd_weak': 3,
                           'source_window': window(50, 300)}], scoped))
                actual = row(key, scoped)
                assert (actual['hands'], actual['river_call_sd'], actual['river_call_sd_weak']) == (4, 12, 8)
                assert actual['source_window'] == window(50, 300)
                checks.append(tag + ' GREATEST counters and source-window union preserved')
                sql(call([{'user_id': key, **scope, 'hands': 4}], scoped))
                actual = row(key, scoped)
                assert (actual['river_call_sd'], actual['river_call_sd_weak']) == (12, 8)
                checks.append(tag + ' sparse old-engine write cannot erase river counters')
                sql(call([{'user_id': key, **scope, 'hands': 4, 'river_call_sd': 13, 'river_call_sd_weak': 9}], scoped))
                assert row(key, scoped)['source_window'] == window(50, 300, 'partial')
                checks.append(tag + ' contributing unproven river increment degrades source coverage')
                for role in ('anon', 'authenticated'):
                    assert 'permission denied for function' in sql('SET ROLE ' + role + '; ' + call([payload], scoped), succeeds=False)
                checks.append(tag + ' anon and authenticated cannot invoke writer')
                invalid = [{**payload, 'user_id': tag + '-a-rollback'}, {**payload, 'user_id': tag + '-z-bad', 'river_call_sd': 'invalid'}]
                assert 'invalid input syntax' in sql(call(invalid, scoped), succeeds=False)
                table = 'horse_mind_stats' + ('_scoped' if scoped else '')
                check(f"SELECT count(*) FROM public.{table} WHERE user_id='{tag}-a-rollback';", '0', tag + ' malformed batch rolls back all rows')
            print(json.dumps({'status': 'passed', 'checks': checks, 'checkCount': len(checks),
                              'migration': str(MIGRATION.relative_to(ROOT)),
                              'migrationSHA256': hashlib.sha256(MIGRATION.read_bytes()).hexdigest(),
                              'preimageMD5': PREIMAGES,
                              'boundary': 'isolated PostgreSQL 17; no production mutation'}, indent=2))
        finally:
            if started or (data / 'postmaster.pid').exists():
                result = command([pg / 'pg_ctl', '-D', data, '-m', 'fast', '-w', 'stop'])
                if result.returncode:
                    raise RuntimeError('Private PostgreSQL cleanup failed: ' + result.stderr)
            if socket_owner:
                socket_owner.cleanup()


if __name__ == '__main__':
    main()
