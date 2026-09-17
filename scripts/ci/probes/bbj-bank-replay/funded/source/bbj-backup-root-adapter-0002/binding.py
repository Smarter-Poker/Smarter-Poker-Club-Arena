"""Pure exact-source authorization. No process/database operations on import."""
import hashlib
import importlib.util
import json
import sys
from pathlib import Path
from uuid import UUID
sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
CASE = 'SEQ08_BBJ_BACKUP_POSITIVE_MAIN_TRANSFER_25'


def require(value, message):
    if not value:
        raise RuntimeError(message)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load(path):
    return json.loads(Path(path).read_text())


def verify_seal(directory, expected, filename='INTEGRITY.json'):
    directory = Path(directory).resolve()
    require(type(expected) is str and len(expected) == 64, 'Exact seal required')
    require(digest(directory / filename) == expected, 'Packet seal differs: ' + str(directory))
    rows = load(directory / filename)['files']
    rows = list(rows.items()) if isinstance(rows, dict) else [(r['path'], r['sha256']) for r in rows]
    require(bool(rows) and len({x[0] for x in rows}) == len(rows), 'Empty/duplicate seal')
    for name, value in rows:
        path = (directory / name).resolve()
        require(path.is_relative_to(directory) and digest(path) == value, 'Member differs: ' + str(path))


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def parent_binding():
    pins = load(HERE / 'SOURCE-PINS.json')
    return module('accepted_bbj0124_binding', Path(pins['opening_adapter']) / 'binding.py')


def assert_complete_preflight(*args, **kwargs):
    return parent_binding().assert_complete_preflight(*args, **kwargs)


def independent_decision(row):
    path = Path(row.get('path', '')).resolve()
    require(path.is_file() and digest(path) == row.get('sha256'), 'Exact independent decision required')
    value = load(path)
    require(type(value) is dict, 'Decision must be a JSON object')
    return value


def validate_root_decision(decision, authorization, pins):
    require(decision.get('accepted_for_isolated_native_execution') is True and
            decision.get('source_review_complete') is True and
            decision.get('adapter_integrity_sha256') == authorization.get('integrity_sha256') and
            decision.get('author_integrity_sha256') == pins['backup_integrity_sha256'] and
            decision.get('opening_adapter_integrity_sha256') == pins['opening_adapter_integrity_sha256'] and
            decision.get('supplemental_integrity_sha256') == pins['supplemental_integrity_sha256'] and
            decision.get('supplemental_source_accepted') is True,
            'Independent review must accept exact complete adapter, opening and supplemental composition')


def verify_binding(authorization, base_driver=None, case=None):
    pins = load(HERE / 'SOURCE-PINS.json')
    require(type(authorization) is dict and authorization.get('packet') == HERE.name and
            authorization.get('native_execution_authorized') is True,
            'This inert adapter requires a separate root native authorization')
    verify_seal(HERE, authorization.get('integrity_sha256'))
    validate_root_decision(independent_decision(authorization.get('independent_source_review', {})), authorization, pins)
    require(authorization.get('case_ids') == [CASE] and (case is None or case == CASE), 'Exact single backup continuation required')
    require(authorization.get('fixture_integrity_sha256') == pins['fixture_integrity_sha256'] and
            authorization.get('driver_extension_sha256') == digest(HERE / 'case_module.py'), 'Exact fixture and adapter bindings required')
    require(str(UUID(authorization.get('opening_operation_id', ''))) == authorization['opening_operation_id'], 'Canonical fresh opening operation required')
    operation = authorization.get('move_operation')
    reason = authorization.get('move_reason')
    require(type(operation) is str and 0 < len(operation.strip()) <= 200 and '\x00' not in operation and operation != authorization['opening_operation_id'], 'Distinct bounded move operation required')
    require(type(reason) is str and 10 <= len(reason.strip(' ')) <= 500 and '\x00' not in reason, 'Bounded move reason required')
    for row in pins['inputs']:
        require(digest(row['path']) == row['sha256'], 'Pinned input changed: ' + row['path'])
    for key in ('fixture', 'resource_fixture', 'schema_fixture', 'identity_fixture', 'parser_fixture', 'opening_adapter', 'author_packet', 'backup_packet', 'supplemental_packet'):
        sha_key = {'backup_packet': 'backup_integrity_sha256', 'supplemental_packet': 'supplemental_integrity_sha256', 'author_packet': 'author_integrity_sha256'}.get(key, key + '_integrity_sha256')
        verify_seal(Path(pins[key]), pins[sha_key])
    for key in ('fixture', 'resource_fixture', 'schema_fixture'):
        for row in load(Path(pins[key]) / 'FIXTURE-INPUTS.json')['external_inputs']:
            require(digest(row['path']) == row['sha256'], 'Inherited source changed: ' + row['path'])
    review = pins['backup_source_review']
    verify_seal(Path(review['directory']), review['integrity_sha256'])
    decision = independent_decision(review['decision'])
    require(decision.get('verdict') == 'ACCEPTED_SOURCE_CASE_FOR_ROOT_ADAPTER_COMPOSITION' and
            decision.get('source_review_complete') is True and decision.get('author_source_case_accepted') is True and
            decision.get('author_integrity_sha256') == pins['backup_integrity_sha256'], 'Accepted backup case decision differs')
    opening = independent_decision(pins['case_source_review']['decision'])
    require(opening.get('verdict') == 'ACCEPTED_FOR_ROOT_ADAPTER_COMPOSITION' and
            opening.get('source_review_complete') is True and opening.get('author_implementation_accepted') is True and
            opening.get('author_integrity_sha256') == pins['author_integrity_sha256'], 'Accepted original0123 case decision differs')
    prior_adapter = independent_decision(pins['opening_adapter_review'])
    require(prior_adapter.get('accepted_for_isolated_native_execution') is True and
            prior_adapter.get('adapter_integrity_sha256') == pins['opening_adapter_integrity_sha256'] and
            prior_adapter.get('author_integrity_sha256') == pins['author_integrity_sha256'], 'Accepted original0124 adapter differs')
    schema = Path(pins['schema_fixture'])
    if base_driver is not None:
        require(Path(base_driver.__file__).resolve() == schema / 'sequence_driver.py' and digest(base_driver.__file__) == pins['driver_sha256'], 'Original exact driver required')
    prior = parent_binding().verify_prior_fixture_preflight(authorization, Path(pins['fixture']), schema, pins)
    return Path(pins['fixture']), Path(pins['resource_fixture']), schema, [CASE], prior
