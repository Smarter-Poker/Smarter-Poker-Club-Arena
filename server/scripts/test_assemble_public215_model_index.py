"""Finite synthetic two-context boundary checks. No models fitted or real data."""
import copy,hashlib,importlib.util,json,math,os,struct,tempfile,unittest
from pathlib import Path
SPEC=importlib.util.spec_from_file_location('model_index',Path(__file__).with_name('assemble-public215-model-index.py'))
h=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(h)
ZERO='0000000000000000';HALF='3fe0000000000000'
def decode(word):
 if not isinstance(word,str)or len(word)!=16 or any(c not in'0123456789abcdef'for c in word):raise ValueError('word')
 value=struct.unpack('>d',bytes.fromhex(word))[0]
 if not math.isfinite(value):raise ValueError('finite')
 return value
def cases():return[{'board':b,'own':['2c','2d'],'features_f64':[ZERO]*215,'raw_heads_f64':[ZERO]*5,'policy_ev_f64':ZERO,'Q_f64':[ZERO]*2,'frequency_f64':[HALF]*2}for b in['Qh9d7c2h','Qh9d7c3h']]
class PublicModelIndexTests(unittest.TestCase):
 def test_two_context_all215_allheads_and_normalized_words_are_exact(self):
  for context_index in range(2):
   reference=cases()
   if context_index:
    for c in reference:c['features_f64'][-1]='3ff0000000000000';c['raw_heads_f64'][:3]=['3ff0000000000000']*3;c['policy_ev_f64']='3ff0000000000000';c['Q_f64']=['3ff0000000000000']*2
   approved=[{k:c[k]for k in['board','own']}for c in reference];actual=[{**c,'physics_ms_f64':HALF,'inference_ms_f64':HALF}for c in copy.deepcopy(reference)]
   h.compare_reference_cases(reference,actual,2,approved,decode)
   for key,index in [('features_f64',214),('raw_heads_f64',4),('Q_f64',1),('frequency_f64',0)]:
    changed=copy.deepcopy(actual);changed[1][key][index]='8000000000000000'
    with self.assertRaisesRegex(ValueError,'PARITY'):h.compare_reference_cases(reference,changed,2,approved,decode)
   changed=copy.deepcopy(actual);changed[0]['policy_ev_f64']='8000000000000000'
   with self.assertRaisesRegex(ValueError,'PARITY'):h.compare_reference_cases(reference,changed,2,approved,decode)
 def test_case_ownership_and_incomplete_vectors_are_refused(self):
  reference=cases();approved=[{k:c[k]for k in['board','own']}for c in reference]
  for change in [lambda x:x.pop(),lambda x:x[0]['raw_heads_f64'].pop(),lambda x:x[1].__setitem__('own',['2d','2c'])]:
   actual=copy.deepcopy(reference);change(actual)
   with self.assertRaises(ValueError):h.compare_reference_cases(reference,actual,2,approved,decode)
 def test_four_actual_terminal_records_and_result_hashes_are_required_even_for_two_context_fixture(self):
  self.assertTrue(os.environ.get('TMPDIR'),'explicit owned external TMPDIR required')
  with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'])as d:
   root=Path(d);contexts=['a'*64,'b'*64];workers=[]
   def write(path,value):
    raw=json.dumps(value,sort_keys=True,separators=(',',':')).encode();path.write_bytes(raw);return{'path':str(path),'sha256':hashlib.sha256(raw).hexdigest()}
   for i in range(4):
    output=root/str(i);output.mkdir();owned=sorted(contexts)[i::4];result={'format':'public_hist215_final_M1_training_v1','status':'finite_final_M1_model_fragments_UNQUALIFIED','dataset_id':'synthetic','training_authority_checksum':'c'*64,'shard_index':i,'shard_count':4,'context_ids':owned,'files':[{'context_id':cid,'file':cid+'.json','sha256':'d'*64}for cid in owned],'qualityCertified':False,'M2_labels_read':False}
    exit_value={'shard_index':i,'exit_code':0,'output':str(output)}
    workers.append({'shard_index':i,'exit_code':0,'output':str(output),'result':write(output/'result.json',result),'exit_receipt':write(output/'exit.json',exit_value)})
   terminal={'format':'public_hist215_final_M1_training_terminal_v1','dataset_id':'synthetic','training_authority_checksum':'c'*64,'workers':workers}
   self.assertEqual(set(h.validate_terminal(terminal,'synthetic','c'*64,contexts)),{0,1,2,3})
   missing=copy.deepcopy(terminal);missing['workers'].pop()
   with self.assertRaisesRegex(ValueError,'FOUR_ACTUAL'):h.validate_terminal(missing,'synthetic','c'*64,contexts)
   missing=copy.deepcopy(terminal);missing['workers'][0]['exit_receipt']['sha256']='e'*64
   with self.assertRaisesRegex(ValueError,'FILE_BYTES'):h.validate_terminal(missing,'synthetic','c'*64,contexts)
   missing=copy.deepcopy(terminal);missing['workers'][0]['result']['sha256']=None
   with self.assertRaises(ValueError):h.validate_terminal(missing,'synthetic','c'*64,contexts)
 def test_reference_file_hash_refuses_mutated_saved_sklearn_words(self):
  with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'])as d:
   path=Path(d)/'references.json';raw=json.dumps(cases()).encode();path.write_bytes(raw);pin={'path':str(path),'sha256':hashlib.sha256(raw).hexdigest()};self.assertEqual(h.load(pin),cases());path.write_bytes(raw.replace(b'0000000000000000',b'8000000000000000',1))
   with self.assertRaisesRegex(ValueError,'FILE_BYTES'):h.load(pin)
if __name__=='__main__':unittest.main()
