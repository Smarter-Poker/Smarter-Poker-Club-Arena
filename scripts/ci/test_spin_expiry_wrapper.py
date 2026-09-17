"""Source-specific hosted adapter controls; not native financial qualification.

The normal wrapper runs these controls before its three separate PG17 images.
No successful mocked protocol receipt establishes that SQL or refunds passed.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('spin_expiry_pg_wrapper', Path(__file__).with_name('test-spin-expiry-postgres.py'))
W = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(W)
EXECUTION = '00000000-0000-4000-8000-000000000001'
ORDINARY = '00000000-0000-4000-8000-000000000002'
TOURNAMENT = '00000000-0000-4000-8000-000000000003'
MANIFEST_SHA = 'b' * 64
PG = Path('/usr/lib/postgresql/17/bin')
SOURCE = Path('/tmp/spin5-protocol/source')


def lane_source_files():
    return {name:(Path(__file__).resolve().parents[2]/name).read_bytes() for name in W.LANE_INPUTS}


def lane_catalog():
    return {'qualification':'receipt_lane_catalog','original_and_candidate_compactor_checked':True,
        'unrelated_update_trigger_refused':True,'altered_binding_refusals':7,'helper_authority_drift_refusals':2,'missing_preimage_refused':True,
        'original_cohort_mismatch_reproduced':True,'reverse_prerequisite_refusals':4,
        'replay_refused':True,'existing_function_metadata_preserved':True,'guarded_and_outer_rollback_verified':True,
        'business_rows_unchanged':True,'historical_rows_qualified':False,'financial_completion_qualified':False,
        'full_qualification':False}


def lane_races():
    # Independent tiny protocol example; no database behavior is simulated/proven.
    value={'execution':EXECUTION,'qualification':'receipt_statement_lane_and_zero_rake_compatibility',
        'passed':True,'cleanup_verified':True,'source_stable':True,'full_qualification':False,
        'historical_rows_qualified':False,'financial_completion_qualified':False,
        'work_deadline_seconds':20,'cleanup_deadline_seconds':5,
        'source_sha256':{name:W.digest(data) for name,data in lane_source_files().items()},
        'backend_pids':{'observer':101,'holder':102,'writer':103},
        'environment':{'database':'qual_spin_expiry_'+EXECUTION.replace('-',''),'user':'postgres','session_user':'postgres',
                       'address':None,'port':'5432','version':170006,'others':0},
        'shared_helper_authority':{'owner':'postgres','acl':'{postgres=X/postgres,service_role=X/postgres}',
          'security_definer':False,'volatility':'v','config':['search_path=public, pg_temp'],
          'full_md5':'409b14ee72ce888d3b26524c52d49a68'},
        'clients':[{'backend_pid':pid,'client_exit':0} for pid in (101,102,103)],
        'backend_cleanup':{'backends':0,'locks':0},'verifier_client':{'backend_pid':104,'client_exit':0},
        'transcripts':{'lane_'+name+'_'+EXECUTION:'original transcript' for name in ('observer','holder','writer')},
        'cleanup_transcript':'original cleanup transcript'}
    state={'catalog':{'original':'selected'},'handler':{'owner':'postgres','acl':'{postgres=X/postgres}',
        'body_md5':'534850c97847e72075044d8604b0a09d','config':['search_path=pg_catalog, public, pg_temp'],
        'security_definer':False,'volatility':'v'},
           'business':{'public.hand_history':[],'public.settlement_idempotency_keys':[]}}
    value['before']=state;value['after']=copy.deepcopy(state)
    value['source_readback']={name:{'sha256':sha,'matches':True} for name,sha in value['source_sha256'].items()}
    cases=[]
    for name,role in [('receipt_insert','service_role'),('receipt_update','service_role'),('receipt_delete','service_role'),
                      ('history_insert','postgres'),('history_identity_update','postgres'),('history_metadata_update','postgres'),
                      ('reverse_shared_lane','postgres'),('truncate_relation_then_refusal','service_role')]:
        holder,writer=(103,102) if name=='reverse_shared_lane' else (102,103)
        row={'case':name,'role':role,'holder_pid':holder,'writer_pid':writer,'affected_rows':0}
        if name!='history_metadata_update':row['wait']={'pid':writer,'wait_event_type':'Lock','wait_event':
            'relation' if name=='truncate_relation_then_refusal' else 'advisory','blockers':[holder]}
        if name=='truncate_relation_then_refusal':row['sqlstate']='55000'
        cases.append(row)
    import uuid
    table_id=str(uuid.uuid5(uuid.UUID(EXECUTION),'receipt-lane-zero-rake-table'))
    hand_id=str(uuid.uuid5(uuid.UUID(EXECUTION),'receipt-lane-zero-rake-hand'))
    result={'success':True,'table_id':table_id,'hand_id':hand_id,
            'rake':{'success':True,'skipped':'zero_rake'},'commissions':[]}
    row={'table_id':table_id,'hand_id':hand_id,'status':'succeeded','result':result,'error':None,
         'attempt_count':1,'first_attempt_at':'2026-09-17T00:00:00+00:00',
         'last_attempt_at':'2026-09-17T00:00:00+00:00','completed_at':'2026-09-17T00:00:00+00:00'}
    one={'count':1,'rows':[{'row':row,'ctid':'(0,1)','xmin':'1234','cmin':'0'}]}
    cases.append({'case':'zero_rake_rpc_entry_and_replay','role':'service_role','holder_pid':102,'writer_pid':103,
        'wait':{'pid':103,'wait_event_type':'Lock','wait_event':'advisory','blockers':[102]},
        'before_receipt_count':0,'pre_entry_receipt_write_locks':0,'created_receipts':1,'rollback_receipts':0,'receipt_fk_count':0,
        'request_compatibility_only':True,'first_result':result,'replay_result':copy.deepcopy(result),
        'receipt_before_replay':one,'receipt_after_replay':copy.deepcopy(one)})
    value['cases']=cases
    return value


def lane_originals():
    before={'catalog':{'retained':'catalog'},'handler':None,'business':{'retained':[]},
            'relation_trigger_hints':{'hand_history':True,'settlement_idempotency_keys':False}}
    after=copy.deepcopy(before);after['relation_trigger_hints']['settlement_idempotency_keys']=True
    values={'receipt_lane_provider':{'qualification':'receipt_lane_provider','exact_authority':True,
             'financial_rows_seeded':False,'full_qualification':False},
        'receipt_lane_catalog':lane_catalog(),'receipt_lane_before':before,'receipt_lane_after':after}
    return {name:json.dumps(values[name]).encode() if name in values else b'' for name in W.LANE_STAGES}


def lane_summary():
    return {'catalog':lane_catalog(),'result_sha256':'d'*64,
            'observed_outputs':{name:'e'*64 for name in W.LANE_STAGES},'guarded_rollback_verified':True,
            'historical_rows_qualified':False,'financial_completion_qualified':False,'full_qualification':False}


def pure_source_files():
    root = Path(__file__).resolve().parents[2]
    return {name: (root / name).read_bytes() for name in W.PURE_INPUTS}


def pure_result():
    # Independent expected protocol only. The actual original SQL supplies proof.
    return {'qualification': 'spin_mixed_basis_pure_evidence', 'shape_positive': 1,
            'shape_negative': 24, 'key_scalar_controls': 17, 'private_invocation_refusals': 9,
            'relative_timestamp_regression_reproduced': True, 'relative_timestamp_refusal_verified': True,
            'installed_authority_verified': True, 'missing_preimage_refused': True,
            'duplicate_install_refused': True, 'inner_and_outer_rollback_verified': True,
            'business_rows_unchanged': True, 'historical_original_rows_qualified': False,
            'statement_lane_qualified': False, 'financial_completion_qualified': False,
            'full_qualification': False}


def retention_behavior():
    # Protocol samples only; actual SQL must produce its own original result.
    sequences = {name: {'last_value': '1', 'is_called': False} for name in (
        'public.content_authors_id_seq', 'public.managed_game_contract_versions_id_seq',
        'smarter_private.f06_lifecycle_seq')}
    return {'qualification': 'spin_history_retention_behavior', 'old_deleted': 5,
            'candidate_deleted': 2, 'canonical_cancellation_count': 2,
            'table_and_catalog_rollback_verified': True, 'sequence_counters_restored': False,
            'completed_spin_qualified': False, 'multi_session_race_qualified': False,
            'sequence_before': sequences, 'sequence_after': copy.deepcopy(sequences)}


def retention_source_files():
    root = Path(__file__).resolve().parents[2]
    names = (*W.RETENTION_INPUTS, 'scripts/qualification/spin-expiry-business-state.sql')
    return {name: (root / name).read_bytes() for name in names}


def completed_source_files():
    root = Path(__file__).resolve().parents[2]
    files = retention_source_files()
    files.update({name: (root / name).read_bytes() for name in W.COMPLETED_INPUTS})
    return files


def completed_result():
    sequences = retention_behavior()['sequence_before']
    return {'qualification': 'spin_history_retention_completed_receipt_eligibility',
            'old_deleted': 1, 'candidate_deleted': 1, 'captured_receipt_unchanged': True,
            'projection_and_catalog_rollback_verified': True,
            'starting_estate_retained_until_database_disposal': True,
            'terminal_creation_qualified': False, 'financial_lifecycle_qualified': False,
            'multi_session_race_qualified': False, 'sequence_counters_restored': False,
            'source_capture_observed_at': '2026-09-17T07:35:54.523723+00:00',
            'sequence_before': sequences, 'sequence_after': copy.deepcopy(sequences)}


def completed_receipt(source=SOURCE):
    value = receipt('preimage', source)
    value.update(image='retention-completed', business_cases=[], catalog_slice_passed=False,
                 native_status='retention_completed_eligibility_passed_cleanup_observed',
                 business_scenario_passed=False, retention_qualification=None,
                 completed_retention_qualification=completed_result())
    # Deliberately independent literal schedule: do not generate expected order
    # from the production validator's table.
    inputs = [
        ('schema_prefix', 'fixture_bootstrap', str(source.parent / 'work/schema-prefix.sql')),
        ('restore_preexisting_principals', 'fixture_bootstrap', 'principals.sql'),
        ('empty_provider_readback', 'fixture_bootstrap', 'empty-provider-check.sql'),
        ('restore_completed_start', 'fixture_bootstrap', 'scripts/qualification/fixtures/spin-history-retention/completed-start-restore.sql'),
        ('schema_suffix_all_real_triggers', 'fixture_bootstrap', str(source.parent / 'work/schema-suffix.sql')),
        ('authentic_access', 'fixture_bootstrap', 'inputs/access.sql'),
        ('authentic_policies', 'fixture_bootstrap', 'inputs/policies.sql'),
        ('current_notification_supplement', 'fixture_bootstrap', 'provider-supplement.sql'),
        ('current_tested_roles', 'fixture_bootstrap', 'provider-roles.sql'),
        ('tested_role_readback', 'fixture_bootstrap', 'provider-roles-check.sql'),
        ('current_catalog_readback', 'fixture_bootstrap', 'provider-check.sql'),
        ('authentic_spin_catalog_supplement', 'fixture_bootstrap', 'inputs/spin-catalog-supplement.sql'),
        ('authentic_entry_provider_supplement', 'fixture_bootstrap', 'inputs/entry-provider-supplement.sql'),
        ('authentic_entry_sequence_authority', 'fixture_bootstrap', 'inputs/entry-sequence-authority.sql'),
        ('authentic_settlement_source_authority', 'fixture_bootstrap', 'inputs/settle-source-authority.sql'),
        ('retention_provider_authority', 'fixture_bootstrap', 'scripts/qualification/fixtures/spin-history-retention/provider-supplement.sql'),
        ('mixed_pure_evidence_rollback', 'postgres', 'scripts/qualification/spin-mixed-basis-pure.sql'),
        ('retention_completed_eligibility', 'postgres', 'scripts/qualification/spin-history-retention-completed.sql'),
    ]
    value['stages'] = [value['stages'][0]] + [
        {'stage': name, 'returncode': 0, 'stdout_sha256': 'e' * 64,
         'argv': W.qualification_sql_argv(PG, source, EXECUTION, ORDINARY, TOURNAMENT, role, path)}
        for name, role, path in inputs]
    return value


def receipt(image='candidate', source=SOURCE):
    # Tiny protocol observations only, never evidence that SQL or refunds passed.
    sql = [str(PG / 'psql'), '-X', '-w', '-A', '-t', '-h', str(source.parent / 'work/socket'),
           '-p', '5432', '-d', 'qual_spin_expiry_' + EXECUTION.replace('-', ''),
           '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-v', 'execution_uuid=' + EXECUTION,
           '-v', 'ordinary_user_uuid=' + ORDINARY, '-v', 'tournament_uuid=' + TOURNAMENT]
    sql_inputs = {
        'spin_catalog_before': 'spin-catalog-observer.sql',
        'spin_catalog_rollback_qualification': 'scripts/qualification/spin-expiry-lock-order.sql',
        'spin_catalog_after': 'spin-catalog-observer.sql',
        'install_candidate': 'supabase/components/spin-expiry-lock-order.sql',
        'real_funded_paid_seat_fixture': 'scripts/qualification/spin-expiry-real-funded-fixture.sql',
    }
    catalog = ['spin_catalog_before', 'spin_catalog_rollback_qualification', 'spin_catalog_after']
    stages = [{'stage': name, 'returncode': 0, 'argv': sql + ['-f', str(source / sql_inputs[name])],
               'stdout_sha256': 'e' * 64}
              for name in (catalog + ['install_candidate'] if image == 'candidate' else []) + ['real_funded_paid_seat_fixture']]
    retention = [
        ('authentic_settlement_source_authority', 'fixture_bootstrap', 'inputs/settle-source-authority.sql'),
        ('retention_provider_authority', 'fixture_bootstrap', 'scripts/qualification/fixtures/spin-history-retention/provider-supplement.sql'),
        ('mixed_pure_evidence_rollback', 'postgres', 'scripts/qualification/spin-mixed-basis-pure.sql'),
        ('retention_catalog_rollback', 'postgres', 'scripts/qualification/spin-history-retention.sql'),
        ('retention_behavior_rollback', 'postgres', 'scripts/qualification/spin-history-retention-behavior.sql'),
    ]
    stages[:0] = [{'stage': name, 'returncode': 0, 'stdout_sha256': 'e' * 64,
        'argv': [str(PG / 'psql'), '-X', '-w', '-A', '-t', '-h', str(source.parent / 'work/socket'),
                 '-p', '5432', '-U', role, '-d', 'qual_spin_expiry_' + EXECUTION.replace('-', ''),
                 '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
                 '-v', 'execution_uuid=' + EXECUTION, '-v', 'ordinary_user_uuid=' + ORDINARY,
                 '-v', 'tournament_uuid=' + TOURNAMENT, '-f', str(source / path)]}
        for name, role, path in retention]
    if image=='candidate':
        lane_stages=[]
        for name,path in [
            ('receipt_lane_provider','scripts/qualification/fixtures/spin-receipt-lane/provider.sql'),
            ('receipt_lane_catalog','scripts/qualification/spin-receipt-lane.sql'),
            ('receipt_lane_before','scripts/qualification/fixtures/spin-receipt-lane/snapshot.sql'),
            ('receipt_lane_install','supabase/components/spin-mixed-basis-receipt-lane.sql'),
            ('receipt_lane_statements','scripts/qualification/spin-receipt-lane.py'),
            ('receipt_lane_rollback','supabase/components/spin-mixed-basis-receipt-lane.rollback.sql'),
            ('receipt_lane_after','scripts/qualification/fixtures/spin-receipt-lane/snapshot.sql')]:
            argv=([sys.executable,str(source/path),'--psql',str(PG/'psql'),'--execution',EXECUTION,
                   '--output',str(source.parent/'work/receipt-lane.json')] if name=='receipt_lane_statements' else
                  W.qualification_sql_argv(PG,source,EXECUTION,ORDINARY,TOURNAMENT,'postgres',path))
            lane_stages.append({'stage':name,'returncode':0,'stdout_sha256':'e'*64,'argv':argv})
        stages[3:3]=lane_stages
    endpoint = {'user': 'fixture_bootstrap', 'session_user': 'fixture_bootstrap',
                'port': '5432', 'address': None, 'listen_addresses': '',
                'unix_socket_directories': str(source.parent / 'work/socket')}
    stages.insert(0, {'stage': 'server_endpoint_readback', 'returncode': 0,
                      'argv': W.server_endpoint_command(PG, source.parent / 'work/socket')})
    records = []
    for ordinal, case in enumerate(W.CASES[image], start=1):
        common = ['--psql', str(PG / 'psql'), '--execution', EXECUTION, '--tournament', TOURNAMENT]
        if case == 'committed-refund':
            argv = [sys.executable, str(source / 'scripts/qualification/spin-expiry-committed-refund.py')]
            argv += common + ['--journal', str(source.parent / 'work' / W.CASE_RESULTS[case])]
        else:
            argv = [sys.executable, str(source / 'scripts/qualification/spin-expiry-business-races.py')]
            argv += common + ['--image', image, '--case', case,
                              '--output', str(source.parent / 'work' / W.CASE_RESULTS[case])]
        stages.append({'stage': W.business_stage_name(case), 'returncode': 0, 'argv': argv})
        records.append({'case': case, 'execution': EXECUTION,
                        'case_identity': EXECUTION + ':' + str(ordinal) + ':' + case,
                        'state': 'passed', 'result_path': W.CASE_RESULTS[case],
                        'result_sha256': W.digest(b'unit-test case bytes')})
    return {'execution': EXECUTION, 'source_manifest_sha256': MANIFEST_SHA,
            'image': image, 'tournament': TOURNAMENT, 'catalog_slice_passed': image == 'candidate',
            'native_status': 'business_scenario_passed_cleanup_observed', 'business_scenario_passed': True,
            'business_qualified': False, 'cleanup_verified': True, 'cleanup_errors': [], 'source_stable': True,
            'full_qualification': False, 'connected_services_qualified': False,
            'execution_backend': 'hosted-owned-pg17-unix-socket',
            'hosted_cleanup_observed': True, 'original_clients_terminal': True,
            'stages': stages, 'business_cases': records, 'server_endpoint': endpoint,
            'retention_qualification': retention_behavior(), 'mixed_pure_qualification': pure_result(),
            'receipt_lane_qualification':lane_summary() if image=='candidate' else None}


class SessionEnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.runners = Path(__file__).resolve().parents[2] / 'scripts' / 'qualification'
        spec = importlib.util.spec_from_file_location(
            'spin_expiry_session_controls', self.runners / 'spin-expiry-business-races.py')
        self.lib = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.lib)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root, self.home = self.allocation(self.temp.name)
        root_patch = patch.object(self.lib, 'ROOT', self.root)
        root_patch.start(); self.addCleanup(root_patch.stop)
        env_patch = patch.dict(os.environ, {
            'HOME': str(self.home), 'PGPASSWORD': 'host-secret-must-not-reach-child',
            'PGSERVICE': 'host-service', 'PGSERVICEFILE': '/host/service',
            'PGPASSFILE': '/host/password', 'PGOPTIONS': '-c role=host-role',
        }, clear=True)
        env_patch.start(); self.addCleanup(env_patch.stop)

    @staticmethod
    def allocation(folder):
        allocation = Path(folder).resolve()
        root = allocation / 'source'; root.mkdir()
        work = allocation / 'work'; work.mkdir(mode=0o700)
        home = work / 'home'; home.mkdir(mode=0o700)
        private = work / 'socket'; private.mkdir(mode=0o700)
        # Metadata-only Unix endpoint for transport preflight; no database runs.
        with socket.socket(socket.AF_UNIX) as endpoint:
            endpoint.bind(str(private / '.s.PGSQL.5432'))
        return root, home

    def test_empty_private_password_file_is_reused_without_inheriting_credentials(self):
        expected = {
            'LC_ALL': 'C', 'PGCONNECT_TIMEOUT': '2', 'PGAPPNAME': 'spin-control',
            'HOME': str(self.home), 'PGPASSFILE': str(self.home / '.spin-expiry.pgpass'),
            'PSQL_HISTORY': '/dev/null',
        }
        self.assertEqual(self.lib.psql_environment('spin-control'), expected)
        password_file = self.home / '.spin-expiry.pgpass'
        before = password_file.lstat()
        self.assertTrue(stat.S_ISREG(before.st_mode))
        self.assertEqual((before.st_uid, stat.S_IMODE(before.st_mode), before.st_size),
                         (os.geteuid(), 0o600, 0))
        self.assertEqual(password_file.read_bytes(), b'')
        self.assertEqual(self.lib.psql_environment('spin-control'), expected)
        after = password_file.lstat()
        self.assertEqual((before.st_dev, before.st_ino, before.st_mode, before.st_size, before.st_mtime_ns),
                         (after.st_dev, after.st_ino, after.st_mode, after.st_size, after.st_mtime_ns))

    def test_actual_session_launch_uses_private_environment_and_preserves_diagnostics(self):
        with patch.object(self.lib.subprocess, 'Popen') as launch, \
                patch.object(self.lib.selectors, 'DefaultSelector'), \
                patch.object(self.lib.os, 'set_blocking'):
            self.lib.Session(Path('/protected/psql'), 'qual_spin_expiry_' + EXECUTION.replace('-', ''),
                             'spin-control', 123)
        launch.assert_called_once()
        args, kwargs = launch.call_args
        self.assertEqual(args[0][:8], ['/protected/psql', '-X', '-w', '-qAt', '-h',
                                         str(self.root.parent / 'work/socket'), '-p', '5432'])
        self.assertEqual(kwargs['env'], self.lib.psql_environment('spin-control'))
        self.assertEqual(set(kwargs['env']), {'LC_ALL', 'PGCONNECT_TIMEOUT', 'PGAPPNAME',
                                             'HOME', 'PGPASSFILE', 'PSQL_HISTORY'})
        self.assertEqual(kwargs['stdin'], self.lib.subprocess.PIPE)
        self.assertEqual(kwargs['stdout'], self.lib.subprocess.PIPE)
        self.assertEqual(kwargs['stderr'], self.lib.subprocess.STDOUT)

    def test_unsafe_home_or_password_file_refuses_before_process_launch_without_truncation(self):
        for case in ('missing-home-env', 'relative-home', 'foreign-home', 'home-mode', 'home-symlink',
                     'password-symlink', 'password-directory', 'password-fifo',
                     'password-nonempty', 'password-mode'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as folder:
                root, home = self.allocation(folder)
                password_file = home / '.spin-expiry.pgpass'
                env = {'HOME': str(home)}
                preserved = None
                if case == 'missing-home-env': env = {}
                if case == 'relative-home': env['HOME'] = 'work/home'
                if case == 'foreign-home': env['HOME'] = str(root)
                if case == 'home-mode': home.chmod(0o755)
                if case == 'home-symlink':
                    real_home = home.with_name('real-home'); home.rename(real_home)
                    home.symlink_to(real_home, target_is_directory=True)
                if case == 'password-symlink':
                    preserved = home / 'unrelated-password'
                    preserved.write_bytes(b'preserve-existing-content'); preserved.chmod(0o600)
                    password_file.symlink_to(preserved)
                if case == 'password-directory': password_file.mkdir(mode=0o700)
                if case == 'password-fifo': os.mkfifo(password_file, 0o600)
                if case == 'password-nonempty':
                    preserved = password_file
                    preserved.write_bytes(b'preserve-existing-content'); preserved.chmod(0o600)
                if case == 'password-mode':
                    password_file.write_bytes(b''); password_file.chmod(0o644)
                original_open = self.lib.os.open
                def bounded_open(path, flags, *args, **kwargs):
                    # Exercise the real FIFO refusal, but fail before a blocking
                    # open if the nonblocking guard regresses.
                    if case == 'password-fifo' and not flags & os.O_CREAT:
                        self.assertNotEqual(flags & os.O_NONBLOCK, 0)
                    return original_open(path, flags, *args, **kwargs)
                with patch.object(self.lib, 'ROOT', root), patch.dict(os.environ, env, clear=True), \
                        patch.object(self.lib.os, 'open', side_effect=bounded_open), \
                        patch.object(self.lib.subprocess, 'Popen') as launch, \
                        patch.object(self.lib.selectors, 'DefaultSelector'), \
                        self.assertRaises((RuntimeError, OSError)):
                    self.lib.Session(Path('/protected/psql'), 'qual_spin_expiry_' + EXECUTION.replace('-', ''),
                                     'spin-control', 123)
                launch.assert_not_called()
                if preserved is not None:
                    self.assertEqual(preserved.read_bytes(), b'preserve-existing-content')
                if case == 'password-symlink': self.assertTrue(password_file.is_symlink())
                if case == 'password-fifo': self.assertTrue(stat.S_ISFIFO(password_file.lstat().st_mode))
                if case == 'password-mode': self.assertEqual(stat.S_IMODE(password_file.stat().st_mode), 0o644)

    def test_warning_prefixed_json_remains_a_failure(self):
        session = object.__new__(self.lib.Session)
        warning = "WARNING: password file '/dev/null' is not a plain file\n{\"ok\":true}"
        with patch.object(session, 'command', return_value=warning), \
                self.assertRaises(json.JSONDecodeError):
            session.json('SELECT original_observation;')
        with patch.object(session, 'command', return_value='ERROR: preserved diagnostic\n{"ok":true}'), \
                self.assertRaisesRegex(RuntimeError, 'unexpected SQL failure'):
            session.json('SELECT original_observation;')

    def test_begin_requires_observed_service_role_without_a_user_identity(self):
        session = object.__new__(self.lib.Session)
        original_transaction = ("BEGIN; SET LOCAL statement_timeout='8s'; "
            "SET LOCAL lock_timeout='4s'; SET LOCAL idle_in_transaction_session_timeout='12s'; "
            "SET LOCAL timezone='UTC'; SET LOCAL search_path=public,pg_temp; "
            "SET LOCAL request.jwt.claims='{}'; SET LOCAL request.jwt.claim.role=''; "
            "SET LOCAL request.jwt.claim.sub='';")
        with patch.object(session, 'command', return_value='') as command:
            session.begin()
        command.assert_called_once_with(original_transaction)
        self.assertNotIn('SET LOCAL ROLE', command.call_args.args[0])
        accepted = {'user': 'service_role', 'role': 'service_role', 'uid': None}
        with patch.object(session, 'command', side_effect=['', json.dumps(accepted)]) as command:
            session.begin(service_role=True)
        self.assertEqual(command.call_count, 2)
        transaction_sql = command.call_args_list[0].args[0]
        self.assertTrue(transaction_sql.startswith(original_transaction))
        for statement in ("SET LOCAL ROLE service_role;",
                          "SET LOCAL request.jwt.claims='{\"role\":\"service_role\"}';",
                          "SET LOCAL request.jwt.claim.role='service_role';",
                          "SET LOCAL request.jwt.claim.sub='';"):
            self.assertIn(statement, transaction_sql)
        observation_sql = ''.join(command.call_args_list[1].args[0].split())
        self.assertEqual(observation_sql,
                         "SELECTjsonb_build_object('user',current_user,'role',auth.role(),'uid',auth.uid());")
        invalid = [None, {}, [], {'role': 'service_role', 'uid': None}]
        for key, value in (('user', None), ('user', 'postgres'), ('user', 'authenticated'),
                           ('role', None), ('role', 'authenticated'), ('role', 'anon'),
                           ('uid', ORDINARY), ('uid', '')):
            invalid.append(dict(accepted, **{key: value}))
        for key in accepted:
            invalid.append({name: value for name, value in accepted.items() if name != key})
        for observed in invalid:
            with self.subTest(observed=observed), \
                    patch.object(session, 'command', side_effect=['', json.dumps(observed)]) as command, \
                    self.assertRaises(RuntimeError):
                session.begin(service_role=True)
            self.assertEqual(command.call_count, 2)
        with patch.object(session, 'command', return_value='ERROR: role setup refused') as command, \
                self.assertRaisesRegex(RuntimeError, 'unexpected SQL failure'):
            session.begin(service_role=True)
        command.assert_called_once()

    def test_refund_runner_binds_the_exact_session_implementation(self):
        spec = importlib.util.spec_from_file_location(
            'spin_expiry_refund_pin_control', self.runners / 'spin-expiry-committed-refund.py')
        refund = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(refund)
        self.assertEqual(refund.R1, self.runners / 'spin-expiry-business-races.py')
        self.assertEqual(refund.FROZEN[refund.R1], W.digest(refund.R1.read_bytes()))
        imported = refund.load(refund.R1, 'spin_expiry_refund_actual_dependency')
        with patch.object(imported, 'ROOT', self.root):
            self.assertEqual(imported.psql_environment('refund-control'),
                             self.lib.psql_environment('refund-control'))

    def test_private_socket_rejects_symlinks_permissions_foreign_owner_and_regular_endpoint(self):
        for case in ('permissive', 'symlink', 'foreign', 'regular', 'missing'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as folder:
                root, home = self.allocation(folder)
                private = root.parent / 'work/socket'
                endpoint = private / '.s.PGSQL.5432'
                if case == 'permissive': private.chmod(0o755)
                if case == 'symlink':
                    real = private.with_name('original-socket'); private.rename(real)
                    private.symlink_to(real, target_is_directory=True)
                if case in ('regular', 'missing'):
                    endpoint.unlink()
                    if case == 'regular': endpoint.write_bytes(b'not a PostgreSQL socket')
                expected_uid = os.geteuid() + (1 if case == 'foreign' else 0)
                with patch.object(self.lib, 'ROOT', root), \
                        patch.object(self.lib.os, 'geteuid', return_value=expected_uid), \
                        self.assertRaises((RuntimeError, OSError)):
                    self.lib.private_socket()

    def test_business_endpoint_rejects_tcp_wrong_database_and_identity(self):
        db = 'qual_spin_expiry_' + EXECUTION.replace('-', '')
        value = dict(database=db, user='postgres', session_user='postgres', port='5432',
                     address=None, version=170006, others=0)
        self.lib.require_private_endpoint(value, db)
        for key, changed in [('address','127.0.0.1'), ('database','postgres'),
                             ('user','fixture_bootstrap'), ('session_user','service_role'),
                             ('port','5433'), ('version',160000), ('others',1)]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                self.lib.require_private_endpoint(dict(value, **{key: changed}), db)


class RelationAuthorityTests(unittest.TestCase):
    def setUp(self):
        directory = Path(__file__).resolve().parents[2] / 'scripts' / 'qualification'
        spec = importlib.util.spec_from_file_location(
            'spin_expiry_relation_controls', directory / 'spin-expiry-committed-refund.py')
        self.refund = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.refund)
        captures = json.loads((directory / 'spin-expiry-committed-refund.authority.json').read_text())['captures']
        self.rows = next(c['rows'] for c in captures
                         if c['origin'] == 'fifo5-R2-current-payment-relations-1409.json')
        self.roles = {'0': 'PUBLIC', '16481': 'authenticated', '16482': 'service_role'}

    def test_retained_capture_normalizes_only_column_gaps_and_observed_role_oids(self):
        original = copy.deepcopy(self.rows)
        actual = copy.deepcopy(self.rows)
        self.assertTrue(any(c['ordinal_position'] != index
                            for row in original for index, c in enumerate(row['columns'], 1)))
        for row in actual:
            for index, column in enumerate(row['columns'], 1):
                column['ordinal_position'] = index
            for policy in row['policies'] or []:
                policy['roles'] = policy['roles'].replace('16481', '16389').replace('16482', '16390')
        actual_before = copy.deepcopy(actual)
        observed = [{'oid': '16389', 'name': 'authenticated'}, {'oid': '16390', 'name': 'service_role'}]
        observed_before = copy.deepcopy(observed)
        actual_roles = self.refund.observed_policy_roles(observed)
        self.assertEqual(actual_roles, {'0': 'PUBLIC', '16389': 'authenticated', '16390': 'service_role'})
        self.assertEqual(self.refund.CAPTURED_POLICY_ROLES, self.roles)
        expected = self.refund.relation_authority(self.rows, self.roles)
        self.assertEqual(self.refund.relation_authority(actual, actual_roles), expected)
        self.assertEqual(self.rows, original)
        self.assertEqual(actual, actual_before)
        self.assertEqual(observed, observed_before)
        self.assertEqual(len(expected), len(original))
        self.assertEqual(expected[0]['policies'][0]['roles'], ['PUBLIC'])
        for before, after in zip(original, expected):
            self.assertEqual({k: v for k, v in before.items() if k not in ('columns', 'policies')},
                             {k: v for k, v in after.items() if k not in ('columns', 'policies')})
            self.assertEqual(len(before['columns']), len(after['columns']))
            self.assertEqual(before['policies'] is None, after['policies'] is None)
            self.assertEqual(len(before['policies'] or []), len(after['policies'] or []))
            for index, (old_column, new_column) in enumerate(zip(before['columns'], after['columns']), 1):
                self.assertEqual(new_column, dict(old_column, ordinal_position=index))
            for old_policy, new_policy in zip(before['policies'] or [], after['policies'] or []):
                names = sorted(self.roles[oid] for oid in old_policy['roles'][1:-1].split(','))
                self.assertEqual(new_policy, dict(old_policy, roles=names))

    def test_real_column_and_policy_drift_remains_distinct(self):
        expected = self.refund.relation_authority(self.rows, self.roles)
        for change in ('column-order', 'type', 'default', 'nullability', 'policy-role', 'policy-expression'):
            changed = copy.deepcopy(self.rows)
            columns = changed[0]['columns']
            if change == 'column-order':
                first, second = columns[0]['ordinal_position'], columns[1]['ordinal_position']
                columns[0], columns[1] = columns[1], columns[0]
                columns[0]['ordinal_position'], columns[1]['ordinal_position'] = first, second
            if change == 'type': columns[0]['data_type'] = 'text'
            if change == 'default': columns[0]['column_default'] = None
            if change == 'nullability': columns[0]['is_nullable'] = 'YES'
            if change == 'policy-role': changed[0]['policies'][0]['roles'] = '{16482}'
            if change == 'policy-expression': changed[0]['policies'][0]['using'] = 'true'
            with self.subTest(change=change):
                self.assertNotEqual(self.refund.relation_authority(changed, self.roles), expected)

    def test_malformed_ordinals_columns_or_policy_role_arrays_refuse(self):
        for ordinal in (0, -1, True, 1.5, '1', None):
            changed = copy.deepcopy(self.rows)
            changed[0]['columns'][0]['ordinal_position'] = ordinal
            with self.subTest(ordinal=ordinal), self.assertRaises(RuntimeError):
                self.refund.relation_authority(changed, self.roles)
        for change in ('duplicate-ordinal', 'decreasing-ordinal', 'duplicate-column', 'missing-column'):
            changed = copy.deepcopy(self.rows)
            columns = changed[0]['columns']
            if change == 'duplicate-ordinal': columns[1]['ordinal_position'] = columns[0]['ordinal_position']
            if change == 'decreasing-ordinal': columns[0]['ordinal_position'] = columns[1]['ordinal_position'] + 1
            if change == 'duplicate-column': columns[1]['column_name'] = columns[0]['column_name']
            if change == 'missing-column': del columns[0]['column_name']
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                self.refund.relation_authority(changed, self.roles)
        for roles in ('{99999}', '{0,0}', '{}', '{16481,}', '{-1}', '{NULL}', '[16481]', ['16481'], None):
            changed = copy.deepcopy(self.rows)
            changed[0]['policies'][0]['roles'] = roles
            with self.subTest(roles=roles), self.assertRaises(RuntimeError):
                self.refund.relation_authority(changed, self.roles)
        for mappings in ({'0': 'authenticated', '16481': 'authenticated', '16482': 'service_role'},
                         {'0': 'PUBLIC', '16481': 'PUBLIC', '16482': 'service_role'},
                         {'0': 'PUBLIC', '16481': '', '16482': 'service_role'}):
            with self.subTest(mappings=mappings), self.assertRaises(RuntimeError):
                self.refund.relation_authority(self.rows, mappings)

    def test_observed_roles_require_exact_unique_names_and_positive_oid_bindings(self):
        good = [{'oid': '16389', 'name': 'authenticated'}, {'oid': '16390', 'name': 'service_role'}]
        invalid = [[], good[:1], good + [good[0]],
                   [good[0], {'oid': '16390', 'name': 'authenticated'}],
                   [good[0], {'oid': '16389', 'name': 'service_role'}],
                   [good[0], {'oid': '16390', 'name': 'PUBLIC'}],
                   [good[0], {'oid': '16390'}],
                   [good[0], {'name': 'service_role'}]]
        for oid in ('0', '-1', '1.5', '', 'abc', None, True):
            invalid.append([good[0], {'oid': oid, 'name': 'service_role'}])
        for observed in invalid:
            with self.subTest(observed=observed), self.assertRaises(RuntimeError):
                self.refund.observed_policy_roles(observed)


class TerminalObservationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = Path(__file__).resolve().parents[1] / 'qualification/spin-expiry-committed-refund-oracle.py'
        spec = importlib.util.spec_from_file_location('terminal_refund_oracle', path)
        cls.oracle = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.oracle)

    def reports(self):
        before = [dict(id='paid', related_entity_id=TOURNAMENT, terminal_closed_at=None, amount=1),
                  dict(id='other', related_entity_id='other-event', terminal_closed_at=None, amount=2)]
        after = copy.deepcopy(before)
        after[0]['terminal_closed_at'] = 'settled'
        after += [dict(id='refund1'), dict(id='refund2')]
        return before, after

    def test_only_exact_target_report_stamp_is_allowed(self):
        before, after = self.reports()
        original = copy.deepcopy(before)
        # The original immutable-only comparison reproduces the observed refusal.
        with self.assertRaisesRegex(RuntimeError, 'prior immutable row'):
            self.oracle.additions(before, after, 'id', 2)
        self.assertEqual(self.oracle.reporting_additions(before, after, TOURNAMENT, 'settled'), after[2:])
        self.assertEqual(before, original)

    def test_report_marker_event_money_and_unrelated_changes_refuse(self):
        for row, field, value in ((0, 'terminal_closed_at', None), (0, 'terminal_closed_at', 'wrong'),
                                  (0, 'related_entity_id', 'other-event'), (0, 'amount', 2),
                                  (1, 'terminal_closed_at', 'settled')):
            with self.subTest(row=row, field=field, value=value):
                before, after = self.reports()
                after[row][field] = value
                with self.assertRaisesRegex(RuntimeError, 'prior immutable row'):
                    self.oracle.reporting_additions(before, after, TOURNAMENT, 'settled')
        before, after = self.reports()
        with self.assertRaisesRegex(RuntimeError, 'prior immutable row'):
            self.oracle.reporting_additions(before, after[1:], TOURNAMENT, 'settled')
        before[0]['terminal_closed_at'] = 'already-closed'
        with self.assertRaisesRegex(RuntimeError, 'original report already closed'):
            self.oracle.reporting_additions(before, after, TOURNAMENT, 'settled')

    def test_elimination_sequence_requires_new_positive_unique_integer(self):
        before = [dict(id=str(i), status='playing', elimination_sequence=None) for i in range(2)]
        after = [dict(id=str(i), status='eliminated', elimination_sequence=i+10) for i in range(2)]
        self.oracle.elimination_sequences(before, after)
        for invalid in (None, 0, -1, True, '10', 1.5, 11):
            with self.subTest(invalid=invalid):
                damaged = copy.deepcopy(after)
                damaged[0]['elimination_sequence'] = invalid
                with self.assertRaisesRegex(RuntimeError, 'invalid database elimination sequence'):
                    self.oracle.elimination_sequences(before, damaged)
        for field, value in (('status', 'eliminated'), ('elimination_sequence', 4)):
            damaged = copy.deepcopy(before)
            damaged[0][field] = value
            with self.assertRaisesRegex(RuntimeError, 'original roster already eliminated'):
                self.oracle.elimination_sequences(damaged, after)
        with self.assertRaisesRegex(RuntimeError, 'elimination roster identity changed'):
            self.oracle.elimination_sequences(before, after[:1])


class FixtureSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve(); self.root.chmod(0o700)
        self.directory = self.root / 'scripts/ci/probes/spin-expiry'
        self.directory.mkdir(parents=True, mode=0o700)
        root_patch = patch.object(W, 'ROOT', self.root)
        root_patch.start(); self.addCleanup(root_patch.stop)
        # Parser/protocol bytes only. Never invoked as a native financial fixture.
        self.files = {name: ('unit input ' + name).encode() for name in W.FIXED_INPUTS}
        self.manifest = {'schemaVersion': 1, 'kind': 'spin-expiry-hosted-fixture',
                         'originManifestSha256': W.ORIGIN_MANIFEST,
                         'files': {name: W.pin(data) for name, data in self.files.items()}}
        for name, data in self.files.items():
            leaf = self.directory / name; leaf.parent.mkdir(parents=True, exist_ok=True)
            leaf.write_bytes(data)
        self.write_manifest()

    def write_manifest(self):
        self.raw = (json.dumps(self.manifest) + '\n').encode()
        (self.directory / 'manifest.json').write_bytes(self.raw)

    def test_exact_fixed_manifest_preserves_provenance_and_bytes(self):
        raw, manifest, files = W.load_fixture(self.directory)
        self.assertEqual((raw, manifest, files), (self.raw, self.manifest, self.files))
        self.assertEqual(len(files), 17)

    def test_missing_financial_authority_and_extra_leaf_refuse(self):
        for name in ('inputs/entry-sequence-authority.sql', 'inputs/settle-source-authority.sql',
                     'inputs/entry-provider-supplement.sql', 'inputs/captured-financial-store-policy.sql'):
            saved = self.manifest['files'].pop(name); self.write_manifest()
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, 'inventory'):
                W.load_fixture(self.directory)
            self.manifest['files'][name] = saved
        self.write_manifest()
        (self.directory / 'unreviewed.sql').write_bytes(b'no')
        with self.assertRaisesRegex(RuntimeError, 'unpinned'): W.load_fixture(self.directory)

    def test_manifest_duplicate_traversal_hash_and_origin_refuse(self):
        with self.assertRaisesRegex(RuntimeError, 'duplicate'): W.decode(b'{"files":{},"files":{}}')
        for name in ('../x', '/x', 'a/../x', 'a//x', 'manifest.json', 'a/./x'):
            with self.subTest(name=name), self.assertRaises(RuntimeError): W.safe_name(name)
        original = self.manifest['originManifestSha256']
        self.manifest['originManifestSha256'] = 'f' * 64; self.write_manifest()
        with self.assertRaisesRegex(RuntimeError, 'provenance'): W.load_fixture(self.directory)
        self.manifest['originManifestSha256'] = original; self.write_manifest()
        (self.directory / 'principals.sql').write_bytes(b'changed')
        with self.assertRaisesRegex(RuntimeError, 'leaf mismatch'): W.load_fixture(self.directory)

    def test_symlink_hardlink_foreign_and_writable_source_refuse(self):
        leaf = self.directory / 'principals.sql'
        leaf.unlink(); leaf.symlink_to(self.directory / 'provider-roles.sql')
        with self.assertRaises(RuntimeError): W.load_fixture(self.directory)
        leaf.unlink(); os.link(self.directory / 'provider-roles.sql', leaf)
        with self.assertRaises(RuntimeError): W.load_fixture(self.directory)
        leaf.unlink(); leaf.write_bytes(self.files['principals.sql']); leaf.chmod(0o666)
        with self.assertRaises(RuntimeError): W.load_fixture(self.directory)
        leaf.chmod(0o600)
        uid = os.geteuid()
        with patch.object(W.os, 'geteuid', return_value=uid + 1), self.assertRaises(RuntimeError):
            W.load_fixture(self.directory)

    def test_read_preserves_atime_and_rejects_inode_replacement(self):
        leaf = self.directory / 'principals.sql'; os.utime(leaf, ns=(1, 2_000_000_000))
        before = leaf.stat()
        self.assertEqual(W.read_regular(leaf, 1000), self.files['principals.sql'])
        after = leaf.stat()
        self.assertEqual((before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns),
                         (after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns))
        original_open = Path.open
        def replacing_open(path, *args, **kwargs):
            handle = original_open(path, *args, **kwargs)
            if path == leaf:
                replacement = leaf.with_name('new-inode')
                with original_open(replacement, 'wb') as out: out.write(self.files['principals.sql'])
                os.replace(replacement, leaf)
            return handle
        with patch.object(Path, 'open', replacing_open), self.assertRaisesRegex(RuntimeError, 'source changed'):
            W.read_regular(leaf, 1000)

    def test_staged_inventory_and_postrun_bytes_are_bound(self):
        files = dict(self.files)
        files.update({name: ('current source '+name).encode() for name in W.REPLACEMENTS})
        files.update(completed_source_files())
        files.update(pure_source_files())
        files.update(lane_source_files())
        manifest = {'files': {name: W.pin(data) for name,data in files.items()}}
        allocation = self.root / 'attempt'; allocation.mkdir(mode=0o700)
        raw = W.stage_packet(allocation, manifest, files)
        W.verify_packet(allocation / 'source', raw, manifest)
        leaf = allocation / 'source/inputs/schema.sql'; leaf.chmod(0o600); leaf.write_bytes(b'changed')
        with self.assertRaisesRegex(RuntimeError, 'source changed'):
            W.verify_packet(allocation / 'source', raw, manifest)
        with self.assertRaises(FileExistsError): W.stage_packet(allocation, manifest, files)

    def test_omitted_or_extra_maintained_source_cannot_stage(self):
        allocation = self.root / 'attempt'; allocation.mkdir(mode=0o700)
        with self.assertRaisesRegex(RuntimeError, 'inventory'):
            W.stage_packet(allocation, {'files':{}}, {})
        self.assertIn('scripts/qualification/spin-expiry-committed-refund-oracle.py',W.REPLACEMENTS)
        self.assertIn('supabase/components/spin-expiry-lock-order.rollback.sql',W.REPLACEMENTS)


class RetentionSourceTests(unittest.TestCase):
    def test_actual_frozen_packet_pins_and_full_relative_include_graph(self):
        files = retention_source_files()
        W.validate_retention_sources(files)
        self.assertEqual(len(W.RETENTION_INPUTS), 24)
        # The catalog's shared oracle must be staged in addition to the new packet.
        manifest = json.loads(files[W.RETENTION_MANIFEST])
        self.assertIn('scripts/qualification/spin-expiry-business-state.sql',
                      manifest['relative_include_graph']['scripts/qualification/spin-history-retention.sql'])

    def test_missing_leaf_modified_sql_manifest_and_shared_oracle_refuse(self):
        for mode in ('missing', 'modified', 'manifest', 'shared'):
            files = retention_source_files()
            name = 'scripts/qualification/fixtures/spin-history-retention/provider-closure-check.sql'
            if mode == 'missing': del files[name]
            if mode == 'modified': files[name] += b'\n'
            if mode == 'manifest': files[W.RETENTION_MANIFEST] += b'\n'
            if mode == 'shared': files['scripts/qualification/spin-expiry-business-state.sql'] += b'\n'
            with self.subTest(mode=mode), self.assertRaises(RuntimeError): W.validate_retention_sources(files)

    def test_actual_include_graph_must_match_declared_graph_even_with_rebound_manifest(self):
        files = retention_source_files()
        manifest = json.loads(files[W.RETENTION_MANIFEST])
        manifest['relative_include_graph']['scripts/qualification/spin-history-retention.sql'].pop()
        files[W.RETENTION_MANIFEST] = json.dumps(manifest).encode()
        with patch.object(W, 'RETENTION_MANIFEST_SHA256', W.digest(files[W.RETENTION_MANIFEST])):
            with self.assertRaisesRegex(RuntimeError, 'include graph'):
                W.validate_retention_sources(files)

    def test_original_psql_output_requires_one_strict_result_and_catalog_marker(self):
        marker = W.RETENTION_CATALOG_MARKER.encode() + b'\n'
        raw = json.dumps(retention_behavior()).encode() + b'\n'
        self.assertEqual(W.retention_output(b'BEGIN\nROLLBACK\n' + marker, b'SET\n' + raw), retention_behavior())
        # Native psql setup emits multiple columns, not another JSON result.
        # Keep every diagnostic value while explicitly tagging those rows.
        claims = ((b'retention_setup_claims',
                   b'{"sub": "47965354-0e56-43ef-931c-ddaab82af765", "role": "service_role"}'
                   b'|47965354-0e56-43ef-931c-ddaab82af765|service_role\n'),
                  (b'retention_cancel_claims', b'{"role":"service_role"}|service_role|\n'))
        tagged = b''.join(label + b'|' + row for label, row in claims)
        self.assertEqual(W.retention_output(marker, tagged + raw), retention_behavior())
        for _, row in claims:
            with self.subTest(claims=row), self.assertRaises(ValueError):
                W.retention_output(marker, row + raw)
        for catalog, behavior in ((b'', raw), (marker * 2, raw), (marker, b'SET\n'),
                                  (marker, raw * 2), (marker, b'{bad JSON}'),
                                  (marker, b'{"qualification":1,"qualification":2}')):
            with self.subTest(catalog=catalog, behavior=behavior), self.assertRaises((RuntimeError, ValueError)):
                W.retention_output(catalog, behavior)

    def test_wrong_deletion_counts_overclaims_and_lossy_sequence_observations_refuse(self):
        changes = [('old_deleted', 2), ('candidate_deleted', 5), ('canonical_cancellation_count', 0),
                   ('table_and_catalog_rollback_verified', False), ('sequence_counters_restored', True),
                   ('completed_spin_qualified', True), ('multi_session_race_qualified', True),
                   ('candidate_deleted', 2.0)]
        for key, value in changes:
            wrong = retention_behavior(); wrong[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(RuntimeError):
                W.validate_retention_behavior(wrong)
        for mode in ('missing', 'numeric', 'overflow', 'called', 'extra'):
            wrong = retention_behavior(); observed = wrong['sequence_after']
            row = observed['public.content_authors_id_seq']
            if mode == 'missing': observed.pop('smarter_private.f06_lifecycle_seq')
            if mode == 'numeric': row['last_value'] = 1
            if mode == 'overflow': row['last_value'] = '9223372036854775808'
            if mode == 'called': row['is_called'] = 1
            if mode == 'extra': wrong['invented_success'] = True
            with self.subTest(mode=mode), self.assertRaises(RuntimeError): W.validate_retention_behavior(wrong)


class ReceiptTests(unittest.TestCase):
    def validate(self, value):
        return W.validate_receipt(value, EXECUTION, ORDINARY, TOURNAMENT, value.get('image'),
                                  MANIFEST_SHA, SOURCE, PG)

    def test_separate_images_do_not_claim_full_qualification(self):
        self.validate(receipt('preimage'))
        self.validate(receipt())

    def test_wrong_identity_failed_unknown_or_overclaim_refuses(self):
        for key, value in [('execution', ORDINARY), ('source_manifest_sha256', 'c' * 64),
                           ('native_status', 'failed_or_unknown'), ('business_scenario_passed', False),
                           ('tournament', ORDINARY), ('business_qualified', True),
                           ('cleanup_verified', False), ('cleanup_errors', ['fast stop failed']),
                           ('source_stable', False), ('full_qualification', True),
                           ('connected_services_qualified', True),
                           ('execution_backend','retired-service'), ('hosted_cleanup_observed',False),
                           ('original_clients_terminal',False)]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                self.validate(dict(receipt(), **{key: value}))

    def test_stage_identity_order_and_original_outcome_required(self):
        for mode in ('missing', 'repeated', 'wrong-user', 'failed', 'order'):
            value = receipt()
            if mode == 'missing': value['stages'].pop()
            if mode == 'repeated': value['stages'].append(copy.deepcopy(value['stages'][0]))
            if mode == 'wrong-user':
                argv = next(stage for stage in value['stages'] if stage['stage'] == 'spin_catalog_before')['argv']
                argv[argv.index('ordinary_user_uuid=' + ORDINARY)] = 'ordinary_user_uuid=' + EXECUTION
            if mode == 'failed': value['stages'][0]['returncode'] = 1
            if mode == 'order': value['stages'].reverse()
            with self.subTest(mode=mode), self.assertRaises(RuntimeError): self.validate(value)

    def test_each_case_requires_original_identity_order_outcome_and_bytes(self):
        for mode in ('missing', 'failed', 'repeated', 'early', 'wrong-execution', 'wrong-case-id', 'path', 'hash'):
            value = receipt()
            if mode == 'missing': value['business_cases'].pop()
            if mode == 'failed': value['business_cases'][-1]['state'] = 'running'
            if mode == 'repeated': value['business_cases'].append(copy.deepcopy(value['business_cases'][-1]))
            if mode == 'early': value['business_cases'].reverse()
            if mode == 'wrong-execution': value['business_cases'][0]['execution'] = ORDINARY
            if mode == 'wrong-case-id': value['business_cases'][0]['case_identity'] = EXECUTION + ':2:order'
            if mode == 'path': value['business_cases'][-1]['result_path'] = '../receipt.json'
            if mode == 'hash': value['business_cases'][-1]['result_sha256'] = None
            with self.subTest(mode=mode), self.assertRaises(RuntimeError): self.validate(value)

    def test_catalog_requires_one_success_before_install_and_equal_original_observers(self):
        for mode in ('flag', 'missing', 'repeated', 'late', 'failed', 'drift', 'wrong-source', 'preimage'):
            value = receipt()
            stages = value['stages']
            qualification = next(stage for stage in stages if stage['stage'] == 'spin_catalog_rollback_qualification')
            after = next(stage for stage in stages if stage['stage'] == 'spin_catalog_after')
            if mode == 'flag': value['catalog_slice_passed'] = False
            if mode == 'missing': stages.remove(qualification)
            if mode == 'repeated': stages.append(copy.deepcopy(qualification))
            if mode == 'late': stages.remove(qualification); stages.append(qualification)
            if mode == 'failed': qualification['returncode'] = 3
            if mode == 'drift': after['stdout_sha256'] = 'd' * 64
            if mode == 'wrong-source': qualification['argv'][-1] = '/old-provider/qualifier.sql'
            if mode == 'preimage': value = receipt('preimage'); value['catalog_slice_passed'] = True
            with self.subTest(mode=mode), self.assertRaises(RuntimeError): self.validate(value)

    def test_retention_stages_require_exact_role_order_identity_and_original_success(self):
        for name in ('authentic_settlement_source_authority', 'retention_provider_authority',
                     'retention_catalog_rollback', 'retention_behavior_rollback'):
            for mode in ('missing', 'repeated', 'early', 'late', 'failed', 'role', 'endpoint', 'source', 'hash'):
                value = receipt(); stages = value['stages']
                stage = next(item for item in stages if item['stage'] == name)
                if mode == 'missing': stages.remove(stage)
                if mode == 'repeated': stages.append(copy.deepcopy(stage))
                if mode == 'early': stages.remove(stage); stages.insert(0, stage)
                if mode == 'before-provider':
                    stages.remove(stage); stages.insert(next(i for i,x in enumerate(stages) if x['stage']=='retention_provider_authority'),stage)
                if mode == 'late': stages.remove(stage); stages.append(stage)
                if mode == 'failed': stage['returncode'] = 1
                if mode == 'role': stage['argv'][stage['argv'].index('-U') + 1] = 'service_role'
                if mode == 'endpoint': stage['argv'][stage['argv'].index('-h') + 1] = '127.0.0.1'
                if mode == 'source': stage['argv'][-1] = '/old/retention.sql'
                if mode == 'hash': stage.pop('stdout_sha256')
                with self.subTest(stage=name, mode=mode), self.assertRaises(RuntimeError): self.validate(value)
        for value in (None, {}, dict(retention_behavior(), table_and_catalog_rollback_verified=False)):
            with self.subTest(result=value), self.assertRaises(RuntimeError):
                self.validate(dict(receipt(), retention_qualification=value))

    def test_original_business_cli_is_bound_to_exact_image_and_fixture(self):
        for marker, replacement in (('--execution', ORDINARY), ('--tournament', ORDINARY),
                                    ('--image', 'preimage'), ('--case', 'timeout')):
            value = receipt()
            stage = next(s for s in value['stages'] if s['stage'] == 'actual_business_order')
            stage['argv'][stage['argv'].index(marker) + 1] = replacement
            with self.subTest(marker=marker), self.assertRaises(RuntimeError): self.validate(value)
        value = receipt('preimage')
        value['stages'].insert(0, {'stage': 'install_candidate', 'returncode': 0, 'argv': []})
        with self.assertRaises(RuntimeError): self.validate(value)



class HostedLifecycleTests(unittest.TestCase):
    def test_bootstrap_endpoint_preserves_listener_socket_and_diagnostic_identity_controls(self):
        socket_path = SOURCE.parent / 'work/socket'
        value = dict(user='fixture_bootstrap', session_user='fixture_bootstrap',
                     port='5432', address=None, listen_addresses='',
                     unix_socket_directories=str(socket_path))
        W.validate_server_endpoint(value, socket_path)
        for key, changed in [('listen_addresses','127.0.0.1'), ('unix_socket_directories','/tmp'),
                             ('address','127.0.0.1'), ('port','5433'), ('user','postgres'),
                             ('session_user','postgres')]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                W.validate_server_endpoint(dict(value, **{key: changed}), socket_path)
        for changed in (None, {}, dict(value, unobserved=True)):
            with self.subTest(value=changed), self.assertRaises(RuntimeError):
                W.validate_server_endpoint(changed, socket_path)
        for key in value:
            changed = dict(value); del changed[key]
            with self.subTest(missing=key), self.assertRaises(RuntimeError):
                W.validate_server_endpoint(changed, socket_path)

    def test_privileged_endpoint_readback_is_required_before_business(self):
        good = receipt('preimage')
        mutations = []
        missing = copy.deepcopy(good); del missing['server_endpoint']; mutations.append(missing)
        missing = copy.deepcopy(good); missing['stages'].pop(0); mutations.append(missing)
        duplicate = copy.deepcopy(good); duplicate['stages'].insert(0, copy.deepcopy(duplicate['stages'][0])); mutations.append(duplicate)
        failed = copy.deepcopy(good); failed['stages'][0]['returncode'] = 1; mutations.append(failed)
        wrong_role = copy.deepcopy(good); command = wrong_role['stages'][0]['argv']; command[command.index('-U') + 1] = 'postgres'; mutations.append(wrong_role)
        wrong_socket = copy.deepcopy(good); command = wrong_socket['stages'][0]['argv']; command[command.index('-h') + 1] = '/tmp'; mutations.append(wrong_socket)
        late = copy.deepcopy(good); late['stages'].append(late['stages'].pop(0)); mutations.append(late)
        for changed in mutations:
            with self.subTest(changed=changed), self.assertRaises(RuntimeError):
                W.validate_receipt(changed, EXECUTION, ORDINARY, TOURNAMENT,
                                   'preimage', MANIFEST_SHA, SOURCE, PG)

    def test_cleanup_first_failure_and_original_deadline_are_sticky(self):
        W.cleanup_negative_controls()
        outcome=W.CleanupOutcome(); outcome.failed('first failure'); outcome.observed_stopped()
        self.assertFalse(outcome.qualifies()); self.assertEqual(outcome.errors,['first failure'])
        self.assertEqual(W.command_budget(30,20,10),7)
        with self.assertRaises(TimeoutError): W.command_budget(30,27,10)

    def test_forced_client_cleanup_never_erases_failure_and_reaps_original_handle(self):
        class Client:
            pid = 12345
            def __init__(self, code): self.returncode = code; self.waits = 0
            def poll(self): return self.returncode
            def wait(self, timeout): self.waits += 1; self.returncode = -9; return -9
        client = Client(None); entry = {}; outcome = W.CleanupOutcome()
        with patch.object(W.os, 'killpg') as kill, \
                patch.object(W, 'process_group_absent', return_value=True), \
                patch.object(W.time, 'monotonic', return_value=1):
            self.assertTrue(W.finish_clients([(client,entry)], 30, outcome))
        kill.assert_called_once_with(client.pid, signal.SIGKILL)
        self.assertEqual(client.waits, 1); self.assertEqual(entry['terminal_returncode'], -9)
        outcome.observed_stopped()
        self.assertFalse(outcome.qualifies()); self.assertEqual(len(outcome.errors),1)
        # A live group exhausts the original deadline; it never earns a new one.
        client = Client(0); outcome = W.CleanupOutcome()
        with patch.object(W.os,'killpg'),patch.object(W,'process_group_absent',return_value=False), \
                patch.object(W.time,'monotonic',return_value=30):
            self.assertFalse(W.finish_clients([(client,{})],30,outcome))
        self.assertFalse(outcome.qualifies())

    def test_sequence_numeric_authority_refuses_rounded_bigints(self):
        row={'start':'1','increment':'1','minimum':'1','maximum':'9223372036854775807',
             'cache':'1','type':'bigint','cycle':False}
        W.sequence_negative_controls(row)

    def test_uuid_collision_with_canonical_refund_actor_refuses(self):
        with patch.object(W.uuid,'uuid4',side_effect=[EXECUTION,ORDINARY,W.REFUND_ACTOR]), \
                self.assertRaisesRegex(RuntimeError,'collision'): W.new_identity('candidate')
        with patch.object(W.uuid,'uuid4',side_effect=[EXECUTION,ORDINARY,TOURNAMENT]):
            args=W.new_identity('candidate')
        self.assertEqual((args.execution,args.ordinary_user,args.tournament),(EXECUTION,ORDINARY,TOURNAMENT))

    def test_still_live_process_group_is_not_terminal_evidence(self):
        with patch.object(W.os,'killpg',return_value=None): self.assertFalse(W.process_group_absent(123))
        with patch.object(W.os,'killpg',side_effect=ProcessLookupError): self.assertTrue(W.process_group_absent(123))
        with patch.object(W.os,'killpg',side_effect=PermissionError), self.assertRaises(PermissionError):
            W.process_group_absent(123)

    def test_case_original_failure_identity_and_financial_state_refuse(self):
        good={'scenario_observed':True,'cleanup_verified':True,'source_stable':True,
              'execution':EXECUTION,'fixture_tournament':TOURNAMENT,'image':'candidate','case':'timeout',
              'selected_before':{'amount':'2.00'},'selected_after':{'amount':'2.00'},
              'authority_before':{'function':'exact'},'authority_after':{'function':'exact'}}
        W.validate_case_result('timeout',json.dumps(good).encode(),EXECUTION,TOURNAMENT,'candidate')
        for key,value in [('scenario_observed',False),('cleanup_verified',False),('execution',ORDINARY),
                          ('selected_after',{'amount':'2.01'}),('authority_after',{'function':'changed'})]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                W.validate_case_result('timeout',json.dumps(dict(good,**{key:value})).encode(),EXECUTION,TOURNAMENT,'candidate')
        records=[{'execution':EXECUTION,'tournament':TOURNAMENT},
                 {'event':'terminal_source_oracle_result','observed':True,
                  'client_and_server_cleanup':True,'source_stable':True}]
        raw=lambda rs:'\n'.join(json.dumps(x) for x in rs).encode()
        W.validate_case_result('committed-refund',raw(records),EXECUTION,TOURNAMENT,'candidate')
        for key,value in [('observed',False),('client_and_server_cleanup',False),('source_stable',False),
                          ('event','commit_intent')]:
            damaged=copy.deepcopy(records);damaged[-1][key]=value
            with self.subTest(key=key),self.assertRaises(RuntimeError):
                W.validate_case_result('committed-refund',raw(damaged),EXECUTION,TOURNAMENT,'candidate')

    def test_every_candidate_case_retains_its_exact_stage_logs(self):
        value = receipt()
        with tempfile.TemporaryDirectory() as folder:
            work = Path(folder).resolve() / 'work'; work.mkdir(mode=0o700)
            out = work.parent / 'out'; out.mkdir(mode=0o700)
            (work / 'receipt.json').write_text(json.dumps(value))
            (work / W.LANE_RESULT).write_text('original lane result')
            for stage in value['stages']:
                for suffix in ('.stdout', '.stderr'):
                    (work / (stage['stage'] + suffix)).write_bytes(b'bounded case evidence')
            for case in value['business_cases']:
                (work / case['result_path']).write_bytes(b'original case result')
            kept = W.retained_evidence(work, out, value, b'{}')
            for stage in value['stages']:
                for suffix in ('.stdout', '.stderr'):
                    self.assertIn(stage['stage'] + suffix, kept)
            self.assertIn('committed-refund.jsonl', kept)

    def test_evidence_never_exports_pgdata_private_home_or_unrelated_file(self):
        with tempfile.TemporaryDirectory() as folder:
            work=Path(folder).resolve()/'work';work.mkdir(mode=0o700)
            out=work.parent/'out';out.mkdir(mode=0o700)
            for name in ['receipt.json','postgres.log','business-order.json','native.stdout','native.stderr']:
                (work/name).write_bytes(b'bounded original evidence')
            (work/'data').mkdir();(work/'data/PG_VERSION').write_bytes(b'17')
            (work/'home').mkdir();(work/'home/.spin-expiry.pgpass').write_bytes(b'')
            (work/'unrelated').write_bytes(b'not uploaded')
            kept=W.retained_evidence(work,out,{'stages':[{'stage':'native'}]},b'{}')
            self.assertEqual(set(kept),{'receipt.json','postgres.log','business-order.json','native.stdout','native.stderr'})
            self.assertFalse((out/'data').exists());self.assertFalse((out/'home').exists());self.assertFalse((out/'unrelated').exists())

    def test_three_images_run_in_order_and_stop_after_first_failure(self):
        for outcomes,expected in [([1],['preimage']),([0,1],['preimage','candidate']),
                                  ([0,0,1],list(W.IMAGES)),([0,0,0],list(W.IMAGES))]:
            with self.subTest(outcomes=outcomes),patch.object(W,'source_controls',return_value=True), \
                    patch.object(W,'find_pg',return_value=PG),patch.object(W,'run_image',side_effect=outcomes) as run, \
                    patch.object(W.sys,'argv',['wrapper']),patch.object(W.sys,'platform','linux'), \
                    patch.object(W.os,'geteuid',return_value=1000),patch.object(W.signal,'signal'):
                result=W.main()
                self.assertEqual([call.args[0] for call in run.call_args_list],expected)
                self.assertEqual(result,1 if 1 in outcomes else 0)

    def test_failed_source_controls_prevent_native_allocation(self):
        with patch.object(W,'source_controls',return_value=False),patch.object(W,'run_image') as run, \
                patch.object(W.sys,'argv',['wrapper']):
            self.assertEqual(W.main(),1)
        run.assert_not_called()


class CompletedRetentionTests(unittest.TestCase):
    def validate(self, value):
        return W.validate_receipt(value, EXECUTION, ORDINARY, TOURNAMENT,
                                  'retention-completed', MANIFEST_SHA, SOURCE, PG)

    def test_success_is_receipt_eligibility_only_with_no_business_cases(self):
        self.assertEqual(self.validate(completed_receipt()), [])
        self.assertEqual(W.completed_retention_output(json.dumps(completed_result()).encode()), completed_result())
        self.assertEqual(W.IMAGES, ('preimage', 'candidate', 'retention-completed'))
        self.assertEqual(W.CASES, {'preimage': ('order',), 'candidate': ('order', 'timeout', 'committed-refund'),
                                  'retention-completed': ()})

    def test_exact_source_pins_and_every_relative_include_are_staged(self):
        files = completed_source_files()
        W.validate_completed_sources(files)
        manifest = W.decode(files[W.COMPLETED_MANIFEST])
        self.assertEqual(len(manifest['files']), 6)
        self.assertTrue(set(W.COMPLETED_INPUTS) <= set(W.REPLACEMENTS))
        for name in W.COMPLETED_INPUTS:
            missing = dict(files); del missing[name]
            with self.subTest(missing=name), self.assertRaises(RuntimeError): W.validate_completed_sources(missing)
            changed = dict(files); changed[name] += b'changed'
            with self.subTest(changed=name), self.assertRaises(RuntimeError): W.validate_completed_sources(changed)
        for shared in ('database-state.sql', 'component-inputs.sql'):
            changed = dict(files)
            changed['scripts/qualification/fixtures/spin-history-retention/' + shared] += b'changed'
            with self.subTest(shared=shared), self.assertRaises(RuntimeError): W.validate_completed_sources(changed)

        files = completed_source_files(); manifest = W.decode(files[W.COMPLETED_MANIFEST])
        manifest['consumed_retention_manifest']['sha256'] = '0' * 64
        files[W.COMPLETED_MANIFEST] = json.dumps(manifest).encode()
        with patch.object(W, 'COMPLETED_MANIFEST_SHA256', W.digest(files[W.COMPLETED_MANIFEST])), \
                self.assertRaisesRegex(RuntimeError, 'dependency revision'):
            W.validate_completed_sources(files)

    def test_include_graph_rejects_undeclared_or_missing_include_even_if_rebound(self):
        for include in ('completed-start-authority.json', '../../../../missing.sql'):
            files = completed_source_files(); manifest = W.decode(files[W.COMPLETED_MANIFEST])
            name = W.COMPLETED_RESTORE
            files[name] += ('\n\\ir ' + include + '\n').encode()
            manifest['files'][name] = W.pin(files[name])
            files[W.COMPLETED_MANIFEST] = json.dumps(manifest).encode()
            with patch.object(W, 'COMPLETED_MANIFEST_SHA256', W.digest(files[W.COMPLETED_MANIFEST])), \
                    self.assertRaises(RuntimeError): W.validate_completed_sources(files)

    def test_each_phase_requires_original_role_source_success_identity_and_order(self):
        for name in W.completed_sql_stages(SOURCE):
            for mode in ('missing', 'repeated', 'early', 'late', 'failed', 'role', 'endpoint', 'source', 'hash'):
                value = completed_receipt(); stages = value['stages']
                stage = next(item for item in stages if item['stage'] == name)
                if mode == 'missing': stages.remove(stage)
                if mode == 'repeated': stages.append(copy.deepcopy(stage))
                if mode == 'early': stages.remove(stage); stages.insert(0, stage)
                if mode == 'before-provider':
                    stages.remove(stage); stages.insert(next(i for i,x in enumerate(stages) if x['stage']=='retention_provider_authority'),stage)
                if mode == 'late':
                    # Move before the prior phase; moving the last stage to the
                    # end would not mutate the protocol.
                    index = stages.index(stage); stages[index-1], stages[index] = stage, stages[index-1]
                if mode == 'failed': stage['returncode'] = 1
                if mode == 'role': stage['argv'][stage['argv'].index('-U') + 1] = 'service_role'
                if mode == 'endpoint': stage['argv'][stage['argv'].index('-h') + 1] = '127.0.0.1'
                if mode == 'source': stage['argv'][-1] = '/old/retention.sql'
                if mode == 'hash': stage.pop('stdout_sha256')
                with self.subTest(stage=name, mode=mode), self.assertRaises(RuntimeError): self.validate(value)

    def test_completed_estate_cannot_reach_money_or_unfinished_cases(self):
        for stage in ('real_funded_paid_seat_fixture', 'actual_business_order', 'actual_business_committed_refund',
                      'spin_catalog_before', 'install_candidate', 'retention_catalog_rollback', 'retention_behavior_rollback'):
            value = completed_receipt(); value['stages'].append({'stage': stage, 'returncode': 0, 'argv': []})
            with self.subTest(stage=stage), self.assertRaises(RuntimeError): self.validate(value)
        for key, bad in (('natural_aging', {}), ('business_scenario_passed', True), ('business_qualified', True),
                         ('full_qualification', True), ('catalog_slice_passed', True), ('retention_qualification', retention_behavior()),
                         ('cleanup_errors', ['original stop failed']), ('cleanup_verified', False),
                         ('hosted_cleanup_observed', False), ('original_clients_terminal', False),
                         ('source_stable', False), ('native_status', 'business_scenario_passed_cleanup_observed')):
            with self.subTest(key=key), self.assertRaises(RuntimeError): self.validate(dict(completed_receipt(), **{key: bad}))
        for image in ('preimage', 'candidate'):
            for stage in ('restore_completed_start', 'retention_completed_eligibility'):
                value = receipt(image); value['stages'].append({'stage': stage, 'returncode': 0, 'argv': []})
                with self.subTest(image=image, stage=stage), self.assertRaises(RuntimeError):
                    W.validate_receipt(value, EXECUTION, ORDINARY, TOURNAMENT, image, MANIFEST_SHA, SOURCE, PG)

    def test_result_refuses_changed_receipt_missing_rollback_overclaims_and_duplicate_json(self):
        for key, value in completed_result().items():
            if key.startswith('sequence_') and isinstance(value, dict): continue
            changed = completed_result(); changed[key] = not value if type(value) is bool else None
            with self.subTest(key=key), self.assertRaises(RuntimeError): W.validate_completed_retention(changed)
        for key in ('sequence_before', 'sequence_after'):
            for wrong in (None, {}, {'last_value': 1}):
                with self.subTest(key=key, wrong=wrong), self.assertRaises(RuntimeError):
                    W.validate_completed_retention(dict(completed_result(), **{key: wrong}))
        good = json.dumps(completed_result()).encode()
        for output in (b'', good + b'\n' + good, good.replace(b'"old_deleted": 1', b'"old_deleted": 1, "old_deleted": 1')):
            with self.subTest(output=output), self.assertRaises(RuntimeError): W.completed_retention_output(output)

    def test_completed_original_output_and_cleanup_required_before_allocation_disposal(self):
        # Only the adapter protocol is simulated; no PG command executes.
        for mode in ('success', 'changed-output', 'failed-cleanup', 'changed-pure-output', 'missing-pure-output'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as folder:
                root = Path(folder).resolve(); allocation = root / 'allocation'; allocation.mkdir(mode=0o700)
                args = W.argparse.Namespace(execution=EXECUTION, ordinary_user=ORDINARY,
                                            tournament=TOURNAMENT, image='retention-completed')
                def staged(allocation, manifest, files):
                    (allocation / 'source').mkdir(mode=0o700)
                    return b'{}'
                def qualified(args, allocation, raw, manifest, pg):
                    work = allocation / 'work'; work.mkdir(mode=0o700)
                    value = completed_receipt(allocation / 'source')
                    value['source_manifest_sha256'] = W.digest(raw)
                    if mode == 'failed-cleanup': value['cleanup_errors'] = ['original fast-stop failure']
                    for stage in value['stages']:
                        output = (json.dumps(completed_result()).encode() if stage['stage'] == 'retention_completed_eligibility'
                                  else json.dumps(pure_result()).encode() if stage['stage'] == W.PURE_STAGE
                                  else b'original protocol output')
                        stage['stdout_sha256'] = W.digest(output)
                        if mode == 'changed-output' and stage['stage'] == 'retention_completed_eligibility': output += b'changed'
                        if mode == 'changed-pure-output' and stage['stage'] == W.PURE_STAGE: output += b'changed'
                        if not (mode == 'missing-pure-output' and stage['stage'] == W.PURE_STAGE):
                            (work / (stage['stage'] + '.stdout')).write_bytes(output)
                        (work / (stage['stage'] + '.stderr')).write_bytes(b'')
                    (work / 'receipt.json').write_text(json.dumps(value))
                    return value
                with patch.object(W, 'ROOT', root), patch.object(W, 'new_identity', return_value=args), \
                        patch.object(W, 'source_packet', return_value=({'files': {}}, {})), \
                        patch.object(W.tempfile, 'mkdtemp', return_value=str(allocation)), \
                        patch.object(W, 'stage_packet', side_effect=staged), patch.object(W, 'qualify', side_effect=qualified):
                    result = W.run_image('retention-completed', PG)
                self.assertEqual(result, 0 if mode == 'success' else 1)
                self.assertEqual(allocation.exists(), mode != 'success')
                output = root / 'artifacts/spin-expiry' / EXECUTION
                if mode == 'missing-pure-output':
                    # Incomplete original logs refuse export/disposal; the exact
                    # receipt and remaining evidence stay in the owned allocation.
                    self.assertTrue((allocation / 'work/receipt.json').exists())
                    self.assertFalse((output / 'receipt.json').exists())
                else:
                    self.assertTrue((output / 'receipt.json').exists())
                    self.assertTrue((output / 'retention_completed_eligibility.stdout').exists())
                self.assertEqual(json.loads((output / 'RESULT.json').read_text())['passed'], mode == 'success')


class PureEvidenceTests(unittest.TestCase):
    def validate(self, value, image='candidate'):
        return W.validate_receipt(value, EXECUTION, ORDINARY, TOURNAMENT, image,
                                  MANIFEST_SHA, SOURCE, PG)

    def test_exact_sources_embedded_bodies_and_include_graph(self):
        files = pure_source_files()
        W.validate_pure_sources(files)
        self.assertEqual(set(W.decode(files[W.PURE_MANIFEST])['files']),
                         {W.PURE_COMPONENT, W.PURE_SHAPE, W.PURE_PREIMAGE, W.PURE_QUALIFIER, W.PURE_ORACLE})
        self.assertFalse(any('terminal' in name or 'receipt-lane' in name for name in W.PURE_INPUTS))
        for name in W.PURE_INPUTS:
            missing = dict(files); missing.pop(name)
            modified = dict(files); modified[name] += b'changed'
            for value in (missing, modified):
                with self.subTest(name=name), self.assertRaises(RuntimeError): W.validate_pure_sources(value)

    def test_rebound_manifest_cannot_hide_embedded_authority_or_include_drift(self):
        for mode in ('component', 'shape', 'preimage', 'embedded_preimage', 'preimage_commit', 'preimage_error', 'include', 'scope', 'role'):
            files = pure_source_files(); manifest = W.decode(files[W.PURE_MANIFEST])
            if mode in ('component', 'shape'):
                path = W.PURE_COMPONENT if mode == 'component' else W.PURE_SHAPE
                files[path] += b'-- source no longer matches embedded body\n'
                manifest['files'][path] = W.pin(files[path])
            if mode == 'preimage':
                # Even rebinding the manifest cannot redefine the original HEAD bytes.
                files[W.PURE_PREIMAGE] += b'-- original authority changed\n'
                manifest['files'][W.PURE_PREIMAGE] = W.pin(files[W.PURE_PREIMAGE])
                manifest['regression_preimage']['sha256'] = W.digest(files[W.PURE_PREIMAGE])
            if mode == 'embedded_preimage':
                files[W.PURE_QUALIFIER] = files[W.PURE_QUALIFIER].replace(
                    b'$mixed_preimage_source$-- SOURCE-ONLY', b'$mixed_preimage_source$-- CHANGED', 1)
                manifest['files'][W.PURE_QUALIFIER] = W.pin(files[W.PURE_QUALIFIER])
            if mode == 'preimage_commit': manifest['regression_preimage']['commit'] = '0' * 40
            if mode == 'preimage_error': manifest['regression_preimage']['control_sqlstate'] = 'P0001'
            if mode == 'include':
                files[W.PURE_QUALIFIER] += b'\n\\ir spin-mixed-basis-terminal.sql\n'
                manifest['files'][W.PURE_QUALIFIER] = W.pin(files[W.PURE_QUALIFIER])
            if mode == 'scope': manifest['full_qualification'] = True
            if mode == 'role': manifest['stage']['role'] = 'service_role'
            files[W.PURE_MANIFEST] = json.dumps(manifest).encode()
            with self.subTest(mode=mode), patch.object(W, 'PURE_MANIFEST_SHA256', W.digest(files[W.PURE_MANIFEST])), \
                    self.assertRaises(RuntimeError): W.validate_pure_sources(files)

    def test_partial_original_result_exact_counts_types_and_no_extra_claims(self):
        raw = json.dumps(pure_result()).encode()
        self.assertEqual(W.pure_output(b'BEGIN\nROLLBACK\n' + raw), pure_result())
        for output in (b'', raw+b'\n'+raw, b'{bad}\n'+raw, raw[:-1],
                       raw.replace(b'"full_qualification": false', b'"full_qualification": false, "full_qualification": false')):
            with self.subTest(output=output[:40]), self.assertRaises((RuntimeError, ValueError)):
                W.pure_output(output)
        for key, original in pure_result().items():
            wrong = dict(pure_result()); wrong[key] = (not original if type(original) is bool else None)
            with self.subTest(key=key), self.assertRaises(RuntimeError): W.validate_pure_result(wrong)
        for wrong in (dict(pure_result(), shape_positive=True), dict(pure_result(), new_claim=True)):
            with self.assertRaises(RuntimeError): W.validate_pure_result(wrong)

    def test_every_original_image_requires_pure_phase_before_retention_or_money(self):
        for image in W.IMAGES:
            original = completed_receipt() if image == 'retention-completed' else receipt(image)
            self.validate(original, image)
            for mode in ('missing', 'repeated', 'early', 'before-provider', 'late', 'role', 'identity', 'failed', 'hash', 'result'):
                value = copy.deepcopy(original); stages = value['stages']
                stage = next(item for item in stages if item['stage'] == 'mixed_pure_evidence_rollback')
                if mode == 'missing': stages.remove(stage)
                if mode == 'repeated': stages.append(copy.deepcopy(stage))
                if mode == 'early': stages.remove(stage); stages.insert(0, stage)
                if mode == 'before-provider':
                    stages.remove(stage); stages.insert(next(i for i,x in enumerate(stages) if x['stage']=='retention_provider_authority'),stage)
                if mode == 'late': stages.remove(stage); stages.append(stage)
                if mode == 'role': stage['argv'][stage['argv'].index('-U')+1] = 'fixture_bootstrap'
                if mode == 'identity': stage['argv'][-1] = '/old/pure.sql'
                if mode == 'failed': stage['returncode'] = 1
                if mode == 'hash': stage.pop('stdout_sha256')
                if mode == 'result': value['mixed_pure_qualification'] = None
                with self.subTest(image=image, mode=mode), self.assertRaises(RuntimeError): self.validate(value,image)

    def test_original_images_cases_and_budgets_unchanged(self):
        self.assertEqual(W.IMAGES, ('preimage','candidate','retention-completed'))
        self.assertEqual(W.CASES, {'preimage':('order',), 'candidate':('order','timeout','committed-refund'),
                                  'retention-completed':()})
        source = Path(W.__file__).read_text()
        self.assertIn('deadline = time.monotonic() + 240', source)
        self.assertIn("'cleanup_deadline_seconds': 30", source)


class ReceiptLaneTests(unittest.TestCase):
    def validate(self, value, image='candidate'):
        return W.validate_receipt(value,EXECUTION,ORDINARY,TOURNAMENT,image,MANIFEST_SHA,SOURCE,PG)

    def test_sealed_authentic_inputs_include_graph_and_embedded_components(self):
        files=lane_source_files(); W.validate_lane_sources(files)
        self.assertEqual(W.IMAGES,('preimage','candidate','retention-completed'))
        self.assertEqual(W.CASES,{'preimage':('order',),'candidate':('order','timeout','committed-refund'),
                                 'retention-completed':()})
        for name in W.LANE_INPUTS:
            changed=dict(files);changed[name]+=b'changed'
            with self.subTest(path=name),self.assertRaises((RuntimeError,ValueError)):
                W.validate_lane_sources(changed)
        missing=dict(files);del missing[W.PURE_ORACLE]
        with self.assertRaises(RuntimeError): W.validate_lane_sources(missing)

    def test_resealed_embedded_drift_and_include_omission_still_refuse(self):
        for mode in ('body','include','capture','session','cohort-preimage','cohort-guard'):
            files=lane_source_files();manifest=W.decode(files[W.LANE_MANIFEST])
            if mode=='body':
                name=W.LANE_BASE+'component-inputs.sql';files[name]=files[name].replace(b'PERFORM public.',b'PERFORM changed.',1)
            elif mode=='include':
                manifest['relative_include_graph'].pop('scripts/qualification/spin-receipt-lane.sql')
                name=None
            elif mode=='cohort-preimage':
                manifest['cohort_guard_preimage']['transaction_body_sha256']='0'*64
                name=None
            elif mode=='cohort-guard':
                name='scripts/qualification/spin-receipt-lane.sql'
                files[name]=files[name].replace(b'480be3139fe0878e637ce54f533a2170',b'0'*32,1)
            else:
                name=W.LANE_BASE+'authority.json' if mode=='capture' else W.LANE_SESSION
                files[name]+=b'\n'
            if name:manifest['files'][name]=W.pin(files[name])
            files[W.LANE_MANIFEST]=(json.dumps(manifest)+'\n').encode()
            with patch.object(W,'LANE_MANIFEST_SHA256',W.digest(files[W.LANE_MANIFEST])),self.subTest(mode=mode),self.assertRaises(RuntimeError):
                W.validate_lane_sources(files)

    def test_exact_original_outputs_and_physical_hint_only_difference(self):
        outputs=lane_originals(); raw=json.dumps(lane_races()).encode()
        result=W.lane_outputs(outputs,raw,EXECUTION,lane_source_files())
        self.assertEqual(result['catalog'],lane_catalog());self.assertFalse(result['full_qualification'])
        for mode in ('retained-handler','changed-business','changed-proc','missing-hint','malformed','duplicate','catalog-control'):
            changed=copy.deepcopy(outputs)
            if mode in ('malformed','duplicate'):
                changed['receipt_lane_catalog']+=b'{' if mode=='malformed' else b'\n'+changed['receipt_lane_catalog']
            elif mode=='catalog-control':
                row=lane_catalog();row['altered_binding_refusals']=6
                changed['receipt_lane_catalog']=json.dumps(row).encode()
            else:
                row=W.lane_json(changed['receipt_lane_after'])
                if mode=='retained-handler':row['handler']={'owner':'postgres'}
                if mode=='changed-business':row['business']['retained']=[{'amount':1}]
                if mode=='changed-proc':row['catalog']['retained']='changed'
                if mode=='missing-hint':del row['relation_trigger_hints']
                changed['receipt_lane_after']=json.dumps(row).encode()
            with self.subTest(mode=mode),self.assertRaises((RuntimeError,ValueError)):
                W.lane_outputs(changed,raw,EXECUTION,lane_source_files())

    def test_session_protocol_refuses_wrong_role_lock_identity_rows_and_missing_cases(self):
        W.validate_lane_races(lane_races(),EXECUTION,lane_source_files())
        for mode in ('missing','repeat','reorder','role','pid','wait','blocker','affected','truncate','metadata'):
            value=lane_races();rows=value['cases']
            if mode=='missing':rows.pop()
            if mode=='repeat':rows.append(copy.deepcopy(rows[0]))
            if mode=='reorder':rows[:2]=reversed(rows[:2])
            if mode=='role':rows[0]['role']='postgres'
            if mode=='pid':rows[0]['writer_pid']=999
            if mode=='wait':rows[0]['wait']['wait_event']='relation'
            if mode=='blocker':rows[0]['wait']['blockers']=[999]
            if mode=='affected':rows[0]['affected_rows']=1
            if mode=='truncate':rows[7]['sqlstate']='42501'
            if mode=='metadata':rows[5]['wait']=copy.deepcopy(rows[0]['wait'])
            with self.subTest(mode=mode),self.assertRaises(RuntimeError):
                W.validate_lane_races(value,EXECUTION,lane_source_files())

    def test_reverse_cohort_protocol_requires_observed_before_and_four_refusals(self):
        raw=json.dumps(lane_races()).encode(); files=lane_source_files()
        value=W.lane_outputs(lane_originals(),raw,EXECUTION,files)['catalog']
        self.assertIs(value['original_cohort_mismatch_reproduced'],True)
        self.assertEqual(value['reverse_prerequisite_refusals'],4)
        for key,bad in [('original_cohort_mismatch_reproduced',None),
                        ('original_cohort_mismatch_reproduced',False),
                        ('original_cohort_mismatch_reproduced',1),
                        ('reverse_prerequisite_refusals',None),
                        ('reverse_prerequisite_refusals',3),
                        ('reverse_prerequisite_refusals',5),
                        ('reverse_prerequisite_refusals',True)]:
            outputs=lane_originals(); row=lane_catalog()
            if bad is None: del row[key]
            else: row[key]=bad
            outputs['receipt_lane_catalog']=json.dumps(row).encode()
            with self.subTest(key=key,bad=bad),self.assertRaises(RuntimeError):
                W.lane_outputs(outputs,raw,EXECUTION,files)

    def test_session_cleanup_authority_source_and_qualification_claims_fail_closed(self):
        for mode in ('foreign-execution','helper-acl','helper-owner','source','dead-client','live-backend',
                     'unknown-verifier','changed-state','failure','missing-transcript','overclaim'):
            value=lane_races()
            if mode=='foreign-execution':value['execution']=ORDINARY
            if mode=='helper-acl':value['shared_helper_authority']['acl']='{postgres=X/postgres}'
            if mode=='helper-owner':value['shared_helper_authority']['owner']='service_role'
            if mode=='source':value['source_sha256'][W.LANE_SESSION]='0'*64
            if mode=='dead-client':value['clients'][0]['client_exit']=-9
            if mode=='live-backend':value['backend_cleanup']['backends']=1
            if mode=='unknown-verifier':value['verifier_client']['client_exit']=None
            if mode=='changed-state':value['after']['business']['public.hand_history']=[{'id':'fake'}]
            if mode=='failure':value['failure']={'type':'TimeoutError'}
            if mode=='missing-transcript':value['transcripts'].pop(next(iter(value['transcripts'])))
            if mode=='overclaim':value['financial_completion_qualified']=True
            with self.subTest(mode=mode),self.assertRaises(RuntimeError):
                W.validate_lane_races(value,EXECUTION,lane_source_files())

    def test_phase_protocol_requires_original_candidate_only_roles_order_and_identity(self):
        self.validate(receipt())
        for name in W.LANE_STAGES:
            for mode in ('missing','repeated','early','role','argv','failed','digest'):
                value=receipt();stages=value['stages'];row=next(x for x in stages if x['stage']==name)
                if mode=='missing':stages.remove(row)
                if mode=='repeated':stages.append(copy.deepcopy(row))
                if mode=='early':stages.remove(row);stages.insert(1,row)
                if mode=='role':
                    if '-U' in row['argv']:row['argv'][row['argv'].index('-U')+1]='fixture_bootstrap'
                    else:row['argv'][0]='/other/python'
                if mode=='argv':row['argv'][-1]='/other/source'
                if mode=='failed':row['returncode']=1
                if mode=='digest':row['stdout_sha256']='f'*64
                with self.subTest(stage=name,mode=mode),self.assertRaises(RuntimeError):self.validate(value)
        for image in ('preimage','retention-completed'):
            value=receipt(image) if image=='preimage' else completed_receipt()
            value['stages'].append(next(x for x in receipt()['stages'] if x['stage']=='receipt_lane_install'))
            with self.subTest(image=image),self.assertRaises(RuntimeError):self.validate(value,image)

    def test_actual_finite_wait_refuses_early_completion_foreign_blocker_and_deadline(self):
        spec=importlib.util.spec_from_file_location('lane_finite_wait',Path(__file__).resolve().parents[2]/W.LANE_PROGRAM)
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        class Holder: pid=102
        class Writer:
            pid=103
            def __init__(self,result=None):self.result=result
            def poll(self):return self.result
        class Observer:
            def __init__(self,value):self.value=value;self.calls=0
            def json(self,query):self.calls+=1;return self.value
        expected={'pid':103,'wait_event_type':'Lock','wait_event':'advisory','blockers':[102]}
        observer=Observer(expected)
        with patch.object(module.time,'monotonic',return_value=1):
            self.assertEqual(module.wait_for_block(observer,Holder(),Writer(),'advisory',2),expected)
        with patch.object(module.time,'monotonic',return_value=1),self.assertRaisesRegex(RuntimeError,'completed'):
            module.wait_for_block(observer,Holder(),Writer('0'),'advisory',2)
        for value in (None,dict(expected,blockers=[999]),dict(expected,wait_event='relation')):
            observer=Observer(value)
            with patch.object(module.time,'monotonic',side_effect=[1,3]),patch.object(module.time,'sleep') as pause, \
                    self.subTest(value=value),self.assertRaises(TimeoutError):
                module.wait_for_block(observer,Holder(),Writer(),'advisory',2)
            self.assertEqual(observer.calls,1);pause.assert_called_once_with(0.01)

    def test_snapshot_comparison_keeps_exact_decimal_difference(self):
        first=W.lane_json(b'{"amount":9007199254740992.01}')
        second=W.lane_json(b'{"amount":9007199254740992.02}')
        self.assertNotEqual(first,second)
        self.assertEqual(str(second['amount']-first['amount']),'0.01')

    def test_real_rpc_protocol_requires_entry_wait_canonical_row_and_unchanged_replay(self):
        for mode in ('positive-rake','pre-entry-write','duplicate','no-real-row','replay-result','replay-tuple',
                     'wrong-key','attempt-count','error','unrolled-row','foreign-key'):
            value=lane_races();rpc=value['cases'][-1]
            if mode=='positive-rake':rpc['first_result']['rake']={'success':True,'rake_amount':1}
            if mode=='pre-entry-write':rpc['pre_entry_receipt_write_locks']=1
            if mode=='duplicate':rpc['created_receipts']=2
            if mode=='no-real-row':rpc['receipt_before_replay']['rows']=[]
            if mode=='replay-result':rpc['replay_result']['commissions']=[{'amount':1}]
            if mode=='replay-tuple':rpc['receipt_after_replay']['rows'][0]['ctid']='(0,2)'
            if mode=='wrong-key':rpc['receipt_after_replay']['rows'][0]['row']['hand_id']=ORDINARY
            if mode=='attempt-count':
                rpc['receipt_before_replay']['rows'][0]['row']['attempt_count']=2
                rpc['receipt_after_replay']['rows'][0]['row']['attempt_count']=2
            if mode=='error':
                rpc['receipt_before_replay']['rows'][0]['row']['error']='unknown'
                rpc['receipt_after_replay']['rows'][0]['row']['error']='unknown'
            if mode=='unrolled-row':rpc['rollback_receipts']=1
            if mode=='foreign-key':rpc['receipt_fk_count']=1
            with self.subTest(mode=mode),self.assertRaises(RuntimeError):
                W.validate_lane_races(value,EXECUTION,lane_source_files())
