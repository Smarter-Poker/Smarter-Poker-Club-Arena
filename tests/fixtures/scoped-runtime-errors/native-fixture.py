import importlib.util
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('reader', ROOT/'scripts/ci/read-scoped-runtime-errors.py')
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
EVENT = '00000000-0000-4000-8000-000000000001'
TABLE = '00000000-0000-4000-8000-000000000002'
SCOPES = [{'tournamentId': EVENT, 'tableIds': [TABLE]}]
STAMP = '2026-09-27T00:00:00.123456789Z '


class NativeLogReader(unittest.TestCase):
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

    def test_historical_window_is_exactly_fifteen_minutes_and_recent(self):
        now = datetime.datetime(2026, 9, 27, 16, tzinfo=datetime.timezone.utc)
        start = '2026-09-27T14:25:00Z'
        self.assertEqual(reader.log_window(start, now), {
            'since': start, 'until': '2026-09-27T14:40:00Z'})
        self.assertEqual(reader.log_window(None, now), None)
        for value in ['', {}, '2026-09-27T14:25:00Z; reboot', '2026-09-27T14:25:00+00:00',
                      '2026-09-27T15:46:00Z', '2026-09-26T15:59:59Z', '2026-02-30T01:00:00Z']:
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

    def test_scope_and_malicious_input(self):
        self.assertEqual(reader.selection(SCOPES), SCOPES)
        for value in [[], SCOPES*3, SCOPES*2, [{'tournamentId': EVENT, 'tableIds': [TABLE], 'command': 'restart'}], [{'tournamentId': '../secrets', 'tableIds': [TABLE]}], [{'tournamentId': EVENT, 'tableIds': [TABLE]*2}], [{'tournamentId': EVENT, 'tableIds': 'bad'}]]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                reader.selection(value)

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
        for fail in ['none', 'transport', 'identity', 'host_identity', 'window', 'mux', 'missing_mux', 'extra_mux']:
            with self.subTest(fail=fail), tempfile.TemporaryDirectory() as name:
                directory = Path(name)
                generated = directory/'fixture_key'
                original_run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(generated)], check=True)
                private = generated.read_text()
                pin = 'fixture.example '+(directory/'fixture_key.pub').read_text()
                event = directory/'event.json'
                payload = {'tournament_log_observation': SCOPES}
                mux = fail in ['mux', 'missing_mux']
                start = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=1)).strftime('%Y-%m-%dT%H:%M:%SZ') if mux else None
                window = reader.log_window(start)
                if mux:
                    payload.update(tournament_log_window_start=start, mux_subscription_timing=True)
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
                    self.assertLessEqual(kwargs['timeout'], 55)
                    self.assertEqual(args[-2], 'root@fixture.example')
                    self.assertRegex(args[-1], r"^python3 - --remote '[A-Za-z0-9+/=]+'$")
                    self.assertEqual(kwargs['input'], (ROOT/'scripts/ci/read-scoped-runtime-errors.py').read_bytes())
                    import base64
                    request = json.loads(base64.b64decode(args[-1].split("'")[1]))
                    self.assertEqual(request, {'scopes': SCOPES, 'windowStart': start, **({'muxTiming': True} if mux else {})})
                    host = {**identity, 'instanceId': 'other-host'} if fail == 'host_identity' else identity
                    output = {'schema': 'scoped-runtime-errors/v1', 'readOnly': True, 'window': reader.window_description(window), 'hostEngineBefore': host, 'hostEngineAfter': host, **reader.extract(b'', SCOPES)}
                    if fail in ['mux', 'extra_mux']:
                        output['muxSubscriptionTimings'] = reader.extract_mux_timings(self.mux_line(self.mux_record()).encode())
                    if fail == 'window':
                        output['window'] = {'since': 'unrequested'}
                    return subprocess.CompletedProcess(args, 1 if fail == 'transport' else 0, json.dumps(output).encode(), b'sensitive transport error')

                current = Path.cwd()
                try:
                    os.chdir(directory)
                    env = {'GITHUB_EVENT_NAME': 'repository_dispatch', 'GITHUB_EVENT_PATH': str(event), 'RUNNER_TEMP': str(directory), 'HETZNER_HOST': 'fixture.example', 'HETZNER_SSH_PRIVATE_KEY': private, 'HETZNER_HOST_KEY': pin}
                    after = {**identity, 'instanceId': '2-changed'} if fail == 'identity' else identity
                    with patch.dict(os.environ, env), patch.object(sys, 'argv', [str(ROOT/'scripts/ci/read-scoped-runtime-errors.py')]), patch.object(reader, 'health', side_effect=[identity, after]), patch.object(subprocess, 'run', side_effect=transport):
                        if fail in ['none', 'mux']:
                            reader.main()
                        else:
                            with self.assertRaises(RuntimeError):
                                reader.main()
                    self.assertEqual(len(calls), 1)
                    self.assertFalse(list(directory.glob('scoped-engine-read-*')))
                    output = directory/'artifacts/scoped-runtime-errors/observation.json'
                    self.assertEqual(output.exists(), fail in ['none', 'mux'])
                    if output.exists():
                        saved = json.loads(output.read_text())
                        self.assertEqual('muxSubscriptionTimings' in saved, mux)
                        if mux:
                            self.assertEqual(saved['muxSubscriptionTimings']['matchingRecords'], 1)
                        self.assertNotIn(private, output.read_text())
                        self.assertNotIn('sensitive transport error', output.read_text())
                finally:
                    os.chdir(current)


if __name__ == '__main__':
    unittest.main()
