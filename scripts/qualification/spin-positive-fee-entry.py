"""Genuine paid entry in the existing finite Spin PostgreSQL allocation.

This module owns no process, cluster, schedule, payment writer or release.
It plans exact captured provider restores and checks the original evidence.
Entry, replay and fee capture do not certify play, completion or lost history.
"""
import hashlib
import json
from pathlib import Path
import posixpath
import re
import types

IMAGE = 'positive-fee-entry'
MODULE = 'scripts/qualification/spin-positive-fee-entry.py'
ORACLE = 'scripts/qualification/spin-positive-fee-entry-oracle.py'
FIXTURE = 'scripts/qualification/spin-mixed-positive-fee-entry.sql'
MANIFEST = 'scripts/qualification/spin-positive-fee-entry.hosted.manifest.json'
BASE = 'scripts/qualification/fixtures/spin-mixed-positive-fee/'
CURRENT = 'scripts/qualification/fixtures/spin-mixed-current/'
LEAVES = ('provider-supplement.sql', 'catalog-readback.sql', 'reference-data.sql',
          'expected-metadata.json', 'preimage-metadata.json', 'provenance.json')
INPUTS = (MODULE, ORACLE, FIXTURE, MANIFEST, *(BASE + n for n in LEAVES))


def require(value, message):
    if not value:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'duplicate paid-entry JSON key')
        result[key] = value
    return result


def decode(raw):
    def bad(value):
        raise ValueError('nonfinite paid-entry JSON: ' + value)
    return json.loads(raw, object_pairs_hook=unique, parse_constant=bad)


def validate_sources(files):
    require(set(INPUTS) <= set(files), 'paid-entry source inventory incomplete')
    manifest = decode(files[MANIFEST])
    require(manifest['schemaVersion'] == 1 and manifest['image'] == IMAGE
            and manifest['kind'] == 'genuine-positive-fee-entry'
            and all(manifest[k] is False for k in ('historical_qualification',
                'full_financial_qualification', 'production_qualification')),
            'paid-entry scope differs')
    require(set(manifest['files']) == set(INPUTS) - {MANIFEST},
            'paid-entry pinned inventory differs')
    for name, pin in manifest['files'].items():
        require(pin == {'bytes': len(files[name]), 'sha256': sha(files[name])},
                'paid-entry source pin differs: ' + name)
    graph = {}
    for name in INPUTS:
        if not name.endswith('.sql'):
            continue
        targets = []
        for line in files[name].decode().splitlines():
            if not line.lstrip().startswith('\\ir'):
                continue
            match = re.fullmatch(r'\\ir ([A-Za-z0-9_./-]+)', line.strip())
            require(match is not None, 'unsupported paid-entry include')
            target = posixpath.normpath(posixpath.join(posixpath.dirname(name), match[1]))
            require(not target.startswith('../') and target in files,
                    'paid-entry include escapes sealed inventory')
            targets.append(target)
        if targets:
            graph[name] = targets
    require(graph == manifest['relative_include_graph'], 'paid-entry include graph differs')


def sql_argv(PG, source, execution, ordinary, tournament, path):
    settings = ("DO $entry_context$ BEGIN PERFORM set_config('spin_mixed_qualification.execution_uuid','" + execution
                + "',false); PERFORM set_config('qualification.execution_uuid','" + execution
                + "',false); END $entry_context$;")
    return [str(PG / 'psql'), '-X', '-w', '-A', '-t', '-h', str(source.parent / 'work/socket'),
            '-p', '5432', '-U', 'postgres', '-d', 'qual_spin_expiry_' + execution.replace('-', ''),
            '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-v', 'execution_uuid=' + execution,
            '-v', 'ordinary_user_uuid=' + ordinary, '-v', 'tournament_uuid=' + tournament,
            '-c', settings, '-f', str(source / path)]


def body_plan(PG, source, execution, ordinary, tournament):
    specs = [('fee_current_catalog_restore', CURRENT + 'catalog-restore.sql'),
             ('fee_current_catalog_readback', CURRENT + 'catalog-readback.sql'),
             ('fee_current_recognition_restore', CURRENT + 'recognition-restore.sql'),
             ('fee_current_recognition_readback', CURRENT + 'recognition-readback.sql'),
             ('fee_provider_restore', BASE + 'provider-supplement.sql'),
             ('fee_provider_readback', BASE + 'catalog-readback.sql'),
             ('fee_actual_paid_entry', FIXTURE)]
    return [(name, sql_argv(PG, source, execution, ordinary, tournament, path))
            for name, path in specs]


def load_oracle(source):
    path = source / ORACLE
    module = types.ModuleType('spin_positive_fee_entry_oracle')
    module.__file__ = str(path)
    exec(compile(path.read_bytes(), str(path), 'exec'), module.__dict__)
    return module


def validate_outputs(source, work, execution, tournament):
    catalog_raw = (work / 'fee_provider_readback.stdout').read_bytes()
    values = [decode(line) for line in catalog_raw.splitlines() if line.lstrip().startswith(b'{')]
    catalog, = [v for v in values if v.get('stage') == 'positive_fee_catalog_readback']
    metadata = decode((source / BASE / 'expected-metadata.json').read_bytes())
    require(catalog['execution_uuid'] == execution
            and catalog['database'] == 'qual_spin_expiry_' + execution.replace('-', '')
            and catalog['relations'] == len(metadata['relations'])
            and catalog['function_authorities'] == len(metadata['functions'])
            and catalog['trigger_bindings'] == len(metadata['bindings'])
            and catalog['logical_catalog_exact'] is True
            and catalog['empty_business_estate'] is True
            and catalog['mtt_abi'] == 'legacy-capacity-v1'
            and all(catalog[k] is False for k in ('deployment_local_attnum_identity_compared',
                'mtt_activation_qualified', 'native_financial_qualification',
                'historical_qualification', 'production_qualification', 'full_qualification')),
            'current paid-entry provider not independently observed')
    original = (work / 'fee_actual_paid_entry.stdout').read_bytes()
    summary = load_oracle(source).validate_output(original, execution, tournament)
    return {'catalog': catalog, 'entry': summary,
            'catalog_stdout_sha256': sha(catalog_raw), 'entry_stdout_sha256': sha(original),
            'full_financial_qualification': False, 'historical_qualification': False,
            'production_qualification': False}


def validate_stages(receipt, PG, source, execution, ordinary, tournament):
    # Exact original allocator sequence: bootstrap schema/authority first,
    # seven nonsuperuser entry stages, then successful original cleanup. A
    # partial/subsequence receipt cannot stand in for the authentic provider.
    work = source.parent / 'work'
    data = work / 'data'
    db = 'qual_spin_expiry_' + execution.replace('-', '')
    bootstrap = [str(PG / 'psql'), '-X', '-w', '-h', str(work / 'socket'), '-p', '5432',
                 '-U', 'fixture_bootstrap', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1']
    endpoint_query = """SELECT jsonb_build_object(
  'user',current_user,'session_user',session_user,'port',current_setting('port'),
  'address',inet_server_addr(),'listen_addresses',current_setting('listen_addresses'),
  'autovacuum',current_setting('autovacuum'),
  'unix_socket_directories',current_setting('unix_socket_directories'));"""
    extension_query = "SELECT json_build_object('pgcrypto',EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='pgcrypto'),'uuid-ossp',EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='uuid-ossp'),'pg_trgm_1_6',EXISTS(SELECT 1 FROM pg_available_extension_versions WHERE name='pg_trgm' AND version='1.6'));"
    plan = [('pg_version', [str(PG / 'postgres'), '--version']),
            ('initdb', [str(PG / 'initdb'), '-D', str(data), '-U', 'fixture_bootstrap',
                        '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8']),
            ('pg_start', [str(PG / 'pg_ctl'), '-D', str(data), '-l', str(work / 'postgres.log'), '-w', '-t', '12', 'start']),
            ('server_endpoint_readback', bootstrap + ['-qAt', '-c', endpoint_query]),
            ('extension_availability', bootstrap + ['-qAt', '-c', extension_query]),
            ('create_sql_owner', bootstrap + ['-c', 'CREATE ROLE postgres NOSUPERUSER INHERIT LOGIN CREATEDB CREATEROLE REPLICATION BYPASSRLS']),
            ('create_database', [str(PG / 'createdb'), '-w', '-h', str(work / 'socket'), '-p', '5432',
                                 '-U', 'fixture_bootstrap', '-O', 'postgres', db])]
    baseline_sql = [('schema_prefix', work / 'schema-prefix.sql'),
                    ('restore_preexisting_principals', source / 'principals.sql'),
                    ('schema_suffix_all_real_triggers', work / 'schema-suffix.sql'),
                    ('authentic_access', source / 'inputs/access.sql'),
                    ('authentic_policies', source / 'inputs/policies.sql'),
                    ('current_notification_supplement', source / 'provider-supplement.sql'),
                    ('current_tested_roles', source / 'provider-roles.sql'),
                    ('tested_role_readback', source / 'provider-roles-check.sql'),
                    ('current_catalog_readback', source / 'provider-check.sql'),
                    ('empty_provider_readback', source / 'empty-provider-check.sql'),
                    ('authentic_spin_catalog_supplement', source / 'inputs/spin-catalog-supplement.sql'),
                    ('authentic_entry_provider_supplement', source / 'inputs/entry-provider-supplement.sql'),
                    ('authentic_entry_sequence_authority', source / 'inputs/entry-sequence-authority.sql'),
                    ('authentic_settlement_source_authority', source / 'inputs/settle-source-authority.sql'),
                    ('retention_provider_authority', source / 'scripts/qualification/fixtures/spin-history-retention/provider-supplement.sql')]
    for name, path in baseline_sql:
        argv = [str(PG / 'psql'), '-X', '-w', '-A', '-t', '-h', str(work / 'socket'),
                '-p', '5432', '-U', 'fixture_bootstrap', '-d', db,
                '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
                '-v', 'execution_uuid=' + execution, '-v', 'ordinary_user_uuid=' + ordinary,
                '-v', 'tournament_uuid=' + tournament, '-f', str(path)]
        plan.append((name, argv))
    plan += body_plan(PG, source, execution, ordinary, tournament)
    plan += [('pg_stop_fast', [str(PG / 'pg_ctl'), '-D', str(data), '-w', '-t', '10', '-m', 'fast', 'stop']),
             ('pg_stopped_readback', [str(PG / 'pg_ctl'), '-D', str(data), 'status'])]
    stages = receipt['stages']
    require(isinstance(stages, list) and all(isinstance(s, dict) for s in stages)
            and [s.get('stage') for s in stages] == [name for name, _ in plan],
            'complete original paid-entry allocation stage sequence differs')
    require(receipt.get('work_deadline_seconds') == 240 and receipt.get('cleanup_deadline_seconds') == 30
            and receipt.get('cleanup_verified') is True and receipt.get('cleanup_errors') == []
            and receipt.get('hosted_cleanup_observed') is True
            and receipt.get('original_clients_terminal') is True and receipt.get('source_stable') is True
            and not any(k in receipt for k in ('failure', 'fast_stop_failure', 'source_readback_error')),
            'paid-entry original budget, source or cleanup evidence differs')
    marker = b'CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user();'
    schema = (source / 'inputs/schema.sql').read_bytes()
    require(schema.count(marker) == 1, 'paid-entry authentic trigger boundary ambiguous')
    prefix, suffix = schema.split(marker)
    require(b'CREATE TRIGGER ' not in prefix and b'CREATE CONSTRAINT TRIGGER ' not in prefix
            and (work / 'schema-prefix.sql').read_bytes() == prefix
            and (work / 'schema-suffix.sql').read_bytes() == marker + suffix,
            'paid-entry executed schema split differs from sealed authentic input')
    for stage, (name, argv) in zip(stages, plan):
        code = 3 if name == 'pg_stopped_readback' else 0
        require(stage.get('argv') == argv and type(stage.get('returncode')) is int
                and stage['returncode'] == code and type(stage.get('terminal_returncode')) is int
                and stage['terminal_returncode'] == code and type(stage.get('pid')) is int
                and stage['pid'] > 0 and 'client_deadline_exceeded' not in stage,
                'paid-entry stage source, endpoint, role or result differs: ' + name)
        for stream in ('stdout', 'stderr'):
            pin = stage.get(stream + '_sha256')
            require(isinstance(pin, str) and re.fullmatch(r'[0-9a-f]{64}', pin) is not None
                    and sha((work / (name + '.' + stream)).read_bytes()) == pin,
                    'original paid-entry stream changed: ' + name + '.' + stream)
    require(receipt['positive_fee_entry_qualification'] == validate_outputs(
        source, source.parent / 'work', execution, tournament),
        'paid-entry summary differs from original evidence')
    return []
