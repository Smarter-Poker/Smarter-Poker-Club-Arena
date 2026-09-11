#!/usr/bin/env python3
"""Run the exact migration ranking blocks in a disposable PostgreSQL 17 cluster.

No connection string is accepted. This proves the ranking statements, not the
full current settlement, manager target, wallet, seat or deferred certificate.
Optionally --core-preimage applies the actual migration twice to the exact
combined core body and checks catalog metadata, plus hostile source/config.
"""
import argparse
import hashlib
import os
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'supabase/migrations/20260911204452_satellite_places_follow_the_accepted_bust_witness.sql'
BEFORE = '6eb5860aad223fd1cfd14a48de2064bb'
AFTER = '6d6637426f916cb766e606764af5e0a8'
IDENTITY = 'public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)'


def block(sql, tag):
    values = re.findall(r'\$' + tag + r'\$(.*?)\$' + tag + r'\$', sql, re.S)
    if len(values) != 1:
        raise AssertionError(f'{tag} is not unique')
    return values[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--core-preimage', type=Path)
    args = parser.parse_args()
    pgbin = Path(os.environ.get('PGBIN', '/opt/homebrew/opt/postgresql@17/bin'))
    if not pgbin.exists():
        pgbin = Path('/usr/lib/postgresql/17/bin')
    version = subprocess.check_output([pgbin / 'postgres', '--version'], text=True).strip()
    if not version.startswith('postgres (PostgreSQL) 17.'):
        raise RuntimeError('PostgreSQL 17 is required')
    migration = MIGRATION.read_text()
    old, new = block(migration, 'old_rank'), block(migration, 'accepted_rank')
    with tempfile.TemporaryDirectory(prefix='ca-satellite-bust-pg17-') as tmp:
        scratch = Path(tmp)
        socket = scratch / 'socket'
        socket.mkdir()
        data = scratch / 'data'
        subprocess.run([pgbin / 'initdb', '-D', data, '-U', 'postgres', '-A', 'trust',
                        '--no-locale', '-E', 'UTF8'], check=True, capture_output=True)
        subprocess.run([pgbin / 'pg_ctl', '-D', data, '-l', scratch / 'postgres.log',
                        '-o', f"-h '' -k '{socket}' -p 55499", '-w', 'start'],
                       check=True, capture_output=True)
        try:
            def sql(source, succeeds=True):
                result = subprocess.run([pgbin / 'psql', '-X', '-q', '-At', '-v',
                                         'ON_ERROR_STOP=1', '-h', socket, '-p', '55499',
                                         '-U', 'postgres', '-d', 'postgres'],
                                        input=source, text=True, capture_output=True)
                if succeeds != (result.returncode == 0):
                    raise AssertionError(result.stdout + result.stderr)
                return result.stdout + result.stderr

            sql((ROOT / 'scripts/dev/fixtures/satellite-accepted-bust-witness/schema.sql').read_text())
            for name, ranking in [('before', old), ('after', new)]:
                sql(f'''CREATE FUNCTION probe.rank_{name}(p_tournament_id uuid) RETURNS void
LANGUAGE plpgsql AS $body$
DECLARE v_field_size integer; v_eliminated_count integer; v_sequenced_count integer;
 v_distinct_sequence_count integer; v_rows integer;
BEGIN
 SELECT count(*) INTO v_field_size FROM public.tournament_players WHERE tournament_id=p_tournament_id;
{ranking}
END $body$;''')
            cases = ROOT / 'scripts/dev/fixtures/satellite-accepted-bust-witness/scenarios.sql'
            output = sql(cases.read_text())
            print(version)
            print(output.strip())
            if args.core_preimage:
                core = args.core_preimage.read_text()
                assert hashlib.md5(core.encode()).hexdigest() == BEFORE
                assert core.count(old) == 1
                updated = core.replace(old, new)
                assert hashlib.md5(updated.encode()).hexdigest() == AFTER
                assert updated.replace(new, old) == core
                sql(f'''CREATE FUNCTION {IDENTITY.replace('(uuid,uuid)', '(p_tournament_id uuid,p_observed_winner_id uuid)')}
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public SET statement_timeout='30s'
AS $body${core}$body$;
REVOKE ALL ON FUNCTION {IDENTITY} FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE probe.core_metadata AS SELECT to_jsonb(p)-'prosrc' AS metadata FROM pg_proc p
 WHERE oid='{IDENTITY}'::regprocedure;''')
                sql(migration)
                sql(migration)
                sql(f'''DO $check$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='{IDENTITY}'::regprocedure)<>'{AFTER}'
 OR (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid='{IDENTITY}'::regprocedure)
 IS DISTINCT FROM (SELECT metadata FROM probe.core_metadata)
 THEN RAISE EXCEPTION 'patch changed source or metadata unexpectedly'; END IF;
END $check$;''')
                sql(f"ALTER FUNCTION {IDENTITY} SET statement_timeout='29s';")
                denied = sql(migration, succeeds=False)
                assert 'source or owner metadata differs' in denied
                sql(f"ALTER FUNCTION {IDENTITY} SET statement_timeout='30s';")
                sql(f"GRANT EXECUTE ON FUNCTION {IDENTITY} TO service_role;")
                denied = sql(migration, succeeds=False)
                assert 'source or owner metadata differs' in denied
                sql(f"REVOKE ALL ON FUNCTION {IDENTITY} FROM service_role;")
                sql(f'''DO $drift$ DECLARE d text; b text; BEGIN
 SELECT pg_get_functiondef(oid),prosrc INTO d,b FROM pg_proc WHERE oid='{IDENTITY}'::regprocedure;
 EXECUTE replace(d,b,b||E'\\n-- source drift'); END $drift$;''')
                denied = sql(migration, succeeds=False)
                assert 'source or owner metadata differs' in denied
                print('PASS actual migration: exact rank-only patch, twice applied, metadata preserved, config/ACL/source drift denied')
            else:
                print('NOT RUN: full-core migration catalog proof (supply exact --core-preimage)')
            print('NOT QUALIFIED: full current manager/financial/seat/certificate execution and old-paid replay')
        finally:
            subprocess.run([pgbin / 'pg_ctl', '-D', data, '-m', 'immediate', '-w', 'stop'],
                           check=True, capture_output=True)


if __name__ == '__main__':
    main()
