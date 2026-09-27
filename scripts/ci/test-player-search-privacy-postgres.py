#!/usr/bin/env python3
"""Run fn_search_players privacy and live-table contracts in private PG17."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'scripts/ci/fixtures/player-search-privacy'
MIGRATION = ROOT / 'supabase/migrations/20260927152804_restore_final_player_search_fuzzy_affiliations_contract.sql'
PG_BIN = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin')).resolve()
SCRATCH = Path(os.environ.get('RUNNER_TEMP', tempfile.gettempdir()))
CLUSTER = Path(tempfile.mkdtemp(prefix='ca-player-search-', dir=SCRATCH))
DATA = CLUSTER / 'data'
SOCKET = Path(tempfile.mkdtemp(prefix='ca-ps-', dir=tempfile.gettempdir()))
ENV = {
    'PATH': str(PG_BIN) + ':/usr/bin:/bin',
    'LANG': 'C',
    'LC_ALL': 'C',
    'PGCONNECT_TIMEOUT': '5',
}
STARTED = False


def run(argv, sql=None, expected_error=None):
    result = subprocess.run(
        [str(value) for value in argv],
        input=sql,
        text=True,
        capture_output=True,
        env=ENV,
        timeout=60,
    )
    if expected_error is not None:
        assert result.returncode and expected_error in result.stderr, result.stderr + result.stdout
    elif result.returncode:
        raise RuntimeError(result.stderr + result.stdout)
    return result.stdout.strip()


def query(sql, expected_error=None):
    return run(
        [
            PG_BIN / 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-h', SOCKET,
            '-U', 'player_search_fixture_admin', '-d', 'postgres', '-p', '5432',
        ],
        sql,
        expected_error,
    )


def as_viewer(sql):
    return query(
        "SET ROLE authenticated; "
        "SET request.jwt.claim.sub='20000000-0000-0000-0000-000000000001'; "
        "SET request.jwt.claim.role='authenticated'; " + sql
    ).splitlines()[-1]


try:
    if ' 17.' not in run([PG_BIN / 'postgres', '--version']):
        raise RuntimeError('PostgreSQL 17 is required')
    run([
        PG_BIN / 'initdb', '-D', DATA, '-U', 'player_search_fixture_admin',
        '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8',
    ])
    with (DATA / 'postgresql.conf').open('a') as config:
        config.write(
            "\nlisten_addresses = ''\n"
            "unix_socket_directories = '" + str(SOCKET) + "'\n"
            "autovacuum = off\n"
        )
    STARTED = True
    run([PG_BIN / 'pg_ctl', '-D', DATA, '-l', CLUSTER / 'server.log', '-w', 'start'])
    query("""
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN;
      CREATE ROLE postgres NOLOGIN NOSUPERUSER BYPASSRLS;
      GRANT CREATE ON DATABASE postgres TO postgres;
      GRANT ALL ON SCHEMA public TO postgres;
      CREATE EXTENSION pg_trgm;
    """)
    query("SET ROLE postgres; " + (FIXTURE / 'setup.sql').read_text())
    query("SET ROLE postgres; " + MIGRATION.read_text())
    query("SET ROLE postgres; " + (FIXTURE / 'cases.sql').read_text())

    endpoint = json.loads(query(
        "SELECT json_build_object('address',inet_server_addr(),'data',current_setting('data_directory'),"
        "'listen',current_setting('listen_addresses'));"
    ))
    assert endpoint == {'address': None, 'data': str(DATA), 'listen': ''}, endpoint

    query(
        "SET ROLE anon; SET request.jwt.claim.sub='20000000-0000-0000-0000-000000000001'; "
        "SELECT public.fn_search_players('king');",
        'permission denied for function fn_search_players',
    )

    payload = json.loads(as_viewer("SELECT public.fn_search_players('kingfsh');"))
    assert payload['fuzzy'] is True, payload
    assert payload['total'] == 1 and len(payload['items']) == 1, payload
    player = payload['items'][0]
    assert player['username'] == 'kingfish', player
    assert player['display_name'] is None, player
    assert player['presence_status'] == 'offline', player
    assert player['tables'] == [], player
    assert player['sensitive_accounts'] == [], player
    affiliations = player['affiliations']
    assert affiliations['has_hidden'] is True, affiliations
    assert [club['club_name'] for club in affiliations['clubs']] == ['Open Room'], affiliations
    assert 'role' not in affiliations['clubs'][0], affiliations
    assert 'hidden_count' not in affiliations, affiliations

    # A privacy preference may redact optional fields, but it cannot make the
    # account undiscoverable from the global authenticated locator.
    exact = json.loads(as_viewer("SELECT public.fn_search_players('kingfish');"))
    assert exact['total'] == 1, exact

    # `%` is a literal user character, never a caller-controlled LIKE wildcard.
    wildcard = json.loads(as_viewer("SELECT public.fn_search_players('%f');"))
    assert wildcard['total'] == 0 and wildcard['items'] == [], wildcard

    # Click-time access independently rejects deleted and closed tables even
    # if a caller held an older search card. The mismatched table is itself a
    # valid table for another event; the search assertion above proves the
    # target's stale tournament-player association cannot expose it.
    for table_id in (
        '30000000-0000-0000-0000-000000000001',
        '30000000-0000-0000-0000-000000000002',
    ):
        access = json.loads(as_viewer(
            "SELECT public.fn_get_table_watch_access('" + table_id + "');"
        ))
        assert access == {'found': False, 'action': 'unavailable', 'can_watch': False}, access

    live_access = json.loads(as_viewer(
        "SELECT public.fn_get_table_watch_access("
        "'30000000-0000-0000-0000-000000000003');"
    ))
    assert live_access['found'] is True, live_access
    assert live_access['can_watch'] is False, live_access
    assert live_access['action'] == 'request_join', live_access

    acl = query("""
      SELECT NOT has_function_privilege('anon',
               'public.fn_search_players(text,integer,integer,text,text,text)', 'EXECUTE')
         AND has_function_privilege('authenticated',
               'public.fn_search_players(text,integer,integer,text,text,text)', 'EXECUTE')
         AND prosecdef
         AND proconfig @> ARRAY['search_path=public, pg_temp']::text[]
        FROM pg_proc
       WHERE oid = 'public.fn_search_players(text,integer,integer,text,text,text)'::regprocedure;
    """)
    assert acl == 't', acl

    watch_acl = query("""
      SELECT NOT has_function_privilege('anon',
               'public.fn_get_table_watch_access(uuid)', 'EXECUTE')
         AND has_function_privilege('authenticated',
               'public.fn_get_table_watch_access(uuid)', 'EXECUTE')
        FROM pg_proc
       WHERE oid = 'public.fn_get_table_watch_access(uuid)'::regprocedure;
    """)
    assert watch_acl == 't', watch_acl

    print('player-search-privacy-native-acceptance-passed')
finally:
    if STARTED and (DATA / 'postmaster.pid').exists():
        run([PG_BIN / 'pg_ctl', '-D', DATA, '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(CLUSTER)
    shutil.rmtree(SOCKET)
