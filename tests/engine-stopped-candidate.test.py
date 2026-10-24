"""Execute canonical engine-up against an isolated, durable fake Docker daemon."""
import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SHA = 'a' * 40
IMAGE = 'sha256:' + 'a' * 64
CID = 'c' * 64
ZERO = '0001-01-01T00:00:00Z'
DOCKER = r'''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
p=Path(os.environ['FAKE_STATE']); d=json.loads(p.read_text()); a=sys.argv[1:]
with open(os.environ['FAKE_CALLS'],'a') as f: f.write(json.dumps(a)+'\n')
def save(): p.write_text(json.dumps(d))
if a[:2]==['image','inspect']:
 print(json.dumps([d['image']])); sys.exit(0)
if a[:2]==['container','ls']: sys.exit(0)
if a[:2]==['container','inspect']:
 x=d['containers'].get(a[-1]); print(json.dumps([x]) if x else '[]'); sys.exit(0 if x else 1)
if a[0]=='inspect':
 x=d['containers'].get(a[-1]);
 if not x: sys.exit(1)
 field=a[2]
 print(x['Id'] if '.Id' in field else x['State']['Status']); sys.exit(0)
if a[0]=='create':
 name=a[a.index('--name')+1]
 if name in d['containers']: sys.exit(1)
 labels={}
 for i,v in enumerate(a):
  if v=='--label': k,val=a[i+1].split('=',1); labels[k]=val
 d['containers'][name]={'Id':'c'*64,'Image':a[-1], 'Config':{'Labels':labels},
 'State':{'Status':'created','Running':False,'Restarting':False,'StartedAt':'0001-01-01T00:00:00Z'},
 'HostConfig':{'RestartPolicy':{'Name':a[a.index('--restart')+1]}}}
 save(); print('c'*64); sys.exit(0)
if a[0]=='rename':
 if a[2] in d['containers']: sys.exit(1)
 d['containers'][a[2]]=d['containers'].pop(a[1]); save(); sys.exit(0)
if a[0]=='start':
 x=d['containers'][a[1]]; x['State'].update(Status='running',Running=True,StartedAt='2026-10-24T07:00:00Z'); save(); print(a[1]); sys.exit(0)
if a[0]=='rm':
 x=d['containers'][a[1]]
 if x['State']['Running']: sys.exit(1)
 del d['containers'][a[1]]; save(); sys.exit(0)
if a[0]=='stop':
 d['containers'][a[-1]]['State'].update(Status='exited',Running=False); save(); sys.exit(0)
if a[0]=='update': sys.exit(0)
sys.exit(1)
'''

class StoppedCandidate(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='engine-stopped-')
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        (self.path/'bin').mkdir()
        for name, source in [('docker', DOCKER), ('flock', '#!/bin/sh\nexit 0\n'),
                             ('seal', '#!/bin/sh\n[ "$1" = authorize ] || exit 1\n[ "$3" = --token-stdin ] || [ "$4" = --token-stdin ] || exit 1\nread token\n[ "$token" = valid-token ] || exit 1\necho pending '+SHA+' '+IMAGE+'\n')]:
            target=self.path/'bin'/name; target.write_text(source); target.chmod(0o755)
        self.state=self.path/'state.json'; self.calls=self.path/'calls.jsonl'
        self.state.write_text(json.dumps({'image':{'Id':IMAGE,'Config':{'Labels':{'org.opencontainers.image.revision':SHA},'Env':['GIT_COMMIT_SHA='+SHA]}}, 'containers':{}}))
        self.calls.touch()
        self.config=self.path/'engine.env'; self.config.write_text('DATABASE_URL=isolated.invalid\n')
        self.env={**os.environ,'PATH':str(self.path/'bin')+':'+os.environ['PATH'],
          'FAKE_STATE':str(self.state),'FAKE_CALLS':str(self.calls), 'ENGINE_UP_STAGED_RUN':'42-1',
          'ENGINE_UP_PREPARED_SHA':SHA,'IMAGE':IMAGE,'CONTAINER':'fixture-engine',
          'ENV_FILE':str(self.config),'ENGINE_RELEASE_SEAL':str(self.path/'bin'/'seal'),
          'LOCK_FILE':str(self.path/'lock'),'LOG_DIR':str(self.path/'logs'),
          'ENGINE_ALERT_JOURNAL_HOST_DIR':str(self.path/'alerts'),
          'ENGINE_HORSE_JOURNAL_HOST_DIR':str(self.path/'decisions')}
        self.script=str(ROOT/'server/scripts/engine-up.sh')

    def run_up(self, **env):
        return subprocess.run(['bash','-c','exec 3<<<"${TEST_TOKEN:-valid-token}"; exec bash "$1"','_',self.script],
            env={**self.env,**env},text=True,capture_output=True,timeout=15)

    def operations(self):
        return [json.loads(s) for s in self.calls.read_text().splitlines()]

    def prepare(self):
        result=self.run_up(ENGINE_UP_PREPARE_STOPPED='1')
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertFalse(any(c[0] in ('stop','start','run','rename') for c in self.operations()))
        self.assertIn('phase=create-returned',result.stderr)
        return json.loads(self.state.read_text())

    def test_prepare_never_executes_and_original_authority_starts_same_container(self):
        original=self.prepare(); staged=original['containers']['fixture-engine-prepared-42-1']
        self.assertEqual(staged['State']['Status'],'created')
        self.assertEqual(staged['HostConfig']['RestartPolicy']['Name'],'no')
        self.assertEqual(staged['Image'],IMAGE)
        again=self.run_up(ENGINE_UP_PREPARE_STOPPED='1'); self.assertEqual(again.returncode,0,again.stderr)
        self.assertEqual(sum(c[0]=='create' for c in self.operations()),1)
        result=self.run_up(ENGINE_RELEASE_TOKEN_FD='3')
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertIn(CID,result.stdout)
        self.assertIn('phase=start-returned',result.stderr)
        self.assertEqual(sum(c[0]=='create' for c in self.operations()),1)
        self.assertEqual(sum(c[0]=='start' for c in self.operations()),1)
        live=json.loads(self.state.read_text())['containers']['fixture-engine']
        self.assertTrue(live['State']['Running'])
        cleanup=self.run_up(ENGINE_UP_REMOVE_STOPPED='1'); self.assertEqual(cleanup.returncode,0,cleanup.stderr)
        self.assertTrue(json.loads(self.state.read_text())['containers']['fixture-engine']['State']['Running'])

    def test_invalid_authority_cannot_start_or_rename_preparation(self):
        self.prepare(); before=self.state.read_bytes()
        result=self.run_up(ENGINE_RELEASE_TOKEN_FD='3',TEST_TOKEN='wrong-token')
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(self.state.read_bytes(),before)
        result=self.run_up()
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(self.state.read_bytes(),before)

    def test_changed_state_image_owner_spec_and_config_refuse_before_serving_mutation(self):
        original=self.prepare()
        mutations=[lambda x:x.update(Image='sha256:'+'b'*64),
          lambda x:x['State'].update(Running=True,Status='running'),
          lambda x:x['State'].update(StartedAt='2026-10-24T06:00:00Z'),
          lambda x:x['State'].update(Status='exited'),
          lambda x:x['Config']['Labels'].update({'sp.release.prepared-run':'43-1'}),
          lambda x:x['Config']['Labels'].update({'sp.release.prepared-spec':'wrong'}),
          lambda x:x['Config']['Labels'].update({'sp.release.sha':'b'*40}),
          lambda x:x['HostConfig']['RestartPolicy'].update(Name='always')]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                d=copy.deepcopy(original); mutate(d['containers']['fixture-engine-prepared-42-1']); self.state.write_text(json.dumps(d))
                before=self.state.read_bytes(); calls=len(self.operations())
                result=self.run_up(ENGINE_RELEASE_TOKEN_FD='3'); self.assertNotEqual(result.returncode,0,result.stdout)
                self.assertEqual(self.state.read_bytes(),before)
                self.assertFalse(any(c[0] in ('stop','start','run','rename','rm') for c in self.operations()[calls:]))
                cleanup=self.run_up(ENGINE_UP_REMOVE_STOPPED='1'); self.assertNotEqual(cleanup.returncode,0)
                self.assertEqual(self.state.read_bytes(),before)
        self.state.write_text(json.dumps(original)); self.config.write_text('DATABASE_URL=changed.invalid\n')
        result=self.run_up(ENGINE_RELEASE_TOKEN_FD='3'); self.assertNotEqual(result.returncode,0)
        self.assertEqual(json.loads(self.state.read_text()),original)

    def test_cleanup_removes_only_owned_never_started_container(self):
        self.prepare(); result=self.run_up(ENGINE_UP_REMOVE_STOPPED='1')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(self.state.read_text())['containers'],{})
        self.assertFalse(any(c[0] in ('stop','start','run','rename') for c in self.operations()))

    def test_invalid_expected_revision_and_run_key_never_create(self):
        for settings in [{'ENGINE_UP_PREPARED_SHA':'b'*40},{'ENGINE_UP_STAGED_RUN':'../other'},
                         {'ENGINE_RELEASE_TOKEN_FD':'3'},{'ENGINE_RELEASE_TOKEN':'forbidden'}]:
            result=self.run_up(ENGINE_UP_PREPARE_STOPPED='1',**settings)
            self.assertNotEqual(result.returncode,0)
            self.assertEqual(json.loads(self.state.read_text())['containers'],{})

if __name__=='__main__': unittest.main()
