"""Focused PUBLIC planning guards only, never invoke assemble/materialize/data."""
import hashlib,importlib.util,json,os,tempfile,unittest
from pathlib import Path
SPEC=importlib.util.spec_from_file_location('public_request',Path(__file__).with_name('prepare-public215-feature-request.py'))
helper=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(helper)
class PublicRequestAssemblyTests(unittest.TestCase):
 def test_fresh_ids_are_unique_namespace_scoped_and_preserve_explicit_ordinal(self):
  ns=helper.NAMESPACE;ids=[helper.fresh_ids(ns,i)for i in [0,1,6098]]
  self.assertEqual(ids[0],('r7f.m1.6b4ec729fd3a43d7a75b15fd3bced986.00000','r7f.m1.6b4ec729fd3a43d7a75b15fd3bced986.00000.target'))
  self.assertEqual(len(set(ids)),3);self.assertLess(ids[0],ids[1]);self.assertTrue(ids[-1][0].endswith('06098'))
  for value in [-1,6099,True]:
   with self.assertRaises(ValueError):helper.fresh_ids(ns,value)
 def test_metadata_and_runtime_order_by_canonical_context_bytes_not_SHA_order(self):
  canonical=lambda v:json.dumps(v,sort_keys=True,separators=(',',':')).encode()
  candidates=[{'context':{'depth_bucket':i,'street':'flop'}}for i in range(1,20)]
  a,b=next((a,b)for a in candidates for b in candidates if canonical(a['context'])<canonical(b['context'])and hashlib.sha256(canonical(a['context'])).digest()>hashlib.sha256(canonical(b['context'])).digest())
  hash_order=sorted([a,b],key=lambda g:hashlib.sha256(canonical(g['context'])).digest());self.assertEqual(hash_order,[b,a])
  self.assertEqual(helper.canonical_context_order(hash_order,canonical),[a,b])
  self.assertEqual(helper.canonical_context_order([{'context':g['context'],'cases':[]}for g in hash_order],canonical),[{'context':a['context'],'cases':[]},{'context':b['context'],'cases':[]}])
 def test_decimal_ROOT_units_do_not_round_binary_float(self):
  values=['0']*1326;values[:3]=['1e-12','0.1','1.000000000000']
  self.assertEqual(helper.range_units(('['+','.join(values)+']').encode())[:3],[1,100000000000,1000000000000])
  for bad in ['0.0000000000001','-0.1','1.000000000001']:
   altered=values[:];altered[0]=bad
   with self.assertRaises(ValueError):helper.range_units(' '.join(altered).encode())
 def test_public_cache_metadata_reader_hashes_all_bytes_but_parses_only_header_and_first_row(self):
  need=os.environ.get('TMPDIR');self.assertTrue(need,'explicit owned external TMPDIR required')
  with tempfile.TemporaryDirectory(dir=need)as d:
   path=Path(d)/'public.json';value={'contract':'public-test','rows':[{'target_id':'one','features':[[.5,.25,.25]]},{'target_id':'two','features':[[.1,.2,.7]]}],'schema_sha256':'a'*64,'solver_labels_used':False}
   raw=json.dumps(value,sort_keys=True,separators=(',',':')).encode()+b'\n';path.write_bytes(raw);f={'path':str(path),'sha256':hashlib.sha256(raw).hexdigest()}
   header,row=helper.cache_header_and_first(f);self.assertEqual(header,{k:v for k,v in value.items()if k!='rows'});self.assertEqual(row,{'target_id':'one'})
   with self.assertRaises(ValueError):helper.cache_header_and_first({**f,'sha256':'0'*64})
if __name__=='__main__':unittest.main()
