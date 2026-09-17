#!/usr/bin/env python3
"""Finite PG17 qualification of three evidence-only components and native Spin CAS.

Only an owned temporary socket/cluster is used. This does not establish financial
banking, production installation, complete trigger routing or provider delivery.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import uuid

from build_pg17_isolationtester import OUTPUT as ISOLATION_OUTPUT, TOOL_LEAF, VERSION_NUM, validate_version

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = 'scripts/qualification/alert-evidence-hosted.manifest.json'
FIXED_INPUTS = ('scripts/ci/build_pg17_isolationtester.py',
 'scripts/ci/test-alert-evidence-postgres.py',
 'scripts/ci/test_alert_evidence_wrapper.py',
 'scripts/qualification/duplicate-structure-record-evidence.manifest.json',
 'scripts/qualification/duplicate-structure-record-evidence.md',
 'scripts/qualification/duplicate-structure-record-evidence.sql',
 'scripts/qualification/fixtures/duplicate-structure-record-evidence/original-40430.sql',
 'scripts/qualification/fixtures/duplicate-structure-record-evidence/preimage.sql',
 'scripts/qualification/fixtures/rake-repair-record-evidence/images.json',
 'scripts/qualification/fixtures/rake-repair-record-evidence/setup.sql',
 'scripts/qualification/fixtures/spin-repair-evidence/original-40497-40499.sql',
 'scripts/qualification/fixtures/spin-repair-evidence/original-bridge.sql',
 'scripts/qualification/fixtures/spin-repair-evidence/preimage.sql',
 'scripts/qualification/rake-repair-record-evidence.manifest.json',
 'scripts/qualification/rake-repair-record-evidence.md',
 'scripts/qualification/rake-repair-record-evidence.sql',
 'scripts/qualification/spin-repair-evidence-race.spec',
 'scripts/qualification/spin-repair-evidence.manifest.json',
 'scripts/qualification/spin-repair-evidence.md',
 'scripts/qualification/spin-repair-evidence.sql',
 'supabase/components/duplicate-structure-record-evidence.rollback.sql',
 'supabase/components/duplicate-structure-record-evidence.sql',
 'supabase/components/rake-repair-record-evidence-rollback.sql',
 'supabase/components/rake-repair-record-evidence.sql',
 'supabase/components/spin-repair-evidence.rollback.sql',
 'supabase/components/spin-repair-evidence.sql')
CASES = (
    ('duplicate', 'duplicate-structure-record-evidence.sql'),
    ('repair', 'rake-repair-record-evidence.sql'),
    ('spin', 'spin-repair-evidence.sql'),
)
PERMUTATION = ('claim_begin', 'claim_write', 'repair_call', 'claim_commit',
               'repair_call', 'repair_assert', 'restore_preimage')
ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C',
       'PYTHONDONTWRITEBYTECODE': '1', 'PGCONNECT_TIMEOUT': '5'}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def pin(data):
    return {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}


def validate_race_output(stdout, stderr):
    # isolationtester can print SQL errors and still exit zero; both channels
    # and actual native wait/completion order are required. No invented result.
    require(not re.search(r'(?mi)^(?:ERROR|FATAL|PANIC):|(?:setup|teardown) failed:|'
                          r'unexpected result status:|canceling step |timed out',
                          stdout + '\n' + stderr), 'native Spin race reported an error')
    matches = list(re.finditer(r'^step (\w+):', stdout, re.M))
    require(tuple(m.group(1) for m in matches) == PERMUTATION,
            'native Spin race step order differs')
    chunks = [stdout[m.end():matches[i + 1].start() if i + 1 < len(matches) else len(stdout)]
              for i, m in enumerate(matches)]
    require(chunks[2].count('<waiting ...>') == 1
            and chunks[4].lstrip().startswith('<... completed>')
            and stdout.count('<waiting ...>') == 1
            and stdout.count('<... completed>') == 1,
            'native blocked repair, claim commit and repair resumption were not observed')
    require('spin-repair-evidence-cas-race' in chunks[5], 'native final race witness absent')


def load_inputs():
    manifest = json.loads((ROOT / MANIFEST).read_text())
    require(manifest['schemaVersion'] == 1
            and set(manifest['files']) == set(FIXED_INPUTS), 'exact fixture inventory differs')
    for name, expected in manifest['files'].items():
        leaf = ROOT / name
        require(leaf.is_file() and not leaf.is_symlink() and pin(leaf.read_bytes()) == expected,
                'source hash differs: ' + name)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/production-alerts-evidence')
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    receipt = {'passed': False, 'scope': __doc__, 'steps': [], 'cleanup': {}, 'cases': []}
    pg = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin')).resolve()
    requested_isolation = os.environ.get('PG_ISOLATION_TESTER')
    isolation = (Path(requested_isolation).resolve() if requested_isolation else
                 ISOLATION_OUTPUT / TOOL_LEAF)
    cluster = None
    child = None
    old_handlers = {}
    failure = None

    def command(argv, name, *, data=None, env=None, timeout=60, expected=0):
        nonlocal child
        stdout_path, stderr_path = output / (name + '.stdout'), output / (name + '.stderr')
        try:
            with stdout_path.open('wb') as stdout, stderr_path.open('wb') as stderr:
                child = subprocess.Popen([str(x) for x in argv], stdin=subprocess.PIPE,
                                         stdout=stdout, stderr=stderr, env=env or ENV,
                                         cwd=ROOT, start_new_session=True)
                try:
                    child.communicate(None if data is None else data.encode(), timeout=timeout)
                except BaseException:
                    # A killed fixture client cannot leave a live owned DB query
                    # behind a passing receipt. Cluster cleanup remains mandatory.
                    if child.poll() is None:
                        child.kill()
                        child.wait(timeout=5)
                    raise
                code = child.returncode
        finally:
            child = None
        receipt['steps'].append({'name': name, 'exit': code, 'expectedExit': expected,
                                 'stdout': pin(stdout_path.read_bytes()),
                                 'stderr': pin(stderr_path.read_bytes())})
        require(stdout_path.stat().st_size + stderr_path.stat().st_size <= 524288,
                name + ': output exceeds reviewed bound')
        require(code == expected, name + ': unexpected exit ' + str(code))
        return stdout_path.read_text(), stderr_path.read_text()

    def interrupt(signum, _frame):
        raise RuntimeError('Interrupted by signal ' + str(signum))

    try:
        for sig in (signal.SIGTERM, signal.SIGINT):
            old_handlers[sig] = signal.signal(sig, interrupt)
        require(os.geteuid() != 0, 'Run with the existing hosted non-root worker identity')
        receipt['inputs'] = load_inputs()
        for binary in [pg / n for n in ('postgres', 'initdb', 'pg_ctl', 'psql')] + [isolation]:
            require(binary.is_file() and os.access(binary, os.X_OK),
                    'Required PG17 executable is missing: ' + str(binary))
        receipt['binaries'] = {str(b): pin(b.read_bytes()) for b in
                              [pg / n for n in ('postgres', 'initdb', 'pg_ctl', 'psql')] + [isolation]}
        for binary, name, option in [(pg / 'postgres', 'postgres-version', '--version'),
                                     (isolation, 'isolation-version', '-V')]:
            version, _ = command([binary, option], name)
            validate_version(version, name)
        command([sys.executable, '-m', 'unittest', 'discover', '-s', 'scripts/ci',
                 '-p', 'test_alert_evidence_wrapper.py'], 'wrapper-negative-controls')
        cluster = Path(tempfile.mkdtemp(prefix='alert-evidence-', dir='/tmp'))
        cluster.chmod(0o700)
        socket = cluster / 'socket'
        socket.mkdir(mode=0o700)
        data_path = cluster / 'data'
        receipt['cluster'] = str(cluster)
        command([pg / 'initdb', '-D', data_path, '-U', 'postgres', '--auth-local=trust',
                 '--auth-host=reject', '--no-locale', '--encoding=UTF8'], 'initdb')
        with (data_path / 'postgresql.conf').open('a') as conf:
            conf.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) +
                       "'\nunix_socket_permissions=0700\nport=5432\nshared_buffers='16MB'\n"
                       "max_connections=10\n")
        command([pg / 'pg_ctl', '-D', data_path, '-l', cluster / 'server.log',
                 '-w', '-t', '20', 'start'], 'start', timeout=25)

        def sql(database, statement, name, env=None):
            return command([pg / 'psql', '-X', '-w', '-qAt', '-v', 'ON_ERROR_STOP=1',
                            '-h', socket, '-p', '5432', '-U', 'postgres', '-d', database,
                            '-c', statement], name, env=env)[0]

        endpoint = json.loads(sql('postgres', "SELECT jsonb_build_object('address',inet_server_addr(),"
            "'listen',current_setting('listen_addresses'),'socket',current_setting('unix_socket_directories'),"
            "'user',current_user,'version',current_setting('server_version_num')::int);", 'endpoint'))
        require(endpoint['address'] is None and endpoint['listen'] == ''
                and endpoint['socket'] == str(socket) and endpoint['user'] == 'postgres'
                and endpoint['version'] == VERSION_NUM, 'owned endpoint or pinned PG17.11 version mismatch')
        sql('postgres', 'CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; '
                       'CREATE ROLE service_role NOLOGIN;', 'roles')
        for index, (prefix, entry) in enumerate((*CASES, ('spin', None))):
            identity = str(uuid.uuid4())
            database = 'qual_' + prefix + '_' + identity.replace('-', '')
            label = ('spin-native-race' if entry is None else prefix)
            child_env = dict(ENV, PGOPTIONS='-c qualification.execution_uuid=' + identity,
                             PG_TEST_TIMEOUT_DEFAULT='15')
            sql('postgres', 'CREATE DATABASE "' + database + '" TEMPLATE template0;', label + '-create')
            if entry is not None:
                command([pg / 'psql', '-X', '-w', '-qAt', '-v', 'ON_ERROR_STOP=1',
                         '-h', socket, '-p', '5432', '-U', 'postgres', '-d', database,
                         '-f', ROOT / 'scripts/qualification' / entry], label + '-qualification',
                        env=child_env)
                clean = sql(database, "SELECT NOT EXISTS (SELECT FROM pg_class WHERE "
                    "relnamespace='public'::regnamespace AND relkind IN ('r','p','v','m','f')) "
                    "AND NOT EXISTS (SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace);",
                    label + '-rollback-proof')
                require(clean.strip() == 't', label + ': fixture rollback incomplete')
            else:
                spec = (ROOT / 'scripts/qualification/spin-repair-evidence-race.spec').read_text()
                stdout, stderr = command([isolation, 'host=' + str(socket) +
                    ' port=5432 user=postgres dbname=' + database], label + '-qualification',
                    data=spec, env=child_env)
                validate_race_output(stdout, stderr)
                post = json.loads(sql(database, "SELECT jsonb_build_object("
                    "'target',md5(pg_get_functiondef('public.fn_spin_repair_missing_multiplier(integer)'::regprocedure)),"
                    "'bridge',md5(pg_get_functiondef('public.fn_ca_financial_alert_to_incident()'::regprocedure)),"
                    "'results',(SELECT jsonb_agg(result) FROM public.qualification_spin_race_results),"
                    "'multiplier',(SELECT spin_multiplier FROM public.tournaments),"
                    "'alerts',(SELECT count(*) FROM public.financial_alerts),"
                    "'reserve',(SELECT count(*) FROM public.spin_reserve_ledger));", label + '-readback'))
                require(post == {'target': '833c06b59dfdd8fd29b74cce0c6be6a2',
                    'bridge': '00a43ae03ab12cec9505e2bfed71d937',
                    'results': [{'ok': True, 'repaired': 0, 'unreconstructable': 0,
                    'paid_over_drawn_count': 0, 'repaired_outside_window': 0,
                    'lost_the_race': 1, 'lookback_mins': 60}],
                    'multiplier': 5, 'alerts': 0, 'reserve': 0}, 'native race postimage differs')
                receipt['race'] = post
            sessions = sql('postgres', "SELECT count(*) FROM pg_stat_activity WHERE datname='" +
                           database + "';", label + '-closed-connections')
            require(sessions.strip() == '0', 'fixture sessions remain open: ' + label)
            sql('postgres', 'DROP DATABASE "' + database + '";', label + '-drop')
            require(sql('postgres', "SELECT NOT EXISTS (SELECT FROM pg_database WHERE datname='" +
                        database + "');", label + '-absent').strip() == 't', 'database survived cleanup')
            receipt['cases'].append({'case': label, 'executionUuid': identity,
                                     'databaseRemoved': True, 'connectionsClosed': True})
        receipt['qualified'] = True
    except BaseException as error:
        failure = error
        receipt['failure'] = str(error)
    finally:
        # Keep the finite cleanup non-reentrant even if the workflow cancels again.
        for sig in old_handlers:
            signal.signal(sig, signal.SIG_IGN)
        try:
            if cluster is not None:
                data_path = cluster / 'data'
                if (data_path / 'postmaster.pid').exists():
                    command([pg / 'pg_ctl', '-D', data_path, '-m', 'fast', '-w', '-t', '15',
                             'stop'], 'cleanup-stop', timeout=20)
                require(not (data_path / 'postmaster.pid').exists(), 'postmaster identity remains')
                if (data_path / 'PG_VERSION').exists():
                    command([pg / 'pg_ctl', '-D', data_path, 'status'], 'cleanup-status', expected=3)
                require(not (cluster / 'socket/.s.PGSQL.5432').exists(), 'socket remains')
                if (cluster / 'server.log').exists():
                    shutil.copyfile(cluster / 'server.log', output / 'postgres.log')
                shutil.rmtree(cluster)
                receipt['cleanup'] = {'stopped': True, 'allocationRemoved': not cluster.exists()}
            else:
                receipt['cleanup'] = {'noClusterStarted': True}
        except BaseException as error:
            receipt['cleanup']['failure'] = str(error)
            failure = failure or error
        receipt['passed'] = failure is None and receipt.get('qualified') is True
        (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        for sig, handler in old_handlers.items():
            signal.signal(sig, handler)
    if failure is not None:
        raise RuntimeError('Alert evidence qualification failed; inspect ' + str(output)) from failure
    print('Evidence model and native Spin CAS qualified; production effects are not claimed.')


if __name__ == '__main__':
    main()
