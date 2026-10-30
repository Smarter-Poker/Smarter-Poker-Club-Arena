#!/usr/bin/env python3
"""Native Git/source admission tests; no host, Docker, or production calls."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
BASH = '/opt/homebrew/bin/bash' if Path('/opt/homebrew/bin/bash').exists() else 'bash'
HELPER = 'server/scripts/engine-release-activation-floor.py'
MANIFEST = 'server/release/activation-floor.json'
DAILY = {'schema': 'engine-release-activation-floor/v1', 'preparationAt': '2026-10-30T08:30:00Z', 'activationAt': '2026-10-30T09:00:00Z', 'expiresAt': '2026-10-30T09:05:00Z', 'timeZone': 'America/Chicago'}
INTAKE = 'server/scripts/engine-release-intake.sh'
spec = importlib.util.spec_from_file_location('floor', ROOT / HELPER)
floor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(floor)


class ActivationFloor(unittest.TestCase):
    def setUp(self):
        environment = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
        environment.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull)
        patcher = patch.dict(os.environ, environment, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        # The caller supplies TMPDIR on the external SSD on macOS.
        self.temp = tempfile.TemporaryDirectory(prefix='activation-floor-')
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.git('init', '-q')
        self.git('config', 'core.hooksPath', str(self.repo / 'no-hooks'))
        self.git('config', 'user.name', 'Isolated fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        for name in (HELPER, MANIFEST, INTAKE, 'server/scripts/engine-release-transaction.sh', 'server/scripts/engine-release-recover.sh'):
            path = self.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes((ROOT / name).read_bytes())
        (self.repo / MANIFEST).write_text(json.dumps(DAILY))
        installer = self.repo / 'server/scripts/install-engine-supervisor.sh'
        installer.write_text('#!/usr/bin/env bash\nprintf installed > "$FIXTURE_MARKER"\n')
        installer.chmod(0o755)
        self.sha = self.commit()
        self.record = floor.policy(str(self.repo), self.sha, self.sha)

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], text=True).strip()

    def commit(self):
        self.git('add', '.')
        self.git('commit', '-qm', 'fixture', '--allow-empty')
        sha = self.git('rev-parse', 'HEAD')
        self.git('update-ref', 'refs/remotes/origin/main', sha)
        return sha

    def owner_record(self):
        source = json.loads((ROOT / MANIFEST).read_text())
        windows = json.loads((ROOT / 'server/release/owner-maintenance-windows.json').read_text())
        window = next(w for w in windows['windows'] if w['id'] == source['ownerWindowId'])
        window['contains'] = self.sha
        (self.repo / MANIFEST).write_bytes((ROOT / MANIFEST).read_bytes())
        (self.repo / 'server/release/owner-maintenance-windows.json').write_text(json.dumps({'version': 1, 'windows': [window]}))
        self.sha = self.commit()
        return floor.policy(str(self.repo), self.sha, self.sha)

    def test_actual_floor_reads_share_legacy_entry_budget_and_retain_announcement(self):
        import shlex
        import shutil
        import sys
        record = self.owner_record()
        requests = self.repo / 'requests'; requests.mkdir()
        floor.entry_state(record, str(requests), '123-1', True,
                          record['activationEpoch'], record['expiresEpoch']+1, announcement=True)
        marker = requests / '123-1.activation-entry'
        original = marker.read_bytes()
        source = (ROOT / 'server/scripts/engine-release-transaction.sh').read_text()
        wrapper = source[source.index('legacy_entry_read() {'):source.index('legacy_entry_trace() {')]
        binaries = self.repo / 'delayed-bin'; binaries.mkdir()
        launched = self.repo / 'git-child-started'
        git = binaries / 'git'
        git.write_text('#!' + sys.executable + '\nimport time\nfrom pathlib import Path\n'
                       + 'Path(' + repr(str(launched)) + ').write_text("started")\n'
                       + 'time.sleep(3)\nraise SystemExit(1)\n')
        git.chmod(0o755)
        self.assertIsNotNone(shutil.which('timeout'))
        def invoke(name, *, old=False, expired=False):
            if launched.exists(): launched.unlink()
            start = source.index(name + '() {'); end = source.index('\n}', start)+2
            body = source[start:end]
            if old: body = body.replace('legacy_entry_read python3', 'python3')
            deadline = time.time_ns()//1000000 + (5000 if expired else 7000)
            script = f'''set -euo pipefail
{wrapper}
date() {{ {shlex.quote(sys.executable)} -c 'import time;print(time.time_ns()//1000000)'; }}
die() {{ exit 77; }}
LEGACY_ENTRY_DEADLINE_MS={deadline}
ACTIVATION_FLOOR_OWNER_WINDOW={record['ownerWindowId']}
CONTROL_DIR={shlex.quote(str(ROOT/'server/scripts'))}
REPO_DIR={shlex.quote(str(self.repo))}
SHA={self.sha}; CONTROL_SHA={self.sha}
MUTATION_DEADLINE_EPOCH={record['expiresEpoch']+1}
REQUEST_ROOT={shlex.quote(str(requests))}; RUN_ID=123-1
{body}
{name}
echo CHECKPOINT_MUST_NOT_RUN
'''
            started = time.monotonic()
            result = subprocess.run([BASH, '-c', script], text=True, capture_output=True,
                env={**os.environ, 'PATH':str(binaries)+os.pathsep+os.environ['PATH']}, timeout=8)
            return result, time.monotonic()-started
        # Actual old caller exceeds the shared entry work allowance on a slow Git read.
        before, elapsed = invoke('floor_reservation_stamp', old=True)
        self.assertNotEqual(before.returncode, 124)
        self.assertGreaterEqual(elapsed, 2.8)
        for name, expected in [('floor_reservation_stamp',124),('record_floor_runtime_entry',77)]:
            with self.subTest(name=name):
                result, elapsed = invoke(name)
                self.assertEqual(result.returncode, expected, result.stderr)
                self.assertLess(elapsed, 2.8, result.stderr)
                self.assertNotIn('CHECKPOINT_MUST_NOT_RUN', result.stdout)
                self.assertEqual(marker.read_bytes(), original)
                result, _ = invoke(name, expired=True)
                self.assertEqual(result.returncode, expected, result.stderr)
                self.assertFalse(launched.exists(), 'expired entry launched the helper Git read')
                self.assertEqual(marker.read_bytes(), original)

    def test_owner_window_is_exact_bounded_and_needs_full_lead(self):
        r = self.owner_record()
        self.assertEqual(r['schema'], floor.OWNER_CAPABILITY)
        with self.assertRaises(ValueError): floor.check_window(r, r['clientPublicationEpoch']-1, r['expiresEpoch']+1, 'publish')
        floor.check_window(r, r['clientPublicationEpoch'], r['clientPublicationEpoch']+120, 'publish')
        floor.check_window(r, r['activationEpoch'], r['activationEpoch'] + 8400, 'admit')
        for now, deadline in [(r['activationEpoch']-1,r['expiresEpoch']+1), (r['expiresEpoch']-419,r['expiresEpoch']+1), (r['activationEpoch'],r['activationEpoch']+419)]:
            with self.assertRaises(ValueError): floor.check_window(r, now, deadline, 'admit')
        path = self.repo / 'server/release/owner-maintenance-windows.json'
        doc = json.loads(path.read_text()); doc['windows'][0]['id'] = 'foreign'
        path.write_text(json.dumps(doc)); sha = self.commit()
        with self.assertRaises(ValueError): floor.policy(str(self.repo), sha, sha)

    def test_new_continuation_preserves_old_target_expiry_and_control_identity(self):
        import hashlib
        old = {'schema': floor.OWNER_CAPABILITY, 'preparationAt': '2026-10-30T00:00:00Z',
               'activationAt': '2026-10-30T00:00:00Z', 'expiresAt': '2026-10-30T06:00:00Z',
               'timeZone': 'America/Chicago', 'ownerWindowId': '2026-10-30-mtt-next-safe-hand-drain',
               'clientPublicationAt': '2026-10-30T09:00:00Z'}
        old_raw = (json.dumps(old, indent=2)+'\n').encode()
        doc = json.loads((ROOT/'server/release/owner-maintenance-windows.json').read_text())
        historical = next(w for w in doc['windows'] if w['id'] == old['ownerWindowId'])
        self.assertEqual(historical['releaseWitness']['sha256'], hashlib.sha256(old_raw).hexdigest())
        self.assertEqual((historical['notBefore'], historical['notAfter']),
                         (old['activationAt'], old['expiresAt']))
        window = {**historical, 'contains': self.sha}
        (self.repo/MANIFEST).write_bytes(old_raw)
        (self.repo/'server/release/owner-maintenance-windows.json').write_text(json.dumps({'version':1,'windows':[window]}))
        old_sha = self.commit()
        previous = floor.policy(str(self.repo), old_sha, old_sha)
        current = self.owner_record()
        self.assertNotEqual(current['ownerWindowId'], previous['ownerWindowId'])
        # 2026-10-30 13:40 UTC continuation (the :55-break release of the heap
        # fix, V60, V62 and V61) follows the 00:00 and 05:30 UTC entries.
        self.assertEqual(current['activationEpoch'], previous['activationEpoch']+49200)
        self.assertEqual(current['expiresEpoch']-current['activationEpoch'], 21600)
        self.assertEqual(current['clientPublicationEpoch'], current['activationEpoch'])
        now = previous['expiresEpoch']+1
        with self.assertRaises(ValueError): floor.check_window(previous, now, now+8400, 'admit')
        # The old entry is expired while the new one is not yet open: neither
        # admits. The new one admits from its own activation instant.
        with self.assertRaises(ValueError): floor.check_window(current, now, now+8400, 'admit')
        now = current['activationEpoch']
        floor.check_window(current, now, now+8400, 'admit')
        floor.check_window(current, current['activationEpoch'], now+8400, 'publish')
        with self.assertRaises(ValueError): floor.policy(str(self.repo), self.sha, old_sha)
        with self.assertRaises(ValueError): floor.policy(str(self.repo), old_sha, self.sha)
        # Pinned old source is unchanged by the newer authorization.
        self.assertEqual(floor.policy(str(self.repo), old_sha, old_sha), previous)
        floor.check_window(current, current['expiresEpoch']-420, current['expiresEpoch'], 'admit')
        with self.assertRaises(ValueError):
            floor.check_window(current, current['expiresEpoch']-419, current['expiresEpoch']+1, 'admit')

    def test_owner_reservation_binds_run_target_cause_and_full_window(self):
        r = self.owner_record(); root = self.repo / 'state'; root.mkdir()
        path = root / 'engine-recovery-window-123-1.json'
        value = {'sha':self.sha,'runId':'123-1','cause':'urgent','announcedAt':r['activationEpoch']*1000}
        path.write_text(json.dumps(value)); path.chmod(0o600)
        self.assertEqual(floor.reservation(r,str(root),'123-1'),value['announcedAt'])
        for changed in [{'sha':'a'*40},{'runId':'124-1'},{'cause':'engine-degraded'},{'announcedAt':(r['expiresEpoch']-419)*1000}]:
            path.write_text(json.dumps({**value,**changed}))
            with self.assertRaises(ValueError): floor.reservation(r,str(root),'123-1')

    def test_actual_owner_certificate_binds_existing_window_and_refuses_shortcut(self):
        import datetime
        r = self.owner_record(); stamp = r['activationEpoch']*1000
        source = (ROOT / 'server/scripts/engine-release-transaction.sh').read_text()
        guard = source[source.index('import os\nfrom datetime import datetime'):source.index('remaining=int(m.get')]
        now = r['activationEpoch']+120
        class Clock(datetime.datetime):
            @classmethod
            def now(cls,tz=None): return datetime.datetime.fromtimestamp(now,tz)
        with patch('datetime.datetime',Clock), patch('time.time',return_value=now), patch.dict(os.environ,{'ACTIVATION_FLOOR_END_EPOCH':str(r['expiresEpoch']),'ACTIVATION_FLOOR_OWNER_WINDOW':r['ownerWindowId'],'FLOOR_ANNOUNCED_AT':str(stamp)}):
            exec(guard,{'m':{'reason':'Deployment Recovery','breakEndsAt':stamp+420000}})
            for m in [{'reason':'Scheduled Engine Maintenance','breakEndsAt':stamp+420000},{'reason':'Deployment Recovery','breakEndsAt':stamp+420001}]:
                with self.assertRaises(SystemExit): exec(guard,{'m':m})
            # The former daily-only guard refused this same owner window.
            before = guard[:guard.index('    if os.environ.get("ACTIVATION_FLOOR_OWNER_WINDOW")')] + '    if not daily: raise SystemExit(1)\n'
            with self.assertRaises(SystemExit): exec(before,{'m':{'reason':'Deployment Recovery','breakEndsAt':stamp+420000}})

    def test_actual_reservation_entry_survives_unknown_ack_and_checkpoint_no_action(self):
        r = self.owner_record(); root=self.repo/'requests';root.mkdir()
        source=(ROOT/'server/scripts/engine-release-transaction.sh').read_text()
        start=source.index('  FLOOR_RESERVATION_FRESH=0\n  if [ -n "${ACTIVATION_FLOOR_OWNER_WINDOW:-}" ]; then')
        end=source.index('  reserve_args=',start)
        body=source[start:end]
        import shlex
        command=' '.join(shlex.quote(x) for x in ['python3',str(self.repo/HELPER),'announcement-entry','--repo',str(self.repo),'--target',self.sha,'--control',self.sha,'--deadline',str(r['expiresEpoch']+100),'--request-root',str(root),'--run-id','123-1'])
        # Actual durable helper is exercised with an explicit injected clock;
        # shell ordering exercises the actual reservation entry fragment.
        floor.entry_state(r,str(root),'123-1',True,r['activationEpoch'],r['expiresEpoch']+100,True)
        result=subprocess.run([BASH,'-c','set -eu\nACTIVATION_FLOOR_OWNER_WINDOW=fixture\nFLOOR_DISPOSITION=never-entered\nrecord_floor_runtime_entry() { '+command+'; }\n'+body+'[ "$FLOOR_DISPOSITION" = announced ]\n'],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.git('update-ref','-d','refs/remotes/origin/main')
        result=subprocess.run(['python3',str(self.repo/HELPER),'disposition','--repo',str(self.repo),'--target',self.sha,'--control',self.sha,'--deadline','1','--request-root',str(root),'--run-id','123-1'],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(result.stdout.strip(),'announced')
        self.assertLess(source.index('    record_floor_runtime_entry',start),source.index('reserve-recovery-window',start))
        self.git('update-ref','refs/remotes/origin/main',self.sha)
        floor.entry_state(r,str(root),'123-1',True,r['activationEpoch']+120,r['expiresEpoch']+100)
        state=self.repo/'state';state.mkdir()
        receipt=state/'engine-recovery-window-123-1.json'
        receipt.write_text(json.dumps({'runId':'123-1','sha':self.sha,'cause':'urgent','announcedAt':r['activationEpoch']*1000}));receipt.chmod(0o600)
        intent=root/'123-1.legacy-checkpoint-intent';intent.write_text('uncertain')
        with self.assertRaises(ValueError): floor.checkpoint_no_action(r,str(root),str(state),'123-1')
        self.assertEqual(floor.entry_state(r,str(root),'123-1',False,0,0),'entered')
        intent.unlink()
        self.assertEqual(floor.checkpoint_no_action(r,str(root),str(state),'123-1'),'announced')
        self.assertEqual(floor.entry_state(r,str(root),'123-1',False,0,0),'announced')


    def test_known_no_reservation_retires_only_new_intent_and_foreign_owner_refuses(self):
        r=self.owner_record();root=self.repo/'requests';root.mkdir();state=self.repo/'state';state.mkdir()
        floor.entry_state(r,str(root),'123-1',True,r['activationEpoch'],r['expiresEpoch']+100,True)
        source=(ROOT/'server/scripts/engine-release-transaction.sh').read_text()
        start=source.index('retire_unannounced_floor_entry() {');end=source.index('\n# THE NEWEST WAITING RELEASE',start)
        body=source[start:end]
        env={**os.environ,'REQUEST_ROOT':str(root),'ENGINE_RELEASE_STATE_DIR':str(state),'RUN_ID':'123-1','FLOOR_RESERVATION_FRESH':'1','FLOOR_DISPOSITION':'announced'}
        reservation=state/'engine-recovery-window-123-1.json';reservation.write_text('{}')
        result=subprocess.run([BASH,'-c','set -eu\n'+body+'\nretire_unannounced_floor_entry'],env=env,capture_output=True,text=True)
        self.assertNotEqual(result.returncode,0);self.assertTrue((root/'123-1.activation-entry').exists())
        reservation.unlink()
        result=subprocess.run([BASH,'-c','set -eu\n'+body+'\nretire_unannounced_floor_entry\n[ "$FLOOR_DISPOSITION" = never-entered ]'],env=env,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr);self.assertFalse((root/'123-1.activation-entry').exists())
        start=source.index('refuse_foreign_floor_owner() {');end=source.index('\nretire_unannounced_floor_entry()',start)
        body=source[start:end]
        for status in (0,2):
            prefix='set -eu\nFLOOR_DISPOSITION=never-entered\ndie() { exit 71; }\nnewer_release_in_flight() { return '+str(status)+'; }\n'
            result=subprocess.run([BASH,'-c',prefix+body+'\nrefuse_foreign_floor_owner'],capture_output=True,text=True)
            self.assertEqual(result.returncode,71)


    def test_exact_feature_witness_survives_squash_and_shared_base_release(self):
        base=self.sha
        r=self.owner_record()
        source=(ROOT/'server/scripts/engine-release-transaction.sh').read_text()
        start=source.index('owner_window_reason() {');end=source.index('\n# The seal and the serving engine',start)
        body=source[start:end]
        # The selected window may restrict announcements to a Chicago minute
        # (the :53 notice before the :55 tournament break); evaluate at the
        # first such instant inside the window rather than at a random minute.
        windows_doc=json.loads((ROOT/'server/release/owner-maintenance-windows.json').read_text())
        selected=next(w for w in windows_doc['windows'] if w['id']==r['ownerWindowId'])
        minutes=selected.get('announceAtChicagoMinutes')
        from datetime import datetime,timezone
        from zoneinfo import ZoneInfo
        now=r['activationEpoch']+30
        while minutes and datetime.fromtimestamp(now,timezone.utc).astimezone(ZoneInfo('America/Chicago')).minute not in minutes:
            now+=60
        self.assertLess(now,r['expiresEpoch'])
        prefix='set -eu\ntimeout() { shift 3; "$@"; }\ndate() { echo '+str(now)+'; }\n'
        env={**os.environ,'REPO_DIR':str(self.repo),'SHA':self.sha,'ACTIVATION_FLOOR_OWNER_WINDOW':r['ownerWindowId']}
        import shlex
        def reason(serving):
            result=subprocess.run([BASH,'-c',prefix+body+'\nowner_window_reason '+shlex.quote(json.dumps({'releaseSha':serving}))],env=env,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            return result.stdout.strip()
        # The protected base already served, including the old daily manifest;
        # only this exact v2 blob consumes its new authorization.
        self.assertEqual(reason(base),'owner-ordered '+r['ownerWindowId'])
        self.assertEqual(reason(self.sha),'')
        (self.repo/MANIFEST).unlink();removed=self.commit()
        self.assertEqual(reason(removed),'')
        # An unrelated named order cannot substitute for the selected one.
        env['ACTIVATION_FLOOR_OWNER_WINDOW']='foreign'
        self.assertEqual(reason(base),'')


    def test_preparation_and_admission_boundaries(self):
        r = self.record
        deadline = r['expiresEpoch'] + 10
        floor.check_window(r, r['preparationEpoch'], deadline, 'prepare')
        floor.check_window(r, r['activationEpoch'], deadline, 'admit')
        for now, mode in [(r['preparationEpoch'] - 1, 'prepare'),
                          (r['activationEpoch'] - 1, 'admit'),
                          (r['expiresEpoch'], 'admit')]:
            with self.subTest(now=now), self.assertRaises(ValueError):
                floor.check_window(r, now, deadline, mode)
        with self.assertRaises(ValueError):
            floor.check_window(r, r['preparationEpoch'], r['expiresEpoch'] - 1, 'prepare')

    def test_malformed_unknown_and_duplicate_metadata_refuse(self):
        source = DAILY
        for change in [{'schema': 'unknown'}, {'timeZone': 'UTC'}, {'unexpected': True},
                       {'activationAt': None}, {'expiresAt': '2026-10-30T10:00:00Z'}]:
            with self.subTest(change=change):
                (self.repo / MANIFEST).write_text(json.dumps({**source, **change}))
                sha = self.commit()
                with self.assertRaises(ValueError):
                    floor.policy(str(self.repo), sha, sha)
        (self.repo / MANIFEST).write_text('{"schema":"a","schema":"b"}')
        sha = self.commit()
        with self.assertRaises(ValueError):
            floor.policy(str(self.repo), sha, sha)

    def test_old_control_or_changed_parser_cannot_ignore_target(self):
        (self.repo / HELPER).write_text('# old parser without admission\n')
        bad = self.commit()
        with self.assertRaises(ValueError):
            floor.policy(str(self.repo), self.sha, bad)

    def test_control_must_share_exact_policy_and_preinstall_guard(self):
        (self.repo / INTAKE).write_text('INSTALL_OUTPUT=early\n')
        bad = self.commit()
        with self.assertRaises(ValueError):
            floor.policy(str(self.repo), self.sha, bad)
        (self.repo / INTAKE).write_bytes((ROOT / INTAKE).read_bytes())
        (self.repo / MANIFEST).write_text((ROOT / MANIFEST).read_text() + '\n')
        bad = self.commit()
        with self.assertRaises(ValueError):
            floor.policy(str(self.repo), self.sha, bad)

    def test_missing_manifest_is_explicit_legacy_removal_not_expiry(self):
        (self.repo / MANIFEST).unlink()
        removed = self.commit()
        self.assertIsNone(floor.policy(str(self.repo), removed, removed))
        # The original pinned request still expires; newer removal cannot alter it.
        with self.assertRaises(ValueError):
            floor.check_window(self.record, self.record['expiresEpoch'], self.record['expiresEpoch'] + 100, 'admit')
        with self.assertRaises(subprocess.SubprocessError):
            floor.policy(str(self.repo), self.sha, removed)
        requests = self.repo / 'requests'
        requests.mkdir()
        command = ['python3', str(self.repo / HELPER), 'disposition', '--repo', str(self.repo),
                   '--target', removed, '--control', removed, '--deadline', str(int(time.time()) + 1200),
                   '--request-root', str(requests), '--run-id', '123-1']
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'legacy')
        self.git('update-ref', '-d', 'refs/remotes/origin/main')
        unknown = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(unknown.returncode, 0)
        self.assertNotIn('never-entered', unknown.stdout)


    def test_actual_intake_refuses_before_installer_even_for_emergency_signals(self):
        source = (ROOT / INTAKE).read_text()
        start = source.index('TARGET_SHA="${REQUEST_LINES[0]}"')
        end = source.index('INSTALL_RC=$?') + len('INSTALL_RC=$?')
        fragment = source[start:end]
        marker = self.repo / 'installed'
        prefix = 'set -euo pipefail\ndie() { echo "$*" >&2; exit 1; }\n'
        run_id = '123-1'
        request = [self.sha, self.sha, 'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/123', 'fixture', str(int(time.time()) + 86400)]
        import shlex
        prefix += 'REQUEST_LINES=(' + ' '.join(shlex.quote(v) for v in request) + ')\n'
        env = {**os.environ, 'STAGE': str(self.repo), 'REPO_DIR': str(self.repo),
               'GITHUB_RUN_ID': '123', 'RUN_ID': run_id, 'FIXTURE_MARKER': str(marker),
               'RECOVERY_URGENT': '1', 'RECOVERY_OWNER_WINDOW': 'active',
               'RECOVERY_QUARANTINED_MANAGERS': '100', 'HEALTH_LIVENESS': 'dead'}
        # This test remains deterministic after the one-time date: an expired
        # request must also refuse before the very same installer boundary.
        result = subprocess.run([BASH, '-c', prefix + fragment], env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('activation floor refused', result.stderr)
        self.assertFalse(marker.exists())
        # Regression control executes exactly the former pre-install fragment.
        guard_start = fragment.index('# The immutable target owns')
        guard_end = fragment.index('\nset +e', guard_start)
        before = fragment[:guard_start] + fragment[guard_end:]
        result = subprocess.run([BASH, '-c', prefix + before], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(marker.read_text(), 'installed')

    def test_receiver_gate_precedes_all_control_installation_and_failure_cleanup(self):
        source = (ROOT / '.github/workflows/auto-deploy-hetzner.yml').read_text()
        prepare = source.index("- name: Admit only the immutable target's preparation window")
        ssh = source.index('- name: Establish pinned ephemeral SSH transport', prepare)
        build = source.index('- name: Prepare the scheduled immutable image', ssh)
        wait = source.index('- name: Wait for the immutable activation floor', build)
        dispatch = source.index('- name: Dispatch the staged SHA', wait)
        self.assertLess(prepare, ssh)
        self.assertLess(build, wait)
        body = source[build:dispatch]
        for forbidden in ('install-engine-supervisor.sh', 'install-engine-intake.sh', 'launch-engine-release.sh', 'engine-release-recover', 'recovery-window'):
            self.assertNotIn(forbidden, body)
        self.assertIn('build-engine-image.sh', body)
        segment = source[dispatch:source.index('- name: Remove exact staging', dispatch)]
        self.assertLess(segment.index('engine-release-activation-floor.py" admit'), segment.index('"$STAGE/server/scripts/install-engine-intake.sh"'))
        cleanup = source[source.index('- name: Remove exact staging'):source.index('\n  record-receipt:')]
        self.assertIn('[ "$RELEASE_COMPLETED" = true ]', cleanup)
        self.assertNotIn('engine-release-recover', cleanup)


    def test_installed_v1_templates_accept_current_per_run_entrypoint(self):
        source = (ROOT / 'server/scripts/install-engine-intake.sh').read_text()
        # The installed unit invokes the authenticated per-run entrypoint;
        # neither frozen template embeds a hash of that entrypoint.
        import re
        templates = re.findall(r"cat > \"\$.*?_STAGE\" <<'UNIT'\n(.*?)\nUNIT", source, re.S)
        self.assertEqual(len(templates), 2)
        self.assertIn('ExecStart=/var/lib/club-arena/control-staging/%i/server/scripts/engine-release-intake.sh --run-id %i', templates[0])
        for content in templates:
            existing = self.repo / 'installed-unit'
            candidate = self.repo / 'candidate-unit'
            existing.write_text(content)
            candidate.write_text(content)
            self.assertEqual(subprocess.run(['cmp', '-s', str(existing), str(candidate)]).returncode, 0)
            candidate.write_text(content + '\nChanged=true\n')
            self.assertNotEqual(subprocess.run(['cmp', '-s', str(existing), str(candidate)]).returncode, 0)
        self.assertIn('frozen intake v1 unit differs; install a new protocol version instead', source)
        self.assertIn('frozen intake v1 path unit differs; install a new protocol version instead', source)

    def test_client_floor_is_independent_of_backlog_and_engine_expiry(self):
        r = self.record
        for reuse in ('true', 'false', 'error'):
            with self.subTest(reuse=reuse), self.assertRaises(ValueError):
                floor.check_window(r, r['activationEpoch'] - 1, r['expiresEpoch'] + 100, 'publish')
        floor.check_window(r, r['activationEpoch'], r['expiresEpoch'] + 100, 'publish')
        floor.check_window(r, r['expiresEpoch'] + 1, r['expiresEpoch'] + 100, 'publish')
        caller = (ROOT / '.github/workflows/publish-club-arena.yml').read_text()
        self.assertIn('uses: ./.github/workflows/publish-club-arena-client.yml', caller)
        source = (ROOT / '.github/workflows/publish-club-arena-client.yml').read_text()
        production = source[source.index('  production:'):]
        self.assertIn('needs.publication-floor.result == \'success\'', production)
        self.assertIn('admit, client-tests, build-and-store, publication-floor]', production)
        admission = source[source.index('  publication-floor:'):source.index('  production:')]
        self.assertIn('engine-release-activation-floor.py publish', admission)
        self.assertNotIn('outputs.publish', admission)
        self.assertNotIn('secrets:', admission)

    def test_actual_daily_certificate_guards_refuse_emergency_and_expiry(self):
        import io
        import datetime
        from unittest.mock import patch
        source = (ROOT / 'server/scripts/engine-release-transaction.sh').read_text()
        guard = source[source.index('import os\nfrom datetime import datetime'):source.index('remaining=int(m.get')]
        for reason, now, expected in [('Scheduled Engine Maintenance', self.record['activationEpoch'], True),
                                      ('Deployment Recovery', self.record['activationEpoch'], False),
                                      ('Scheduled Engine Maintenance', self.record['expiresEpoch'], False)]:
            class Clock(datetime.datetime):
                @classmethod
                def now(cls, tz=None):
                    return datetime.datetime.fromtimestamp(now, tz)
            with patch('datetime.datetime', Clock), patch('time.time', return_value=now), \
                 patch.dict(os.environ, {'ACTIVATION_FLOOR_END_EPOCH': str(self.record['expiresEpoch'])}):
                if expected:
                    exec(guard, {'m': {'reason': reason}})
                else:
                    with self.assertRaises(SystemExit):
                        exec(guard, {'m': {'reason': reason}})
        start = source.index('request_recovery_window() {')
        end = source.index('  now="$(date +%s)"', start)
        prefix = source[start:end] + '\n  echo unexpected-write\n}\nrequest_recovery_window\n'
        result = subprocess.run([BASH, '-c', 'set -eu\nRECOVERY_REQUESTED=0\nACTIVATION_FLOOR_END_EPOCH=1\n' + prefix], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '')
        self.assertIn('CERTIFICATE_DEADLINE="$ACTIVATION_FLOOR_END_EPOCH"', source)


    def test_runtime_entry_is_durable_and_expiry_never_creates_it(self):
        root = self.repo / 'requests'
        root.mkdir()
        r = self.record
        self.assertEqual(floor.entry_state(r, str(root), '123-1', False, r['expiresEpoch'], r['expiresEpoch'] + 100), 'never-entered')
        with self.assertRaises(ValueError):
            floor.entry_state(r, str(root), '123-1', True, r['expiresEpoch'], r['expiresEpoch'] + 100)
        self.assertFalse((root / '123-1.activation-entry').exists())
        self.assertEqual(floor.entry_state(r, str(root), '123-1', True, r['activationEpoch'], r['expiresEpoch'] + 100), 'entered')
        self.assertEqual(floor.entry_state(r, str(root), '123-1', False, r['expiresEpoch'], 1), 'entered')
        (root / '123-1.activation-entry').write_text('{}')
        with self.assertRaises(ValueError):
            floor.entry_state(r, str(root), '123-1', False, r['expiresEpoch'], 1)
        self.assertEqual(floor.entry_state(None, str(root), '123-1', False, 0, 0), 'legacy')

    def test_actual_recovery_skips_runtime_only_for_proved_never_entered(self):
        import shlex
        root = self.repo / 'requests'
        root.mkdir()
        control = self.repo / 'server/scripts'
        events = self.repo / 'runtime-events'
        for file in ('engine-release-seal.py', 'engine-supervisor.sh'):
            path = control / file
            path.write_text('#!/usr/bin/env bash\necho runtime >> "$FIXTURE_EVENTS"\n')
            path.chmod(0o755)
        (control / 'control-sha').write_text(self.sha + '\n')
        request = root / '123-1.request'
        request.write_text('\n'.join([self.sha, 'url', 'actor', str(control), self.sha, str(self.record['expiresEpoch'] + 100)]) + '\n')
        source = (ROOT / 'server/scripts/engine-release-recover.sh').read_text()
        fragment = source[source.index('mapfile -t FLOOR_REQUEST'):source.index('if [ "$RECOVERY_MODE" = retryable ]; then')]
        prefix = """set -euo pipefail
recovery_remaining() { echo 100; }
bounded_recovery_command() { shift; "$@"; }
flock() { echo lock >> "$FIXTURE_EVENTS"; }
docker() { echo docker >> "$FIXTURE_EVENTS"; }
"""
        # Reuse the maintained fixture-only Bash3 mapfile adapter; Linux
        # executes the production builtin. No release behavior is replaced.
        import ast
        adapter_tree = ast.parse((ROOT / 'tests/operations/engine-drill-admission.py').read_text())
        adapter = next(ast.literal_eval(node.value) for node in adapter_tree.body
                       if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'PORTABLE_ROOT' for t in node.targets))
        prefix += adapter[adapter.index('if ! help mapfile'):] + '\n'
        env = {**os.environ, 'REQUEST_ROOT': str(root), 'RUN_ID': '123-1', 'CONTROL_DIR': str(control),
               'REPO_DIR': str(self.repo), 'ENGINE_LOCK': str(self.repo / 'lock'), 'FIXTURE_EVENTS': str(events),
               'RECOVERY_DEADLINE_EPOCH': '9999999999', 'CONTAINER': 'fixture', 'PUBLIC_URL': 'fixture'}
        result = subprocess.run([BASH, '-c', prefix + fragment], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(events.exists())
        floor.entry_state(self.record, str(root), '123-1', True, self.record['activationEpoch'], self.record['expiresEpoch'] + 100)
        self.git('update-ref', '-d', 'refs/remotes/origin/main')
        result = subprocess.run([BASH, '-c', prefix + fragment], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('runtime', events.read_text())
        events.unlink()
        (root / '123-1.activation-entry').write_text('{}')
        result = subprocess.run([BASH, '-c', prefix + fragment], env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(events.exists())
        # A durable announcement is ownership, not permission to restore an
        # untouched predecessor. Exercise the actual recovery branch.
        r = self.owner_record()
        (root / '123-1.activation-entry').unlink()
        (control / 'control-sha').write_text(self.sha + '\n')
        request.write_text('\n'.join([self.sha, 'url', 'actor', str(control), self.sha, str(r['expiresEpoch']+100)])+'\n')
        floor.entry_state(r,str(root),'123-1',True,r['activationEpoch'],r['expiresEpoch']+100,True)
        result = subprocess.run([BASH, '-c', prefix + fragment], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode,75,result.stderr)
        self.assertFalse(events.exists())
        self.assertTrue(request.exists())


    def test_fresh_prework_cannot_restore_live_engine_and_entry_is_after_certificate(self):
        source = (ROOT / 'server/scripts/engine-release-transaction.sh').read_text()
        start = source.index('if [ "$FLOOR_DISPOSITION" = never-entered ] || [ "$FLOOR_DISPOSITION" = announced ]; then\n  # No runtime restoration')
        end = source.index('# Once this exact run crossed', start)
        body = source[start:end]
        result = subprocess.run([BASH, '-c', 'set -eu\nFLOOR_DISPOSITION=never-entered\nACTIVATION_FLOOR_END_EPOCH=9999999999\nprove_rollback_readiness() { echo read-only; }\n' + body], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), '')
        prework = source[source.index('FLOOR_DISPOSITION="$(python3'):start]
        self.assertIn('[ "$PENDING_STATE" != none ]', prework)
        first_entry = source.index('    record_floor_runtime_entry\n    LEGACY_CHECKPOINT_ATTEMPTED=1')
        self.assertLess(source.index('ENTRY_STARTED_MS="$(date +%s%3N)"'), first_entry)
        self.assertLess(first_entry, source.index('    "$LEGACY_CHECKPOINT" "$RUN_ID"', first_entry))
        recovery = (ROOT / 'server/scripts/engine-release-recover.sh').read_text()
        marker = recovery.index('rm -f -- "$REQUEST_ROOT/$RUN_ID.activation-entry"')
        self.assertLess(recovery.index('attest-terminal'), marker)
        self.assertLess(marker, recovery.index('rm -f -- "$REQUEST_FILE"'))
        wrapper = (ROOT / 'server/scripts/engine-release-unit-wrapper.sh').read_text()
        self.assertIn('"$GENERATION/engine-release-recover.sh" --run-id "$RUN_KEY" --mode retryable', wrapper)


    def test_actual_confirmed_checkpoint_no_action_retires_only_fresh_entry(self):
        import shlex
        root = self.repo / 'requests'
        root.mkdir()
        floor.entry_state(self.record, str(root), '123-1', True, self.record['activationEpoch'], self.record['expiresEpoch'] + 100)
        source = (ROOT / 'server/scripts/engine-release-transaction.sh').read_text()
        start = source.index('      [ ! -e "$REQUEST_ROOT/$RUN_ID.legacy-checkpoint-intent" ]')
        end = source.index('      LEGACY_CHECKPOINT_ATTEMPTED=0', start)
        body = source[start:end]
        prefix = 'set -eu\ndie() { exit 1; }\n'
        env = {**os.environ, 'REQUEST_ROOT': str(root), 'RUN_ID': '123-1', 'FLOOR_DISPOSITION': 'never-entered'}
        (root / '123-1.legacy-checkpoint-intent').write_text('uncertain')
        result = subprocess.run([BASH, '-c', prefix + body], env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(floor.entry_state(self.record, str(root), '123-1', False, 0, 0), 'entered')
        (root / '123-1.legacy-checkpoint-intent').unlink()
        result = subprocess.run([BASH, '-c', prefix + body], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(floor.entry_state(self.record, str(root), '123-1', False, 0, 0), 'never-entered')


if __name__ == '__main__':
    unittest.main()
