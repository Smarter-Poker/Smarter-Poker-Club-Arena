import gzip
import importlib.util
import datetime
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('reader', ROOT/'scripts/ci/read-scoped-runtime-errors.py')
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
EVENT = '00000000-0000-4000-8000-000000000001'
TABLE = '00000000-0000-4000-8000-000000000002'
SCOPES = [{'tournamentId': EVENT, 'tableIds': [TABLE]}]
STAMP = '2026-09-27T00:00:00.123456789Z '


class NativeLogReader(unittest.TestCase):
    def test_rebuy_diagnostic_keeps_selected_generation_and_outcome_only(self):
        value = {'schema': 'horse-rebuy-decision/v1', 'tournamentId': EVENT, 'userId': TABLE,
                 'handNumber': 777, 'choice': True, 'phase': 'purchase_unproven',
                 'bustAtMs': 1000, 'promptUntilMs': 31000, 'observedAtMs': 31001,
                 'remainingMs': -1, 'elapsedMs': 500, 'sqlstate': '55000', 'failureClass': 'cutoff',
                 'secret': 'PRIVATE', 'message': 'PRIVATE arbitrary error'}
        raw = (STAMP+'[Tournament.horse_rebuy_decision] '+json.dumps(value)+'\n').encode()
        result = reader.extract(raw, SCOPES)
        self.assertEqual(result['matchingRecords'], 1)
        decision = result['records'][0]['rebuyDecision']
        self.assertEqual(decision['handNumber'], 777)
        self.assertEqual(decision['remainingMs'], -1)
        self.assertEqual(decision['failureClass'], 'cutoff')
        self.assertNotIn('PRIVATE', json.dumps(result))
        for key, invalid in [('phase', 'PRIVATE'), ('phase', []), ('tournamentId', []), ('handNumber', True), ('choice', 1),
                             ('elapsedMs', 'PRIVATE'), ('tournamentId', TABLE)]:
            changed = {**value, key: invalid}
            self.assertIsNone(reader.rebuy_decision(['[Tournament.horse_rebuy_decision] '+json.dumps(changed)], {EVENT}))

    def test_continuation_failure_retains_only_fixed_category_and_phase(self):
        cases = [
            ('Error: Hand Continuation Write Is Unproven',
             '    at retainHandContinuation (/app/dist/services/supabase/handContinuation.js:41:15)',
             'write_unproven', 'retain'),
            ('Error: Hand Recovery Requires The External Runout Original',
             '    at HandController.serializeRecoveryState (/app/dist/engine/HandController.js:12:3)',
             'external_runout_original_required', 'capture'),
            ('Error: PRIVATE player cards deck arbitrary error',
             '    at ServerTableEngine.handleHandEvent (/app/dist/engine/ServerTableEngine.js:42:6)',
             'unknown', 'dispatch'),
        ]
        for message, frame, category, phase in cases:
            raw = (STAMP+f'[ServerTableEngine.{TABLE}.hand_continuation_unproven] '+message+'\n'
                   +STAMP+frame+'\n'+STAMP+'  PRIVATE credentials cards deck\n').encode()
            result = reader.extract(raw, SCOPES)
            self.assertEqual(result['matchingRecords'], 1)
            record = result['records'][0]
            self.assertEqual(record['context'], 'ServerTableEngine.hand_continuation_unproven')
            self.assertEqual(record['continuationFailure'], {'category': category, 'phase': phase})
            self.assertEqual(record['scopeIds'], [TABLE])
            self.assertNotIn('PRIVATE', json.dumps(result))
            self.assertNotIn('/app/', json.dumps(result))

    def test_continuation_failure_requires_exact_selected_context_and_whole_message(self):
        for context in [f'ServerTableEngine.{EVENT}.hand_continuation_unproven',
                        f'ServerTableEngine.{TABLE}.hand_continuation_unproven_extra']:
            raw = (STAMP+'['+context+'] Error: Hand Continuation Write Is Unproven\n').encode()
            self.assertEqual(reader.extract(raw, SCOPES)['matchingRecords'], 0)
        raw = (STAMP+f'[ServerTableEngine.{TABLE}.hand_continuation_unproven] '
               +'Error: Hand Continuation Write Is Unproven PRIVATE\n').encode()
        record = reader.extract(raw, SCOPES)['records'][0]
        self.assertEqual(record['continuationFailure'], {'category': 'unknown', 'phase': 'unknown'})
        self.assertNotIn('PRIVATE', json.dumps(record))

    def test_continuation_failure_does_not_infer_timeout_from_generic_refusal(self):
        raw = (STAMP+f'[ServerTableEngine.{TABLE}.hand_continuation_unproven] '
               +'Error: Hand Continuation Write Is Unproven\n'
               +STAMP+'    at arbitraryTimeout (/PRIVATE/path:1:2)\n').encode()
        record = reader.extract(raw, SCOPES)['records'][0]
        self.assertEqual(record['continuationFailure'], {'category': 'write_unproven', 'phase': 'unknown'})

    def test_restart_read_requires_opt_in_and_original_window(self):
        self.assertFalse(reader.restart_incident_requested(None, None))
        window = {'since': '2026-10-28T23:00:00Z', 'until': '2026-10-28T23:15:00Z'}
        self.assertTrue(reader.restart_incident_requested(True, window))
        for value, selected in [(True, None), (False, window), (1, window), ('true', window)]:
            with self.assertRaises(ValueError):
                reader.restart_incident_requested(value, selected)

    def test_restart_signs_do_not_export_arbitrary_fatal_payloads(self):
        raw = (STAMP+'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory PRIVATE\n'
               +STAMP+'unrelated PRIVATE text\n'
               +'FATAL ERROR: Reached heap limit Allocation failed undated PRIVATE\n').encode()
        result = reader.restart_log_signs(raw)
        self.assertEqual(result['matchingRecords'], 2)
        self.assertNotIn('PRIVATE', json.dumps(result))
        self.assertTrue(all(set(r) == {'timestamp', 'kind'} for r in result['records']))

    def test_restart_sources_are_fixed_bounded_read_only_and_sanitized(self):
        window = {'since': '2026-10-28T23:00:00Z', 'until': '2026-10-28T23:15:00Z'}
        events = [{'Action': 'die', 'timeNano': 1793228940000000000,
                   'Actor': {'Attributes': {'name': 'club-arena-engine', 'exitCode': '137', 'PRIVATE': 'SECRET'}}},
                  {'Action': 'die', 'timeNano': 1, 'Actor': {'Attributes': {'name': 'other'}}}]
        sources = [json.dumps({'Running': True, 'OOMKilled': False, 'ExitCode': 0,
                               'StartedAt': '2026-10-28T23:09:14Z', 'Error': 'SECRET'}).encode(),
                   ('\n'.join(json.dumps(e) for e in events)).encode(),
                   (STAMP+'Container /club-arena-engine unhealthy - Restarting PRIVATE\n').encode(),
                   json.dumps({'MESSAGE': 'Out of memory: Killed process PRIVATE',
                               '__REALTIME_TIMESTAMP': '1793228940000000'}).encode()]
        with patch.object(reader, 'capture', side_effect=sources) as capture:
            result = reader.read_restart_incident(window, b'')
        self.assertEqual(len(capture.call_args_list), 4)
        for call in capture.call_args_list:
            command = call.args[0]
            self.assertNotIn('restart', command)
            self.assertNotIn('exec', command)
            self.assertEqual(call.kwargs, {'seconds': 4})
        self.assertEqual(result['sources']['events']['records'], [
            {'action': 'die', 'timeNano': 1793228940000000000, 'exitCode': 137}])
        self.assertEqual(result['sources']['kernel']['records'][0]['engineAttribution'], 'unproven')
        self.assertNotIn('SECRET', json.dumps(result))
        self.assertNotIn('PRIVATE', json.dumps(result))
        with patch.object(reader, 'capture', side_effect=OSError('SECRET')):
            failed = reader.read_restart_incident(window, b'')
        self.assertTrue(all(s == {'status': 'unavailable'} for s in failed['sources'].values()))

    def test_kernel_native_fault_is_classified_without_exporting_addresses_or_payload(self):
        events = [
            {'MESSAGE': 'node[123]: segfault at deadbeef ip 0000 sp 0000 error 4 in node[abcd+1234] PRIVATE', '__REALTIME_TIMESTAMP': '1793427054862585'},
            {'MESSAGE': 'traps: node[123] general protection fault ip:abcd sp:1234 error:0 in libc.so.6[abc+def] PRIVATE'},
            {'MESSAGE': 'PRIVATE[123]: segfault at 0 ip 0 sp 0 error 4 in PRIVATE[abc+123]'},
            {'MESSAGE': 'Out of memory: Killed process PRIVATE'},
            {'MESSAGE': 'unrelated PRIVATE text'},
            {'MESSAGE': ['segfault']},
        ]
        rows = reader.kernel_restart_signs(('\n'.join(json.dumps(e) for e in events)).encode())
        self.assertEqual(len(rows), 4)
        self.assertEqual(rows[0], {'timestampUs': '1793427054862585', 'kind': 'host_native_fault_observed',
                                  'fault': 'segmentation_fault', 'processClass': 'node',
                                  'moduleClass': 'node', 'engineAttribution': 'unproven'})
        self.assertEqual(rows[1]['fault'], 'general_protection_fault')
        self.assertEqual(rows[1]['moduleClass'], 'libc')
        self.assertEqual(rows[2]['processClass'], 'other')
        self.assertEqual(rows[2]['moduleClass'], 'unknown')
        self.assertEqual(rows[3]['kind'], 'host_oom_observed')
        for secret in ['PRIVATE', 'deadbeef', 'abcd', '1234']:
            self.assertNotIn(secret, json.dumps(rows))

    def test_failure_diagnostics_never_export_exception_or_transport_text(self):
        cases = [(RuntimeError('PRIVATE host token query'), 'refused'),
                 (ValueError('PRIVATE payload'), 'refused'),
                 (OSError('PRIVATE path'), 'io_unavailable'),
                 (subprocess.TimeoutExpired(['PRIVATE command'], 1, stderr=b'PRIVATE key'), 'timeout'),
                 (RuntimeError('Log read exceeded bounded input'), 'input_bound'),
                 (RuntimeError('Log read timed out'), 'timeout'),
                 (RuntimeError('Public and host engine identity changed or differ'), 'identity_mismatch'),
                 (Exception('PRIVATE unexpected'), 'unexpected')]
        with patch.object(reader, 'FAILURE_STAGE', 'current_logs'):
            for error, expected in cases:
                result = reader.failure_diagnostic(error)
                self.assertEqual(result, {'schema': 'scoped-runtime-failure/v1',
                    'stage': 'current_logs', 'category': expected, 'readOnly': True})
                self.assertNotIn('PRIVATE', json.dumps(result))

    def test_remote_failure_only_admits_exact_bounded_fixed_diagnostic(self):
        valid = {'schema': 'scoped-runtime-failure/v1', 'stage': 'current_logs',
                 'category': 'input_bound', 'readOnly': True}
        variants = [valid, {**valid, 'payload': 'PRIVATE'}, {**valid, 'stage': 'PRIVATE'},
                    {**valid, 'category': 'PRIVATE'}, {**valid, 'readOnly': False},
                    {**valid, 'stage': []}, {**valid, 'category': {}},
                    {**valid, 'schema': 'other'}]
        for i, value in enumerate(variants):
            reply = subprocess.CompletedProcess(['ssh'], 1, b'', json.dumps(value).encode())
            result = reader.failure_diagnostic(reader.remote_failure(reply))
            self.assertEqual(result['category'], 'input_bound' if i == 0 else 'transport_exit')
            self.assertEqual(result['stage'], 'current_logs' if i == 0 else 'remote_transport')
            self.assertNotIn('PRIVATE', json.dumps(result))
        for code, stderr in [(255, b'PRIVATE auth host'), (1, b'x'*4097)]:
            reply = subprocess.CompletedProcess(['ssh'], code, b'', stderr)
            result = reader.failure_diagnostic(reader.remote_failure(reply))
            self.assertEqual(result['category'], 'ssh_exit_255' if code == 255 else 'transport_exit')
            self.assertNotIn('PRIVATE', json.dumps(result))

    def test_actual_failed_entry_emits_only_fixed_category_and_stage(self):
        import base64
        encoded = base64.b64encode(json.dumps({'scopes': 'PRIVATE_REQUEST',
                                              'windowStart': None}).encode()).decode()
        result = subprocess.run([sys.executable, str(ROOT/'scripts/ci/read-scoped-runtime-errors.py'),
                                 '--remote', encoded], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')
        lines = result.stderr.splitlines()
        self.assertEqual(len(lines), 2)
        self.assertEqual(json.loads(lines[0]), {'schema': 'scoped-runtime-failure/v1',
                         'stage': 'remote_admission', 'category': 'refused', 'readOnly': True})
        self.assertNotIn('PRIVATE', result.stderr)
        self.assertNotIn(encoded, result.stderr)

    def test_lease_metrics_accepts_and_strips_deployed_target_labels(self):
        config = (ROOT/'infra/monitoring/prometheus.yml').read_text()
        job = config.split('  - job_name: engine_game_server\n', 1)[1].split('    scrape_interval:', 1)[0]
        target_labels = dict(re.findall(r'^          (host|role|app): ([a-z0-9-]+)$', job, re.MULTILINE))
        self.assertEqual(target_labels, {'host': 'engine-01', 'role': 'engine', 'app': 'club-arena-engine'})
        window = {'since': '2026-10-27T09:05:00Z', 'until': '2026-10-27T09:20:00Z'}
        start = datetime.datetime.fromisoformat(window['since'].replace('Z', '+00:00')).timestamp()
        metric = {'__name__': 'poker_lease_heartbeat_outcomes_total', 'scope': 'tournament',
                  'state': 'kept', 'job': 'engine_game_server', 'instance': 'PRIVATE_HOST', **target_labels}
        source = {'status': 'success', 'data': {'resultType': 'matrix', 'result': [
            {'metric': metric, 'values': [[start, '12']]}]}}
        result = reader.extract_lease_metrics(source, window)
        self.assertEqual(result['series'][0]['labels'], {'scope': 'tournament', 'state': 'kept'})
        self.assertNotIn('PRIVATE_HOST', json.dumps(result))
        for key in target_labels:
            self.assertNotIn(key, result['series'][0]['labels'])
            original = metric[key]
            metric[key] = 'unexpected-target'
            with self.assertRaises(ValueError):
                reader.extract_lease_metrics(source, window)
            metric[key] = original
        metric['arbitrary_label'] = 'unexpected'
        with self.assertRaises(ValueError):
            reader.extract_lease_metrics(source, window)

    def test_lease_metrics_requires_explicit_original_window(self):
        self.assertFalse(reader.lease_metrics_requested(None, None))
        window = {'since': '2026-10-27T09:05:00Z', 'until': '2026-10-27T09:20:00Z'}
        self.assertTrue(reader.lease_metrics_requested(True, window))
        for value, selected in [(True, None), (False, window), ('true', window), (1, window)]:
            with self.assertRaises(ValueError):
                reader.lease_metrics_requested(value, selected)

    def test_lease_metrics_keeps_only_fixed_numeric_evidence(self):
        window = {'since': '2026-10-27T09:05:00Z', 'until': '2026-10-27T09:20:00Z'}
        start = datetime.datetime.fromisoformat(window['since'].replace('Z', '+00:00')).timestamp()
        metric = {'__name__': 'poker_lease_heartbeat_outcomes_total', 'scope': 'tournament',
                  'state': 'kept', 'job': 'PRIVATE_JOB', 'instance': 'PRIVATE_HOST'}
        source = {'status': 'success', 'data': {'resultType': 'matrix', 'result': [
            {'metric': metric, 'values': [[start, '12'], [start+15, 'NaN']]}]}}
        result = reader.extract_lease_metrics(source, window)
        self.assertEqual(result['status'], 'partial')
        self.assertIn('poker_lease_renewal_loop_running', result['missingMetrics'])
        self.assertEqual(result['series'][0]['labels'], {'scope': 'tournament', 'state': 'kept'})
        self.assertEqual(result['series'][0]['values'], [[start, 12.0], [start+15, None]])
        self.assertEqual(result['unknownSamples'], 1)
        self.assertNotIn('PRIVATE_', json.dumps(result))
        empty = {'status': 'success', 'data': {'resultType': 'matrix', 'result': []}}
        self.assertEqual(reader.extract_lease_metrics(empty, window)['status'], 'no_series')
        import copy
        for mutate in [
            lambda d: d['data']['result'][0]['metric'].update(user_id=EVENT),
            lambda d: d['data']['result'][0]['metric'].update(__name__='private_metric'),
            lambda d: d['data']['result'][0]['metric'].update(scope='PRIVATE_SECRET'),
            lambda d: d['data']['result'][0].update(values=[[start-1, '1']]),
            lambda d: d['data']['result'][0].update(values=[[start, 'PRIVATE_SECRET']]),
            lambda d: d['data']['result'][0].update(values=[[start+15, '1'], [start, '2']]),
            lambda d: d['data']['result'][0].update(values=[[start, '1']]*62),
            lambda d: d['data']['result'][0].update(values=[[float('nan'), '1']]),
            lambda d: d['data'].update(result=d['data']['result']*65),
        ]:
            changed = copy.deepcopy(source)
            mutate(changed)
            with self.assertRaises(ValueError):
                reader.extract_lease_metrics(changed, window)

    def test_lease_metrics_remote_entry_is_opt_in_and_identity_bracketed(self):
        import base64
        import io
        now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
        start = now-datetime.timedelta(hours=1)
        request = {'scopes': SCOPES, 'windowStart': start.strftime('%Y-%m-%dT%H:%M:%SZ'),
                   'leaseIncidentMetrics': True}
        encoded = base64.b64encode(json.dumps(request).encode()).decode()
        calls = []
        identity = {'version': 'abcdef012345', 'instanceId': 'fixture'}
        output = io.StringIO()
        with patch.object(reader, 'capture', return_value=b''), patch.object(reader, 'archived_window', return_value=([], {})), patch.object(reader, 'health', side_effect=lambda *_: calls.append('identity') or identity), patch.object(reader, 'read_lease_metrics', side_effect=lambda _: calls.append('metrics') or {'status': 'no_series', 'series': [], 'unknownSamples': 0}), patch.object(sys, 'argv', ['reader', '--remote', encoded]), patch.object(sys, 'stdout', output):
            reader.main()
        self.assertEqual(calls, ['identity', 'metrics', 'identity'])
        self.assertEqual(json.loads(output.getvalue())['leaseIncidentMetrics']['status'], 'no_series')
        del request['leaseIncidentMetrics']
        encoded = base64.b64encode(json.dumps(request).encode()).decode()
        output = io.StringIO()
        with patch.object(reader, 'capture', return_value=b''), patch.object(reader, 'archived_window', return_value=([], {})), patch.object(reader, 'health', return_value=identity), patch.object(reader, 'read_lease_metrics') as metrics, patch.object(sys, 'argv', ['reader', '--remote', encoded]), patch.object(sys, 'stdout', output):
            reader.main()
        metrics.assert_not_called()
        self.assertNotIn('leaseIncidentMetrics', json.loads(output.getvalue()))

    def test_lease_metrics_transport_is_fixed_bounded_and_reports_unknown(self):
        window = {'since': '2026-10-27T09:05:00Z', 'until': '2026-10-27T09:20:00Z'}
        response = Mock()
        response.status = 200
        response.read.return_value = json.dumps({'status': 'success', 'data': {'resultType': 'matrix', 'result': []}}).encode()
        context = Mock()
        context.__enter__ = Mock(return_value=response)
        context.__exit__ = Mock(return_value=False)
        opener = Mock()
        opener.open.return_value = context
        with patch.object(reader.urllib.request, 'build_opener', return_value=opener) as build:
            self.assertEqual(reader.read_lease_metrics(window)['status'], 'no_series')
        self.assertIs(build.call_args.args[0], reader.NoRedirect)
        with self.assertRaises(RuntimeError):
            reader.NoRedirect().redirect_request(None, None, 302, '', {}, 'http://unrequested')
        url = reader.urllib.parse.urlparse(opener.open.call_args.args[0])
        self.assertEqual((url.scheme, url.netloc, url.path), ('http', '127.0.0.1:9090', '/api/v1/query_range'))
        query = reader.urllib.parse.parse_qs(url.query)
        self.assertEqual(set(query), {'query', 'start', 'end', 'step'})
        self.assertEqual(query['start'], [window['since']])
        self.assertEqual(query['end'], [window['until']])
        self.assertEqual(query['step'], ['15s'])
        self.assertEqual(query['query'], ['{job="engine_game_server",__name__=~"'+'|'.join(sorted(reader.LEASE_METRIC_NAMES))+'"}'])
        self.assertEqual(opener.open.call_args.kwargs['timeout'], 5)
        response.read.assert_called_once_with(262145)
        for body in [b'PRIVATE_SECRET', b'x'*262145,
                     b'{"status":"error","error":"PRIVATE_SECRET"}']:
            response.read.return_value = body
            with patch.object(reader.urllib.request, 'build_opener', return_value=opener):
                result = reader.read_lease_metrics(window)
            self.assertEqual(result['status'], 'unavailable')
            self.assertNotIn('PRIVATE_SECRET', json.dumps(result))

    def test_break_refusals_keep_only_named_guards_and_symbolic_codes(self):
        prefix = '[Tournament:'+EVENT[:8]+'] Break abcdef12 '
        lines = [prefix+'not begun: source_roster_unread:PRIVATE_SQL_PASSWORD',
                 prefix+'members not dispatched: source_engine_absent',
                 prefix+'not retired: members_unresolved:2_of_4',
                 prefix+'not begun: movement_unproven:F06_MOVEMENT_WHOLE_ROSTER_REQUIRED',
                 prefix+'not begun: PRIVATE_SECRET',
                 prefix+'arbitrary: source_engine_absent',
                 prefix+'not begun: source_engine_absent PRIVATE_SECRET']
        result = reader.extract(('\n'.join(STAMP+x for x in lines)).encode(), SCOPES)
        self.assertEqual(result['matchingRecords'], 4)
        self.assertEqual(result['records'][0]['breakRefusal'],
                         {'breakIdPrefix': 'abcdef12', 'stage': 'not begun', 'reason': 'source_roster_unread'})
        self.assertEqual(result['records'][3]['symbolicErrors'], ['F06_MOVEMENT_WHOLE_ROSTER_REQUIRED'])
        self.assertNotIn('PRIVATE_', json.dumps(result))
        self.assertNotIn('2_of_4', json.dumps(result))

    def test_balance_progress_admits_only_three_fixed_selected_transitions(self):
        prefix = '[Tournament:'+EVENT[:8]+'] '
        valid = [prefix+'Resumed - 23 tables, level 7',
                 prefix+'consolidation outstanding - sweeps move to the consolidation lane',
                 prefix+'consolidation finished - sweeps return to the general lanes']
        invalid = [valid[0]+' PRIVATE_SECRET', prefix+'Resumed - 999999 tables, level 7',
                   prefix+'arbitrary PRIVATE_SECRET',
                   '[Tournament:deadbeef] Resumed - 23 tables, level 7']
        result = reader.extract(('\n'.join(STAMP+x for x in valid+invalid)).encode(), SCOPES)
        self.assertEqual(result['matchingRecords'], 3)
        self.assertEqual(result['records'][0]['resumedBoard'], {'tables': 23, 'level': 7})
        self.assertEqual([r['context'] for r in result['records']],
                         ['Tournament.resumed', 'Tournament.consolidation_outstanding', 'Tournament.consolidation_finished'])
        self.assertNotIn('PRIVATE_SECRET', json.dumps(result))
        ambiguous = SCOPES+[{'tournamentId': '00000000-0000-4000-8000-000000000003', 'tableIds': []}]
        self.assertEqual(reader.extract((STAMP+valid[0]).encode(), ambiguous)['records'], [])

    def test_unrelated_archive_traffic_cannot_spend_the_selected_record_budget(self):
        import base64
        import io
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            window, path, _ = self.archive_fixture(directory)
            stamp = window['since']+' '
            noise = ''.join(stamp+'[Other] unrelated '+str(i)+'\n' for i in range(20001))
            selected = (stamp+'[Tournament.atomic_move_refused_or_unknown] Error: F06_WHOLE_ROSTER_REQUIRED\n'
                        +stamp+"  tournamentId: '"+EVENT+"', password: 'PRIVATE_SECRET'\n")
            with gzip.open(path, 'wb') as out:
                out.write((noise+selected).encode())
            encoded = base64.b64encode(json.dumps({'scopes': SCOPES, 'windowStart': window['since']}).encode()).decode()
            output = io.StringIO()
            identity = {'version': 'abcdef012345', 'instanceId': 'fixture'}
            with patch.object(reader, 'ARCHIVE_DIRECTORY', directory), patch.object(reader, 'capture', return_value=b''), patch.object(reader, 'health', return_value=identity), patch.object(sys, 'argv', ['reader', '--remote', encoded]), patch.object(sys, 'stdout', output):
                reader.main()
            result = json.loads(output.getvalue())
            self.assertEqual(result['matchingRecords'], 1)
            self.assertEqual(result['records'][0]['symbolicErrors'], ['F06_WHOLE_ROSTER_REQUIRED'])
            self.assertEqual(result['archiveRead']['archives'][0]['retainedPhysicalLines'], 2)
            self.assertFalse(result['archiveRead']['truncated'])
            self.assertFalse(result['archiveRead']['fullWindowCoverageProven'])
            self.assertNotIn('PRIVATE_SECRET', output.getvalue())

    def test_archive_owner_admits_yesterday_and_exact_shared_age_boundary(self):
        now = datetime.datetime(2026, 10, 28, 21, tzinfo=datetime.timezone.utc)
        class FixedDateTime(datetime.datetime):
            @classmethod
            def now(cls, tz=None):
                return now
        with patch.object(reader.datetime, 'datetime', FixedDateTime):
            for hours in [36, 48]:
                start = now-datetime.timedelta(hours=hours)
                window = reader.log_window(start.strftime('%Y-%m-%dT%H:%M:%SZ'), now)
                ended = start+datetime.timedelta(minutes=15)
                with tempfile.TemporaryDirectory() as name:
                    directory = Path(name)
                    filename = ('engine-'+ended.strftime('%Y%m%dT%H%M%SZ')+'-started'+
                        (start-datetime.timedelta(hours=1)).strftime('%Y%m%dT%H%M%S')+
                        '-abcdef123456-c3ed8648.log.gz')
                    line = start.strftime('%Y-%m-%dT%H:%M:%SZ')+' [Tournament.read] F06_ORIGINAL_CHANGED '+EVENT+' PRIVATE_SECRET\n'
                    with gzip.open(directory/filename, 'wb') as out:
                        out.write(line.encode())
                    with patch.object(reader, 'ARCHIVE_DIRECTORY', directory):
                        sources, metadata = reader.archived_window(window, b'', scopes=SCOPES)
                    self.assertEqual(len(sources), 1)
                    self.assertEqual(sources[0][0], line.encode())
                    self.assertFalse(metadata['fullWindowCoverageProven'])
                    self.assertNotIn('PRIVATE_SECRET', json.dumps(reader.extract_sources(b'', sources, SCOPES)))
            old = {'since': '2026-10-26T20:59:59Z', 'until': '2026-10-26T21:14:59Z'}
            with patch.object(reader.os, 'open') as opened:
                with self.assertRaises(ValueError):
                    reader.archived_window(old, b'')
                opened.assert_not_called()

    def test_archive_fallback_recovers_original_window_without_current_identity(self):
        now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
        start = now-datetime.timedelta(hours=1)
        window = reader.log_window(start.strftime('%Y-%m-%dT%H:%M:%SZ'), now)
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            end = now-datetime.timedelta(minutes=30)
            filename = 'engine-'+end.strftime('%Y%m%dT%H%M%SZ')+'-started'+(start-datetime.timedelta(hours=1)).strftime('%Y%m%dT%H%M%S')+'-abcdef123456-c3ed8648.log.gz'
            line = start.strftime('%Y-%m-%dT%H:%M:%SZ')+' [Tournament.read] F06_ORIGINAL_CHANGED '+EVENT+' PRIVATE_SECRET\n'
            with gzip.open(directory/filename, 'wb') as out:
                out.write((line+end.strftime('%Y-%m-%dT%H:%M:%SZ')+' OUTSIDE_SECRET\n').encode())
            with patch.object(reader, 'ARCHIVE_DIRECTORY', directory):
                sources, metadata = reader.archived_window(window, b'')
            self.assertEqual(len(sources), 1)
            raw, identity = sources[0]
            self.assertEqual(raw, line.encode())
            self.assertEqual(identity['imageIdPrefix'], 'c3ed8648')
            self.assertIn('unproven', identity['fullEngineRevision'])
            self.assertFalse(metadata['truncated'])
            self.assertNotIn('OUTSIDE_SECRET', raw.decode())
            self.assertNotIn('PRIVATE_SECRET', json.dumps(reader.extract(raw, SCOPES)))
            import base64
            import io
            encoded = base64.b64encode(json.dumps({'scopes': SCOPES, 'windowStart': window['since']}).encode()).decode()
            identity_now = {'version': '9f0000000000', 'instanceId': 'new-process'}
            output = io.StringIO()
            with patch.object(reader, 'ARCHIVE_DIRECTORY', directory), patch.object(reader, 'capture', return_value=b''), patch.object(reader, 'health', return_value=identity_now), patch.object(sys, 'argv', ['reader', '--remote', encoded]), patch.object(sys, 'stdout', output):
                reader.main()
            result = json.loads(output.getvalue())
            self.assertEqual(result['inputBytes'], len(line.encode()))
            self.assertEqual(result['records'][0]['engineIdentity']['imageIdPrefix'], 'c3ed8648')
            self.assertEqual(result['hostEngineBefore'], identity_now)
            self.assertEqual(result['hostEngineAfter'], identity_now)
            self.assertNotIn('PRIVATE_SECRET', output.getvalue())

    def test_selected_archived_records_still_share_the_existing_input_bound(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            window, path, _ = self.archive_fixture(directory)
            stamp = window['since']+' '
            first = (stamp+'[Tournament.read] Error: F06_ORIGINAL_CHANGED\n'
                     +stamp+'  tournamentId: '+EVENT+'\n')
            second = stamp+'[Tournament.next] Error: F06_OTHER '+EVENT+'\n'
            with gzip.open(path, 'wb') as out:
                out.write((first+second).encode())
            with patch.object(reader, 'ARCHIVE_DIRECTORY', directory), patch.object(reader, 'MAX_PHYSICAL_LINES', 2):
                sources, metadata = reader.archived_window(window, b'', scopes=SCOPES)
            self.assertTrue(metadata['truncated'])
            self.assertEqual(metadata['archives'][0]['status'], 'inputBound')
            self.assertEqual(sources[0][0], first.encode())
            self.assertEqual(reader.extract(sources[0][0], SCOPES)['matchingRecords'], 1)

    def archive_fixture(self, directory, *, ended_minutes=30, started_hours=2, suffix='abcdef123456-c3ed8648', raw=None):
        now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
        start = now-datetime.timedelta(hours=1)
        window = reader.log_window(start.strftime('%Y-%m-%dT%H:%M:%SZ'), now)
        name = 'engine-'+(now-datetime.timedelta(minutes=ended_minutes)).strftime('%Y%m%dT%H%M%SZ')+'-started'+(now-datetime.timedelta(hours=started_hours)).strftime('%Y%m%dT%H%M%S')+'-'+suffix+'.log.gz'
        line = start.strftime('%Y-%m-%dT%H:%M:%SZ')+' [Tournament.read] F06_ORIGINAL_CHANGED '+EVENT+'\n'
        with gzip.open(directory/name, 'wb') as out:
            out.write(raw if raw is not None else line.encode())
        return window, directory/name, line.encode()

    def test_archive_admission_rejects_symlink_malformed_nonoverlap_and_old_processes(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            window, valid, line = self.archive_fixture(directory)
            valid.rename(directory/'payload.gz')
            valid.symlink_to(directory/'payload.gz')
            self.archive_fixture(directory, ended_minutes=20, started_hours=.25)
            self.archive_fixture(directory, ended_minutes=1500, started_hours=26)
            self.archive_fixture(directory, suffix='nothex123456-password')
            (directory/'engine-20260230T000000Z-started20260229T000000-abcdef123456-c3ed8648.log.gz').write_bytes(b'bad')
            with patch.object(reader, 'ARCHIVE_DIRECTORY', directory):
                sources, metadata = reader.archived_window(window, b'')
            self.assertEqual(sources, [])
            self.assertEqual(metadata['status'], 'unavailable')
            self.assertFalse(metadata['fullWindowCoverageProven'])
            # A symlinked canonical directory is refused too.
            alias = directory/'alias'
            alias.symlink_to(directory, target_is_directory=True)
            with patch.object(reader, 'ARCHIVE_DIRECTORY', alias):
                self.assertEqual(reader.archived_window(window, b'')[1]['status'], 'unavailable')

    def test_archive_shared_limits_dedup_and_corrupt_sources_are_explicit(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            window, path, line = self.archive_fixture(directory)
            with patch.object(reader, 'ARCHIVE_DIRECTORY', directory):
                sources, metadata = reader.archived_window(window, line)
                self.assertEqual(sources[0][0], b'')
                self.assertFalse(metadata['truncated'])
                sources, metadata = reader.archived_window(window, b'x\n'*20000)
                self.assertTrue(metadata['truncated'])
                self.assertEqual(metadata['archives'][0]['status'], 'inputBound')
                self.assertEqual(sources[0][0], b'')
                sources, metadata = reader.archived_window(window, b'x'*reader.MAX_BYTES)
                self.assertTrue(metadata['truncated'])
                self.assertEqual(sources[0][0], b'')
                with patch.object(reader, 'MAX_ARCHIVE_EXPANSION', 1):
                    sources, metadata = reader.archived_window(window, b'')
                    self.assertTrue(metadata['truncated'])
                    self.assertEqual(metadata['archives'][0]['status'], 'expansionBound')
                path.write_bytes(b'not gzip PRIVATE_SECRET')
                sources, metadata = reader.archived_window(window, b'')
                self.assertEqual(metadata['status'], 'incomplete')
                self.assertNotIn('PRIVATE_SECRET', json.dumps(metadata))

    def test_archive_selection_and_time_are_bounded_without_absence_certificate(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            for minutes in [30, 29, 28]:
                window, _, _ = self.archive_fixture(directory, ended_minutes=minutes)
            with patch.object(reader, 'ARCHIVE_DIRECTORY', directory):
                sources, metadata = reader.archived_window(window, b'')
                self.assertEqual(len(metadata['archives']), 2)
                self.assertTrue(metadata['truncated'])
                self.assertFalse(metadata['fullWindowCoverageProven'])
                self.assertIn('unknown', metadata['absenceMeans'])
                sources, metadata = reader.archived_window(window, b'', seconds=0)
                self.assertEqual(sources, [])
                self.assertTrue(metadata['truncated'])
                old = {'since': '2000-01-01T00:00:00Z', 'until': '2000-01-01T00:15:00Z'}
                with self.assertRaises(ValueError):
                    reader.archived_window(old, b'')

    def test_archive_decompression_child_is_killed_at_shared_deadline(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            window, _, _ = self.archive_fixture(directory)
            executable = directory/'gzip'
            executable.write_text('#!'+sys.executable+'\nimport time\ntime.sleep(5)\n')
            executable.chmod(0o700)
            import time
            started = time.monotonic()
            with patch.object(reader, 'ARCHIVE_DIRECTORY', directory), patch.dict(os.environ, {'PATH': str(directory)+':'+os.environ.get('PATH', '')}):
                sources, metadata = reader.archived_window(window, b'', seconds=.05)
            self.assertLess(time.monotonic()-started, 1)
            self.assertTrue(metadata['truncated'])
            self.assertEqual(metadata['archives'][0]['status'], 'timeBound')
            self.assertEqual(sources[0][0], b'')

    def fold_record(self, **changes):
        return {**dict(version=1, requestId=EVENT, totalMs=450, timerLateMs=2,
                       outcome='fulfilled', attempts=[dict(startMs=0, headersMs=400,
                       bodyMs=440, status=200, providerRequestId=TABLE,
                       upstreamMs=12, outcome='fulfilled')], attemptsOmitted=0, omitted=0), **changes}

    def fold_line(self, record):
        return STAMP+'[LightningFoldTiming] '+json.dumps(record)

    def test_fold_timing_explicit_window_and_allowlisted_schema(self):
        window = {'since': '2026-09-27T14:25:00Z', 'until': '2026-09-27T14:40:00Z'}
        self.assertFalse(reader.lightning_fold_timing_requested(None, None))
        self.assertTrue(reader.lightning_fold_timing_requested(True, window))
        for flag, selected in [(True, None), (False, window), ('true', window), (1, window)]:
            with self.assertRaises(ValueError):
                reader.lightning_fold_timing_requested(flag, selected)
        good = self.fold_record(password='PRIVATE_SECRET', playerId=TABLE)
        good['attempts'][0]['headers'] = {'authorization': 'PRIVATE_SECRET'}
        bad = [self.fold_record(requestId='PRIVATE_SECRET'), self.fold_record(totalMs=True),
               self.fold_record(totalMs=float('nan')), self.fold_record(totalMs=900001),
               self.fold_record(omitted=-1), self.fold_record(version=True),
               self.fold_record(outcome='PRIVATE_SECRET'), self.fold_record(attempts=[{}]),
               self.fold_record(attempts=self.fold_record()['attempts']*7)]
        for key, value in [('status', True), ('status', 600), ('providerRequestId', 'PRIVATE_SECRET'),
                           ('upstreamMs', -1), ('startMs', 451), ('bodyMs', 399)]:
            record = self.fold_record()
            record['attempts'][0][key] = value
            bad.append(record)
        lines = [self.fold_line(good)] + [self.fold_line(r) for r in bad]
        lines += [self.fold_line(self.fold_record()).replace('[LightningFoldTiming] ', '[LightningFoldTimingExtra] ')]
        result = reader.extract_lightning_fold_timings(('\n'.join(lines)).encode())
        self.assertEqual(result['matchingRecords'], 1)
        self.assertEqual(result['invalidRecords'], len(bad))
        self.assertEqual(result['records'], [{'timestamp': STAMP.strip(), **self.fold_record()}])
        self.assertNotIn('PRIVATE_SECRET', json.dumps(result))
        self.assertNotIn('playerId', json.dumps(result))
        self.assertNotIn('headers', json.dumps(result).replace('headersMs', ''))

    def test_fold_timing_preserves_pending_transport_after_outer_boundary(self):
        record = self.fold_record(outcome='rejected')
        record['attempts'][0].update(headersMs=None, bodyMs=None, status=None,
                                      providerRequestId=None, upstreamMs=None, outcome='pending')
        result = reader.extract_lightning_fold_timings(self.fold_line(record).encode())
        self.assertEqual(result['invalidRecords'], 0)
        self.assertEqual(result['records'][0]['outcome'], 'rejected')
        self.assertEqual(result['records'][0]['attempts'][0]['outcome'], 'pending')
        record['outcome'] = 'pending'
        result = reader.extract_lightning_fold_timings(self.fold_line(record).encode())
        self.assertEqual(result['matchingRecords'], 0)
        self.assertEqual(result['invalidRecords'], 1)

    def test_fold_timing_retention_bounds_and_empty_unknown(self):
        lines = [self.fold_line(self.fold_record(omitted=i)) for i in range(53)]
        lines += [STAMP+'[LightningFoldTiming] {broken}',
                  STAMP+'[LightningFoldTiming] '+('x'*8193),
                  '[LightningFoldTiming] '+json.dumps(self.fold_record())]
        result = reader.extract_lightning_fold_timings(('\n'.join(lines)).encode())
        self.assertEqual(result['matchingRecords'], 53)
        self.assertEqual(result['omittedRecords'], 3)
        self.assertEqual(result['invalidRecords'], 3)
        self.assertEqual(len(result['records']), 50)
        self.assertEqual(result['records'][0]['omitted'], 3)
        self.assertIn('unknown', reader.extract_lightning_fold_timings(b'')['absenceMeans'])

    def test_fold_timing_remote_admission_preserves_scope_and_window(self):
        import base64
        import io
        start = (datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(hours=1)).strftime('%Y-%m-%dT%H:%M:%SZ')
        for flag, selected, accepted in [(True, start, True), (True, None, False),
                                         ('true', start, False), (False, start, False)]:
            request = {'scopes': SCOPES, 'windowStart': selected, 'lightningFoldTiming': flag}
            encoded = base64.b64encode(json.dumps(request).encode()).decode()
            output = io.StringIO()
            identity = {'version': 'abcdef012345', 'instanceId': '1-fixture'}
            with patch.object(sys, 'argv', ['reader', '--remote', encoded]), patch.object(reader, 'health', return_value=identity), patch.object(reader, 'capture', return_value=self.fold_line(self.fold_record()).encode()) as capture, patch.object(sys, 'stdout', output):
                if accepted:
                    reader.main()
                    result = json.loads(output.getvalue())
                    self.assertEqual(result['lightningFoldTimings']['matchingRecords'], 1)
                    self.assertEqual(result['window'], reader.window_description(reader.log_window(start)))
                    capture.assert_called_once_with(reader.log_command(reader.log_window(start)))
                    self.assertEqual(result['hostEngineBefore'], result['hostEngineAfter'])
                else:
                    with self.assertRaises(ValueError):
                        reader.main()
                    capture.assert_not_called()

    def mux_record(self, **changes):
        return {**dict(attempt=7, startedAt=1790534274869, outcome='subscribed',
                      authorityReturnedAtMs=1200.5, ensureStartedAtMs=None,
                      tableReadyAtMs=1201, ackQueuedAtMs=1202,
                      firstHubFrameQueuedAtMs=1203, hubSubscribedAtMs=1204,
                      totalMs=1205), **changes}

    def mux_line(self, record):
        return STAMP+'[EngineWS] mux subscription timing '+json.dumps(record)

    def test_anonymous_mux_timings_require_explicit_completed_window(self):
        window = {'since': '2026-09-27T14:25:00Z', 'until': '2026-09-27T14:40:00Z'}
        self.assertFalse(reader.mux_timing_requested(None, None))
        self.assertTrue(reader.mux_timing_requested(True, window))
        for flag, selected in [(True, None), (False, window), ('true', window), (1, window), ({}, window)]:
            with self.subTest(flag=flag), self.assertRaises(ValueError):
                reader.mux_timing_requested(flag, selected)

    def test_native_mux_timing_pipe_keeps_only_exact_anonymous_fields(self):
        source = '\n'.join([self.mux_line(self.mux_record()),
                            STAMP+'[Other] '+json.dumps(self.mux_record()),
                            self.mux_line(self.mux_record()).replace('timing ', 'timing_extra '),
                            self.mux_line(self.mux_record(token='PRIVATE_SECRET')),
                            self.mux_line(self.mux_record(outcome='PRIVATE_SECRET')),
                            self.mux_line(self.mux_record(totalMs=float('nan'))),
                            self.mux_line(self.mux_record(totalMs=10**1000)),
                            self.mux_line(self.mux_record(attempt=True)),
                            self.mux_line(self.mux_record(authorityReturnedAtMs=-1)),
                            self.mux_line(self.mux_record(firstHubFrameQueuedAtMs='PRIVATE_SECRET'))])
        raw = reader.capture([sys.executable, '-c', 'import sys;sys.stdout.write('+repr(source)+')'])
        result = reader.extract_mux_timings(raw)
        self.assertEqual(result['matchingRecords'], 1)
        self.assertEqual(result['records'], [{'timestamp': STAMP.strip(), **self.mux_record()}])
        self.assertEqual(result['invalidRecords'], 7)
        self.assertNotIn('PRIVATE_SECRET', json.dumps(result))
        self.assertIn('cannot identify', result['attribution'])
        self.assertIn('unknown', result['absenceMeans'])

    def test_mux_timing_truncation_and_malformed_records_remain_unknown(self):
        source = '\n'.join(self.mux_line(self.mux_record(attempt=i+1)) for i in range(53))
        source += '\n'+STAMP+'[EngineWS] mux subscription timing {broken}'
        source += '\n'+STAMP+'[EngineWS] mux subscription timing '+('x'*4097)
        result = reader.extract_mux_timings(source.encode())
        self.assertEqual(result['matchingRecords'], 53)
        self.assertEqual(len(result['records']), 50)
        self.assertEqual(result['omittedRecords'], 3)
        self.assertEqual(result['invalidRecords'], 2)
        self.assertEqual(result['records'][0]['attempt'], 4)
        self.assertEqual(reader.extract_mux_timings(b'')['records'], [])

    def test_yesterdays_morning_and_exact_48_hour_boundary_remain_readable(self):
        now = datetime.datetime(2026, 10, 28, 16, tzinfo=datetime.timezone.utc)
        for value in ['2026-10-27T09:05:00Z', '2026-10-26T16:00:00Z']:
            result = reader.log_window(value, now)
            self.assertEqual(result['since'], value)
            end = datetime.datetime.fromisoformat(result['until'].replace('Z', '+00:00'))
            start = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
            self.assertEqual(end-start, datetime.timedelta(minutes=15))
        with self.assertRaises(ValueError):
            reader.log_window('2026-10-26T15:59:59Z', now)

    def test_historical_window_is_exactly_fifteen_minutes_and_recent(self):
        now = datetime.datetime(2026, 9, 27, 16, tzinfo=datetime.timezone.utc)
        start = '2026-09-27T14:25:00Z'
        self.assertEqual(reader.log_window(start, now), {
            'since': start, 'until': '2026-09-27T14:40:00Z'})
        self.assertEqual(reader.log_window(None, now), None)
        for value in ['', {}, '2026-09-27T14:25:00Z; reboot', '2026-09-27T14:25:00+00:00',
                      '2026-09-27T15:46:00Z', '2026-09-25T15:59:59Z', '2026-02-30T01:00:00Z']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                reader.log_window(value, now)
        command = reader.log_command(reader.log_window(start, now))
        self.assertEqual(command, ['docker', 'logs', '--since', start, '--until',
                                  '2026-09-27T14:40:00Z', '--tail', '20000',
                                  '--timestamps', 'club-arena-engine'])
        self.assertEqual(reader.log_command(None), reader.COMMAND)

    def test_actual_watchdog_context_keeps_only_selected_identity_and_named_reason(self):
        source = '\n'.join([
            STAMP+'[ServerTableEngine.'+TABLE+'.watchdog_kill] Error: Engine self-terminating for restart: tournament_table_zombie',
            STAMP+"  password: 'NEVER_PRINT_THIS', player: 'PRIVATE_NAME'",
            STAMP+'[ServerTableEngine.10000000-0000-4000-8000-000000000001.watchdog_kill] Engine self-terminating for restart: post_hand_settlement_failed',
            STAMP+'[Other] '+TABLE+' F06_UNRELATED'])
        result = reader.extract(source.encode(), SCOPES)
        self.assertEqual(result['matchingRecords'], 1)
        record = result['records'][0]
        self.assertEqual(record['scopeIds'], [TABLE])
        self.assertEqual(record['context'], 'ServerTableEngine.watchdog_kill')
        self.assertEqual(record['engineReasons'], ['tournament_table_zombie'])
        self.assertNotIn('PRIVATE_NAME', json.dumps(result))
        self.assertNotIn('NEVER_PRINT_THIS', json.dumps(result))
        self.assertNotIn('post_hand_settlement_failed', json.dumps(result))

    def test_cash_table_scope_and_exact_postcommit_refusal_are_sanitized(self):
        scopes = [{'tableIds': [TABLE]}]
        self.assertEqual(reader.selection(scopes), scopes)
        source = '\n'.join([
            STAMP+'[GameServer.retained_hand_refusal_holds_table] Error: HAND_SUBMISSION_HANDOFF_STATE_CHANGED',
            "  tableId: '"+TABLE+"', code: 'HAND_SUBMISSION_HANDOFF_STATE_CHANGED', password: 'PRIVATE_SECRET'",
            STAMP+'[ServerTableEngine.post_commit_obligations_pending] Error: f06_finish_unproven',
            "  tableId: '"+TABLE+"', handId: 'PRIVATE_HAND', cards: 'PRIVATE_CARDS'",
            STAMP+'[ServerTableEngine.post_commit_obligations_pending_extra] Error: f06_wrong '+TABLE,
            STAMP+'[Other] HAND_SUBMISSION_FAKE '+TABLE])
        result = reader.extract(source.encode(), scopes)
        self.assertEqual(result['matchingRecords'], 2)
        self.assertEqual(result['records'][0]['context'], 'GameServer.retained_hand_refusal_holds_table')
        self.assertEqual(result['records'][0]['symbolicErrors'], ['HAND_SUBMISSION_HANDOFF_STATE_CHANGED'])
        self.assertEqual(result['records'][1]['symbolicErrors'], ['f06_finish_unproven'])
        self.assertTrue(all(r['scopeIds'] == [TABLE] for r in result['records']))
        self.assertNotIn('PRIVATE_', json.dumps(result))
        self.assertNotIn('f06_wrong', json.dumps(result))
        for invalid in [[{'tableIds': []}], [{'tableIds': [TABLE]*2}], scopes*2,
                        [{'tableIds': [TABLE], 'command': 'restart'}], [{'tableIds': ['bad']}]]:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                reader.selection(invalid)

    def test_original_startup_financial_refusal_is_exactly_scoped(self):
        scopes = [{'tableIds': [TABLE]}]
        source = '\n'.join([
            STAMP+'[ServerTableEngine.'+TABLE+'.failed_to_start] Error: RETIRED_CASH_ORIGINAL_CHANGED PRIVATE_SQL',
            STAMP+'[GameServer.retained_hand_refusal_holds_table] Error: LEDGER_INVARIANT_REFUSED',
            "  tableId: '"+TABLE+"', password: 'PRIVATE_SECRET'",
            STAMP+'[ServerTableEngine.'+TABLE+'.failed_to_start_extra] Error: RETIRED_CASH_WRONG',
            STAMP+'[ServerTableEngine.10000000-0000-4000-8000-000000000001.failed_to_start] Error: RETIRED_CASH_FOREIGN'])
        result = reader.extract(source.encode(), scopes)
        self.assertEqual(result['matchingRecords'], 2)
        self.assertEqual(result['records'][0]['context'], 'ServerTableEngine.failed_to_start')
        self.assertEqual(result['records'][0]['scopeIds'], [TABLE])
        self.assertEqual(result['records'][0]['symbolicErrors'], ['RETIRED_CASH_ORIGINAL_CHANGED'])
        self.assertEqual(result['records'][1]['symbolicErrors'], ['LEDGER_INVARIANT_REFUSED'])
        self.assertNotIn('PRIVATE_', json.dumps(result))
        self.assertNotIn('RETIRED_CASH_WRONG', json.dumps(result))
        self.assertNotIn('RETIRED_CASH_FOREIGN', json.dumps(result))

    def test_original_postcommit_keeps_exact_state_and_static_native_cause_only(self):
        sources = [
            STAMP+'[ServerTableEngine.'+TABLE+'.failed_to_start] Error: RETIRED_CASH_ORIGINAL_POSTCOMMIT_REFUSED: 23514 cash_earning_seat_provenance_missing_or_ambiguous PRIVATE_SQL',
            STAMP+'[ServerTableEngine.'+TABLE+'.failed_to_start] Error: RETIRED_CASH_ORIGINAL_POSTCOMMIT_REFUSED: 23514 PRIVATE_MESSAGE',
            STAMP+'[ServerTableEngine.'+TABLE+'.failed_to_start] Error: arbitrary 23514 cash_earning_seat_provenance_missing_or_ambiguous',
            STAMP+'[ServerTableEngine.'+TABLE+'.failed_to_start] Error: RETIRED_CASH_ORIGINAL_POSTCOMMIT_REFUSED: 23514x cash_earning_seat_provenance_missing_or_ambiguous',
            STAMP+'[ServerTableEngine.'+TABLE+'.failed_to_start] Error: RETIRED_CASH_ORIGINAL_POSTCOMMIT_REFUSED: 23514 cash_earning_seat_provenance_missing_or_ambiguous_extra',
            STAMP+'[Other] RETIRED_CASH_ORIGINAL_POSTCOMMIT_REFUSED: 23514 cash_earning_seat_provenance_missing_or_ambiguous '+TABLE,
        ]
        result = reader.extract(('\n'.join(sources)).encode(), [{'tableIds': [TABLE]}])
        self.assertEqual(result['matchingRecords'], 5)
        first = result['records'][0]
        self.assertEqual(first['originalPostcommitSqlstates'], ['23514'])
        self.assertEqual(first['nativeErrorClasses'], ['cash_earning_seat_provenance_missing_or_ambiguous'])
        self.assertEqual(result['records'][1]['nativeErrorClasses'], [])
        for record in result['records'][2:4]:
            self.assertNotIn('originalPostcommitSqlstates', record)
            self.assertNotIn('nativeErrorClasses', record)
        self.assertEqual(result['records'][4]['nativeErrorClasses'], [])
        self.assertNotIn('PRIVATE_', json.dumps(result))
        self.assertNotIn('ambiguous_extra', json.dumps(result))

    def test_scope_and_malicious_input(self):
        self.assertEqual(reader.selection(SCOPES), SCOPES)
        for value in [[], SCOPES*3, SCOPES*2, [{'tournamentId': EVENT, 'tableIds': [TABLE], 'command': 'restart'}], [{'tournamentId': '../secrets', 'tableIds': [TABLE]}], [{'tournamentId': EVENT, 'tableIds': [TABLE]*2}], [{'tournamentId': EVENT, 'tableIds': 'bad'}]]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                reader.selection(value)

    def test_canonical_short_event_marker_is_explicitly_inferred_and_redacted(self):
        source = '\n'.join([
            STAMP+'[Tournament.entry_window_close_refused] Error: [Tournament:'+EVENT[:8]+'] F06_ORIGINAL_CHANGED PRIVATE_ERROR',
            STAMP+"  password: 'PRIVATE_PASSWORD', parameters: ['PRIVATE_SQL_ARGUMENT']",
            STAMP+'[TournamentManagerBase.manager_refused] Error: [Tournament:'+EVENT[:8]+'] f06_allocation_unproven',
        ])
        raw = reader.capture([sys.executable, '-c', 'import sys;sys.stdout.write('+repr(source)+')'])
        result = reader.extract(raw, SCOPES)
        self.assertEqual(result['matchingRecords'], 2)
        for record in result['records']:
            self.assertEqual(record['scopeIds'], [])
            self.assertEqual(record['inferredScopeIds'], [EVENT])
            self.assertEqual(record['scopeAttribution'], 'canonical_event_prefix_inferred')
        self.assertEqual(result['records'][0]['symbolicErrors'], ['F06_ORIGINAL_CHANGED'])
        self.assertEqual(result['records'][1]['symbolicErrors'], ['f06_allocation_unproven'])
        self.assertNotIn('PRIVATE_', json.dumps(result))

    def test_short_event_marker_rejects_wrong_ambiguous_and_arbitrary_positions(self):
        context = '[Tournament.entry_window_close_refused] '
        prefix = EVENT[:8]
        sources = [
            context+'Error: [Tournament:deadbeef] F06_WRONG',
            context+'Error: arbitrary [Tournament:'+prefix+'] F06_WRONG',
            context+'Error: [Tournament:'+prefix+'a] F06_WRONG',
            context+'Error: [Tournament:'+prefix+']suffix F06_WRONG',
            context+'Error: unscoped\n  [Tournament:'+prefix+'] F06_WRONG',
            '[Other] Error: [Tournament:'+prefix+'] F06_WRONG',
            '[GameServer.Tournament_resume_failed_for_t] Error: [Tournament:'+prefix+'] F06_WRONG',
        ]
        for source in sources:
            with self.subTest(source=source):
                self.assertEqual(reader.extract((STAMP+source).encode(), SCOPES)['records'], [])
        other = {'tournamentId': '00000000-0000-4000-8000-000000000003',
                 'tableIds': ['10000000-0000-4000-8000-000000000004']}
        ambiguous = context+'Error: [Tournament:'+prefix+'] F06_AMBIGUOUS'
        self.assertEqual(reader.extract((STAMP+ambiguous).encode(), SCOPES+[other])['records'], [])

    def test_full_uuid_attribution_precedes_short_event_inference(self):
        other = {'tournamentId': '00000000-0000-4000-8000-000000000003',
                 'tableIds': ['10000000-0000-4000-8000-000000000004']}
        source = (STAMP+'[Tournament.entry_window_close_refused] Error: [Tournament:'+EVENT[:8]+'] '
                  'F06_ORIGINAL_CHANGED '+EVENT)
        for scopes in [SCOPES, SCOPES+[other]]:
            with self.subTest(scopes=scopes):
                records = reader.extract(source.encode(), scopes)['records']
                self.assertEqual(len(records), 1)
                self.assertEqual(records[0]['scopeIds'], [EVENT])
                self.assertNotIn('inferredScopeIds', records[0])
                self.assertNotIn('scopeAttribution', records[0])

    def test_native_deal_failure_contexts_are_selected_exactly_and_redacted(self):
        contexts = ['deal_error_attempt_'+str(attempt) for attempt in range(1, 11)]
        contexts.append('too_many_errors_stopping')
        lines = []
        for context in contexts:
            # reportError writes the table UUID in its header, followed by
            # Error/object details and possible multiline private fields.
            lines.extend([
                STAMP+'[ServerTableEngine.'+TABLE+'.'+context+"] Error: f06_allocation_unproven",
                STAMP+"  message: 'F06_ORIGINAL_CHANGED', password: 'PRIVATE_FIXTURE_PASSWORD',",
                STAMP+"  parameters: ['PRIVATE_SQL_ARGUMENT'], stack: 'PRIVATE_STACK',",
            ])
        for table_id, context in [
            ('10000000-0000-4000-8000-000000000001', contexts[0]),
            (EVENT, contexts[0]),
            (TABLE+'a', contexts[0]),
            (TABLE, 'deal_error_attempt_0'),
            (TABLE, 'deal_error_attempt_11'),
            (TABLE, 'deal_error_attempt_01'),
            (TABLE, 'deal_error_attempt_1_extra'),
            (TABLE, 'too_many_errors_stopping_extra'),
            (TABLE, 'arbitrary_failure'),
        ]:
            # A selected identity elsewhere in a rejected header's record
            # cannot admit another table or arbitrary call site.
            lines.append(STAMP+'[ServerTableEngine.'+table_id+'.'+context+'] F06_UNRELATED '+TABLE)
        raw = reader.capture([sys.executable, '-c', 'import sys;sys.stdout.write('+repr('\n'.join(lines))+')'])
        result = reader.extract(raw, SCOPES)
        self.assertEqual(result['matchingRecords'], 11)
        self.assertEqual([r['context'] for r in result['records']],
                         ['ServerTableEngine.'+context for context in contexts])
        for record in result['records']:
            self.assertEqual(record['scopeIds'], [TABLE])
            self.assertEqual(record['timestamp'], STAMP.strip())
            self.assertEqual(record['symbolicErrors'], ['F06_ORIGINAL_CHANGED', 'f06_allocation_unproven'])
            self.assertEqual(record['engineReasons'], [])
        serialized = json.dumps(result)
        for private in ['PRIVATE_FIXTURE_PASSWORD', 'PRIVATE_SQL_ARGUMENT', 'PRIVATE_STACK', 'F06_UNRELATED']:
            self.assertNotIn(private, serialized)

    def test_native_pipe_framing_and_scoped_redaction(self):
        source = '\n'.join([STAMP+'[Tournament.atomic_move_refused_or_unknown] {', STAMP+"  message: 'STOPPED_BANK_ORIGINAL_CHANGED',", STAMP+"  password: 'NEVER_PRINT_THIS',", STAMP+"} { tournamentId: '"+EVENT+"', sourceTableId: '"+TABLE+"' }", STAMP+'[Tournament.other] MOVEMENT_ROSTER_CHANGED', STAMP+"  tournamentId: '10000000-0000-4000-8000-000000000001'", STAMP+'[Other] F06_SHOULD_NOT_BE_ATTRIBUTED'])
        raw = reader.capture([sys.executable, '-c', 'import sys;sys.stdout.write('+repr(source)+')'])
        result = reader.extract(raw, SCOPES)
        self.assertEqual(result['matchingRecords'], 1)
        self.assertEqual(result['records'][0]['scopeIds'], [EVENT, TABLE])
        self.assertEqual(result['records'][0]['symbolicErrors'], ['STOPPED_BANK_ORIGINAL_CHANGED'])
        self.assertNotIn('NEVER_PRINT_THIS', json.dumps(result))
        self.assertNotIn('MOVEMENT_ROSTER_CHANGED', json.dumps(result))
        self.assertIn('unknown', result['absenceMeans'])

    def test_empty_is_unknown(self):
        result = reader.extract(b'', SCOPES)
        self.assertEqual(result['records'], [])
        self.assertIn('unknown', result['absenceMeans'])

    def test_successor_trigger_keeps_only_scoped_static_phase_and_elapsed_counts(self):
        context = 'GameServer.stalled_elimination_successor_drain_requested'
        body = 'Tournament '+EVENT+' bust stage stalled (sweep in flight 0s, oldest bust waiting 129s, stage 1, stuck in tryTournamentRebuys for 3s) - no bust could be recorded PRIVATE_SECRET'
        raw = ('\n'.join([
            STAMP+'['+context+'] Error: '+body,
            STAMP+'['+context+'_extra] Error: '+body,
            STAMP+'['+context+'] Error: '+body.replace(EVENT, '10000000-0000-4000-8000-000000000001'),
            STAMP+'['+context+'] Error: '+body.replace('tryTournamentRebuys', 'PRIVATE_PHASE'),
            STAMP+'[GameServer.stuck_tournament_successor_drain_requested] Error: '+EVENT+' '+TABLE+' PRIVATE_SECRET',
        ])).encode()
        result = reader.extract(raw, SCOPES)
        self.assertEqual(result['matchingRecords'], 3)
        self.assertEqual(result['records'][0]['successorStall'], {
            'sweepInFlightSeconds': 0, 'bustWaitingSeconds': 129,
            'stage': 1, 'step': 'tryTournamentRebuys', 'stepSeconds': 3,
        })
        self.assertIsNone(result['records'][1]['successorStall']['step'])
        self.assertNotIn('successorStall', result['records'][2])
        self.assertNotIn('PRIVATE_', json.dumps(result))

    def test_native_successor_admission_contexts_are_exact_and_redacted(self):
        contexts = [
            'GameServer.Tournament_resume_failed_for_t',
            'GameServer.tournament_admission_retry_failed',
            'GameServer.mixed_original_recovery_retained',
        ]
        lines = []
        for context in contexts:
            lines.extend([
                STAMP+'['+context+"] { message: 'F06_ORIGINAL_CHANGED',",
                STAMP+"  password: 'PRIVATE_FIXTURE_PAYLOAD', token: 'PRIVATE_FIXTURE_TOKEN',",
                STAMP+"  parameters: ['PRIVATE_SQL_ARGUMENT'], stack: 'PRIVATE_STACK',",
                STAMP+"} { tournamentId: '"+EVENT+"', tableId: '"+TABLE+"' }",
            ])
        # Neither another GameServer call site nor a prefix/suffix match may
        # broaden this finite scope. A different event and a partial UUID also
        # remain outside the selected identities, even at an allowed call site.
        for context, identity in [
            ('GameServer.Tournament_stage_resume_failed_for_t', EVENT),
            ('GameServer.arbitrary_failure', EVENT),
            (contexts[0]+'_extra', EVENT),
            ('Prefix'+contexts[0], EVENT),
            (contexts[0], '10000000-0000-4000-8000-000000000001'),
            (contexts[0], EVENT+'a'),
        ]:
            lines.append(STAMP+'['+context+'] F06_UNRELATED '+identity)
        source = '\n'.join(lines)
        raw = reader.capture([sys.executable, '-c', 'import sys;sys.stdout.write('+repr(source)+')'])
        result = reader.extract(raw, SCOPES)
        self.assertEqual(result['matchingRecords'], 3)
        self.assertEqual([r['context'] for r in result['records']], contexts)
        for record in result['records']:
            self.assertEqual(record['scopeIds'], [EVENT, TABLE])
            self.assertEqual(record['symbolicErrors'], ['F06_ORIGINAL_CHANGED'])
            self.assertEqual(record['timestamp'], STAMP.strip())
        serialized = json.dumps(result)
        for private in ['PRIVATE_FIXTURE_PAYLOAD', 'PRIVATE_FIXTURE_TOKEN',
                        'PRIVATE_SQL_ARGUMENT', 'PRIVATE_STACK', 'F06_UNRELATED']:
            self.assertNotIn(private, serialized)

    def test_oversized_record_cannot_reuse_later_scope(self):
        raw = ('[Tournament.bad] F06_BAD\n'+'x\n'*70+EVENT).encode()
        result = reader.extract(raw, SCOPES)
        self.assertEqual(result['records'], [])
        self.assertEqual(result['oversizedRecords'], 1)

    def test_output_caps_and_duplicate_record_counts(self):
        raw = (('[Tournament.bad] F06_BAD '+EVENT+'\n')*205).encode()
        result = reader.extract(raw, SCOPES)
        self.assertEqual(len(result['records']), 200)
        self.assertEqual(result['matchingRecords'], 205)
        self.assertEqual(result['omittedRecords'], 5)

    def test_native_reader_refuses_large_and_failed_sources(self):
        with self.assertRaisesRegex(RuntimeError, 'bounded input'):
            reader.capture([sys.executable, '-c', 'import sys;sys.stdout.buffer.write(b"x"*(8*1024*1024+1))'])
        with self.assertRaisesRegex(RuntimeError, 'unavailable'):
            reader.capture([sys.executable, '-c', 'import sys;print("secret-error");sys.exit(1)'])

    def test_real_remote_entry_only_runs_fixed_docker_read(self):
        import base64
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            docker = directory/'docker'
            docker.write_text('#!'+sys.executable+'\nimport sys\nassert sys.argv[1:]=='+repr(reader.COMMAND[1:])+'\nprint('+repr(STAMP+'[Tournament.read] F06_ORIGINAL_CHANGED '+EVENT)+')\n')
            docker.chmod(0o700)
            environment = {'PATH': str(directory)+':/usr/bin:/bin'}
            encoded = base64.b64encode(json.dumps(SCOPES).encode()).decode()
            # Host health is simulated; the maintained remote main and actual
            # fixed subprocess entry are exercised with a real local pipe.
            program = "import importlib.util,sys; s=importlib.util.spec_from_file_location('r',"+repr(str(ROOT/'scripts/ci/read-scoped-runtime-errors.py'))+"); m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.health=lambda origin: {'version':'abcdef012345','instanceId':'1-fixture'};sys.argv=['reader','--remote',"+repr(encoded)+"];m.main()"
            result = subprocess.run([sys.executable, '-c', program], capture_output=True, text=True, env=environment, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            output = json.loads(result.stdout)
            self.assertTrue(output['readOnly'])
            self.assertEqual(output['records'][0]['symbolicErrors'], ['F06_ORIGINAL_CHANGED'])
            self.assertEqual(output['hostEngineBefore'], output['hostEngineAfter'])
            self.assertIn('unproven', output['perRecordEngineIdentity'])

    def test_real_remote_historical_entry_and_invalid_window_admission(self):
        import base64
        start = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=1)).strftime('%Y-%m-%dT%H:%M:%SZ')
        window = reader.log_window(start)
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            docker = directory/'docker'
            marker = directory/'called'
            docker.write_text('#!'+sys.executable+'\nimport sys\nfrom pathlib import Path\nassert sys.argv[1:]=='+repr(reader.log_command(window)[1:])+'\nPath('+repr(str(marker))+').write_text("read")\nprint('+repr(STAMP+'[ServerTableEngine.'+TABLE+'.watchdog_kill] Engine self-terminating for restart: tournament_table_zombie')+')\nprint('+repr(self.mux_line(self.mux_record()))+')\n')
            docker.chmod(0o700)
            for value, flag, accepted in [(start, None, True), (start, True, True), (None, True, False), (start, 'true', False), (start, False, False), ('2000-01-01T00:00:00Z', None, False), ('2026-09-27T14:25:00Z; restart', None, False)]:
                request = {'scopes': SCOPES, 'windowStart': value}
                if flag is not None:
                    request['muxTiming'] = flag
                encoded = base64.b64encode(json.dumps(request).encode()).decode()
                program = "import importlib.util,sys; s=importlib.util.spec_from_file_location('r',"+repr(str(ROOT/'scripts/ci/read-scoped-runtime-errors.py'))+"); m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.health=lambda origin: {'version':'abcdef012345','instanceId':'1-fixture'};sys.argv=['reader','--remote',"+repr(encoded)+"];m.main()"
                result = subprocess.run([sys.executable, '-c', program], capture_output=True, text=True, env={'PATH': str(directory)+':/usr/bin:/bin'}, timeout=10)
                self.assertEqual(result.returncode == 0, accepted)
                self.assertEqual(marker.exists(), accepted)
                if accepted:
                    output = json.loads(result.stdout)
                    self.assertEqual(output['window'], reader.window_description(window))
                    self.assertEqual(output['records'][0]['engineReasons'], ['tournament_table_zombie'])
                    self.assertEqual('muxSubscriptionTimings' in output, flag is True)
                    if flag is True:
                        self.assertEqual(output['muxSubscriptionTimings']['records'], [{'timestamp': STAMP.strip(), **self.mux_record()}])
                    marker.unlink()

    def test_transport_admission_ephemeral_permissions_and_failure_cleanup(self):
        original_run = subprocess.run
        for fail in ['none', 'transport', 'identity', 'host_identity', 'window', 'mux', 'missing_mux', 'extra_mux', 'lease', 'missing_lease', 'extra_lease']:
            with self.subTest(fail=fail), tempfile.TemporaryDirectory() as name:
                directory = Path(name)
                generated = directory/'fixture_key'
                original_run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(generated)], check=True)
                private = generated.read_text()
                pin = 'fixture.example '+(directory/'fixture_key.pub').read_text()
                event = directory/'event.json'
                payload = {'tournament_log_observation': SCOPES}
                mux = fail in ['mux', 'missing_mux']
                lease = fail in ['lease', 'missing_lease']
                start = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=1)).strftime('%Y-%m-%dT%H:%M:%SZ') if mux or lease else None
                window = reader.log_window(start)
                if mux:
                    payload.update(tournament_log_window_start=start, mux_subscription_timing=True)
                if lease:
                    payload.update(tournament_log_window_start=start, leaseIncidentMetrics=True)
                event.write_text(json.dumps({'action': 'audit-production-integrity', 'client_payload': payload}))
                identity = {'version': 'abcdef012345', 'instanceId': '1-fixture'}
                calls = []

                def transport(args, **kwargs):
                    if args[0] != 'ssh':
                        return original_run(args, **kwargs)
                    calls.append(args)
                    key = Path(args[2])
                    self.assertEqual(key.stat().st_mode & 0o777, 0o600)
                    self.assertEqual(key.parent.stat().st_mode & 0o777, 0o700)
                    self.assertEqual(key.read_text(), private+'\n')
                    self.assertIn('StrictHostKeyChecking=yes', args)
                    self.assertIn('IdentitiesOnly=yes', args)
                    self.assertIn(f'ConnectTimeout={reader.CONNECT_TIMEOUT}', args)
                    self.assertGreater(kwargs['timeout'], 2 * reader.HEALTH_TIMEOUT + reader.CAPTURE_TIMEOUT + reader.CONNECT_TIMEOUT)
                    self.assertEqual(kwargs['timeout'], 60 if lease else 55)
                    self.assertEqual(args[-2], 'root@fixture.example')
                    self.assertRegex(args[-1], r"^python3 - --remote '[A-Za-z0-9+/=]+'$")
                    self.assertEqual(kwargs['input'], (ROOT/'scripts/ci/read-scoped-runtime-errors.py').read_bytes())
                    import base64
                    request = json.loads(base64.b64decode(args[-1].split("'")[1]))
                    self.assertEqual(request, {'scopes': SCOPES, 'windowStart': start, **({'muxTiming': True} if mux else {}), **({'leaseIncidentMetrics': True} if lease else {})})
                    host = {**identity, 'instanceId': 'other-host'} if fail == 'host_identity' else identity
                    output = {'schema': 'scoped-runtime-errors/v1', 'readOnly': True, 'window': reader.window_description(window), 'hostEngineBefore': host, 'hostEngineAfter': host, **reader.extract(b'', SCOPES)}
                    if fail in ['mux', 'extra_mux']:
                        output['muxSubscriptionTimings'] = reader.extract_mux_timings(self.mux_line(self.mux_record()).encode())
                    if fail in ['lease', 'extra_lease']:
                        output['leaseIncidentMetrics'] = {'status': 'no_series', 'series': []}
                    if fail == 'window':
                        output['window'] = {'since': 'unrequested'}
                    return subprocess.CompletedProcess(args, 1 if fail == 'transport' else 0, json.dumps(output).encode(), b'sensitive transport error')

                current = Path.cwd()
                try:
                    os.chdir(directory)
                    env = {'GITHUB_EVENT_NAME': 'repository_dispatch', 'GITHUB_EVENT_PATH': str(event), 'RUNNER_TEMP': str(directory), 'HETZNER_HOST': 'fixture.example', 'HETZNER_SSH_PRIVATE_KEY': private, 'HETZNER_HOST_KEY': pin}
                    after = {**identity, 'instanceId': '2-changed'} if fail == 'identity' else identity
                    with patch.dict(os.environ, env), patch.object(sys, 'argv', [str(ROOT/'scripts/ci/read-scoped-runtime-errors.py')]), patch.object(reader, 'health', side_effect=[identity, after]), patch.object(subprocess, 'run', side_effect=transport):
                        if fail in ['none', 'mux', 'lease']:
                            reader.main()
                        else:
                            with self.assertRaises(RuntimeError):
                                reader.main()
                    self.assertEqual(len(calls), 1)
                    self.assertFalse(list(directory.glob('scoped-engine-read-*')))
                    output = directory/'artifacts/scoped-runtime-errors/observation.json'
                    self.assertEqual(output.exists(), fail in ['none', 'mux', 'lease'])
                    if output.exists():
                        saved = json.loads(output.read_text())
                        self.assertEqual('muxSubscriptionTimings' in saved, mux)
                        self.assertEqual('leaseIncidentMetrics' in saved, lease)
                        if mux:
                            self.assertEqual(saved['muxSubscriptionTimings']['matchingRecords'], 1)
                        self.assertNotIn(private, output.read_text())
                        self.assertNotIn('sensitive transport error', output.read_text())
                finally:
                    os.chdir(current)


if __name__ == '__main__':
    unittest.main()
