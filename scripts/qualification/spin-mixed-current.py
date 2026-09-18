"""Synthetic current-terminal cases inside the existing finite Spin allocator.

This module owns no process, database allocation, scheduler or release operation.
The existing wrapper stages every input, runs these cases, and proves disposal.
The declared starting estate is not recovered historical evidence or a genuine
paid-entry producer. Positive-fee and full financial qualification remain false.
"""
from copy import deepcopy
from decimal import Decimal
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys

IMAGES = ('mixed-current-completion', 'mixed-current-source-change')
BASE = 'scripts/qualification/fixtures/spin-mixed-current/'
PROGRAM = 'scripts/qualification/spin-mixed-current-races.py'
ASSERTIONS = 'scripts/qualification/spin-mixed-current-assertions.py'
MODULE = 'scripts/qualification/spin-mixed-current.py'
MANIFEST = 'scripts/qualification/spin-mixed-current.hosted.manifest.json'
SESSION = 'scripts/qualification/spin-expiry-business-races.py'
COMPONENT = 'supabase/components/spin-mixed-basis-current-terminal.sql'
ROLLBACK = 'supabase/components/spin-mixed-basis-current-terminal.rollback.sql'
LANE = 'supabase/components/spin-mixed-basis-current-receipt-lane.sql'
LANE_ROLLBACK = 'supabase/components/spin-mixed-basis-current-receipt-lane.rollback.sql'
RESULT = 'mixed-current-races.json'
LEAVES = ('catalog-restore.sql', 'catalog-readback.sql', 'recognition-restore.sql',
          'recognition-readback.sql', 'authority.json', 'catalog.json', 'net-plan.json',
          'recognizer.json', 'period-requests.json', 'synthetic-model.json',
          'synthetic-seed.sql', 'actor-identity.sql', 'store-policy.sql',
          'synthetic-provider.sql', 'synthetic-entry-close.sql',
          'synthetic-input-check.sql', 'observer.sql', 'replay.sql',
          'wrapper-refusals.sql', 'narrow-refusal.sql', 'rollback-refusals.sql',
          'provenance.json', 'current-lane-state.sql', 'current-lane-snapshot.sql',
          'current-lane-refusals.sql')
INPUTS = (MODULE, PROGRAM, ASSERTIONS, SESSION, COMPONENT, ROLLBACK, LANE, LANE_ROLLBACK,
          'scripts/qualification/fixtures/spin-receipt-lane/boundary.sql',
          'scripts/qualification/fixtures/spin-receipt-lane/state.sql',
          'scripts/qualification/fixtures/spin-history-retention/database-state.sql', MANIFEST,
          *(BASE + name for name in LEAVES))
TID = '10000000-0000-4000-8000-000000000001'
WINNER = '00000000-0000-4000-8000-000000000003'
SOURCE_HAND = '40000000-0000-4000-8000-000000000001'
INPUT_RESULT = {'synthetic_relational_input_consistent': True, 'total_cash_chips': 300,
                'wallets': 270, 'reserve': 10, 'prize_escrow': 20,
                'history_reader_passed': True, 'business_execution_qualified': False,
                'historical_qualification': False, 'incident_closed': False}


def require(value, message):
    if not value:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def load_module(source, name):
    spec = importlib.util.spec_from_file_location('mixed_current_' + Path(name).stem,
                                                source / name)
    module = importlib.util.module_from_spec(spec)
    # The source packet is sealed. Loading its independent observer must not
    # create a __pycache__ leaf and invalidate the final inventory readback.
    exec(compile((source / name).read_bytes(), str(source / name), 'exec'), module.__dict__)
    return module


def validate_sources(files):
    require(set(INPUTS) <= set(files), 'current mixed source inventory incomplete')
    manifest = json.loads(files[MANIFEST])
    require(manifest['schemaVersion'] == 1 and manifest['kind'] == 'synthetic-current-mixed-terminal'
            and manifest['images'] == list(IMAGES)
            and all(manifest[k] is False for k in ('historical_qualification',
                    'full_financial_qualification', 'production_qualification')),
            'current mixed scope differs')
    require(set(manifest['files']) == set(INPUTS) - {MANIFEST}, 'current mixed manifest inventory differs')
    for name, pin in manifest['files'].items():
        require(pin == {'bytes': len(files[name]), 'sha256': sha(files[name])},
                'current mixed source pin differs: ' + name)
    # Every relative include must be present among the exact staged inputs.
    import posixpath
    graph = {}
    for name in INPUTS:
        if not name.endswith('.sql'):
            continue
        targets = []
        for line in files[name].decode().splitlines():
            if not line.lstrip().startswith('\\ir'):
                continue
            match = re.fullmatch(r'\\ir ([A-Za-z0-9_./-]+)', line.strip())
            require(match is not None, 'unsupported mixed include')
            target = posixpath.normpath(posixpath.join(posixpath.dirname(name), match[1]))
            require(not target.startswith('../') and target in files,
                    'mixed include escapes staged inventory')
            targets.append(target)
        if targets:
            graph[name] = targets
    require(graph == manifest['relative_include_graph'], 'mixed include graph differs')
    require(files[BASE + 'store-policy.sql'].count(files['inputs/captured-financial-store-policy.sql']) == 1,
            'mixed store policy differs from captured authority')


def sql_argv(PG, source, execution, ordinary, tournament, role, path, *, variables=()):
    require(role in ('postgres', 'fixture_bootstrap', 'bootstrap_postgres'), 'unknown mixed SQL role')
    settings = ("SELECT set_config('spin_mixed_qualification.execution_uuid','" + execution + "',false),"
                "set_config('qualification.execution_uuid','" + execution + "',false),"
                "set_config('spin_mixed_qualification.tournament_id','" + TID + "',false),"
                "set_config('spin_mixed_qualification.winner_id','" + WINNER + "',false);")
    if role == 'bootstrap_postgres':
        settings = 'SET ROLE postgres; ' + settings
    result = [str(PG / 'psql'), '-X', '-w', '-A', '-t', '-h', str(source.parent / 'work/socket'),
              '-p', '5432', '-U', 'fixture_bootstrap' if role == 'bootstrap_postgres' else role,
              '-d', 'qual_spin_expiry_' + execution.replace('-', ''),
              '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
              '-v', 'execution_uuid=' + execution, '-v', 'ordinary_user_uuid=' + ordinary,
              '-v', 'tournament_uuid=' + tournament]
    for key, value in variables:
        result += ['-v', key + '=' + value]
    return result + ['-c', settings, '-f', str(source / path)]


def mode_for(image):
    require(image in IMAGES, 'unknown mixed image')
    return 'completion' if image == IMAGES[0] else 'source_change'


def race_argv(PG, source, execution, image):
    return [sys.executable, str(source / PROGRAM), '--psql', str(PG / 'psql'),
            '--execution', execution, '--mode', mode_for(image),
            '--output', str(source.parent / 'work' / RESULT)]


def seed_plan(PG, source, execution, ordinary, tournament):
    common = (PG, source, execution, ordinary, tournament)
    return [
        ('mixed_synthetic_seed', sql_argv(*common, 'fixture_bootstrap', BASE + 'synthetic-seed.sql',
            variables=(('synthetic_model_json', (source / BASE / 'synthetic-model.json').read_text()),))),
        ('mixed_actor_identity', sql_argv(*common, 'fixture_bootstrap', BASE + 'actor-identity.sql')),
    ]


def lane_variables(source, mode):
    require(mode in ('forward', 'rollback'), 'unknown current-lane direction')
    text = (source / (LANE if mode == 'forward' else LANE_ROLLBACK)).read_text()
    require(text.count('\nBEGIN;\n') == 1 and text.endswith('COMMIT;\n'),
            'current-lane transaction boundary differs')
    body = text.replace('\nBEGIN;\n', '\n', 1)[:-len('COMMIT;\n')]
    require(hashlib.md5(body.encode()).hexdigest() == {'forward': '9d1ced3d628446de1db0c10a1d025df9', 'rollback': '228e29b7fa4c677a2d0c443668024c4c'}[mode],
            'current-lane refusal source differs')
    return (('lane_mode', mode), ('lane_body', body))


def body_plan(PG, source, execution, ordinary, tournament, image):
    require(image in IMAGES, 'unknown mixed image')
    common = (PG, source, execution, ordinary, tournament)
    specs = [
        ('mixed_lane_provider', 'postgres', 'scripts/qualification/fixtures/spin-receipt-lane/provider.sql'),
        ('mixed_synthetic_provider', 'bootstrap_postgres', BASE + 'synthetic-provider.sql'),
        ('mixed_entry_close_input', 'bootstrap_postgres', BASE + 'synthetic-entry-close.sql'),
        ('mixed_pure_install', 'postgres', 'supabase/components/spin-mixed-basis-evidence.sql'),
        ('mixed_input_observer', 'bootstrap_postgres', BASE + 'synthetic-input-check.sql'),
        ('mixed_store_policy', 'postgres', BASE + 'store-policy.sql'),
        ('mixed_catalog_restore', 'postgres', BASE + 'catalog-restore.sql'),
        ('mixed_catalog_readback', 'postgres', BASE + 'catalog-readback.sql'),
        ('mixed_recognition_restore', 'postgres', BASE + 'recognition-restore.sql'),
        ('mixed_recognition_readback', 'postgres', BASE + 'recognition-readback.sql'),
        ('current_lane_before', 'postgres', BASE + 'current-lane-snapshot.sql'),
        ('current_lane_forward_refusals', 'fixture_bootstrap', BASE + 'current-lane-refusals.sql'),
        ('mixed_lane_install', 'postgres', LANE),
        ('current_lane_installed', 'postgres', BASE + 'current-lane-snapshot.sql'),
        ('mixed_terminal_install', 'postgres', COMPONENT),
        ('independent_before', 'postgres', BASE + 'observer.sql'),
        ('wrapper_refusals', 'postgres', BASE + 'wrapper-refusals.sql'),
        ('narrow_refusal', 'postgres', BASE + 'narrow-refusal.sql'),
        ('independent_after_negatives', 'postgres', BASE + 'observer.sql'),
    ]
    plan = [(name, sql_argv(*common, role, path,
                variables=lane_variables(source, 'forward') if name == 'current_lane_forward_refusals' else ()))
            for name, role, path in specs]
    plan.append(('terminal_consumer', race_argv(PG, source, execution, image)))
    if mode_for(image) == 'source_change':
        plan.append(('independent_after_source_change', sql_argv(*common, 'postgres', BASE + 'observer.sql')))
    else:
        for name, leaf in [('independent_committed', 'observer.sql'), ('independent_replay', 'replay.sql'),
                           ('independent_after_replay', 'observer.sql')]:
            plan.append((name, sql_argv(*common, 'postgres', BASE + leaf)))
        rollback = (source / ROLLBACK).read_text()
        require(rollback.splitlines().count('BEGIN;') == 1 and rollback.endswith('COMMIT;\n'),
                'mixed rollback transaction boundary differs')
        body = rollback.replace('\nBEGIN;\n', '\n', 1)[:-len('COMMIT;\n')]
        require(hashlib.md5(body.encode()).hexdigest() == '6745474610e2ef2693f151feeaf65bdb',
                'mixed rollback refusal source differs')
        plan.append(('rollback_refusals', sql_argv(*common, 'fixture_bootstrap', BASE + 'rollback-refusals.sql',
                                                  variables=(('rollback_body', body),))))
        plan.append(('independent_after_rollback_negatives', sql_argv(*common, 'postgres', BASE + 'observer.sql')))
    plan.append(('current_lane_before_terminal_rollback', sql_argv(*common, 'postgres', BASE + 'current-lane-snapshot.sql')))
    plan.append(('current_terminal_rollback', sql_argv(*common, 'postgres', ROLLBACK)))
    plan.append(('independent_after_rollback', sql_argv(*common, 'postgres', BASE + 'observer.sql')))
    plan.append(('current_lane_before_rollback', sql_argv(*common, 'postgres', BASE + 'current-lane-snapshot.sql')))
    plan.append(('current_lane_rollback_refusals', sql_argv(*common, 'fixture_bootstrap', BASE + 'current-lane-refusals.sql',
                                                          variables=lane_variables(source, 'rollback'))))
    plan.append(('current_lane_rollback', sql_argv(*common, 'postgres', LANE_ROLLBACK)))
    plan.append(('current_lane_after', sql_argv(*common, 'postgres', BASE + 'current-lane-snapshot.sql')))
    return plan


def decode_races(raw):
    def constant(value):
        raise ValueError('nonfinite mixed race JSON constant: ' + value)
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'duplicate mixed race JSON key: ' + key)
            result[key] = value
        return result
    return json.loads(raw, parse_float=Decimal, parse_constant=constant, object_pairs_hook=unique)


def validate_races(value, execution, image, files):
    """Bind the child receipt to its staged inputs and original observations."""
    mode = mode_for(image)
    require(isinstance(value, dict) and value.get('execution') == execution
            and value.get('mode') == mode
            and value.get('qualification') == 'synthetic_current_terminal_zero_fee',
            'wrong/stale mixed race receipt')
    for key in ('passed', 'cleanup_verified', 'source_stable'):
        require(value.get(key) is True, 'mixed race assertion false: ' + key)
    for key in ('production_mutation', 'full_qualification', 'historical_qualification',
                'full_financial_qualification', 'fee_bearing_qualification', 'incident_closed'):
        require(value.get(key) is False, 'mixed race unsupported qualification claim: ' + key)
    require(not any(key in value for key in ('failure', 'cleanup_failure', 'verifier_cleanup_error'))
            and type(value.get('work_deadline_seconds')) is int
            and value['work_deadline_seconds'] == 20
            and type(value.get('cleanup_deadline_seconds')) is int
            and value['cleanup_deadline_seconds'] == 5,
            'mixed race failure or original deadline differs')
    require(set(INPUTS) <= set(files), 'mixed race staged source inventory incomplete')
    expected_sources = {name: sha(files[name]) for name in INPUTS}
    require(value.get('source_sha256') == expected_sources,
            'mixed race executed source map differs')
    require(value.get('source_readback') == {
        name: {'sha256': digest, 'matches': True} for name, digest in expected_sources.items()},
        'mixed race final source readback differs')
    require(all(row['matches'] is True for row in value['source_readback'].values()),
            'mixed race source readback is not an observed match')

    ids = value.get('backend_pids', {})
    require(isinstance(ids, dict) and set(ids) == {'observer', 'holder', 'caller'}
            and all(type(pid) is int and pid > 0 for pid in ids.values())
            and len(set(ids.values())) == 3, 'mixed race backend identities invalid')
    environment = value.get('environment', {})
    require(isinstance(environment, dict)
            and set(environment) == {'database', 'user', 'session_user', 'address', 'listen',
                                     'port', 'super', 'version', 'others'}
            and environment.get('database') == 'qual_spin_expiry_' + execution.replace('-', '')
            and environment.get('user') == environment.get('session_user') == 'postgres'
            and environment.get('address') is None and environment.get('listen') == ''
            and environment.get('port') == '5432' and environment.get('super') is False
            and type(environment.get('version')) is int
            and 170000 <= environment['version'] < 180000
            and type(environment.get('others')) is int and environment['others'] == 0,
            'mixed race private nonsuper endpoint differs')
    clients = value.get('clients', [])
    require(clients == [{'client_exit': 0, 'backend_pid': ids[name]}
                        for name in ('caller', 'holder', 'observer')]
            and all(type(client['client_exit']) is int for client in clients),
            'mixed race original client terminal identity differs')
    cleanup = value.get('backend_cleanup', {})
    require(cleanup == {'backends': 0, 'locks': 0}
            and all(type(count) is int for count in cleanup.values()),
            'mixed race original backend or lock remains')
    verifier = value.get('verifier_client', {})
    require(isinstance(verifier, dict) and set(verifier) == {'client_exit', 'backend_pid'}
            and type(verifier['client_exit']) is int and verifier['client_exit'] == 0
            and type(verifier['backend_pid']) is int and verifier['backend_pid'] > 0
            and verifier['backend_pid'] not in ids.values(),
            'mixed race fresh cleanup client terminal proof differs')

    # PG17 hashtextextended(...,0) keys, in G then B order. These exact OID-string
    # values are retained in the Q6 original observer transcript (75d897abd543...).
    barriers = ({'classid': '4265093629', 'objid': '1253463894'},
                {'classid': '880566413', 'objid': '1926503905'})
    cases = value.get('cases', [])
    names = (['receipt_writer_rollback_then_wrapper', 'concurrent_completion_rollback_retry',
              'concurrent_completion_commit_replay'] if mode == 'completion'
             else ['committed_source_reread_after_wait'])
    require(isinstance(cases, list) and all(isinstance(case, dict) for case in cases)
            and [case.get('case') for case in cases] == names,
            'mixed race schedule order/count differs')
    expected_wait = {'pid': ids['caller'], 'type': 'Lock', 'event': 'advisory',
                     'blockers': [ids['holder']], 'data_locks': 0,
                     'locks': [dict(barriers[0], mode='ExclusiveLock', granted=False, objsubid=1)]}
    for case in cases:
        require(case.get('wait') == expected_wait, 'mixed race exact initial G wait differs')
        wait = case['wait']
        require(type(wait['pid']) is int and type(wait['data_locks']) is int
                and all(type(pid) is int for pid in wait['blockers'])
                and wait['locks'][0]['granted'] is False
                and type(wait['locks'][0]['objsubid']) is int,
                'mixed race wait observation types differ')
        if mode == 'source_change':
            require(type(case.get('affected_rows')) is int and case['affected_rows'] == 1
                    and case.get('exact_refusal') is True
                    and case.get('only_declared_source_change') is True,
                    'mixed race source refusal outcome differs')
        elif case['case'] == names[0]:
            require(case.get('exact_rollback') is True, 'mixed race writer rollback unproven')
        else:
            replay = case['case'] == names[-1]
            require(case.get('exact_rollback') is (not replay) and case.get('exact_replay') is replay,
                    'mixed race completion rollback/replay outcome differs')
            held = case.get('exclusive_barriers', [])
            require(isinstance(held, list) and all(isinstance(lock, dict) for lock in held),
                    'mixed race held barrier observations absent')
            for barrier in barriers:
                expected = dict(barrier, mode='ExclusiveLock', granted=True, objsubid=1)
                matches = [lock for lock in held if lock == expected]
                require(len(matches) == 1 and matches[0]['granted'] is True
                        and type(matches[0]['objsubid']) is int,
                        'mixed race exact exclusive G/B ownership absent')
            receipt = case.get('second_receipt', {})
            require(isinstance(receipt, dict) and receipt.get('ok') is True
                    and receipt.get('fully_settled') is True and receipt.get('status') == 'COMPLETED'
                    and receipt.get('tournament_id') == TID and receipt.get('winner_id') == WINNER,
                    'mixed race second caller completion identity differs')
    if mode == 'source_change':
        require(value.get('source_preconditions') == {
            'table_id': '20000000-0000-4000-8000-000000000001', 'hand_id': SOURCE_HAND,
            'status': 'succeeded', 'error': None, 'running_unsealed': True},
            'mixed race successful unsealed source precondition absent')
        require(value['source_preconditions']['running_unsealed'] is True,
                'mixed race unsealed source observation differs')

    transcripts = value.get('transcripts', {})
    expected_names = {'current_mixed_' + name + '_' + execution for name in ids}
    require(isinstance(transcripts, dict) and set(transcripts) == expected_names
            and all(isinstance(raw, str) and raw for raw in transcripts.values()),
            'mixed race original session transcripts absent')
    for name, raw in transcripts.items():
        expected_error = (['ERROR:  P0404: mixed-basis retained history refused: unaccepted_receipt']
                          if mode == 'source_change' and name == 'current_mixed_caller_' + execution else [])
        require(re.findall(r'^(?:ERROR|FATAL|PANIC):[^\r\n]*', raw, re.M) == expected_error
                and raw.count('ERROR:') == len(expected_error)
                and 'FATAL:' not in raw and 'PANIC:' not in raw,
                'mixed race original SQL diagnostic differs: ' + name)
    cleanup_raw = value.get('cleanup_transcript')
    require(isinstance(cleanup_raw, str) and cleanup_raw
            and not any(marker in cleanup_raw for marker in ('ERROR:', 'FATAL:', 'PANIC:')),
            'mixed race cleanup SQL diagnostic differs')


def validate_lane_roundtrip(one):
    """Read original stage observations; DDL reversal must never erase business rows."""
    before = one('current_lane_before')
    installed = one('current_lane_installed')
    terminal = one('current_lane_before_terminal_rollback')
    reversing = one('current_lane_before_rollback')
    after = one('current_lane_after')
    for value in (before, installed, terminal, reversing, after):
        require(isinstance(value, dict)
                and set(value) == {'catalog', 'current_cohort', 'handler', 'business'}
                and isinstance(value['catalog'], dict) and value['catalog']
                and isinstance(value['current_cohort'], list) and value['current_cohort']
                and isinstance(value['business'], dict) and value['business'],
                'current-lane original authority/business observation incomplete')
    require(before['handler'] is None and after['handler'] is None,
            'current-lane original/restored handler is not absent')
    require(installed['handler'] == reversing['handler'] == {
        'owner': 'postgres', 'acl': '{postgres=X/postgres}',
        'body_md5': '534850c97847e72075044d8604b0a09d',
        'config': ['search_path=pg_catalog, public, pg_temp'],
        'security_definer': False, 'volatility': 'v'},
        'current-lane installed handler authority differs')
    require(before['catalog'] == after['catalog']
            and before['current_cohort'] == installed['current_cohort']
                == reversing['current_cohort'] == after['current_cohort'],
            'current-lane roundtrip did not restore original current authority')
    require(before['business'] == installed['business']
            and terminal['business'] == reversing['business'] == after['business'],
            'current-lane install or terminal/lane rollback changed business state')
    for mode, count in (('forward', 9), ('rollback', 12)):
        require(one('current_lane_' + mode + '_refusals') == {
            'current_lane_mode': mode, 'authority_refusals': count,
            'exact_state_restored': True}, 'current-lane drift refusal evidence differs')
    return {'original_current_authority_restored': True,
            'business_state_preserved': True, 'forward_refusals': 9, 'rollback_refusals': 12}


def validate_outputs(source, work, execution, image):
    assertions = load_module(source, ASSERTIONS)
    def one(name):
        value, = assertions.load(work, name)
        return value
    require(one('mixed_input_observer') == INPUT_RESULT, 'declared mixed starting estate differs')
    before, negative = one('independent_before'), one('independent_after_negatives')
    require(before['state'] == negative['state'] and before['estate'] == negative['estate'],
            'refusal changed mixed starting estate')
    require(one('wrapper_refusals') == {'wrapper_first_acquisition_refusals': 2},
            'missing wrapper refusal')
    require(one('narrow_refusal') == {'narrow_lane_admission_refused': True,
                                    'classification_race_qualified': False}, 'missing narrow-lane refusal')
    raw = (work / RESULT).read_bytes()
    races = decode_races(raw)
    validate_races(races, execution, image, {name: (source / name).read_bytes() for name in INPUTS})
    require(races['execution'] == execution and races['mode'] == mode_for(image)
            and races['passed'] is True and races['cleanup_verified'] is True,
            'actual mixed race did not qualify')
    require(races['backend_cleanup'] == {'backends': 0, 'locks': 0}
            and len(races['clients']) == 3
            and all(x.get('client_exit') == 0 and 'cleanup_error' not in x for x in races['clients'])
            and len({x['backend_pid'] for x in races['clients']}) == 3
            and races['verifier_client']['client_exit'] == 0,
            'mixed business clients or locks remain')
    summary = {'qualification': 'synthetic_current_mixed_terminal', 'mode': mode_for(image),
               'race_result_sha256': sha(raw), 'exact_full_state_verified': True,
               'current_lane_roundtrip': validate_lane_roundtrip(one),
               'positive_fee_qualified': False, 'full_financial_qualification': False,
               'historical_qualification': False, 'production_qualification': False,
               'incident_closed': False}
    if mode_for(image) == 'completion':
        require([x['case'] for x in races['cases']] == ['receipt_writer_rollback_then_wrapper',
                'concurrent_completion_rollback_retry', 'concurrent_completion_commit_replay'],
                'mixed completion schedule inventory differs')
        summary['cash_oracle'] = assertions.validate(work)
        require(one('rollback_refusals') == {'rollback_owner_acl_refusals': 8}, 'missing rollback refusal')
        committed = one('independent_committed')
        for name in ('independent_after_rollback_negatives', 'independent_after_rollback'):
            observed = one(name)
            require(observed['state'] == committed['state'] and observed['estate'] == committed['estate'],
                    'mixed rollback lost committed state or cash')
        summary['rollback_preserves_committed_evidence'] = True
    else:
        case, = races['cases']
        require(case['case'] == 'committed_source_reread_after_wait' and case['exact_refusal'] is True
                and case['only_declared_source_change'] is True, 'committed source failure not observed')
        after = one('independent_after_source_change')
        expected = deepcopy(before['state'])
        row, = [r for r in expected['settlement_idempotency_keys'] if r['hand_id'] == SOURCE_HAND]
        require(row['status'] == 'succeeded' and row['error'] is None, 'source was already refused')
        row.update(status='failed', error='qualification-negative-source')
        require(after['state'] == expected and before['estate'] == after['estate'],
                'committed source refusal changed unrelated state')
        require(before['pid'] != after['pid'] and before['backend_start'] and after['backend_start']
                and before['backend_start'] != after['backend_start'], 'fresh source observer missing')
        rolled = one('independent_after_rollback')
        require(rolled['state'] == after['state'] and rolled['estate'] == after['estate'],
                'source-change rollback changed the refused estate')
        summary['only_declared_source_change'] = True
    return summary


def validate_stages(receipt, PG, source, execution, ordinary, tournament, image):
    plan = seed_plan(PG, source, execution, ordinary, tournament)
    plan += body_plan(PG, source, execution, ordinary, tournament, image)
    stages = receipt['stages']
    names = [x['stage'] for x in stages]
    require(all(names.count(name) == 1 for name, _ in plan), 'mixed stage absent or repeated')
    require([names.index(name) for name, _ in plan] == sorted(names.index(name) for name, _ in plan),
            'mixed stages reordered')
    require(names.index('schema_prefix') < names.index('mixed_synthetic_seed')
            < names.index('mixed_actor_identity') < names.index('schema_suffix_all_real_triggers')
            < names.index('retention_provider_authority') < names.index('mixed_lane_provider'),
            'synthetic restore crossed original trigger/provider boundaries')
    require(not any(name in names for name in ('restore_preexisting_principals',
            'empty_provider_readback', 'real_funded_paid_seat_fixture', 'restore_completed_start')),
            'synthetic estate reached another image lifecycle')
    for name, argv in plan:
        stage = stages[names.index(name)]
        require(stage['argv'] == argv and stage['returncode'] == 0,
                'mixed stage endpoint, authority, source or outcome differs: ' + name)
        for stream in ('stdout', 'stderr'):
            require(sha((source.parent / 'work' / (name + '.' + stream)).read_bytes()) == stage[stream + '_sha256'],
                    'mixed original output changed: ' + name)
    expected = validate_outputs(source, source.parent / 'work', execution, image)
    require(receipt.get('mixed_current_qualification') == expected, 'mixed summary differs from original evidence')
    return []
