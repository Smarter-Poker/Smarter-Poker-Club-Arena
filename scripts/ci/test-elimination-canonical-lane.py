"""Qualify the complete ordinary elimination against the real PG17 money fixture."""
from pathlib import Path
import argparse
import datetime
import hashlib
import json
import re
import signal
import sys
from collections import Counter

sys.dont_write_bytecode = True
from satellite_qualifier_fixture import module, sha, function_sql

MIGRATION = 'supabase/migrations/20260927165023_ordinary_eliminations_acquire_their_canonical_lane_before_ro.sql'
CAPTURE = 'scripts/ci/fixtures/elimination-canonical-lane/current-authorities-20260927.json'
HAND = 'scripts/ci/fixtures/elimination-canonical-lane/current-hand-lane.json'
PROBE = 'scripts/ci/probes/elimination-canonical-lane.sql'
SPEC = 'scripts/ci/probes/elimination-canonical-lane.spec'


def lit(value):
    return "'" + value.replace("'", "''") + "'"


def identity(row):
    return row['identity'] if '.' in row['identity'].split('(')[0] else 'public.' + row['identity']


def current_authorities(root):
    rows = json.loads((root / CAPTURE).read_text())['rows']
    if len(rows) != 5:
        raise ValueError('exact five installed authorities required')
    commands = ['BEGIN;']
    hand = json.loads((root / HAND).read_text())['rows'][0]
    if hand['definition_md5'] != '409b14ee72ce888d3b26524c52d49a68' or hashlib.md5(hand['definition'].encode()).hexdigest() != hand['definition_md5']:
        raise ValueError('actual accepted hand lane capture changed')
    commands += [hand['definition'].rstrip() + ';',
        'REVOKE ALL ON FUNCTION public.fn_ca_share_settlement_lane_for_table(uuid) FROM PUBLIC,anon,authenticated;',
        'GRANT EXECUTE ON FUNCTION public.fn_ca_share_settlement_lane_for_table(uuid) TO service_role;']
    rows += [hand]
    for row in rows:
        definition = row['definition']
        if hashlib.md5(definition.encode()).hexdigest() != row['definition_md5']:
            raise ValueError('captured definition differs')
        name = identity(row)
        # The maintained full movement fixture carries the previous source
        # guard. Compose only its actual installed successor, never a stub.
        if name == 'smarter_private.f06_source_guard()':
            commands.append(definition.rstrip().rstrip(';') + ';')
        commands.append("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=" + lit(name) + "::regprocedure AND md5(pg_get_functiondef(p.oid))=" + lit(row['definition_md5']) + " AND md5(p.prosrc)=" + lit(row['source_md5']) + " AND p.proacl::text=" + lit(row['acl']) + " AND pg_get_userbyid(p.proowner)=" + lit(row['owner']) + " AND to_jsonb(p.proconfig)=" + lit(json.dumps(row['proconfig'])) + "::jsonb) THEN RAISE EXCEPTION 'installed elimination authority differs: %'," + lit(name) + "; END IF; END $$;")
    return '\n'.join(commands + ['COMMIT;'])


def validate_hand_race(code, stdout, stderr, baseline, release):
    expected_names = ['a_begin', 'a_hand', 'b_claim']
    notices = ['LANE_BASELINE_REFUSED'] if baseline else ['LANE_WAIT_PROVEN']
    if not baseline:
        expected_names += ['observed_wait']
    expected_names += ['a_row_available', 'a_' + release]
    if not baseline:
        expected_names += ['b_claim', 'duplicate', 'final_state']
        notices += ['LANE_ROW_AVAILABLE', 'LANE_CLAIM_PROVEN', 'LANE_DUPLICATE_PROVEN', 'LANE_EFFECTS_PROVEN']
    else:
        expected_names += ['baseline_state']
        notices += ['LANE_ROW_AVAILABLE', 'LANE_BASELINE_ROLLBACK_PROVEN']
    actual_notices = re.findall(r'^(?:[a-z_]+: )?NOTICE:\s*(LANE_[A-Z_]+)\s*$', stdout, re.M)
    permutations = re.findall(r'^starting permutation: (.*)$', stdout, re.M)
    steps = Counter(re.findall(r'^step ([a-z_]+):', stdout, re.M))
    expected_permutation = [n for n in expected_names if n != 'b_claim']
    expected_permutation.insert(2, 'b_claim')
    if (code or stderr.strip() or re.search(r'^(?:[a-z_]+: )?(?:ERROR|FATAL|PANIC|WARNING):', stdout, re.M)
        or actual_notices != notices or steps != Counter(expected_names)
        or permutations != [' '.join(expected_permutation)]
        or stdout.count('Parsed test spec with 3 sessions') != 1
        or stdout.count('<waiting ...>') != (0 if baseline else 1)
        or stdout.count('<... completed>') != (0 if baseline else 1)):
        raise RuntimeError('exact accepted-hand/elimination concurrency evidence differs')
    return {'baseline_refusal': baseline, 'actual_advisory_wait': not baseline,
            'holder_row_lock_available': True, 'release': release, 'exact_effects': True}


def hand_races(e, root, native, db, baseline):
    binary = native.stock_isolationtester(e.pg)
    e.report['isolationtester'] = {'path': str(binary), 'sha256': sha(binary)}
    template = (root / SPEC).read_text()
    for release in ('commit', 'rollback'):
        case = e.database(db)
        rendered = template.replace('BASELINE_BOOL', 'true' if baseline else 'false')
        unused = ['a_rollback' if release == 'commit' else 'a_commit']
        unused += ['observed_wait', 'duplicate', 'final_state'] if baseline else ['baseline_state']
        for step in unused:
            rendered = re.sub(r'^step "' + step + r'" \{.*?^\}\n', '', rendered, flags=re.M | re.S)
        names = ['a_begin', 'a_hand', 'b_claim'] + ([] if baseline else ['observed_wait'])
        names += ['a_row_available', 'a_' + release]
        names += ['baseline_state'] if baseline else ['duplicate', 'final_state']
        rendered += '\npermutation ' + ' '.join('"' + n + '"' for n in names) + '\n'
        label = ('baseline-' if baseline else 'candidate-') + 'hand-' + release
        (e.output / (label + '.spec')).write_text(rendered)
        code, stdout, stderr = e.run(label, [binary, f'host={e.socket} port={e.port} dbname={case} user=postgres'], text=rendered, seconds=40, check=False)
        proof = validate_hand_race(code, stdout, stderr, baseline, release)
        e.discard(case)
        e.report['races'].append({'case': label, **proof, 'database_removed': True})


def probe(e, db, path, label, fixture, marker):
    before = e.snapshot(db, label + '-before-data')
    catalog = e.catalog_snapshot(db, label + '-before-catalog')
    private = fixture.private_snapshot(e, db, label + '-before-private')
    code, stdout, stderr = e.sql(db, file=path, label=label, seconds=120, check=False)
    if code or any(v in stderr for v in ['ERROR:', 'FATAL:', 'PANIC:', 'WARNING:']) or stdout.splitlines().count(marker) != 1 or stderr.count('ELIMINATION PASS:') != 98:
        raise RuntimeError(label + ': exact 98 complete transaction assertions required')
    if e.snapshot(db, label + '-after-data') != before or e.catalog_snapshot(db, label + '-after-catalog') != catalog or fixture.private_snapshot(e, db, label + '-after-private') != private:
        raise RuntimeError(label + ': complete rollback failed')
    e.report['native'].append({'case': label, 'assertions': 98, 'data_catalog_private_rollback': True})


def refusals(e, db, root, fixture):
    cases = [
        ('body', "DO $$ DECLARE d text; BEGIN SELECT pg_get_functiondef('public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)'::regprocedure) INTO d; EXECUTE replace(d,'DECLARE',E'DECLARE\\n-- isolated drift'); END $$;", 'SOURCE'),
        ('acl', 'GRANT EXECUTE ON FUNCTION public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric) TO authenticated;', 'AUTHORITY'),
        ('trigger', 'ALTER TABLE public.tournament_players DISABLE TRIGGER a00_f06_source_roster;', 'TRIGGER'),
        ('lane', 'ALTER FUNCTION public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid) RESET ALL;', 'SOURCE'),
    ]
    for name, mutation, error in cases:
        case = e.database(db)
        e.sql(case, mutation, label='inject-' + name)
        before = e.snapshot(case, name + '-before-data')
        cat = e.catalog_snapshot(case, name + '-before-catalog')
        private = fixture.private_snapshot(e, case, name + '-before-private')
        code, stdout, stderr = e.sql(case, file=root / MIGRATION, label='refuse-' + name, check=False)
        if code != 3 or 'ELIMINATION_LANE_' + error + '_DRIFT' not in stderr:
            raise RuntimeError('migration drift not refused: ' + name + stdout + stderr)
        if before != e.snapshot(case, name + '-after-data') or cat != e.catalog_snapshot(case, name + '-after-catalog') or private != fixture.private_snapshot(e, case, name + '-after-private'):
            raise RuntimeError('failed installation changed state: ' + name)
        e.discard(case)
        e.report['migration_refusals'].append({'kind': name, 'complete_rollback': True})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--pg-bin', type=Path, required=True)
    args = parser.parse_args()
    root, out = args.root.resolve(), args.evidence.resolve()
    out.mkdir(exist_ok=False, parents=True)
    if sha(Path(__file__)) != sha(root / 'scripts/ci/test-elimination-canonical-lane.py'):
        raise ValueError('executed qualifier differs from bound source')
    fixture = module(root / 'scripts/ci/test-f06-accepted-elimination.py', 'lane_accepted_fixture')
    movement = module(root / 'scripts/ci/test-f06-movement-admission.py', 'lane_movement_fixture')
    manifest = fixture.prepare(root, out)
    paths = [MIGRATION, CAPTURE, HAND, PROBE, SPEC, 'scripts/ci/test-elimination-canonical-lane.py', 'scripts/ci/test-f06-movement-admission.py']
    paths += [getattr(movement, k) for k in ['MIGRATION', 'RECEIPT', 'AUTHORITIES', 'PUBLIC_F06', 'DEPENDENCY_CATALOG', 'DEPENDENCY_FUNCTIONS', 'FINAL_RELATIONS', 'PRIVATE', 'CONTROL', 'CONTINUATION']]
    manifest['source_sha256'].update({p: sha(root / p) for p in paths})
    (out / 'movement-catalog.sql').write_text(movement.movement_catalog(root))
    (out / 'installed-authorities.sql').write_text(current_authorities(root))
    (out / 'source-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    native = module(root / 'scripts/ci/test-mtt-unlimited.py', 'lane_execution')
    e = native.Execution(root, out, args.pg_bin.resolve(), out, 600)
    e.report.update(source_sha256=manifest['source_sha256'], fixture_identity='complete-ordinary-elimination-before-canonical-row-locks')
    for sig in native.CANCELLATION_SIGNALS:
        signal.signal(sig, native.interrupted)
    try:
        e.start()
        db = e.database()
        e.sql(db, file=out / 'foundation.sql', label='real-financial-foundation', seconds=180)
        e.sql(db, file=out / 'current-authorities.sql', label='retained-elimination-authorities')
        e.sql(db, file=out / 'movement-catalog.sql', label='actual-movement-catalog')
        captured = json.loads((root / 'scripts/ci/fixtures/satellite-qualifiers/current-money-ddl-guard-20260917.json').read_text())
        for row in captured['functions']:
            e.sql(db, function_sql(row), label='actual-money-ddl-guard')
        e.sql(db, "CREATE EVENT TRIGGER ab_ca_money_rpc_registered ON ddl_command_end WHEN TAG IN ('CREATE FUNCTION') EXECUTE FUNCTION public.fn_ca_money_rpc_registry_guard();", label='actual-money-ddl-event')
        e.sql(db, file=root / 'scripts/ci/probes/atomic-terminal-rehearsal-fixture.sql', label='structural-opening')
        e.sql(db, file=out / 'opening.sql', label='accepted-hand-opening')
        e.sql(db, file=root / fixture.MIGRATION, label='retained-elimination-install')
        probe(e, db, root / fixture.PROBE, 'historical-complete-financial-path', fixture, 'F06_ACCEPTED_ELIMINATION_PASS')
        e.sql(db, file=root / movement.MIGRATION, label='actual-movement-install')
        e.sql(db, file=out / 'installed-authorities.sql', label='exact-installed-current-authorities')
        hand_races(e, root, native, db, True)
        refusals(e, db, root, fixture)
        before = e.snapshot(db, 'before-candidate-data')
        private = fixture.private_snapshot(e, db, 'before-candidate-private')
        e.sql(db, file=root / MIGRATION, label='candidate-install')
        if before != e.snapshot(db, 'after-candidate-data') or private != fixture.private_snapshot(e, db, 'after-candidate-private'):
            raise RuntimeError('source-only migration changed data or private authority')
        probe(e, db, root / PROBE, 'current-complete-financial-path', fixture, 'CURRENT_ELIMINATION_LANE_PASS')
        hand_races(e, root, native, db, False)
        fixture.qualify_races(e, root, native, db)
        for path, digest in manifest['source_sha256'].items():
            if sha(root / path) != digest:
                raise RuntimeError('qualification input changed: ' + path)
        e.report.update(status='passed', failure=None)
        e.discard(db)
    except BaseException as exc:
        e.report['failure'] = repr(exc)
    finally:
        for sig in native.CANCELLATION_SIGNALS:
            signal.signal(sig, signal.SIG_IGN)
        try:
            e.close()
        except BaseException as exc:
            e.report.update(cleanup_failure=repr(exc), status='failed')
        e.report['ended_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (out / 'result.json').write_text(json.dumps(e.report, indent=2) + '\n')
        print(json.dumps({key: e.report.get(key) for key in ['status', 'failure', 'native', 'races', 'cleanup']}), flush=True)
    return 0 if e.report['status'] == 'passed' else 1


if __name__ == '__main__':
    sys.exit(main())
