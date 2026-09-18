"""Finite original-witness regression on the actual retained financial catalog."""
from pathlib import Path
import argparse
import json
import signal
import sys

sys.dont_write_bytecode = True
from satellite_qualifier_fixture import module
from breakfast_fixture import compose, opening
from breakfast_qualification import (
    call, closure_sql, qualify_installer, qualify_refusals, refusal, state,
)
from breakfast_concurrency import qualify as qualify_concurrency
from breakfast_original_witness import build, retained, DATA, MIGRATION, sha

CLAIMS = "SELECT set_config('request.jwt.claims','{\"role\":\"service_role\"}',true);"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--pg-bin', type=Path, required=True)
    args = parser.parse_args()
    root, out = args.root.resolve(), args.evidence.resolve()
    out.mkdir(parents=True, exist_ok=False)
    if build(root) != (root / MIGRATION).read_text():
        raise ValueError('generated candidate differs')
    foundation, inputs = compose(root)
    (out / 'foundation.sql').write_text(foundation)
    (out / 'opening.sql').write_text(opening(root))
    paths = [
        root / MIGRATION,
        root / 'scripts/ci/breakfast_original_witness.py',
        root / 'scripts/ci/probes/breakfast-original-witness/authority.sql',
        root / 'scripts/ci/breakfast_qualification.py',
        root / 'scripts/ci/breakfast_concurrency.py',
        Path(__file__),
        *list((root / DATA).glob('*')),
    ]
    for path in paths:
        if path.is_file():
            inputs[str(path.relative_to(root))] = sha(path)
    native = module(root / 'scripts/ci/test-mtt-unlimited.py', 'breakfast_execution')
    binary = native.stock_isolationtester(args.pg_bin.resolve())
    e = native.Execution(root, out, args.pg_bin.resolve(), out, 600)
    e.report.update(source_sha256=inputs, scope='Original Breakfast witness only',
                    production_mutations=False)
    for sig in native.CANCELLATION_SIGNALS:
        signal.signal(sig, native.interrupted)
    completed = False
    try:
        e.start()
        baseline = e.database()
        e.sql(baseline, file=out / 'foundation.sql', label='current-financial-foundation', seconds=180)
        e.sql(baseline, file=out / 'opening.sql', label='retained-case-opening', seconds=60)
        before = state(e, baseline, 'opening-before')
        # A missing catalog object is not a reproduction of the original defect.
        rc, _, stderr = e.sql(baseline, 'BEGIN; ' + CLAIMS + " SELECT public.fn_complete_tournament_terminal('f370585d-40ea-4085-bb8f-c7e8c74f3fb4','ae0bc48d-f98c-4b25-a9fa-e3522f986173','places'); ROLLBACK;",
                              label='before-original-refusal', check=False)
        if rc != 3 or 'still has 2 live players' not in stderr:
            raise AssertionError('original refusal was not the demonstrated two-live-player defect')
        if before != state(e, baseline, 'opening-after-before-refusal'):
            raise AssertionError('failed original changed rows')
        e.report['before'] = {'passed': True, 'reason': 'still has 2 live players',
                              'all_public_auth_private_rows_unchanged': True}
        qualify_installer(e, baseline, root / MIGRATION)
        template = e.database(baseline)
        e.sql(template, file=root / MIGRATION, label='install-qualified-candidate', seconds=60)
        physical = json.loads((root / DATA / 'physical.json').read_text())['evidence']
        case = retained(root)
        expected = {key: case[key] for key in ['roster', 'entry', 'seats']}
        expected['manager'] = [
            {key: value for key, value in lease.items() if key not in ['heartbeat_at', 'acquired_at']}
            for lease in physical['manager']
        ]
        (out / 'expected.json').write_text(json.dumps(expected, indent=2) + '\n')
        qualify_refusals(e, template, expected)
        db = e.database(template)
        verify = closure_sql(root)
        sql = 'BEGIN; ' + CLAIMS + ' SELECT ' + call(expected) + ';\n' + verify + '\nCOMMIT;\n'
        (out / 'candidate-call.sql').write_text(sql)
        _, _, stderr = e.sql(db, file=out / 'candidate-call.sql', label='candidate-actual-closure')
        if 'BREAKFAST_FULL_CLOSURE_PASS' not in stderr:
            raise AssertionError('actual canonical closure witness absent')
        committed = state(e, db, 'committed-before-replay')
        # A second transaction after actual private commit proves durable replay.
        _, _, stderr = e.sql(db, file=out / 'candidate-call.sql', label='exact-committed-replay')
        if 'BREAKFAST_FULL_CLOSURE_PASS' not in stderr or committed != state(e, db, 'committed-after-replay'):
            raise AssertionError('exact committed replay changed data or lost proof')
        refusal(e, db, 'other-operation-after-commit',
                call(expected, 'b0000000-0000-4000-8000-000000000002'), 'BREAKFAST_REPLAY_MISMATCH')
        changed = json.loads(json.dumps(expected))
        changed['manager'] = []
        refusal(e, db, 'changed-input-after-commit', call(changed), 'BREAKFAST_REPLAY_MISMATCH')
        for label, mutation in [
            ('update', 'UPDATE smarter_private.breakfast_original_witness SET admitted_at=clock_timestamp()'),
            ('delete', 'DELETE FROM smarter_private.breakfast_original_witness'),
            ('truncate', 'TRUNCATE smarter_private.breakfast_original_witness'),
        ]:
            refusal(e, db, 'immutable-witness-' + label,
                    'pg_temp.breakfast_mutate()', 'BREAKFAST_ORIGINAL_WITNESS_IMMUTABLE',
                    'CREATE FUNCTION pg_temp.breakfast_mutate() RETURNS void LANGUAGE plpgsql AS $mutation$ BEGIN ' + mutation + '; END $mutation$;')
        e.sql(db, "DO $acl$ DECLARE role_name text; BEGIN FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP IF has_table_privilege(role_name,'smarter_private.breakfast_original_witness','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') OR has_function_privilege(role_name,'smarter_private.breakfast_standings_witness(uuid,uuid)','EXECUTE') THEN RAISE EXCEPTION 'BREAKFAST_PRIVATE_AUTHORITY_EXPOSED'; END IF; END LOOP; IF has_function_privilege('anon','public.fn_complete_breakfast_original_witness(uuid,jsonb)','EXECUTE') OR has_function_privilege('authenticated','public.fn_complete_breakfast_original_witness(uuid,jsonb)','EXECUTE') OR NOT has_function_privilege('service_role','public.fn_complete_breakfast_original_witness(uuid,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'BREAKFAST_PUBLIC_AUTHORITY_ACL_CHANGED'; END IF; END $acl$;",
              label='actual-installed-permissions')
        e.report['closure'] = {'passed': True, 'committed_in_private_database': True,
                               'exact_replay_unchanged': True, 'actual_permissions_checked': True}
        e.discard(db)
        qualify_concurrency(e, template, expected, binary, verify)
        if len(e.report['native']) != 27 or len(e.report['migration_refusals']) != 3 or len(e.report['races']) != 3:
            raise AssertionError('required native cases are incomplete')
        changed_inputs = [path for path, digest in inputs.items() if sha(root / path) != digest]
        if changed_inputs:
            raise AssertionError('qualified input changed during run: ' + ', '.join(changed_inputs))
        e.report['source_hashes_stable'] = True
        completed = True
    except BaseException as error:
        e.report['error'] = str(error)
        raise
    finally:
        try:
            e.close()
            if completed and e.report['cleanup'] == {'stopped': True, 'removed': True}:
                e.report['status'] = 'passed'
        finally:
            (out / 'RESULTS.json').write_text(json.dumps(e.report, indent=2) + '\n')
    return 0 if e.report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
