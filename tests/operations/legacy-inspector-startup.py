"""Real Node/TCP/deadline cases for the maintained readiness shell helper.

Only docker-exec transport is substituted; no Docker or production access.
"""
import os
import hashlib
import json
from pathlib import Path
import shutil
import shlex
import socket
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = (ROOT / 'server/scripts/engine-release-transaction.sh').read_text()
HELPER = SOURCE[SOURCE.index('legacy_inspector_is_closed() {'):SOURCE.index('\nrequest_recovery_window() {')]
CHECKPOINT = (ROOT / 'server/scripts/legacy-engine-checkpoint.sh').read_text()
RUNTIME_START = CHECKPOINT[CHECKPOINT.index('checkpoint_entry_read timeout 3s docker exec "$CONTAINER_ID"'):CHECKPOINT.index("' checkpoint-runtime -e '") + len("' checkpoint-runtime")]
TRANSPORT_START = next(line.split('| ', 1)[1] for line in CHECKPOINT.splitlines()
                       if '| checkpoint_final_read docker exec -i' in line)


class StartupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='legacy-probe-', dir=ROOT.parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        docker = self.root / 'docker'
        docker.write_text('#!/bin/sh\n[ "$1" = exec ] || exit 95\nshift\nif [ "$1" = -i ]; then shift; fi\n[ "$1" = fixture ] || exit 95\nshift\nexec "$@"\n')
        docker.chmod(0o700)
        # Never touch an existing local listener. Fail before invoking Node if
        # this fixed production port is unavailable to the isolated fixture.
        self.listener = socket.socket()
        self.listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.listener.bind(('127.0.0.1', 9229))
        self.addCleanup(self.listener.close)

    def probe(self, options='', listening=False):
        if listening:
            self.listener.listen()
            self.listener.settimeout(2)
        else:
            self.listener.close()
        env = dict(os.environ, NODE_OPTIONS=options, NODE_PATH=str(self.root),
                   PATH=str(self.root) + os.pathsep + os.environ['PATH'])
        result = subprocess.run(['bash', '-c', HELPER + '\nCONTAINER=fixture\nlegacy_inspector_is_closed\n'],
                                env=env, text=True, capture_output=True, timeout=5)
        if listening:
            connection, _ = self.listener.accept()
            with connection:
                connection.settimeout(2)
                self.assertEqual(connection.recv(1), b'')
            self.assertGreaterEqual(self.listener.fileno(), 0)
        return result

    def test_closed_port_is_positive_absence(self):
        result = self.probe()
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, '', ''))

    def test_inherited_inspect_cannot_open_the_observers_own_listener(self):
        result = self.probe('--inspect=127.0.0.1:9229')
        # Preserve the checkpoint's existing incompatible-option refusal, now
        # before announcement and without ever starting the observer Node.
        self.assertEqual((result.returncode, result.stdout, result.stderr), (1, '', ''))

    def test_inherited_preload_never_executes(self):
        marker = self.root / 'preload-ran'
        preload = self.root / 'preload.cjs'
        preload.write_text('require("node:fs").writeFileSync(' + repr(str(marker)) + ', "ran");')
        result = self.probe('--require=' + str(preload))
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, '', ''))
        self.assertFalse(marker.exists())

    def test_genuine_listener_stays_open_and_receives_no_payload(self):
        result = self.probe(listening=True)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (1, '', ''))

    def test_child_transport_failure_cannot_prove_absence(self):
        (self.root / 'docker').write_text('#!/bin/sh\nexit 2\n')
        result = self.probe()
        self.assertEqual(result.returncode, 2)

    def start_checkpoint_child(self, options, transport=False):
        self.listener.close()
        marker = self.root / 'preload-ran'
        preload = self.root / 'preload.cjs'
        preload.write_text('require("node:fs").writeFileSync(' + repr(str(marker)) + ', "ran");')
        env = dict(os.environ, NODE_OPTIONS=options.replace('PRELOAD', str(preload)),
                   NODE_PATH=str(self.root), INTERNAL_API_KEY='isolated-fixture-only',
                   PATH=str(self.root) + os.pathsep + os.environ['PATH'])
        # Actual child launch commands, synthetic Node payload instead of any
        # production runtime/inspector/custody operation. Proves startup only.
        payload = ('if(process.env.NODE_OPTIONS!==undefined||process.env.NODE_PATH!==undefined'
                   '||process.env.INTERNAL_API_KEY!=="isolated-fixture-only")process.exit(91);'
                   'process.stdout.write(JSON.stringify(process.argv.slice(2)));')
        setup = ('checkpoint_entry_read() { "$@"; }; checkpoint_final_read() { "$@"; }; '
                 'CONTAINER_ID=fixture; INSTANCE=fixture-instance; LEGACY_SHA=fixture-sha; '
                 'CHECKPOINT_INTENT=fixture-intent; CHECKPOINT_DEADLINE_MS=40000;\n')
        command = TRANSPORT_START if transport else RUNTIME_START + ' -e ' + shlex.quote(payload)
        result = subprocess.run(['bash', '-c', setup + command], env=env, input=payload,
                                text=True, capture_output=True, timeout=5)
        self.assertFalse(marker.exists())
        return result

    def test_runtime_start_preserves_inspect_and_debug_refusal_before_node(self):
        for flag in ['--inspect=127.0.0.1:9229', '--inspect-brk', '--debug']:
            with self.subTest(flag=flag):
                result = self.start_checkpoint_child('--require=PRELOAD ' + flag)
                self.assertEqual((result.returncode, result.stdout, result.stderr), (1, '', ''))

    def test_runtime_start_ignores_application_preload_and_preserves_auth(self):
        result = self.start_checkpoint_child('--require=PRELOAD')
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, '[]', ''))

    def test_runtime_start_accepts_previously_allowed_options(self):
        result = self.start_checkpoint_child('--dns-result-order=ipv4first')
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, '[]', ''))

    def test_stdin_transport_cannot_open_its_own_inspector_or_run_preloads(self):
        result = self.start_checkpoint_child('--inspect=127.0.0.1:9229 --require=PRELOAD', transport=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, '')
        self.assertEqual(json.loads(result.stdout), ['fixture-instance', 'fixture-sha', 'fixture-intent', '40000'])


class NativeArtifactPackagingTests(unittest.TestCase):
    """Execute maintained artifact verifier/cleanup, without Docker or dlopen."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='legacy-artifact-', dir=ROOT.parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.control = self.root / 'control'
        self.control.mkdir()
        self.pin = 'd' * 64
        (self.control / 'legacy-engine-checkpoint.mjs').write_text(
            "export const LEGACY_CENSUS_NATIVE_SOURCE_SHA256 = '" + self.pin + "';\n")
        self.binary = self.root / 'legacy-census.node'
        self.binary.write_bytes(b'isolated fixture; never loaded')
        self.manifest = dict(schema='legacy-native-census-build/v1', node='v22.23.2',
            v8='12.4.254.21-node.56', modules='127', platform='linux', arch='x64',
            pointerCompression=0, sourceSHA256=self.pin, headersSHA256='e'*64,
            binarySHA256=hashlib.sha256(self.binary.read_bytes()).hexdigest(),
            compiler='fixture only', maxMatches=22096, managedOutputBytes=772608,
            qualification='unqualified-build-only')

    def verify(self):
        self.binary.chmod(0o400)
        if self.binary.with_suffix('.node.json').exists(): self.binary.with_suffix('.node.json').chmod(0o600)
        self.binary.with_suffix('.node.json').write_text(json.dumps(self.manifest))
        self.binary.with_suffix('.node.json').chmod(0o400)
        function = CHECKPOINT[CHECKPOINT.index('verify_native_artifacts() {'):
                              CHECKPOINT.index('verify_native_candidate() {')]
        # Portable fixture simulates root uid only, preserving real modes, file
        # kinds and all hashes. No native binary is loaded or production read.
        bootstrap = ('import os,sys;original=os.lstat;'
            'os.lstat=lambda p:os.stat_result(tuple(original(p))[:4]+(0,)+tuple(original(p))[5:]);'
            'sys.argv.pop(1);exec(sys.stdin.read())')
        command = ('native_artifact_read() { "$@"; }; '
                   'python3() { command python3 -c ' + shlex.quote(bootstrap) + ' "$@"; };\n' +
                   function + '\nCONTROL_DIR=' + shlex.quote(str(self.control)) + '\n' +
                   'verify_native_artifacts ' + shlex.quote(str(self.root)) + ' ' +
                   'a'*40 + ' sha256:' + 'b'*64 + ' ' + 'c'*40 + ' 123-1')
        return subprocess.run(['bash', '-c', command], text=True, capture_output=True, timeout=5)

    def test_binds_exact_pair_and_candidate_without_loading_it(self):
        result = self.verify()
        self.assertEqual(result.returncode, 0, result.stderr)
        descriptor = json.loads(result.stdout)
        self.assertEqual(descriptor['schema'], 'legacy-native-census-artifact/v1')
        self.assertEqual(descriptor['path'], '/app/.legacy-census-checkpoint-123-1/legacy-census.node')
        self.assertEqual(descriptor['sourceSHA256'], self.pin)
        self.assertEqual(descriptor['binarySHA256'], self.manifest['binarySHA256'])
        self.assertEqual(descriptor['candidateSHA'], 'a'*40)

    def test_abi_source_hash_and_payload_mismatches_refuse(self):
        for field, bad in [('modules','128'), ('v8','wrong'), ('sourceSHA256','f'*64),
                           ('binarySHA256','f'*64), ('platform','darwin')]:
            with self.subTest(field=field):
                old = self.manifest[field]
                self.manifest[field] = bad
                self.assertNotEqual(self.verify().returncode, 0)
                self.manifest[field] = old

    def test_missing_binary_refuses_before_any_load(self):
        self.binary.unlink()
        function = CHECKPOINT[CHECKPOINT.index('verify_native_artifacts() {'):
                              CHECKPOINT.index('verify_native_candidate() {')]
        result = subprocess.run(['bash', '-c', 'native_artifact_read() { "$@"; };\n' + function +
            '\nCONTROL_DIR=' + shlex.quote(str(self.control)) + '\nverify_native_artifacts ' +
            shlex.quote(str(self.root)) + ' ' + 'a'*40 + ' sha256:'+'b'*64+' '+'c'*40+' 123-1'],
            text=True, capture_output=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('FileNotFoundError', result.stderr)

    def test_extraction_ack_loss_cleans_only_exact_nonrunning_owner(self):
        function = CHECKPOINT[CHECKPOINT.index('    cleanup_extraction() {'):
                              CHECKPOINT.index("    trap 'extraction_exit=$?")]
        for token, running in [('owned',False), ('foreign',False), ('owned',True)]:
            with self.subTest(token=token, running=running):
                stage = self.root / ('extract-'+token+str(running))
                stage.mkdir()
                metadata = json.dumps({'Image':'sha256:'+'a'*64,'Id':'b'*64,
                    'Config':{'Labels':{'sp.legacy-census.extraction':token}},
                    'State':{'Running':running}})
                script = ('timeout() { shift 2; "$@"; }; '
                    'docker() { if [ "$1" = inspect ]; then printf "%s\\n" '+shlex.quote(metadata)+
                    '; elif [ "$1" = rm ]; then printf "%s\\n" "$2" > '+shlex.quote(str(stage/'removed'))+
                    '; else return 95; fi; };\n'+function+
                    '\nextraction_attempted=1\nextraction_name=fixture\nextraction_token=owned\nimage=sha256:'+'a'*64+
                    '\nstage='+shlex.quote(str(stage))+'\ncleanup_extraction')
                result = subprocess.run(['bash','-c',script], text=True, capture_output=True, timeout=5)
                if token == 'owned' and not running:
                    self.assertEqual(result.returncode,0,result.stderr)
                    self.assertFalse(stage.exists())
                else:
                    self.assertNotEqual(result.returncode,0)
                    self.assertTrue(stage.exists())
                    self.assertFalse((stage/'removed').exists())

    def test_lost_creation_ack_still_cleans_only_matching_ownership(self):
        function = CHECKPOINT[CHECKPOINT.index('cleanup_native_capture() {'):
                              CHECKPOINT.index("trap 'native_exit=$?")]
        real_node = shutil.which('node')
        bootstrap = ('const fs=require("node:fs"),original=fs.lstatSync;'
            'fs.lstatSync=(...a)=>{const s=original(...a);s.uid=0;return s};'
            'const code=process.argv[1];process.argv.splice(1,1);eval(code)')
        for marker in ['owned', 'foreign', None]:
            with self.subTest(marker=marker):
                directory = self.root / ('capture-' + str(marker))
                directory.mkdir()
                payload = directory / 'legacy-census.node'
                payload.write_bytes(b'not loaded')
                if marker is not None:
                    (directory / '.ownership').write_text(marker+'\n')
                script = ('checkpoint_final_read() { "$@"; }; '
                    'docker() { shift 2; "$@"; }; '
                    'node() { ' + shlex.quote(real_node) + ' -e ' + shlex.quote(bootstrap) + ' "$2" "${@:3}"; };\n' +
                    function + '\nCONTAINER_ID=fixture\nNATIVE_CAPTURE_ATTEMPTED=1\nNATIVE_CAPTURE_TOKEN=owned\nNATIVE_CAPTURE_DIR=' +
                    shlex.quote(str(directory)) + '\ncleanup_native_capture')
                # env executes Node through PATH, so expose only this neutral
                # wrapper in the fixture; no real Docker command is available.
                wrapper = self.root / 'node'
                wrapper.write_text('#!/bin/bash\n[ "$1" = --no-inspect ] && shift\n[ "$1" = -e ] || exit 95\nshift\nexec '+shlex.quote(real_node)+' -e '+shlex.quote(bootstrap)+' "$@"\n')
                wrapper.chmod(0o700)
                result = subprocess.run(['bash','-c',script], text=True, capture_output=True, timeout=5,
                    env={**os.environ,'PATH':str(self.root)+os.pathsep+os.environ['PATH']})
                if marker == 'owned':
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertFalse(directory.exists())
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertTrue(payload.exists())


if __name__ == '__main__':
    assert shutil.which('node') and shutil.which('timeout'), 'Node and GNU timeout required'
    unittest.main()
