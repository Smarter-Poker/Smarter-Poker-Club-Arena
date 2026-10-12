"""Credential containment and failed-export boundaries; not a restore drill."""
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import shutil

SPEC = importlib.util.spec_from_file_location(
    'native_export', Path(__file__).resolve().parents[1] / 'dr/native-supabase-export.py')
DRIVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DRIVER)

SCRIPT = '''export PGHOST="example.invalid"
export PGPORT="5432"
export PGUSER="fixture"
export PGPASSWORD="fixture password with spaces"
export PGDATABASE="fixture"
pg_dump --schema-only
'''


class NativeExportBoundaries(unittest.TestCase):
    def test_wrong_or_unlinked_project_refuses_before_credentials_are_prepared(self):
        with tempfile.TemporaryDirectory() as folder:
            work = Path(folder)
            metadata = work / 'supabase/.temp'
            metadata.mkdir(parents=True)
            with self.assertRaises(DRIVER.ExportError):
                DRIVER.linked_project(work, 'a'*20)
            (metadata / 'project-ref').write_text('b'*20)
            with self.assertRaises(DRIVER.ExportError):
                DRIVER.linked_project(work, 'a'*20)
            DRIVER.linked_project(work, 'b'*20)
    def test_diagnostic_retains_only_allowlisted_stage_without_private_source(self):
        self.assertEqual(DRIVER.safe_stage(b'fixture-password\npg_dump: reading user-defined functions\nprivate-source'),
                         'user-defined functions')
        self.assertEqual(DRIVER.safe_stage('pg_dump: reading secret-private-relation'), 'unknown')
    def test_ephemeral_connection_preserves_quoted_password_and_enforces_tls(self):
        with patch.dict(os.environ, {'PGSSLMODE': 'disable'}):
            env = DRIVER.connection_environment(SCRIPT)
        self.assertEqual(env['PGPASSWORD'], 'fixture password with spaces')
        self.assertEqual(env['PGSSLMODE'], 'verify-full')
        self.assertEqual(env['PGSSLROOTCERT'], 'system')

    def test_incomplete_duplicate_unknown_and_malformed_connections_refuse(self):
        candidates = [SCRIPT.replace('export PGDATABASE="fixture"\n', ''),
                      SCRIPT + 'export PGHOST="other.invalid"\n',
                      SCRIPT + 'export UNEXPECTED_SECRET="fixture"\n',
                      SCRIPT.replace('5432', '99999'),
                      SCRIPT.replace('5432', 'five'),
                      SCRIPT + 'export PGHOST="fixture"; echo fixture\n']
        for candidate in candidates:
            with self.subTest(candidate=candidates.index(candidate)):
                with self.assertRaises(DRIVER.ExportError) as raised:
                    DRIVER.connection_environment(candidate)
                self.assertNotIn('fixture password', str(raised.exception))

    def test_provider_failure_does_not_disclose_raw_stderr_or_arguments(self):
        with patch.object(DRIVER.subprocess, 'run', return_value=
                          subprocess.CompletedProcess([], 1, SCRIPT, 'secret-provider-error')):
            with self.assertRaises(DRIVER.ExportError) as raised:
                DRIVER.cli_environment('fixture-cli', Path('.'))
        self.assertNotIn('secret-provider-error', str(raised.exception))

    def test_internal_output_and_existing_or_redirected_artifact_refuse(self):
        for path in ['/tmp/export.sql', '/Users/example/export.sql']:
            with self.assertRaises(DRIVER.ExportError):
                DRIVER.destination(path)

    def test_failed_timeout_or_empty_dump_never_promotes_partial(self):
        # CI's temporary root is provider-owned; the driver rejects internal Mac
        # paths at its real entrypoint. This isolated function test moves no data.
        with tempfile.TemporaryDirectory() as folder:
            for kind in ['failed', 'timeout', 'empty']:
                path = Path(folder) / (kind + '.dump')
                def run(*args, **kwargs):
                    if kind == 'timeout':
                        raise subprocess.TimeoutExpired('pg_dump', 1)
                    kwargs['stdout'].write(b'partial' if kind == 'failed' else b'')
                    return subprocess.CompletedProcess([], 1 if kind == 'failed' else 0,
                                                       stderr=b'fixture-secret')
                with patch.object(DRIVER.subprocess, 'run', side_effect=run):
                    with self.assertRaises(DRIVER.ExportError) as raised:
                        DRIVER.export('pg_dump', {}, path, 'full', 1)
                self.assertFalse(path.exists())
                self.assertNotIn('fixture-secret', str(raised.exception))

    def test_full_dump_has_no_exclusions_and_export_receipt_never_certifies_restore(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'full.dump'
            def run(command, **kwargs):
                self.assertIn('--format=custom', command)
                self.assertNotIn('--schema-only', command)
                self.assertFalse(any('exclude' in arg for arg in command))
                self.assertIn('--lock-wait-timeout=5s', command)
                kwargs['stdout'].write(b'fixture archive')
                return subprocess.CompletedProcess(command, 0, stderr=b'')
            with patch.object(DRIVER.subprocess, 'run', side_effect=run):
                result = DRIVER.export('pg_dump', {}, path, 'full', 10)
            self.assertTrue(result['exported'])
            self.assertFalse(result['restore_qualified'])
            self.assertEqual(result['bytes'], len(b'fixture archive'))
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertFalse(path.with_name('full.dump.partial').exists())

    def test_competing_destination_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'full.dump'
            def run(command, **kwargs):
                kwargs['stdout'].write(b'new archive')
                path.write_bytes(b'other operation')
                return subprocess.CompletedProcess(command, 0, stderr=b'')
            with patch.object(DRIVER.subprocess, 'run', side_effect=run):
                with self.assertRaises(FileExistsError):
                    DRIVER.export('pg_dump', {}, path, 'full', 10)
            self.assertEqual(path.read_bytes(), b'other operation')
            self.assertEqual(path.with_name('full.dump.partial').read_bytes(), b'new archive')

    def test_actual_pg17_archive_restores_rows_partitions_generators_routines_and_acl(self):
        pg = Path(os.environ.get('PG_BIN', '/opt/homebrew/bin'))
        parent = os.environ.get('NATIVE_PG_SOCKET_ROOT', os.environ.get('TMPDIR'))
        with tempfile.TemporaryDirectory(prefix='nr-', dir=parent) as folder:
            root = Path(folder)
            socket = root / 's'
            socket.mkdir(mode=0o700)
            if len(str(socket / '.s.PGSQL.5432').encode()) >= 104:
                self.fail('Owned native socket path exceeds PostgreSQL Unix-socket limit')
            data = root / 'data'
            env = dict(os.environ, PGHOST=str(socket), PGPORT='5432',
                       PGUSER='recovery_fixture', PGDATABASE='postgres', PGSSLMODE='require')
            def run(args, sql=None, success=True):
                result = subprocess.run([str(arg) for arg in args], input=sql,
                                        capture_output=True, text=True, env=env, timeout=60)
                if success:
                    self.assertEqual(result.returncode, 0, result.stderr)
                else:
                    self.assertNotEqual(result.returncode, 0)
                return result.stdout.strip()
            self.assertIn(' 17.', run([pg / 'pg_dump', '--version']))
            run([pg / 'initdb', '-D', data, '-U', 'recovery_fixture',
                 '--auth-local=trust', '--auth-host=reject', '--no-locale', '-E', 'UTF8'])
            with (data / 'postgresql.conf').open('a') as config:
                config.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) + "'\n")
            started = False
            try:
                started = True
                run([pg / 'pg_ctl', '-D', data, '-l', root / 'server.log', '-w', 'start'])
                psql = [pg / 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1']
                run(psql, "CREATE DATABASE source_fixture; CREATE DATABASE restored_fixture; CREATE ROLE recovery_reader;")
                env['PGDATABASE'] = 'source_fixture'
                run(psql, """
                    CREATE TABLE club_wallets(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                                             chips numeric(18,2) CHECK(chips>=0),
                                             cents bigint GENERATED ALWAYS AS ((chips*100)::bigint) STORED);
                    INSERT INTO club_wallets(chips) VALUES(10000),(0),(12350);
                    CREATE TABLE hand_journal(id bigint, wallet_id bigint REFERENCES club_wallets(id),
                                              amount numeric(18,2)) PARTITION BY RANGE(id);
                    CREATE TABLE hand_journal_early PARTITION OF hand_journal FOR VALUES FROM(1) TO(10);
                    INSERT INTO hand_journal VALUES(1,1,15.25),(2,2,0);
                    CREATE FUNCTION total_chips() RETURNS numeric LANGUAGE sql STABLE
                      AS $$SELECT sum(chips) FROM club_wallets$$;
                    GRANT SELECT ON club_wallets TO recovery_reader;
                    ALTER TABLE club_wallets ENABLE ROW LEVEL SECURITY;
                    CREATE POLICY fixture_wallet_policy ON club_wallets
                      FOR SELECT TO recovery_reader USING(chips<=10000);
                    REVOKE ALL ON FUNCTION total_chips() FROM PUBLIC;
                    GRANT EXECUTE ON FUNCTION total_chips() TO recovery_reader;
                    DO $$BEGIN
                      FOR i IN 1..1000 LOOP
                        EXECUTE format('CREATE FUNCTION fixture_f_%s(p bigint) RETURNS bigint LANGUAGE sql IMMUTABLE AS %L',i,'SELECT $1+1');
                      END LOOP;
                    END$$;
                """)
                archive = root / 'full.dump'
                candidate_dump = os.environ.get('NATIVE_DR_PG_DUMP', str(pg / 'pg_dump'))
                receipt = DRIVER.export(candidate_dump, env, archive, 'full', 60)
                self.assertFalse(receipt['restore_qualified'])
                env['PGDATABASE'] = 'restored_fixture'
                restore = [pg / 'pg_restore', '--exit-on-error', '--single-transaction',
                           '--dbname=restored_fixture', archive]
                run(restore)
                oracle = """SELECT jsonb_build_object(
                    'wallets',(SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM club_wallets w),
                    'hands',(SELECT jsonb_agg(to_jsonb(h) ORDER BY id) FROM hand_journal h),
                    'total',total_chips(),
                    'routine_count',(SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'fixture_f_%'),
                    'routine_hash',(SELECT md5(string_agg(pg_get_functiondef(oid),'' ORDER BY proname)) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'fixture_f_%'),
                    'table_acl',has_table_privilege('recovery_reader','club_wallets','SELECT'),
                    'function_acl',has_function_privilege('recovery_reader','total_chips()','EXECUTE'));
                """
                restored = run(psql, oracle)
                env['PGDATABASE'] = 'source_fixture'
                self.assertEqual(run(psql, oracle), restored)
                self.assertEqual(run(psql, 'SET ROLE recovery_reader; SELECT count(*) FROM club_wallets;'), 'SET\n2')
                env['PGDATABASE'] = 'restored_fixture'
                run(restore, success=False)
                self.assertEqual(run(psql, oracle), restored)
                self.assertEqual(run(psql, "INSERT INTO club_wallets(chips) VALUES(0.25) RETURNING id,cents;"),
                                 '4|25\nINSERT 0 1')
                run(psql, "INSERT INTO hand_journal VALUES(3,999,1);", success=False)
                self.assertEqual(run(psql, "SELECT inet_server_addr() IS NULL;"), 't')
            finally:
                if started:
                    run([pg / 'pg_ctl', '-D', data, '-m', 'immediate', '-w', 'stop'])


if __name__ == '__main__':
    unittest.main()
