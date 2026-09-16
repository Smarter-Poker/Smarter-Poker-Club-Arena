"""Bounded source-specific adapter controls; no PostgreSQL or privileged commands.

Invoked by test-spin-expiry-postgres.py --self-test in the
same required step immediately before the actual PG qualifier. These controls
are not native SQL, systemd, provider installation or connected-service proof.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import signal
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('spin_expiry_pg_wrapper', Path(__file__).with_name('test-spin-expiry-postgres.py'))
W = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(W)
EXECUTION = '00000000-0000-4000-8000-000000000001'
ORDINARY = '00000000-0000-4000-8000-000000000002'
TOURNAMENT = '00000000-0000-4000-8000-000000000003'
INVOCATION = 'a' * 32
MANIFEST_SHA = 'b' * 64
GROUP = '/system.slice/spin5-business-' + EXECUTION + '.service'


def terminal():
    return {'LoadState': 'loaded', 'ActiveState': 'inactive', 'SubState': 'dead',
            'Result': 'success', 'ExecMainStatus': '0', 'MainPID': '0',
            'ControlGroup': '', 'InvocationID': INVOCATION}


def receipt(image='candidate'):
    # Tiny protocol observations only, never evidence that SQL or refunds passed.
    source = W.BASE / ('spin5-business-' + EXECUTION) / 'source'
    sql = [W.PG + '/psql', '-v', 'execution_uuid=' + EXECUTION,
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
    records = []
    for ordinal, case in enumerate(W.CASES[image], start=1):
        common = ['--psql', W.PG + '/psql', '--execution', EXECUTION, '--tournament', TOURNAMENT]
        if case == 'committed-refund':
            argv = ['/usr/bin/python3', str(source / 'scripts/qualification/spin-expiry-committed-refund.py')]
            argv += common + ['--journal', str(source.parent / 'work' / W.CASE_RESULTS[case])]
        else:
            argv = ['/usr/bin/python3', str(source / 'scripts/qualification/spin-expiry-business-races.py')]
            argv += common + ['--image', image, '--case', case,
                              '--output', str(source.parent / 'work' / W.CASE_RESULTS[case])]
        stages.append({'stage': 'actual_business_' + case, 'returncode': 0, 'argv': argv})
        records.append({'case': case, 'execution': EXECUTION,
                        'case_identity': EXECUTION + ':' + str(ordinal) + ':' + case,
                        'state': 'passed', 'result_path': W.CASE_RESULTS[case],
                        'result_sha256': W.digest(b'unit-test case bytes')})
    return {'execution': EXECUTION, 'source_manifest_sha256': MANIFEST_SHA,
            'image': image, 'tournament': TOURNAMENT, 'catalog_slice_passed': image == 'candidate',
            'native_status': 'business_scenario_passed_cleanup_observed', 'business_scenario_passed': True,
            'business_qualified': False, 'cleanup_verified': True, 'cleanup_errors': [], 'source_stable': True,
            'full_qualification': False, 'connected_services_qualified': False,
            'systemd_invocation': INVOCATION, 'cgroup': GROUP, 'host_netns': 'net:[100]',
            'worker_netns': 'net:[101]', 'resource_controls': {'cpu.max': '100000 100000',
            'memory.max': '2147483648', 'memory.swap.max': '0', 'pids.max': '128'},
            'stages': stages, 'business_cases': records}


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name).resolve()
        # Content-only tiny fixture. Root filesystem authority is mocked only in
        # these tests; production load_provider always calls the real guard.
        self.files = {name: (name + '\n').encode() for name in W.REQUIRED}
        self.files['checkout-replacements.json'] = json.dumps(W.REPLACEMENTS).encode()
        self.manifest = {'source_owner_commit': 'old-provider-origin', 'resources': dict(W.RESOURCES),
                         'files': {name: W.pin(data) for name, data in self.files.items()}}
        for name, data in self.files.items():
            path = self.directory / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        self.raw = (json.dumps(self.manifest) + '\n').encode()
        (self.directory / 'manifest.json').write_bytes(self.raw)

    def load(self, sha=None):
        with patch.object(W, 'root_custody'):
            return W.load_provider(str(self.directory), sha or W.digest(self.raw))

    def test_valid_manifest_retains_every_fixed_byte(self):
        raw, manifest, files = self.load()
        self.assertEqual(raw, self.raw)
        self.assertEqual(files, self.files)
        changed = {name: b'actual committed qualification source\n' for name in W.REPLACEMENTS}
        provenance = {'provider_declared_source_owner_commit': 'old-provider-origin', 'attempt_source_commit': 'actual-checkout'}
        produced, copied = W.attempt_source(manifest, files, changed, provenance)
        self.assertEqual(produced['ci_provenance'], provenance)
        self.assertEqual(produced['source_owner_commit'], 'old-provider-origin')
        for name in files:
            self.assertEqual(copied[name], changed.get(name, files[name]))
            self.assertEqual(produced['files'][name], W.pin(copied[name]))
        self.assertEqual(manifest, self.manifest)

    def test_missing_config_or_wrong_manifest_never_defaults(self):
        for configured in ('', 'no-pin', 'A' * 64, '0' * 64):
            with self.subTest(pin=configured), self.assertRaises(RuntimeError):
                W.load_provider(str(self.directory), configured)

    def test_drift_unpinned_leaf_and_symlink_refuse(self):
        leaf = self.directory / 'run.py'
        leaf.write_bytes(b'drift')
        with self.assertRaisesRegex(RuntimeError, 'leaf mismatch'):
            self.load()
        leaf.write_bytes(self.files['run.py'])
        extra = self.directory / 'unexpected.py'
        extra.write_bytes(b'extra')
        with self.assertRaisesRegex(RuntimeError, 'unpinned'):
            self.load()
        extra.unlink()
        leaf.unlink(); leaf.symlink_to(self.directory / 'principals.sql')
        with self.assertRaisesRegex(RuntimeError, 'non-regular'):
            self.load()

    def test_duplicate_or_traversal_manifest_refuses(self):
        with self.assertRaisesRegex(RuntimeError, 'duplicate'):
            W.decode(b'{"files":{},"files":{}}')
        for name in ('../x', '/x', 'a/../x', 'a//x', 'manifest.json', 'a/./x'):
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                W.safe_name(name)

    def test_no_replacement_for_provider_code(self):
        with self.assertRaises(RuntimeError):
            W.attempt_source(self.manifest, self.files, {'run.py': b'changed'}, {})

    def test_actual_business_fixture_oracle_and_provider_inputs_cannot_be_omitted(self):
        for name in ('scripts/qualification/spin-expiry-real-funded-fixture.sql',
                     'scripts/qualification/spin-expiry-committed-refund-oracle.py',
                     'inputs/entry-provider-supplement.sql', 'inputs/captured-financial-store-policy.sql'):
            manifest = copy.deepcopy(self.manifest); del manifest['files'][name]
            raw = json.dumps(manifest).encode()
            (self.directory / 'manifest.json').write_bytes(raw)
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, 'inventory incomplete'):
                self.load(W.digest(raw))

    def test_provider_cannot_remap_the_maintained_checkout_inputs(self):
        name = 'checkout-replacements.json'
        mapping = dict(W.REPLACEMENTS)
        mapping['run.py'] = 'scripts/untrusted-run.py'
        changed = json.dumps(mapping).encode()
        (self.directory / name).write_bytes(changed)
        manifest = copy.deepcopy(self.manifest); manifest['files'][name] = W.pin(changed)
        raw = json.dumps(manifest).encode(); (self.directory / 'manifest.json').write_bytes(raw)
        with self.assertRaisesRegex(RuntimeError, 'checkout mapping drift'):
            self.load(W.digest(raw))

    def test_root_custody_rejects_writable_or_foreign_paths(self):
        info = type('Info', (), {'st_mode': 0o100444, 'st_uid': 0})()
        with patch.object(Path, 'lstat', return_value=info):
            W.root_custody(Path('/provider/manifest.json'))
            for mode, uid in ((0o100664, 0), (0o100444, 1000), (0o120777, 0)):
                info.st_mode, info.st_uid = mode, uid
                with self.assertRaises(RuntimeError):
                    W.root_custody(Path('/provider/manifest.json'))

    def test_read_does_not_treat_access_time_as_source_mutation(self):
        leaf = self.directory / 'atime-control'
        leaf.write_bytes(b'unchanged pinned source')
        os.utime(leaf, ns=(1, 2_000_000_000))
        before = leaf.stat()
        self.assertLess(before.st_atime_ns, before.st_mtime_ns)
        self.assertEqual(W.read_regular(leaf, 100), b'unchanged pinned source')
        after = leaf.stat()
        self.assertEqual((after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns),
                         (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns))
        # noatime filesystems may retain atime; either behavior must qualify.

    def test_replacement_during_read_is_rejected(self):
        leaf = self.directory / 'run.py'
        original_open = Path.open
        def replacing_open(path, *args, **kwargs):
            handle = original_open(path, *args, **kwargs)
            if path == leaf:
                replacement = self.directory / 'new-inode'
                with original_open(replacement, 'wb') as out: out.write(self.files['run.py'])
                os.replace(replacement, leaf)
            return handle
        with patch.object(Path, 'open', replacing_open), self.assertRaisesRegex(RuntimeError, 'source changed'):
            W.read_regular(leaf, 1000)


class ReceiptTests(unittest.TestCase):
    def validate(self, value, unit=None):
        return W.validate_receipt(value, EXECUTION, ORDINARY, TOURNAMENT, value.get('image'),
                                  MANIFEST_SHA, 'net:[100]', GROUP, unit or terminal())

    def test_separate_images_do_not_claim_full_qualification(self):
        self.validate(receipt('preimage'))
        self.validate(receipt())
        gc = terminal(); gc.update(LoadState='not-found', InvocationID='')
        self.validate(receipt(), gc)

    def test_wrong_identity_failed_unknown_or_overclaim_refuses(self):
        for key, value in [('execution', ORDINARY), ('source_manifest_sha256', 'c' * 64),
                           ('native_status', 'failed_or_unknown'), ('business_scenario_passed', False),
                           ('tournament', ORDINARY), ('business_qualified', True),
                           ('cleanup_verified', False), ('cleanup_errors', ['fast stop failed']),
                           ('source_stable', False), ('full_qualification', True),
                           ('connected_services_qualified', True), ('systemd_invocation', None),
                           ('cgroup', '/another.service'), ('host_netns', 'net:[999]'),
                           ('worker_netns', 'net:[100]')]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                self.validate(dict(receipt(), **{key: value}))

    def test_stage_identity_order_and_original_outcome_required(self):
        for mode in ('missing', 'repeated', 'wrong-user', 'failed', 'order'):
            value = receipt()
            if mode == 'missing': value['stages'].pop()
            if mode == 'repeated': value['stages'].append(copy.deepcopy(value['stages'][0]))
            if mode == 'wrong-user':
                argv = value['stages'][0]['argv']
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
            if mode == 'flag': value['catalog_slice_passed'] = False
            if mode == 'missing': value['stages'].pop(1)
            if mode == 'repeated': value['stages'].insert(2, copy.deepcopy(value['stages'][1]))
            if mode == 'late': value['stages'].insert(4, value['stages'].pop(1))
            if mode == 'failed': value['stages'][1]['returncode'] = 3
            if mode == 'drift': value['stages'][2]['stdout_sha256'] = 'd' * 64
            if mode == 'wrong-source': value['stages'][1]['argv'][-1] = '/old-provider/qualifier.sql'
            if mode == 'preimage': value = receipt('preimage'); value['catalog_slice_passed'] = True
            with self.subTest(mode=mode), self.assertRaises(RuntimeError): self.validate(value)

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

    def test_live_unknown_wrong_invocation_or_failed_unit_refuses(self):
        for key, value in [('ActiveState', 'active'), ('MainPID', '23'), ('LoadState', 'error'), ('ControlGroup', '/foreign')]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                W.terminal_unit(dict(terminal(), **{key: value}), GROUP)
        for key, value in [('InvocationID', 'c' * 32), ('InvocationID', ''), ('Result', 'timeout'), ('ExecMainStatus', '9')]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                self.validate(receipt(), dict(terminal(), **{key: value}))

    def test_resources_and_namespaces_are_not_caller_success_flags(self):
        for namespace in ('', 'net:[0]', 'net:[10]\n', 'user:[100]', None):
            with self.subTest(namespace=namespace), self.assertRaises(RuntimeError): W.namespace(namespace)
        value = receipt(); value['resource_controls']['memory.swap.max'] = 'max'
        with self.assertRaises(RuntimeError): self.validate(value)


class LifecycleTests(unittest.TestCase):
    def attempt(self, output):
        item = object.__new__(W.Attempt)
        item.execution, item.ordinary, item.unit = EXECUTION, ORDINARY, 'spin5-business-' + EXECUTION + '.service'
        item.tournament, item.image = TOURNAMENT, 'candidate'
        item.allocation, item.cgroup, item.out = Path('/srv/ci-validation/spin5-business-' + EXECUTION), GROUP, output
        item.result = {'failures': [], 'cleanup_verified': False, 'source_manifest_sha256': MANIFEST_SHA, 'host_netns': 'net:[100]'}
        item.launched = False
        item.stop_requested = False
        item.clients = []
        item.persist = lambda: None
        item.prepare = lambda: (item.allocation / 'source', 'net:[100]')
        return item

    def test_exact_launch_is_nonroot_bounded_and_environment_isolated(self):
        cmd = W.launch_command('spin5-business-' + EXECUTION + '.service', Path('/source'), EXECUTION, ORDINARY, TOURNAMENT, 'candidate', 'net:[100]')
        for value in ('User=lima', 'Group=lima', 'CPUQuota=100%', 'MemoryMax=2G', 'MemorySwapMax=0',
                      'TasksMax=128', 'RuntimeMaxSec=270', 'TimeoutStopSec=25', 'KillMode=control-group', 'PrivateNetwork=yes'):
            self.assertIn(value, cmd)
        self.assertEqual(cmd[-10:], ['--execution', EXECUTION, '--ordinary-user', ORDINARY,
                                   '--host-netns', 'net:[100]', '--tournament', TOURNAMENT, '--image', 'candidate'])
        self.assertNotIn('--scope', cmd)
        self.assertEqual(set(W.CLEAN_ENV), {'PATH', 'LANG', 'LC_ALL', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'})
        self.assertNotIn('os.environ.copy', W.WORKER_ENTRY)
        self.assertIn('os.environ.get("INVOCATION_ID", "")', W.WORKER_ENTRY)

    def test_original_failure_cancellation_and_stop_failure_remain_nonzero(self):
        for mode in ('success', 'launch-failed', 'cancelled', 'stop-failed', 'terminal-live', 'receipt-stale', 'client-live', 'case-bytes-drift'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as folder:
                item = self.attempt(Path(folder)); called = []
                def command(name, argv, timeout, allow=(0,)):
                    called.append((name, argv, timeout))
                    if name == 'systemd_qualifier' and mode in ('launch-failed', 'stop-failed'):
                        raise RuntimeError('original launch failed')
                    if name == 'systemd_qualifier' and mode == 'cancelled':
                        raise W.AttemptCancelled('cancelled')
                    if name == 'stop_owned_unit' and mode == 'stop-failed':
                        raise RuntimeError('stop failed')
                    return b''
                item.command = command
                def observe(_deadline):
                    if mode == 'terminal-live': raise RuntimeError('group still populated')
                    return terminal()
                item.terminal = observe
                if mode == 'client-live':
                    def live_client(_deadline): raise RuntimeError('original client exit unknown')
                    item.observe_clients = live_client
                value = receipt()
                if mode == 'receipt-stale': value['execution'] = ORDINARY
                def read_original(path, _limit):
                    if path.name == 'receipt.json': return json.dumps(value).encode()
                    return b'drift' if mode == 'case-bytes-drift' else b'unit-test case bytes'
                with patch.object(W, 'read_regular', side_effect=read_original), patch.object(signal, 'signal'):
                    result = item.run()
                self.assertEqual(result, 0 if mode == 'success' else 1)
                self.assertEqual(item.result['passed'], mode == 'success')
                self.assertEqual(sum(name == 'systemd_qualifier' for name, _, _ in called), 1)
                for name, cmd, _ in called:
                    if name == 'stop_owned_unit': self.assertEqual(cmd[-1], item.unit)
                if mode == 'stop-failed': self.assertEqual(len(item.result['failures']), 2)

    def test_terminal_observation_uses_original_deadline_not_six_second_iteration_cap(self):
        with tempfile.TemporaryDirectory() as folder:
            item = self.attempt(Path(folder)); clock = [0.0]; observations = []
            item.stop_requested = True
            def command(name, argv, timeout, allow=(0,)):
                observations.append(clock[0]); clock[0] += min(0.01, timeout)
                state = terminal()
                if clock[0] < 26:
                    state.update(ActiveState='deactivating', MainPID='42', ControlGroup=GROUP)
                return '\n'.join(key + '=' + value for key, value in state.items()).encode()
            item.command = command
            def sleep(seconds): clock[0] += seconds
            with patch.object(W.time, 'monotonic', side_effect=lambda: clock[0]), patch.object(W.time, 'sleep', side_effect=sleep), \
                    patch.object(Path, 'lstat', side_effect=FileNotFoundError):
                observed = item.terminal(30)
            self.assertEqual(observed['MainPID'], '0')
            self.assertGreater(clock[0], 25)
            self.assertLess(clock[0], 30)
            self.assertTrue(item.result['terminal_cgroup']['absent'])
            self.assertGreater(len(observations), 30)

    def test_live_group_cannot_receive_fresh_cleanup_budgets(self):
        with tempfile.TemporaryDirectory() as folder:
            item = self.attempt(Path(folder)); clock = [0.0]
            item.stop_requested = True
            def command(name, argv, timeout, allow=(0,)):
                clock[0] += min(1, timeout)
                state = terminal(); state.update(ActiveState='deactivating', MainPID='42', ControlGroup=GROUP)
                return '\n'.join(key + '=' + value for key, value in state.items()).encode()
            item.command = command
            def sleep(seconds): clock[0] += seconds
            with patch.object(W.time, 'monotonic', side_effect=lambda: clock[0]), patch.object(W.time, 'sleep', side_effect=sleep), \
                    self.assertRaisesRegex(RuntimeError, 'original outer cleanup deadline exhausted'):
                item.terminal(30)
            self.assertLessEqual(clock[0], 30)
            self.assertNotIn('terminal_cgroup', item.result)

    def test_checkout_mapping_includes_catalog_forward_and_rollback_sources(self):
        self.assertEqual(len(W.REPLACEMENTS), 15)
        for name in ('scripts/qualification/spin-expiry-lock-order.sql',
                     'scripts/qualification/spin-expiry-lock-order.component-inputs.sql',
                     'supabase/components/spin-expiry-lock-order.sql',
                     'supabase/components/spin-expiry-lock-order.rollback.sql'):
            self.assertEqual(W.REPLACEMENTS[name], name)
        self.assertIn('spin-catalog-observer.sql', W.REQUIRED)
        self.assertEqual(W.RESOURCES['unit_stop_seconds'], 25)

    def test_two_separate_allocations_stop_after_first_failed_original(self):
        for fail_image in (None, 'preimage', 'candidate'):
            calls = []
            class OriginalAttempt:
                def __init__(self, image): self.image = image; calls.append(image)
                def run(self): return 1 if self.image == fail_image else 0
            with self.subTest(fail_image=fail_image), patch.object(W, 'Attempt', OriginalAttempt), \
                    patch.object(W.sys, 'argv', ['test-spin-expiry-postgres.py']), patch.object(signal, 'signal') as handler:
                result = W.main()
            self.assertEqual(calls, ['preimage'] if fail_image == 'preimage' else ['preimage', 'candidate'])
            self.assertEqual(result, 0 if fail_image is None else 1)
            self.assertEqual(handler.call_count, 2 * len(calls))
