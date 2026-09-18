#!/usr/bin/env python3
"""Mixed-cutover original Spin settlement in the existing full native runner."""
import hashlib,json,subprocess,sys
from pathlib import Path
root=Path(__file__).resolve().parents[2]
psql,socket,port,database,work=sys.argv[1:];work=Path(work);work.mkdir(exist_ok=True,parents=True)
fix=root/'tests/fixtures/spin-mixed-cutover'
if database!='postgres' or not socket.startswith('/'):raise AssertionError('Existing private native cluster required')
binding=json.loads((fix/'source-binding.json').read_text())
for relative,expected in binding['repository_files'].items():
 if hashlib.sha256((root/relative).read_bytes()).hexdigest()!=expected:raise AssertionError('Unreviewed mixed Spin source drift: '+relative)
subprocess.run([sys.executable,str(fix/'build-candidate.py'),'--check'],check=True)

cmd=[psql,'-X','-q','-v','ON_ERROR_STOP=1','-U','postgres','-h',socket,'-p',port,'-d',database,'-c',"SET timezone='UTC';"]
def run(sql,label):
 path=work/(label+'.sql');path.write_text(sql)
 r=subprocess.run(cmd+['-f',str(path)],capture_output=True,text=True)
 (work/(label+'.log')).write_text(r.stdout+r.stderr)
 if r.returncode:raise AssertionError(label+': '+r.stderr[-5000:])
 print('PASS '+label,flush=True)
rows=json.loads((fix/'captured-preimages.json').read_text())['functions'];sql=''
for r in rows:
 sql+=r['definition']+';\nREVOKE ALL ON FUNCTION public.'+r['identity']+' FROM PUBLIC,anon,authenticated,service_role;\n'
 for a in r['acl']:
  if a.startswith('service_role='):sql+='GRANT EXECUTE ON FUNCTION public.'+r['identity']+' TO service_role;\n'
run(sql,'mixed-spin-original-preimages')
run((root/'tests/fixtures/tournament-fee-lifecycle/full-lifecycle-seed.sql').read_text(),'mixed-spin-original-store-contracts')
run((fix/'setup.sql').read_text(),'mixed-spin-original-setup')
run(next((root/'supabase/migrations').glob('20260918085836*.sql')).read_text(),'mixed-spin-successor')
run((fix/'after.sql').read_text(),'mixed-spin-original-settlement')
run((fix/'concurrency.sql').read_text(),'mixed-spin-concurrency-scene')
import time
# Hold the actual original paid admission/fee transaction uncommitted. A real
# close in another backend must wait on that owner's tournament row lock.
interactive=[psql,'-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-h',socket,'-p',port,'-d',database]
def start_session(label):
 log=(work/(label+'.log')).open('w')
 p=subprocess.Popen(interactive,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True)
 return p,log
def send(p,sql):p.stdin.write(sql+'\n');p.stdin.flush()
def ready(p,marker):
 while True:
  line=p.stdout.readline()
  if not line:raise AssertionError('Original backend did not signal '+marker)
  if line.strip()==marker:return
admission,admission_log=start_session('mixed-spin-admission')
try:
 send(admission,"SET timezone='UTC'; BEGIN; SELECT spin_fixture.complete_union_original_admission(); SELECT 'ADMISSION_READY';")
 ready(admission,'ADMISSION_READY')
 closers=[subprocess.Popen(interactive+['-c',"SET timezone='UTC'; SELECT public.fn_settle_tournament_rake(spin_fixture.u(202),'mixed-concurrent-close-"+str(i)+"');"],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) for i in range(2)]
 try:
  time.sleep(.2)
  if any(p.poll() is not None for p in closers):raise AssertionError('Settlement bypassed uncommitted original admission')
  state=subprocess.check_output(cmd+['-At','-c',"SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%mixed-concurrent-close-%' AND wait_event_type='Lock';"],text=True).strip()
  if state!='2':raise AssertionError('Both original closes were not proven waiting on their locks: '+state)
  out,_=admission.communicate('COMMIT;\n',timeout=20)
  if admission.returncode:raise AssertionError('Original admission commit failed: '+out)
  results=[]
  for i,p in enumerate(closers):
   out,err=p.communicate(timeout=20);(work/('mixed-spin-admission-close-'+str(i)+'.log')).write_text(out+err)
   if p.returncode:raise AssertionError(out+err)
   results.extend(json.loads(line) for line in out.splitlines() if line.startswith('{'))
  if len(results)!=2 or not all(r.get('ok') is True for r in results) or sum(r.get('already_settled') is True for r in results)!=1:
   raise AssertionError('Competing first closes did not produce one new settlement and one replay: '+repr(results))
 finally:
  for p in closers:
   if p.poll() is None:p.kill();p.wait()

finally:
 if admission.poll() is None:admission.kill();admission.wait()
 admission_log.close()
run("""
SELECT spin_fixture.assert((SELECT count(*)=3 AND sum(rake_credit)=.48 AND bool_and(union_id=spin_fixture.u(151)) FROM public.accounting_tournament_fee_sources WHERE tournament_id=spin_fixture.u(202))
 AND (SELECT count(*)=1 AND sum(amount)=.48 FROM public.union_wallet_transactions WHERE union_id=spin_fixture.u(151) AND wallet='rake_wallet' AND direction='credit' AND tx_type='rake')
 AND (SELECT count(*)=1 FROM public.accounting_mixed_cutover_spin_fee_proofs WHERE tournament_id=spin_fixture.u(202))
 AND (SELECT fee_balance=0 FROM public.tournament_escrow WHERE tournament_id=spin_fixture.u(202)),
 'Original close waits for original admission then conserves one Union bank credit');
SELECT spin_fixture.assert(public.fn_accounting_tournament_week_quality(spin_fixture.u(102),now()-interval '1 day',now()+interval '1 day')->>'status'='ready',
 'Original Union earning scope reaches the existing weekly quality reader');
""",'mixed-spin-admission-proof')
# The competing first close above must retain only one financial result.
run("""
SELECT spin_fixture.assert((SELECT count(*)=1 AND sum(amount)=.48 FROM public.union_wallet_transactions WHERE union_id=spin_fixture.u(151) AND wallet='rake_wallet' AND direction='credit' AND tx_type='rake')
 AND (SELECT count(*)=1 FROM public.accounting_tournament_fee_recognitions WHERE tournament_id=spin_fixture.u(202))
 AND (SELECT count(*)=1 FROM public.accounting_mixed_cutover_spin_fee_proofs WHERE tournament_id=spin_fixture.u(202)),
 'Concurrent duplicate original closes retain exactly one payment proof and recognition');
""",'mixed-spin-concurrent-proof')
def capture(query,label):
 result=subprocess.check_output(cmd+['-At','-c',query],text=True)
 (work/(label+'.json')).write_text(json.dumps(json.loads(result),indent=2)+'\n')
capture("""SELECT jsonb_agg(to_jsonb(x) ORDER BY identity) FROM (
 SELECT p.oid::regprocedure::text identity,pg_get_functiondef(p.oid) definition,
 md5(pg_get_functiondef(p.oid)) definition_md5,md5(p.prosrc) source_md5,
 pg_get_userbyid(p.proowner) owner,p.proacl::text acl,p.proconfig config
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
 AND p.proname IN('fn_settle_tournament_rake','fn_accounting_tournament_fee_net_plan',
 'fn_accounting_mixed_cutover_spin_proof_valid','fn_accounting_qualify_mixed_cutover_spin_fee'))x""",'mixed-spin-qualified-functions')
capture("""SELECT jsonb_build_object('columns',(SELECT jsonb_agg(to_jsonb(x)) FROM (
 SELECT a.attname,format_type(a.atttypid,a.atttypmod) type,a.attnotnull,pg_get_expr(d.adbin,d.adrelid) default_expr
 FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
 WHERE a.attrelid='public.accounting_mixed_cutover_spin_fee_proofs'::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum)x),
 'triggers',(SELECT jsonb_agg(to_jsonb(x)) FROM(SELECT tgname,tgenabled,pg_get_triggerdef(oid) definition FROM pg_trigger
 WHERE tgrelid='public.accounting_mixed_cutover_spin_fee_proofs'::regclass AND NOT tgisinternal ORDER BY tgname)x),
 'relation',(SELECT jsonb_build_object('owner',pg_get_userbyid(relowner),'acl',relacl::text,'rls',relrowsecurity) FROM pg_class
 WHERE oid='public.accounting_mixed_cutover_spin_fee_proofs'::regclass))""",'mixed-spin-qualified-relation')
capture("""SELECT jsonb_build_object('proofs',(SELECT jsonb_agg(to_jsonb(p) ORDER BY tournament_id) FROM public.accounting_mixed_cutover_spin_fee_proofs p),
 'settlements',(SELECT jsonb_agg(to_jsonb(s) ORDER BY tournament_id) FROM public.tournament_rake_settlements s WHERE tournament_id IN(spin_fixture.u(201),spin_fixture.u(202))))""",'mixed-spin-qualified-original-close')
inputs=json.loads((fix/'source-binding.json').read_text())['repository_files']
(work/'mixed-spin-tested-binding.json').write_text(json.dumps({p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in inputs},indent=2)+'\n')
import re
count=sum(len(re.findall(r'NOTICE:\s+PASS ',p.read_text())) for p in work.glob('mixed-spin-*.log'))
expected=json.loads((fix/'source-binding.json').read_text())['expected_assertion_executions']
if count!=expected:raise AssertionError(f'Mixed Spin assertions expected {expected}, observed {count}')
print(f'PASS {count} original mixed-cutover Spin assertions and two original backend races',flush=True)
