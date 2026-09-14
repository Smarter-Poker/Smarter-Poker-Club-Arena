"""Portable qualification/profile tests. All native calls and API replies here are controlled fixtures."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import subprocess
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
qualification = load('qualification', ROOT / 'server/scripts/engine-image-ci-qualification.py')
producer_tests = load('producer_test_helpers', ROOT / 'tests/operations/produce-engine-image-ci.test.py')
producer = producer_tests.producer


class QualificationTests(unittest.TestCase):
    def setUp(self):
        self.fixture = producer_tests.ProducerTests('test_complete_proof_then_outputs_and_reference_cleanup')
        self.fixture.setUp()
        self.root = self.fixture.root
        self.env = {**self.fixture.env, 'GITHUB_EVENT_NAME':'pull_request', 'GITHUB_REF':'refs/pull/4509/merge',
                    'GITHUB_WORKFLOW_REF': qualification.REPOSITORY+'/'+qualification.WORKFLOW+'@refs/pull/4509/merge',
                    'GITHUB_EVENT_PATH':str(self.root/'event.json')}
        self.event = {'number':4509,'action':'synchronize','pull_request':{'number':4509,'state':'open',
            'head':{'sha':self.fixture.target,'repo':{'full_name':qualification.REPOSITORY}},
            'base':{'sha':'e'*40,'ref':'main','repo':{'full_name':qualification.REPOSITORY}}}}
        self.write_event()
        self.identity = {**qualification.context(self.fixture.target,self.env,'linux'),
                         'merge_base_sha':'e'*40,'server_tree':self.fixture.tree,'image_id':'sha256:'+'d'*64}
        self.bundle = self.root/'engine-image-qualification-123-2'
        self.evidence = self.root/'engine-image-qualification-evidence-123-2'
        self.api_calls=[]

    def tearDown(self):self.fixture.tearDown()
    def write_event(self):Path(self.env['GITHUB_EVENT_PATH']).write_text(json.dumps(self.event))

    def make_bundle(self):
        archive=self.root/'source-image.tar';archive.write_bytes(bytes(2048))
        runtime=self.root/'runtime';runtime.mkdir();(runtime/'index.js').write_text('export const tested = true;\n')
        normalization=dict(version=1,scope='engine-image-archive-normalization',image_id=self.identity['image_id'],
            source_sha=self.identity['source_sha'],server_tree=self.identity['server_tree'],build_contract=qualification.CONTRACT,
            input_sha256='1'*64,archive_sha256=hashlib.sha256(archive.read_bytes()).hexdigest(),archive_bytes=2048,
            layers=1,platform='linux/amd64',producer_authenticated=False,host_import_qualified=False)
        result=qualification.write_bundle(self.bundle,archive,self.identity,normalization,runtime,runtime)
        return {key:result[key] for key in ('identity','archive_sha256','archive_bytes','descriptor_sha256')} | {
            'artifact_id':'456','artifact_digest':'f'*64}

    def metadata(self):
        repo={'full_name':qualification.REPOSITORY,'id':77}
        run={'id':123,'run_attempt':2,'event':'pull_request','path':qualification.WORKFLOW,
             'head_sha':self.identity['pr_head_sha'],'repository':{'id':77},'head_repository':{'id':77},
             'status':'in_progress','conclusion':None,'pull_requests':[{'number':4509,
             'head':{'sha':self.identity['pr_head_sha']},'base':{'sha':self.identity['pr_base_sha']}}]}
        artifact={'id':456,'name':'engine-image-qualification-123-2','digest':'sha256:'+'f'*64,'expired':False,
            'workflow_run':{'id':123,'head_sha':self.identity['pr_head_sha'],'repository_id':77,'head_repository_id':77}}
        jobs={'total_count':2,'jobs':[{'name':qualification.PRODUCER_JOB,'id':999,'run_id':123,
              'head_sha':self.identity['pr_head_sha'],'status':'completed','conclusion':'success'},
              {'name':'consumer','id':1000,'run_id':123,'status':'in_progress','conclusion':None}]}
        return repo,run,artifact,jobs

    def api(self, endpoint):
        self.api_calls.append(endpoint)
        repo,run,artifact,jobs=self.metadata()
        if '/git/commits/' in endpoint:return {'sha':self.identity['workflow_control_sha'],'parents':[{'sha':self.identity['merge_base_sha']},{'sha':self.identity['pr_head_sha']}]}
        if '/compare/' in endpoint:return {'base_commit':{'sha':self.identity['pr_base_sha']},'merge_base_commit':{'sha':self.identity['pr_base_sha']},'status':'identical' if self.identity['pr_base_sha']==self.identity['merge_base_sha'] else 'ahead','ahead_by':0 if self.identity['pr_base_sha']==self.identity['merge_base_sha'] else 1,'behind_by':0}
        if endpoint.endswith('/jobs?per_page=100'):return jobs
        if '/artifacts/' in endpoint:return artifact
        if '/attempts/' in endpoint:return run
        return repo

    def command(self,args,**kwargs):
        if args[:2]==['git','rev-list']:
            self.fixture.commands.append((args,kwargs))
            return ' '.join((self.fixture.control,'e'*40,self.fixture.target))
        return self.fixture.fake_command(args,**kwargs)

    def test_genuine_pr_context_keeps_control_and_head_identities_distinct(self):
        observed=qualification.context(self.fixture.target,self.env,'linux')
        self.assertEqual(observed['workflow_control_sha'],self.env['GITHUB_SHA'])
        self.assertEqual(observed['source_sha'],self.event['pull_request']['head']['sha'])
        self.assertNotEqual(observed['workflow_control_sha'],observed['source_sha'])
        self.assertEqual(observed['purpose'],'qualification-only')
        with self.assertRaisesRegex(RuntimeError,'RELEASE_CONTEXT_REQUIRED'):
            producer.context(self.fixture.target,self.env,'linux')

    def test_other_events_forks_refs_or_source_cannot_select_the_profile(self):
        cases=[('GITHUB_EVENT_NAME','repository_dispatch'),('GITHUB_EVENT_NAME','pull_request_target'),
               ('GITHUB_REPOSITORY','elsewhere/repo'),('GITHUB_SHA','bad'),('GITHUB_REF','refs/heads/main'),
               ('GITHUB_WORKFLOW_REF',qualification.REPOSITORY+'/.github/workflows/auto-deploy-hetzner.yml@refs/heads/main')]
        for key,value in cases:
            with self.subTest(key=key),self.assertRaises(ValueError):
                qualification.context(self.fixture.target,{**self.env,key:value},'linux')
        self.event['pull_request']['head']['repo']['full_name']='fork/repo';self.write_event()
        with self.assertRaisesRegex(ValueError,'SAME_REPOSITORY'):
            qualification.context(self.fixture.target,self.env,'linux')
        with self.assertRaisesRegex(ValueError,'DISPOSABLE_CI'):
            qualification.context(self.fixture.target,self.env,'darwin')

    def test_merge_control_must_have_two_ordered_parents_and_the_exact_event_head(self):
        self.assertEqual(qualification.verify_git_source(self.identity,self.command),self.fixture.tree)
        for wrong in ('bad',' '.join((self.fixture.control,self.fixture.target,'e'*40)),
                      ' '.join((self.fixture.control,'e'*40,self.fixture.target,'0'*40))):
            def run(args,**kwargs):return wrong if args[:2]==['git','rev-list'] else self.command(args,**kwargs)
            with self.subTest(wrong=wrong),self.assertRaisesRegex(ValueError,'MERGE_PARENTS'):
                qualification.verify_git_source(self.identity,run)

    def test_actual_git_accepts_forward_main_parent_and_refuses_rewind(self):
        with tempfile.TemporaryDirectory(prefix='qualification-merge-') as temporary:
            root=Path(temporary)
            env={k:v for k,v in os.environ.items() if not k.startswith('GIT_')}
            env.update(GIT_CONFIG_NOSYSTEM='1',GIT_CONFIG_GLOBAL=os.devnull,GIT_NO_REPLACE_OBJECTS='1')
            def git(*args):
                return subprocess.check_output(['git',*args],cwd=root,env=env,stderr=subprocess.PIPE,text=True).strip()
            git('init','-q','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid')
            git('config','commit.gpgsign','false');git('config','core.hooksPath',str(root/'no-hooks'))
            (root/'server').mkdir();(root/'server/a').write_text('base');git('add','.');git('commit','-qm','base');base=git('rev-parse','HEAD')
            git('switch','-qc','feature');(root/'server/feature').write_text('feature');git('add','.');git('commit','-qm','head');head=git('rev-parse','HEAD')
            git('switch','-q','main');(root/'server/main').write_text('later main');git('add','.');git('commit','-qm','main advances');actual_base=git('rev-parse','HEAD')
            git('switch','-qc','qualification');git('merge','--no-ff','-m','synthetic merge','feature');control=git('rev-parse','HEAD')
            git('update-ref','refs/remotes/origin/main',actual_base)
            identity={**self.identity,'workflow_control_sha':control,'source_sha':head,'pr_head_sha':head,'pr_base_sha':base}
            def run(args,**kwargs):return git(*args[1:])
            self.assertEqual(qualification.verify_git_source(identity,run),git('rev-parse',head+':server'))
            self.assertEqual(identity['merge_base_sha'],actual_base)
            self.assertNotEqual(identity['pr_base_sha'],identity['merge_base_sha'])
            git('update-ref','refs/remotes/origin/main',base)
            with self.assertRaises(subprocess.CalledProcessError):qualification.verify_git_source(identity,run)
            git('update-ref','refs/remotes/origin/main',actual_base)
            with self.assertRaises(subprocess.CalledProcessError):qualification.verify_git_source({**identity,'pr_base_sha':head},run)

    def test_consumer_authenticates_actual_merge_parents_and_forward_recorded_base(self):
        identity={**self.identity,'merge_base_sha':'9'*40}
        commit={'sha':identity['workflow_control_sha'],'parents':[{'sha':identity['merge_base_sha']},{'sha':identity['pr_head_sha']}]}
        comparison={'base_commit':{'sha':identity['pr_base_sha']},'merge_base_commit':{'sha':identity['pr_base_sha']},'status':'ahead','ahead_by':3,'behind_by':0}
        qualification.validate_merge_metadata(identity,commit,comparison)
        for wrong in ({**commit,'sha':'8'*40},{**commit,'parents':list(reversed(commit['parents']))},{**commit,'parents':commit['parents']+[{'sha':'7'*40}]}):
            with self.subTest(wrong=wrong),self.assertRaisesRegex(ValueError,'API_MERGE_PARENTS'):qualification.validate_merge_metadata(identity,wrong,comparison)
        for wrong in ({**comparison,'status':'diverged'},{**comparison,'behind_by':1},{**comparison,'ahead_by':True},{**comparison,'merge_base_commit':{'sha':'8'*40}}):
            with self.subTest(wrong=wrong),self.assertRaisesRegex(ValueError,'API_BASE_ANCESTRY'):qualification.validate_merge_metadata(identity,commit,wrong)

    def test_actual_producer_profile_runs_one_proof_then_promotes_separate_schema(self):
        calls=[]
        real=self.fixture.proof().main
        def native(**kwargs):calls.append(kwargs);return real(**kwargs)
        from types import SimpleNamespace
        result=producer.produce(self.fixture.target,self.bundle,self.evidence,environment=self.env,
            platform='linux',run=self.command,proof_module=SimpleNamespace(main=native),profile='qualification')
        self.assertEqual(len(calls),1)
        self.assertEqual(result['identity']['purpose'],'qualification-only')
        self.assertEqual(json.loads((self.bundle/'engine-image.json').read_text())['schema'],'engine-ci-qualification-image-v1')
        self.assertEqual(sum(args[:2]==['npm','ci'] for args,_ in self.fixture.commands),1)
        for _,kwargs in self.fixture.commands:
            for key in ('GITHUB_EVENT_NAME','GITHUB_SHA','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT'):
                self.assertEqual(kwargs['environment'][key],self.env[key])
        receipt=json.loads((self.evidence/'producer-receipt.json').read_text())
        self.assertEqual(receipt['profile'],'qualification')
        self.assertTrue(receipt['owned_reference_source_removed'])
        self.assertFalse(receipt['deployment_authorized'])

    def test_failed_native_proof_never_promotes_qualification_bytes(self):
        with self.assertRaisesRegex(RuntimeError,'simulated native cleanup'):
            producer.produce(self.fixture.target,self.bundle,self.evidence,environment=self.env,
                platform='linux',run=self.command,proof_module=self.fixture.proof('exception_after_callback'),profile='qualification')
        self.assertFalse(self.bundle.exists())
        self.assertEqual(json.loads((self.evidence/'producer-receipt.json').read_text())['status'],'failed')

    def test_production_bundle_rejects_qualification_identity_and_bytes(self):
        expected=self.make_bundle()
        with self.assertRaisesRegex(ValueError,'IDENTITY_SHAPE'):
            qualification.production.validate_files(self.bundle,expected)
        with self.assertRaisesRegex(ValueError,'IDENTITY_SHAPE'):
            qualification.production.validate_github_metadata(*self.metadata(),expected,self.env)
        identity={k:v for k,v in self.identity.items() if k in ('repository','workflow','workflow_control_sha',
                  'source_sha','server_tree','run_id','run_attempt','image_id')}
        with self.assertRaisesRegex(ValueError,'PRODUCER_REPOSITORY_WORKFLOW'):
            qualification.production.check_identity(identity)

    def test_authentication_custody_and_refusals_complete_without_env_spoofing(self):
        expected=self.make_bundle();before=dict(self.env)
        with patch.object(qualification.sys,'platform','linux'):
            receipt=qualification.qualify_received(self.bundle,expected,self.root/'admission',self.env,self.api)
        self.assertEqual(receipt['status'],'passed')
        self.assertEqual(set(receipt['refusals']),{'live_artifact_digest','stale_identity','production_profile',
                                                 'archive_bytes','descriptor_bytes'})
        self.assertEqual(len(self.api_calls),16)
        self.assertEqual(self.env,before)
        self.assertTrue(receipt['owned_fault_files_removed'])
        self.assertFalse(receipt['production_admission'])
        self.assertFalse(receipt['host_import_qualified'])
        self.assertFalse(receipt['deployment_authorized'])

    def test_foreign_execution_context_refuses_before_api_or_evidence_creation(self):
        expected=self.make_bundle()
        with patch.object(qualification.sys,'platform','darwin'),self.assertRaisesRegex(ValueError,'DISPOSABLE_CI'):
            qualification.qualify_received(self.bundle,expected,self.root/'must-not-exist',self.env,self.api)
        self.assertFalse((self.root/'must-not-exist').exists())
        self.assertEqual(self.api_calls,[])
        foreign={**self.env,'GITHUB_EVENT_NAME':'repository_dispatch'}
        with patch.object(qualification.sys,'platform','linux'),self.assertRaisesRegex(ValueError,'PR_REQUIRED'):
            qualification.admit(self.bundle,expected,foreign,self.api)
        self.assertEqual(self.api_calls,[])

    def test_evidence_outside_owned_runner_area_refuses_before_api(self):
        expected=self.make_bundle()
        with patch.object(qualification.sys,'platform','linux'),self.assertRaisesRegex(ValueError,'EVIDENCE_PATH'):
            qualification.qualify_received(self.bundle,expected,self.root/'missing-parent'/'outside',self.env,self.api)
        self.assertEqual(self.api_calls,[])
        self.assertFalse((self.root/'missing-parent').exists())

    def test_wrong_api_provenance_cannot_pass(self):
        expected=self.make_bundle()
        mutations=[(0,'full_name','other/repo'),(0,'id',True),(1,'event','repository_dispatch'),
                   (1,'head_sha','0'*40),(1,'path','.github/workflows/auto-deploy-hetzner.yml'),
                   (1,'run_attempt',1),(1,'pull_requests',[]),(2,'id',457),(2,'digest','sha256:'+'0'*64),
                   (2,'expired',True),(2,'name','engine-image-123-2'),(3,'total_count',101)]
        for index,key,value in mutations:
            objects=list(self.metadata());objects[index][key]=value
            with self.subTest(index=index,key=key),patch.object(qualification.sys,'platform','linux'),self.assertRaises(ValueError):
                qualification.validate_github_metadata(*objects,expected,self.env)
        for value in ('failure','cancelled','skipped',None):
            objects=list(self.metadata());objects[3]['jobs'][0]['conclusion']=value
            with self.subTest(value=value),patch.object(qualification.sys,'platform','linux'),self.assertRaisesRegex(ValueError,'PRODUCER_SUCCESS'):
                qualification.validate_github_metadata(*objects,expected,self.env)
        for mutate in ('duplicate','foreign_repository','wrong_head'):
            objects=list(self.metadata())
            if mutate=='duplicate':objects[3]['jobs'].append(copy.deepcopy(objects[3]['jobs'][0]));objects[3]['total_count']+=1
            elif mutate=='foreign_repository':objects[2]['workflow_run']['head_repository_id']=999
            else:objects[3]['jobs'][0]['head_sha']='0'*40
            with self.subTest(mutate=mutate),patch.object(qualification.sys,'platform','linux'),self.assertRaises(ValueError):
                qualification.validate_github_metadata(*objects,expected,self.env)

    def test_bytes_changed_during_api_reads_fail_after_authentication(self):
        expected=self.make_bundle()
        def api(endpoint):
            result=self.api(endpoint)
            if endpoint.endswith('/jobs?per_page=100'):(self.bundle/'engine-image.tar').write_bytes(b'changed')
            return result
        with patch.object(qualification.sys,'platform','linux'),self.assertRaisesRegex(ValueError,'ARCHIVE_DIGEST'):
            qualification.admit(self.bundle,expected,self.env,api)

    def test_api_failure_or_missing_refusal_never_emits_passed_receipt(self):
        expected=self.make_bundle()
        def failed(endpoint):raise ValueError('ENGINE_CI_IMAGE_GITHUB_READ')
        with patch.object(qualification.sys,'platform','linux'),self.assertRaisesRegex(ValueError,'GITHUB_READ'):
            qualification.qualify_received(self.bundle,expected,self.root/'failed',self.env,failed)
        self.assertEqual(json.loads((self.root/'failed/qualification-receipt.json').read_text())['status'],'failed')
        with self.assertRaisesRegex(ValueError,'MISSING_REFUSAL'):
            qualification.require_refusal(lambda:None,'GITHUB_ARTIFACT')
        with self.assertRaisesRegex(ValueError,'WRONG_REFUSAL'):
            qualification.require_refusal(lambda:qualification.require(False,'OTHER'),'GITHUB_ARTIFACT')


if __name__=='__main__':unittest.main()
