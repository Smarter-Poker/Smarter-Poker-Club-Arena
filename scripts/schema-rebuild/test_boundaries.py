import importlib.util,json,tempfile,unittest,os,subprocess,sys
from pathlib import Path
p=Path(__file__).with_name('verify.py');spec=importlib.util.spec_from_file_location('rebuild',p);v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
class Boundaries(unittest.TestCase):
 def test_required_private_real_scratch(self):
  with self.assertRaises(v.Refused):v.validate_parent('/does/not/exist')
 def test_catalog_detects_missing_routine_constraint_policy_and_acl(self):
  for category in ['relations','routines','types','event_triggers','defaults']:
   expected={category:[{'name':'actual','acl':'{anon=r/postgres,service_role=arw/postgres}'}]}
   self.assertTrue(v.compare(expected,{category:[]}))
   self.assertTrue(v.compare(expected,{category:[{'name':'actual','acl':'{anon=arw/postgres}'}]}))
 def test_normalized_acl_tuple_loss_detected(self):
  expected={'x':[{'acl':[{'grantor':'p','grantee':'a','privilege':'SELECT','grantable':False}]}]}
  self.assertEqual(v.compare(expected,expected),[])
  self.assertTrue(v.compare(expected,{'x':[{'acl':[]}]}))
 def test_entrypoint_refuses_remote_settings_before_any_cluster(self):
  parent=Path(os.environ.get('SCHEMA_TEST_SCRATCH',os.environ.get('RUNNER_TEMP',v.ROOT.parent)))
  with tempfile.TemporaryDirectory(prefix='guard-',dir=parent) as temporary:
   directory=Path(temporary);environment=dict(os.environ,PGHOST='remote-target.invalid')
   result=subprocess.run([sys.executable,str(p),'--scratch',str(directory),'--result',str(directory/'result.json'),'--pg-bin',str(directory/'no-tools')],capture_output=True,text=True,env=environment)
   self.assertNotEqual(result.returncode,0)
   self.assertIn('caller-provided database settings are forbidden',result.stderr)
   self.assertEqual(list(directory.glob('sr-*')),[])
 def test_schema_is_exact_native_file_and_no_credentials_are_fixture_inputs(self):
  manifest=json.loads((v.BASE/'pokeriq-baseline.json').read_text());self.assertTrue(manifest['allSchemas']);self.assertFalse(manifest['dataIncluded']);self.assertEqual(manifest['bytes'],(v.BASE/manifest['schemaFile']).stat().st_size)
if __name__=='__main__':unittest.main()
