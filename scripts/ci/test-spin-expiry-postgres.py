#!/usr/bin/env python3
"""Finite hosted PG17 Spin expiry qualification, using authentic captured inputs.

Runs source-specific controls first, then independent preimage, candidate and
completed-receipt eligibility clusters. No provider daemon, VM, arbitrary database
target, retry or resume.
The financial schedules and their independent oracle remain authoritative.
"""
import argparse
from decimal import Decimal
import hashlib
import importlib.util
import json
import os
import posixpath
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'scripts/ci/probes/spin-expiry'
ORIGIN_MANIFEST = 'bee0d56349f89b0324962455b770fde4b5c322970b2b7b5a11ad69536b3ff580'
MARKER = b'CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user();'
OWNER = '47965354-0e56-43ef-931c-ddaab82af765'
REFUND_ACTOR = '2d1cd6c3-5700-4af9-a271-d4863fdab20d'
IMAGES = ('preimage', 'candidate', 'retention-completed')
CASES = {'preimage': ('order',), 'candidate': ('order', 'timeout', 'committed-refund'),
         'retention-completed': ()}
CASE_RESULTS = {'order': 'business-order.json', 'timeout': 'business-timeout.json',
                'committed-refund': 'committed-refund.jsonl'}
SERVER_ENDPOINT_QUERY = """SELECT jsonb_build_object(
  'user',current_user,'session_user',session_user,'port',current_setting('port'),
  'address',inet_server_addr(),'listen_addresses',current_setting('listen_addresses'),
  'unix_socket_directories',current_setting('unix_socket_directories'));"""
CLEAN_ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8',
             'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
             'PYTHONDONTWRITEBYTECODE': '1'}
REPLACEMENTS = {'scripts/qualification/spin-expiry-business-races.md': 'scripts/qualification/spin-expiry-business-races.md', 'scripts/qualification/spin-expiry-business-races.py': 'scripts/qualification/spin-expiry-business-races.py', 'scripts/qualification/spin-expiry-business-state.sql': 'scripts/qualification/spin-expiry-business-state.sql', 'scripts/qualification/spin-expiry-committed-refund-oracle.py': 'scripts/qualification/spin-expiry-committed-refund-oracle.py', 'scripts/qualification/spin-expiry-committed-refund-state.sql': 'scripts/qualification/spin-expiry-committed-refund-state.sql', 'scripts/qualification/spin-expiry-committed-refund.authority.json': 'scripts/qualification/spin-expiry-committed-refund.authority.json', 'scripts/qualification/spin-expiry-committed-refund.md': 'scripts/qualification/spin-expiry-committed-refund.md', 'scripts/qualification/spin-expiry-committed-refund.py': 'scripts/qualification/spin-expiry-committed-refund.py', 'scripts/qualification/spin-expiry-lock-order.authority.json': 'scripts/qualification/spin-expiry-lock-order.authority.json', 'scripts/qualification/spin-expiry-lock-order.component-inputs.sql': 'scripts/qualification/spin-expiry-lock-order.component-inputs.sql', 'scripts/qualification/spin-expiry-lock-order.md': 'scripts/qualification/spin-expiry-lock-order.md', 'scripts/qualification/spin-expiry-lock-order.sql': 'scripts/qualification/spin-expiry-lock-order.sql', 'scripts/qualification/spin-expiry-real-funded-fixture.sql': 'scripts/qualification/spin-expiry-real-funded-fixture.sql', 'supabase/components/spin-expiry-lock-order.rollback.sql': 'supabase/components/spin-expiry-lock-order.rollback.sql', 'supabase/components/spin-expiry-lock-order.sql': 'supabase/components/spin-expiry-lock-order.sql'}
RETENTION_MANIFEST = 'scripts/qualification/spin-history-retention.manifest.json'
RETENTION_MANIFEST_SHA256 = '00e114895b4eab4a4af80056649345a77acd85c1667dfa6ac57c35c579ab5429'
RETENTION_INPUTS = (
    'scripts/qualification/fixtures/spin-history-retention/capture-closure.sql',
    'scripts/qualification/fixtures/spin-history-retention/capture-provider.sql',
    'scripts/qualification/fixtures/spin-history-retention/component-inputs.sql',
    'scripts/qualification/fixtures/spin-history-retention/database-state.sql',
    'scripts/qualification/fixtures/spin-history-retention/estate.sql',
    'scripts/qualification/fixtures/spin-history-retention/history-writer-authority.json',
    'scripts/qualification/fixtures/spin-history-retention/preimage.sql',
    'scripts/qualification/fixtures/spin-history-retention/provider-authority.json',
    'scripts/qualification/fixtures/spin-history-retention/provider-check.sql',
    'scripts/qualification/fixtures/spin-history-retention/provider-closure-authority.json',
    'scripts/qualification/fixtures/spin-history-retention/provider-closure-check.sql',
    'scripts/qualification/fixtures/spin-history-retention/provider-closure.sql',
    'scripts/qualification/fixtures/spin-history-retention/provider-supplement.sql',
    'scripts/qualification/fixtures/spin-history-retention/sequence-authority-capture.json',
    'scripts/qualification/fixtures/spin-history-retention/sequence-authority.sql',
    'scripts/qualification/fixtures/spin-history-retention/social-alias-reference.sql',
    'scripts/qualification/fixtures/spin-history-retention/social-alias-reference-authority.json',
    'scripts/qualification/fixtures/spin-history-retention/state.sql',
    'scripts/qualification/spin-history-retention-behavior.sql',
    'scripts/qualification/spin-history-retention.md',
    'scripts/qualification/spin-history-retention.sql',
    'supabase/components/spin-history-retention.rollback.sql',
    'supabase/components/spin-history-retention.sql',
    'scripts/qualification/spin-history-retention.manifest.json',
)
COMPLETED_MANIFEST = 'scripts/qualification/spin-history-retention-completed.manifest.json'
COMPLETED_MANIFEST_SHA256 = '85ce94040484c567c0b1c71e4d98df0d0c2ba549325e8dd1e747a324287c9bc2'
COMPLETED_INPUTS = (
    'scripts/qualification/fixtures/spin-history-retention/capture-completed-start.sql',
    'scripts/qualification/fixtures/spin-history-retention/completed-start-authority.json',
    'scripts/qualification/fixtures/spin-history-retention/completed-start-input.sql',
    'scripts/qualification/fixtures/spin-history-retention/completed-start-restore.sql',
    'scripts/qualification/spin-history-retention-completed.sql',
    'scripts/qualification/spin-history-retention-completed.md',
    COMPLETED_MANIFEST,
)
COMPLETED_RESTORE = 'scripts/qualification/fixtures/spin-history-retention/completed-start-restore.sql'
COMPLETED_CONSUMER = 'scripts/qualification/spin-history-retention-completed.sql'
COMPLETED_CAPTURE_TIME = '2026-09-17T07:35:54.523723+00:00'
REPLACEMENTS.update({name: name for name in (*RETENTION_INPUTS, *COMPLETED_INPUTS)})
PURE_MANIFEST = 'scripts/qualification/spin-mixed-basis-pure.hosted.manifest.json'
PURE_MANIFEST_SHA256 = 'a35df0cdf919067a27646cf55272748a4feb6fd418a896156b57fd84a651cdfe'
PURE_COMPONENT = 'supabase/components/spin-mixed-basis-evidence.sql'
PURE_SHAPE = 'scripts/qualification/spin-mixed-basis-shape.sql'
PURE_PREIMAGE = 'scripts/qualification/spin-mixed-basis-evidence.preimage.sql'
PURE_PREIMAGE_SHA256 = 'f0d703e56be6f6bd171a2ed56cd4943a5021fd4bfc9da57a60c706d1af7d8572'
PURE_QUALIFIER = 'scripts/qualification/spin-mixed-basis-pure.sql'
PURE_ORACLE = 'scripts/qualification/fixtures/spin-history-retention/database-state.sql'
PURE_INPUTS = (PURE_COMPONENT, PURE_SHAPE, PURE_PREIMAGE, PURE_QUALIFIER, PURE_ORACLE, PURE_MANIFEST)
PURE_STAGE = 'mixed_pure_evidence_rollback'
REPLACEMENTS.update({name: name for name in PURE_INPUTS})
LANE_MANIFEST = 'scripts/qualification/spin-receipt-lane.hosted.manifest.json'
LANE_MANIFEST_SHA256 = 'df957a7c5ce6d2ec2dcdc60021bb31ace22c557bff5392f933a283b2d58ec2a3'
LANE_BASE = 'scripts/qualification/fixtures/spin-receipt-lane/'
LANE_COMPONENT = 'supabase/components/spin-mixed-basis-receipt-lane.sql'
LANE_ROLLBACK = 'supabase/components/spin-mixed-basis-receipt-lane.rollback.sql'
LANE_PROGRAM = 'scripts/qualification/spin-receipt-lane.py'
LANE_SESSION = 'scripts/qualification/spin-expiry-business-races.py'
LANE_RESULT = 'receipt-lane.json'
LANE_PHASE = 'receipt_lane_statements'
LANE_STAGES = {
    'receipt_lane_provider': LANE_BASE + 'provider.sql',
    'receipt_lane_catalog': 'scripts/qualification/spin-receipt-lane.sql',
    'receipt_lane_before': LANE_BASE + 'snapshot.sql',
    'receipt_lane_install': LANE_COMPONENT,
    LANE_PHASE: LANE_PROGRAM,
    'receipt_lane_rollback': LANE_ROLLBACK,
    'receipt_lane_after': LANE_BASE + 'snapshot.sql',
}
LANE_CASES = ('receipt_insert', 'receipt_update', 'receipt_delete', 'history_insert',
              'history_identity_update', 'history_metadata_update', 'reverse_shared_lane',
              'truncate_relation_then_refusal', 'zero_rake_rpc_entry_and_replay')
LANE_INPUTS = (LANE_MANIFEST, LANE_COMPONENT, LANE_ROLLBACK, LANE_PROGRAM, LANE_SESSION, PURE_ORACLE,
    'scripts/qualification/spin-receipt-lane.sql', 'scripts/qualification/spin-receipt-lane-compactor.sql',
    'scripts/qualification/spin-receipt-lane.md',
    *(LANE_BASE + name for name in ('authority.json','boundary.sql','provider.sql','state.sql',
                                  'snapshot.sql','component-inputs.sql')))
REPLACEMENTS.update({name: name for name in LANE_INPUTS})
LANE_CATALOG = {'qualification':'receipt_lane_catalog','original_and_candidate_compactor_checked':True,
    'unrelated_update_trigger_refused':True,'altered_binding_refusals':7,'helper_authority_drift_refusals':2,'missing_preimage_refused':True,
    'replay_refused':True,'existing_function_metadata_preserved':True,'guarded_and_outer_rollback_verified':True,
    'business_rows_unchanged':True,'historical_rows_qualified':False,'financial_completion_qualified':False,
    'full_qualification':False}


def lane_program_argv(PG, source, execution):
    return [sys.executable, str(source / LANE_PROGRAM), '--psql', str(PG/'psql'),
            '--execution', execution, '--output', str(source.parent/'work'/LANE_RESULT)]


def lane_json(output):
    values = [json.loads(line,object_pairs_hook=unique_object,parse_float=Decimal)
              for line in output.splitlines() if line.lstrip().startswith(b'{')]
    require(len(values) == 1, 'lane original JSON absent, malformed or repeated')
    return values[0]


def validate_lane_sources(files):
    require(set(LANE_INPUTS) <= set(files), 'receipt lane source inventory incomplete')
    require(digest(files[LANE_MANIFEST]) == LANE_MANIFEST_SHA256, 'receipt lane manifest differs')
    manifest = decode(files[LANE_MANIFEST])
    require(set(manifest['files']) == set(LANE_INPUTS)-{LANE_MANIFEST}, 'receipt lane leaf inventory differs')
    for name, expected in manifest['files'].items():
        require(pin(files[name]) == expected, 'receipt lane source pin mismatch: ' + name)
    require(digest(files[LANE_BASE+'authority.json']) == 'a4aadc81c0b50396dbed0c3d9b8bf7c72887ecb897ffd2e0b05e96534d78c39c',
            'authentic lane capture differs')
    require(digest(files[LANE_SESSION]) == '33040b22707d84990cc87489d97b412ca1a5163906646769a9961842a1f3eae8',
            'existing Session implementation differs')
    graph = {}
    for name in manifest['files']:
        if not name.endswith('.sql'): continue
        targets = []
        for line in files[name].decode().splitlines():
            if not line.lstrip().startswith('\\ir'): continue
            match = re.fullmatch(r'\\ir ([A-Za-z0-9_./-]+)', line.strip())
            require(match is not None, 'unsupported lane include')
            target = posixpath.normpath(posixpath.join(posixpath.dirname(name), match[1]))
            safe_name(target); require(target in files, 'lane include missing from staged source')
            targets.append(target)
        if targets: graph[name] = targets
    require(graph == manifest['relative_include_graph'], 'lane include graph changed')
    embedded = files[LANE_BASE+'component-inputs.sql'].decode()
    for label, name, end in [('forward',LANE_COMPONENT,'COMMIT;'),('rollback',LANE_ROLLBACK,'COMMIT;'),
                            ('compactor','scripts/qualification/spin-receipt-lane-compactor.sql','ROLLBACK;')]:
        source = files[name].decode()
        require(source.splitlines().count('BEGIN;') == 1 and source.splitlines().count(end) == 1,
                'lane embedded transaction boundary changed')
        body = ''.join(line for line in source.splitlines(keepends=True) if line.strip() not in ('BEGIN;',end))
        parts = embedded.split('$lane_'+label+'$')
        require(len(parts)==3 and parts[1]==body, 'lane embedded source differs: '+label)
    require(manifest['stage_order'] == list(LANE_STAGES) and manifest['image']=='candidate'
            and manifest['full_qualification'] is False, 'lane stage/scope contract differs')


def validate_lane_races(value, execution, files):
    require(value.get('execution') == execution and value.get('qualification') == 'receipt_statement_lane_and_zero_rake_compatibility',
            'wrong/stale lane execution')
    for key in ('passed','cleanup_verified','source_stable'):
        require(value.get(key) is True, 'lane assertion false: '+key)
    for key in ('full_qualification','historical_rows_qualified','financial_completion_qualified'):
        require(value.get(key) is False, 'lane unsupported qualification claim')
    require(not any(key in value for key in ('failure','cleanup_failure','verifier_cleanup_error'))
            and value.get('work_deadline_seconds')==20 and value.get('cleanup_deadline_seconds')==5,
            'lane original failure or deadline mismatch')
    expected_sources = {name: digest(files[name]) for name in LANE_INPUTS}
    require(value.get('source_sha256') == expected_sources, 'lane executed source set differs')
    require(value.get('source_readback') == {name:{'sha256':sha,'matches':True} for name,sha in expected_sources.items()},
            'lane final input readback differs')
    require(value.get('shared_helper_authority') == {'owner':'postgres','acl':'{postgres=X/postgres,service_role=X/postgres}',
        'security_definer':False,'volatility':'v','config':['search_path=public, pg_temp'],
        'full_md5':'409b14ee72ce888d3b26524c52d49a68'}, 'lane helper authority unproven')
    ids = value.get('backend_pids',{})
    require(set(ids)=={'observer','holder','writer'} and all(type(x) is int and x>0 for x in ids.values())
            and len(set(ids.values()))==3, 'lane backend identities invalid')
    environment = value.get('environment',{})
    require(environment.get('database') == 'qual_spin_expiry_'+execution.replace('-','')
            and environment.get('user') == 'postgres' and environment.get('session_user') == 'postgres'
            and environment.get('address') is None and environment.get('port') == '5432'
            and type(environment.get('version')) is int and 170000 <= environment['version'] < 180000
            and environment.get('others') == 0, 'lane endpoint proof differs')
    cases = value.get('cases',[])
    require([row.get('case') for row in cases] == list(LANE_CASES), 'lane case order/count differs')
    for row in cases:
        name = row['case']; reverse = name=='reverse_shared_lane'
        holder,writer = (ids['writer'],ids['holder']) if reverse else (ids['holder'],ids['writer'])
        role = 'service_role' if name.startswith('receipt_') or name in ('truncate_relation_then_refusal','zero_rake_rpc_entry_and_replay') else 'postgres'
        require(row.get('role')==role and row.get('holder_pid')==holder and row.get('writer_pid')==writer
                , 'lane role/PID differs')
        if name!='zero_rake_rpc_entry_and_replay':
            require(type(row.get('affected_rows')) is int and row['affected_rows']==0, 'lane affected row count differs')
        if name != 'history_metadata_update':
            require(row.get('wait') == {'pid':writer,'wait_event_type':'Lock',
                'wait_event':'relation' if name=='truncate_relation_then_refusal' else 'advisory',
                'blockers':[holder]}, 'lane original wait/binding absent')
        else:
            require('wait' not in row, 'metadata path incorrectly joined the identity lane')
        if name=='truncate_relation_then_refusal': require(row.get('sqlstate')=='55000','truncate refusal absent')
    rpc=cases[-1]
    table_id=str(uuid.uuid5(uuid.UUID(execution),'receipt-lane-zero-rake-table'))
    hand_id=str(uuid.uuid5(uuid.UUID(execution),'receipt-lane-zero-rake-hand'))
    expected={'success':True,'table_id':table_id,'hand_id':hand_id,
              'rake':{'success':True,'skipped':'zero_rake'},'commissions':[]}
    require(all(type(rpc.get(k)) is int and rpc[k]==v for k,v in
                {'before_receipt_count':0,'pre_entry_receipt_write_locks':0,'created_receipts':1,'rollback_receipts':0,'receipt_fk_count':0}.items())
            and rpc.get('request_compatibility_only') is True and rpc.get('first_result')==expected
            and rpc.get('replay_result')==expected, 'zero-rake request compatibility proof differs')
    one=rpc.get('receipt_before_replay',{})
    require(one==rpc.get('receipt_after_replay') and one.get('count')==1
            and isinstance(one.get('rows'),list) and len(one['rows'])==1, 'RPC replay receipt tuple changed')
    physical=one['rows'][0];row=physical.get('row',{})
    require(set(physical)=={'row','ctid','xmin','cmin'}
            and all(isinstance(physical[k],str) and physical[k] for k in ('ctid','xmin','cmin'))
            and row.get('table_id')==table_id and row.get('hand_id')==hand_id and row.get('status')=='succeeded'
            and row.get('result')==expected and row.get('error') is None and row.get('attempt_count')==1
            and isinstance(row.get('completed_at'),str) and row.get('first_attempt_at')==row.get('last_attempt_at')==row['completed_at'],
            'real zero-rake receipt contents or identity missing')
    before,after=value.get('before'),value.get('after')
    require(isinstance(before,dict) and set(before)=={'catalog','handler','business'} and before==after
            and before['handler'] == {'owner':'postgres','acl':'{postgres=X/postgres}',
                'body_md5':'534850c97847e72075044d8604b0a09d','config':['search_path=pg_catalog, public, pg_temp'],
                'security_definer':False,'volatility':'v'} and isinstance(before['business'],dict)
            and before['business'].get('public.hand_history')==[]
            and before['business'].get('public.settlement_idempotency_keys')==[], 'lane exact empty state/rollback differs')
    clients=value.get('clients',[])
    require(len(clients)==3 and {c.get('backend_pid') for c in clients}==set(ids.values())
            and all(c.get('client_exit')==0 and 'cleanup_error' not in c for c in clients)
            and value.get('backend_cleanup')=={'backends':0,'locks':0}, 'lane client/backend cleanup unproven')
    observer=value.get('verifier_client',{})
    require(type(observer.get('backend_pid')) is int and observer['backend_pid']>0
            and observer['backend_pid'] not in ids.values() and observer.get('client_exit')==0,
            'lane final observer terminal unknown')
    require(set(value.get('transcripts',{})) == {'lane_'+name+'_'+execution for name in ids}
            and all(isinstance(s,str) and s for s in value['transcripts'].values())
            and isinstance(value.get('cleanup_transcript'),str) and value['cleanup_transcript'],
            'lane original session transcripts missing')
    return value


def lane_outputs(outputs, result, execution, files):
    provider=lane_json(outputs['receipt_lane_provider'])
    require(provider=={'qualification':'receipt_lane_provider','exact_authority':True,
                      'financial_rows_seeded':False,'full_qualification':False}
            and all(type(provider.get(key)) is bool for key in ('exact_authority','financial_rows_seeded','full_qualification')),
            'lane provider result differs')
    catalog=lane_json(outputs['receipt_lane_catalog'])
    require(catalog == LANE_CATALOG and all(type(catalog[k]) is type(v) for k,v in LANE_CATALOG.items()),
            'lane catalog controls incomplete')
    before,after=(lane_json(outputs[name]) for name in ('receipt_lane_before','receipt_lane_after'))
    require(set(before)==set(after)=={'catalog','handler','business','relation_trigger_hints'}
            and before['handler'] is None and after['handler'] is None
            and all(before[key]==after[key] for key in ('catalog','business')),
            'lane guarded rollback changed full rows/catalog or retained private handler')
    # Preserve both raw physical hint values; never turn them into semantic trigger proof.
    for observation in (before,after):
        require(set(observation['relation_trigger_hints'])=={'hand_history','settlement_idempotency_keys'}
                and all(type(v) is bool for v in observation['relation_trigger_hints'].values()), 'raw trigger hints absent')
    validate_lane_races(decode(result), execution, files)
    return {'catalog':catalog,'result_sha256':digest(result),
            'observed_outputs':{name:digest(raw) for name,raw in outputs.items()},
            'guarded_rollback_verified':True,'historical_rows_qualified':False,
            'financial_completion_qualified':False,'full_qualification':False}


RETENTION_STAGES = {
    'retention_provider_authority': ('fixture_bootstrap', 'scripts/qualification/fixtures/spin-history-retention/provider-supplement.sql'),
    'retention_catalog_rollback': ('postgres', 'scripts/qualification/spin-history-retention.sql'),
    'retention_behavior_rollback': ('postgres', 'scripts/qualification/spin-history-retention-behavior.sql'),
}
RETENTION_CATALOG_MARKER = 'spin history retention catalog controls passed; business/race qualification separate'
RETENTION_SEQUENCES = frozenset(('public.content_authors_id_seq',
                               'public.managed_game_contract_versions_id_seq',
                               'smarter_private.f06_lifecycle_seq'))
FIXED_INPUTS = frozenset(('inputs/schema.sql', 'inputs/access.sql', 'inputs/policies.sql', 'principals.sql', 'provider-supplement.sql', 'provider-roles.sql', 'provider-roles-check.sql', 'provider-check.sql', 'empty-provider-check.sql', 'inputs/catalog-sequence-exact.json', 'inputs/spin-catalog-supplement.sql', 'inputs/entry-provider-supplement.sql', 'inputs/entry-sequence-authority.sql', 'inputs/settle-source-authority.sql', 'inputs/captured-financial-store-policy.sql', 'inputs/captured-spin-catalog.json', 'spin-catalog-observer.sql'))

def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def validate_server_endpoint(value, socket_path):
    # PG17 restricts unix_socket_directories to privileged diagnostic readers.
    # The existing fixture bootstrap checks server configuration; business
    # sessions retain their captured nonsuperuser roles and owned socket checks.
    require(value == {'user': 'fixture_bootstrap', 'session_user': 'fixture_bootstrap',
                      'port': '5432', 'address': None, 'listen_addresses': '',
                      'unix_socket_directories': str(socket_path)},
            'private server endpoint configuration differs')


def server_endpoint_command(PG, socket_path):
    return [str(PG / 'psql'), '-X', '-w', '-h', str(socket_path), '-p', '5432',
            '-U', 'fixture_bootstrap', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
            '-qAt', '-c', SERVER_ENDPOINT_QUERY]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def pin(data):
    return {'sha256': digest(data), 'bytes': len(data)}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'duplicate JSON member: ' + key)
        result[key] = value
    return result


def decode(data):
    return json.loads(data, object_pairs_hook=unique_object)


def safe_name(name):
    require(isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*', name)
            and all(part not in ('.', '..') for part in name.split('/'))
            and name != 'manifest.json', 'unsafe provider leaf')
    return name


def read_regular(path, limit):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= limit,
            'non-regular, linked or oversized source: ' + str(path))
    def identity(value):
        # Reading may legitimately update atime; mutation-relevant fields may not change.
        return (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid,
                value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
    with path.open('rb') as handle:
        require(identity(os.fstat(handle.fileno())) == identity(info), 'source changed before read')
        data = handle.read(limit + 1)
    require(len(data) == info.st_size and identity(path.lstat()) == identity(info), 'source changed during read')
    return data


class CleanupOutcome:
    def __init__(self):
        self.errors = []
        self.terminal = False

    def failed(self, error):
        self.errors.append(str(error))

    def observed_stopped(self):
        self.terminal = True

    def qualifies(self):
        return self.terminal and not self.errors


def command_budget(deadline, now, requested):
    if deadline is None:
        raise RuntimeError('cleanup deadline absent')
    # The three-second client exit wait stays inside the same original deadline.
    budget = min(requested, deadline - now - 3)
    if budget <= 0:
        raise TimeoutError('original command/cleanup deadline exhausted')
    return budget


def cleanup_negative_controls():
    clean = CleanupOutcome()
    if clean.qualifies():
        raise AssertionError('unobserved terminal accepted')
    clean.observed_stopped()
    if not clean.qualifies():
        raise AssertionError('clean terminal rejected')
    failed = CleanupOutcome()
    failed.failed('original fast-stop failure')
    failed.observed_stopped()  # A successful fallback must preserve the failure.
    if failed.qualifies() or failed.errors != ['original fast-stop failure']:
        raise AssertionError('fallback erased original cleanup failure')
    if command_budget(30, 0, 12) != 12 or command_budget(30, 20, 10) != 7:
        raise AssertionError('cleanup command received a new independent deadline')
    try:
        command_budget(30, 27, 10)
    except TimeoutError:
        return
    raise AssertionError('exhausted cleanup budget accepted')


def sequence_contract(row):
    expected = {'start': '1', 'increment': '1', 'minimum': '1',
                'maximum': '9223372036854775807', 'cache': '1'}
    for key, value in expected.items():
        if type(row.get(key)) is not str or not re.fullmatch(r'[0-9]+', row[key]) or row[key] != value:
            raise ValueError('sequence bound must be exact captured decimal TEXT: ' + key)
    if row.get('type') != 'bigint' or row.get('cycle') is not False:
        raise ValueError('sequence kind/cycle drift')
    return expected


def sequence_negative_controls(row):
    # Direct regression for the observed JSON bigint rounding; run before PG.
    sequence_contract(row)
    for bad in (9223372036854776000, float(9223372036854775807),
                '9223372036854776000', None, '9.223372036854776e18'):
        changed = dict(row, maximum=bad)
        try:
            sequence_contract(changed)
        except ValueError:
            continue
        raise AssertionError('unsafe sequence metadata accepted')


def canonical_uuid(value):
    parsed = str(uuid.UUID(value))
    if parsed != value:
        raise ValueError('canonical lowercase UUID required')
    return parsed


def owned_path(path, root, *, directory=False, private=False):
    require(path.is_absolute() and path.resolve() == path
            and (path == root or root in path.parents), 'noncanonical or escaping source path')
    for item in (path, *path.parents):
        info = item.lstat()
        require(not stat.S_ISLNK(info.st_mode) and info.st_uid == os.geteuid()
                and not info.st_mode & 0o022, 'foreign, symlink or writable source path: ' + str(item))
        if item == root: break
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode),
            'wrong source path kind')
    if private: require(stat.S_IMODE(info.st_mode) == 0o700, 'private directory mode required')


def load_fixture(directory):
    owned_path(directory, ROOT, directory=True)
    owned_path(directory / 'manifest.json', directory)
    raw = read_regular(directory / 'manifest.json', 262144)
    manifest = decode(raw)
    require(manifest.get('schemaVersion') == 1 and manifest.get('kind') == 'spin-expiry-hosted-fixture'
            and manifest.get('originManifestSha256') == ORIGIN_MANIFEST, 'fixture provenance mismatch')
    entries = manifest.get('files')
    require(isinstance(entries, dict) and set(entries) == FIXED_INPUTS, 'exact fixed input inventory required')
    files = {}
    for name, expected in entries.items():
        safe_name(name)
        require(isinstance(expected, dict) and set(expected) == {'sha256', 'bytes'}
                and type(expected['bytes']) is int and 0 < expected['bytes'] <= 16777216
                and isinstance(expected['sha256'], str)
                and re.fullmatch(r'[0-9a-f]{64}', expected['sha256']), 'malformed fixture pin')
        leaf = directory / name
        owned_path(leaf, directory)
        data = read_regular(leaf, 16777216)
        require(pin(data) == expected, 'fixture leaf mismatch: ' + name)
        files[name] = data
    actual, count = set(), 0
    for current, dirs, leaves in os.walk(directory, followlinks=False):
        for name in dirs + leaves:
            count += 1
            require(count <= 64, 'fixture inventory bound exceeded')
            item = Path(current) / name
            owned_path(item, directory, directory=name in dirs)
        actual.update((Path(current) / name).relative_to(directory).as_posix() for name in leaves)
    require(actual == FIXED_INPUTS | {'manifest.json'}, 'unpinned fixture leaves')
    return raw, manifest, files


def git_read(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args], env=CLEAN_ENV, timeout=5)


def pure_transaction_body(data, closing):
    # No parser or rewritten authority: only the exact single outer wrapper of
    # these two hash-pinned files is removed for the rollback-only native test.
    source = data.decode()
    require(source.count('\nBEGIN;\n') == 1 and source.endswith(closing + '\n'),
            'pure source transaction envelope differs')
    return source.replace('\nBEGIN;\n', '\n', 1)[:-len(closing + '\n')]


def validate_pure_sources(files):
    require(set(PURE_INPUTS) <= set(files), 'pure source inventory incomplete')
    require(digest(files[PURE_MANIFEST]) == PURE_MANIFEST_SHA256,
            'pure manifest differs from reviewed source')
    manifest = decode(files[PURE_MANIFEST])
    require(set(manifest['files']) == set(PURE_INPUTS) - {PURE_MANIFEST}, 'pure leaf inventory differs')
    for name, expected in manifest['files'].items():
        require(pin(files[name]) == expected, 'pure source pin mismatch: ' + name)
    require(manifest['full_qualification'] is False and manifest['stage'] == {
        'name': PURE_STAGE, 'role': 'postgres', 'path': PURE_QUALIFIER}, 'pure scope or role differs')
    require(digest(files[PURE_PREIMAGE]) == PURE_PREIMAGE_SHA256
            and manifest['regression_preimage'] == {
                'commit': '5ce406fbf32f562762910db2ed324839be01b683', 'path': PURE_COMPONENT, 'sha256': PURE_PREIMAGE_SHA256,
                'qualifier_input': PURE_PREIMAGE, 'control_sqlstate': 'PZ020',
                'control_message': 'mixed shape accepted relative modern commit timestamps'},
            'pure regression preimage provenance differs')
    qualifier = files[PURE_QUALIFIER].decode()
    expected_sources = {
        'mixed_component_source': {'path': PURE_COMPONENT, 'remove_outer_transaction': ['BEGIN;', 'COMMIT;']},
        'mixed_shape_source': {'path': PURE_SHAPE, 'remove_outer_transaction': ['BEGIN;', 'ROLLBACK;']},
        'mixed_preimage_source': {'path': PURE_PREIMAGE, 'remove_outer_transaction': ['BEGIN;', 'COMMIT;']}}
    require(manifest['embedded_sources'] == expected_sources, 'pure embedded source inventory differs')
    for delimiter, spec in expected_sources.items():
        parts = qualifier.split('$' + delimiter + '$')
        require(len(parts) == 3 and parts[1] == pure_transaction_body(
            files[spec['path']], spec['remove_outer_transaction'][1]), 'pure embedded source differs: ' + delimiter)
    graph = {}
    for name in manifest['files']:
        targets = []
        for line in files[name].decode().splitlines():
            if not line.lstrip().startswith('\\ir'): continue
            match = re.fullmatch(r'\\ir ([A-Za-z0-9_./-]+)', line.strip())
            require(match is not None, 'unsupported pure include directive')
            target = posixpath.normpath(posixpath.join(posixpath.dirname(name), match[1]))
            safe_name(target)
            require(target in manifest['files'], 'pure include outside exact consumed source')
            targets.append(target)
        if targets: graph[name] = targets
    require(graph == manifest['relative_include_graph'] == {PURE_QUALIFIER: [PURE_ORACLE]},
            'pure include graph differs')


def validate_pure_result(value):
    fixed = {'qualification': 'spin_mixed_basis_pure_evidence', 'shape_positive': 1,
             'shape_negative': 24, 'key_scalar_controls': 17, 'private_invocation_refusals': 9,
             'relative_timestamp_regression_reproduced': True, 'relative_timestamp_refusal_verified': True,
             'installed_authority_verified': True, 'missing_preimage_refused': True,
             'duplicate_install_refused': True, 'inner_and_outer_rollback_verified': True,
             'business_rows_unchanged': True, 'historical_original_rows_qualified': False,
             'statement_lane_qualified': False, 'financial_completion_qualified': False,
             'full_qualification': False}
    require(isinstance(value, dict) and set(value) == set(fixed), 'pure original JSON shape differs')
    for key, expected in fixed.items():
        require(type(value[key]) is type(expected) and value[key] == expected,
                'pure assertion differs: ' + key)
    return value


def pure_output(output):
    values = [decode(line) for line in output.splitlines() if line.lstrip().startswith(b'{')]
    require(len(values) == 1, 'pure original JSON absent or repeated')
    return validate_pure_result(values[0])


def validate_retention_sources(files):
    """Validate the frozen component/fixture and every relative staged include."""
    require(set(RETENTION_INPUTS) <= set(files), 'retention source inventory incomplete')
    require(digest(files[RETENTION_MANIFEST]) == RETENTION_MANIFEST_SHA256,
            'retention manifest differs from reviewed source')
    manifest = decode(files[RETENTION_MANIFEST])
    require(set(manifest['files']) == set(RETENTION_INPUTS) - {RETENTION_MANIFEST},
            'retention leaf inventory differs')
    for name, expected in manifest['files'].items():
        require(pin(files[name]) == expected, 'retention source pin mismatch: ' + name)
    shared = 'scripts/qualification/spin-expiry-business-state.sql'
    require(shared in files and pin(files[shared]) == manifest['unchanged_base_bindings'][shared],
            'retention shared rollback oracle drift')
    graph = {}
    for name in manifest['files']:
        if not name.endswith('.sql'): continue
        includes = []
        for line in files[name].decode().splitlines():
            if not line.lstrip().startswith('\\ir'): continue
            match = re.fullmatch(r'\\ir ([A-Za-z0-9_./-]+)', line.strip())
            require(match is not None, 'unsupported retention include directive')
            target = posixpath.normpath(posixpath.join(posixpath.dirname(name), match[1]))
            safe_name(target)
            require(target in files, 'retention include missing from staged source: ' + target)
            includes.append(target)
        if includes: graph[name] = includes
    require(graph == manifest['relative_include_graph'], 'retention include graph changed')
    require(manifest['stage_order'] == [{'role': role, 'path': path}
            for role, path in RETENTION_STAGES.values()], 'retention stage contract changed')


def validate_completed_sources(files):
    require(set(COMPLETED_INPUTS) <= set(files), 'completed retention source inventory incomplete')
    require(digest(files[COMPLETED_MANIFEST]) == COMPLETED_MANIFEST_SHA256,
            'completed retention manifest differs from reviewed source')
    manifest = decode(files[COMPLETED_MANIFEST])
    require(set(manifest['files']) == set(COMPLETED_INPUTS) - {COMPLETED_MANIFEST},
            'completed retention leaf inventory differs')
    for name, expected in manifest['files'].items():
        require(pin(files[name]) == expected, 'completed retention source pin mismatch: ' + name)
    # Preserve the author provenance separately; consume only the exact adopted
    # provider revision, including its native-discovered authority/comparison corrections.
    require(manifest['consumed_retention_manifest'] == {
        'path': RETENTION_MANIFEST, 'sha256': RETENTION_MANIFEST_SHA256,
        'all_existing_leaf_pins_match': True}, 'completed retention dependency revision differs')
    validate_retention_sources(files)
    graph = {}
    for name in manifest['files']:
        if not name.endswith('.sql'): continue
        includes = []
        for line in files[name].decode().splitlines():
            if not line.lstrip().startswith('\\ir'): continue
            match = re.fullmatch(r'\\ir ([A-Za-z0-9_./-]+)', line.strip())
            require(match is not None, 'unsupported completed retention include directive')
            target = posixpath.normpath(posixpath.join(posixpath.dirname(name), match[1]))
            safe_name(target)
            require(target in files, 'completed retention include missing from staged source: ' + target)
            includes.append(match[1])
        graph[name] = includes
    require(graph == manifest['relative_include_graph'], 'completed retention include graph changed')
    require(manifest['stage_order'][0]['path'] == COMPLETED_RESTORE
            and manifest['stage_order'][0]['role'] == 'fixture_bootstrap'
            and manifest['stage_order'][2]['path'] == COMPLETED_CONSUMER
            and manifest['stage_order'][2]['role'] == 'postgres', 'completed retention role contract changed')


def validate_sequence_observations(value):
    for key in ('sequence_before', 'sequence_after'):
        rows = value[key]
        require(isinstance(rows, dict) and set(rows) == RETENTION_SEQUENCES,
                'retention sequence observation inventory differs')
        for row in rows.values():
            require(isinstance(row, dict) and set(row) == {'last_value', 'is_called'}
                    and type(row['is_called']) is bool and type(row['last_value']) is str
                    and re.fullmatch(r'[1-9][0-9]*', row['last_value'])
                    and int(row['last_value']) <= 9223372036854775807,
                    'retention sequence observation must preserve exact decimal text')


def validate_completed_retention(value):
    fixed = {'qualification': 'spin_history_retention_completed_receipt_eligibility',
             'old_deleted': 1, 'candidate_deleted': 1, 'captured_receipt_unchanged': True,
             'projection_and_catalog_rollback_verified': True,
             'starting_estate_retained_until_database_disposal': True,
             'terminal_creation_qualified': False, 'financial_lifecycle_qualified': False,
             'multi_session_race_qualified': False, 'sequence_counters_restored': False,
             'source_capture_observed_at': COMPLETED_CAPTURE_TIME}
    require(isinstance(value, dict) and set(value) == set(fixed) | {'sequence_before', 'sequence_after'},
            'completed retention JSON shape differs')
    for key, expected in fixed.items():
        require(type(value[key]) is type(expected) and value[key] == expected,
                'completed retention assertion differs: ' + key)
    validate_sequence_observations(value)
    return value


def completed_retention_output(output):
    values = [decode(line) for line in output.splitlines() if line.lstrip().startswith(b'{')]
    require(len(values) == 1, 'completed retention original JSON absent or repeated')
    return validate_completed_retention(values[0])


def completed_sql_stages(source):
    # Insertion order is the actual required restore/trigger/consumer protocol.
    stages = {
        'schema_prefix': ('fixture_bootstrap', str(source.parent / 'work/schema-prefix.sql')),
        'restore_preexisting_principals': ('fixture_bootstrap', 'principals.sql'),
        'empty_provider_readback': ('fixture_bootstrap', 'empty-provider-check.sql'),
        'restore_completed_start': ('fixture_bootstrap', COMPLETED_RESTORE),
        'schema_suffix_all_real_triggers': ('fixture_bootstrap', str(source.parent / 'work/schema-suffix.sql')),
        'authentic_access': ('fixture_bootstrap', 'inputs/access.sql'),
        'authentic_policies': ('fixture_bootstrap', 'inputs/policies.sql'),
        'current_notification_supplement': ('fixture_bootstrap', 'provider-supplement.sql'),
        'current_tested_roles': ('fixture_bootstrap', 'provider-roles.sql'),
        'tested_role_readback': ('fixture_bootstrap', 'provider-roles-check.sql'),
        'current_catalog_readback': ('fixture_bootstrap', 'provider-check.sql'),
        'authentic_spin_catalog_supplement': ('fixture_bootstrap', 'inputs/spin-catalog-supplement.sql'),
        'authentic_entry_provider_supplement': ('fixture_bootstrap', 'inputs/entry-provider-supplement.sql'),
        'authentic_entry_sequence_authority': ('fixture_bootstrap', 'inputs/entry-sequence-authority.sql'),
        'authentic_settlement_source_authority': ('fixture_bootstrap', 'inputs/settle-source-authority.sql'),
        'retention_provider_authority': RETENTION_STAGES['retention_provider_authority'],
        PURE_STAGE: ('postgres', PURE_QUALIFIER),
        'retention_completed_eligibility': ('postgres', COMPLETED_CONSUMER),
    }
    return stages


def validate_retention_behavior(value):
    fixed = {'qualification': 'spin_history_retention_behavior', 'old_deleted': 5,
             'candidate_deleted': 2, 'canonical_cancellation_count': 2,
             'table_and_catalog_rollback_verified': True, 'sequence_counters_restored': False,
             'completed_spin_qualified': False, 'multi_session_race_qualified': False}
    require(isinstance(value, dict) and set(value) == set(fixed) | {'sequence_before', 'sequence_after'},
            'retention behavior JSON shape differs')
    for key, expected in fixed.items():
        require(type(value[key]) is type(expected) and value[key] == expected,
                'retention behavior assertion differs: ' + key)
    validate_sequence_observations(value)
    return value


def retention_output(catalog, behavior):
    require(catalog.splitlines().count(RETENTION_CATALOG_MARKER.encode()) == 1,
            'retention catalog original success marker absent or repeated')
    values = [decode(line) for line in behavior.splitlines() if line.lstrip().startswith(b'{')]
    require(len(values) == 1, 'retention behavior original JSON absent or repeated')
    return validate_retention_behavior(values[0])


def qualification_sql_argv(PG, source, execution, ordinary, tournament, user, path):
    return [str(PG / 'psql'), '-X', '-w', '-A', '-t', '-h', str(source.parent / 'work/socket'),
            '-p', '5432', '-U', user, '-d', 'qual_spin_expiry_' + execution.replace('-', ''),
            '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
            '-v', 'execution_uuid=' + execution, '-v', 'ordinary_user_uuid=' + ordinary,
            '-v', 'tournament_uuid=' + tournament, '-f', str(source / path)]


def source_packet():
    head = git_read('rev-parse', 'HEAD').decode().strip()
    tree = git_read('rev-parse', 'HEAD^{tree}').decode().strip()
    require(re.fullmatch(r'[0-9a-f]{40}', head) and re.fullmatch(r'[0-9a-f]{40}', tree), 'invalid checkout identity')
    raw, fixture_manifest, fixed = load_fixture(FIXTURE)
    # Static inputs and maintained qualification code must be exactly committed.
    relative = (FIXTURE / 'manifest.json').relative_to(ROOT).as_posix()
    require(git_read('show', head + ':' + relative) == raw, 'fixture manifest differs from checkout HEAD')
    for name, data in fixed.items():
        relative = (FIXTURE / name).relative_to(ROOT).as_posix()
        require(git_read('show', head + ':' + relative) == data, 'fixture differs from checkout HEAD: ' + name)
    copied = dict(fixed)
    for name in REPLACEMENTS:
        owned_path(ROOT / name, ROOT)
        actual = read_regular(ROOT / name, 1048576)
        require(git_read('show', head + ':' + name) == actual, 'qualification source differs from checkout HEAD: ' + name)
        copied[name] = actual
    for name in ('scripts/ci/test-spin-expiry-postgres.py', 'scripts/ci/test_spin_expiry_wrapper.py'):
        actual = read_regular(ROOT / name, 1048576)
        require(git_read('show', head + ':' + name) == actual, 'wrapper source differs from checkout HEAD: ' + name)
    validate_completed_sources(copied)
    validate_pure_sources(copied)
    validate_lane_sources(copied)
    manifest = {'schemaVersion': 1, 'kind': 'spin-expiry-hosted-attempt',
                'checkout': {'head': head, 'tree': tree}, 'fixtureManifestSha256': digest(raw),
                'fixtureProvenance': fixture_manifest,
                'files': {name: pin(data) for name, data in copied.items()}}
    return manifest, copied


def stage_packet(allocation, manifest, files):
    owned_path(allocation, allocation, directory=True, private=True)
    require(set(files) == FIXED_INPUTS | set(REPLACEMENTS)
            and set(manifest['files']) == set(files), 'source inventory incomplete')
    source = allocation / 'source'; source.mkdir(mode=0o700)
    for name, data in files.items():
        safe_name(name)
        require(pin(data) == manifest['files'][name], 'source bytes differ before staging')
        leaf = source / name; leaf.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with leaf.open('xb') as handle:
            handle.write(data); handle.flush(); os.fsync(handle.fileno())
        leaf.chmod(0o400)
    raw = (json.dumps(manifest, indent=2) + '\n').encode()
    with (source / 'manifest.json').open('xb') as handle: handle.write(raw)
    (source / 'manifest.json').chmod(0o400)
    verify_packet(source, raw, manifest)
    return raw


def verify_packet(source, raw, manifest):
    owned_path(source, source, directory=True, private=True)
    require(read_regular(source / 'manifest.json', 262144) == raw, 'staged manifest changed')
    actual = set()
    for current, dirs, leaves in os.walk(source, followlinks=False):
        for name in dirs:
            owned_path(Path(current) / name, source, directory=True)
        for name in leaves:
            leaf = Path(current) / name; owned_path(leaf, source)
            actual.add(leaf.relative_to(source).as_posix())
    require(actual == set(manifest['files']) | {'manifest.json'}, 'staged inventory changed')
    files = {}
    for name, expected in manifest['files'].items():
        files[name] = read_regular(source / name, 16777216)
        require(pin(files[name]) == expected, 'staged source changed: ' + name)
    validate_completed_sources(files)
    validate_pure_sources(files)
    validate_lane_sources(files)


def find_pg():
    requested = os.environ.get('PG_BIN')
    require(requested and Path(requested).is_absolute(), 'PG_BIN must name existing PostgreSQL17 tools')
    pg = Path(requested).resolve()
    for name in ('postgres', 'initdb', 'pg_ctl', 'psql', 'createdb'):
        require((pg / name).is_file() and os.access(pg / name, os.X_OK), 'missing PostgreSQL binary: ' + name)
    return pg


def process_group_absent(pid):
    try: os.killpg(pid, 0)
    except ProcessLookupError: return True
    return False


def finish_clients(clients, deadline, outcome):
    terminal = True
    for child, entry in clients:
        try:
            if child.poll() is None or not process_group_absent(child.pid):
                outcome.failed('original command process group required forced cleanup: ' + str(child.pid))
                try: os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError: pass
            if child.poll() is None:
                child.wait(timeout=command_budget(deadline, time.monotonic(), 2))
            entry['terminal_returncode'] = child.returncode
            # One original cleanup deadline; no new per-iteration time allowance.
            while not process_group_absent(child.pid):
                remaining = deadline - time.monotonic()
                require(remaining > 0, 'original process group cleanup deadline exhausted')
                time.sleep(min(0.02, remaining))
            require(child.returncode is not None, 'original client exit unobserved')
        except BaseException as error:
            terminal = False
            outcome.failed(error)
    return terminal


def validate_case_result(case, raw, execution, tournament, image):
    if case == 'committed-refund':
        records = [decode(line) for line in raw.splitlines()]
        require(records and records[-1].get('event') == 'terminal_source_oracle_result'
                and records[-1].get('observed') is True
                and records[-1].get('client_and_server_cleanup') is True
                and records[-1].get('source_stable') is True
                and records[0].get('execution') == execution
                and records[0].get('tournament') == tournament,
                'original committed-refund terminal lacks required evidence')
    else:
        result = decode(raw)
        require(result.get('scenario_observed') is True and result.get('cleanup_verified') is True
                and result.get('source_stable') is True and result.get('execution') == execution
                and result.get('fixture_tournament') == tournament
                and result.get('image') == image and result.get('case') == case
                and result.get('selected_before') == result.get('selected_after')
                and result.get('authority_before') == result.get('authority_after'),
                'original order/timeout result lacks exact required evidence')


def business_stage_name(case):
    require(case in CASE_RESULTS, 'unknown business case')
    return 'actual_business_' + case.replace('-', '_')


def retained_evidence(work, output, receipt, source_manifest):
    # Exact allowlist: no PGDATA, homes, passwords, arbitrary worktrees or env.
    names = {'receipt.json', 'postgres.log', LANE_RESULT} | set(CASE_RESULTS.values())
    for stage in receipt.get('stages', []):
        name = stage['stage']
        require(re.fullmatch(r'[a-z0-9_]+', name), 'unsafe evidence stage name')
        names.update((name + '.stdout', name + '.stderr'))
    mandatory = {'receipt.json'}
    if receipt.get('receipt_lane_qualification') is not None: mandatory.add(LANE_RESULT)
    for stage in receipt.get('stages', []):
        mandatory.update((stage['stage'] + '.stdout', stage['stage'] + '.stderr'))
    mandatory.update(case['result_path'] for case in receipt.get('business_cases', []) if case.get('state') == 'passed')
    require(all((work / name).exists() for name in mandatory), 'original evidence leaf missing')
    kept = {}
    for name in sorted(names):
        leaf = work / name
        if not leaf.exists(): continue
        owned_path(leaf, work)
        data = read_regular(leaf, 33554432)
        with (output / name).open('xb') as handle: handle.write(data)
        kept[name] = pin(data)
    (output / 'source-manifest.json').write_bytes(source_manifest)
    (output / 'evidence-manifest.json').write_text(json.dumps(kept, indent=2) + '\n')
    return kept


def qualify(args, allocation, manifest_bytes, manifest, PG):
    ROOT = allocation / 'source'
    verify_packet(ROOT, manifest_bytes, manifest)
    embedded = (ROOT / 'scripts/qualification/spin-expiry-lock-order.component-inputs.sql').read_text()
    for label, name in [('forward', 'spin-expiry-lock-order.sql'),
                        ('rollback', 'spin-expiry-lock-order.rollback.sql')]:
        delimiter = '$spin_expiry_' + label + '_source$'
        parts = embedded.split(delimiter)
        if len(parts) != 3 or parts[1] != (ROOT / 'supabase/components' / name).read_text():
            raise ValueError('catalog embedded component differs from exact checkout: ' + label)
    row = json.loads((ROOT / 'inputs/catalog-sequence-exact.json').read_text())['rows'][0]
    bounds = sequence_contract(row)
    sequence_negative_controls(row)
    cleanup_negative_controls()
    identity = ('START WITH ' + bounds['start'] + ' INCREMENT BY ' + bounds['increment']
                + ' MINVALUE ' + bounds['minimum'] + ' MAXVALUE ' + bounds['maximum']
                + ' CACHE ' + bounds['cache'] + ' NO CYCLE')
    if (ROOT / 'provider-supplement.sql').read_text().count(identity) != 1:
        raise ValueError('sequence overlay no longer matches exact text authority')
    schema = (ROOT / 'inputs/schema.sql').read_bytes()
    if schema.count(MARKER) != 1:
        raise ValueError('authentic first-trigger boundary ambiguous')
    prefix, suffix = schema.split(MARKER)
    suffix = MARKER + suffix
    if b'CREATE TRIGGER ' in prefix or b'CREATE CONSTRAINT TRIGGER ' in prefix or prefix + suffix != schema:
        raise ValueError('trigger prefix boundary/reassembly drift')
    work = allocation / 'work'
    work.mkdir(mode=0o700)  # Existing allocation work refuses; no retry/resume.
    (work / 'home').mkdir(mode=0o700)
    (work / 'socket').mkdir(mode=0o700)
    (work / 'schema-prefix.sql').write_bytes(prefix)
    (work / 'schema-suffix.sql').write_bytes(suffix)
    data = work / 'data'
    deadline = time.monotonic() + 240
    cleanup_deadline = None
    receipt = {'execution': args.execution, 'source_manifest_sha256': hashlib.sha256(manifest_bytes).hexdigest(),
               'native_status': 'running', 'stages': [], 'full_qualification': False,
               'business_scenario_passed': False, 'business_qualified': False,
               'catalog_slice_passed': False, 'retention_qualification': None,
               'completed_retention_qualification': None, 'mixed_pure_qualification': None,
               'receipt_lane_qualification': None,
               'image': args.image, 'tournament': args.tournament, 'business_cases': [],
               'qualification_scope': ('captured completed-receipt retention eligibility only' if args.image == 'retention-completed'
                                       else 'one authentic funded Spin expiry schedule'),
               'connected_services_qualified': False, 'cleanup_verified': False,
               'execution_backend': 'hosted-owned-pg17-unix-socket',
               'work_deadline_seconds': 240, 'cleanup_deadline_seconds': 30,
               'pg_binary_sha256': {name: hashlib.sha256((PG / name).read_bytes()).hexdigest()
                                    for name in ('postgres', 'psql', 'initdb', 'pg_ctl', 'createdb')}}
    passfile = work / 'home/.spin-expiry.pgpass'
    with passfile.open('xb'): pass
    passfile.chmod(0o600)
    clients = []
    original_pid = None
    env = {'PGPASSFILE': str(passfile), 'PSQL_HISTORY': '/dev/null', 'PATH': str(PG) + ':/usr/bin:/bin', 'HOME': str(work / 'home'),
           'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'PGCONNECT_TIMEOUT': '3',
           'PGAPPNAME': 'spin5-business-' + args.execution,
           'PYTHONDONTWRITEBYTECODE': '1',
           'PGOPTIONS': '-c qualification.execution_uuid=' + args.execution}

    def persist():
        target = work / 'receipt.json'
        temp = work / 'receipt.tmp'
        with temp.open('w') as handle:
            json.dump(receipt, handle, indent=2); handle.write('\n'); handle.flush(); os.fsync(handle.fileno())
        os.replace(temp, target)

    def command(stage, command_args, *, timeout=30, cleanup=False, allow=(0,)):
        active_deadline = cleanup_deadline if cleanup else deadline
        budget = command_budget(active_deadline, time.monotonic(), timeout)
        entry = {'stage': stage, 'started_monotonic': time.monotonic(), 'argv': command_args}
        receipt['stages'].append(entry); persist()
        stdout = work / (stage + '.stdout'); stderr = work / (stage + '.stderr')
        with stdout.open('wb') as out, stderr.open('wb') as err:
            child = subprocess.Popen(command_args, stdout=out, stderr=err, env=env, start_new_session=True)
            entry['pid'] = child.pid
            clients.append((child, entry))
            try:
                child.wait(timeout=budget)
            except BaseException as interrupted:
                entry['client_deadline_exceeded'] = True
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait(timeout=max(0.001, min(3, active_deadline - time.monotonic())))
                entry['returncode'] = child.returncode; persist()
                raise RuntimeError('client interrupted; database effect/cleanup remains unknown: ' + stage) from interrupted
        entry['returncode'] = child.returncode
        entry['stdout_sha256'] = hashlib.sha256(stdout.read_bytes()).hexdigest()
        entry['stderr_sha256'] = hashlib.sha256(stderr.read_bytes()).hexdigest()
        persist()
        if child.returncode not in allow:
            raise RuntimeError('stage failed: ' + stage)
        return stdout.read_text()

    db = 'qual_spin_expiry_' + args.execution.replace('-', '')
    vars_ = ['-v', 'execution_uuid=' + args.execution, '-v', 'ordinary_user_uuid=' + args.ordinary_user,
             '-v', 'tournament_uuid=' + args.tournament]

    def sql(stage, path, user='fixture_bootstrap'):
        cmd = [str(PG / 'psql'), '-X', '-w', '-A', '-t', '-h', str(work / 'socket'),
               '-p', '5432', '-U', user, '-d', db, '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'] + vars_
        return command(stage, cmd + ['-f', str(path)], timeout=70)

    failed = None
    pg_attempted = False
    try:
        version = command('pg_version', [str(PG / 'postgres'), '--version'], timeout=3)
        if not re.fullmatch(r'postgres \(PostgreSQL\) 17(?:\.[0-9]+)?[^\n]*\n?', version):
            raise ValueError('PG17 required')
        command('initdb', [str(PG / 'initdb'), '-D', str(data), '-U', 'fixture_bootstrap',
                          '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8'], timeout=30)
        with (data / 'postgresql.conf').open('a') as handle:
            handle.write("\nlisten_addresses=''\nport=5432\nunix_socket_directories='" + str(work / 'socket')
                         + "'\nunix_socket_permissions=0700\nshared_buffers='32MB'\nwork_mem='4MB'\nmaintenance_work_mem='64MB'\nmax_connections=8"
                         + "\nmax_worker_processes=0\nmax_parallel_workers=0\nmax_wal_senders=0\nwal_level=logical"
                         + "\nstatement_timeout='20s'\nlock_timeout='3s'\nidle_in_transaction_session_timeout='20s'\n")
        pg_attempted = True
        command('pg_start', [str(PG / 'pg_ctl'), '-D', str(data), '-l', str(work / 'postgres.log'), '-w', '-t', '12', 'start'], timeout=15)
        original_pid = int((data / 'postmaster.pid').read_text().splitlines()[0])
        bootstrap = [str(PG / 'psql'), '-X', '-w', '-h', str(work / 'socket'), '-p', '5432', '-U', 'fixture_bootstrap', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1']
        server_endpoint = decode(command('server_endpoint_readback',
            server_endpoint_command(PG, work / 'socket'), timeout=5))
        validate_server_endpoint(server_endpoint, work / 'socket')
        receipt['server_endpoint'] = server_endpoint
        persist()
        extension_query = "SELECT json_build_object('pgcrypto',EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='pgcrypto'),'uuid-ossp',EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='uuid-ossp'),'pg_trgm_1_6',EXISTS(SELECT 1 FROM pg_available_extension_versions WHERE name='pg_trgm' AND version='1.6'));"
        extensions = decode(command('extension_availability', bootstrap + ['-qAt', '-c', extension_query], timeout=5))
        require(extensions == {'pgcrypto': True, 'uuid-ossp': True, 'pg_trgm_1_6': True}, 'required authentic PostgreSQL extensions unavailable')
        command('create_sql_owner', bootstrap + ['-c', 'CREATE ROLE postgres NOSUPERUSER INHERIT LOGIN CREATEDB CREATEROLE REPLICATION BYPASSRLS'], timeout=5)
        command('create_database', [str(PG / 'createdb'), '-w', '-h', str(work / 'socket'), '-p', '5432', '-U', 'fixture_bootstrap', '-O', 'postgres', db], timeout=5)
        sql('schema_prefix', work / 'schema-prefix.sql')
        sql('restore_preexisting_principals', ROOT / 'principals.sql')
        if args.image == 'retention-completed':
            sql('empty_provider_readback', ROOT / 'empty-provider-check.sql')
            sql('restore_completed_start', ROOT / COMPLETED_RESTORE)
        sql('schema_suffix_all_real_triggers', work / 'schema-suffix.sql')
        sql('authentic_access', ROOT / 'inputs/access.sql')
        sql('authentic_policies', ROOT / 'inputs/policies.sql')
        sql('current_notification_supplement', ROOT / 'provider-supplement.sql')
        sql('current_tested_roles', ROOT / 'provider-roles.sql')
        sql('tested_role_readback', ROOT / 'provider-roles-check.sql')
        sql('current_catalog_readback', ROOT / 'provider-check.sql')
        if args.image != 'retention-completed':
            sql('empty_provider_readback', ROOT / 'empty-provider-check.sql')
        sql('authentic_spin_catalog_supplement', ROOT / 'inputs/spin-catalog-supplement.sql')
        sql('authentic_entry_provider_supplement', ROOT / 'inputs/entry-provider-supplement.sql')
        sql('authentic_entry_sequence_authority', ROOT / 'inputs/entry-sequence-authority.sql')
        sql('authentic_settlement_source_authority', ROOT / 'inputs/settle-source-authority.sql')
        role, path = RETENTION_STAGES['retention_provider_authority']
        retention_provider_original = sql('retention_provider_authority', ROOT / path, user=role)
        # The shared observer references this authentic pruner authority at CREATE.
        # Pure controls follow that existing setup in every image, before funding.
        pure_original = sql(PURE_STAGE, ROOT / PURE_QUALIFIER, user='postgres')
        receipt['mixed_pure_qualification'] = pure_output(pure_original.encode())
        persist()
        if args.image == 'retention-completed':
            original = sql('retention_completed_eligibility', ROOT / COMPLETED_CONSUMER, user='postgres')
            receipt['completed_retention_qualification'] = completed_retention_output(original.encode())
            # The finally block still proves cleanup/source stability. This
            # committed logical starting estate never reaches funding or cases.
            persist()
            return receipt
        if args.image == 'candidate':
            lane_original = {}
            for name,path in LANE_STAGES.items():
                if name == LANE_PHASE:
                    lane_original[name] = command(name, lane_program_argv(PG,ROOT,args.execution), timeout=30).encode()
                else:
                    lane_original[name] = sql(name,ROOT/path,user='postgres').encode()
            lane_files = {name:(ROOT/name).read_bytes() for name in LANE_INPUTS}
            receipt['receipt_lane_qualification'] = lane_outputs(lane_original,(work/LANE_RESULT).read_bytes(),
                                                               args.execution,lane_files)
            persist()
        # Same finite allocation and original deadline. The rollback-only estate
        # precedes funding; it does not qualify completed-terminal or race behavior.
        retention_stdout = {'retention_provider_authority': retention_provider_original.encode()}
        for stage, (role, path) in list(RETENTION_STAGES.items())[1:]:
            retention_stdout[stage] = sql(stage, ROOT / path, user=role).encode()
        receipt['retention_qualification'] = retention_output(
            retention_stdout['retention_catalog_rollback'], retention_stdout['retention_behavior_rollback'])
        persist()
        if args.image == 'candidate':
            # Retain the already proven catalog guard in the SAME required CI
            # allocation, so future qualifier/rollback changes cannot skip it.
            before = sql('spin_catalog_before', ROOT / 'spin-catalog-observer.sql', user='postgres')
            sql('spin_catalog_rollback_qualification',
                ROOT / 'scripts/qualification/spin-expiry-lock-order.sql', user='postgres')
            after = sql('spin_catalog_after', ROOT / 'spin-catalog-observer.sql', user='postgres')
            if before != after:
                raise AssertionError('selected catalog changed after rollback-only qualification')
            receipt['catalog_slice_passed'] = True
            sql('install_candidate', ROOT / 'supabase/components/spin-expiry-lock-order.sql', user='postgres')
        sql('real_funded_paid_seat_fixture',
            ROOT / 'scripts/qualification/spin-expiry-real-funded-fixture.sql', user='postgres')
        # A positive one-minute policy is explicitly admitted for this isolated
        # fixture. Never mutate joined_at or hold a transaction open while aging.
        # This is one finite wait, not a retry, observer loop or state repair.
        if deadline - time.monotonic() < (95 if args.image == 'preimage' else 155):
            raise TimeoutError('insufficient original budget for natural aging and bounded schedule')
        receipt['natural_aging'] = {'started_monotonic': time.monotonic(), 'seconds': 65}
        persist()
        time.sleep(65)
        receipt['natural_aging']['finished_monotonic'] = time.monotonic()
        # One database/allocation identity is shared only by the candidate's
        # explicit serial cases. Both rollback cases independently prove exact
        # business/catalog restoration plus client/backend cleanup before reuse.
        # The only committing case is last. Failure or unknown outcome stops the
        # allocation immediately; no case is retried or resumed.
        cases = CASES[args.image]
        for ordinal, case in enumerate(cases, start=1):
            case_record = {'case': case, 'case_identity': args.execution + ':' + str(ordinal) + ':' + case,
                           'execution': args.execution, 'state': 'running'}
            receipt['business_cases'].append(case_record)
            persist()
            command_args = [sys.executable]
            common = ['--psql', str(PG / 'psql'), '--execution', args.execution,
                      '--tournament', args.tournament]
            if case == 'committed-refund':
                result_path = work / 'committed-refund.jsonl'
                command_args += [str(ROOT / 'scripts/qualification/spin-expiry-committed-refund.py')]
                command_args += common + ['--journal', str(result_path)]
            else:
                result_path = work / ('business-' + case + '.json')
                command_args += [str(ROOT / 'scripts/qualification/spin-expiry-business-races.py')]
                command_args += common + ['--image', args.image, '--case', case,
                                          '--output', str(result_path)]
            command(business_stage_name(case), command_args, timeout=30)
            validate_case_result(case, result_path.read_bytes(), args.execution, args.tournament, args.image)
            case_record.update(state='passed', result_sha256=hashlib.sha256(result_path.read_bytes()).hexdigest(),
                               result_path=str(result_path.relative_to(work)))
            persist()
        receipt['business_scenario_passed'] = True
    except BaseException as error:
        failed = str(error)
        receipt['failure'] = {'type': type(error).__name__, 'message': str(error)}
    finally:
        # A killed client, timeout, or failed stop command is never terminal proof.
        cleanup_outcome = CleanupOutcome()
        cleanup_deadline = time.monotonic() + 30
        for sig in (signal.SIGINT, signal.SIGTERM): signal.signal(sig, signal.SIG_IGN)
        pg_terminal = not pg_attempted
        try:
            if pg_attempted:
                pidfile = data / 'postmaster.pid'
                if pidfile.exists():
                    observed_pid = int(pidfile.read_text().splitlines()[0])
                    require(original_pid in (None, observed_pid), 'original PostgreSQL identity changed')
                    original_pid = observed_pid
                try:
                    command('pg_stop_fast', [str(PG / 'pg_ctl'), '-D', str(data), '-w', '-t', '10', '-m', 'fast', 'stop'], timeout=12, cleanup=True)
                except Exception as first:
                    receipt['fast_stop_failure'] = str(first)
                    cleanup_outcome.failed(first)
                    command('pg_stop_immediate', [str(PG / 'pg_ctl'), '-D', str(data), '-w', '-t', '8', '-m', 'immediate', 'stop'], timeout=10, cleanup=True)
                command('pg_stopped_readback', [str(PG / 'pg_ctl'), '-D', str(data), 'status'], timeout=3, cleanup=True, allow=(3,))
                if pidfile.exists() or (original_pid is not None and Path('/proc', str(original_pid)).exists()) or (work / 'socket/.s.PGSQL.5432').exists():
                    raise RuntimeError('owned PostgreSQL process/socket absence not proved')
            pg_terminal = True
        except BaseException as error:
            cleanup_outcome.failed(error)
        clients_terminal = finish_clients(clients, cleanup_deadline, cleanup_outcome)
        receipt['original_clients_terminal'] = clients_terminal
        if pg_terminal and clients_terminal:
            cleanup_outcome.observed_stopped()
        receipt['cleanup_verified'] = cleanup_outcome.terminal
        receipt['cleanup_errors'] = cleanup_outcome.errors
        try:
            verify_packet(ROOT, manifest_bytes, manifest)
            receipt['source_stable'] = True
        except BaseException as error:
            receipt['source_stable'] = False
            receipt['source_readback_error'] = str(error)
        success = ('retention_completed_eligibility_passed_cleanup_observed' if args.image == 'retention-completed'
                   else 'business_scenario_passed_cleanup_observed')
        receipt['native_status'] = success if failed is None and cleanup_outcome.qualifies() and receipt['source_stable'] else 'failed_or_unknown'
        receipt['postmaster_pid'] = original_pid
        receipt['hosted_cleanup_observed'] = cleanup_outcome.qualifies()
        persist()
    return receipt


def validate_receipt(receipt, execution, ordinary, tournament, image, manifest_sha,
                     source, PG):
    require(image in IMAGES, 'unknown FIFO5 image')
    require(receipt.get('execution') == execution and receipt.get('source_manifest_sha256') == manifest_sha
            and receipt.get('image') == image and receipt.get('tournament') == tournament,
            'wrong/stale qualification receipt')
    validate_pure_result(receipt.get('mixed_pure_qualification'))
    completed = image == 'retention-completed'
    status = ('retention_completed_eligibility_passed_cleanup_observed' if completed
              else 'business_scenario_passed_cleanup_observed')
    require(receipt.get('native_status') == status
            and receipt.get('business_scenario_passed') is (not completed) and receipt.get('cleanup_verified') is True
            and receipt.get('cleanup_errors') == [] and receipt.get('source_stable') is True
            and 'failure' not in receipt, 'business scenario or cleanup did not qualify')
    require(receipt.get('full_qualification') is False and receipt.get('connected_services_qualified') is False
            and receipt.get('business_qualified') is False, 'unexpected claim beyond observed schedules')
    require(receipt.get('execution_backend') == 'hosted-owned-pg17-unix-socket'
            and receipt.get('hosted_cleanup_observed') is True
            and receipt.get('original_clients_terminal') is True, 'hosted terminal observation absent')
    require(receipt.get('catalog_slice_passed') is (image == 'candidate'), 'catalog qualification outcome mismatch')
    stages = receipt.get('stages')
    require(isinstance(stages, list) and 0 < len(stages) <= 64, 'missing bounded original stage evidence')
    require(all(isinstance(stage, dict) for stage in stages), 'invalid original stage')
    names = [stage.get('stage') for stage in stages]
    validate_server_endpoint(receipt.get('server_endpoint'), source.parent / 'work/socket')
    require(names.count('server_endpoint_readback') == 1, 'server endpoint readback absent or repeated')
    endpoint_index = names.index('server_endpoint_readback')
    endpoint_stage = stages[endpoint_index]
    require(endpoint_stage.get('returncode') == 0
            and endpoint_stage.get('argv') == server_endpoint_command(PG, source.parent / 'work/socket'),
            'server endpoint readback identity or outcome differs')
    catalog = ['spin_catalog_before', 'spin_catalog_rollback_qualification', 'spin_catalog_after']
    completed_inputs = completed_sql_stages(source)
    if completed:
        expected = list(completed_inputs)
        require(receipt.get('retention_qualification') is None and 'natural_aging' not in receipt,
                'completed estate cannot qualify unfinished retention or funded aging')
        validate_completed_retention(receipt.get('completed_retention_qualification'))
        require(not any(name in names for name in catalog + ['install_candidate',
                    'real_funded_paid_seat_fixture', 'retention_catalog_rollback', 'retention_behavior_rollback']),
                'completed receipt estate reached unrelated catalog or financial stages')
    else:
        expected = ['authentic_settlement_source_authority', 'retention_provider_authority',
                    PURE_STAGE, *(list(LANE_STAGES) if image=='candidate' else []), *list(RETENTION_STAGES)[1:]]
        expected += (catalog + ['install_candidate'] if image == 'candidate' else []) + ['real_funded_paid_seat_fixture']
        expected += [business_stage_name(case) for case in CASES[image]]
        require(receipt.get('completed_retention_qualification') is None
                and not any(name in names for name in ('restore_completed_start', 'retention_completed_eligibility')),
                'completed starting estate contaminated a financial image')
    lane = receipt.get('receipt_lane_qualification')
    if image == 'candidate':
        require(isinstance(lane,dict) and lane.get('catalog')==LANE_CATALOG
                and lane.get('guarded_rollback_verified') is True
                and all(lane.get(k) is False for k in ('full_qualification','historical_rows_qualified','financial_completion_qualified'))
                and re.fullmatch(r'[0-9a-f]{64}',lane.get('result_sha256','')) is not None
                and set(lane.get('observed_outputs',{}))==set(LANE_STAGES), 'lane qualification receipt incomplete')
        for name in LANE_STAGES:
            matching=[x for x in stages if x['stage']==name]
            require(len(matching)==1 and matching[0].get('stdout_sha256')==lane['observed_outputs'][name],
                    'lane original output identity missing')
    else:
        require(lane is None and not any(name in names for name in LANE_STAGES),
                'lane phase must remain solely in original candidate allocation')
    require(all(names.count(name) == 1 for name in expected)
            and [names.index(name) for name in expected] == sorted(names.index(name) for name in expected),
            'original phase sequence absent or repeated')
    require(endpoint_index < min(names.index(name) for name in expected),
            'server endpoint readback must precede qualification and financial setup')
    if image == 'preimage':
        require(not any(name in names for name in catalog + ['install_candidate']),
                'candidate installation or catalog execution in preimage allocation')
    elif image == 'candidate':
        before, after = (stages[names.index(name)].get('stdout_sha256')
                         for name in ('spin_catalog_before', 'spin_catalog_after'))
        require(isinstance(before, str) and re.fullmatch(r'[0-9a-f]{64}', before) and before == after,
                'original catalog observer bytes changed or missing')
    require([name for name in names if isinstance(name, str) and name.startswith('actual_business_')]
            == [business_stage_name(case) for case in CASES[image]], 'unexpected or reordered business invocation')
    if not completed:
        validate_retention_behavior(receipt.get('retention_qualification'))
    sql_inputs = {
        'authentic_settlement_source_authority': 'inputs/settle-source-authority.sql',
        PURE_STAGE: PURE_QUALIFIER,
        **{name:path for name,path in LANE_STAGES.items() if name != LANE_PHASE},
        **{name: path for name, (_, path) in RETENTION_STAGES.items()},
        'spin_catalog_before': 'spin-catalog-observer.sql',
        'spin_catalog_rollback_qualification': 'scripts/qualification/spin-expiry-lock-order.sql',
        'spin_catalog_after': 'spin-catalog-observer.sql',
        'install_candidate': 'supabase/components/spin-expiry-lock-order.sql',
        'real_funded_paid_seat_fixture': 'scripts/qualification/spin-expiry-real-funded-fixture.sql',
    }
    if completed:
        sql_inputs.update({name: path for name, (_, path) in completed_inputs.items()})
    for name in expected:
        stage = stages[names.index(name)]
        require(stage.get('returncode') == 0 and isinstance(stage.get('argv'), list) and stage['argv'],
                'stage identity or outcome mismatch')
        if name == LANE_PHASE:
            require(stage['argv']==lane_program_argv(PG,source,execution), 'lane finite session invocation differs')
            continue
        if completed or name in LANE_STAGES or name in RETENTION_STAGES or name in (PURE_STAGE, 'authentic_settlement_source_authority'):
            role = (completed_inputs[name][0] if completed else 'postgres' if name == PURE_STAGE or name in LANE_STAGES else
                    RETENTION_STAGES[name][0] if name in RETENTION_STAGES else 'fixture_bootstrap')
            require(stage['argv'] == qualification_sql_argv(PG, source, execution, ordinary, tournament,
                                                           role, sql_inputs[name]),
                    'retention SQL role, endpoint or original identity mismatch')
            require(isinstance(stage.get('stdout_sha256'), str)
                    and re.fullmatch(r'[0-9a-f]{64}', stage['stdout_sha256']),
                    'retention original output digest absent')
        if not name.startswith('actual_business_'):
            require(stage['argv'][0] == str(PG / 'psql')
                    and 'execution_uuid=' + execution in stage['argv']
                    and 'ordinary_user_uuid=' + ordinary in stage['argv']
                    and 'tournament_uuid=' + tournament in stage['argv']
                    and stage['argv'][-2:] == ['-f', str(source / sql_inputs[name])], 'SQL stage identity mismatch')
    cases = receipt.get('business_cases')
    require(isinstance(cases, list) and len(cases) == len(CASES[image]), 'case receipt count mismatch')
    for ordinal, (case, record) in enumerate(zip(CASES[image], cases), start=1):
        require(isinstance(record, dict) and record.get('case') == case and record.get('execution') == execution
                and record.get('case_identity') == execution + ':' + str(ordinal) + ':' + case
                and record.get('state') == 'passed' and record.get('result_path') == CASE_RESULTS[case]
                and isinstance(record.get('result_sha256'), str)
                and re.fullmatch(r'[0-9a-f]{64}', record['result_sha256']), 'wrong or incomplete original case receipt')
        common = ['--psql', str(PG / 'psql'), '--execution', execution, '--tournament', tournament]
        work = source.parent / 'work'
        if case == 'committed-refund':
            argv = [sys.executable, str(source / 'scripts/qualification/spin-expiry-committed-refund.py')]
            argv += common + ['--journal', str(work / CASE_RESULTS[case])]
        else:
            argv = [sys.executable, str(source / 'scripts/qualification/spin-expiry-business-races.py')]
            argv += common + ['--image', image, '--case', case, '--output', str(work / CASE_RESULTS[case])]
        require(stages[names.index(business_stage_name(case))]['argv'] == argv,
                'original business case invocation differs')
    return cases


class AttemptCancelled(Exception):
    pass


def new_identity(image):
    values = [str(uuid.uuid4()) for _ in range(3)]
    require(len(set(values + [OWNER, REFUND_ACTOR])) == 5, 'fixture identity collision')
    return argparse.Namespace(execution=values[0], ordinary_user=values[1], tournament=values[2], image=image)


def run_image(image, PG):
    require(image in IMAGES, 'unknown FIFO5 image')
    args = new_identity(image)
    output = ROOT / 'artifacts/spin-expiry' / args.execution
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    allocation = None
    result = {'execution': args.execution, 'image': image, 'passed': False,
              'full_qualification': False, 'connected_services_qualified': False,
              'failures': [], 'sourceWrapperSha256': digest(Path(__file__).read_bytes())}
    receipt = None
    try:
        manifest, files = source_packet()
        manifest['execution'] = args.execution
        manifest['image'] = image
        manifest['ordinary_user'] = args.ordinary_user
        manifest['tournament'] = args.tournament
        allocation = Path(tempfile.mkdtemp(prefix='spin5-', dir='/tmp')).resolve()
        allocation.chmod(0o700)
        result['allocation'] = str(allocation)
        manifest_bytes = stage_packet(allocation, manifest, files)
        result['sourceManifestSha256'] = digest(manifest_bytes)
        receipt = qualify(args, allocation, manifest_bytes, manifest, PG)
        result['cleanupVerified'] = receipt['cleanup_verified']
        retained_evidence(allocation / 'work', output, receipt, manifest_bytes)
        validate_receipt(receipt, args.execution, args.ordinary_user, args.tournament, image,
                         digest(manifest_bytes), allocation / 'source', PG)
        pure_original = read_regular(allocation / 'work' / (PURE_STAGE + '.stdout'), 1048576)
        pure_stage = next(item for item in receipt['stages'] if item['stage'] == PURE_STAGE)
        require(digest(pure_original) == pure_stage['stdout_sha256']
                and pure_output(pure_original) == receipt['mixed_pure_qualification'],
                'pure result differs from original output')
        if image == 'candidate':
            originals = {}
            for name in LANE_STAGES:
                original = read_regular(allocation/'work'/(name+'.stdout'), 16777216)
                stage = next(item for item in receipt['stages'] if item['stage']==name)
                require(digest(original)==stage['stdout_sha256'], 'lane original output changed')
                originals[name]=original
            original = read_regular(allocation/'work'/LANE_RESULT, 16777216)
            require(lane_outputs(originals,original,args.execution,files)==receipt['receipt_lane_qualification'],
                    'lane receipt differs from original source/SQL/session observations')
        retention_stdout = {}
        observed_stages = (('restore_completed_start', 'retention_provider_authority', 'retention_completed_eligibility')
                           if image == 'retention-completed' else tuple(RETENTION_STAGES))
        for stage in observed_stages:
            original = read_regular(allocation / 'work' / (stage + '.stdout'), 1048576)
            observed = next(item for item in receipt['stages'] if item['stage'] == stage)
            require(digest(original) == observed['stdout_sha256'], 'retention original output digest mismatch')
            retention_stdout[stage] = original
        if image == 'retention-completed':
            require(completed_retention_output(retention_stdout['retention_completed_eligibility'])
                    == receipt['completed_retention_qualification'],
                    'completed retention result differs from original output')
        else:
            require(retention_output(retention_stdout['retention_catalog_rollback'],
                                     retention_stdout['retention_behavior_rollback']) == receipt['retention_qualification'],
                    'retention result differs from original output')
        for case in receipt['business_cases']:
            original = read_regular(allocation / 'work' / case['result_path'], 33554432)
            require(digest(original) == case['result_sha256'], 'original case receipt digest mismatch')
        # Evidence is retained before removal; uncertain/failed allocations stay.
        shutil.rmtree(allocation)
        require(not allocation.exists(), 'owned temporary allocation removal unobserved')
        result['ownedDirectoryRemoved'] = True
        result['passed'] = True
    except BaseException as error:
        result['failures'].append({'type': type(error).__name__, 'message': str(error)})
        # If interruption occurred inside the qualifier, its finally already
        # performed the single owned cleanup and preserved the original outcome.
        if allocation is not None and (allocation / 'work/receipt.json').is_file() and receipt is None:
            try:
                receipt = decode(read_regular(allocation / 'work/receipt.json', 1048576))
                retained_evidence(allocation / 'work', output, receipt, manifest_bytes)
            except BaseException as evidence_error:
                result['failures'].append({'stage': 'retain_evidence', 'message': str(evidence_error)})
    finally:
        (output / 'RESULT.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'passed': result['passed'], 'execution': args.execution, 'image': image,
                      'evidence': str(output), 'full_qualification': False}), flush=True)
    return 0 if result['passed'] else 1


def source_controls():
    path = Path(__file__).with_name('test_spin_expiry_wrapper.py')
    spec = importlib.util.spec_from_file_location('spin_expiry_wrapper_tests', path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromModule(module)).wasSuccessful()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-test', action='store_true', help='bounded source controls only; no PostgreSQL')
    args = parser.parse_args()
    if not source_controls(): return 1
    if args.self_test: return 0
    require(sys.platform == 'linux' and os.geteuid() != 0, 'ordinary non-root Linux hosted runner required')
    PG = find_pg()
    def interrupted(signum, _frame):
        raise AttemptCancelled('original CI command cancelled by signal ' + str(signum))
    for image in IMAGES:
        for sig in (signal.SIGINT, signal.SIGTERM): signal.signal(sig, interrupted)
        if run_image(image, PG) != 0: return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
