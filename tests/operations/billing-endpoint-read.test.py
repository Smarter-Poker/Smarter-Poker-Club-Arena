#!/usr/bin/env python3
"""Finite local qualification: real Node parser, fixed transport and refusal boundaries."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
SPEC=importlib.util.spec_from_file_location('billing_reader',ROOT/'scripts/ci/read-scoped-billing-endpoints.py')
R=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(R)
REQUEST={'releaseSha':'a'*40,'imageId':'sha256:'+'b'*64}
IDENTITY={'releaseSha':'a'*40,'instanceId':'one-instance'}
CONTAINER={'containerId':'c'*64,'imageId':REQUEST['imageId'],'running':'true','startedAt':'2026-10-19T15:00:00Z','hostPid':'123','restartCount':'0'}


def node_read(environment, argv=None, binary_same=True):
    # Execute the actual fixed Node code. Only /proc metadata is isolated;
    # URL parsing, explicit env selection and emitted JSON are real Node.
    harness=r"""
const vm=require('node:vm');
const input=JSON.parse(process.argv[1]);
const fs={readFileSync:()=>input.argv.join('\0')+'\0',statSync:path=>({dev:1,ino:path==='/proc/1/exe'||input.same?1:2})};
try{vm.runInNewContext(input.source,{require:name=>{if(name!=='node:fs')throw Error('Unexpected import');return fs},URL,process:{env:input.environment,execPath:'/node',version:process.version},console:{log:value=>process.stdout.write(value+'\n')}})}
catch{process.stderr.write('Endpoint refused\n');process.exitCode=1}
"""
    return subprocess.run(['node','-e',harness,json.dumps({'source':R.NODE_READ,'environment':environment,'argv':argv or ['node','dist/index.js'],'same':binary_same})],capture_output=True,text=True,timeout=5)


def result():
    return {'schema':R.SCHEMA,'readOnly':True,'hostBefore':IDENTITY.copy(),'hostAfter':IDENTITY.copy(),'containerBefore':CONTAINER.copy(),'containerAfter':CONTAINER.copy(),'imageReleaseSha':REQUEST['releaseSha'],'nodeVersion':'v22.0.0','argv':['node','dist/index.js'],'endpoints':[{'name':n,'configured':False,'hostname':None,'port':None} for n in R.FIELDS]}


class BillingEndpointRead(unittest.TestCase):
    def test_real_node_exports_only_hosts_and_ports(self):
        secret='never-export-this-password'
        p=node_read({'SUPABASE_URL':'https://user:'+secret+'@primary.supabase.co/private?token='+secret+'#'+secret,'DATABASE_URL':'postgresql://user:'+secret+'@aws-0.pooler.supabase.com:6543/postgres?password='+secret,'ENGINE_PG_LISTEN_URL':'postgres://user:'+secret+'@replica.supabase.co/postgres','UNRELATED_SECRET':secret})
        self.assertEqual(p.returncode,0,p.stderr)
        self.assertNotIn(secret,p.stdout+p.stderr)
        rows=json.loads(p.stdout)['endpoints']
        self.assertEqual(rows,[{'name':'SUPABASE_URL','configured':True,'hostname':'primary.supabase.co','port':443},{'name':'DATABASE_URL','configured':True,'hostname':'aws-0.pooler.supabase.com','port':6543},{'name':'ENGINE_PG_LISTEN_URL','configured':True,'hostname':'replica.supabase.co','port':5432}])
        self.assertNotIn('UNRELATED_SECRET',p.stdout)

    def test_unset_is_unknown_configuration_not_primary_assumption(self):
        p=node_read({});self.assertEqual(p.returncode,0)
        self.assertTrue(all(x['configured'] is False and x['hostname'] is None and x['port'] is None for x in json.loads(p.stdout)['endpoints']))

    def test_malformed_or_unsafe_values_refuse_without_echo(self):
        for value in ['not-a-url-secret','https://host\nsecret',' http://host','http://host','file:///etc/passwd','https://host:99999','https://[::1]','https://host/ '+ 'secret']:
            with self.subTest(value=value):
                p=node_read({'SUPABASE_URL':value});self.assertNotEqual(p.returncode,0);self.assertEqual(p.stdout,'');self.assertEqual(p.stderr,'Endpoint refused\n')
        self.assertNotEqual(node_read({'DATABASE_URL':'https://host'}).returncode,0)

    def test_other_process_or_binary_refused(self):
        self.assertNotEqual(node_read({},argv=['node','other.js']).returncode,0)
        self.assertNotEqual(node_read({},binary_same=False).returncode,0)

    def test_exact_selection_no_command_or_endpoint_input(self):
        self.assertEqual(R.selection(REQUEST.copy()),REQUEST)
        for bad in [None,{},dict(REQUEST,command='env'),dict(REQUEST,host='foreign'),dict(REQUEST,releaseSha='a'*39)]:
            with self.assertRaises((ValueError,TypeError)):R.selection(bad)

    def test_unknown_and_schedule_admission_refused_before_transport(self):
        for event in ['schedule','workflow_dispatch','push']:
            with patch.dict(os.environ,{'GITHUB_EVENT_NAME':event},clear=True),patch.object(R.sys,'argv',['reader']),patch.object(R,'health') as h:
                with self.assertRaises(RuntimeError):R.main()
                h.assert_not_called()

    def test_result_identity_and_output_shape_refusals(self):
        self.assertEqual(R.validate_result(result(),REQUEST)['schema'],R.SCHEMA)
        mutations=[lambda d:d.update(secret='opaque'),lambda d:d['hostAfter'].update(instanceId='other'),lambda d:d['containerAfter'].update(restartCount='1'),lambda d:d.update(imageReleaseSha='d'*40),lambda d:d['endpoints'][0].update(secret='opaque'),lambda d:d['endpoints'][0].update(hostname='opaque'),lambda d:d['endpoints'][0].update(configured=True,hostname='user:secret@host',port=443),lambda d:d['endpoints'][0].update(configured=True,hostname='host',port=True),lambda d:d['endpoints'].pop(),lambda d:d['endpoints'].reverse()]
        for mutate in mutations:
            d=result();mutate(d)
            with self.assertRaises(RuntimeError):R.validate_result(d,REQUEST)

    def test_remote_uses_only_fixed_command_and_no_env_dump(self):
        native={'nodeVersion':'v22.0.0','argv':['node','dist/index.js'],'endpoints':result()['endpoints']}
        with patch.object(R,'health',return_value=IDENTITY),patch.object(R,'container_identity',return_value=CONTAINER),patch.object(R,'run_read',side_effect=[REQUEST['releaseSha'].encode(),json.dumps(native).encode()]) as read:
            R.remote(REQUEST)
            self.assertEqual(read.call_args_list[1].args[0],['docker','exec',CONTAINER['containerId'],'node','-e',R.NODE_READ])
        self.assertEqual(R.NODE_READ.count('fs.readFileSync('),1)
        self.assertIn("fs.readFileSync('/proc/1/cmdline'",R.NODE_READ)
        self.assertNotIn('Object.entries(process.env)',R.NODE_READ)

    def test_native_cannot_override_identity_or_add_secret_fields(self):
        for native in [{'hostBefore':IDENTITY}, {'nodeVersion':'v22.0.0','argv':['node','dist/index.js'],'endpoints':result()['endpoints'],'secret':'opaque'}]:
            with patch.object(R,'health',return_value=IDENTITY),patch.object(R,'container_identity',return_value=CONTAINER),patch.object(R,'run_read',side_effect=[REQUEST['releaseSha'].encode(),json.dumps(native).encode()]):
                with self.assertRaises(RuntimeError):R.remote(REQUEST)

    def test_workflow_optin_and_qualification_wiring(self):
        text=(ROOT/'.github/workflows/production-integrity-audit.yml').read_text()
        job=text.split('  scoped_billing_endpoints:',1)[1].split('\n  scoped_',1)[0]
        self.assertIn("github.event_name == 'repository_dispatch'",job)
        self.assertIn('github.event.client_payload.billing_endpoint_observation != null',job)
        self.assertIn('python3 -B tests/operations/billing-endpoint-read.test.py',job)
        self.assertIn('HETZNER_HOST_KEY: ${{ secrets.HETZNER_HOST_KEY }}',job)
        self.assertNotIn('issues: write',job)
        source=(ROOT/'scripts/ci/read-scoped-billing-endpoints.py').read_text()
        for bound in ['StrictHostKeyChecking=yes','GlobalKnownHostsFile=/dev/null','timeout=70','containerAfter','Public and host engine identity changed or differ']:
            self.assertIn(bound,source)


if __name__=='__main__':unittest.main()
