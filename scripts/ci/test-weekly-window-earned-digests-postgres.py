#!/usr/bin/env python3
"""Actual earned-plan combine, local PG17, tiny owned fixture; no remote connections."""
import argparse,hashlib,json,os,subprocess,tempfile,shutil,sys,uuid
from pathlib import Path
if os.environ.get('DATABASE_URL'):raise RuntimeError('remote forbidden')
p=argparse.ArgumentParser();p.add_argument('--repo',type=Path,default=Path(__file__).resolve().parents[2]);p.add_argument('--pg-bin',type=Path,required=True);p.add_argument('--scratch',type=Path,required=True);args=p.parse_args()
B=args.scratch.resolve();F=args.repo.resolve()/'scripts/ci/fixtures/weekly-window-digests';pg=args.pg_bin.resolve()
if sys.platform=='darwin' and not str(B).startswith('/Volumes/SmarterWork/agent-work/'):raise RuntimeError('external scratch required')
root=Path(tempfile.mkdtemp(prefix='ed-',dir=B));data=root/'d';started=False
pins=next(x for x in json.loads((F/'replacement.json').read_text())['functions'] if 'earned_plan_combine' in x['signature'])
before=(F/pins['before_file']).read_text();after=(F/pins['after_file']).read_text()
assert hashlib.md5(before.encode()).hexdigest()==pins['before_md5']=='b2e3fd77ed627e13476e440bf7aa5322'
assert hashlib.md5(after.encode()).hexdigest()==pins['after_md5']=='79ea1825fc78b42b0928bac70b5ac4f6'
assert before.replace(pins['old'],pins['new'])==after
sig='fn_accounting_union_earned_plan_combine(uuid,timestamptz,timestamptz)';psql=[pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',root,'-U','postgres','-d','postgres']
def run(cmd,s=None,error=None):
 r=subprocess.run(list(map(str,cmd)),input=s,text=True,capture_output=True,timeout=45)
 if error:assert r.returncode and error in r.stderr,r.stderr
 else:assert r.returncode==0,r.stderr
 return r.stdout.strip()
def q(s,error=None):return run(psql,s,error)
u='fade0000-0000-0000-0000-000000000001';aa='2026-10-05 07:00Z';bb='2026-10-12 07:00Z';call="SELECT "+sig.split('(')[0]+"('"+u+"','"+aa+"','"+bb+"')"
def invoke(inject='',error=None):return q("BEGIN;SET LOCAL app.weekly_accounting_chunked='on';SET LOCAL app.accounting_close_memo='on';"+inject+call+';ROLLBACK;',error)
def ids(ns):return [str(uuid.UUID(hashlib.md5(str(n).encode()).hexdigest())) for n in ns]
def aid(v):return 'NULL::uuid[]' if v is None else 'ARRAY['+','.join("'"+str(i)+"'::uuid" for i in v)+']::uuid[]'
def aby(v):return 'NULL::bytea' if v is None else "decode('"+v.hex()+"','hex')"
cases=[[],[(None,None,None,None)],[([],b'',[],b'')]]
for n in [0,1,15,16,17,31,32,33]:cases.append([(ids([3,1,2]),bytes(range(n)),ids([4,0]),bytes(reversed(range(n))))])
cases += [[(ids([9,1]),b'abc',None,None),(ids([5,3]),b'Z'*33,ids([7]),None)],[(ids([8]),None,ids([2,1]),b'0'*70)]]
# One real TOAST window with incompressible binary digests, interleaved UUID order.
cases.append([(ids(range(1500)),b''.join(hashlib.md5(('cash'+str(n)).encode()).digest() for n in range(1500)),ids(range(2000,2300)),b''.join(hashlib.md5(('fee'+str(n)).encode()).digest() for n in range(300)))])
results=[]
try:
 assert ' 17.' in run([pg/'postgres','--version'])
 run([pg/'initdb','-D',data,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
 with(data/'postgresql.conf').open('a')as f:f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(root)+"'\nshared_buffers='8MB'\ntemp_file_limit='256MB'\n")
 run([pg/'pg_ctl','-D',data,'-l',root/'log','-w','start']);started=True
 q("CREATE ROLE service_role;CREATE TABLE accounting_cash_accrual_cutover(singleton boolean,starts_at timestamptz);INSERT INTO accounting_cash_accrual_cutover VALUES(true,'2026-09-01');CREATE FUNCTION fn_accounting_close_proof_lifetime() RETURNS interval LANGUAGE sql AS $$SELECT interval '72 hours'$$;CREATE FUNCTION fn_accounting_close_windows(timestamptz,timestamptz) RETURNS TABLE(window_start timestamptz,window_end timestamptz) LANGUAGE sql AS $$SELECT g,g+interval '2 hours' FROM generate_series($1,$2-interval '2 hours',interval '2 hours')g$$;CREATE TABLE accounting_close_partials(kind text,union_id uuid,period_start timestamptz,period_end timestamptz,window_start timestamptz,window_end timestamptz,value jsonb,cash_ids uuid[],cash_md5 bytea,fee_ids uuid[],fee_md5 bytea,computed_at timestamptz);")
 q(before+";REVOKE ALL ON FUNCTION "+sig+" FROM PUBLIC;GRANT EXECUTE ON FUNCTION "+sig+" TO service_role;")
 meta="SELECT jsonb_build_array(proowner,prosecdef,provolatile,proacl,proconfig) FROM pg_proc WHERE oid='"+sig+"'::regprocedure";authority=q(meta)
 for index,case in enumerate(cases):
  q("TRUNCATE accounting_close_partials;INSERT INTO accounting_close_partials SELECT 'earned_plan_window','"+u+"','"+aa+"','"+bb+"',w.window_start,w.window_end,jsonb_build_object('bank_sum',10,'source_sum',10,'house_sum',1,'basis',jsonb_build_array(jsonb_build_object('club_id','00000000-0000-0000-0000-000000000002','game_type','cash','rake_in',10,'weighted',3.335))),NULL,NULL,NULL,NULL,clock_timestamp() FROM fn_accounting_close_windows('"+aa+"','"+bb+"')w;")
  for ordinal,row in enumerate(case):
   q('UPDATE accounting_close_partials SET cash_ids='+aid(row[0])+',cash_md5='+aby(row[1])+',fee_ids='+aid(row[2])+',fee_md5='+aby(row[3])+" WHERE window_start='"+aa+"'::timestamptz+interval '2 hours'*"+str(ordinal)+';')
  raw=b''
  for k in[0,2]:
   pairs=[]
   for row in case:
    for no,i in enumerate(row[k]or[]):pairs.append((uuid.UUID(i),b'' if row[k+1]is None else row[k+1][no*16:no*16+16]))
   raw+=b''.join(d.hex().encode()for _,d in sorted(pairs))
  want=hashlib.md5(raw).hexdigest();q(before);out_before=invoke();q(after);out_after=invoke();assert out_before==out_after;(o:=json.loads(out_after));assert o['source_fingerprint']==want;assert o['period_rake']==840 and o['earned_rake']==840 and o['house_rake']==84 and o['basis_detail'][0]['payout']==280.14;assert authority==q(meta)
  results.append({'case':index,'independent_fingerprint':want,'whole_result_parity':True})
 refusals=[("SET LOCAL app.weekly_accounting_chunked='off';",None),("SET LOCAL app.accounting_close_memo='off';",None),("UPDATE accounting_cash_accrual_cutover SET starts_at='2026-10-20';",None),("DELETE FROM accounting_close_partials WHERE window_start='"+aa+"';",None),("UPDATE accounting_close_partials SET computed_at=clock_timestamp()-interval '73 hours' WHERE window_start='"+aa+"';",None),("UPDATE accounting_close_partials SET value=jsonb_set(value,'{bank_sum}','11'::jsonb) WHERE window_start='"+aa+"';",'union_earned_rake_does_not_conserve_bank')]
 for inject,error in refusals:
  q(before);x=invoke(inject,error);q(after);y=invoke(inject,error);assert x==y
 # Read back the actual complete installed function and authority.
 actual=q("SELECT pg_get_functiondef('"+sig+"'::regprocedure)");assert actual==after.strip();assert q("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure))")==hashlib.md5(after.encode()).hexdigest();assert q(meta)==authority
 result={'qualification':'passed','before_md5':hashlib.md5(before.encode()).hexdigest(),'after_md5':hashlib.md5(after.encode()).hexdigest(),'full_actual_owner':True,'boundary_cases':len(cases),'refusal_cases':len(refusals),'independent_python_oracle':True,'global_uuid_sort_cash_before_fee':True,'partial_short_extra_null_digests_preserved':True,'whole_json_money_and_basis_unchanged':True,'authority_preserved':True,'actual_pg_function_definition_exact':True,'real_toast_case_cash_ids':1500,'real_toast_case_fee_ids':300,'large_scale_not_run_pending_root_space_preflight':True,'full_financial_close_qualified':False}
 (B/'weekly-window-earned-native-result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
finally:
 if started:run([pg/'pg_ctl','-D',data,'-m','fast','-w','stop'])
 shutil.rmtree(root)
