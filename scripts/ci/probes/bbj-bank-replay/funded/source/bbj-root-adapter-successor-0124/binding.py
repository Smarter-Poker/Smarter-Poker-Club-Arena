"""Inert source/evidence binding. This module never opens a database or process."""
import hashlib
import importlib.util
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
CASES = ('SEQ08_BBJ_MAIN_POSITIVE_OPENING_SETUP',)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load(path):
    return json.loads(Path(path).read_text())


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def verify_seal(directory, expected_sha):
    seal_path = directory / 'INTEGRITY.json'
    require(digest(seal_path) == expected_sha, 'Wrong immutable packet seal: ' + str(directory))
    rows = load(seal_path)['files']
    require(bool(rows) and len({r['path'] for r in rows}) == len(rows), 'Empty/duplicate source seal')
    for row in rows:
        p = (directory / row['path']).resolve()
        require(p.is_relative_to(directory.resolve()), 'Seal path escaped packet')
        require(digest(p) == row['sha256'], 'Sealed input changed: ' + str(p))


def assert_complete_preflight(pf, fixture, registry_fixture, *, expected_database='fixture_base', require_empty=True):
    """Require the complete frozen identities, not just a convenient passed flag."""
    functions = load(fixture / 'FUNCTION-OVERLAY-INPUTS.json')
    tables = load(fixture / 'TABLE-OVERLAY-INPUTS.json')
    expected = {('function', f['schema'] + '.' + f['signature'].removeprefix(f['schema'] + '.'))
                for f in functions}
    expected |= {('table', t['schema'] + '.' + t['name']) for t in tables}
    comparisons = pf.get('comparisons', [])
    actual = {(k, row[k]) for row in comparisons for k in ('function', 'table') if k in row}
    require(pf.get('passed') is True and len(comparisons) == len(expected) == 327 and
            actual == expected and all('differences' in r and not r['differences'] for r in comparisons),
            'Complete 327-comparison native preflight is not proven')
    identity = pf.get('expression_identity', {})
    expected_identity = load(fixture / 'CONTEXT-AND-IDENTITY-INPUTS.json')
    # A multiset comparison retains repeated dependency edges if the catalog has any.
    canonical = lambda rows: sorted(json.dumps(r, sort_keys=True) for r in rows)
    require(identity.get('passed') is True and identity.get('context_matches') is True and
            identity.get('context', {}).get('search_path') == expected_identity['search_path'] and
            identity.get('context', {}).get('effective_path') == expected_identity['effective_path'] and
            identity.get('expected_count') == identity.get('actual_count') == 2957 and
            identity.get('missing') == [] and identity.get('extra') == [] and
            canonical(identity.get('actual_dependencies', [])) ==
            canonical(expected_identity['dependency_identities']),
            'Exact 2,957 expression dependencies are not proven')
    prereq = pf.get('prerequisites', {})
    records = {r['kind']: r['objects'] for r in load(fixture / 'NAMESPACE-AND-SEQUENCE-INPUTS.json')}
    expected_prereq = {('sequence', r['schema'] + '.' + r['name']) for r in records['sequences']}
    expected_prereq |= {('schema', r['name']) for r in records['schemas']}
    expected_prereq |= {('extension', r['name']) for r in records['extensions']}
    expected_prereq |= {('default_query_column', r['relation'] + '.' + r['name'])
                        for r in records['default_table_columns']}
    rows = prereq.get('comparisons', [])
    actual_prereq = {(k, r[k]) for r in rows
                    for k in ('sequence', 'schema', 'extension', 'default_query_column') if k in r}
    require(prereq.get('passed') is True and len(rows) == len(expected_prereq) and
            actual_prereq == expected_prereq and all('differences' in r and not r['differences'] for r in rows),
            'Complete native prerequisite metadata is not proven')
    boundary = pf.get('boundary', {})
    require(boundary.get('database') == expected_database and boundary.get('role') == 'postgres' and
            boundary.get('socket_only') is True and boundary.get('replication_role') == 'origin' and
            boundary.get('server_version', '').startswith('17.11') and
            all(type(boundary.get(k)) is int and boundary[k] >= 0 for k in ('users','clubs','legs','snapshots')) and
            (not require_empty or all(boundary[k] == 0 for k in ('users','clubs','legs','snapshots'))),
            'Expected socket-only PostgreSQL17.11 catalog boundary is not proven')

    assert_registry_preflight(pf, registry_fixture)


def assert_registry_preflight(pf, fixture):
    """Recheck saved actual values against the sealed0010 registry expectation."""
    expected = load(fixture / 'REGISTRY-EXPECTED.json')
    registry = pf.get('registry', {})
    rows = registry.get('comparisons', [])
    fields = set(expected['metadata']) | {'exact_historical_declaration_set','seed_relation_presence_only'}
    require(registry.get('passed') is True and len(rows) == len(fields) and
            all(type(r) is dict for r in rows) and {r.get('field') for r in rows} == fields,
            'Complete exact registry preflight is not proven')
    actual = {r['field']:r for r in rows}
    for key, value in {**expected['metadata'], 'exact_historical_declaration_set':expected['declarations']}.items():
        row = actual[key]
        require(row.get('matches') is True and 'actual' in row and row['actual'] == value and
                'expected' in row and row['expected'] == value,
                'Registry preflight differs from sealed metadata/configuration: ' + key)
    names = load(fixture / 'SEED-RELATION-DEPENDENCIES.json')['required_names']
    row = actual['seed_relation_presence_only']
    presence = row.get('actual')
    require(row.get('matches') is True and type(presence) is list and len(presence) == len(names) and
            all(type(r) is dict and set(r) == {'name','present'} for r in presence) and
            {r['name'] for r in presence} == set(names) and all(r['present'] is True for r in presence),
            'Bounded seed relation presence was not proven')


def assert_prior_disposals(run, identity_fixture):
    """Require actual JSON/OID/session/absence evidence, independent of money verdicts."""
    spec = importlib.util.spec_from_file_location('prior_disposal_oid', identity_fixture / 'oid_identity.py')
    identity = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(identity)
    rows = run.get('case_database_disposals', [])
    require(type(rows) is list and bool(rows) and all(type(r) is dict for r in rows),
            'No prior actual catalog/disposal proof')
    names = [r.get('case') for r in rows]
    require(len(names) == len(set(names)) and all(n in ('SEQ01','SEQ02','SEQ03','SEQ04','SEQ05') for n in names),
            'Unexpected or duplicate prior case disposal')
    confirmed_oid = False
    for row in rows:
        require(row.get('database') == row['case'].lower() and row.get('status') == 'ABSENT_PROVEN' and
                row.get('absent') is True, 'Prior serial disposal is not positively proven')
        before = row.get('before', {})
        require(set(before) == {'oid','sessions'} and type(before['sessions']) is int and before['sessions'] == 0,
                'Prior disposal zero-session catalog proof is absent')
        if before['oid'] is not None:
            # Preserve actual pg OID JSON text and use the exact accepted canonical parser.
            oid = row.get('observed_created_oid')
            actual_oid = identity.require_owned_database_identity(oid, before['oid'], before['sessions'])
            require(type(oid) is str and actual_oid == oid and
                    type(row.get('normalized_existing_oid')) is str and row['normalized_existing_oid'] == oid,
                    'Prior exact created/catalog/disposed OID differs')
            confirmed_oid = True
    require(confirmed_oid, 'Prior run has no successful actual created-OID disposal proof')


def verify_prior_fixture_preflight(authorization, fixture, schema_fixture, pins):
    fixture_sha = pins['fixture_integrity_sha256']
    proof = authorization.get('prior_fixture_preflight', {})
    values = {}
    for key in ('run', 'preflight', 'native_review'):
        row = proof.get(key, {})
        p = Path(row.get('path', '')).resolve()
        require(p.is_file() and digest(p) == row.get('sha256'), 'Missing/exact prior proof mismatch: ' + key)
        values[key] = (p, load(p))
    run_path, run = values['run']
    pf_path, pf = values['preflight']
    review_path, review = values['native_review']
    require(run_path.name == 'RUN.json' and pf_path.name == 'PREFLIGHT.json' and
            run_path.parent == pf_path.parent and run_path.parent.name == run.get('runid') and
            run_path.parent.parent == (fixture / 'execution-runs').resolve(),
            'Prior preflight must belong to an actual immutable selected fixture run')
    require(review.get('packet') == fixture.name and
            review.get('native_execution_authorized') is True and review.get('integrity_sha256') == fixture_sha and
            run.get('authorized_review_sha256') == digest(review_path),
            'Prior run is not bound to exact selected fixture native authorization')
    require(run.get('helper_choice') == 'original_current_capture' and run.get('no_remote_dsn') is True and
            run.get('current_capture_pg') == '17.6' and run.get('local_pg') == '17.11' and
            run.get('seed_sha256') == pins['seed_sha256'] and run.get('driver_sha256') == pins['driver_sha256'] and
            run.get('schema_fixture_integrity_sha256') == pins['schema_fixture_integrity_sha256'],
            'Prior run source/helper/version boundary differs')
    cleanup = run.get('cleanup', {})
    require(cleanup.get('inactive_proven') is True and cleanup.get('owned_directory_removed') is True,
            'Prior owned fixture cleanup is not proven')
    assert_complete_preflight(pf, schema_fixture, fixture)
    assert_prior_disposals(run, Path(pins['identity_fixture']))
    prior_cases = []
    for case in run.get('cases', []):
        case_path = (run_path.parent / case.get('evidence_file', '')).resolve()
        require(case_path.parent == run_path.parent and case_path.is_file() and
                digest(case_path) == case.get('sha256'), 'Prior case receipt is not intact')
        actual_case = load(case_path)
        require(actual_case.get('case') == case.get('case') and
                actual_case.get('status') == case.get('status'), 'Prior case summary differs from receipt')
        prior_cases.append({k: case[k] for k in
                            ('case', 'status', 'error_type', 'error', 'evidence_file', 'sha256') if k in case})
    # A genuine failure in original SEQ01-05 does not erase a complete setup pass.
    # It remains a failure, recorded here; no previous financial pass is inferred.
    return {'run': str(run_path), 'run_sha256': digest(run_path),
            'preflight_sha256': digest(pf_path), 'native_review_sha256': digest(review_path),
            'prior_run_status': run.get('status'), 'prior_case_statuses': prior_cases,
            'prior_catalog_disposals':run['case_database_disposals'],
            'qualification': 'Exact setup prerequisite only; no prior financial failure waived'}


def verify_binding(authorization, base_driver=None, case=None):
    pins = load(HERE / 'SOURCE-PINS.json')
    fixture = Path(pins['fixture']).resolve()
    resource_fixture = Path(pins['resource_fixture']).resolve()
    schema_fixture = Path(pins['schema_fixture']).resolve()
    require(authorization.get('packet') == HERE.name and
            authorization.get('native_execution_authorized') is True,
            'This source-only integration has no supplied native authorization')
    verify_seal(HERE, authorization.get('integrity_sha256'))
    # Independent source decision must bind both immutable authored packets.
    independent=authorization.get('independent_source_review', {})
    review_path=Path(independent.get('path', '')).resolve()
    require(review_path.is_file() and digest(review_path)==independent.get('sha256'),
            'Exact independent source review is required before native setup')
    decision=load(review_path)
    require(decision.get('accepted_for_isolated_native_execution') is True and
            decision.get('adapter_integrity_sha256')==authorization.get('integrity_sha256') and
            decision.get('author_integrity_sha256')==pins['author_integrity_sha256'],
            'Independent review does not accept these exact adapter and author seals')
    verify_seal(Path(pins['author_packet']), pins['author_integrity_sha256'])
    # The accepted case review is distinct from this adapter's future review.
    case_review=pins['case_source_review']
    source_decision=load(case_review['decision_path'])
    require(digest(case_review['seal_path'])==case_review['seal_sha256'] and
            digest(case_review['decision_path'])==case_review['decision_sha256'] and
            source_decision.get('verdict')=='ACCEPTED_FOR_ROOT_ADAPTER_COMPOSITION' and
            source_decision.get('source_review_complete') is True and
            source_decision.get('author_implementation_accepted') is True and
            source_decision.get('author_integrity_sha256')==pins['author_integrity_sha256'],
            'Exact independent BBJ case source acceptance is absent')

    require(authorization.get('fixture_integrity_sha256') == pins['fixture_integrity_sha256'] and
            authorization.get('driver_extension_sha256') == digest(HERE / 'case_module.py'),
            'Authorization does not bind exact fixture and extension')
    selected = authorization.get('case_ids')
    require(isinstance(selected, list) and bool(selected) and all(x in CASES for x in selected) and
            len(selected) == len(set(selected)), 'Explicit unique bounded case selection required')
    if case is not None:
        require(case in selected, 'This case was not selected in exact authorization')
    for row in pins['inputs']:
        require(digest(row['path']) == row['sha256'], 'Referenced source changed: ' + row['path'])
    verify_seal(fixture, pins['fixture_integrity_sha256'])
    verify_seal(Path(pins['identity_fixture']), pins['identity_fixture_integrity_sha256'])
    verify_seal(Path(pins['parser_fixture']), pins['parser_fixture_integrity_sha256'])
    verify_seal(schema_fixture, pins['schema_fixture_integrity_sha256'])
    verify_seal(resource_fixture, pins['resource_fixture_integrity_sha256'])
    for row in load(resource_fixture / 'FIXTURE-INPUTS.json')['external_inputs']:
        require(digest(row['path']) == row['sha256'], 'Resource inherited input changed: ' + row['path'])
    for row in load(fixture / 'FIXTURE-INPUTS.json')['external_inputs']:
        require(digest(row['path']) == row['sha256'], 'Fixture external input changed: ' + row['path'])
    for row in load(schema_fixture / 'FIXTURE-INPUTS.json')['external_inputs']:
        require(digest(row['path']) == row['sha256'], 'Schema inherited input changed: ' + row['path'])
    if base_driver is not None:
        require(Path(base_driver.__file__).resolve() == schema_fixture / 'sequence_driver.py' and
                digest(base_driver.__file__) == pins['driver_sha256'], 'Wrong actual base driver')
    prior = verify_prior_fixture_preflight(authorization, fixture, schema_fixture, pins)
    return fixture, resource_fixture, schema_fixture, selected, prior
