import importlib.util
import io
import json
import hashlib
from pathlib import Path
import tarfile
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4
import zipfile

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('stage', ROOT / 'operations/release/native/engine-stage-boundary.py')
STAGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(STAGE)

class NativeStage(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / 'state'; self.state.mkdir()
        self.scripts = self.root / 'controls'; self.scripts.mkdir()
        (self.scripts / 'helper.sh').write_text('#!/bin/sh\nexit 0\n')
        self.controls = {'helper.sh': hashlib.sha256((self.scripts/'helper.sh').read_bytes()).hexdigest()}
        self.config = {'trusted_control_sha': 'c'*40, 'control_files': self.controls}
        config = b'{"created":"native-fixture"}'
        self.identity = 'sha256:' + hashlib.sha256(config).hexdigest()
        self.build_id = str(uuid4())
        tar = io.BytesIO()
        with tarfile.open(fileobj=tar, mode='w') as archive:
            for name, body in [('config.json', config), ('manifest.json', json.dumps([{'Config': 'config.json',
                 'RepoTags': ['club-arena-release-candidate:'+self.build_id], 'Layers': []}]).encode())]:
                info = tarfile.TarInfo(name); info.size=len(body); archive.addfile(info, io.BytesIO(body))
        self.tar = tar.getvalue(); zipbuf = io.BytesIO()
        with zipfile.ZipFile(zipbuf, 'w') as archive:
            archive.writestr('engine-image.tar', self.tar)
        self.zip = zipbuf.getvalue()
        self.request = {'target': 'club-arena-engine', 'source_sha': 'a'*40, 'control_sha': 'c'*40,
            'server_tree_sha': 'b'*40, 'manifest_digest': 'd'*64, 'run_key': '123-1',
            'github_artifact_id': '45', 'artifact_image_id': self.identity,
            'archive_digest': 'sha256:'+hashlib.sha256(self.tar).hexdigest(), 'archive_bytes': len(self.tar),
            'github_archive_digest': 'sha256:'+hashlib.sha256(self.zip).hexdigest(), 'github_archive_bytes': len(self.zip),
            'build_operation_id': self.build_id, 'not_after_epoch': int(time.time())+600,
            'expected_current': {'source_sha': '9'*40, 'image_id': 'sha256:'+'9'*64}}
        self.envelope = {'operation_id': str(uuid4()), 'epoch': str(uuid4()), 'request': self.request}
        self.folder = self.state/self.envelope['operation_id']
        self.loaded=False; self.loads=0; self.commands=[]
        def secure(path, file=True):
            path=Path(path)
            if str(path).startswith('/etc/systemd'):
                return path
            self.assertFalse(path.is_symlink())
            return path
        self.patches=[patch.object(STAGE, 'STATE', self.state), patch.object(STAGE, 'BUILD_LOCK', self.root/'build.lock'),
            patch.object(STAGE.BASE, 'STAGING', self.root/'staged'), patch.object(STAGE.BASE, 'LEASE_ROOT', self.root/'leases'),
            patch.object(STAGE, 'secure', side_effect=secure), patch.object(STAGE.BASE, 'secure', side_effect=secure),
            patch.object(STAGE, 'check', return_value=(self.request,self.scripts)),
            patch.object(STAGE, 'prior_seal'), patch.object(STAGE, 'command', side_effect=self.command),
            patch.object(STAGE, 'inspect_image', side_effect=lambda *args: self.loaded),
            patch.object(STAGE.subprocess, 'run', side_effect=self.load),
            patch.object(STAGE.shutil, 'disk_usage', return_value=SimpleNamespace(free=10**12))]
        for p in self.patches: p.start(); self.addCleanup(p.stop)
    def command(self, args, **kwargs):
        self.commands.append([str(x) for x in args])
        return SimpleNamespace(returncode=0,stdout='LoadState=loaded\nActiveState=inactive\nJob=0\n')
    def load(self, args, **kwargs):
        self.loads+=1; self.loaded=True
        return SimpleNamespace(returncode=0)
    def receive(self): return STAGE.receive(self.envelope, io.BytesIO(self.zip), self.config)
    def test_transfer_stage_and_idempotent_recovery_preserve_exact_image_and_existing_lease(self):
        self.receive(); self.assertEqual(self.loads,0)
        result=STAGE.apply(self.envelope['operation_id'],self.config)
        self.assertTrue(result['terminal']); self.assertEqual(result['image_id'],self.identity)
        self.assertEqual((self.root/'leases/123-1.lease').read_text(),'a'*40+'\n')
        self.assertEqual(STAGE.observe(self.envelope,self.config),result)
        self.assertEqual(STAGE.apply(self.envelope['operation_id'],self.config),result)
        self.assertEqual(self.loads,1)
        self.assertFalse(any('restart' in command for command in self.commands))
    def test_lost_docker_response_never_loads_twice_and_readback_finishes_same_owned_stage(self):
        self.receive()
        def lose(*args,**kwargs): self.loads+=1; raise TimeoutError('fixture-only')
        with patch.object(STAGE.subprocess,'run',side_effect=lose):
            with self.assertRaises(TimeoutError): STAGE.apply(self.envelope['operation_id'],self.config)
        self.assertFalse(STAGE.apply(self.envelope['operation_id'],self.config)['terminal'])
        self.assertEqual(self.loads,1)
        self.loaded=True
        self.assertTrue(STAGE.observe(self.envelope,self.config)['terminal'])
        self.assertEqual(self.loads,1)
    def test_incomplete_transfer_has_terminal_failure_only_after_native_receiver_is_gone(self):
        with self.assertRaises(ValueError): STAGE.receive(self.envelope,io.BytesIO(self.zip[:10]),self.config)
        result=STAGE.observe(self.envelope,self.config)
        self.assertEqual(result['outcome'],'FAILED'); self.assertEqual(self.loads,0)
    def test_native_resume_after_archive_acceptance_and_receiver_response_loss(self):
        self.receive(); self.commands.clear()
        result=STAGE.observe(self.envelope,self.config)
        self.assertFalse(result['terminal']); self.assertTrue(any('start' in c for c in self.commands))
        self.assertEqual(self.loads,0)
    def test_tampered_archive_and_wrong_image_manifest_refuse_before_docker_load(self):
        self.receive()
        (self.folder/'artifact.zip').write_bytes(b'changed')
        with self.assertRaises(ValueError): STAGE.apply(self.envelope['operation_id'],self.config)
        self.assertEqual(self.loads,0)
    def test_expiration_after_unknown_load_is_not_success_or_a_second_load(self):
        self.receive(); STAGE.persist(self.folder/'load-intent.json',{'image_id':self.identity,'archive_digest':self.request['archive_digest']})
        with patch.object(STAGE.time,'time',return_value=self.request['not_after_epoch']+1):
            self.assertFalse(STAGE.observe(self.envelope,self.config)['terminal'])
            self.loaded=True
            self.assertEqual(STAGE.observe(self.envelope,self.config)['outcome'],'FAILED')
        self.assertEqual(self.loads,0)

if __name__=='__main__': unittest.main()
