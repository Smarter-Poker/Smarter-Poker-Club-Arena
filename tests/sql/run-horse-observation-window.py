#!/usr/bin/env python3
"""Qualify the Horse source-window migration on a private socket-only PG17.

No DSN, host, credentials, production fixtures, or existing cluster are accepted.
TMPDIR/RUNNER_TEMP selects scratch storage; on macOS it must be the external SSD.
"""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'tests/sql/fixtures/horse-observation-window'
MIGRATION = ROOT / 'supabase/migrations/20260930233329_horse_observation_window_persistence.sql'
DB = 'horse_observation_window_test'
PORT = '55479'
LIFETIME = ['hands', 'vpip', 'pfr', 'three_bet', 'aggr', 'passive', 'folds', 'faced_aggr',
            'cbet_opps', 'cbet_folds', 'f3b_opps', 'f3b_folds', 'bigbet_sd', 'bigbet_sd_strong',
            'post_aggr', 'post_passive', 'river_bet_opps', 'river_bet_folds', 'checks',
            'snap_bet_sd', 'snap_bet_sd_strong', 'tank_bet_sd', 'tank_bet_sd_strong']
RECENCY = ['r_hands', 'r_folds', 'r_faced_aggr', 'r_aggr', 'r_passive', 'r_checks']
UNKNOWN = {'version': 1, 'coverage': 'unknown', 'fromMs': None, 'toMs': None}


def window(lo, hi, coverage='complete'):
    return {'version': 1, 'coverage': coverage, 'fromMs': lo, 'toMs': hi}


def literal(value):
    return "'" + json.dumps(value).replace("'", "''") + "'::jsonb"


def main():
    base = Path(os.environ.get('TMPDIR') or os.environ.get('RUNNER_TEMP') or tempfile.gettempdir()).resolve()
    if sys.platform == 'darwin' and not str(base).startswith('/Volumes/SmarterWork/agent-work/'):
        raise RuntimeError('Set TMPDIR to the assigned external SSD task scratch directory')
    base.mkdir(parents=True, exist_ok=True)
    pg_bin = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
    for name in ('initdb', 'pg_ctl', 'psql', 'createdb'):
        if not (pg_bin / name).is_file():
            raise RuntimeError(f'PG17 tool missing: {pg_bin / name}')
    env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
    passed = []
    with tempfile.TemporaryDirectory(prefix='hw-', dir=base) as raw:
        work = Path(raw)
        socket_dir = work / 's'
        # macOS sockaddr_un has a strict byte limit. The separate private socket
        # directory, when needed, still lives beneath the same assigned SSD task.
        socket_owner = None
        if len(str(socket_dir / f'.s.PGSQL.{PORT}').encode()) >= 104:
            socket_owner = tempfile.TemporaryDirectory(prefix='hw-', dir=base.parent)
            socket_dir = Path(socket_owner.name)
        socket_dir.mkdir(exist_ok=True)
        if len(str(socket_dir / f'.s.PGSQL.{PORT}').encode()) >= 104:
            raise RuntimeError('Assigned scratch path is too long for a private PostgreSQL Unix socket')
        data_dir = work / 'data'
        started = False

        def command(args, **kwargs):
            return subprocess.run([str(x) for x in args], env=env, text=True,
                                  capture_output=True, timeout=120, **kwargs)

        def sql(text, succeeds=True):
            result = command([pg_bin / 'psql', '-X', '-qAt', '-h', socket_dir, '-p', PORT,
                              '-U', 'postgres', '-d', DB, '-v', 'ON_ERROR_STOP=1'], input=text)
            if succeeds and result.returncode:
                raise AssertionError(result.stderr)
            if not succeeds and not result.returncode:
                raise AssertionError('Expected refusal unexpectedly succeeded')
            return result.stdout.strip() if succeeds else result.stderr

        def check(text, expected, name):
            actual = sql(text)
            assert actual == expected, f'{name}: {actual!r} != {expected!r}'
            passed.append(name)

        def call(payload, scoped=False):
            name = 'upsert_horse_mind_stats' + ('_scoped' if scoped else '')
            return f'SELECT public.{name}({literal(payload)});'

        def read_row(key, scoped=False):
            table = 'horse_mind_stats' + ('_scoped' if scoped else '')
            return json.loads(sql(f"SELECT to_jsonb(t) FROM public.{table} t WHERE user_id='{key}';"))

        def catalog():
            return sql("""SELECT jsonb_agg(jsonb_build_object(
                'name',proname,'owner',pg_get_userbyid(proowner),'acl',proacl::text,
                'definer',prosecdef,'config',proconfig,'args',pg_get_function_identity_arguments(oid),
                'return',pg_get_function_result(oid)) ORDER BY proname)
                FROM pg_proc WHERE oid IN ('public.upsert_horse_mind_stats(jsonb)'::regprocedure,
                'public.upsert_horse_mind_stats_scoped(jsonb)'::regprocedure);""")

        try:
            for args in ([pg_bin / 'initdb', '-D', data_dir, '-U', 'postgres', '-A', 'trust'],
                         [pg_bin / 'pg_ctl', '-D', data_dir, '-l', work / 'postgres.log',
                          '-o', f"-k {socket_dir} -p {PORT} -c listen_addresses=''", '-w', 'start']):
                result = command(args)
                if result.returncode:
                    raise RuntimeError(result.stderr + result.stdout)
            started = True
            result = command([pg_bin / 'createdb', '-h', socket_dir, '-p', PORT, '-U', 'postgres', DB])
            if result.returncode:
                raise RuntimeError(result.stderr)
            check("SELECT current_database() = 'horse_observation_window_test' AND inet_server_addr() IS NULL AND current_setting('server_version_num')::int BETWEEN 170000 AND 179999;",
                  't', 'isolated socket-only PostgreSQL 17')
            sql((FIXTURE / 'schema.sql').read_text())
            original = (FIXTURE / 'installed-rpc-preimage.sql').read_text()
            sql(original)
            for name in ['upsert_horse_mind_stats', 'upsert_horse_mind_stats_scoped']:
                sql(f'REVOKE ALL ON FUNCTION public.{name}(jsonb) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public.{name}(jsonb) TO service_role;')
            before = catalog()
            table_before = sql("SELECT jsonb_agg(jsonb_build_array(relname,relowner,relacl::text,relrowsecurity,relforcerowsecurity) ORDER BY relname) FROM pg_class WHERE oid IN ('public.horse_mind_stats'::regclass,'public.horse_mind_stats_scoped'::regclass);")
            check(call([{'user_id': 'old-engine', 'hands': 2, 'source_window': window(10, 20)}]),
                  '1', 'new JSON payload accepted by installed old RPC')
            assert 'source_window' not in read_row('old-engine')
            passed.append('baseline reproduces dropped original observation window')
            # The installation must refuse a changed live RPC before any DDL.
            sql("CREATE OR REPLACE FUNCTION public.upsert_horse_mind_stats(rows jsonb) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$ BEGIN RETURN -1; END $$;")
            refusal = sql(MIGRATION.read_text(), succeeds=False)
            assert 'preimage drift' in refusal, refusal
            check("SELECT count(*) FROM information_schema.columns WHERE table_name IN ('horse_mind_stats','horse_mind_stats_scoped') AND column_name='source_window';",
                  '0', 'RPC preimage drift rolls back before adding columns')
            sql(original)
            sql(MIGRATION.read_text())
            assert catalog() == before, 'RPC owner/ACL/signature/SECURITY DEFINER/search_path changed'
            passed.append('both installed RPC security contracts preserved')
            check("SELECT jsonb_agg(jsonb_build_array(relname,relowner,relacl::text,relrowsecurity,relforcerowsecurity) ORDER BY relname) FROM pg_class WHERE oid IN ('public.horse_mind_stats'::regclass,'public.horse_mind_stats_scoped'::regclass);",
                  table_before, 'table grants and RLS unchanged')
            assert read_row('old-engine')['source_window'] is None
            passed.append('legacy rows receive no invented backfill')
            for name in ['upsert_horse_mind_stats(jsonb)', 'upsert_horse_mind_stats_scoped(jsonb)',
                         'fn_horse_mind_source_window_normalize(jsonb)', 'fn_horse_mind_source_window_merge(jsonb,jsonb)']:
                check(f"SELECT NOT has_function_privilege('anon','public.{name}','EXECUTE') AND NOT has_function_privilege('authenticated','public.{name}','EXECUTE') AND has_function_privilege('service_role','public.{name}','EXECUTE');",
                      't', f'restricted execution: {name}')
            for role in ('anon', 'authenticated'):
                refusal = sql(f'SET ROLE {role}; ' + call([{'user_id': 'forbidden', 'hands': 1}]), succeeds=False)
                assert 'permission denied for function upsert_horse_mind_stats' in refusal
                check(f'SET ROLE {role}; SELECT count(*) FROM public.horse_mind_stats;', '0',
                      role + ' cannot execute memory writer or read protected rows')
            for malformed in [None, [], {}, window(-1, 10), window(20, 10), window(1.5, 5),
                              window(1, 9007199254740992), {**window(1, 2), 'extra': 3},
                              {**window(1, 2), 'fromMs': '1'}]:
                assert json.loads(sql(f'SELECT public.fn_horse_mind_source_window_normalize({literal(malformed)});')) == UNKNOWN
            passed.append('malformed/unsafe timestamps normalize unknown without throwing')
            for scoped in (False, True):
                tag = 'scoped' if scoped else 'pooled'
                scope = {'scope': 'omaha:short'} if scoped else {}
                def payload(key, **values):
                    return [{'user_id': key, **scope, **values}]
                key = f'{tag}-complete'
                values = {k: 4 for k in LIFETIME}
                check('SET ROLE service_role; ' + call(payload(key, **values, source_window=window(100, 200)), scoped),
                      '1', tag + ' service role writes complete original envelope')
                sql(call(payload(key, **{k: 2 for k in LIFETIME}, source_window=window(50, 300)), scoped))
                row = read_row(key, scoped)
                assert all(row[k] == 4 for k in LIFETIME)
                assert row['source_window'] == window(50, 300)
                passed.append(tag + ' all 23 lifetime maxima preserved with complete envelope union')
                sql(call(payload(key, hands=5), scoped))
                assert read_row(key, scoped)['source_window'] == window(50, 300, 'partial')
                passed.append(tag + ' contributing legacy payload degrades complete coverage')
                sql(call(payload(key, hands=6, source_window=window(400, 500)), scoped))
                assert read_row(key, scoped)['source_window'] == window(50, 500, 'partial')
                passed.append(tag + ' partial historical coverage cannot become complete')
                legacy = f'{tag}-legacy'
                sql(call(payload(legacy, hands=8), scoped))
                assert read_row(legacy, scoped)['source_window'] == UNKNOWN
                sql(call(payload(legacy, hands=9, source_window=window(600, 700)), scoped))
                assert read_row(legacy, scoped)['source_window'] == window(600, 700, 'partial')
                passed.append(tag + ' old nonzero rows retain unknown history on newer complete snapshot')
                zero = f'{tag}-zero'
                sql(call(payload(zero), scoped))
                sql(call(payload(zero, hands=1, source_window=window(800, 900)), scoped))
                assert read_row(zero, scoped)['source_window'] == window(800, 900)
                passed.append(tag + ' pristine zero counters can begin complete history')
                sql(call(payload(zero, hands=1), scoped))
                assert read_row(zero, scoped)['source_window'] == window(800, 900)
                passed.append(tag + ' unchanged legacy lifetime maxima do not add fabricated history')
                invalid = payload(f'{tag}-rollback', hands=1) + payload(f'{tag}-bad', hands='invalid-int')
                assert 'invalid input syntax' in sql(call(invalid, scoped), succeeds=False)
                table = 'horse_mind_stats' + ('_scoped' if scoped else '')
                check(f"SELECT count(*) FROM public.{table} WHERE user_id='{tag}-rollback';", '0',
                      tag + ' failed batch rolls back both counters and metadata')
                check(call([{'user_id': '', **scope}, {'user_id': 'x' * 129, **scope}], scoped),
                      '0', tag + ' original key validation and scalar receipt preserved')
            for changed in (4, 1):
                key = f'recency-{changed}'
                sql(call([{'user_id': key, 'hands': 4, **{c: 4 for c in RECENCY}, 'source_window': window(10, 20)}]))
                sql(call([{'user_id': key, 'hands': 4, **{c: changed for c in RECENCY}}]))
                row = read_row(key)
                assert all(row[c] == changed for c in RECENCY)
                assert row['source_window'] == window(10, 20, 'partial')
                passed.append(f'legacy recency overwrite 4-to-{changed} conservatively degrades coverage')
            for scoped in (False, True):
                tag = 'scoped' if scoped else 'pooled'
                def concurrent_write(i):
                    value = {'user_id': tag + '-race', 'hands': i + 1,
                             'source_window': window((i + 1) * 100, (i + 1) * 100)}
                    if scoped:
                        value['scope'] = 'holdem:hu'
                    sql('BEGIN; ' + call([value], scoped) + ' SELECT pg_sleep(0.02); COMMIT;')
                with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                    list(pool.map(concurrent_write, range(8)))
                row = read_row(tag + '-race', scoped)
                assert row['hands'] == 8 and row['source_window'] == window(100, 800)
                passed.append(tag + ' concurrent row updates preserve counter maximum and complete envelope')
            print(json.dumps({'status': 'passed', 'checks': passed, 'checkCount': len(passed),
                              'migration': str(MIGRATION.relative_to(ROOT)),
                              'migrationSHA256': hashlib.sha256(MIGRATION.read_bytes()).hexdigest(),
                              'boundary': 'isolated PostgreSQL 17; no production mutation'}, indent=2))
        finally:
            if started or (data_dir / 'postmaster.pid').exists():
                result = command([pg_bin / 'pg_ctl', '-D', data_dir, '-m', 'fast', '-w', 'stop'])
                if result.returncode:
                    raise RuntimeError('Private PostgreSQL cleanup failed: ' + result.stderr)
            if socket_owner:
                socket_owner.cleanup()


if __name__ == '__main__':
    main()
