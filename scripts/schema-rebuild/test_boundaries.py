import importlib.util,json,tempfile,unittest,os,subprocess,sys,re,hashlib
from pathlib import Path
import check_history,forward
p=Path(__file__).with_name('verify.py');spec=importlib.util.spec_from_file_location('rebuild',p);v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
class Boundaries(unittest.TestCase):
 def test_current_snapshot_refuses_any_unexecuted_forward(self):
  inventory=json.loads((v.BASE/'source-history.json').read_text())
  entries=json.loads((v.BASE/'forward-schema.json').read_text())['arena']
  audited=Path(os.environ.get('SCHEMA_AUDITED_SOURCE',v.ROOT))
  self.assertFalse(any(check_history.check(audited,'arena',inventory,entries).values()))
  self.assertTrue(check_history.check(audited,'arena',inventory,[])['unadmittedNew'])
  for altered in [list(reversed(entries)),entries[:1],entries+entries,[dict(entries[0],sha256='0'*64)],[dict(entries[0],state='unknown')]]:
   with self.assertRaises(ValueError):forward.validate(v.ROOT,altered)
  with self.assertRaises(ValueError):check_history.check(v.ROOT,'arena',inventory,[{'path':'unreviewed.sql','sha256':'0'*64}])
 def test_fixed_workflow_uses_only_exact_audited_history_and_strict_checker(self):
  workflow=(v.ROOT/'.github/workflows/full-schema-rebuild.yml').read_text()
  def pinned(text):
   blocks=re.findall(r'^      - uses: actions/checkout@v4\n        with:\n(.*?)(?=^      -|\Z)',text,re.M|re.S)
   audit=[b for b in blocks if 'path: audited-arena-source' in b]
   fields=dict(line.strip().split(': ',1) for line in audit[0].splitlines() if ': ' in line and not line.lstrip().startswith('#')) if len(audit)==1 else {}
   return fields=={'repository':'Smarter-Poker/Smarter-Poker-Club-Arena','ref':v.AUDITED_SOURCE_REVISION,'path':'audited-arena-source','sparse-checkout':'supabase/migrations','persist-credentials':'false'} and '--checkout audited-arena-source --repo arena' in text and '--checkout . --repo arena' not in text
  self.assertTrue(pinned(workflow))
  self.assertFalse(pinned(workflow.replace('ref: '+v.AUDITED_SOURCE_REVISION,'ref: main')))
  self.assertFalse(pinned(workflow.replace('--checkout audited-arena-source --repo arena','--checkout . --repo arena')))
  manifest=json.loads((v.BASE/'pokeriq-baseline.json').read_text())
  self.assertEqual(manifest['auditedSourceRevision'],v.AUDITED_SOURCE_REVISION);self.assertEqual(manifest['qualificationScope'],v.QUALIFICATION_SCOPE);self.assertTrue(manifest['laterMigrationsExcluded'])
  failure=v.failure_diagnostic('ERROR:  42501: denied','proof',{},'psql')
  self.assertEqual(failure['auditedSourceRevision'],v.AUDITED_SOURCE_REVISION);self.assertEqual(failure['qualificationScope'],v.QUALIFICATION_SCOPE);self.assertTrue(failure['laterMigrationsExcluded'])
  parent=Path(os.environ.get('SCHEMA_TEST_SCRATCH',v.ROOT.parent))
  with tempfile.TemporaryDirectory(prefix='cutoff-',dir=parent) as folder:
   root=Path(folder);migrations=root/'supabase/migrations';migrations.mkdir(parents=True)
   source=migrations/'audited.sql';source.write_text('SELECT 1;')
   inventory={'repositories':{'arena':{'files':[dict(path='supabase/migrations/audited.sql',sha256=hashlib.sha256(source.read_bytes()).hexdigest())]}}}
   self.assertFalse(any(check_history.check(root,'arena',inventory,[]).values()))
   (migrations/'later.sql').write_text('CREATE TABLE later(id int);')
   self.assertEqual(check_history.check(root,'arena',inventory,[])['unadmittedNew'],['supabase/migrations/later.sql'])
 def test_pending_psql_file_is_visible_only_inside_mounted_scratch(self):
  parent=Path(os.environ.get('SCHEMA_TEST_SCRATCH',v.ROOT.parent))
  entries=json.loads((v.BASE/'forward-schema.json').read_text())['arena']
  with tempfile.TemporaryDirectory(prefix='pending-path-',dir=parent) as folder:
   work=Path(folder);calls=[]
   def mounted_only(args,**context):
    source=Path(args[args.index('-f')+1]);self.assertEqual(source.parent,work)
    entry=entries[len(calls)]
    self.assertEqual(source.read_bytes(),(v.ROOT/entry['path']).read_bytes())
    self.assertEqual(source.stat().st_mode&0o777,0o600)
    self.assertEqual(context['phase'],'pending-schema-restore');calls.append(args)
   v.apply_pending_schema(mounted_only,['psql'],v.ROOT,work,entries)
   self.assertEqual(len(calls),4)
   with self.assertRaises(FileExistsError):v.apply_pending_schema(mounted_only,['psql'],v.ROOT,work,entries)
   with self.assertRaises(ValueError):v.apply_pending_schema(mounted_only,['psql'],v.ROOT,work,[dict(entries[0],sha256='0'*64),*entries[1:]])
 def test_event_triggers_restore_as_captured_owners(self):
  source=(v.BASE/'pokeriq-20261020.sql').read_text();reference=json.loads((v.BASE/'pokeriq-catalog-reference.json').read_text());contract=json.loads((v.BASE/'pokeriq-role-contract.json').read_text())
  rendered=v.render_event_trigger_owners(source,reference,contract)
  for trigger in reference['event_triggers']:
   self.assertIn('SET ROLE '+v.q(trigger['owner'])+';\nCREATE EVENT TRIGGER '+trigger['name'],rendered)
   self.assertIn('ALTER EVENT TRIGGER '+trigger['name']+' OWNER TO '+trigger['owner']+';',rendered)
  with self.assertRaises(v.Refused):v.render_event_trigger_owners(source.replace('CREATE EVENT TRIGGER ab_ca_money_rpc_registered','CREATE EVENT TRIGGER unexpected',1),reference,contract)
  reference['event_triggers'][0]['owner']='unrecognized_owner'
  with self.assertRaises(v.Refused):v.render_event_trigger_owners(source,reference,contract)
 def test_provider_error_firstline_is_retained_without_values_or_context(self):
  result=v.failure_diagnostic('ERROR:  XX000: Superuser owned event trigger must execute a superuser owned function\nHINT: use role "sensitive" https://example.test/secret\nDETAIL: secret body\nCONTEXT: secret routine','baseline-restore',{},'psql')
  self.assertIn('Superuser owned event trigger',result['message']);self.assertNotIn('sensitive',str(result));self.assertNotIn('example.test',str(result));self.assertNotIn('secret body',str(result))
 def test_catalog_diagnostics_name_fields_without_expression_values(self):
  expected={'relations':[{'schema':'public','name':'proof','owner':'postgres','columns':[{'name':'id','default':"'private literal'",'acl':[]}]}]}
  actual={'relations':[{'schema':'public','name':'proof','owner':'wrong_owner','columns':[{'name':'id','default':"'different private literal'",'acl':[]}]}]}
  result=v.compare(expected,actual);detail=result[0]['objectDifferences'][0]
  self.assertEqual(detail['object'],'public.proof');self.assertEqual({x['field'] for x in detail['fields']},{'owner','columns[id].default'})
  self.assertNotIn('private literal',json.dumps(result));self.assertIn('wrong_owner',json.dumps(result))
  result=v.compare({'relations':[dict(name=str(i),owner='old') for i in range(150)]},{'relations':[dict(name=str(i),owner='new') for i in range(150)]})
  self.assertEqual(len(result[0]['objectDifferences']),100);self.assertEqual(result[0]['omittedObjects'],50)
 def test_required_private_real_scratch(self):
  with self.assertRaises(v.Refused):v.validate_parent('/does/not/exist')
 def test_catalog_detects_missing_routine_constraint_policy_and_acl(self):
  for category in ['relations','routines','types','event_triggers','defaults']:
   expected={category:[{'name':'actual','acl':'{anon=r/postgres,service_role=arw/postgres}'}]}
   self.assertTrue(v.compare(expected,{category:[]}))
   self.assertTrue(v.compare(expected,{category:[{'name':'actual','acl':'{anon=arw/postgres}'}]}))
 def test_comments_are_exact_multisets_with_nested_order_preserved(self):
  first={'object':'a','comment':'first','nested':[1,2]};second={'object':'Z','comment':'second'}
  expected={'comments':[first,second,first]}
  self.assertEqual(v.compare(expected,{'comments':[second,first,first]}),[])
  for changed in [[first,second],[first,second,first,first],[first,dict(second,comment='changed'),first],[dict(first,nested=[2,1]),second,first]]:
   self.assertTrue(v.compare(expected,{'comments':changed}))
  self.assertTrue(v.compare({'relations':[first,second]},{'relations':[second,first]}))
 def test_normalized_acl_tuple_loss_detected(self):
  expected={'x':[{'acl':[{'grantor':'p','grantee':'a','privilege':'SELECT','grantable':False}]}]}
  self.assertEqual(v.compare(expected,expected),[])
  self.assertTrue(v.compare(expected,{'x':[{'acl':[]}]}))
 def test_lock_memory_message_and_hint_are_allowlisted(self):
  stderr='ERROR:  53200: out of shared memory\nHINT:  You might need to increase "max_locks_per_transaction".\nCONTEXT: private source'
  result=v.failure_diagnostic(stderr,'baseline-restore',{},'psql')
  self.assertEqual(result['message'],'out of shared memory');self.assertIn('max_locks_per_transaction',result['hint']);self.assertNotIn('private source',json.dumps(result))
  result=v.failure_diagnostic('ERROR:  53200: sensitive unexpected value','baseline-restore',{},'psql')
  self.assertIn('sensitive unexpected value',result['message'])
 def test_bootstrap_failure_has_precise_nonsecret_context(self):
  result=v.failure_diagnostic('ERROR:  42501: permission denied to grant privileges as role "supabase_admin"\nDETAIL: discarded private detail','role-membership',{'role':'pg_monitor','member':'postgres','grantor':'supabase_admin'},'psql')
  self.assertEqual(result['sqlstate'],'42501');self.assertEqual(result['phase'],'role-membership')
  self.assertEqual(result['context']['grantor'],'supabase_admin');self.assertIn('"supabase_admin"',result['message']);self.assertNotIn('private detail',json.dumps(result))
 def test_baseline_error_keeps_line_without_exposing_source_literal(self):
  result=v.failure_diagnostic('psql:/scratch/restore.sql:123: ERROR:  42601: syntax error at or near "sensitive_literal"\nCONTEXT: source body','baseline-restore',{'sourceFile':'baseline.sql'},'psql')
  self.assertEqual(result['line'],123);self.assertEqual(result['sqlstate'],'42601');self.assertNotIn('sensitive_literal',json.dumps(result));self.assertNotIn('source body',json.dumps(result))
 def test_entrypoint_refuses_remote_settings_before_any_cluster(self):
  parent=Path(os.environ.get('SCHEMA_TEST_SCRATCH',os.environ.get('RUNNER_TEMP',v.ROOT.parent)))
  with tempfile.TemporaryDirectory(prefix='guard-',dir=parent) as temporary:
   directory=Path(temporary);environment=dict(os.environ,PGHOST='remote-target.invalid')
   result=subprocess.run([sys.executable,str(p),'--scratch',str(directory),'--result',str(directory/'result.json'),'--pg-bin',str(directory/'no-tools')],capture_output=True,text=True,env=environment)
   self.assertNotEqual(result.returncode,0)
   self.assertIn('caller-provided database settings are forbidden',result.stderr)
   self.assertEqual(list(directory.glob('sr-*')),[])
   receipt=json.loads((directory/'result.json').read_text())
   self.assertEqual(receipt['auditedSourceRevision'],v.AUDITED_SOURCE_REVISION);self.assertEqual(receipt['qualificationScope'],v.QUALIFICATION_SCOPE);self.assertTrue(receipt['laterMigrationsExcluded'])
 def test_schema_is_exact_native_file_and_no_credentials_are_fixture_inputs(self):
  manifest=json.loads((v.BASE/'pokeriq-baseline.json').read_text());self.assertTrue(manifest['allSchemas']);self.assertFalse(manifest['dataIncluded']);self.assertEqual(manifest['bytes'],(v.BASE/manifest['schemaFile']).stat().st_size)
if __name__=='__main__':unittest.main()
