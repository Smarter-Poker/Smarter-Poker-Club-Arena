#!/usr/bin/env python3
"""Private PG17 receipt fence proof. Actual accepted and bank owners, no pay-owner stubs."""
import os,sys,json,hashlib,subprocess,time,re
from pathlib import Path
sys.path.insert(0,os.environ['ROUND1_HERE'])
from fixture_helpers import sql,setup,source,psql
here=Path(os.environ['SEAL_HERE']); checks=[]; waits=[]
setup()
# Prepare synthetic requests/lease heartbeat before the actual-owner baseline.
# The call under test below is the installed 12-argument owner, not this helper.
prepare=sql("SELECT pg_get_functiondef('test_owner_amount(bigint,numeric)'::regprocedure);")
prepare=prepare.replace('FUNCTION public.test_owner_amount(', 'FUNCTION public.test_prepare_owner(')
prepare,n=re.subn(r'RETURN fn_ca_commit_hand_settlement\(.*?\);', "RETURN '{}'::jsonb;",prepare,flags=re.S)
assert n==2
sql(prepare)
sql((here/'01-private-prefix-seals.sql').read_text())
def check(name,ok):
 assert ok,name
 checks.append(name);print('PASS: '+name,flush=True)
def value(q): return json.loads(sql(q).splitlines()[-1])
def stamp():return sql('SELECT clock_timestamp();')
def state():return sql("SELECT jsonb_build_object('public',test_funding_state(),'producers',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY cutoff),'[]') FROM ca_accounting_seal_private.producer_prefixes p),'banked_sources',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY hand_id),'[]') FROM ca_accounting_seal_private.banked_sources x),'banks',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY producer_cutoff),'[]') FROM ca_accounting_seal_private.bank_manifests b));")
def refuse(name,q,expected):
 before=state();e=sql(q,False);assert expected in e,e;check(name,before==state())
def producer(c):return f"SELECT ca_accounting_seal_private.seal_producer('{c}');"
def bankseal(c,b):return f"SELECT ca_accounting_seal_private.seal_bank('{c}','{b}');"
def accepted(n):
 sql(f'SELECT test_prepare_owner({n},2);')
 return f"SELECT fn_ca_commit_hand_settlement(test_id(950),{n},request->'stacks',2,0,'native-source:{n}',0,request->'row','[]'::jsonb,'native-owner-source',test_id(960),request->'obligations') FROM test_owner_requests WHERE hand_number={n};"
def bank(n):return f"SELECT row_to_json(b) FROM atomic_distribute_rake(test_id(950),test_id(900),test_id({n}),{n},2,0,200,2,jsonb_build_object(test_id(201)::text,100,test_id(202)::text,100),NULL,'{{}}','WEIGHTED_CONTRIBUTED') b;"
def batch(n):
 return f"SELECT fn_credit_agent_commissions_batch(jsonb_agg(jsonb_build_object('user_id',player_id,'club_id',booked_club_id,'rake_credit',rake_credit,'source_type','rake_settlement','source_id',hand_id))) FROM ca_cash_commission_facts WHERE hand_id=test_id({n}) AND rake_credit>0;"
def runbatch(n):
 r=value(batch(n));assert r['failed']==0,r
class Session:
 def __init__(self):
  self.p=subprocess.Popen([psql,'-X','-qAt','-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
  self.send("SELECT set_config('request.jwt.claim.sub',test_id(100)::text,false);SELECT pg_backend_pid();SELECT 'READY';")
  out=self.read('READY');self.pid=int(out[-1])
 def send(self,q):self.p.stdin.write(q+'\n');self.p.stdin.flush()
 def read(self,end):
  rows=[]
  while True:
   line=self.p.stdout.readline()
   if not line:raise RuntimeError(self.p.stderr.read())
   s=line.strip()
   if s==end:return rows
   if s:rows.append(s)
 def close(self,commit=True):
  self.send(('COMMIT;' if commit else 'ROLLBACK;')+'\\q');return self.p.communicate(timeout=15)
def worker(q):
 return subprocess.Popen([psql,'-X','-qAt','-v','ON_ERROR_STOP=1','-c',"SELECT set_config('request.jwt.claim.sub',test_id(100)::text,false);"+q],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
def waitfor(key,mode):
 for _ in range(150):
  data=value("SELECT coalesce(jsonb_agg(jsonb_build_object('pid',pid,'mode',mode,'granted',granted)),'[]') FROM pg_locks WHERE locktype='advisory' AND (classid::bigint<<32 | objid::bigint)=hashtextextended('"+key+"',0);")
  if any(x['mode']==mode and not x['granted'] for x in data):waits.append(data);return
  time.sleep(.02)
 raise AssertionError('Expected admission wait not observed '+key)
producerkey='club-arena:cash-producer-prefix:v1';bankkey='club-arena:cash-bank-manifest:v1'
source(2900001,'2');runbatch(2900001)
c1=stamp();r=value(producer(c1))
check('Actual accepted owner creates complete source and exact original scope manifest',len(r['manifest'])==1 and r['manifest'][0]['source']['hand_id'].endswith('2900001') and r['period_closed'] is False)
b1=stamp();r=value(bankseal(c1,b1))
check('Actual treasury credit and contributor receipts are captured without financial finality',len(r['manifest'])==1 and len(r['manifest'][0]['contributors'])==2 and r['period_closed'] is False)
before=state();r=value(bank(2900001));check('Current bank exact replay after seal adds no money or public/private rows',r['already_processed'] and state()==before)
before=state();r=value(producer(c1));check('Producer manifest replay does not rewrite its receipt',r['replayed'] and state()==before)
before=state();r=value(bankseal(c1,b1));check('Bank manifest replay does not rewrite its receipt',r['replayed'] and state()==before)
refuse('Changed bank replay cutoff cannot relabel original evidence',bankseal(c1,stamp()),'replay cutoff conflict')
for role in ['service_role','authenticated','anon']:
 refuse('Private sealer refuses direct execution by '+role,'SET ROLE '+role+';'+producer(stamp()),'permission denied')
before=state()
isolation=subprocess.run([psql,'-X','-qAt','-v','ON_ERROR_STOP=1','-c',"BEGIN ISOLATION LEVEL REPEATABLE READ;"+producer(stamp())],capture_output=True,text=True)
check('Repeatable read cannot hide a writer committed during the wait',isolation.returncode!=0 and 'fresh read committed' in isolation.stderr and before==state())
refuse('Manifest cannot be relabeled complete',"UPDATE ca_accounting_seal_private.bank_manifests SET period_closed=true;",'immutable')
# A forged/new ledger row after the old owner has moved money must abort the
# whole transaction; returning an old receipt is not sufficient evidence.
refuse('Duplicate treasury journal after a credit rolls back the preceding money',"BEGIN;SET app.ledger_autoskip_clubs='1';UPDATE clubs SET chip_treasury=chip_treasury+2 WHERE id=test_id(900);INSERT INTO chip_ledger SELECT (jsonb_populate_record(NULL::chip_ledger,to_jsonb(c)||jsonb_build_object('id',gen_random_uuid(),'created_at',clock_timestamp()))).* FROM chip_ledger c WHERE id=(SELECT chip_ledger_id FROM ca_cash_bank_receipts WHERE hand_id=test_id(2900001));COMMIT;",'Sealed bank source')
# Invalid source classification is a rollback-only negative fixture. It is not
# asserted to be a normal output of the current 12-argument accepted owner.
for label,payload in [('NULL envelope','NULL::jsonb'),('Noncash envelope',"jsonb_build_object('rake',jsonb_build_object('tournament_id',test_id(999)))")]:
 q="BEGIN;INSERT INTO hand_atomic_commits SELECT (jsonb_populate_record(NULL::hand_atomic_commits,to_jsonb(h)||jsonb_build_object('hand_id',test_id(2900900),'hand_number',2900900,'post_commit_payload',"+payload+",'post_commit_payload_hash',NULL,'committed_at',clock_timestamp()))).* FROM hand_atomic_commits h WHERE hand_id=test_id(2900001);SELECT ca_accounting_seal_private.seal_producer(clock_timestamp()-interval '1 microsecond');COMMIT;"
 refuse(label+' cannot be counted as an empty cash producer prefix',q,'unknown, noncash, missing or invalid')
# Producer was admitted first: seal blocks until complete actual owner commits.
a=Session();a.send('BEGIN;'+accepted(2900002)+"SELECT 'OWNER_DONE';");a.read('OWNER_DONE');c2=stamp();w=worker(producer(c2));waitfor(producerkey,'ExclusiveLock');a.close();out,err=w.communicate(timeout=15)
check('Producer first: exclusive seal waits and includes committed actual owner',w.returncode==0 and sql("SELECT jsonb_array_length(manifest) FROM ca_accounting_seal_private.producer_prefixes ORDER BY cutoff DESC LIMIT 1;")=='1')
refuse('Missing actual bank acknowledgment refuses without advancing bank evidence',bankseal(c2,stamp()),'not banked')
sql(bank(2900002));refuse('Missing actual contributor acknowledgment refuses bank evidence',bankseal(c2,stamp()),'contributor receipt')
runbatch(2900002);b2=stamp();value(bankseal(c2,b2))
# Sealer owns exclusion before writer computes/attempts INSERT. The original
# committed_at default is evaluated before the BEFORE trigger waits.
a=Session();a.send("BEGIN;SELECT pg_advisory_xact_lock(hashtextextended('"+producerkey+"',0));SELECT 'LOCKED';");a.read('LOCKED')
call=accepted(2900003);before=state();w=worker(call);waitfor(producerkey,'ShareLock');c3=stamp();a.send(producer(c3)+"SELECT 'SEALED';");a.read('SEALED');a.close();out,err=w.communicate(timeout=15)
late_result=json.loads(out.strip().splitlines()[-1])
check('Sealer first: waiting actual accepted owner refuses its original timestamp without retiming',w.returncode==0 and late_result.get('success') is False and late_result.get('reason')=='atomic_hand_rolled_back' and late_result.get('sqlstate')=='40001' and 'original timestamp' in late_result.get('error','') and sql('SELECT count(*) FROM hand_atomic_commits WHERE hand_id=test_id(2900003);')=='0')
check('Refused late accepted owner leaves every public financial row unchanged',json.loads(before)['public']==json.loads(state())['public'])
# Bank admitted first: seal waits for actual bank and contributor transaction.
sql(accepted(2900004));c4=stamp();value(producer(c4));a=Session();a.send('BEGIN;'+bank(2900004)+batch(2900004)+"SELECT 'BANK_DONE';");a.read('BANK_DONE');b4=stamp();w=worker(bankseal(c4,b4));waitfor(bankkey,'ExclusiveLock');a.close();out,err=w.communicate(timeout=15)
check('Bank first: seal waits then pins the actual committed credit and contributor chain',w.returncode==0 and sql("SELECT jsonb_array_length(manifest) FROM ca_accounting_seal_private.bank_manifests ORDER BY producer_cutoff DESC LIMIT 1;")=='1')
# Sealer first while a new accepted source exists outside its prior manifest.
# That source may bank later, but an already-evaluated old credit timestamp must
# not become a new closed-window credit after the bank cutoff has committed.
sql(accepted(2900005));a=Session();a.send("BEGIN;SELECT pg_advisory_xact_lock(hashtextextended('"+bankkey+"',0));SELECT 'LOCKED';");a.read('LOCKED')
before=state();w=worker(bank(2900005));waitfor(bankkey,'ShareLock');b5=stamp();a.send(bankseal(c3,b5)+"SELECT 'SEALED';");a.read('SEALED');a.close();out,err=w.communicate(timeout=15)
check('Sealer first: original actual money timestamp refuses after wait without credit',w.returncode!=0 and 'original timestamp' in err and sql('SELECT count(*) FROM ca_cash_bank_receipts WHERE hand_id=test_id(2900005);')=='0')
check('Refused bank attempt rolls back all public rows',json.loads(before)['public']==json.loads(state())['public'])
# A fresh actual retry uses the newly evaluated normal timestamp and succeeds.
sql(bank(2900005));runbatch(2900005)
check('Fresh retry banks exactly once after the closed bank cutoff',sql('SELECT count(*) FROM ca_cash_bank_receipts WHERE hand_id=test_id(2900005);')=='1')
# Actual Union route, original captured ownership and saved pre-capture owner.
# Only the saved function name changes, so it can coexist with the new owner.
legacy_path=Path(os.environ['ROUND1_INPUT'])/'source-authority/bank-owner/actual-bank-owner.sql'
legacy_body=legacy_path.read_text()
legacy_alias=legacy_body.replace('CREATE OR REPLACE FUNCTION public.atomic_distribute_rake(', 'CREATE FUNCTION public.test_pre_capture_bank(',1)
assert legacy_alias!=legacy_body
sql(legacy_alias)
sql("INSERT INTO unions(id,name,owner_id,slug) VALUES(test_id(901),'Seal Original Union',test_id(100),'seal-original'),(test_id(902),'Seal Later Union',test_id(100),'seal-later');INSERT INTO union_clubs(union_id,club_id,rate_cash) VALUES(test_id(901),test_id(900),.90);UPDATE tables SET union_id=test_id(901) WHERE id=test_id(950);")
sql(accepted(2900006));sql("UPDATE tables SET union_id=test_id(902) WHERE id=test_id(950);")
r=value(bank(2900006));runbatch(2900006);c6=stamp();value(producer(c6));b6=stamp();r=value(bankseal(c6,b6))
union_bank=[x['bank'] for x in r['manifest'] if x['bank']['hand_id'].endswith('2900006')][0]
check('Seal binds original Union after the current table changes Union',union_bank['funding_union_id'].endswith('901') and union_bank['funding_route']=='union_rake_wallet')
check('Union bank cutoff uses original money transaction time, not receipt-recording time',sql("SELECT b.bank_credit_at=u.created_at AND b.bank_credit_at<=b.recorded_at FROM ca_cash_bank_receipts b JOIN union_wallet_transactions u ON u.id=b.union_wallet_transaction_id WHERE b.hand_id=test_id(2900006);")=='t')
before=state();r=value(bank(2900006));check('Current original-Union replay after bank seal adds no money',r['already_processed'] and before==state())
# An existing legacy body is exercised honestly as a saved-definition call,
# not mislabeled as a function suspended across production DDL activation.
sql("UPDATE tables SET union_id=test_id(901) WHERE id=test_id(950);")
before=state();r=value(bank(2900006).replace('atomic_distribute_rake(', 'test_pre_capture_bank('));check('Saved actual pre-capture bank owner exact replay adds no second money after seal',r['already_processed'] and before==state())
sql("UPDATE tables SET union_id=test_id(902) WHERE id=test_id(950);")
refuse('Saved pre-capture bank owner cannot create a different Union credit after seal',bank(2900006).replace('atomic_distribute_rake(', 'test_pre_capture_bank('),'Cash bank spendable leg conflicts')
refuse('Duplicate Union money journal rolls back its preceding wallet credit',"BEGIN;SELECT set_config('app.ledger_hand_id',test_id(2900006)::text,true);UPDATE union_wallets SET rake_wallet=rake_wallet+2 WHERE union_id=test_id(901);INSERT INTO union_wallet_transactions SELECT (jsonb_populate_record(NULL::union_wallet_transactions,to_jsonb(u)||jsonb_build_object('id',gen_random_uuid(),'created_at',clock_timestamp()))).* FROM union_wallet_transactions u WHERE id=(SELECT union_wallet_transaction_id FROM ca_cash_bank_receipts WHERE hand_id=test_id(2900006));COMMIT;",'Sealed bank source')
# Nothing in either manifest claims released/payed cumulative capacity is final.
check('No financial period or funding/payment receipt is invented by seal primitives',sql('SELECT count(*) FROM ca_source_club_cash_releases;')=='0' and sql('SELECT bool_or(period_closed) FROM ca_accounting_seal_private.bank_manifests;')=='f')
proof={'schema_version':1,'scope':'Private source prefix and exact bank/contributor manifest primitives','production_applied':False,'period_closed':False,'passing':len(checks),'checks':checks,'observed_waits':waits,'runner_sha256':hashlib.sha256((here/'run-local.sh').read_bytes()).hexdigest(),'probe_sha256':hashlib.sha256((here/'native-probe.py').read_bytes()).hexdigest(),'candidate_sha256':hashlib.sha256((here/'01-private-prefix-seals.sql').read_bytes()).hexdigest(),'legacy_bank_definition_sha256':hashlib.sha256(legacy_body.encode()).hexdigest(),'input_commit':'7adbfb02544b68ccc1754c51f11d2f61fa406180','fixture_inputs':{str(p.relative_to(Path(os.environ['ROUND1_INPUT']))):hashlib.sha256(p.read_bytes()).hexdigest() for p in Path(os.environ['ROUND1_INPUT']).rglob('*') if p.is_file()},'limitations':['Private receipt prefix only; no complete periodic/funding/payment finality authority.','Known noncash and NULL envelope classification refuse in this candidate.','No production activation, no historical data edits, no payment or fractional residual policy.','No runtime caller is activated; root must compose the canonical dispatcher and verify its complete scope.']}
(here/'native-proof.json').write_text(json.dumps(proof,indent=2)+'\n');print(json.dumps({'passing':len(checks),'observed_waits':len(waits)}),flush=True)
