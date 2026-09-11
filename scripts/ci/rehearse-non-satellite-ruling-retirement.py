#!/usr/bin/env python3
"""Prove ruling retirement on an owned, socket-only PostgreSQL 17 E2 fixture.

Reuses the exact D12 archive and guard migration, supplied by that preparation
package. Optional paths select only those SHA256-pinned local artifacts; this
runner accepts no database destination, credentials, or production connection.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'supabase/migrations/20260911204101_non_satellite_rulings_use_the_canonical_terminal_authority.sql'
ORIGINAL = ROOT / 'supabase/migrations/20260909171500_a_result_the_chronology_cannot_certify_is_settled_by_a_ruling.sql'
IDENTITY = 'public.fn_settle_tournament_places_by_ruling(uuid,text,text)'
EVENT = 'bee519fa-ff07-438c-9542-d386fc821908'
WINNER = '8327a08a-77e7-4f33-be45-e086a718c9e2'
REASON = 'Native local ruling retirement regression: preserve each existing financial record, exact paid contract and terminal receipt; completion must use the canonical authority without a legacy batch or a direct status transition.'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin', type=Path, default=Path('/opt/homebrew/opt/postgresql@17/bin'))
    parser.add_argument('--d12-archive', type=Path, default=ROOT / 'scripts/ci/fixtures/d12-tournament-guards-20260911.tar.gz')
    parser.add_argument('--d12-migration', type=Path, default=ROOT / 'supabase/migrations/20260911161539_restore_tournament_guards_with_canonical_terminal_receipts.sql')
    args = parser.parse_args()
    pg = args.pg_bin.resolve()
    assert subprocess.check_output([str(pg / 'postgres'), '--version'], text=True).startswith('postgres (PostgreSQL) 17.')
    assert sha(args.d12_archive) == '9824936824f888c607b26b02b334c50a0fdd5f53bcc7f27eb881802f4b22f4ef'
    assert sha(args.d12_migration) == '030afa6eb8db12ea18bf2cfc6175c40d8601dd3becc3816e978d0f1dbee73a3f'
    assert sha(ORIGINAL) == '43c88b2bf9465da37f7ea76fb2e92729aa3e6efd2a427a7582b4ee8baa8d1b97'
    candidate_hash = sha(MIGRATION)
    runner_hash = sha(Path(__file__))
    probe_hash = sha(ROOT / 'scripts/ci/probes/non-satellite-ruling-retirement.sql')
    cluster = Path(tempfile.mkdtemp(prefix='ca-e2-owned-', dir='/tmp'))
    runtime = cluster / 'ruling-retirement'
    runtime.mkdir()
    socket = cluster / 'socket'
    socket.mkdir(mode=0o700)
    with tarfile.open(args.d12_archive) as archive:
        for member in archive.getmembers():
            assert member.isfile() and Path(member.name).name == member.name
            (runtime / member.name).write_bytes(archive.extractfile(member).read())
    manifest = json.loads((runtime / 'fixture-manifest.json').read_text())
    for name, digest in manifest['sha256'].items():
        assert sha(runtime / name) == digest, name
    for path in runtime.glob('*.py'):
        path.write_text(path.read_text().replace('/opt/homebrew/opt/postgresql@17/bin', str(pg)))
    state = {'cluster': str(cluster), 'socket': str(socket), 'port': 55498, 'database': 'e2_bee519fa'}
    (runtime / 'cluster.json').write_text(json.dumps(state))
    env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
    env['PGTZ'] = 'UTC'
    psql = [str(pg / 'psql'), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', str(socket), '-p', '55498', '-U', 'postgres']
    db = psql + ['-d', state['database']]

    def run(command, name, *, allow_failure=False):
        result = subprocess.run(command, cwd=runtime, env=env, text=True, capture_output=True)
        (runtime / name).write_text(result.stdout + result.stderr)
        if result.returncode and not allow_failure:
            raise RuntimeError(name + ': ' + (result.stderr or result.stdout)[-3000:])
        return result

    def query(sql, name='query.log'):
        return json.loads(run(db + ['-Atc', sql], name).stdout)

    metadata_sql = "SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid=" + literal(IDENTITY) + '::regprocedure'
    definition_sql = "SELECT jsonb_build_object('definition',pg_get_functiondef(oid),'source',prosrc) FROM pg_proc WHERE oid=" + literal(IDENTITY) + '::regprocedure'
    started = False
    try:
        run([str(pg / 'initdb'), '-D', str(cluster / 'data'), '--no-locale', '-E', 'UTF8', '-U', 'postgres'], 'init.log')
        run([str(pg / 'pg_ctl'), '-D', str(cluster / 'data'), '-l', str(cluster / 'postgres.log'), '-o', "-h '' -k " + str(socket) + ' -p 55498', '-w', 'start'], 'start.log')
        started = True
        run(psql + ['-d', 'postgres', '-c', 'CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;'], 'roles.log')
        for name in ['load-local.py', 'verify-pins.py', 'seed-local.py']:
            run([sys.executable, str(runtime / name)], name + '.log')
        for name in ['entry-close-trigger-function.sql', 'lifecycle-tables.sql', 'lifecycle-functions.sql']:
            run(db + ['-f', str(runtime / name)], name + '.log')
        service = ['fn_settle_tournament_places(uuid,uuid)', 'trg_tournament_atomic_place_completion_guard()', 'fn_complete_tournament_terminal(uuid,uuid,text)', 'trg_freeze_batched_tournament_place()']
        acl = ''.join('REVOKE ALL ON FUNCTION public.' + name + ' FROM PUBLIC,anon,authenticated,service_role;' for name in service + ['fn_tournament_finish_readiness(uuid,uuid)'])
        acl += ''.join('GRANT EXECUTE ON FUNCTION public.' + name + ' TO service_role;' for name in service)
        run(db + ['-c', acl], 'observed-d12-acls.log')
        run(db + ['-f', str(args.d12_migration.resolve())], 'd12-migration.log')
        run(db + ['-f', str(ORIGINAL)], 'original-ruling.log')
        run(db + ['-f', str(ROOT / 'scripts/ci/probes/non-satellite-ruling-retirement.sql')], 'probe-helpers.log')
        metadata_before = query(metadata_sql)
        original = query(definition_sql)
        assert hashlib.md5(original['source'].encode()).hexdigest() == 'b5e3efd9216d9570b1101577a8788ad8'
        before_install = query('SELECT ruling_probe.application_state()')

        cases = [('cash', {}), ('null-markers', {'variant': None, 'tournament_type': None}),
                 ('bounty', {'is_bounty': True}), ('pko', {'is_pko': True}),
                 ('mystery', {'is_mystery_bounty': True}), ('spin', {'variant': 'spin'}),
                 ('satellite-variant', {'variant': 'satellite'}),
                 ('satellite-type', {'tournament_type': 'SATELLITE'}),
                 ('satellite-target-id', {'satellite_target_id': EVENT}),
                 ('satellite-target', {'satellite_target': EVENT})]

        def exercise(label, patch, stage):
            return query('SELECT ruling_probe.exercise(' + literal(EVENT) + '::uuid,' + literal(json.dumps(patch)) + '::jsonb,' + literal(REASON) + ')', stage + '-' + label + '.log')

        before_cases = {label: exercise(label, patch, 'before') for label, patch in cases}
        assert before_cases['cash']['result']['reason'] != 'non_satellite_ruling_retired'
        assert query('SELECT ruling_probe.application_state()') == before_install

        # A separate database cloned from this invocation's own fixture proves
        # the problematic COMPLETING path. Its hands use the same real native
        # elimination doors. The main E2 stays unfinished until after migration.
        run(psql + ['-d', 'postgres', '-c', 'CREATE DATABASE ruling_preimage TEMPLATE e2_bee519fa;'], 'clone-preimage.log')
        preimage_db = psql + ['-d', 'ruling_preimage']
        run(preimage_db + ['-f', str(runtime / 'future-finishes.sql')], 'preimage-future-finishes.log')
        completing_sql = 'SELECT ruling_probe.exercise(' + literal(EVENT) + '::uuid,' + literal('{"status":"COMPLETING"}') + '::jsonb,' + literal(REASON) + ')'
        completing_before = json.loads(run(preimage_db + ['-Atc', completing_sql], 'completing-preimage.log').stdout)
        assert completing_before['result']['reason'] == 'chronology_can_certify_this_result'
        assert not completing_before['unchanged']
        assert completing_before['result']['normalization']['repriced'] > 0
        def completing_satellites(stage):
            results = {}
            for label, patch in cases:
                if label.startswith('satellite-'):
                    sql = 'SELECT ruling_probe.exercise(' + literal(EVENT) + '::uuid,' + literal(json.dumps({**patch, 'status': 'COMPLETING'})) + '::jsonb,' + literal(REASON) + ')'
                    results[label] = json.loads(run(preimage_db + ['-Atc', sql], stage + '-completing-' + label + '.log').stdout)
            return results
        completing_satellites_before = completing_satellites('before')
        run(preimage_db + ['-f', str(MIGRATION)], 'preimage-candidate.log')
        completing_after = json.loads(run(preimage_db + ['-Atc', completing_sql], 'completing-after.log').stdout)
        assert completing_after['result']['reason'] == 'non_satellite_ruling_retired'
        assert completing_after['unchanged']
        completing_satellites_after = completing_satellites('after')
        assert completing_satellites_before == completing_satellites_after

        drift_cases = []
        mutations = [
            ('client-grant', 'GRANT EXECUTE ON FUNCTION ' + IDENTITY + ' TO authenticated;'),
            ('wrong-owner', 'ALTER FUNCTION ' + IDENTITY + ' OWNER TO service_role;'),
            ('search-path', 'ALTER FUNCTION ' + IDENTITY + ' SET search_path TO public;'),
            ('missing-service-grant', 'REVOKE EXECUTE ON FUNCTION ' + IDENTITY + ' FROM service_role;'),
            ('service-grant-option', 'GRANT EXECUTE ON FUNCTION ' + IDENTITY + ' TO service_role WITH GRANT OPTION;'),
            ('changed-body', original['definition'].replace(original['source'], original['source'] + '\n')),
        ]
        for label, mutation in mutations:
            result = run(db + ['-c', 'BEGIN;' + mutation, '-f', str(MIGRATION)], 'drift-' + label + '.log', allow_failure=True)
            assert result.returncode and 'non-satellite ruling retirement source or metadata differs' in result.stderr, label
            assert query(metadata_sql) == metadata_before
            assert query(definition_sql) == original
            assert query('SELECT ruling_probe.application_state()') == before_install
            drift_cases.append({'case': label, 'refused': True, 'rolledBack': True})

        run(db + ['-f', str(MIGRATION)], 'candidate.log')
        assert query(metadata_sql) == metadata_before
        assert query('SELECT ruling_probe.application_state()') == before_install
        installed = query(definition_sql)
        assert hashlib.md5(installed['source'].encode()).hexdigest() == '9cc595c1950af528220a77e295bddd19'
        after_cases = {label: exercise(label, patch, 'after') for label, patch in cases}
        for label, _ in cases:
            assert after_cases[label]['unchanged'] and before_cases[label]['unchanged'], label
            if label.startswith('satellite-'):
                assert after_cases[label] == before_cases[label], label
            else:
                assert after_cases[label]['result']['reason'] == 'non_satellite_ruling_retired', label
        assert query('SELECT ruling_probe.application_state()') == before_install
        run(db + ['-f', str(MIGRATION)], 'reapply.log')
        assert query(definition_sql) == installed and query(metadata_sql) == metadata_before

        roles = []
        for role in ['anon', 'authenticated', 'service_role']:
            result = run(db + ['-Atc', 'SET ROLE ' + role + ';SELECT ' + IDENTITY.split('(')[0] + '(' + literal(EVENT) + ',' + literal(REASON) + ');'], 'role-' + role + '.log', allow_failure=True)
            if role == 'service_role':
                assert not result.returncode and json.loads(result.stdout)['reason'] == 'non_satellite_ruling_retired'
            else:
                assert result.returncode and 'permission denied for function fn_settle_tournament_places_by_ruling' in result.stderr
            roles.append({'role': role, 'result': 'retired' if role == 'service_role' else 'permission denied'})

        run(db + ['-f', str(runtime / 'future-finishes.sql')], 'future-finishes.log')
        terminal = query('SELECT public.fn_complete_tournament_terminal(' + literal(EVENT) + ',' + literal(WINNER) + ",'places')", 'terminal.log')
        assert terminal['status'] == 'COMPLETED'
        run([sys.executable, str(runtime / 'verify-local.py')], 'verify-e2.log')
        run([sys.executable, str(runtime / 'verify-guard-poststate.py')], 'verify-guards.log')
        terminal_before = query('SELECT ruling_probe.application_state()')
        refusal = query('SELECT public.fn_settle_tournament_places_by_ruling(' + literal(EVENT) + ',' + literal(REASON) + ')')
        assert refusal['reason'] == 'non_satellite_ruling_retired'
        assert query('SELECT ruling_probe.application_state()') == terminal_before
        assert sha(MIGRATION) == candidate_hash
        assert sha(Path(__file__)) == runner_hash
        assert sha(ROOT / 'scripts/ci/probes/non-satellite-ruling-retirement.sql') == probe_hash
        receipt = {'status': 'passed', 'observedAt': datetime.now(timezone.utc).isoformat(),
                   'productionWrites': 0, 'migrationSha256': candidate_hash,
                   'runnerSha256': runner_hash, 'probeSha256': probe_hash,
                   'archiveSha256': sha(args.d12_archive), 'd12MigrationSha256': sha(args.d12_migration),
                   'originalBodyMd5': 'b5e3efd9216d9570b1101577a8788ad8', 'installedBodyMd5': '9cc595c1950af528220a77e295bddd19',
                   'metadataPreserved': True, 'migrationAndReapplicationChangeNoApplicationRows': True,
                   'beforeCases': before_cases, 'afterCases': after_cases, 'driftRefusals': drift_cases,
                   'completingPreimage': completing_before, 'completingAfter': completing_after,
                   'completingSatellitesBefore': completing_satellites_before,
                   'completingSatellitesAfter': completing_satellites_after,
                   'roles': roles, 'completedRulingRefusedWithoutChange': True,
                   'ordinaryE2': json.loads((runtime / 'verification-receipt.json').read_text()),
                   'guardPoststate': json.loads((runtime / 'guard-poststate-receipt.json').read_text()),
                   'runtime': str(runtime)}
        (runtime / 'ruling-retirement-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        print(json.dumps({'status': 'passed', 'receiptDirectory': str(runtime), 'migrationSha256': candidate_hash,
                          'cashRefusals': 6, 'satelliteEquivalenceCases': 8, 'metadataDriftRefusals': len(drift_cases),
                          'ordinaryE2Paid': '304.00', 'productionWrites': 0}))
    finally:
        if started:
            run([str(pg / 'pg_ctl'), '-D', str(cluster / 'data'), '-m', 'fast', '-w', 'stop'], 'stop.log')


if __name__ == '__main__':
    main()
