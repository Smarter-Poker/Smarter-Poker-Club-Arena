from pathlib import Path
import hashlib,json
HERE=Path(__file__).resolve().parent
CASE='SEQ08_BBJ_MAIN_POSITIVE_OPENING_SETUP'
ACTOR='7beef002-0002-4000-8000-000000000001'
CLUB='7beef002-0002-4000-8000-000000000002'
def read(n):return json.loads((HERE/n).read_text())
def require(v,m):
 if not v:raise AssertionError(m)
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def verify_pins():
 for e in read('SOURCE-PINS.json'):require(sha(e['path'])==e['sha256'],'Pinned source changed: '+e['path'])
def verify_authorization(a,driver,seed):
 require(type(a) is dict and a.get('authorized') is True and a.get('case')==CASE and a.get('case_review_accepted') is True and a.get('root_adapter_review_accepted') is True,'Independent case/adapter acceptance and root authorization required')
 require(a.get('packet_sha256')==sha(HERE/'INTEGRITY.json'),'Exact packet authorization required')
 for e in read('INTEGRITY.json')['files']:
  f=(HERE/e['path']).resolve();require(f.is_relative_to(HERE) and sha(f)==e['sha256'],'Packet member changed')
 verify_pins()
 d=next(e for e in read('SOURCE-PINS.json') if e['role']=='base_driver')
 require(Path(driver.__file__).resolve()==Path(d['path']) and sha(driver.__file__)==d['sha256'],'Original shared driver required')
 require(driver.ACTOR==ACTOR and driver.CLUB==CLUB,'Original seed identities changed')
 require(callable(seed) and a.get('seed_sha256')==next(e['sha256'] for e in read('SOURCE-PINS.json') if e['role']=='seed'),'Exact seed0007 callback required')
