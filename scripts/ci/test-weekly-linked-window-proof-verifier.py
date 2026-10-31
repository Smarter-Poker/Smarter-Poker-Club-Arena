#!/usr/bin/env python3
"""Offline fault cases for strict saved installer evidence; no DB or payment calls."""
from pathlib import Path
import argparse,copy,hashlib,importlib.util,json,tempfile,unittest
p=argparse.ArgumentParser();p.add_argument('--scratch',type=Path,required=True);args=p.parse_args();assert args.scratch.is_dir()
R=Path(__file__).resolve().parents[2];source=R/'scripts/ci/fixtures/weekly-linked-window-proof';spec=importlib.util.spec_from_file_location('strict_five',Path(__file__).with_name('verify-weekly-linked-window-proof.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class StrictEvidence(unittest.TestCase):
 def setUp(self):
  self.folder=tempfile.TemporaryDirectory(prefix='five-offline-',dir=args.scratch);self.d=Path(self.folder.name);module.F=self.d
  for name in ['source-binding.json','admission-before.json','admission-after.json','expected-footprints.json','installed-history-admission.json','kind-before.txt','kind-after.txt']:(self.d/name).write_bytes((source/name).read_bytes())
  # Deliberately synthetic identity outside every migration directory.
  self.version='20990101000001';self.migration=self.d/(self.version+'_native_fixture.sql');self.migration.write_text((source/'migration-template.sql.in').read_text().replace('__RESERVED_VERSION__',self.version))
  binding=json.loads((self.d/'source-binding.json').read_text());binding['reserved_version']=self.version;binding['candidate_sha256']=hashlib.sha256(self.migration.read_bytes()).hexdigest();(self.d/'source-binding.json').write_text(json.dumps(binding))
  before=json.loads((source/'admission-before.json').read_text());after=json.loads((source/'admission-after.json').read_text());language=next(x['metadata']['prolang']for x in before if'weekly_hand_parts_witness('in x['signature'])
  for x in after:
   if x['metadata']['prolang']=='REQUIRE_ACTUAL_PG_LANGUAGE_PLPGSQL_OID_AT_INSTALL':x['metadata']['prolang']=language
  def value(mode,owners):return {'kind':'linked_window_strict_'+mode,'mode':mode,'observed_at':'2026-10-30T15:00:01+00:00'if mode=='pre'else'2026-10-30T15:01:00+00:00','source65':True,'frozen':False,'new_linked_rows':0,'kind_contract':(source/('kind-before.txt'if mode=='pre'else'kind-after.txt')).read_text(),'manual40_md5':'bf419dcc51e70b4275e04c7f452f5ade','footprints':json.loads((source/'expected-footprints.json').read_text()),'generation':binding['old_generation']if mode=='pre'else binding['new_generation'],'owners':[{'signature':x['signature'],'metadata':x['metadata'],'definition':x['definition']}for x in owners],'predecessor_history':[{'version':x['version'],'sql_sha256':hashlib.sha256(x['statements'][0].encode()).hexdigest()}for x in sorted(json.loads((source/'installed-history-admission.json').read_text()),key=lambda x:x['version'])],'history':None if mode=='pre'else[{'version':self.version,'name':'native_fixture','statements':[self.migration.read_text()],'rollback':None,'created_by':None,'idempotency_key':None}]}
  self.a=value('pre',before);self.b=value('post',after)
 def tearDown(self):self.folder.cleanup()
 def run_verifier(self,extra='',terminal=True):
  a=self.d/'pre.log';b=self.d/'post.log';a.write_text('BEGIN\n'+json.dumps(self.a)+'\nROLLBACK\n');b.write_text('BEGIN\n'+json.dumps(self.b)+'\n'+extra+('ROLLBACK\n'if terminal else''));return module.verify(a,b,self.migration,'2026-10-30T15:00:00+00:00')
 def refused(self):
  with self.assertRaises(AssertionError):self.run_verifier()
 def test_valid_saved_chain(self):self.assertTrue(self.run_verifier()['passed'])
 def test_duplicate_manual_credit(self):self.b['footprints']['manual40'].append(copy.deepcopy(self.b['footprints']['manual40'][0]));self.refused()
 def test_original_paid_digest_changes(self):self.b['footprints']['paid5']['payout']['count']+=1;self.refused()
 def test_any_759_timestamp_or_value_changes(self):self.b['footprints']['all759']['md5']='0'*32;self.refused()
 def test_r2_receipt_changes(self):self.b['footprints']['earned_R2']['round2_union_window']['count']-=1;self.refused()
 def test_old_generation_retag(self):self.b['generation']=self.a['generation'];self.refused()
 def test_new_proof_during_install(self):self.b['new_linked_rows']=1;self.refused()
 def test_kind_check_not_extended(self):self.b['kind_contract']=self.a['kind_contract'];self.refused()
 def test_source_seal_unknown(self):self.b['source65']=None;self.refused()
 def test_current_controller_metadata_changes(self):next(x for x in self.b['owners']if'weekly_payout_execute('in x['signature'])['metadata']['proconfig'].append('work_mem=1MB');self.refused()
 def test_already_installed_helper_changes(self):next(x for x in self.b['owners']if'fn_union_pnl_touched_registrations('in x['signature'])['definition']+=' ';self.refused()
 def test_prior_installer_history_changes(self):self.b['predecessor_history'][0]['sql_sha256']='0'*64;self.refused()
 def test_replay_before_history(self):self.a['history']=self.b['history'];self.refused()
 def test_wrong_protected_sql(self):self.b['history'][0]['statements'][0]+='\n';self.refused()
 def test_stale_before(self):self.a['observed_at']='2026-10-30T14:59:59+00:00';self.refused()
 def test_extra_json_is_not_filtered(self):
  with self.assertRaises(AssertionError):self.run_verifier(extra='{}\n')
 def test_missing_terminal_rollback(self):
  with self.assertRaises(AssertionError):self.run_verifier(terminal=False)
 def test_sql_error_is_not_ignored(self):
  with self.assertRaises(AssertionError):self.run_verifier(extra='ERROR: statement timeout\n')
result=unittest.TextTestRunner(verbosity=1).run(unittest.defaultTestLoader.loadTestsFromTestCase(StrictEvidence));raise SystemExit(0 if result.wasSuccessful()else 1)
