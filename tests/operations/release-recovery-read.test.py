#!/usr/bin/env python3
"""Actual fixed file reader on isolated native files; no host or provider calls."""
import importlib.util
import base64
import contextlib
import io
import ast
import json
import os
import subprocess
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('reader', ROOT / 'scripts/ci/read-scoped-release-recovery.py')
R = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(R)
REQUEST = {'runKey': '38268897283-1', 'releaseSha': 'a' * 40}
WINDOW = {'runId': REQUEST['runKey'], 'sha': REQUEST['releaseSha'],
          'announcedAt': 1791821651724, 'cause': 'engine-degraded'}
RESULT = {'schema': 1, 'runId': REQUEST['runKey'], 'sha': REQUEST['releaseSha'],
          'result': 'sealed', 'completedAt': 1791821800,
          'private_metadata': {'never_export': 'secret fixture'}}


def kernel_evidence(owner='unknown'):
    return ({'stage':'complete','code':'exclusive'} if owner in {'main','other_container_process'}
            else {'stage':'snapshot','code':'unproved'})


class ServingRoleTests(unittest.TestCase):
    def test_serving_role_exact_selector(self):
        request = {'mode':'current_serving_inspector_role', 'releaseSha':R.EED,
                   'instanceId':'1-12345678'}
        self.assertEqual(R.selection(request), request)


    def test_serving_role_selector_refuses_every_extra_or_changed_identity(self):
        good={'mode':'current_serving_inspector_role','releaseSha':R.EED,'instanceId':'1-12345678'}
        bad=[None,[],{},dict(good,runKey=REQUEST['runKey']),dict(good,host='localhost'),
             dict(good,port=9229),dict(good,path='/proc'),dict(good,releaseSha='a'*40),
             dict(good,instanceId='1-1234567'),dict(good,instanceId='2-12345678'),
             dict(good,instanceId='1-ABCDEF12'),dict(good,instanceId=1)]
        bad += [{k:v for k,v in good.items() if k!=missing} for missing in good]
        for request in bad:
            with self.subTest(request=request),self.assertRaises(ValueError):R.selection(request)
        for old in [REQUEST,dict(REQUEST,mode='pending_transaction'),dict(REQUEST,mode='legacy_checkpoint_inspector')]:
            self.assertEqual(R.selection(old),old)

    def test_serving_role_dispatch_never_opens_transaction_files(self):
        request={'mode':'current_serving_inspector_role','releaseSha':R.EED,'instanceId':'1-12345678'}
        sentinel={'schema':'current-serving-inspector-role/v2','readOnly':True,**request,
            'inspectorOwner':'unknown','inspectorOwnerEvidence':kernel_evidence(),'limitation':'Kernel role only; no inspector ownership, provenance or action authority.'}
        with patch.object(R,'serving_role_remote',return_value=sentinel,create=True) as reader, \
                patch.object(R.os,'open',side_effect=AssertionError('transaction file access')):
            self.assertEqual(R.remote(request),sentinel)
        reader.assert_called_once_with(request)


    def setUp(self):
        self.request={'mode':'current_serving_inspector_role','releaseSha':R.EED,'instanceId':'1-12345678'}
        self.identity={'container':'c'*64,'image':'sha256:'+'d'*64,'running':'true',
            'startedAt':'2026-10-30T01:00:00.000Z','hostPid':'1234','restarts':'0'}
        self.health={'source':R.EED,'instance':self.request['instanceId']}
        self.boot='12345678-1234-1234-1234-123456789abc'

    @contextlib.contextmanager
    def bound(self,role='main',overrides=None):
        defaults={'_serving_boot_id':{'return_value':self.boot},
            'inspector_identity':{'return_value':self.identity},
            'pending_tcp_health':{'return_value':self.health},
            '_kernel_pid_stat':{'return_value':'987654'},
            'inspector_command':{'return_value':(R.EED+'\n').encode()},
            'pending_socket_owner_details':{'return_value':(role,kernel_evidence(role))}}
        defaults.update(overrides or {})
        with contextlib.ExitStack() as stack:
            mocks={name:stack.enter_context(patch.object(R,name,create=True,**options))
                   for name,options in defaults.items()}
            for name in ['pending_tcp_presence','inspector_remote','pending_remote','read_json']:
                stack.enter_context(patch.object(R,name,side_effect=AssertionError('forbidden read '+name)))
            yield mocks

    def test_serving_role_exact_minimal_private_reply_and_shared_deadline(self):
        for role in ['main','other_container_process','unknown']:
            with self.subTest(role=role),self.bound(role) as mocks:
                answer=R.serving_role_remote(self.request)
                self.assertEqual(answer,{'schema':'current-serving-inspector-role/v2','readOnly':True,
                    **self.request,'inspectorOwner':role,'inspectorOwnerEvidence':kernel_evidence(role),
                    'limitation':'Kernel role only; no inspector ownership, provenance or action authority.'})
                self.assertEqual(R.validate_reply(answer,self.request),answer)
                text=json.dumps(answer)
                for private in [self.boot,self.identity['container'],self.identity['image'],'987654','hostPid','/proc','runKey']:
                    self.assertNotIn(private,text)
                owner=mocks['pending_socket_owner_details'];owner.assert_called_once()
                self.assertEqual(owner.call_args.args[0],self.identity)
                deadline=owner.call_args.args[1]
                self.assertGreater(deadline,R.time.monotonic());self.assertLessEqual(deadline-R.time.monotonic(),8)
                for name in ['_serving_boot_id','inspector_identity','pending_tcp_health','_kernel_pid_stat','inspector_command']:
                    self.assertGreaterEqual(mocks[name].call_count,1)
                    for call in mocks[name].call_args_list:
                        self.assertIn(deadline,call.args)
                for call in mocks['inspector_command'].call_args_list:
                    self.assertEqual(call.args[0][:3],['docker','image','inspect'])
                    self.assertEqual(call.args[0][-1],self.identity['image'])

    def test_serving_role_identity_mutations_refuse_even_unknown_kernel(self):
        cases=[('_serving_boot_id',[self.boot,'aaaaaaaa-1234-1234-1234-123456789abc']),
               ('_kernel_pid_stat',['987654','987655']),
               ('pending_tcp_health',[self.health,dict(self.health,source='a'*40)]),
               ('pending_tcp_health',[self.health,dict(self.health,instance='1-87654321')])]
        for key in self.identity:
            changed=dict(self.identity);changed[key]=str(changed[key])+'changed'
            cases.append(('inspector_identity',[self.identity,changed]))
        for helper,values in cases:
            with self.subTest(helper=helper,values=values),self.bound('unknown',{helper:{'side_effect':values}}):
                with self.assertRaises(ValueError):R.serving_role_remote(self.request)

    def test_serving_role_wrong_source_instance_revision_and_invalid_kernel_refuse(self):
        cases=[('pending_tcp_health',{'source':'a'*40,'instance':self.request['instanceId']}),
               ('pending_tcp_health',dict(self.health,instance='1-87654321')),
               ('inspector_command',('a'*40+'\n').encode())]
        for helper,value in cases:
            with self.subTest(helper=helper,value=value),self.bound(overrides={helper:{'return_value':value}}):
                with self.assertRaises(ValueError):R.serving_role_remote(self.request)

    def test_serving_role_kernel_ambiguity_never_skips_final_bindings(self):
        for options in [{'return_value':None},{'return_value':'child'},
                        {'side_effect':PermissionError('private fixture')},
                        {'side_effect':ValueError('private fixture')}]:
            with self.subTest(options=options),self.bound(overrides={'pending_socket_owner_details':options}) as mocks:
                self.assertEqual(R.serving_role_remote(self.request)['inspectorOwner'],'unknown')
                for helper in ['_serving_boot_id','inspector_identity','pending_tcp_health','_kernel_pid_stat']:
                    self.assertEqual(mocks[helper].call_count,2)
            with self.bound(overrides={'pending_socket_owner_details':options,
                    '_serving_boot_id':{'side_effect':[self.boot,'aaaaaaaa-1234-1234-1234-123456789abc']}}):
                with self.assertRaises(ValueError):R.serving_role_remote(self.request)

    def test_serving_role_unavailable_and_expired_bindings_refuse_without_private_error(self):
        for helper in ['_serving_boot_id','inspector_identity','pending_tcp_health','_kernel_pid_stat','inspector_command']:
            for error in [PermissionError('private fixture'),ValueError('private fixture')]:
                with self.subTest(helper=helper,error=type(error)),self.bound(overrides={helper:{'side_effect':error}}):
                    with self.assertRaises(R.ScopedRefusal) as caught:R.serving_role_remote(self.request)
                    self.assertEqual(caught.exception.phase,'serving_role')
                    self.assertIn(caught.exception.code,{'binding_unproved','evidence_unavailable'})
                    self.assertNotIn('private fixture',str(caught.exception))
        with self.bound(),patch.object(R.time,'monotonic',side_effect=[100]+[109]*40):
            with self.assertRaises(ValueError):R.serving_role_remote(self.request)

    def test_serving_role_boot_reader_fixed_private_bounded_metadata_only(self):
        deadline=R.time.monotonic()+8
        with patch.object(R,'_kernel_read',return_value=(self.boot+'\n').encode()) as read:
            self.assertEqual(R._serving_boot_id(deadline),self.boot)
        read.assert_called_once_with(Path('/proc/sys/kernel/random/boot_id'),64,deadline)
        for raw in [b'',b'not-a-boot-id',b'A'*36,b'12345678-1234-1234-1234-123456789abc extra']:
            with self.subTest(raw=raw),patch.object(R,'_kernel_read',return_value=raw):
                with self.assertRaises(ValueError):R._serving_boot_id(deadline)

    def test_serving_role_reply_refuses_extra_missing_wrong_fields(self):
        good={'schema':'current-serving-inspector-role/v2','readOnly':True,**self.request,
            'inspectorOwner':'unknown','inspectorOwnerEvidence':kernel_evidence(),'limitation':'Kernel role only; no inspector ownership, provenance or action authority.'}
        bad=[dict(good,hostPid=1234),dict(good,readOnly=1),dict(good,inspectorOwner='child'),
             dict(good,releaseSha='a'*40),dict(good,instanceId='1-87654321'),dict(good,limitation='owned')]
        bad += [dict(good,inspectorOwnerEvidence=evidence) for evidence in [None,{},
            {'stage':'private','code':'unproved'},{'stage':'snapshot','code':'private'},
            {'stage':'snapshot','code':'unproved','hostPid':1234},
            {'stage':'complete','code':'exclusive'},
            {'stage':'not_observed','code':'not_read'}]]
        bad += [dict(good,inspectorOwner='main'),dict(good,schema='current-serving-inspector-role/v1')]
        bad += [{k:v for k,v in good.items() if k!=missing} for missing in good]
        for answer in bad:
            with self.subTest(answer=answer),self.assertRaises(ValueError):R.validate_reply(answer,self.request)


class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='native-recovery-', dir=ROOT.parent)
        self.root = Path(self.temp.name)
        (self.root / 'engine-release-results').mkdir()
        self.window = self.root / ('engine-recovery-window-' + REQUEST['runKey'] + '.json')
        self.result = self.root / 'engine-release-results' / (REQUEST['runKey'] + '.json')
        self.window.write_text(json.dumps(WINDOW))
        self.result.write_text(json.dumps(RESULT))
        self.patcher = patch.object(R, 'STATE_ROOT', self.root)
        self.patcher.start()
        # Exact-file fixtures never inspect the machine running the tests.
        self.tcp_patcher = patch.object(R, 'pending_tcp_presence', create=True,
            return_value=({'state':'unknown','binding':'unproved','code':'not_read'}, 'unknown',
                          {'stage':'not_observed','code':'not_read'}))
        self.tcp_patcher.start()

    def tearDown(self):
        self.tcp_patcher.stop()
        self.patcher.stop()
        self.temp.cleanup()

    def test_real_files_export_only_bound_identity_cause_and_times(self):
        answer = R.remote(REQUEST)
        self.assertEqual(answer['cause'], 'engine-degraded')
        self.assertEqual(answer['freezeAtMs'], 1791821771724)
        self.assertEqual(answer['windowEndsAtMs'], 1791822071724)
        self.assertNotIn('secret fixture', json.dumps(answer))
        self.assertNotIn('private_metadata', answer)
        self.assertEqual(answer['emergencyBasisStatus'], 'unknown_not_retained_in_selected_receipts')
        self.assertEqual(R.validate_reply(answer, REQUEST), answer)

    def test_pending_transaction_reads_exact_request_without_requiring_a_seal(self):
        request = {**REQUEST, 'mode': 'pending_transaction'}
        directory = self.root / 'engine-release-requests'
        directory.mkdir()
        raw = '\n'.join([REQUEST['releaseSha'],
            'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/38268897283',
            'private actor fixture', '/usr/local/lib/club-arena/engine-control-generations/' + 'b' * 40,
            'b' * 40, '1791829999']) + '\n'
        (directory / (REQUEST['runKey'] + '.request')).write_text(raw)
        (directory / (REQUEST['runKey'] + '.intent')).write_text(raw)
        (directory / (REQUEST['runKey'] + '.awaiting-certificate')).write_text(REQUEST['releaseSha'] + '\n')
        for metadata in directory.iterdir(): metadata.chmod(0o600)
        unit = {'activeState': 'active', 'subState': 'running', 'invocationId': '1' * 32}
        with patch.object(R, 'pending_unit', return_value=unit, create=True), patch.object(R, 'pending_journal', return_value=[], create=True):
            answer = R.remote(request)
        self.assertEqual(answer['stage'], 'awaiting_certificate_marker_retained')
        self.assertEqual(answer['requestDeadlineEpoch'], 1791829999)
        self.assertEqual(answer['controlSha'], 'b' * 40)
        self.assertNotIn('private actor fixture', json.dumps(answer))
        self.assertNotIn('/opt/', json.dumps(answer))
        self.assertEqual(R.validate_reply(answer, request), answer)

    def test_pending_kernel_role_projection_keeps_original_unit_recheck(self):
        request={**REQUEST,'mode':'pending_transaction'}
        directory=self.root/'engine-release-requests';directory.mkdir()
        raw='\n'.join([REQUEST['releaseSha'],
            'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/38268897283',
            'private actor','/usr/local/lib/club-arena/engine-control-generations/'+'b'*40,'b'*40,'1791829999'])+'\n'
        for suffix in ['.request','.intent']:
            path=directory/(REQUEST['runKey']+suffix);path.write_text(raw);path.chmod(0o600)
        unit={'activeState':'active','subState':'running','invocationId':'1'*32}
        tcp={'state':'listening','binding':'matched','code':'connection_established'}
        with patch.object(R,'pending_unit',return_value=unit) as reads, \
                patch.object(R,'pending_journal',return_value=[]), \
                patch.object(R,'pending_tcp_presence',return_value=(tcp,'main',kernel_evidence('main'))) as tcp_reads:
            answer=R.remote(request)
        self.assertEqual(answer['inspectorOwner'],'main');self.assertEqual(answer['inspectorTcp'],tcp)
        self.assertEqual(answer['inspectorOwnerEvidence'],kernel_evidence('main'))
        self.assertEqual(reads.call_count,2);self.assertEqual(R.validate_reply(answer,request),answer)
        tcp_reads.assert_called_once_with(include_owner_evidence=True)
        self.assertNotIn('private',json.dumps(answer))
        for mutation in [{'inspectorOwner':'private PID123'},{'schema':'existing-release-pending-observation/v5'},
                         {'inspectorOwnerEvidence':{'stage':'descriptors','code':'permission_denied'}},
                         {'inspectorOwnerEvidence':{'stage':'complete','code':'exclusive','inode':'private'}},
                         {'inspectorOwnerEvidence':{'stage':'private','code':'unproved'}},
                         {'inspectorOwnerEvidence':{'stage':'snapshot','code':'private'}},
                         {'inspectorTcp':{'state':'closed','binding':'matched','code':'connection_refused'}}]:
            with self.subTest(mutation=mutation),self.assertRaises(ValueError):R.validate_reply({**answer,**mutation},request)
        with patch.object(R,'pending_unit',side_effect=[unit,{**unit,'invocationId':'2'*32}]), \
                patch.object(R,'pending_journal',return_value=[]), \
                patch.object(R,'pending_tcp_presence',return_value=(tcp,'main',kernel_evidence('main'))),self.assertRaises(R.ScopedRefusal) as refused:
            R.remote(request)
        self.assertEqual((refused.exception.phase,refused.exception.code),('pending_recheck_unit','evidence_unavailable'))

    def test_pending_remote_failure_reports_fixed_stage_without_private_detail(self):
        request = {**REQUEST, 'mode': 'pending_transaction'}
        with self.assertRaises(R.ScopedRefusal) as caught:
            R.remote(request)
        self.assertEqual((caught.exception.phase, caught.exception.code),
                         ('pending_directory', 'records_absent'))
        directory = self.root / 'engine-release-requests'
        directory.mkdir()
        with self.assertRaises(R.ScopedRefusal) as caught:
            R.remote(request)
        self.assertEqual((caught.exception.phase, caught.exception.code),
                         ('pending_request_read', 'records_absent'))
        raw = '\n'.join([REQUEST['releaseSha'],
            'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/38268897283',
            'private actor fixture', '/usr/local/lib/club-arena/engine-control-generations/' + 'b' * 40,
            'b' * 40, '1791829999']) + '\n'
        for suffix in ('.request', '.intent'):
            path = directory / (REQUEST['runKey'] + suffix)
            path.write_text(raw); path.chmod(0o600)
        unit = {'activeState': 'active', 'subState': 'running', 'invocationId': '1' * 32}
        cases = [('read_lines', 'request_read'), ('pending_metadata', 'request_binding'),
                 ('pending_unit', 'unit')]
        for function, stage in cases:
            with self.subTest(stage=stage), \
                    patch.object(R, 'pending_unit', return_value=unit), \
                    patch.object(R, 'pending_journal', return_value=[]), \
                    patch.object(R, function, side_effect=ValueError('private fixture detail')):
                with self.assertRaises(R.ScopedRefusal) as caught:
                    R.remote(request)
                exported = R.refusal(request, caught.exception)
                validated = R.validate_refusal(exported, request)
                self.assertEqual((validated.phase, validated.code),
                                 ('pending_' + stage, 'evidence_unavailable'))
                self.assertNotIn('private fixture detail', json.dumps(exported))
        with patch.object(R, 'pending_unit', side_effect=[unit, {**unit, 'invocationId': '2' * 32}]), \
                patch.object(R, 'pending_journal', return_value=[]):
            with self.assertRaises(R.ScopedRefusal) as caught:
                R.remote(request)
            self.assertEqual(caught.exception.phase, 'pending_recheck_unit')

    def test_pending_journal_failure_preserves_only_rechecked_metadata_as_unknown(self):
        request = {**REQUEST, 'mode': 'pending_transaction'}
        directory = self.root / 'engine-release-requests'; directory.mkdir()
        rows = [REQUEST['releaseSha'], 'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/38268897283',
                'private actor fixture', '/usr/local/lib/club-arena/engine-control-generations/' + 'b' * 40,
                'b' * 40, '1791829999']
        for suffix in ('.request', '.intent'):
            path = directory / (REQUEST['runKey'] + suffix)
            path.write_text('\n'.join(rows) + '\n'); path.chmod(0o600)
        unit = {'activeState': 'active', 'subState': 'running', 'invocationId': '1' * 32}
        with patch.object(R, 'pending_unit', return_value=unit) as reads, \
                patch.object(R, 'pending_journal', side_effect=ValueError('private journal detail')):
            answer = R.remote(request)
        self.assertEqual(reads.call_count, 2)
        self.assertEqual(answer['journalStatus'], 'unavailable')
        self.assertIsNone(answer['journalSigns'])
        self.assertEqual(answer['journalFailure'], {'phase': 'pending_journal', 'code': 'evidence_unavailable'})
        self.assertEqual(R.validate_reply(answer, request), answer)
        self.assertNotIn('private', json.dumps(answer))
        failures = [(ValueError('Recovery witness output refused'), 'output_bound'),
                    (ValueError('Pending journal unavailable'), 'command_nonzero'),
                    (ValueError('Pending journal ownership refused'), 'ownership_refused'),
                    (ValueError('Pending journal shape refused'), 'shape_refused'),
                    (ValueError('Duplicate persisted field'), 'fields_refused'),
                    (subprocess.TimeoutExpired('private command', 5), 'command_deadline'),
                    (OSError('private command'), 'command_unavailable'),
                    (json.JSONDecodeError('private', 'private', 0), 'json_refused')]
        for error, code in failures:
            with self.subTest(code=code), self.assertRaises(R.ScopedRefusal) as caught:
                R.pending_stage('journal', lambda: (_ for _ in ()).throw(error))
            self.assertEqual((caught.exception.phase, caught.exception.code), ('pending_journal', code))
        with self.assertRaises(RuntimeError):
            R.pending_stage('journal', lambda: (_ for _ in ()).throw(RuntimeError('unexpected')))
        for mutation in [{'journalSigns': []}, {'journalStatus': 'observed'},
                         {'journalFailure': {'phase': 'pending_unit', 'code': 'evidence_unavailable'}},
                         {'journalFailure': {'phase': 'pending_journal', 'code': 'private detail'}},
                         {'schema': 'existing-release-pending-observation/v1'}]:
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                R.validate_reply({**answer, **mutation}, request)
        for target in ('unit', 'requests'):
            def journal(*args):
                if target == 'requests':
                    path = directory / (REQUEST['runKey'] + '.request')
                    path.write_text('changed')
                raise ValueError('private journal detail')
            with patch.object(R, 'pending_unit', side_effect=[unit, {**unit, 'invocationId': '2' * 32}] if target == 'unit' else None, return_value=unit), \
                    patch.object(R, 'pending_journal', side_effect=journal), self.assertRaises(R.ScopedRefusal):
                R.remote(request)

    def test_pending_mode_refuses_unknown_modes_and_export_forgery(self):
        request = {**REQUEST, 'mode': 'pending_transaction'}
        for mode in ['pending', 'status', None, True, '$(id)']:
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                R.selection({**REQUEST, 'mode': mode})
        rows = [REQUEST['releaseSha'], 'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/38268897283',
                'actor', '/usr/local/lib/club-arena/engine-control-generations/' + 'b' * 40,
                'b' * 40, '1791829999']
        unit = {'activeState': 'active', 'subState': 'running', 'invocationId': '1' * 32}
        answer = R.pending_observation(request, rows, rows, None, None, unit, [])
        for mutation in [{'stage': 'ready'}, {'controlSha': 'secret'}, {'requestDeadlineEpoch': True},
                         {'unit': {**unit, 'invocationId': 'bad'}}, {'raw': 'private'},
                         {'journalSigns': [{'category': 'arbitrary', 'observedAtMs': WINDOW['announcedAt']}]},
                         {'journalSigns': [{'category': 'certificate_shut', 'observedAtMs': True}]}]:
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                R.validate_reply({**answer, **mutation}, request)
        for index, value in [(0, 'c' * 40), (1, 'https://other.invalid'), (3, '/etc/keys'), (4, 'bad'), (5, '0')]:
            bad = [*rows]; bad[index] = value
            with self.subTest(index=index), self.assertRaises(ValueError):
                R.pending_observation(request, bad, bad, None, None, unit, [])
        with self.assertRaises(ValueError):
            R.pending_observation(request, rows, rows, ['c' * 40], None, unit, [])
        with self.assertRaises(ValueError):
            R.pending_observation(request, rows, rows, None, ['0'], unit, [])

    def test_pending_native_unit_and_journal_are_exact_readonly_and_sanitized(self):
        request = {**REQUEST, 'mode': 'pending_transaction'}
        unit = {'activeState': 'active', 'subState': 'running', 'invocationId': '1' * 32}
        calls = []
        def show(args):
            calls.append(args)
            return types.SimpleNamespace(returncode=0, stdout=b'SubState=running\nActiveState=active\nInvocationID=' + b'1' * 32 + b'\n')
        with patch.object(R, 'bounded_journal', side_effect=show):
            self.assertEqual(R.pending_unit(request), unit)
        self.assertEqual(calls[0][:3], ['systemctl', 'show', 'club-arena-engine-release-v1@38268897283-1.service'])
        row = {'_SYSTEMD_INVOCATION_ID': unit['invocationId'],
               '_SYSTEMD_UNIT': calls[0][2], '__REALTIME_TIMESTAMP': '1791821800000000',
               'MESSAGE': '[engine-release-transaction] the restart certificate is shut with 299000ms of the break left: unparkedTables=66 unparkedReasons={cards_in_air:66} handsInFlightTotal=0',
               'ignored_metadata': 'private fixture'}
        def journal(args):
            calls.append(args)
            return types.SimpleNamespace(returncode=0, stdout=json.dumps(row).encode())
        with patch.object(R, 'bounded_journal', side_effect=journal):
            signs = R.pending_journal(request, unit)
        # This historical fixture's unquoted key is not Python producer repr.
        # Preserve its category while retaining unavailable causal details.
        self.assertEqual(signs, [{'category': 'certificate_shut', 'observedAtMs': 1791821800000, 'details': None}])
        self.assertNotIn('private', json.dumps(signs))
        self.assertIn('_SYSTEMD_INVOCATION_ID=' + '1' * 32, calls[-1])
        self.assertIn('_SYSTEMD_UNIT=' + calls[0][2], calls[-1])
        self.assertIn('--lines=12', calls[-1])
        for mutation in [{'_SYSTEMD_INVOCATION_ID': '2' * 32}, {'_SYSTEMD_UNIT': 'other.service'},
                         {'__REALTIME_TIMESTAMP': 'bad'}, {'MESSAGE': ['private']}]:
            with patch.object(R, 'bounded_journal', return_value=types.SimpleNamespace(returncode=0, stdout=json.dumps({**row, **mutation}).encode())), self.assertRaises(ValueError):
                R.pending_journal(request, unit)
        row['MESSAGE'] = 'arbitrary private message'
        with patch.object(R, 'bounded_journal', side_effect=journal):
            self.assertEqual(R.pending_journal(request, unit), [])

    def test_pending_certificate_retains_literal_counts_without_private_reason_names(self):
        request = {**REQUEST, 'mode': 'pending_transaction'}
        unit = {'activeState': 'activating', 'subState': 'start', 'invocationId': '1' * 32}
        template = ('[engine-release-transaction] the restart certificate is shut with %dms of the break left: '
                    'unparkedTables=%r unparkedReasons=%r handsInFlightTotal=%r\\n')
        self.assertIn(template, (ROOT / 'server/scripts/engine-release-transaction.sh').read_text())
        message = template.replace('\\n', '\n') % (296969, 3,
            {'cards_in_air': 2, 'private player fixture': 1}, 2)
        row = {'_SYSTEMD_INVOCATION_ID': unit['invocationId'],
               '_SYSTEMD_UNIT': 'club-arena-engine-release-v1@' + request['runKey'] + '.service',
               '__REALTIME_TIMESTAMP': '1793318108736000', 'MESSAGE': message.rstrip('\n')}
        with patch.object(R, 'bounded_journal', return_value=types.SimpleNamespace(returncode=0, stdout=json.dumps(row).encode())):
            signs = R.pending_journal(request, unit)
        self.assertEqual(signs[0]['details'][:3], [296969, 3, 2])
        self.assertEqual(signs[0]['details'][3][R.PENDING_REASON_ORDER.index('cards_in_air')], 2)
        self.assertEqual(signs[0]['details'][3][-1], 1)
        self.assertNotIn('private', json.dumps(signs))
        R.validate_pending_signs(signs)

    def test_pending_legacy_intent_absence_is_a_read_not_retry_authority(self):
        request = {**REQUEST, 'mode': 'pending_transaction'}
        directory = self.root / 'engine-release-requests'; directory.mkdir()
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            summary, binding = R.pending_legacy_intent(request, fd, 'b' * 40)
            self.assertEqual(summary, {'status': 'absent_at_read', 'code': None})
            self.assertIsNone(binding)
            path = directory / (request['runKey'] + '.legacy-checkpoint-intent')
            value = {'instance': '1-12345678', 'container': 'c' * 64,
                     'startedAt': '2026-10-29T23:10:28.589Z', 'hostPid': 1234,
                     'source': R.EED, 'runId': request['runKey'], 'controlSha': 'b' * 40,
                     'at': 1793318108, 'retryAllowed': False}
            path.write_text(json.dumps(value)); path.chmod(0o600)
            summary, binding = R.pending_legacy_intent(request, fd, 'b' * 40)
            self.assertEqual(summary, {'status': 'bound_at_read', 'code': None})
            self.assertIsNotNone(binding)
            self.assertNotIn('1234', json.dumps(summary))
            self.assertEqual(R.pending_legacy_intent(request, fd, 'd' * 40)[0],
                             {'status': 'unknown', 'code': 'binding_refused'})
            path.unlink(); path.symlink_to(self.window)
            self.assertEqual(R.pending_legacy_intent(request, fd, 'b' * 40)[0],
                             {'status': 'unknown', 'code': 'evidence_unavailable'})
        finally:
            os.close(fd)

    def test_pending_literal_categories_counts_and_unknown_details_are_closed(self):
        request = {**REQUEST, 'mode': 'pending_transaction'}
        unit = {'activeState': 'activating', 'subState': 'start', 'invocationId': '1' * 32}
        cases = [
            ('[engine-release-transaction] the restart certificate is also shut: unparkedTables=None unparkedReasons=None', 'certificate_also_shut', [None, None, None, None]),
            ('[engine-release-transaction] the durable table break has 284999ms remaining, below the 285000ms candidate-and-recovery budget; refusing before mutation and waiting for a later certificate', 'candidate_budget_missed', [284999, 285000]),
            ('[engine-release-transaction] the locked table break has 244999ms remaining, below the 245000ms candidate-and-recovery budget; waiting for a later certificate', 'locked_budget_missed', [244999, 245000]),
            ('[engine-release-transaction] prove_rollback_readiness took 11000ms of the 15000ms entry allowance inside the 40s legacy checkpoint budget', 'rollback_readiness_completed', [11000, 15000, 40]),
            ('[engine-release-transaction] FATAL: legacy checkpoint did not retain the full restart certificate and 245000ms legacy reserve (240000ms remaining, certificate rc 2)', 'rollback_certificate_lost', [245000, 240000, 2]),
            ('[engine-release-inflight-hands] weekly payout owns the boundary; refusing cutover', 'weekly_owner_active', None),
            ('[engine-release-inflight-hands] UNKNOWN: private exception fixture', 'inflight_evidence_unavailable', None),
            ('[engine-release-transaction] FATAL: could not acquire the engine mutation lock for maintenance cutover', 'mutation_lock_unavailable', None),
            ('[engine-release-transaction] FATAL: deadline expired before maintenance cutover', 'mutation_lock_deadline', None),
            ('[engine-release-inflight-hands] 3 hand(s) in the air within 120s - refusing the cutover:', 'hands_in_air', [3, 120]),
        ]
        for message, category, details in cases:
            with self.subTest(category=category):
                row = {'_SYSTEMD_INVOCATION_ID': unit['invocationId'],
                       '_SYSTEMD_UNIT': 'club-arena-engine-release-v1@' + request['runKey'] + '.service',
                       '__REALTIME_TIMESTAMP': '1793318108736000', 'MESSAGE': message}
                with patch.object(R, 'bounded_journal', return_value=types.SimpleNamespace(returncode=0, stdout=json.dumps(row).encode())):
                    signs = R.pending_journal(request, unit)
                self.assertEqual(signs, [{'category': category, 'observedAtMs': 1793318108736, 'details': details}])
                R.validate_pending_signs(signs)
                self.assertNotIn('private', json.dumps(signs))
        prefix = '[engine-release-transaction] the restart certificate is shut with 299000ms of the break left: '
        for reasons in ["{'cards_in_air': True}", "{'cards_in_air': -1}",
                        "{'cards_in_air': 1, 'cards_in_air': 2}",
                        "__import__('os').system('private')", "{'cards_in_air': [1]}"]:
            self.assertIsNone(R.pending_certificate_details(prefix + 'unparkedTables=1 unparkedReasons=' + reasons + ' handsInFlightTotal=0'))
        for details in [[299000, 1, True, None], [299000, 1, 0, [1]],
                        [299000, 1, 0, [-1] * (len(R.PENDING_REASON_ORDER) + 1)]]:
            with self.assertRaises(ValueError):
                R.validate_pending_signs([{'category': 'certificate_shut', 'observedAtMs': 1793318108736, 'details': details}])

    def test_pending_optional_intent_changes_never_bypass_request_or_unit_rechecks(self):
        request = {**REQUEST, 'mode': 'pending_transaction'}
        directory = self.root / 'engine-release-requests'; directory.mkdir()
        rows = [REQUEST['releaseSha'], 'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/38268897283',
                'private fixture', '/usr/local/lib/club-arena/engine-control-generations/' + 'b' * 40,
                'b' * 40, '1791829999']
        for suffix in ('.request', '.intent'):
            path = directory / (request['runKey'] + suffix)
            path.write_text('\n'.join(rows) + '\n'); path.chmod(0o600)
        unit = {'activeState': 'activating', 'subState': 'start', 'invocationId': '1' * 32}
        absent = ({'status': 'absent_at_read', 'code': None}, None)
        bound = ({'status': 'bound_at_read', 'code': None}, 'private binding')
        with patch.object(R, 'pending_unit', return_value=unit) as unit_reads, \
                patch.object(R, 'read_lines', wraps=R.read_lines) as file_reads, \
                patch.object(R, 'pending_journal', side_effect=ValueError('private journal')), \
                patch.object(R, 'pending_legacy_intent', side_effect=[absent, bound]), \
                patch.object(R, 'pending_tcp_presence', side_effect=OSError('private TCP failure')):
            answer = R.remote(request)
        self.assertEqual(unit_reads.call_count, 2)
        self.assertEqual(file_reads.call_count, 8)
        self.assertEqual(answer['legacyIntent'], {'status': 'unknown', 'code': 'changed_during_read'})
        self.assertIsNone(answer['journalSigns'])
        self.assertEqual(answer['inspectorTcp'], {'state':'unknown','binding':'unproved','code':'evidence_unavailable'})
        self.assertEqual(R.validate_reply(answer, request), answer)
        self.assertNotIn('private', json.dumps(answer))
        for mutation in [{'legacyIntent': {'status': 'absent_at_read', 'code': 'never_entered'}},
                         {'legacyIntent': {'status': 'bound_at_read', 'code': None, 'hostPid': 1}},
                         {'schema': 'existing-release-pending-observation/v2'}]:
            with self.assertRaises(ValueError): R.validate_reply({**answer, **mutation}, request)

    def test_pending_native_selector_retains_early_counts_despite_late_budget_noise(self):
        request = {**REQUEST, 'mode': 'pending_transaction'}
        unit = {'activeState': 'activating', 'subState': 'start', 'invocationId': '1' * 32}
        early = ('[engine-release-transaction] the restart certificate is shut with 296969ms of the break left: '
                 "unparkedTables=1 unparkedReasons={'cards_in_air': 1} handsInFlightTotal=1")
        late = "[engine-release-transaction] the restart certificate is also shut: unparkedTables=1 unparkedReasons={'cards_in_air': 1}"
        messages = [early] + [late] * 20
        def journal(args):
            # Exercise the actual fixed ERE with native grep, then the same
            # latest-N selection as journalctl. No systemd/host read occurs.
            pattern = next(arg.removeprefix('--grep=') for arg in args if arg.startswith('--grep='))
            selected = subprocess.run(['grep', '-E', pattern], input='\n'.join(messages) + '\n',
                                      capture_output=True, text=True, timeout=2, check=True).stdout.splitlines()
            limit = int(next(arg.removeprefix('--lines=') for arg in args if arg.startswith('--lines=')))
            self.assertEqual(limit, 12)
            rows = [{'_SYSTEMD_INVOCATION_ID': unit['invocationId'],
                     '_SYSTEMD_UNIT': 'club-arena-engine-release-v1@' + request['runKey'] + '.service',
                     '__REALTIME_TIMESTAMP': str(1793318108736000 + ordinal * 1000), 'MESSAGE': message}
                    for ordinal, message in enumerate(selected[-limit:])]
            return types.SimpleNamespace(returncode=0, stdout='\n'.join(json.dumps(row) for row in rows).encode())
        with patch.object(R, 'bounded_journal', side_effect=journal):
            signs = R.pending_journal(request, unit)
        self.assertEqual([sign['category'] for sign in signs], ['certificate_shut'])
        self.assertEqual(signs[0]['details'][:3], [296969, 1, 1])

    def recovery_messages(self):
        prefix = '[engine-release-transaction] '
        return [
            (prefix + 'newer release ' + 'c' * 40 + ' (run 40980634821-1) is in flight and owns any off-cycle window; this release waits for the scheduled break', 'recovery_newer_owner'),
            (prefix + 'legacy inspector absence is not proved; no recovery window requested and no inspector was touched', 'recovery_inspector_unproved'),
            (prefix + 'recovery announcement reservation could not be established; no window was announced, waiting for the scheduled break', 'recovery_reservation_unestablished'),
            (prefix + 'off-cycle window wanted (owner-ordered private-window-fixture) but one was already announced in the last hour; waiting for the scheduled break', 'recovery_rate_limited'),
        ] + [(prefix + 'fixed recovery announcement 1793318108736: ' + status + '; existing certificate and rollback budget remain required', 'recovery_announcement_' + status)
             for status in ['accepted', 'active', 'pending', 'busy', 'expired', 'use_hourly', 'unavailable', 'unknown']]

    def recovery_signs(self, messages, native=False):
        request = {**REQUEST, 'mode': 'pending_transaction'}
        unit = {'activeState': 'activating', 'subState': 'start', 'invocationId': '1' * 32}
        def journal(args):
            selected = messages
            if native:
                pattern = next(arg.removeprefix('--grep=') for arg in args if arg.startswith('--grep='))
                result = subprocess.run(['grep', '-E', pattern], input='\n'.join(messages) + '\n',
                                        capture_output=True, text=True, timeout=2)
                self.assertIn(result.returncode, [0, 1], result.stderr)
                self.assertIn('--lines=12', args)
                selected = result.stdout.splitlines()[-12:]
            rows = [{'_SYSTEMD_INVOCATION_ID': unit['invocationId'],
                     '_SYSTEMD_UNIT': 'club-arena-engine-release-v1@' + request['runKey'] + '.service',
                     '__REALTIME_TIMESTAMP': str(1793318108736000 + ordinal * 1000), 'MESSAGE': message}
                    for ordinal, message in enumerate(selected)]
            return types.SimpleNamespace(returncode=0, stdout='\n'.join(json.dumps(row) for row in rows).encode())
        with patch.object(R, 'bounded_journal', side_effect=journal):
            return R.pending_journal(request, unit)

    def test_pending_entry_producer_timestamps_are_selected_without_private_text(self):
        cases = [
            ('[engine-release-lightning-hold] Lightning hold recorded: 11 owned, 0 foreign, 0 refused', 'lightning_hold_recorded'),
            ('[engine-release-lightning-hold] Lightning hold released: 11 owned Cluster(s)', 'lightning_hold_released'),
            ('[engine-release-lightning-hold] UNKNOWN: private transport fixture', 'lightning_hold_unknown'),
        ]
        for phase, reason in [('admitted', 'verified'), ('locked', 'verified'),
                              ('checkpoint', 'verified'), ('completed', 'verified'),
                              ('refused', 'countdown_refused'), ('refused', 'checkpoint_refused')]:
            cases.append(('[engine-release-transaction] legacy entry phase=' + phase + ' reason=' + reason
                          + ' elapsedEntryMs=123 remainingEntryMs=39877 remainingWindowMs=290123',
                          'legacy_entry_' + (reason if phase == 'refused' else phase)))
        cases += [
            ('[engine-release-transaction] WARN: the Lightning hold answered UNKNOWN (exit 124); it is retried on the next pass', 'lightning_hold_timeout'),
            ('[engine-release-transaction] WARN: the Lightning hold answered UNKNOWN (exit 3); it is retried on the next pass', 'lightning_hold_unknown'),
            ('[engine-release-transaction] WARN: the Lightning hold helper could not run (exit 127); Lightning was NEVER ASKED to pause this pass and the census guard decides on its own', 'lightning_hold_helper_unavailable'),
        ]
        signs = self.recovery_signs([message for message, _ in cases], native=True)
        self.assertEqual([sign['category'] for sign in signs], [category for _, category in cases])
        self.assertTrue(all(sign['details'] is None for sign in signs))
        R.validate_pending_signs(signs)
        self.assertNotIn('private', json.dumps(signs))
        self.assertNotIn('290123', json.dumps(signs))

    def test_pending_entry_categories_refuse_unknown_phases_and_forged_details(self):
        bad = [
            '[engine-release-lightning-hold] Lightning hold recorded: bad owned, 0 foreign, 0 refused',
            '[engine-release-lightning-hold] Lightning hold released: 11 owned Cluster(s) private',
            '[engine-release-transaction] legacy entry phase=private reason=verified elapsedEntryMs=1 remainingEntryMs=2 remainingWindowMs=3',
            '[engine-release-transaction] legacy entry phase=admitted reason=private elapsedEntryMs=1 remainingEntryMs=2 remainingWindowMs=3',
            '[engine-release-transaction] legacy entry phase=admitted reason=verified elapsedEntryMs=1 remainingEntryMs=2 remainingWindowMs=3 private',
        ]
        self.assertEqual(self.recovery_signs(bad, native=True), [])
        with self.assertRaises(ValueError):
            R.validate_pending_signs([{'category': 'lightning_hold_recorded', 'observedAtMs': 1793318108736, 'details': [11]}])

    def test_pending_recovery_producer_messages_export_closed_categories_only(self):
        cases = self.recovery_messages()
        signs = self.recovery_signs([message for message, _ in cases])
        self.assertEqual([sign['category'] for sign in signs], [category for _, category in cases])
        self.assertTrue(all(sign['details'] is None for sign in signs))
        R.validate_pending_signs(signs)
        body = json.dumps(signs)
        for private in ['c' * 40, '40980634821', 'private-window-fixture']:
            self.assertNotIn(private, body)
        producer = (ROOT / 'server/scripts/engine-release-transaction.sh').read_text()
        for literal in ['newer release ${newer#* } (run ${newer%% *})',
                        'legacy inspector absence is not proved; no recovery window requested',
                        'recovery announcement reservation could not be established; no window was announced',
                        'off-cycle window wanted ($reason) but one was already announced',
                        'fixed recovery announcement $stamp: $outcome; existing certificate and rollback budget remain required']:
            self.assertIn(literal, producer)

    def test_pending_recovery_native_selector_retains_the_maintained_forms(self):
        cases = self.recovery_messages()
        signs = self.recovery_signs([message for message, _ in cases], native=True)
        self.assertEqual([sign['category'] for sign in signs], [category for _, category in cases])
        for reason in ['engine-degraded liveness=dead', 'engine-degraded wholeFleetStalled',
                       'engine-degraded tournamentManagersQuarantined=100',
                       'engine-degraded liveness=dead,wholeFleetStalled,tournamentManagersQuarantined=101']:
            message = cases[3][0].replace('owner-ordered private-window-fixture', reason)
            self.assertEqual(self.recovery_signs([message], native=True)[0]['category'], 'recovery_rate_limited')

    def test_pending_recovery_malformed_private_tails_are_not_classified(self):
        cases = self.recovery_messages()
        malformed = [cases[0][0].replace('c' * 40, 'C' * 40),
                     cases[0][0].replace('40980634821-1', 'private-run'),
                     cases[1][0] + ' private endpoint', cases[2][0] + ' private reason',
                     cases[3][0].replace('owner-ordered private-window-fixture', 'private cause'),
                     cases[3][0].replace('owner-ordered private-window-fixture', 'engine-degraded private=1'),
                     cases[3][0].replace('owner-ordered private-window-fixture', 'owner-ordered ' + 'x' * 65),
                     cases[4][0].replace(': accepted;', ': private;'),
                     cases[4][0].replace('1793318108736', '9999999999999'),
                     cases[4][0] + ' private endpoint']
        self.assertEqual(self.recovery_signs(malformed), [])

    def test_pending_recovery_export_refuses_unknown_statuses_and_details(self):
        sign = {'category': 'recovery_announcement_accepted', 'observedAtMs': 1793318108736, 'details': None}
        R.validate_pending_signs([sign])
        for mutation in [{'category': 'recovery_announcement_private'}, {'details': [1793318108736]},
                         {'reason': 'private fixture'}]:
            with self.assertRaises(ValueError): R.validate_pending_signs([{**sign, **mutation}])

    def test_pending_recovery_latest_rows_preserve_unknown_earlier_evidence(self):
        early = ('[engine-release-transaction] the restart certificate is shut with 296969ms of the break left: '
                 "unparkedTables=1 unparkedReasons={'cards_in_air': 1} handsInFlightTotal=1")
        signs = self.recovery_signs([early] + [self.recovery_messages()[1][0]] * 20, native=True)
        self.assertEqual(len(signs), 12)
        self.assertTrue(all(sign['category'] == 'recovery_inspector_unproved' for sign in signs))
        request = {**REQUEST, 'mode': 'pending_transaction'}
        rows = [REQUEST['releaseSha'], 'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/38268897283',
                'private fixture', '/usr/local/lib/club-arena/engine-control-generations/' + 'b' * 40,
                'b' * 40, '1791829999']
        unit = {'activeState': 'activating', 'subState': 'start', 'invocationId': '1' * 32}
        answer = R.pending_observation(request, rows, rows, [REQUEST['releaseSha']], None, unit, signs)
        self.assertIn('unknown', answer['absenceMeans'])
        self.assertLessEqual(len(json.dumps(answer).encode()), 4096)
        self.assertEqual(R.validate_reply(answer, request), answer)

    def test_pending_twelve_causal_signs_fit_unchanged_transport_on_realistic_full_counts(self):
        request = {**REQUEST, 'mode': 'pending_transaction'}
        rows = [REQUEST['releaseSha'], 'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/38268897283',
                'private fixture', '/usr/local/lib/club-arena/engine-control-generations/' + 'b' * 40,
                'b' * 40, '1791829999']
        unit = {'activeState': 'activating', 'subState': 'start', 'invocationId': '1' * 32}
        signs = [{'category': 'certificate_shut', 'observedAtMs': 1793318108736,
                  'details': [299999, 1000, 1000, [1000] * (len(R.PENDING_REASON_ORDER) + 1)]} for _ in range(12)]
        answer = R.pending_observation(request, rows, rows, [REQUEST['releaseSha']], None, unit, signs)
        self.assertLessEqual(len(json.dumps(answer).encode()), 4096)
        self.assertEqual(R.validate_reply(answer, request), answer)

    def test_pending_native_files_refuse_links_fifo_changed_and_oversized_bytes(self):
        fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            path = self.root / 'pending'
            self.assertIsNone(R.read_lines(fd, 'pending', optional=True))
            path.symlink_to(self.window)
            with self.assertRaises(OSError): R.read_lines(fd, 'pending', optional=True)
            path.unlink(); os.mkfifo(path)
            with self.assertRaises(ValueError): R.read_lines(fd, 'pending')
            path.unlink(); path.write_bytes(b'x' * 4097)
            with self.assertRaises(ValueError): R.read_lines(fd, 'pending')
            path.write_text('one\n'); path.chmod(0o644)
            with self.assertRaises(ValueError): R.read_lines(fd, 'pending')
            path.chmod(0o600)
            before = os.fstat
            calls = 0
            def changed(value):
                nonlocal calls
                row = before(value); calls += 1
                if calls == 2:
                    return types.SimpleNamespace(st_dev=row.st_dev, st_ino=row.st_ino, st_size=row.st_size,
                                                 st_mtime_ns=row.st_mtime_ns + 1, st_ctime_ns=row.st_ctime_ns,
                                                 st_uid=row.st_uid, st_gid=row.st_gid, st_mode=row.st_mode)
                return row
            with patch.object(R.os, 'fstat', side_effect=changed), self.assertRaises(ValueError):
                R.read_lines(fd, 'pending')
        finally:
            os.close(fd)

    def test_provenance_fixed_hash_only_census_covers_original_custody_modules(self):
        spec = importlib.util.spec_from_file_location('provenance', ROOT / 'scripts/ci/read-scoped-operator-hold-provenance.py')
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        needed = {'engine/HandController.js', 'engine/HandContinuationLane.js',
            'engine/PrivateHandContinuation.js', 'engine/TimeBankEngine.js',
            'engine/DisconnectEngine.js', 'engine/ServerTableEngineTurns.js',
            'services/F06HandPermit.js', 'services/TournamentRetirementCustody.js',
            'services/supabase/handContinuation.js', 'services/supabase/snapshots.js'}
        self.assertTrue(needed <= set(module.FILES))
        self.assertEqual(len(module.FILES), 24)
        self.assertEqual(len(set(module.FILES)), 24)
        self.assertTrue(all(path.endswith('.js') and '..' not in path for path in module.FILES))
        self.assertNotIn('process.env', module.NODE_READ)
        self.assertIn("return {path,bytes:bytes.length,sha256:", module.NODE_READ)

    def test_selection_refuses_paths_commands_wrong_types_and_unbounded_ids(self):
        for request in [None, {}, {**REQUEST, 'command': 'cat /app/.env'},
                        {**REQUEST, 'runKey': '../../keys'}, {**REQUEST, 'runKey': '1;id-1'},
                        {**REQUEST, 'runKey': '1' * 100 + '-1'},
                        {**REQUEST, 'releaseSha': '$(id)'}, {**REQUEST, 'releaseSha': True}]:
            with self.subTest(request=request), self.assertRaises(ValueError):
                R.selection(request)

    def test_wrong_window_run_sha_cause_time_or_extra_fields_fail_closed(self):
        for field, value in [('runId', '1-1'), ('sha', 'b' * 40), ('cause', 'missed-window'),
                             ('cause', None), ('announcedAt', True), ('announcedAt', -1)]:
            bad = {**WINDOW, field: value}
            self.window.write_text(json.dumps(bad))
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                R.remote(REQUEST)
        self.window.write_text(json.dumps({**WINDOW, 'arbitrary_detail': 'never export'}))
        with self.assertRaises(ValueError):
            R.remote(REQUEST)

    def test_wrong_terminal_run_sha_outcome_schema_or_outside_window_refused(self):
        for field, value in [('runId', '1-1'), ('sha', 'b' * 40), ('result', 'already-released'),
                             ('result', 'pending'), ('schema', True), ('completedAt', True),
                             ('completedAt', WINDOW['announcedAt']),
                             ('completedAt', (WINDOW['announcedAt'] + 119000) // 1000),
                             ('completedAt', (WINDOW['announcedAt'] + 421000) // 1000)]:
            self.result.write_text(json.dumps({**RESULT, field: value}))
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                R.remote(REQUEST)

    def test_all_named_causes_require_existing_seal_inside_window(self):
        for cause in sorted(R.CAUSES):
            self.window.write_text(json.dumps({**WINDOW, 'cause': cause}))
            self.assertEqual(R.remote(REQUEST)['cause'], cause)

    def test_missing_evidence_never_infers_ordinary_or_emergency_cause(self):
        self.window.unlink()
        with self.assertRaises(FileNotFoundError):
            R.remote(REQUEST)

    def test_malformed_duplicate_truncated_and_large_json_are_refused(self):
        for raw in [b'{', b'null', b'{"cause":"urgent","cause":"deadline"}', b'x' * 65537]:
            self.window.write_bytes(raw)
            with self.subTest(raw=raw[:20]), self.assertRaises((ValueError, json.JSONDecodeError)):
                R.remote(REQUEST)

    def test_symlink_file_and_directory_and_fifo_refused(self):
        self.window.unlink()
        self.window.symlink_to(self.result)
        with self.assertRaises(OSError):
            R.remote(REQUEST)
        self.window.unlink()
        os.mkfifo(self.window)
        with self.assertRaises(ValueError):
            R.remote(REQUEST)
        self.window.unlink()
        self.window.write_text(json.dumps(WINDOW))
        self.result.unlink()
        (self.root / 'engine-release-results').rmdir()
        (self.root / 'engine-release-results').symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(OSError):
            R.remote(REQUEST)

    def test_changed_second_read_refused(self):
        original = R.read_json
        calls = 0

        def changed(fd, name):
            nonlocal calls
            value = original(fd, name)
            calls += 1
            if calls == 3:
                value['cause'] = 'deadline'
            return value

        with patch.object(R, 'read_json', changed), self.assertRaises(ValueError):
            R.remote(REQUEST)

    def test_unapproved_export_field_or_boolean_readonly_or_wrong_time_refused(self):
        answer = R.remote(REQUEST)
        for mutation in [{'raw': 'no'}, {'readOnly': False}, {'readOnly': 1}, {'windowEndsAtMs': 0}, {'cause': 'missed'},
                         {'emergencyBasisStatus': 'passed'}]:
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                R.validate_reply({**answer, **mutation}, REQUEST)

    def test_event_and_scheduled_invocation_refuse_before_transport(self):
        with patch.dict(os.environ, {'GITHUB_EVENT_NAME': 'schedule'}), patch.object(R.subprocess, 'run') as run:
            with self.assertRaises(ValueError):
                R.main()
            run.assert_not_called()

    def test_actual_client_uses_pinned_fixed_command_and_cleans_private_transport(self):
        event = self.root / 'event.json'
        event.write_text(json.dumps({'action': 'audit-production-integrity',
                                    'client_payload': {'release_recovery_observation': REQUEST}}))
        answer = R.remote(REQUEST)
        calls = []

        def execute(args, **kwargs):
            calls.append(args)
            if args[0] == 'ssh-keygen':
                return types.SimpleNamespace(returncode=0)
            self.assertEqual(args[0], 'ssh')
            self.assertIn('StrictHostKeyChecking=yes', args)
            self.assertIn('GlobalKnownHostsFile=/dev/null', args)
            self.assertEqual(args[-2], 'root@configured.example')
            self.assertTrue(args[-1].startswith("python3 - --remote '"))
            encoded = args[-1].split("'")[1]
            self.assertEqual(json.loads(R.base64.b64decode(encoded)), REQUEST)
            self.assertEqual(kwargs['input'], Path(R.__file__).read_bytes())
            return types.SimpleNamespace(returncode=0, stdout=json.dumps(answer).encode())

        environment = {'GITHUB_EVENT_NAME': 'repository_dispatch', 'GITHUB_EVENT_PATH': str(event),
                       'HETZNER_HOST': 'configured.example', 'HETZNER_SSH_PRIVATE_KEY': 'opaque-test-key',
                       'HETZNER_HOST_KEY': 'opaque-test-pin', 'RUNNER_TEMP': str(self.root)}
        old = Path.cwd()
        try:
            os.chdir(self.root)
            with patch.dict(os.environ, environment), patch.object(R.subprocess, 'run', execute):
                R.main()
            exported = (self.root / 'artifacts/release-recovery-observation/observation.json').read_text()
            self.assertNotIn('opaque-test', exported)
            self.assertEqual(len(calls), 3)
            self.assertEqual(list(self.root.glob('release-recovery-read-*')), [])
        finally:
            os.chdir(old)

    def test_existing_workflow_reader_is_explicit_pinned_readonly_and_enforced(self):
        workflow = (ROOT / '.github/workflows/production-integrity-audit.yml').read_text()
        job = workflow.split('\n  scoped_release_recovery:', 1)[1].split('\n  scoped_operator_hold_image:', 1)[0]
        self.assertIn("github.event_name == 'repository_dispatch'", job)
        self.assertIn('github.event.client_payload.release_recovery_observation != null', job)
        self.assertIn('contents: read', job)
        self.assertNotIn('contents: write', job)
        self.assertIn('python3 -B tests/operations/release-recovery-read.test.py', job)
        self.assertIn('python3 -B scripts/ci/read-scoped-release-recovery.py', job)
        self.assertIn('actions/upload-artifact@v4', job)
        source = (ROOT / 'scripts/ci/read-scoped-release-recovery.py').read_text()
        self.assertIn('StrictHostKeyChecking=yes', source)
        self.assertIn("'_SYSTEMD_INVOCATION_ID=' + invocation", source)
        self.assertIn("'_SYSTEMD_UNIT=club-arena-engine-release-v1@' + request['runKey'] + '.service'", source)
        self.assertIn("'--lines=2'", source)
        self.assertIn('8193 - len(raw)', source)
        self.assertNotIn('shell=True', source)
        # This explicit inspector mode admits only immutable Docker reads and
        # its scalar-only helper, not lifecycle operations or a publisher.
        for forbidden in ["'restart'", "'stop'", "'kill'", "'rm'", "'run'"]:
            self.assertNotIn(forbidden, source[source.index('def inspector_identity'):source.index('def remote(')])
        for forbidden in ['Runtime.queryObjects', "SIGUSR1", 'inspector.close(', 'global.gc(', 'GameServer.']:
            self.assertNotIn(forbidden, R.INSPECTOR_NODE)
        self.assertEqual(R.INSPECTOR_NODE.count("method:'Runtime.evaluate'"), 1)
        self.assertIn("hostname:'127.0.0.1',port:9229", R.INSPECTOR_NODE)
        self.assertNotIn('process.env', R.INSPECTOR_NODE)
        # The only systemd operation is a bounded exact-unit metadata show.
        tree = ast.parse(source)
        lists = [node for node in ast.walk(tree) if isinstance(node, ast.List)
                 and node.elts and isinstance(node.elts[0], ast.Constant)
                 and node.elts[0].value == 'systemctl']
        self.assertEqual(len(lists), 1)
        self.assertEqual(lists[0].elts[1].value, 'show')
        self.assertIn('--property=ActiveState,SubState,InvocationID', source)

    def witness_fixture(self):
        invocation = 'd' * 32
        result = {**RESULT, 'invocationIds': [invocation],
                  'completionRuntime': {'invocationId': invocation}}
        row = {'__CURSOR': 's=abc;i=1;b=' + 'f' * 32, '__MONOTONIC_TIMESTAMP': '12345',
               '_BOOT_ID': 'f' * 32, 'MESSAGE': R.REASON_PREFIX + 'engine-degraded breaksSinceRestartCertified=1,liveness=dead',
               '_SYSTEMD_INVOCATION_ID': invocation,
               '_SYSTEMD_UNIT': 'club-arena-engine-release-v1@' + REQUEST['runKey'] + '.service',
               '__REALTIME_TIMESTAMP': str((WINDOW['announcedAt'] + 50) * 1000)}
        return result, row

    def test_actual_remote_handler_recovers_original_reason_without_raw_export(self):
        result, row = self.witness_fixture()
        self.result.write_text(json.dumps(result))
        before = R.observation(REQUEST, WINDOW, result)
        self.assertEqual(before['emergencyBasisStatus'], 'unknown_not_retained_in_selected_receipts')
        calls = []
        def journal(args):
            calls.append(args)
            self.assertIn('_SYSTEMD_INVOCATION_ID=' + row['_SYSTEMD_INVOCATION_ID'], args)
            self.assertIn('_SYSTEMD_UNIT=' + row['_SYSTEMD_UNIT'], args)
            self.assertIn('--lines=2', args)
            self.assertIn('--since=@' + str(WINDOW['announcedAt'] // 1000), args)
            return types.SimpleNamespace(returncode=0, stdout=json.dumps(row).encode())
        with patch.object(R, 'bounded_journal', journal):
            after = R.remote(REQUEST)
        self.assertEqual(len(calls), 1)
        self.assertEqual(after['emergencyBasis']['signs'], {'breaksSinceRestartCertified': 1, 'liveness': 'dead'})
        self.assertEqual(after['emergencyBasisStatus'], 'retained_exact_invocation_producer_signs')
        self.assertNotIn('MESSAGE', json.dumps(after))
        self.assertNotIn('secret fixture', json.dumps(after))
        self.assertEqual(R.validate_reply(after, REQUEST), after)

    def test_real_v255_profile_passes_actual_handler_and_discards_sequence_metadata(self):
        result, row = self.witness_fixture()
        row.update({'__SEQNUM': '18446744073709551615', '__SEQNUM_ID': 'a' * 32})
        self.result.write_text(json.dumps(result))
        with patch.object(R, 'bounded_journal', return_value=types.SimpleNamespace(returncode=0, stdout=json.dumps(row).encode())):
            answer = R.remote(REQUEST)
        self.assertEqual(answer['emergencyBasis']['signs']['liveness'], 'dead')
        self.assertNotIn('__SEQNUM', json.dumps(answer))
        self.assertEqual(R.validate_reply(answer, REQUEST), answer)

    def test_sequence_pair_must_be_complete_typed_positive_uint64_and_native_id(self):
        result, row = self.witness_fixture()
        pair = {'__SEQNUM': '1', '__SEQNUM_ID': 'a' * 32}
        mutations = [{'__SEQNUM': '1'}, {'__SEQNUM_ID': 'a' * 32}]
        mutations += [{**pair, '__SEQNUM': x} for x in [0, True, [], '0', '-1', '01', '18446744073709551616', '1' * 21]]
        mutations += [{**pair, '__SEQNUM_ID': x} for x in [None, [], 'g' * 32, 'a' * 31]]
        mutations += [{**pair, 'secret': 'never-export'}]
        for mutation in mutations:
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                R.reason_from_rows(json.dumps({**row, **mutation}).encode(), REQUEST, WINDOW, result)

    def test_refusal_protocol_exports_only_literal_codes_never_exception_detail(self):
        for error, expected in [(ValueError('Recovery journal fields refused'), ('journal', 'fields_refused')),
                                (ValueError('/private/secret unknown'), ('remote', 'evidence_refused'))]:
            answer = R.refusal(REQUEST, error)
            refusal = R.validate_refusal(answer, REQUEST)
            self.assertEqual((refusal.phase, refusal.code), expected)
            self.assertNotIn('secret', json.dumps(answer))
        answer = R.refusal(REQUEST, ValueError('Recovery journal fields refused'))
        for mutation in [{'runKey': '1-1'}, {'releaseSha': 'b' * 40}, {'readOnly': 1},
                         {'schema': 'other'}, {'code': '/private/secret'}, {'phase': []},
                         {'raw': 'never export'}, {'phase': 'remote'}]:
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                R.validate_refusal({**answer, **mutation}, REQUEST)

    def test_actual_remote_main_emits_only_bounded_refusal_on_native_failure(self):
        encoded = base64.b64encode(json.dumps(REQUEST).encode()).decode()
        output = io.StringIO()
        self.window.write_text(json.dumps({**WINDOW, 'secret': 'never-export'}))
        with patch.object(R.sys, 'argv', ['reader', '--remote', encoded]), contextlib.redirect_stdout(output), self.assertRaises(SystemExit) as exit_code:
            R.main()
        self.assertEqual(exit_code.exception.code, 1)
        exported = json.loads(output.getvalue())
        self.assertNotIn('secret', output.getvalue())
        self.assertEqual(R.validate_refusal(exported, REQUEST).code, 'evidence_refused')

    def test_actual_client_rejects_untrusted_failure_output_and_preserves_scoped_code(self):
        event = self.root / 'event.json'
        event.write_text(json.dumps({'action': 'audit-production-integrity', 'client_payload': {'release_recovery_observation': REQUEST}}))
        environment = {'GITHUB_EVENT_NAME': 'repository_dispatch', 'GITHUB_EVENT_PATH': str(event),
                       'HETZNER_HOST': 'configured.example', 'HETZNER_SSH_PRIVATE_KEY': 'opaque-test-key',
                       'HETZNER_HOST_KEY': 'opaque-test-pin', 'RUNNER_TEMP': str(self.root)}
        known = R.refusal(REQUEST, ValueError('Recovery journal fields refused'))
        for payload, exception in [(json.dumps(known).encode(), R.ScopedRefusal),
                                   (b'raw private host failure', ValueError),
                                   (json.dumps({**known, 'releaseSha': 'b' * 40}).encode(), ValueError),
                                   (b'x' * 4097, ValueError)]:
            def execute(args, **kwargs):
                return types.SimpleNamespace(returncode=0) if args[0] == 'ssh-keygen' else types.SimpleNamespace(returncode=1, stdout=payload, stderr=b'never-export-secret')
            with patch.dict(os.environ, environment), patch.object(R.subprocess, 'run', execute), self.assertRaises(exception) as failed:
                R.main()
            self.assertNotIn('secret', str(failed.exception))
            self.assertEqual(list(self.root.glob('release-recovery-read-*')), [])

    def test_wrong_invocation_unit_time_cause_and_extra_journal_fields_refused(self):
        result, row = self.witness_fixture()
        for mutation in [{'_SYSTEMD_INVOCATION_ID': 'e' * 32}, {'_SYSTEMD_UNIT': 'other.service'},
                         {'__REALTIME_TIMESTAMP': str((WINDOW['announcedAt'] - 1) * 1000)},
                         {'__REALTIME_TIMESTAMP': str((WINDOW['announcedAt'] + 120001) * 1000)},
                         {'MESSAGE': R.REASON_PREFIX + 'deadline something'}, {'secret': 'never export'},
                         {'MESSAGE': R.REASON_PREFIX + 'engine-degraded liveness=dead,arbitrary=secret'}]:
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                R.reason_from_rows(json.dumps({**row, **mutation}).encode(), REQUEST, WINDOW, result)

    def test_missing_journal_is_unknown_and_ambiguous_or_malformed_is_not_pass(self):
        result, row = self.witness_fixture()
        self.result.write_text(json.dumps(result))
        for reply in [types.SimpleNamespace(returncode=0, stdout=b''),
                      types.SimpleNamespace(returncode=1, stdout=b'private error')]:
            with patch.object(R, 'bounded_journal', return_value=reply):
                self.assertIsNone(R.remote(REQUEST)['emergencyBasis'])
        for raw in [b'{', json.dumps(row).encode() + b'\n' + json.dumps(row).encode(), b'x' * 8193]:
            with self.subTest(raw=raw[:20]), self.assertRaises(ValueError):
                R.reason_from_rows(raw, REQUEST, WINDOW, result)

    def test_replay_invocation_and_corrupt_allowlist_refuse_before_journal(self):
        result, row = self.witness_fixture()
        for mutation in [{'invocationIds': ['e' * 32]}, {'invocationIds': ['d' * 32] * 2},
                         {'invocationIds': ['d' * 32, 'bad']},
                         {'completionRuntime': {'invocationId': 'e' * 32}}]:
            self.result.write_text(json.dumps({**result, **mutation}))
            with patch.object(R, 'bounded_journal') as journal, self.assertRaises(ValueError):
                R.remote(REQUEST)
            journal.assert_not_called()

    def test_sign_thresholds_types_duplicates_and_export_forgery_refused(self):
        result, row = self.witness_fixture()
        for tail in ['breaksSinceRestartCertified=0', 'tournamentManagersQuarantined=99',
                     'tournamentManagersQuarantined=2147483648', 'liveness=ok',
                     'wholeFleetStalled,wholeFleetStalled', 'liveness=dead,liveness=dead']:
            with self.subTest(tail=tail), self.assertRaises(ValueError):
                R.reason_from_rows(json.dumps({**row, 'MESSAGE': R.REASON_PREFIX + 'engine-degraded ' + tail}).encode(), REQUEST, WINDOW, result)
        answer = R.observation(REQUEST, WINDOW, result)
        with self.assertRaises(ValueError):
            R.validate_reply({**answer, 'emergencyBasisStatus': 'retained_exact_invocation_producer_signs'}, REQUEST)

    def test_bounded_native_process_never_collects_unbounded_journal(self):
        # Execute the actual bounded subprocess read in isolation; the host
        # selector is already pinned by the handler fixture above.
        reply = R.bounded_journal(['python3', '-c', 'print("native witness")'])
        self.assertEqual(reply.returncode, 0)
        self.assertEqual(reply.stdout, b'native witness\n')
        with self.assertRaises(ValueError):
            R.bounded_journal(['python3', '-c', 'print("x" * 9000)'])

    def test_actual_reservation_and_terminal_producer_contracts_stay_bound(self):
        tree = ast.parse((ROOT / 'server/scripts/engine-release-seal.py').read_text())
        functions = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}
        reserve = functions['cmd_reserve_recovery_window']
        dictionaries = [node for node in ast.walk(reserve) if isinstance(node, ast.Dict)]
        self.assertTrue(any({key.value for key in node.keys if isinstance(key, ast.Constant)} ==
                            {'runId', 'sha', 'announcedAt', 'cause'} for node in dictionaries))
        self.assertTrue(any(isinstance(node, ast.Call) and ast.unparse(node) == 'int(time.time() * 1000)'
                            for node in ast.walk(reserve)))
        # The terminal result owner must keep schema 1 and epoch-second completion.
        owners = [node for node in functions.values() if any(
            isinstance(child, ast.Dict) and any(isinstance(key, ast.Constant) and key.value == 'completionRuntime'
                                               for key in child.keys) for child in ast.walk(node))]
        self.assertTrue(owners)
        producer = (ROOT / 'server/scripts/engine-release-transaction.sh').read_text()
        self.assertIn('INVOCATION_ID="${INVOCATION_ID:-}"', producer)
        self.assertIn('off-cycle recovery window reason: $reason', producer)
        self.assertIn('--control-sha "$CONTROL_SHA" --invocation-id "$INVOCATION_ID"', producer)
        # Historical journal witnesses above retain their original signs; the
        # current producer must not promote a missed certificate to an emergency.
        reason = producer[producer.index('recovery_window_reason() {'):producer.index('newer_release_in_flight() {')]
        self.assertNotIn('breaksSinceRestartCertified', reason)
        self.assertIn('RECOVERY_QUARANTINED_MANAGERS=100', producer)
        wrapper = (ROOT / 'server/scripts/engine-release-unit-wrapper.sh').read_text()
        self.assertIn('env ENGINE_CONTROL_DIR="$GENERATION"', wrapper)
        self.assertIn('"$GENERATION/engine-release-transaction.sh" --run-id "$RUN_KEY"', wrapper)
        for owner in owners:
            results = [node for node in ast.walk(owner) if isinstance(node, ast.Dict) and
                       any(isinstance(key, ast.Constant) and key.value == 'completedAt' for key in node.keys)]
            self.assertTrue(results)
            for result in results:
                fields = {key.value: value for key, value in zip(result.keys, result.values)
                          if isinstance(key, ast.Constant)}
                self.assertEqual(ast.literal_eval(fields['schema']), 1)
                self.assertEqual(ast.unparse(fields['completedAt']), 'int(time.time())')




class InspectorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='owned-inspector-', dir=ROOT.parent)
        self.root = Path(self.temp.name)
        d = self.root / 'engine-release-requests'; d.mkdir(); self.d = d
        self.request = {**REQUEST, 'mode': 'legacy_checkpoint_inspector'}
        self.intent = {'instance':'1-1234abcd','container':'c'*64,'startedAt':'2026-10-29T20:00:00.000Z',
            'hostPid':1234,'source':R.EED,'runId':REQUEST['runKey'],'controlSha':'b'*40,'at':1793307300.0,'retryAllowed':False}
        self.identity = {'container':'c'*64,'image':'sha256:'+'d'*64,'running':'true',
            'startedAt':self.intent['startedAt'],'hostPid':'1234','restarts':'0'}
        self.health = {'source':R.EED,'instance':self.intent['instance']}
        self.url = 'ws://127.0.0.1:9229/12345678-1234-1234-1234-123456789abc'
        self.digest = R.hashlib.sha256(self.url.encode()).hexdigest()
        self.native = {'pid':1,'usedHeapBytes':100000000,'availableHeapBytes':200000000,
            'heapLimitBytes':4000000000,'availableProcessBytes':1000000000}
        self.write_intent()
        rows = [REQUEST['releaseSha'], 'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/38268897283',
            'private actor', '/usr/local/lib/club-arena/engine-control-generations/'+'b'*40,'b'*40,'1793399999']
        for suffix in ['.request','.intent']:
            p=d/(REQUEST['runKey']+suffix);p.write_text('\n'.join(rows)+'\n');p.chmod(0o600)
        self.patches = [patch.object(R,'STATE_ROOT',self.root),patch.object(R,'inspector_identity',return_value=self.identity),
            patch.object(R,'inspector_health',return_value=self.health)]
        for p in self.patches:p.start()
        self.calls=[]
    def tearDown(self):
        for p in reversed(self.patches):p.stop()
        self.temp.cleanup()
    def write_intent(self):
        self.path=self.d/(REQUEST['runKey']+'.legacy-checkpoint-intent')
        self.path.write_text(json.dumps(self.intent));self.path.chmod(0o600)
    def command(self,args,deadline,**kwargs):
        self.calls.append(args)
        if args[1:3]==['image','inspect']:return (R.EED+'\n').encode()
        if args[1]=='logs':return ('2026-10-29T20:55:01.000000000Z Debugger listening on '+self.url+'\nprivate ignored log\n').encode()
        raise AssertionError(args)
    def run_probe(self, probes):
        with patch.object(R,'inspector_command',side_effect=self.command),patch.object(R,'inspector_probe',side_effect=probes) as probe:
            result=R.remote(self.request)
        self.assertEqual(R.validate_reply(result,self.request),result)
        return result,probe
    def test_closed_proves_only_absence_without_logs_or_websocket(self):
        v,p=self.run_probe([{'state':'closed','endpointSha256':None}])
        self.assertEqual(v['status'],'closed');self.assertIsNone(v['nativeMemory']);self.assertEqual(p.call_count,1)
        self.assertFalse(any(x[1]=='logs' for x in self.calls))
    def test_owned_exact_original_endpoint_exports_only_scalar_provenance(self):
        v,p=self.run_probe([{'state':'open','endpointSha256':self.digest},{'state':'owned','endpointSha256':self.digest,'native':self.native}])
        self.assertEqual(v['status'],'owned');self.assertTrue(v['nativeMemory']['predicateSatisfied'])
        self.assertEqual(p.call_args.args[-1],self.digest)
        for text in [self.url,'private','1234','c'*64,'/app']:
            if text=='1234':continue
            self.assertNotIn(text,json.dumps(v))
        self.assertEqual(v['readiness'],'unknown_not_certified_by_metadata')
    def test_foreign_endpoint_never_attaches(self):
        v,p=self.run_probe([{'state':'open','endpointSha256':'e'*64}]);self.assertEqual(v['status'],'foreign');self.assertEqual(p.call_count,1)
    def test_foreign_client_never_exports_memory(self):
        v,_=self.run_probe([{'state':'open','endpointSha256':self.digest},{'state':'foreign','endpointSha256':self.digest}]);self.assertEqual(v['reason'],'established_inspector_client');self.assertIsNone(v['nativeMemory'])
    def test_missing_log_is_unproved_and_never_attaches(self):
        with patch.object(R,'inspector_endpoint',side_effect=ValueError('missing')):
            v,p=self.run_probe([{'state':'open','endpointSha256':self.digest}])
        self.assertEqual(v['status'],'unproved');self.assertEqual(v['reason'],'historical_endpoint_unavailable');self.assertEqual(p.call_count,1)
    def test_missing_intent_is_refused_not_empty(self):
        self.path.unlink()
        with self.assertRaises(R.ScopedRefusal) as caught:R.remote(self.request)
        self.assertEqual((caught.exception.phase,caught.exception.code),('inspector','intent_unavailable'))
    def test_intent_candidate_control_and_original_identity_mismatch_refuse(self):
        for key,value in [('runId','1-1'),('source','a'*40),('controlSha','e'*40),('retryAllowed',True),('hostPid',True),('at',float('nan'))]:
            original=dict(self.intent);self.intent[key]=value;self.write_intent()
            with self.subTest(key=key),self.assertRaises(ValueError):R.remote(self.request)
            self.intent=original
        self.write_intent()
    def test_changed_identity_rejects_even_closed_result(self):
        with patch.object(R,'inspector_identity',side_effect=[self.identity,{**self.identity,'hostPid':'5678'}]),self.assertRaises(ValueError):
            self.run_probe([{'state':'closed','endpointSha256':None}])
    def test_permissions_and_symlink_intent_refused(self):
        self.path.chmod(0o644)
        with self.assertRaises(ValueError):R.remote(self.request)
        self.path.unlink();self.path.symlink_to(self.d/'other')
        with self.assertRaises(R.ScopedRefusal):R.remote(self.request)
    def test_historical_exact_line_ambiguous_foreign_oversize_and_time(self):
        line=('2026-10-29T20:55:01Z Debugger listening on '+self.url+'\n').encode()
        self.assertEqual(R.inspector_endpoint(line,self.intent['at']),self.digest)
        for raw in [b'',line+line,line.replace(b'127.0.0.1',b'evil.local'),b'x'*65537,line.replace(b'20:55:01',b'20:56:01')]:
            with self.subTest(raw=raw[:40]),self.assertRaises(ValueError):R.inspector_endpoint(raw,self.intent['at'])
    def test_missing_nonfinite_wrong_pid_and_overflow_memory_refuse(self):
        for key,value in [('pid',2),('pid',True),('availableProcessBytes',None),('usedHeapBytes',float('inf')),('availableHeapBytes',-1),('usedHeapBytes',9007199254740991)]:
            with self.subTest(key=key,value=value),self.assertRaises(ValueError):R.inspector_memory({**self.native,key:value})
    def test_predicate_boundary_is_exact_32MiB_8x_but_not_readiness(self):
        n={**self.native,'availableHeapBytes':133554432,'availableProcessBytes':833554432}
        self.assertTrue(R.inspector_memory(n)['predicateSatisfied'])
        for key in ['availableHeapBytes','availableProcessBytes']:
            self.assertFalse(R.inspector_memory({**n,key:n[key]-1})['predicateSatisfied'])
    def test_scalar_forgery_extra_fields_and_unknown_as_owned_refused(self):
        v,_=self.run_probe([{'state':'closed','endpointSha256':None}])
        for change in [{'nativeMemory':self.native},{'status':'owned'},{'endpointSha256':self.digest},{'raw':'private'},{'readiness':'ready'},{'originalSourceSha':None},{'reason':'evidence_unavailable'}]:
            with self.subTest(change=change),self.assertRaises(ValueError):R.validate_reply({**v,**change},self.request)
    def test_bounded_native_child_deadline_and_oversize(self):
        with self.assertRaises(ValueError):R.inspector_command(['python3','-c','print("x"*1000)'],R.time.monotonic()+2,limit=100)
        with self.assertRaises(ValueError):R.inspector_command(['python3','-c','import time;time.sleep(1)'],R.time.monotonic()+.02)
    def test_probe_closed_unknown_and_native_payload_bound(self):
        for row in [{'state':'closed','endpointSha256':'a'*64},{'state':'open','endpointSha256':None},{'state':'whatever','endpointSha256':None},{'state':'owned','endpointSha256':'a'*64,'native':{},'raw':'private'}]:
            with patch.object(R,'inspector_command',return_value=json.dumps(row).encode()),self.subTest(row=row),self.assertRaises(ValueError):R.inspector_probe('c'*64,123)


    def test_inspector_known_boundaries_roundtrip_remote_refusal_without_private_text(self):
        # Exercise the actual remote selection and final refusal validator;
        # only maintained literal boundary messages may acquire typed codes.
        known = {message: code for message, (phase, code) in R.REFUSALS.items()
                 if phase == 'inspector'}
        self.assertEqual(len(known), 27)
        for message, code in known.items():
            with self.subTest(code=code), patch.object(R, 'inspector_remote', side_effect=ValueError(message)):
                with self.assertRaises(ValueError) as caught:
                    R.remote(self.request)
                exported = R.refusal(self.request, caught.exception)
                validated = R.validate_refusal(exported, self.request)
                self.assertEqual((validated.phase, validated.code), ('inspector', code))
                self.assertNotIn(message, json.dumps(exported))
                self.assertEqual(set(exported), {'schema','readOnly','runKey','releaseSha','mode','phase','code'})
        with patch.object(R, 'inspector_remote', side_effect=ValueError('/private/raw stderr secret')):
            with self.assertRaises(ValueError) as caught:
                R.remote(self.request)
            exported = R.refusal(self.request, caught.exception)
            self.assertEqual(R.validate_refusal(exported,self.request).code, 'evidence_refused')
            self.assertNotIn('secret', json.dumps(exported))

    def test_literal_command_stages_roundtrip_without_exporting_arguments(self):
        for stage in R.INSPECTOR_COMMAND_STAGES:
            for message, code in R.INSPECTOR_COMMAND_ERRORS.items():
                with self.subTest(stage=stage, code=code), patch.object(R, '_inspector_command', side_effect=ValueError(message)):
                    with patch.object(R, 'inspector_remote', side_effect=lambda *args: R.inspector_command(['private command secret'],123,stage=stage)):
                        with self.assertRaises(R.ScopedRefusal) as caught:
                            R.remote(self.request)
                    exported = R.refusal(self.request,caught.exception)
                    answer = R.validate_refusal(exported,self.request)
                    self.assertEqual((answer.phase,answer.code),('inspector_'+stage,code))
                    self.assertNotIn('private',json.dumps(exported))
        with patch.object(R,'_inspector_command') as child, self.assertRaises(ValueError):
            R.inspector_command(['secret'],123,stage='unreviewed_private')
        child.assert_not_called()

    def test_native_child_idle_poll_is_not_the_absolute_deadline(self):
        # A real child stays silent past the old three-second polling slice.
        started = R.time.monotonic()
        raw = R.inspector_command([R.sys.executable, '-c',
            'import time;time.sleep(3.1);print("bounded reply")'], started + 6)
        self.assertEqual(raw, b'bounded reply\n')
        self.assertGreaterEqual(R.time.monotonic() - started, 3.1)
        self.assertLess(R.time.monotonic() - started, 6)

    def test_native_command_refusals_roundtrip_deadline_size_and_nonzero(self):
        for code, command, seconds, limit in [
            ('command_deadline', 'import time;time.sleep(2)', .05, 100),
            ('command_size', 'print("x"*1000)', 2, 100),
            ('command_nonzero', 'import sys;sys.stderr.write("private secret");sys.exit(7)', 2, 100),
        ]:
            with self.subTest(code=code), self.assertRaises(ValueError) as caught:
                R.inspector_command([R.sys.executable, '-c', command], R.time.monotonic()+seconds, limit=limit)
            exported = R.refusal(self.request, caught.exception)
            self.assertEqual(R.validate_refusal(exported,self.request).code, code)
            self.assertNotIn('private',json.dumps(exported))

    def test_actual_inspector_observer_child_isolates_inherited_options_in_both_phases(self):
        import socket
        node=os.environ.get('RELEASE_RECOVERY_TEST_NODE','node')
        for expected in [None,self.digest]:
            with patch.object(R,'inspector_command',return_value=b'{"state":"closed","endpointSha256":null}') as command:
                result=R.inspector_probe(self.identity['container'],123,expected)
            self.assertEqual(result,{'state':'closed','endpointSha256':None})
            self.assertEqual(command.call_args.args[0],['docker','exec','-i','-e','NODE_OPTIONS=',
                self.identity['container'],'node','--no-inspect','--input-type=module','-',
                'read' if expected else 'probe',expected or ''])
            self.assertEqual(command.call_args.args[1],123)
            self.assertEqual(command.call_args.kwargs,
                {'input_bytes':R.INSPECTOR_NODE.encode(),'limit':16384,'stage':'probe'})
        with socket.socket() as closed:
            closed.bind(('127.0.0.1',0));port=closed.getsockname()[1]
        source=R.INSPECTOR_NODE.replace('9229',str(port)).encode()
        inherited={**os.environ,'NODE_OPTIONS':'--inspect=127.0.0.1:'+str(port)}
        before=subprocess.run([node,'--input-type=module','-','probe',''],input=source,
            capture_output=True,env=inherited,timeout=5)
        self.assertEqual(before.returncode,0,before.stderr)
        self.assertIn(b'Debugger listening',before.stderr)
        self.assertEqual(json.loads(before.stdout)['state'],'open')
        after=subprocess.run([node,'--no-inspect','--input-type=module','-','probe',''],input=source,
            capture_output=True,env={**inherited,'NODE_OPTIONS':''},timeout=5)
        self.assertEqual(after.returncode,0,after.stderr)
        self.assertNotIn(b'Debugger listening',after.stderr)
        self.assertEqual(json.loads(after.stdout),{'state':'closed','endpointSha256':None})

    def test_actual_native_scalar_read_and_proxy_environment_independence(self):
        # Actual native inspector evaluation in an isolated child. Linux PID 1
        # binding is separately pinned in the maintained transport; this local
        # process deliberately is not a production container or target.
        import re
        expression = re.search(r'const evaluate="(.*)";', R.INSPECTOR_NODE)[1]
        script = "import inspector from 'node:inspector';const s=new inspector.Session();s.connect();s.post('Runtime.evaluate'," + json.dumps({'expression':expression,'returnByValue':True,'timeout':500}) + ",(e,r)=>{if(e||r.exceptionDetails)process.exitCode=1;else console.log(JSON.stringify(r.result.value));s.disconnect()});"
        node = os.environ.get('RELEASE_RECOVERY_TEST_NODE', 'node')
        reply = R.subprocess.run([node,'--input-type=module','-e',script],capture_output=True,timeout=5,
            env={**os.environ,'HTTP_PROXY':'http://invalid.example:1','HTTPS_PROXY':'http://invalid.example:1','ALL_PROXY':'http://invalid.example:1'})
        self.assertEqual(reply.returncode,0,reply.stderr)
        value=json.loads(reply.stdout);self.assertGreater(value['pid'],0)
        self.assertTrue(all(type(v) is int and v>0 for v in value.values()))
        self.assertIn("agent:false,timeout:1000",R.INSPECTOR_NODE)
        self.assertNotIn('fetch(',R.INSPECTOR_NODE)
        self.assertIn("socket.close()",R.INSPECTOR_NODE)
        self.assertNotIn('node:inspector',R.INSPECTOR_NODE.split('finally{')[0])
        self.assertIn("if(connections()!==0)",R.INSPECTOR_NODE)
        self.assertIn("if(connections()!==1)",R.INSPECTOR_NODE)
        self.assertIn("Buffer.byteLength(event.data)>4096",R.INSPECTOR_NODE)
        self.assertIn("setTimeout(()=>reject(Error('deadline')),1500)",R.INSPECTOR_NODE)
        self.assertIn("if(await target()!==url||connections()!==1)",R.INSPECTOR_NODE)


    def test_actual_bounded_http_and_websocket_scalar_transport(self):
        # Real inspector HTTP/WS in our own tiny child; fixture substitutes the
        # ephemeral port/PID and Linux socket-table seam only. No live target.
        import re
        node=os.environ.get('RELEASE_RECOVERY_TEST_NODE', 'node')
        target=R.subprocess.Popen([node,'--input-type=module','-e',
            "import inspector from 'node:inspector';import readline from 'node:readline';console.log(JSON.stringify({ready:'fixture-ready',closed:inspector.url()===undefined}));readline.createInterface({input:process.stdin}).once('line',line=>{if(line!=='open')process.exit(2);inspector.open(0,'127.0.0.1');console.log(JSON.stringify({url:inspector.url(),pid:process.pid}));});"],
            stdin=R.subprocess.PIPE,stdout=R.subprocess.PIPE,stderr=R.subprocess.PIPE)
        def fixture_line(seconds):
            deadline=R.time.monotonic()+seconds
            out=bytearray();err=bytearray()
            with R.selectors.DefaultSelector() as selector:
                selector.register(target.stdout,R.selectors.EVENT_READ,'out')
                selector.register(target.stderr,R.selectors.EVENT_READ,'err')
                while R.time.monotonic()<deadline:
                    events=selector.select(max(0,deadline-R.time.monotonic()))
                    for key,_ in events:
                        chunk=os.read(key.fileobj.fileno(),4096)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            continue
                        selected=out if key.data=='out' else err
                        selected.extend(chunk)
                        self.assertLessEqual(len(selected),4096,'isolated fixture output bound')
                        if b'\n' in out:
                            line,extra=out.split(b'\n',1)
                            self.assertFalse(extra,'unexpected fixture output')
                            return json.loads(line)
                    if not selector.get_map():break
            self.fail('isolated fixture deadline/exit: '+str(target.poll())+' stderr='+err.decode(errors='replace'))
        try:
            self.assertEqual(fixture_line(5),{'ready':'fixture-ready','closed':True})
            target.stdin.write(b'open\n');target.stdin.flush()
            selected=fixture_line(2)
            port=int(selected['url'].split(':')[2].split('/')[0])
            source=R.INSPECTOR_NODE.replace(':9229',':'+str(port)).replace('v?.pid!==1','v?.pid!=='+str(selected['pid']))
            source=re.sub(r'const connections=\(\)=>\{.*?\n\};', 'let nativeConnectionReads=0;const connections=()=>Math.min(nativeConnectionReads++,1);',source,flags=re.S)
            digest=R.hashlib.sha256(selected['url'].encode()).hexdigest()
            reply=R.subprocess.run([node,'--no-inspect','--experimental-websocket','--input-type=module','-','read',digest],input=source.encode(),capture_output=True,timeout=5,
                env={**os.environ,'NODE_OPTIONS':'','HTTP_PROXY':'http://invalid.example:1','ALL_PROXY':'http://invalid.example:1'})
            self.assertEqual(reply.returncode,0,reply.stderr)
            value=json.loads(reply.stdout)
            self.assertEqual(value['state'],'owned');self.assertEqual(value['native']['pid'],selected['pid'])
            self.assertEqual(value['endpointSha256'],digest)
            self.assertGreater(value['native']['usedHeapBytes'],0)
            self.assertIsNone(target.poll(),'reader must not stop its target')
        finally:
            target.kill();target.wait(timeout=2);target.stdin.close();target.stdout.close();target.stderr.close()


    def retired(self):
        for suffix in ['.request','.intent']:(self.d/(REQUEST['runKey']+suffix)).unlink()
        directory=self.root/'engine-release-results';directory.mkdir()
        self.receipt=directory/(REQUEST['runKey']+'.json')
        self.failed={'schema':1,'runId':REQUEST['runKey'],'result':'failed','sha':REQUEST['releaseSha'],
            'controlSha':self.intent['controlSha'],'invocationId':'f'*32,'transactionExitStatus':1,
            'recoveredDesiredSha':R.EED,'recoveredDesiredImageId':self.identity['image'],'completedAt':int(self.intent['at'])+30}
        self.write_failed()
    def write_failed(self):
        self.receipt.write_text(json.dumps(self.failed));self.receipt.chmod(0o600)
    def test_retired_failure_preserves_original_closed_and_owned_read(self):
        self.retired()
        v,_=self.run_probe([{'state':'closed','endpointSha256':None}]);self.assertEqual(v['status'],'closed')
        v,_=self.run_probe([{'state':'open','endpointSha256':self.digest},{'state':'owned','endpointSha256':self.digest,'native':self.native}]);self.assertEqual(v['status'],'owned')
        self.assertNotIn('invocationId',json.dumps(v));self.assertNotIn('transactionExitStatus',json.dumps(v))
    def test_retired_missing_receipt_refuses_before_any_probe(self):
        self.retired();self.receipt.unlink()
        with patch.object(R,'inspector_probe') as probe,self.assertRaises(R.ScopedRefusal):R.remote(self.request)
        probe.assert_not_called()
    def test_retired_wrong_control_target_and_desired_refuse(self):
        self.retired()
        for key,value in [('controlSha','e'*40),('sha','e'*40),('runId','1-1'),('recoveredDesiredSha','e'*40),('result','sealed')]:
            original=dict(self.failed);self.failed[key]=value;self.write_failed()
            with patch.object(R,'inspector_probe') as probe,self.subTest(key=key),self.assertRaises(R.ScopedRefusal):R.remote(self.request)
            probe.assert_not_called();self.failed=original
    def test_retired_wrong_image_and_failure_metadata_refuse(self):
        self.retired()
        for key,value in [('recoveredDesiredImageId','sha256:'+'e'*64),('schema',True),('transactionExitStatus',0),('transactionExitStatus',True),('invocationId','bad'),('completedAt',self.intent['at']-1),('completedAt',4102444800),('raw','private')]:
            original=dict(self.failed);self.failed[key]=value;self.write_failed()
            with patch.object(R,'inspector_probe') as probe,self.subTest(key=key),self.assertRaises(R.ScopedRefusal):R.remote(self.request)
            probe.assert_not_called();self.failed=original
    def test_partial_request_records_never_fall_back_to_valid_failure(self):
        self.retired()
        for suffix in ['.request','.intent']:
            path=self.d/(REQUEST['runKey']+suffix);path.write_text('private invalid retained record');path.chmod(0o600)
            with patch.object(R,'inspector_probe') as probe,self.subTest(suffix=suffix),self.assertRaises(R.ScopedRefusal):R.remote(self.request)
            probe.assert_not_called();path.unlink()
    def test_changed_retired_receipt_invalidates_closed_observation(self):
        self.retired()
        def change(*args):
            self.failed['invocationId']='e'*32;self.write_failed()
            return {'state':'closed','endpointSha256':None}
        with patch.object(R,'inspector_command',side_effect=self.command),patch.object(R,'inspector_probe',side_effect=change),self.assertRaises(R.ScopedRefusal) as caught:R.remote(self.request)
        self.assertEqual(caught.exception.code,'identity_changed')
    def test_retired_receipt_permissions_symlinks_and_oversize_refuse(self):
        self.retired();self.receipt.chmod(0o644)
        with self.assertRaises(R.ScopedRefusal):R.remote(self.request)
        self.write_failed();self.receipt.write_text('x'*65537)
        with self.assertRaises(R.ScopedRefusal):R.remote(self.request)
        self.receipt.unlink();self.receipt.symlink_to(self.path)
        with self.assertRaises(R.ScopedRefusal):R.remote(self.request)




class PendingTcpTests(unittest.TestCase):
    def setUp(self):
        self.identity={'container':'c'*64,'image':'sha256:'+'d'*64,'running':'true',
            'startedAt':'2026-10-30T01:00:00.000Z','hostPid':'123','restarts':'0'}
        self.health={'source':'a'*40,'instance':'1-12345678'}

    def test_native_tcp_closed_and_listening_send_no_payload(self):
        import socket
        import threading
        node=os.environ.get('RELEASE_RECOVERY_TEST_NODE','node')
        with socket.socket() as listener:
            listener.bind(('127.0.0.1',0));port=listener.getsockname()[1]
        source=R.TCP_PRESENCE_NODE.replace('9229',str(port))
        reply=subprocess.run([node,'--input-type=module','-'],input=source.encode(),capture_output=True,timeout=5)
        self.assertEqual(reply.returncode,0,reply.stderr)
        self.assertEqual(json.loads(reply.stdout),{'state':'closed','code':'connection_refused'})
        received=[]
        with socket.socket() as listener:
            listener.bind(('127.0.0.1',0));listener.listen();listener.settimeout(3)
            port=listener.getsockname()[1]
            def accept():
                conn,_=listener.accept()
                with conn:
                    conn.settimeout(2);received.append(conn.recv(1))
            thread=threading.Thread(target=accept);thread.start()
            source=R.TCP_PRESENCE_NODE.replace('9229',str(port))
            reply=subprocess.run([node,'--input-type=module','-'],input=source.encode(),capture_output=True,timeout=5)
            thread.join(timeout=3)
            self.assertFalse(thread.is_alive())
        self.assertEqual(reply.returncode,0,reply.stderr)
        self.assertEqual(json.loads(reply.stdout),{'state':'listening','code':'connection_established'})
        self.assertEqual(received,[b''])
        for forbidden in ['node:inspector','Runtime.evaluate','WebSocket','node:http','socket.write','process.kill']:
            self.assertNotIn(forbidden,R.TCP_PRESENCE_NODE)

    def test_native_tcp_child_options_cannot_create_its_own_listener_or_load_preloads(self):
        import socket
        import threading
        node=os.environ.get('RELEASE_RECOVERY_TEST_NODE','node')
        with socket.socket() as closed:
            closed.bind(('127.0.0.1',0));port=closed.getsockname()[1]
        source=R.TCP_PRESENCE_NODE.replace('9229',str(port)).encode()
        inherited={**os.environ,'NODE_OPTIONS':'--inspect=127.0.0.1:'+str(port)}
        # Demonstrate the actual inherited-options counterexample in isolation.
        before=subprocess.run([node,'--input-type=module','-'],input=source,
            capture_output=True,env=inherited,timeout=5)
        self.assertEqual(before.returncode,0,before.stderr)
        self.assertIn(b'Debugger listening',before.stderr)
        self.assertEqual(json.loads(before.stdout)['state'],'listening')
        isolated={**inherited,'NODE_OPTIONS':''}
        after=subprocess.run([node,'--no-inspect','--input-type=module','-'],input=source,
            capture_output=True,env=isolated,timeout=5)
        self.assertEqual(after.returncode,0,after.stderr)
        self.assertNotIn(b'Debugger listening',after.stderr)
        self.assertEqual(json.loads(after.stdout),{'state':'closed','code':'connection_refused'})
        self.assertEqual(inherited['NODE_OPTIONS'],'--inspect=127.0.0.1:'+str(port))
        with tempfile.TemporaryDirectory(prefix='tcp-preload-',dir=ROOT.parent) as temp:
            marker=Path(temp)/'preload-ran';preload=Path(temp)/'preload.cjs'
            preload.write_text("require('node:fs').writeFileSync("+json.dumps(str(marker))+",'fixture');")
            inherited={**os.environ,'NODE_OPTIONS':'--require='+str(preload)}
            before=subprocess.run([node,'--input-type=module','-'],input=source,
                capture_output=True,env=inherited,timeout=5)
            self.assertEqual(before.returncode,0,before.stderr)
            self.assertEqual(marker.read_text(),'fixture');marker.unlink()
            after=subprocess.run([node,'--no-inspect','--input-type=module','-'],input=source,
                capture_output=True,env={**inherited,'NODE_OPTIONS':''},timeout=5)
            self.assertEqual(after.returncode,0,after.stderr)
            self.assertFalse(marker.exists(),'probe must not execute inherited preloads')
        # Clearing child options must still see a genuine, separate listener.
        received=[]
        with socket.socket() as listener:
            listener.bind(('127.0.0.1',0));listener.listen();listener.settimeout(3)
            port=listener.getsockname()[1]
            def accept():
                conn,_=listener.accept()
                with conn:conn.settimeout(2);received.append(conn.recv(1))
            thread=threading.Thread(target=accept);thread.start()
            after=subprocess.run([node,'--no-inspect','--input-type=module','-'],
                input=R.TCP_PRESENCE_NODE.replace('9229',str(port)).encode(),
                capture_output=True,env={**os.environ,'NODE_OPTIONS':''},timeout=5)
            thread.join(timeout=3);self.assertFalse(thread.is_alive())
        self.assertEqual(after.returncode,0,after.stderr)
        self.assertNotIn(b'Debugger listening',after.stderr)
        self.assertEqual(json.loads(after.stdout),{'state':'listening','code':'connection_established'})
        self.assertEqual(received,[b''])

    def run_bound_probe(self, probe, *, after=None, after_health=None, failure=None, owner='unknown', owner_error=None, expected_owner='unknown', include_evidence=False, expected_evidence=None):
        identity=' '.join(self.identity.values()).encode()
        health=json.dumps({'status':'ok','running':True,'releaseSha':self.health['source'],
            'version':self.health['source'][:8],'instanceId':self.health['instance']}).encode()
        rows=[identity,health,self.health['source'].encode(),json.dumps(probe).encode(),identity,health]
        if after is not None:rows[4]=' '.join(after.values()).encode()
        if after_health is not None:rows[5]=json.dumps(after_health).encode()
        if failure is not None:rows[failure[0]]=failure[1]
        with patch.object(R,'inspector_command',side_effect=rows) as native, \
                patch.object(R,'pending_socket_owner_details',return_value=(owner,kernel_evidence(owner)),side_effect=owner_error) as kernel:
            observed=R.pending_tcp_presence(include_owner_evidence=True) if include_evidence else R.pending_tcp_presence()
            answer,observed_owner=observed[:2]
            self.assertEqual(len(observed),3 if include_evidence else 2)
            if include_evidence:self.assertEqual(observed[2],expected_evidence)
        self.last_kernel_read=kernel
        self.assertEqual(observed_owner,expected_owner)
        if kernel.called:
            self.assertEqual(kernel.call_args.args,(self.identity,native.call_args_list[0].args[1]))
        self.assertNotIn(self.identity['container'],json.dumps(answer))
        self.assertNotIn('private',json.dumps(answer))
        return answer,native

    def test_kernel_role_uses_existing_tcp_deadline_and_never_survives_binding_change(self):
        probe={'state':'listening','code':'connection_established'}
        expected={'state':'listening','code':'connection_established','binding':'matched'}
        for role in ['main','other_container_process']:
            for include_evidence in [False,True]:
                answer,_=self.run_bound_probe(probe,owner=role,expected_owner=role,include_evidence=include_evidence,expected_evidence=kernel_evidence(role))
                self.assertEqual(answer,expected);self.last_kernel_read.assert_called_once()
        answer,_=self.run_bound_probe(probe,owner='main',after={**self.identity,'hostPid':'124'},include_evidence=True,expected_evidence={'stage':'not_observed','code':'tcp_unproved'})
        self.assertEqual(answer,{'state':'unknown','binding':'unproved','code':'identity_changed'})
        changed={'status':'ok','running':True,'releaseSha':self.health['source'],
            'version':self.health['source'][:8],'instanceId':'1-87654321'}
        answer,_=self.run_bound_probe(probe,owner='main',after_health=changed)
        self.assertEqual(answer['code'],'identity_changed')
        answer,_=self.run_bound_probe(probe,owner_error=PermissionError('private proc path'),include_evidence=True,expected_evidence={'stage':'snapshot','code':'unavailable'})
        self.assertEqual(answer,expected)
        answer,_=self.run_bound_probe({'state':'closed','code':'connection_refused'},owner='main',include_evidence=True,expected_evidence={'stage':'not_observed','code':'not_listening'})
        self.assertEqual(answer['state'],'closed');self.last_kernel_read.assert_not_called()

    def test_tcp_binds_current_runtime_before_and_after_without_legacy_intent(self):
        for state,code in [('closed','connection_refused'),('listening','connection_established')]:
            answer,native=self.run_bound_probe({'state':state,'code':code})
            self.assertEqual(answer,{'state':state,'code':code,'binding':'matched'})
            self.assertEqual(native.call_count,6)
            calls=native.call_args_list
            self.assertEqual(calls[3].args[0],['docker','exec','-i','-e','NODE_OPTIONS=',self.identity['container'],'node','--no-inspect','--input-type=module','-'])
            self.assertEqual(calls[3].kwargs['input_bytes'],R.TCP_PRESENCE_NODE.encode())
            shared=[call.args[1] for call in calls if call is not calls[3]]
            self.assertTrue(all(value==shared[0] for value in shared))
            self.assertLessEqual(calls[3].args[1],shared[0])
        for key,value in [('container','e'*64),('image','sha256:'+'f'*64),('hostPid','124'),('restarts','1')]:
            answer,_=self.run_bound_probe({'state':'closed','code':'connection_refused'},after={**self.identity,key:value})
            self.assertEqual(answer,{'state':'unknown','binding':'unproved','code':'identity_changed'})
        changed={'status':'ok','running':True,'releaseSha':self.health['source'],
            'version':self.health['source'][:8],'instanceId':'1-87654321'}
        answer,_=self.run_bound_probe({'state':'closed','code':'connection_refused'},after_health=changed)
        self.assertEqual(answer['code'],'identity_changed')

    def test_tcp_native_startup_failure_deadline_and_bad_health_stay_unknown(self):
        for error,code in [(ValueError('Inspector read deadline'),'command_deadline'),
                           (ValueError('Inspector read size'),'command_size'),
                           (ValueError('Inspector native unavailable'),'command_nonzero')]:
            answer,_=self.run_bound_probe({'state':'closed','code':'connection_refused'},failure=(3,error))
            self.assertEqual(answer,{'state':'unknown','binding':'unproved','code':code})
        for index,bad,code in [(0,b'private unknown','container_unproved'),
                               (1,b'{"running":true}','health_unproved'),
                               (2,b'private wrong image','image_unproved'),
                               (3,b'{"state":"closed","code":"private"}','probe_unproved')]:
            answer,_=self.run_bound_probe({'state':'closed','code':'connection_refused'},failure=(index,bad))
            self.assertEqual(answer,{'state':'unknown','binding':'unproved','code':code})

    def test_tcp_schema_rejects_false_binding_private_fields_and_future_codes(self):
        for value in [
            {'state':'closed','binding':'unproved','code':'connection_refused'},
            {'state':'unknown','binding':'matched','code':'probe_unproved'},
            {'state':'listening','binding':'matched','code':'connection_refused'},
            {'state':'unknown','binding':'unproved','code':'secret error'},
            {'state':'closed','binding':'matched','code':'connection_refused','container':'private'}]:
            with self.subTest(value=value),self.assertRaises(ValueError):R.validate_pending_tcp(value)
        for state,code in [('closed','connection_refused'),('listening','connection_established')]:
            R.validate_pending_tcp({'state':state,'binding':'matched','code':code})
        R.validate_pending_tcp({'state':'unknown','binding':'unproved','code':'not_read'})



class KernelOwnerTests(unittest.TestCase):
    def setUp(self):
        self.identity={'container':'c'*64,'hostPid':'123'}
        self.deadline=R.time.monotonic()+3
        self.snapshot={'members':('123','124'),'processes':(('123','10'),('124','20')),
            'namespace':'net:[123456]','inode':'456789','owners':('123',)}

    def test_kernel_docker_top_accepts_only_bounded_unique_pid_membership(self):
        with patch.object(R,'inspector_command',return_value=b'PID\n124\n123\n') as native:
            self.assertEqual(R._kernel_members(self.identity,self.deadline),('123','124'))
        self.assertEqual(native.call_args.args,(['docker','top','c'*64,'-eo','pid'],self.deadline))
        self.assertEqual(native.call_args.kwargs,{'limit':4096})
        for data in [b'PID COMMAND\n123 private\n',b'PID\n124\n',b'PID\n123\n123\n',
                     b'PID\n0\n123\n',b'PID\n123\n-2\n',b'PID\n123\n124 extra\n',
                     ('PID\n'+'\n'.join(str(i) for i in range(1,258))).encode()]:
            with self.subTest(data=data[:30]),patch.object(R,'inspector_command',return_value=data),self.assertRaises(ValueError):
                R._kernel_members(self.identity,self.deadline)

    def test_kernel_native_file_bound_symlink_and_expired_deadline(self):
        with tempfile.TemporaryDirectory(prefix='kernel-owner-file-',dir=ROOT.parent) as temp:
            path=Path(temp)/'fixed';path.write_bytes(b'12345678')
            self.assertEqual(R._kernel_read(path,8,self.deadline),b'12345678')
            path.write_bytes(b'123456789')
            with self.assertRaises(ValueError):R._kernel_read(path,8,self.deadline)
            link=Path(temp)/'linked';link.symlink_to(path)
            with self.assertRaises(OSError):R._kernel_read(link,8,self.deadline)
            with patch.object(R.os,'open') as opened,self.assertRaises(ValueError):
                R._kernel_read(path,8,R.time.monotonic()-1)
            opened.assert_not_called()

    def test_kernel_stat_starttime_handles_private_comm_without_export(self):
        record=('123 (private ) comm (name)) S '+' '.join(['0']*18+['98765']+['0']*30)).encode()
        with patch.object(R,'_kernel_read',return_value=record) as read:
            self.assertEqual(R._kernel_pid_stat('123',self.deadline),'98765')
        self.assertEqual(read.call_args.args,(R.KERNEL_PROC_ROOT/'123'/'stat',4096,self.deadline))
        # Linux emits opaque comm bytes; only the numeric suffix is ASCII.
        for comm in [b'n\xc3\xb8de',b'private \xff ) name (']:
            record=b'123 ('+comm+b') S '+b' '.join([b'0']*18+[b'98765']+[b'0']*30)
            with self.subTest(comm=comm),patch.object(R,'_kernel_read',return_value=record):
                self.assertEqual(R._kernel_pid_stat('123',self.deadline),'98765')
        for pid in ['../123','0','123/private','-1']:
            with self.subTest(pid=pid),patch.object(R,'_kernel_read') as read,self.assertRaises(ValueError):
                R._kernel_pid_stat(pid,self.deadline)
            read.assert_not_called()
        for record in [b'124 (private) S '+b'0 '*18+b'98765',b'123 (private) S 0',
                       b'123 (private) S '+b'0 '*18+b'private']:
            with patch.object(R,'_kernel_read',return_value=record),self.assertRaises(ValueError):
                R._kernel_pid_stat('123',self.deadline)

    @staticmethod
    def socket_table(*rows):
        return ('sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n'+''.join(
            '0: 0100007F:%04X 00000000:0000 %s 00000000:00000000 00:00000000 00000000 1000 0 %s\n'%row
            for row in rows)).encode()

    def test_kernel_listener_is_fixed_port_listen_only_and_exclusive_inode(self):
        empty=self.socket_table()
        with patch.object(R,'_kernel_read',side_effect=[self.socket_table((9228,'0A','7'),(9229,'01','8'),(9229,'0A','9')),empty]) as read:
            self.assertEqual(R._kernel_listeners('123',self.deadline),'9')
        self.assertEqual([call.args[0] for call in read.call_args_list],
            [R.KERNEL_PROC_ROOT/'123'/'net'/'tcp',R.KERNEL_PROC_ROOT/'123'/'net'/'tcp6'])
        for first,second in [(empty,empty),
            (self.socket_table((9229,'0A','9'),(9229,'0A','10')),empty),
            (self.socket_table((9229,'0A','9')),self.socket_table((9229,'0A','10'))),
            (self.socket_table((9229,'0A','0')),empty),
            (b'private malformed',empty),
            (self.socket_table(*[(9229,'0A',str(i)) for i in range(1,11)]),empty)]:
            with patch.object(R,'_kernel_read',side_effect=[first,second]),self.assertRaises(ValueError):
                R._kernel_listeners('123',self.deadline)

    def test_kernel_two_snapshots_bind_owner_and_refuse_race_permission_or_deadline(self):
        with patch.object(R.sys,'platform','linux'):
            for owners,expected in [(('123',),'main'),(('124',),'other_container_process')]:
                snapshot={**self.snapshot,'owners':owners}
                with patch.object(R,'_socket_owner_snapshot',return_value=snapshot) as read:
                    result,evidence=R.pending_socket_owner_details(self.identity,self.deadline)
                self.assertEqual(result,expected);self.assertEqual(evidence,kernel_evidence(expected));self.assertEqual(read.call_count,2)
                self.assertNotIn('123',json.dumps(result));self.assertNotIn('private',json.dumps(result))
            for changed in [{'members':('123','125')},{'processes':(('123','11'),('124','20'))},
                            {'namespace':'net:[999]'},{'inode':'456790'},{'owners':('124',)}]:
                with self.subTest(changed=changed),patch.object(R,'_socket_owner_snapshot',side_effect=[self.snapshot,{**self.snapshot,**changed}]):
                    self.assertEqual(R.pending_socket_owner_details(self.identity,self.deadline),('unknown',{'stage':'snapshot','code':'changed'}))
            for error,code in [(PermissionError('private path'),'permission_denied'),(FileNotFoundError('private process'),'changed'),(ValueError('private overflow'),'unproved'),
                          (subprocess.TimeoutExpired(['private'],1),'deadline')]:
                with patch.object(R,'_socket_owner_snapshot',side_effect=error):
                    self.assertEqual(R.pending_socket_owner_details(self.identity,self.deadline),('unknown',{'stage':'snapshot','code':code}))
            with patch.object(R,'_socket_owner_snapshot',return_value=self.snapshot):
                self.assertEqual(R.pending_socket_owner_details(self.identity,R.time.monotonic()-1),('unknown',{'stage':'snapshot','code':'deadline'}))
        with patch.object(R.sys,'platform','darwin'),patch.object(R,'_socket_owner_snapshot') as read:
            self.assertEqual(R.pending_socket_owner_details(self.identity,self.deadline),('unknown',{'stage':'identity','code':'unsupported'}))
        read.assert_not_called()
        with patch.object(R.sys,'platform','linux'),patch.object(R,'_socket_owner_snapshot') as read:
            self.assertEqual(R.pending_socket_owner_details({},self.deadline),('unknown',{'stage':'identity','code':'unproved'}))
        read.assert_not_called()
        with patch.object(R,'pending_socket_owner_details',return_value=('main',kernel_evidence('main'))):
            self.assertEqual(R.pending_socket_owner(self.identity,self.deadline),'main')

    def test_kernel_wire_role_requires_matched_listening_and_never_accepts_private_fields(self):
        listening={'state':'listening','binding':'matched','code':'connection_established'}
        for role in ['main','other_container_process','unknown']:R.validate_pending_owner(role,listening)
        for role in ['123',{'pid':123},True,None,'foreign/private']:
            with self.subTest(role=role),self.assertRaises(ValueError):R.validate_pending_owner(role,listening)
        for tcp in [{'state':'closed','binding':'matched','code':'connection_refused'},
                    {'state':'unknown','binding':'unproved','code':'probe_unproved'}]:
            R.validate_pending_owner('unknown',tcp)
            for role in ['main','other_container_process']:
                with self.assertRaises(ValueError):R.validate_pending_owner(role,tcp)
        for owner in ['main','other_container_process']:
            self.assertEqual(R.validate_kernel_owner_evidence(kernel_evidence(owner),owner),kernel_evidence(owner))
        for stage in ['identity','members','process_stat','namespace','listeners','descriptors','recheck_process','recheck_members','recheck_listeners','snapshot']:
            evidence={'stage':stage,'code':'unproved'}
            self.assertEqual(R.validate_kernel_owner_evidence(evidence,'unknown'),evidence)
        unread={'stage':'not_observed','code':'not_read'}
        self.assertEqual(R.validate_kernel_owner_evidence(unread,'unknown',allow_not_observed=True),unread)
        for value,owner in [(None,'unknown'),({},'unknown'),({'stage':'private','code':'unproved'},'unknown'),
                ({'stage':'snapshot','code':'private'},'unknown'),({'stage':'snapshot','code':'unproved','pid':123},'unknown'),
                ({'stage':True,'code':'unproved'},'unknown'),(kernel_evidence('main'),'unknown'),
                (kernel_evidence(),'main'),(unread,'unknown'),({'stage':'snapshot','code':'not_read'},'unknown')]:
            with self.subTest(value=value,owner=owner),self.assertRaises(ValueError):
                R.validate_kernel_owner_evidence(value,owner)
        self.assertEqual(R.PENDING_SCHEMA,'existing-release-pending-observation/v6')

    def test_kernel_snapshot_bounds_shared_unmapped_descriptors_and_process_races(self):
        # Native Linux components below exercise /proc; these finite adversarial
        # records qualify refusal branches without touching this host's processes.
        def run(*,fd_targets=('socket:[456789]',),names=('3',),stats=('10','20','10','20'),
                members=(('123','124'),('123','124')),listeners=('456789','456789'),networks=('net:[123456]','net:[123456]'),end_networks=None,other_targets=(),budget=None,details=False):
            entries=[types.SimpleNamespace(name=name,path='/private/'+name) for name in names]
            with patch.object(R,'_kernel_members',side_effect=members), \
                    patch.object(R,'_kernel_pid_stat',side_effect=stats), \
                    patch.object(R,'_kernel_listeners',side_effect=listeners), \
                    patch.object(R.os,'readlink',side_effect=[*networks,*fd_targets,*other_targets,*(end_networks or networks)]), \
                    patch.object(R.os,'scandir',side_effect=[contextlib.nullcontext(iter(entries)),contextlib.nullcontext(iter([types.SimpleNamespace(name=str(i+8),path='/private/other'+str(i)) for i in range(len(other_targets))]))]):
                if details:
                    with patch.object(R.sys,'platform','linux'):
                        return R.pending_socket_owner_details(self.identity,self.deadline)
                return R._socket_owner_snapshot(self.identity,self.deadline,budget)
        self.assertEqual(run()['owners'],('123',))
        shared_budget={'fds':16383}
        self.assertEqual(run(budget=shared_budget)['owners'],('123',))
        self.assertEqual(shared_budget['fds'],16384)
        with self.assertRaises(ValueError):run(budget=shared_budget)
        for kwargs in [dict(fd_targets=('socket:[999]',)),dict(names=('private',)),
                       dict(fd_targets=(PermissionError('private'),)),
                       dict(stats=('10','20','11','20')),dict(members=(('123','124'),('123',))),
                       dict(listeners=('456789','999')),dict(networks=('net:[123456]','net:[999]')),
                       dict(end_networks=('net:[123456]','net:[999]')),dict(other_targets=('socket:[456789]',))]:
            with self.subTest(kwargs=str(kwargs)),self.assertRaises((OSError,ValueError)):
                run(**kwargs)
        reasons=[
            (dict(members=(PermissionError('private'),)),'members','permission_denied'),
            (dict(members=(ValueError('Inspector native unavailable'),)),'members','command_failed'),
            (dict(members=(ValueError('Inspector read deadline'),)),'members','deadline'),
            (dict(members=(ValueError('Inspector read size'),)),'members','bound'),
            (dict(stats=(UnicodeDecodeError('ascii',b'\xff',0,1,'private'),)),'process_stat','invalid_encoding'),
            (dict(networks=(PermissionError('private'),)),'namespace','permission_denied'),
            (dict(listeners=(ValueError('Kernel owner file bound'),)),'listeners','bound'),
            (dict(fd_targets=(FileNotFoundError('private'),)),'descriptors','changed'),
            (dict(fd_targets=('x'*4097,)),'descriptors','bound'),
            (dict(fd_targets=('socket:[999]',)),'descriptors','ambiguous'),
            (dict(stats=('10','20','11','20')),'recheck_process','changed'),
            (dict(end_networks=('net:[123456]','net:[999]')),'recheck_process','changed'),
            (dict(members=(('123','124'),('123',))),'recheck_members','changed'),
            (dict(listeners=('456789','999')),'recheck_listeners','changed'),
            (dict(other_targets=('socket:[456789]',)),'descriptors','ambiguous')]
        for kwargs,stage,code in reasons:
            with self.subTest(stage=stage,code=code):
                result=run(**kwargs,details=True)
                self.assertEqual(result,('unknown',{'stage':stage,'code':code}))
                self.assertNotIn('private',json.dumps(result))
        entries=(types.SimpleNamespace(name=str(i),path='/private/'+str(i)) for i in range(16385))
        with patch.object(R,'_kernel_members',return_value=('123',)), \
                patch.object(R,'_kernel_pid_stat',return_value='10'), \
                patch.object(R,'_kernel_listeners',return_value='456789'), \
                patch.object(R.os,'readlink',side_effect=lambda path:'net:[123456]' if str(path).endswith('/ns/net') else '/private/ignored'), \
                patch.object(R.os,'scandir',return_value=contextlib.nullcontext(entries)),self.assertRaises(ValueError):
            R._socket_owner_snapshot(self.identity,self.deadline)


@unittest.skipUnless(R.sys.platform=='linux','actual Linux proc/socket qualification required; unavailable on Mac')
class LinuxKernelOwnerTests(unittest.TestCase):
    # Owned fork fixtures only. The Docker-top boundary supplies exactly the
    # fixture members; socket tables, stat, namespaces and descriptor links are
    # read from the real Linux kernel by the maintained implementation.
    FIXTURE=r"""
import ctypes,json,os,signal,socket,sys
role=sys.argv[1]
opaque_comm=len(sys.argv)>2 and sys.argv[2]=='opaque'
srv=None;child=None;control=None;ack=None;port=None
try:
 if role in ('main','shared'):
  srv=socket.socket();srv.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);srv.bind(('127.0.0.1',0));srv.listen();port=srv.getsockname()[1]
 if role in ('other','shared'):
  read,write=os.pipe();ready_read,ready_write=os.pipe();child=os.fork()
  if child==0:
   os.close(write);os.close(ready_read)
   saved_name=None;prctl=None
   try:
    if opaque_comm:
     prctl=ctypes.CDLL(None,use_errno=True).prctl
     prctl.argtypes=[ctypes.c_int,ctypes.c_void_p,ctypes.c_ulong,ctypes.c_ulong,ctypes.c_ulong]
     prctl.restype=ctypes.c_int
     previous=ctypes.create_string_buffer(16)
     if prctl(16,previous,0,0,0)!=0:raise RuntimeError('owned fixture comm read unavailable')
     saved_name=previous
     own_name=ctypes.create_string_buffer(b'own-\xc3\xb8-\xff')
     if prctl(15,own_name,0,0,0)!=0:raise RuntimeError('owned fixture comm change unavailable')
    if role=='other':
     srv=socket.socket();srv.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);srv.bind(('127.0.0.1',0));srv.listen();port=srv.getsockname()[1]
    os.write(ready_write,(str(port)+'\n').encode());os.close(ready_write)
    while True:
     command=os.read(read,1)
     if command in (b'',b'q'):break
     if command==b'c':
      srv.close();srv=None
      os.write(1,b'{"childClosed":true}\n')
   finally:
    # Only this owned child changes its comm, and restores it before exit.
    if saved_name is not None and prctl(15,saved_name,0,0,0)!=0:
     raise RuntimeError('owned fixture comm restore unavailable')
   os._exit(0)
  os.close(read);os.close(ready_write);control=write
  raw=b''
  while not raw.endswith(b'\n'):raw+=os.read(ready_read,32)
  os.close(ready_read);port=int(raw)
 print(json.dumps({'main':os.getpid(),'child':child,'port':port}),flush=True)
 for line in sys.stdin:
  if line.strip()=='quit':break
  if line.strip() in ('close','replace'):
   if child:raise RuntimeError('commands are main fixture only')
   if srv:srv.close();srv=None
   if line.strip()=='replace':
    srv=socket.socket();srv.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);srv.bind(('127.0.0.1',port));srv.listen()
   print(json.dumps({'replaced':True} if srv else {'closed':True}),flush=True)
finally:
 if child:
  os.write(control,b'q');os.close(control);os.waitpid(child,0)
 if srv:srv.close()
"""

    @contextlib.contextmanager
    def fixture(self,role,opaque_comm=False):
        import signal
        child=subprocess.Popen([R.sys.executable,'-u','-c',self.FIXTURE,role,'opaque' if opaque_comm else 'plain'],
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
        def line():
            deadline=R.time.monotonic()+5;data=bytearray()
            with R.selectors.DefaultSelector() as selector:
                selector.register(child.stdout,R.selectors.EVENT_READ)
                while R.time.monotonic()<deadline:
                    if not selector.select(max(0,deadline-R.time.monotonic())):break
                    part=os.read(child.stdout.fileno(),4096)
                    if not part:break
                    data.extend(part);self.assertLessEqual(len(data),4096)
                    if b'\n' in data:
                        raw,extra=data.split(b'\n',1);self.assertFalse(extra)
                        return json.loads(raw)
            self.fail('owned Linux fixture readiness deadline; exit='+str(child.poll()))
        try:
            ready=line();main=str(ready['main']);members=tuple(str(pid) for pid in [ready['main'],ready['child']] if pid)
            identity={'container':'c'*64,'hostPid':main}
            with patch.object(R,'_kernel_members',return_value=tuple(sorted(members,key=int))), \
                    patch.object(R,'KERNEL_INSPECTOR_PORT',ready['port']):
                yield identity,child,line
        finally:
            if child.poll() is None:
                child.stdin.write(b'quit\n');child.stdin.flush()
                try:child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    # Fault cleanup may only kill this isolated fixture group.
                    os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=2)
            child.stdin.close();child.stdout.close();child.stderr.close()

    def test_real_linux_serving_wrapper_uses_actual_proc_socket_role(self):
        # Docker/health are explicit metadata seams; actual owned process,
        # socket, proc stat/ns/net/FD joins and two snapshots stay native.
        with self.fixture('main') as (owned,_,__):
            identity={**owned,'image':'sha256:'+'d'*64,'running':'true',
                'startedAt':'2026-10-30T01:00:00.000Z','restarts':'0'}
            request={'mode':'current_serving_inspector_role','releaseSha':R.EED,'instanceId':'1-12345678'}
            with patch.object(R,'inspector_identity',return_value=identity), \
                    patch.object(R,'pending_tcp_health',return_value={'source':R.EED,'instance':request['instanceId']}), \
                    patch.object(R,'inspector_command',return_value=(R.EED+'\n').encode()), \
                    patch.object(R,'pending_tcp_presence',side_effect=AssertionError('TCP forbidden')):
                answer=R.remote(request)
            self.assertEqual(answer['inspectorOwner'],'main')
            self.assertEqual(R.validate_reply(answer,request),answer)
            self.assertEqual(set(answer), {'schema','readOnly','mode','releaseSha',
                'instanceId','inspectorOwner','inspectorOwnerEvidence','limitation'})
            self.assertNotIn('hostPid',answer)
            self.assertNotIn('container',answer)

    def test_real_linux_main_and_child_listener_roles(self):
        for fixture,expected,opaque in [('main','main',False),
                                       ('other','other_container_process',False),
                                       ('other','other_container_process',True)]:
            with self.subTest(role=fixture,opaque_comm=opaque),self.fixture(fixture,opaque) as (identity,_,__):
                role,evidence=R.pending_socket_owner_details(identity,R.time.monotonic()+3)
                self.assertEqual(role,expected)
                self.assertEqual(evidence,{'stage':'complete','code':'exclusive'})
                self.assertNotIn(identity['hostPid'],json.dumps((role,evidence)))
                self.assertNotIn('own-',json.dumps((role,evidence)))

    def test_real_linux_shared_parent_child_descriptor_is_unknown(self):
        with self.fixture('shared') as (identity,_,__):
            self.assertEqual(R.pending_socket_owner(identity,R.time.monotonic()+3),'unknown')

    def test_real_linux_disappearing_and_replaced_listener_between_snapshots_is_unknown(self):
        for command,ack in [(b'close\n',{'closed':True}),(b'replace\n',{'replaced':True})]:
            with self.subTest(command=command),self.fixture('main') as (identity,child,line):
                original=R._socket_owner_snapshot
                calls=0
                def snapshot(*args):
                    nonlocal calls
                    calls+=1;value=original(*args)
                    if calls==1:
                        child.stdin.write(command);child.stdin.flush()
                        self.assertEqual(line(),ack)
                    return value
                with patch.object(R,'_socket_owner_snapshot',side_effect=snapshot):
                    self.assertEqual(R.pending_socket_owner(identity,R.time.monotonic()+3),'unknown')
                self.assertEqual(calls,2)



class MainRetirementRecordTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='retirement-files-', dir=ROOT.parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.requests = self.root / 'engine-release-requests'; self.requests.mkdir()
        self.results = self.root / 'engine-release-results'; self.results.mkdir()
        self.request = dict(REQUEST, mode='main_inspector_retirement')
        self.control = 'b' * 40
        self.rows = [REQUEST['releaseSha'], 'https://github.com/Smarter-Software-PIQ/Smarter-Poker-Club-Arena/actions/runs/' + REQUEST['runKey'].split('-')[0],
                     'fixture private actor', '/usr/local/lib/club-arena/engine-control-generations/' + self.control,
                     self.control, '1793389999']
        self.proposal = {'schema':'main-inspector-retirement/v1',
            'endpoint':'ws://127.0.0.1:9229/12345678-1234-1234-1234-123456789abc',
            'binding':{'schema':'main-inspector-socket-binding/v1','pid':1,'startTicks':'123',
                'namespace':'net:[44]','listener':{'family':'tcp','local':'0100007F:240D','inode':'555'}}}
        self.claim = {'schema':'main-inspector-retirement-claim/v1','runId':REQUEST['runKey'],
            'invocationId':'c'*32,'controlSha':self.control,'requestDeadline':1793389999,
            'target':REQUEST['releaseSha'],'requestSha256':R.hashlib.sha256(('\n'.join(self.rows)+'\n').encode()).hexdigest(),
            'nativeUnit':{'InvocationID':'c'*32,'ActiveState':'activating','SubState':'start'},
            'source':R.EED,'instance':'1-a474c9ca','containerIdentity':'d'*64+' '+R.RETIREMENT_IMAGE+' true 2026-10-30T13:38:28.940Z 12345',
            'proposal':self.proposal,'proposalSha256':R.hashlib.sha256(json.dumps(self.proposal,separators=(',',':')).encode()).hexdigest(),
            'deadlineMs':1793389900000,'retryAllowed':False}
        self.outcome = dict.fromkeys(R.RETIREMENT_PREDICATES,True)
        self.outcome.update(stage='complete',reason='native_close_observed',retryAllowed=False)
        self.failed = {'schema':1,'runId':REQUEST['runKey'],'result':'failed','sha':REQUEST['releaseSha'],
            'controlSha':self.control,'invocationId':'c'*32,'transactionExitStatus':1,
            'recoveredDesiredSha':R.EED,'recoveredDesiredImageId':R.RETIREMENT_IMAGE,'completedAt':1793389910}
        self.patch = patch.object(R,'STATE_ROOT',self.root);self.patch.start();self.addCleanup(self.patch.stop)
        # Actual filesystem IO remains native; only root UID metadata is mapped
        # for unprivileged Mac/hosted test users. Production always requires UID0.
        self.fstat = os.fstat
        def owned(fd):
            value = list(self.fstat(fd));value[4] = 0
            return os.stat_result(value)
        self.owner = patch.object(R.os,'fstat',side_effect=owned);self.owner.start();self.addCleanup(self.owner.stop)
        for name in ['pending_remote','inspector_remote','serving_role_remote','pending_tcp_presence',
                     'pending_socket_owner_details','inspector_command','pending_unit','pending_journal']:
            p = patch.object(R,name,side_effect=AssertionError('pure file mode cannot call '+name));p.start();self.addCleanup(p.stop)

    def write(self, name, value, result=False):
        path = (self.results if result else self.requests) / (REQUEST['runKey']+name)
        path.write_text(value if isinstance(value,str) else json.dumps(value));path.chmod(0o600)
        return path

    def bind(self, terminal=True):
        if terminal:self.write('.json',self.failed,True)
        else:
            for suffix in ('.request','.intent'):self.write(suffix,'\n'.join(self.rows)+'\n')

    def records(self):
        self.write('.main-inspector-retirement-intent',self.claim)
        self.write('.main-inspector-retirement-receipt',{'claim':self.claim,'outcome':self.outcome,'observedAt':1793389901.5})

    def read(self):
        value=R.remote(self.request)
        self.assertEqual(R.validate_reply(value,self.request),value)
        return value

    def test_mode_admits_only_exact_run_source_and_closed_selector(self):
        self.assertEqual(R.selection(self.request),self.request)
        for bad in [dict(self.request,path='/etc/passwd'),dict(self.request,instanceId='1-a474c9ca'),
                    dict(self.request,runKey='../run'),dict(self.request,releaseSha='x'*40),
                    {'mode':'main_inspector_retirement'}]:
            with self.subTest(bad=bad),self.assertRaises(ValueError):R.selection(bad)

    def test_terminal_binding_distinguishes_actual_absence_without_action_authority(self):
        self.bind();value=self.read()
        self.assertEqual(value['status'],'both_absent_at_read')
        self.assertEqual(value['intentPresence'],'absent_at_read')
        self.assertEqual(value['bindingKind'],'terminal_failure')
        self.assertFalse(value['positiveReceipt']);self.assertFalse(value['retryAllowed'])
        self.assertIsNone(value['claimIdentity'])

    def test_native_actual_files_bind_success_and_drop_every_private_identity(self):
        for terminal in (True,False):
            with self.subTest(terminal=terminal):
                self.bind(terminal);self.records();value=self.read()
                self.assertTrue(value['positiveReceipt']);self.assertTrue(value['receiptMatchesClaim'])
                self.assertEqual(value['status'],'bound_positive_historical_receipt')
                self.assertEqual(value['claimIdentity']['proposalSha256'],self.claim['proposalSha256'])
                for secret in [self.proposal['endpoint'],'fixture private actor','/usr/local/',self.claim['containerIdentity'],'12345','net:[44]']:
                    self.assertNotIn(secret,json.dumps(value))
                for path in self.requests.iterdir():path.unlink()
        self.proposal['binding']['listener'].update(family='tcp6',local='00000000000000000000000001000000:240D')
        self.claim['proposalSha256']=R.hashlib.sha256(json.dumps(self.proposal,separators=(',',':')).encode()).hexdigest()
        self.bind();self.records();self.assertTrue(self.read()['positiveReceipt'])

    def test_partial_negative_and_mismatched_receipts_stay_unknown(self):
        self.bind();intent=self.write('.main-inspector-retirement-intent',self.claim)
        value=self.read();self.assertEqual(value['status'],'unknown');self.assertIsNotNone(value['claimIdentity'])
        self.outcome['ok']=False;self.records();value=self.read()
        self.assertEqual(value['status'],'unknown');self.assertFalse(value['positiveReceipt'])
        self.assertFalse(value['outcomePredicates']['ok'])
        wrong=dict(self.claim,controlSha='e'*40)
        self.write('.main-inspector-retirement-receipt',{'claim':wrong,'outcome':self.outcome,'observedAt':1793389901})
        self.assertFalse(self.read()['receiptMatchesClaim'])
        intent.unlink();self.assertEqual(self.read()['status'],'unknown')

    def test_binding_is_required_even_when_both_retirement_files_are_absent(self):
        self.assertEqual(self.read()['status'],'unknown')
        self.bind();bad=dict(self.failed,invocationId='not-an-invocation')
        self.write('.json',bad,True);self.assertEqual(self.read()['status'],'unknown')
        self.write('.request','\n'.join(self.rows)+'\n')
        self.assertIsNone(self.read()['bindingKind'])

    def test_unsafe_file_metadata_json_bounds_and_symlinks_are_not_absence(self):
        self.bind();path=self.write('.main-inspector-retirement-intent',self.claim)
        path.chmod(0o644);self.assertEqual(self.read()['intentPresence'],'unknown')
        path.chmod(0o600);path.write_text('x'*32769);self.assertEqual(self.read()['intentPresence'],'unknown')
        path.unlink();path.symlink_to(self.results/(REQUEST['runKey']+'.json'))
        self.assertEqual(self.read()['intentPresence'],'unknown')
        path.unlink();self.write('.main-inspector-retirement-intent','{broken')
        self.assertEqual(self.read()['status'],'unknown')
        self.owner.stop()
        # On unprivileged test users actual UID is rejected; no root impersonation.
        if os.geteuid()!=0:self.assertEqual(self.read()['intentPresence'],'unknown')
        self.owner.start()
        self.records()
        loads=R.json.loads
        changed=False
        def change_after_snapshot(raw,*args,**kwargs):
            nonlocal changed
            if not changed and isinstance(raw,bytes) and b'main-inspector-retirement-claim/v1' in raw:
                changed=True
                self.write('.main-inspector-retirement-intent',dict(self.claim,instance='1-87654321'))
            return loads(raw,*args,**kwargs)
        with patch.object(R.json,'loads',side_effect=change_after_snapshot):value=self.read()
        self.assertTrue(changed);self.assertEqual(value['status'],'unknown')
        self.assertIsNone(value['claimIdentity']);self.assertIsNone(value['bindingKind'])
        self.assertEqual(value['intentPresence'],'unknown')

    def test_exact_terminal_and_claim_identity_mismatch_never_export_claim(self):
        self.bind();self.records()
        for field,bad in [('runId','999-1'),('target','e'*40),('controlSha','e'*40),
                          ('invocationId','e'*32),('source','e'*40),('proposalSha256','0'*64),
                          ('containerIdentity','private invalid identity')]:
            claim=dict(self.claim,**{field:bad});self.write('.main-inspector-retirement-intent',claim)
            with self.subTest(field=field):self.assertIsNone(self.read()['claimIdentity'])
        self.write('.main-inspector-retirement-intent',self.claim)
        self.write('.json',dict(self.failed,sha='e'*40),True)
        self.assertEqual(self.read()['status'],'unknown')
        self.write('.json',self.failed,True)
        for observed in ['private time',float('nan'),float('inf'),self.claim['requestDeadline']+1,self.failed['completedAt']+1]:
            self.write('.main-inspector-retirement-receipt',{'claim':self.claim,'outcome':self.outcome,'observedAt':observed})
            with self.subTest(observed=observed):self.assertFalse(self.read()['positiveReceipt'])
        # Integer terminal timestamps represent a whole recorded second.
        self.write('.main-inspector-retirement-receipt',{'claim':self.claim,'outcome':self.outcome,'observedAt':self.failed['completedAt']+0.5})
        self.assertTrue(self.read()['positiveReceipt'])
        (self.results/(REQUEST['runKey']+'.json')).unlink()
        self.bind(False);self.records();bad=dict(self.claim,requestDeadline=self.claim['requestDeadline']-1)
        self.write('.main-inspector-retirement-intent',bad)
        self.assertIsNone(self.read()['claimIdentity'])

    def test_export_validator_rejects_authority_extra_fields_and_fabricated_positive(self):
        self.bind();value=self.read()
        for bad in [dict(value,retryAllowed=True),dict(value,endpoint=self.proposal['endpoint']),
                    dict(value,positiveReceipt=True),dict(value,status='bound_positive_historical_receipt'),
                    dict(value,claimIdentity={'raw':self.claim})]:
            with self.subTest(bad=bad),self.assertRaises((ValueError,TypeError)):R.validate_reply(bad,self.request)

    def test_remote_serialization_is_bounded_and_strictly_pure_file(self):
        self.bind();self.records()
        # Existing --remote transport calls this same dispatcher and encoder;
        # roundtrip its actual bytes through the normal reply validator.
        output=io.StringIO()
        encoded=base64.b64encode(json.dumps(self.request).encode()).decode()
        with patch.object(R.sys,'argv',['reader','--remote',encoded]),contextlib.redirect_stdout(output):
            R.main()
        raw=output.getvalue().encode()
        self.assertLess(len(raw),4096)
        self.assertEqual(R.validate_reply(json.loads(raw),self.request)['readOnly'],True)
        self.assertNotIn(b'endpoint',raw);self.assertNotIn(b'containerIdentity"',raw)


if __name__ == '__main__':
    unittest.main()
