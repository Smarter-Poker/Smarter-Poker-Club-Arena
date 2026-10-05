"""Pure completion protocol controls. No database/process execution."""
import importlib.util,json,unittest,hashlib
from pathlib import Path
from decimal import Decimal
p=Path(__file__).with_name('spin-first-archived-completion.py');s=importlib.util.spec_from_file_location('completion_under_test',p);M=importlib.util.module_from_spec(s);s.loader.exec_module(M)
class FirstArchivedCompletionTests(unittest.TestCase):
 def test_postgres_fraction_precision_is_lossless(self):
  for n in range(1,7):
   fraction='123456'[:n];t=M.stamp('2026-09-27 15:28:00.'+fraction+'+00')
   self.assertEqual(t.microsecond,int(fraction.ljust(6,'0')))
  for zone in ('Z','+00','+0000','+00:00'):self.assertEqual(M.stamp('2026-09-27T15:28:00'+zone).utcoffset().total_seconds(),0)
  for v in ('2026-09-27T15:28:00.1234567Z','2026-09-27T15:28:00',None,True,'2026-13-27T15:28:00Z'):
   with self.subTest(v=v),self.assertRaises(ValueError):M.stamp(v)
 def test_timezone_offsets_are_range_checked(self):
  for zone,seconds in (('+23:59',86340),('-23:59',-86340),('+0530',19800),('-05',-18000)):
   with self.subTest(zone=zone):self.assertEqual(M.stamp('2026-09-27T15:28:00'+zone).utcoffset().total_seconds(),seconds)
  for zone in ('+00:99','+01:60','-00:99','-01:60','+0060','-0199','+24:00','-24','+99:00'):
   with self.subTest(zone=zone),self.assertRaisesRegex(ValueError,'timezone offset malformed'):M.stamp('2026-09-27T15:28:00'+zone)
 def test_timestamp_digits_are_ascii_only(self):
  for value in ('２０２６-09-27T15:28:00Z','2026-٠٩-27T15:28:00Z','2026-09-27T١٥:28:00Z','2026-09-27T15:28:00.١Z','2026-09-27T15:28:00+٠٠:00','2026-09-27T15:28:00+00:００'):
   with self.subTest(value=value),self.assertRaisesRegex(ValueError,'encoding malformed'):M.stamp(value)
 def test_no_abort_to_completion_conversion(self):
  for raw in ('ERROR:  PZ002: FIRST_ARCHIVED_ROLLBACK_PROVED:x\nDETAIL: {}','{}','{"kind":"first_archived_completion_before_commit_v1"}\n{"kind":"first_archived_completion_before_commit_v1"}','{"kind":"other"}'):
   with self.subTest(raw=raw),self.assertRaises(ValueError):M.parse_original(raw)
 def test_lossless_binding_and_delimiter_refusal(self):
  bound=M.bind({'amount':Decimal('1.2300')});self.assertIn('1.2300',bound);self.assertNotIn('__VERIFIED_COMPLETION_ENVELOPE_JSON__',bound)
  for v in (Decimal('NaN'),Decimal('Infinity')):
   with self.assertRaises(ValueError):M.encode(v)
  with self.assertRaises(ValueError):M.bind({'value':'$completion$'})
 def test_exact_sources_and_precommit_financial_prefix(self):
  A,P,Q=M.modules();original=(M.ROOT/P.PROBE).read_text();candidate=(M.ROOT/M.SQL).read_text()
  self.assertEqual(hashlib.sha256(candidate.encode()).hexdigest(),M.SQL_SHA)
  self.assertEqual(hashlib.sha256(M.READBACK.encode()).hexdigest(),M.READBACK_SHA)
  prefix=original[original.index('BEGIN;'):original.index(" RAISE EXCEPTION USING ERRCODE='PZ002'")].replace('DO $probe$','DO $completion$')
  self.assertEqual(candidate[candidate.index('BEGIN;'):candidate.index(' -- Separate COMMIT candidate:')],prefix)
  self.assertNotIn("ERRCODE='PZ002'",candidate);self.assertNotIn('transaction_will_abort_now',candidate)
  self.assertLess(candidate.index("SET CONSTRAINTS ALL IMMEDIATE"),candidate.index("set_config('ca.first_archived_completion_evidence'"))
  self.assertTrue(candidate.endswith("AS evidence;\nCOMMIT;\n"))
 def test_durable_checks_are_exact_inventory(self):
  self.assertEqual(len(M.CHECKS),28);self.assertIn('winner_200_only',M.CHECKS);self.assertIn('fee_24_held',M.CHECKS)
  self.assertNotIn('checks',M.CHECKS);self.assertNotIn('__VERIFIED_PZ002',M.READBACK)
  self.assertIn("reference_status'='committed'",M.READBACK)
 def test_sql_baseline_count_matches_exact_scoped_inventory(self):
  import re
  _,_,Q=M.modules()
  count=re.search(r'count\(\*\) FROM jsonb_object_keys\(b\)\)=(\d+)',M.READBACK)
  self.assertIsNotNone(count);self.assertEqual(int(count.group(1)),len(Q.SCOPED));self.assertEqual(len(Q.SCOPED),23)
 def test_variant_preserves_existing_paths(self):
  A,P,Q=M.modules();args=(Path('/qualified/pg17/bin'),M.ROOT,'00000000-0000-4000-8000-000000000009','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003')
  original=A.body_plan(*args,A.IMAGE);bank=A.body_plan(*args,A.BANK_IMAGE);completion=A.body_plan(*args,A.COMPLETION_IMAGE)
  i=[n for n,_ in original].index('archive_production_probe');self.assertEqual(completion[:i],original[:i]);self.assertEqual(completion[i][1],original[i][1]+['--completion']);self.assertEqual(len(completion),i+1);self.assertEqual(bank[i][1],original[i][1]+['--bank-races'])
 def test_bool_xid_and_wrong_envelope_refuse(self):
  for e in ({},{'kind':'FIRST_ARCHIVED_ROLLBACK_PROVED'},{'transaction_id':True}):
   with self.subTest(e=e),self.assertRaises((ValueError,KeyError)):M.validate(e,{})
 def test_native_faults_are_exact_derived_not_production_edits(self):
  A,P,Q=M.modules();C=M.load('completion_cases_control',p.with_name('spin-first-archived-completion-cases.py'));B=P.C.load('existing_bank_controls',P.ROOT/'scripts/qualification/spin-first-archived-bank-races.py');source=(M.ROOT/M.SQL).read_text()
  self.assertEqual(C.FAULTS,('own_parent','own_child','own_noop','own_offset','deferred_commit'))
  for kind in C.FAULTS:
   derived=C.fault_source(source,kind,P,B);self.assertNotEqual(derived,source);self.assertNotIn("ERRCODE='PZ002'",derived)
   if kind!='deferred_commit':
    self.assertTrue(derived.endswith('$completion$;\n'))
    self.assertNotIn("SELECT current_setting('ca.first_archived_completion_evidence')",derived)
    self.assertNotIn('COMMIT;',derived)
  offset=C.fault_source(source,'own_offset',P,B);self.assertIn('rake_wallet=rake_wallet+1',offset);self.assertIn('rake_wallet=rake_wallet-1',offset)
  child=C.fault_source(source,'own_child',P,B);self.assertIn('EXCEPTION WHEN division_by_zero',child)
  deferred=C.fault_source(source,'deferred_commit',P,B);self.assertIn("ERRCODE='PZ005'",deferred);self.assertIn('CREATE TEMP TABLE completion_commit_fault',deferred);self.assertIn('DEFERRABLE INITIALLY DEFERRED',deferred)
  self.assertLess(deferred.index("SET CONSTRAINTS completion_commit_fault DEFERRED"),deferred.index("SELECT current_setting('ca.first_archived_completion_evidence')"))
  self.assertTrue(deferred.endswith('AS evidence;\nCOMMIT;\n'))
  with self.assertRaises(ValueError):C.fault_source(source,'unknown',P,B)
 def test_bank_completion_variant_preserves_all_existing_variants(self):
  A,P,Q=M.modules();args=(Path('/qualified/pg17/bin'),M.ROOT,'00000000-0000-4000-8000-000000000009','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003')
  original=A.body_plan(*args,A.IMAGE);bank=A.body_plan(*args,A.COMPLETION_BANK_IMAGE);i=[n for n,_ in original].index('archive_production_probe')
  self.assertEqual(bank[:i],original[:i]);self.assertEqual(bank[i][1],original[i][1]+['--completion','--completion-case','bank_intervals']);self.assertEqual(len(bank),i+1)
  self.assertTrue({A.IMAGE,A.BANK_IMAGE,A.COMPLETION_IMAGE,A.COMPLETION_BANK_IMAGE}<=set(A.IMAGES))
 def test_unknown_ack_reader_does_not_need_original_ack_xid(self):
  A,P,Q=M.modules();C=M.load('completion_queries',p.with_name('spin-first-archived-completion-cases.py'));query=C.recovery_query(P)
  self.assertIn('pg_xact_status(admitted_xid::text::xid8)',query);self.assertIn('spin_archived_first_admission',query)
  self.assertNotIn('fn_complete_first_archived_spin',query);self.assertNotIn('INSERT',query)
  replay=C.replay_query(P);self.assertIn('fn_smarter_data_api_pre_request',replay);self.assertEqual(replay.count('fn_complete_first_archived_spin('),1)
 def test_bank_scenario_has_one_final_commit_no_event_reset(self):
  source=p.with_name('spin-first-archived-completion-cases.py').read_text()
  self.assertIn("c['B_in_progress_at_first_readback']",source);self.assertIn("readback('after_B')",source);self.assertIn("readback('after_C')",source)
  self.assertNotIn('TRUNCATE',source);self.assertNotIn('DISABLE TRIGGER',source);self.assertNotIn('DELETE FROM',source)
  self.assertIn("c['after']==c['after_replay']",source);self.assertIn("w['waiting_xids']==[top]",source)
 def test_recognition_capture_is_bound_and_current(self):
  A,_,_=M.modules();files={p:(M.ROOT/p).read_bytes() for p in A.INPUTS};A.validate_recognition_capture(files)
  statepath=A.BASE+'first-temporal-state.json';rawpath=A.BASE+'first-recognition-capture.json'
  for kind in ('hash','query','evidence','outside','overlap','scope','guard'):
   f=dict(files);s=json.loads(f[statepath]);r=json.loads(f[rawpath]);p=s['recognition_period']
   if kind=='hash':p['capture_sha256']='0'*64
   elif kind=='query':p['query']+=' '
   elif kind=='evidence':p['evidence']['observed_at']='2026-09-27T00:00:00+00:00'
   elif kind=='guard':f[A.COMPLETION_SQL]=f[A.COMPLETION_SQL].replace(b'2026-10-12T07:00:00Z',b'2026-10-05T07:00:00Z')
   else:
    e=r['rows'][0]['evidence']
    if kind=='outside':e['observed_at']='2026-09-27T00:00:00+00:00'
    elif kind=='overlap':e['runs_blocking_now']=True
    else:e['scopes']=[]
    f[rawpath]=json.dumps(r).encode();p['capture_sha256']=hashlib.sha256(f[rawpath]).hexdigest();p['evidence']=e
   f[statepath]=json.dumps(s).encode()
   with self.subTest(kind=kind),self.assertRaises(ValueError):A.validate_recognition_capture(f)
if __name__=='__main__':unittest.main()
