"""Inert composition: original genuine opening100, then accepted backup25 once."""
import importlib.util
import json
import sys
from pathlib import Path
from binding import CASE, digest, load, require, verify_binding
sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
SELECTED = (CASE,)
_PARENT = None

PHYSICAL_SQL = """SELECT jsonb_build_object(
'database',current_database(),'database_oid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),
'system_identifier',(SELECT system_identifier::text FROM pg_control_system()),
'data_directory',current_setting('data_directory'),'socket_directory',current_setting('unix_socket_directories'),
'role',current_user,'session_role',session_user,'socket',inet_server_addr() IS NULL,
'replication',current_setting('session_replication_role'),'server_version',current_setting('server_version'),
'pid',pg_backend_pid(),'backend_start',(SELECT backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()))"""


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def parent_modules():
    """Load immutable accepted siblings with their own import bindings, then restore ours."""
    global _PARENT
    if _PARENT is not None:
        return _PARENT
    path = Path(load(HERE / 'SOURCE-PINS.json')['opening_adapter'])
    names = ('binding', 'catalog_queries', 'normalization')
    previous = {name: sys.modules.get(name) for name in names}
    installed = {}
    try:
        for name in names:
            installed[name] = module('accepted0124_' + name, path / (name + '.py'))
            sys.modules[name] = installed[name]
        adapter = module('accepted0124_case', path / 'case_module.py')
        opening, supplemental, _ = adapter.author_modules()
        _PARENT = (adapter, installed['normalization'], opening, supplemental)
        return _PARENT
    finally:
        for name in reversed(names):
            if name in installed:
                require(sys.modules.get(name) is installed[name], 'Parent import binding changed')
                if previous[name] is None:
                    del sys.modules[name]
                else:
                    sys.modules[name] = previous[name]


def backup_module():
    return module('accepted_backup0002', Path(load(HERE / 'SOURCE-PINS.json')['backup_packet']) / 'case_module.py')


def supplemental_module():
    pins = load(HERE / 'SOURCE-PINS.json')
    return module('backup_supplemental', Path(pins['supplemental_packet']) / pins['supplemental_module'])


def validate_physical(actual, expected):
    required = {'database', 'database_oid', 'system_identifier', 'data_directory', 'socket_directory'}
    require(type(expected) is dict and set(expected) == required, 'Exact physical expectation required')
    require(type(actual) is dict and all(actual.get(k) == v for k, v in expected.items()), 'Different physical owned endpoint')
    require(actual.get('role') == actual.get('session_role') == 'postgres' and actual.get('socket') is True and
            actual.get('replication') == 'origin' and str(actual.get('server_version', '')).startswith('17.11') and
            type(actual.get('pid')) is int and actual['pid'] > 0 and actual.get('backend_start'), 'Wrong native actor/version/session boundary')
    for key in ('database_oid', 'system_identifier'):
        value = expected[key]
        require(type(value) is str and value.isdecimal() and str(int(value)) == value and int(value) > 0, 'Exact canonical physical identity text required')
    require(int(expected['database_oid']) <= 4294967295, 'OID out of range')
    return actual


def owned_connect(Psql, args, env, label, events, registry, expected):
    """Register before invoking the exact original constructor, including partial failures."""
    c = Psql.__new__(Psql)
    row = {'connection': c, 'label': label, 'events': events, 'constructor_status': 'ATTEMPTED', 'physical': None}
    registry.append(row)
    try:
        Psql.__init__(c, args, env, label, events)
        require(type(c) is Psql and c.one.__func__ is Psql.one and c.sql.__func__ is Psql.sql, 'Original Psql methods required')
        row['constructor_status'] = 'RETURNED'
        row['physical'] = validate_physical(c.one(PHYSICAL_SQL), expected)
        return c
    except Exception as exc:
        row.update(constructor_status='FAILED', error_type=type(exc).__name__, error=str(exc))
        raise


def cleanup_connection(connection):
    # Exact accepted cleanup operation implementation; source AST checked against0124.
    outcomes=[]
    if connection is None:return outcomes
    for action,operation in (
        ('rollback',lambda:connection.sql('ROLLBACK')),
        ('unlock',lambda:connection.sql('SELECT pg_advisory_unlock_all()')),
        ('close',lambda:connection.close())):
        row={'connection':connection.label,'action':action,'status':'ATTEMPTED'}
        outcomes.append(row)
        try:operation();row['status']='RETURNED'
        except Exception as exc:row.update(status='ERROR',error_type=type(exc).__name__,error=str(exc))
    return outcomes


def cleanup_with_reset(connection):
    """Independent rollback/reset/unlock/close for installer or partial root ownership."""
    outcomes = []
    if connection is None:
        return outcomes
    for action, operation in [('rollback', lambda: connection.sql('ROLLBACK')),
                              ('reset', lambda: connection.sql('RESET ALL')),
                              ('unlock', lambda: connection.sql('SELECT pg_advisory_unlock_all()')),
                              ('close', lambda: connection.close())]:
        row = {'connection': getattr(connection, 'label', 'partial'), 'action': action, 'status': 'ATTEMPTED'}
        outcomes.append(row)
        try:
            operation()
            row['status'] = 'RETURNED'
        except Exception as exc:
            row.update(status='ERROR', error_type=type(exc).__name__, error=str(exc))
    return outcomes


def cleanup_registry(registry):
    """Every owned construction remains discoverable; exited clients are positive closure evidence."""
    outcomes = []
    for entry in registry:
        c = entry['connection']
        row = {k: v for k, v in entry.items() if k not in ('connection', 'events')}
        row['event_count'] = len(entry['events'])
        if entry['constructor_status'] != 'RETURNED':
            row['failed_constructor_events'] = entry['events']
        row['cleanup'] = []
        outcomes.append(row)
        process = getattr(c, 'p', None)
        if process is None:
            row['process_state'] = 'NO_PROCESS_HANDLE_AFTER_CONSTRUCTOR_FAILURE'
            row['cleanup_error'] = 'Constructor never returned a usable process; original failure retained; physical cleanup remains mandatory'
            continue
        try:
            exit_code = process.poll()
            row['exit_before_cleanup'] = exit_code
        except Exception as exc:
            exit_code = None
            row['cleanup'].append({'action': 'poll', 'status': 'ERROR', 'error': str(exc)})
        if exit_code is None:
            row['cleanup'].extend(cleanup_with_reset(c))
        try:
            row['exit_after_cleanup'] = process.poll()
            if row['exit_after_cleanup'] is None:
                row['cleanup_error'] = 'Owned client exit unproven'
        except Exception as exc:
            row['cleanup_error'] = str(exc)
        row['stderr'] = list(getattr(c, 'errors', []))
    return outcomes


def registry_failed(rows):
    return any(r.get('cleanup_error') or r.get('constructor_status') != 'RETURNED' or
               any(x.get('status') == 'ERROR' for x in r.get('cleanup', [])) for r in rows)


def supplemental_preflight(connection):
    return parent_modules()[0].supplemental_preflight(connection)


def complete_original_metadata(*args):
    return parent_modules()[0].complete_original_metadata(*args)


def backup_preflight(connection, stage):
    """Read one complete catalog snapshot and restore source rendering/session context."""
    report = {'stage': stage, 'status': 'ATTEMPTED', 'cleanup_errors': []}
    old_path = None
    primary = None
    try:
        old_path = connection.one("SELECT to_jsonb(current_setting('search_path'))")
        require(type(old_path) is str, 'Search path must be actual text')
        connection.sql("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='60s'; SET LOCAL lock_timeout='10s'; SET LOCAL search_path=pg_catalog,public,extensions")
        report['catalog'] = supplemental_module().collect(connection, stage)
        backup_module().metadata(connection, lambda _: report['catalog'])
        connection.sql('COMMIT')
        report['status'] = 'PASSED'
    except Exception as exc:
        primary = exc
        report.update(status='FAIL', error_type=type(exc).__name__, error=str(exc))
        if hasattr(exc, 'supplemental_report'):
            report['supplemental_report'] = exc.supplemental_report
    finally:
        for action, operation in [('rollback', lambda: connection.sql('ROLLBACK')),
                                  ('restore_search_path', lambda: connection.sql("SELECT set_config('search_path'," + "'" + old_path.replace("'", "''") + "',false)")) if old_path is not None else ('restore_search_path', lambda: None)]:
            try:
                operation()
            except Exception as exc:
                report['cleanup_errors'].append({'action': action, 'error': str(exc)})
    if primary is not None or report['cleanup_errors']:
        error = primary or RuntimeError('Catalog cleanup failed')
        error.backup_metadata_report = report
        raise error
    return report['catalog']


def install_supplemental_owned(connect, authorization, expected_oid, physical):
    verify_binding(authorization)
    report = {'status': 'RUNNING', 'events': [], 'opening_normalization': None, 'backup_installation': {}, 'cleanup_outcomes': []}
    c = None
    try:
        c = connect('bbj_exact_install', report['events'])
        validate_physical(c.one(PHYSICAL_SQL), physical)
        report['opening_normalization'] = parent_modules()[1].normalize_owned_fixture(c, expected_oid, {k: physical[k] for k in ('data_directory', 'socket_directory')})
        require(report['opening_normalization']['status'] == 'EXACT_ACL_TRANSITIONS_COMMITTED', 'Original opening normalization failed')
        report['backup_installation']['expected_identity'] = physical
        returned = supplemental_module().install(c, report['backup_installation'])
        require(returned is report['backup_installation'], 'Supplemental must preserve root-owned mutable report identity')
        require(returned.get('status') == 'INSTALLED_OR_EXACT_NOOP' and
                returned.get('commit_status') == 'COMMITTED' and returned.get('cleanup_errors') == [],
                'Supplemental commit and cleanup must be proven before case admission')
        report['complete_catalog'] = backup_preflight(c, 'post_install')
        report['committed_audit'] = audit_postflight(c, 'post_install_audit', physical)
        report['committed_audit_check'] = supplemental_module().A.assert_persisted(
            returned['audit_after'], report['committed_audit']['capture'])
        report['status'] = 'INSTALLED_OR_EXACT_NOOP'
    except Exception as exc:
        report.update(status='FAIL', error_type=type(exc).__name__, error=str(exc))
        for attr in ('normalization_report', 'supplemental_report', 'backup_metadata_report', 'audit_report'):
            if hasattr(exc, attr):
                report[attr] = getattr(exc, attr)
    finally:
        report['cleanup_outcomes'] = cleanup_with_reset(c)
        if c is not None:
            report['connection_stderr'] = list(getattr(c, 'errors', []))
        if any(r['status'] == 'ERROR' for r in report['cleanup_outcomes']):
            report['status'] = 'FAIL'
        if report['status'] == 'FAIL':
            # No retry or afterimage waiver: independently capture failure-state metadata/raw.
            # A historical rollback preimage must remain a failed current-afterimage check.
            post = None
            failure_post = {'events': [], 'errors': [], 'status': 'ATTEMPTED'}
            report['failure_postflight'] = failure_post
            try:
                post = connect('bbj_install_failure_postflight', failure_post['events'])
                failure_post['physical'] = validate_physical(post.one(PHYSICAL_SQL), physical)
                try:
                    failure_post['catalog'] = backup_preflight(post, 'install_failure_postflight')
                except Exception as exc:
                    failure_post['errors'].append({'stage': 'catalog', 'type': type(exc).__name__, 'error': str(exc)})
                    if hasattr(exc, 'backup_metadata_report'):
                        failure_post['backup_metadata_report'] = exc.backup_metadata_report
                try:
                    failure_post['raw'] = backup_module().capture(post)
                except Exception as exc:
                    failure_post['errors'].append({'stage': 'raw', 'type': type(exc).__name__, 'error': str(exc),
                                                  'capture_cleanup_errors': getattr(exc, 'capture_cleanup_errors', [])})
                try:
                    failure_post['audit'] = audit_postflight(post, 'install_failure_audit', physical)
                except Exception as exc:
                    failure_post['errors'].append({'stage':'audit','type':type(exc).__name__,'error':str(exc),
                                                  'audit_report':getattr(exc,'audit_report',None)})
                failure_post['physical_after'] = validate_physical(post.one(PHYSICAL_SQL), physical)
                failure_post['audit_effects_accepted'] = False
                failure_post['status'] = 'CAPTURED' if not failure_post['errors'] else 'CAPTURED_WITH_FAILURES'
            except Exception as exc:
                failure_post.update(status='FAIL', error_type=type(exc).__name__, error=str(exc))
            finally:
                failure_post['cleanup'] = cleanup_with_reset(post)
                failure_post['stderr'] = list(getattr(post, 'errors', [])) if post is not None else []
                if any(r['status'] == 'ERROR' for r in failure_post['cleanup']):
                    failure_post['status'] = 'CLEANUP_FAILED'
    return report


def audit_postflight(connection, stage, physical):
    """Bounded independent evidence, including audit state after failed DDL.

    The caller keeps physical ownership and all cleanup. A captured failure
    state never substitutes for a successful original installation transition.
    """
    report = {'stage':stage,'status':'ATTEMPTED','capture':{},'cleanup_errors':[]}
    primary = None
    try:
        report['physical_before'] = validate_physical(connection.one(PHYSICAL_SQL), physical)
        connection.sql("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='60s'; SET LOCAL lock_timeout='10s'; SET LOCAL search_path=pg_catalog,public,extensions")
        supplement = supplemental_module()
        supplement.capture_audit(connection, report['capture'])
        supplement.A.validate_capture(report['capture'])
        connection.sql('COMMIT')
        report['physical_after'] = validate_physical(connection.one(PHYSICAL_SQL), physical)
        report['status'] = 'CAPTURED'
    except Exception as exc:
        primary = exc
        report.update(status='FAIL',error_type=type(exc).__name__,error=str(exc))
    finally:
        try:
            connection.sql('ROLLBACK')
        except Exception as exc:
            report['cleanup_errors'].append({'action':'rollback','type':type(exc).__name__,'error':str(exc)})
    if primary is not None or report['cleanup_errors']:
        error = primary or RuntimeError('Audit reader cleanup failed')
        error.audit_report = report
        raise error
    return report


def capture_failed_postflight(connect, physical, stage):
    """Use a separately owned read connection; catalog failure cannot skip raw evidence."""
    report = {'stage': stage, 'status': 'ATTEMPTED', 'events': [], 'errors': []}
    connection = None
    try:
        connection = connect(stage, report['events'])
        report['physical_before'] = validate_physical(connection.one(PHYSICAL_SQL), physical)
        try:
            report['catalog'] = backup_preflight(connection, stage)
        except Exception as exc:
            report['errors'].append({'stage': 'catalog', 'type': type(exc).__name__, 'error': str(exc)})
            if hasattr(exc, 'backup_metadata_report'):
                report['backup_metadata_report'] = exc.backup_metadata_report
        # Raw capture is an independent attempt even after catalog refusal.
        try:
            report['raw'] = backup_module().capture(connection)
        except Exception as exc:
            report['errors'].append({'stage': 'raw', 'type': type(exc).__name__, 'error': str(exc),
                                     'capture_cleanup_errors': getattr(exc, 'capture_cleanup_errors', [])})
        try:
            report['audit'] = audit_postflight(connection, stage + ':audit', physical)
        except Exception as exc:
            report['errors'].append({'stage':'audit','type':type(exc).__name__,'error':str(exc),
                                     'audit_report':getattr(exc,'audit_report',None)})
        report['audit_effects_accepted'] = False
        report['physical_after'] = validate_physical(connection.one(PHYSICAL_SQL), physical)
        report['status'] = 'CAPTURED' if not report['errors'] else 'CAPTURED_WITH_FAILURES'
    except Exception as exc:
        report.update(status='FAIL', error_type=type(exc).__name__, error=str(exc))
    finally:
        report['cleanup'] = cleanup_with_reset(connection)
        report['stderr'] = list(getattr(connection, 'errors', [])) if connection is not None else []
        if any(row['status'] == 'ERROR' for row in report['cleanup']):
            report['status'] = 'CLEANUP_FAILED'
    return report


def execute_prepared_case(case, connect, seed, base_driver, authorization, combined=None, metadata_check=None, database=None, database_oid=None):
    verify_binding(authorization, base_driver, case)
    require(case == CASE and database == case.lower(), 'One fresh selected clone required')
    require(callable(combined) and callable(metadata_check), 'Real root callbacks required')
    pins = load(HERE / 'SOURCE-PINS.json')
    opening = parent_modules()[2]
    backup = backup_module()
    report = {'case': case, 'status': 'RUNNING', 'events': [], 'observations': [], 'funding_result': None,
              'backup_result': None, 'failures': [], 'root_preseed_cleanup': [], 'whole_original_case_qualified': False,
              'native_financial_foundation_qualified': False, 'opening_dispatch_count': 0, 'backup_dispatch_count': 0, 'seed_dispatch_count': 0, 'phase_calls': []}
    seed_calls = 0
    probe = None
    def single_seed():
        nonlocal seed_calls
        require(seed_calls == 0, 'Original seed may run exactly once')
        seed_calls += 1
        report['seed_dispatch_count'] = seed_calls
        return seed()
    def phase_callback(names):
        position = 0
        def run():
            nonlocal position
            require(position < len(names), 'Unexpected additional combined command')
            phase = names[position]
            position += 1
            report['phase_calls'].append({'phase': phase, 'status': 'ATTEMPTED'})
            out = combined(phase)
            report['phase_calls'][-1]['status'] = 'RETURNED'
            return out
        return run
    try:
        probe = connect('backup_preseed_guard', report['events'])
        report['observations'].append({'preseed_metadata': metadata_check(probe)})
        empty = backup.capture(probe)
        report['observations'].append({'preseed_raw': empty})
        names = backup.read('FINGERPRINT-CONTRACT.json')['new_supporting_relations']
        require(all(empty['raw']['public.' + name] == [] for name in names) and
                all(empty['raw'][name] == [] for name in ('auth.users', 'public.clubs', 'public.chip_ledger', 'public.ca_account_snapshots', 'public.ca_currency_meter')), 'Fresh unseeded support/financial state required')
        report['root_preseed_cleanup'] = cleanup_connection(probe)
        probe = None
        require(not any(x['status'] == 'ERROR' for x in report['root_preseed_cleanup']), 'Preseed connection cleanup failed')
        opening_auth = {'authorized': True, 'case': opening.CASE, 'case_review_accepted': True, 'root_adapter_review_accepted': True,
                        'packet_sha256': pins['author_integrity_sha256'], 'seed_sha256': pins['seed_sha256'],
                        'database': database, 'database_oid': database_oid, 'operation_id': authorization['opening_operation_id']}
        report['opening_dispatch_count'] += 1
        funding = opening.execute_prepared_case(opening.CASE, connect, single_seed, base_driver, opening_auth,
                    phase_callback(['opening:BEFORE', 'opening:FIRST-POSITIVE', 'opening:STABLE']), metadata_check)
        report['funding_result'] = funding
        require(funding.get('status') == 'PASS_IMPLEMENTED_SUBSET' and funding.get('cleanup_errors') == [] and seed_calls == 1,
                'Original fresh opening failed; backup not invoked')
        require([x['phase'] for x in report['phase_calls']] == ['opening:BEFORE', 'opening:FIRST-POSITIVE', 'opening:STABLE'], 'Three original opening phases required')
        backup_auth = {'authorized': True, 'case': CASE, 'case_review_accepted': True, 'root_adapter_review_accepted': True,
                       'supplemental_source_review_accepted': True, 'packet_sha256': pins['backup_integrity_sha256'],
                       'seed_sha256': pins['seed_sha256'], 'database': database, 'database_oid': database_oid, 'fresh_fixture': True,
                       'opening_module_path': str(Path(opening.__file__).resolve()), 'opening_operation_id': authorization['opening_operation_id'],
                       'move_operation': authorization['move_operation'], 'move_reason': authorization['move_reason']}
        report['backup_dispatch_count'] += 1
        report['backup_result'] = backup.execute_prepared_case(CASE, connect, single_seed, base_driver, backup_auth,
                    phase_callback(['backup:FIRST-BACKUP-POSITIVE', 'backup:STABLE-BACKUP']), metadata_check, opening, funding)
        require(report['backup_result'].get('status') == 'PASS_IMPLEMENTED_SUBSET', 'Backup case failed; full result retained')
        require(seed_calls == 1 and len(report['phase_calls']) == 5 and all(x['status'] == 'RETURNED' for x in report['phase_calls']), 'Exact opening3 plus backup2 phases required')
        report['status'] = 'PASS_IMPLEMENTED_SUBSET'
    except Exception as exc:
        report['status'] = 'FAIL'
        report['failures'].append({'type': type(exc).__name__, 'error': str(exc), 'sqlstate': getattr(exc, 'sqlstate', None)})
        if hasattr(exc, 'backup_metadata_report'):
            report['metadata_error_report'] = exc.backup_metadata_report
    finally:
        if probe is not None:
            report['root_preseed_cleanup'].extend(cleanup_connection(probe))
        if any(x['status'] == 'ERROR' for x in report['root_preseed_cleanup']):
            report['status'] = 'FAIL'
    return report
