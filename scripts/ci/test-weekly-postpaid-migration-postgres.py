from pathlib import Path
import argparse,subprocess,tempfile,socket,os,sys,json,hashlib,shutil,re
p=argparse.ArgumentParser()
for x in ['candidate','owners','discovery','scratch','pg-bin','output']:p.add_argument('--'+x,type=Path,required=True)
a=p.parse_args();assert not a.output.exists();assert sys.platform!='darwin'or a.scratch.resolve().is_relative_to(Path('/Volumes/SmarterWork/agent-work'))
inputs=[Path(__file__).resolve(),a.candidate,a.owners,a.discovery];snap={str(x):x.read_bytes()for x in inputs};sha=lambda b:hashlib.sha256(b).hexdigest();M=a.candidate.read_text();assert sha(M.encode())=='10e207ba202252a729559410448e2c3bc586a872712c9c36f5f25d132bce8368';rows=json.loads(a.owners.read_text())['owners']+json.loads(a.discovery.read_text())['owners'];assert len(rows)==13
D=Path(tempfile.mkdtemp(prefix='guarded-native-',dir=a.scratch));data=D/'pg';env={k:v for k,v in os.environ.items()if not k.startswith('PG')and k not in ('DATABASE_URL','SUPABASE_DB_URL')};env.update(TMPDIR=str(D),LC_ALL='C',LANG='C');started=False;cases=[]
with socket.socket()as s:s.bind(('127.0.0.1',0));port=str(s.getsockname()[1])
def run(sql):return subprocess.run([str(a.pg_bin/'psql'),'-XqAt','-h','127.0.0.1','-p',port,'-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],input='SET check_function_bodies=off;'+sql,text=True,capture_output=True,env=env,timeout=30)
def q(sql):
 r=run(sql);assert r.returncode==0,r.stderr;return r.stdout.strip()
def state():return {r['signature']:json.loads(q("SELECT jsonb_build_object('md5',md5(pg_get_functiondef(p.oid)),'metadata',to_jsonb(p)-'prosrc')FROM pg_proc p WHERE oid='"+r['signature']+"'::regprocedure;"))for r in rows}
def reset():
 for r in rows:q(r['definition']+';')
 for sig in ['public.fn_process_weekly_accounting_scope(uuid,uuid)','smarter_private.weekly_payout_eligible_scopes(timestamptz,timestamptz)']:q('REVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC,anon,authenticated,service_role;')
 q("TRUNCATE supabase_migrations.schema_migrations;CREATE OR REPLACE FUNCTION fn_platform_frozen()RETURNS boolean LANGUAGE sql AS $$SELECT false$$;CREATE OR REPLACE FUNCTION smarter_private.original_inventory_proof_sources_match()RETURNS boolean LANGUAGE sql AS $$SELECT true$$;CREATE OR REPLACE FUNCTION smarter_private.original_inventory_basis_generation()RETURNS text LANGUAGE sql AS $$SELECT 'original-inventory-245-v1:05f51b14eb6ebcb361fd88f7ba7a7343'::text$$;")
def refused(edited,err):
 b=state();r=run(edited);assert r.returncode!=0 and err in r.stderr,r.stderr;assert state()==b,'failed migration changed owner state'
try:
 subprocess.run([str(a.pg_bin/'initdb'),'-D',str(data),'-U','postgres','-A','trust','--no-locale'],env=env,stdout=subprocess.DEVNULL,check=True);subprocess.run([str(a.pg_bin/'pg_ctl'),'-D',str(data),'-l',str(D/'pg.log'),'-o',f"-k '' -h 127.0.0.1 -p {port} -c fsync=off",'-w','start'],env=env,stdout=subprocess.DEVNULL,check=True);started=True
 q('CREATE SCHEMA smarter_private;CREATE SCHEMA supabase_migrations;CREATE TABLE supabase_migrations.schema_migrations(version text);CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;')
 reset();old=state();assert all(old[r['signature']]['md5']==r['md5']for r in rows)
 native=[{'signature':r['signature'],'md5':r['md5'],'metadata':old[r['signature']]['metadata']}for r in rows];tag='$postpaid_expected_owners$';assert M.count(tag)==2;parts=M.split(tag);B=parts[0]+tag+json.dumps(native,separators=(',',':'))+tag+parts[2];assert B.split(tag)[0]==parts[0]and B.split(tag)[2]==parts[2]
 q(B);after=state()
 for r in rows:
  sig=r['signature'];want='e4f6b4adc2f43ccd2b7ecd90f2434538'if sig.startswith('public.fn_process_weekly_accounting_scope(')else 'c2268481918932ae2d8be5a5acf72e9a'if sig.startswith('smarter_private.weekly_payout_eligible_scopes(')else r['md5'];assert after[sig]['md5']==want and after[sig]['metadata']==old[sig]['metadata']
 cases.append('exact_guarded_migration_two_owner_success_all13_body_and_metadata_postimages')
 for label,sql,error in [
 ('wrong_scope_body',next(r['definition']for r in rows if r['signature'].startswith('public.fn_process_weekly_accounting_scope(')).replace('AS $function$','AS $function$\n-- native changed scope body',1)+';','postpaid_scope_exact_preimage_changed'),
 ('unrelated_report_body',next(r['definition']for r in rows if r['signature'].startswith('public.fn_union_pnl_evidence_report(')).replace('AS $function$','AS $function$\n-- native changed unrelated report body',1)+';','postpaid_scope_exact_preimage_changed'),
 ('metadata_acl_drift','GRANT EXECUTE ON FUNCTION public.fn_process_weekly_accounting_scope(uuid,uuid)TO service_role;','postpaid_scope_exact_preimage_changed'),
 ('source65_false','CREATE OR REPLACE FUNCTION smarter_private.original_inventory_proof_sources_match()RETURNS boolean LANGUAGE sql AS $$SELECT false$$;','postpaid_scope_original_inventory_changed'),
 ('generation_bad',"CREATE OR REPLACE FUNCTION smarter_private.original_inventory_basis_generation()RETURNS text LANGUAGE sql AS $$SELECT 'wrong'::text$$;",'postpaid_scope_original_inventory_changed'),
 ('frozen','CREATE OR REPLACE FUNCTION fn_platform_frozen()RETURNS boolean LANGUAGE sql AS $$SELECT true$$;','postpaid_scope_maintenance_refused'),
 ('already_installed',"INSERT INTO supabase_migrations.schema_migrations VALUES('20261031162838');",'postpaid_scope_version_already_installed')]:
  reset();q(sql);refused(B,error);cases.append(label+'_refuses_no_owner_changes')
 reset();fault=B.replace(' EXECUTE e;',' EXECUTE e;\n RAISE EXCEPTION \'native_late_fault\';');assert fault!=B;refused(fault,'native_late_fault');cases.append('late_fault_after_both_execute_rolls_back_both_body_and_metadata_changes')
 for k,b in snap.items():assert Path(k).read_bytes()==b
 a.output.write_text(json.dumps({'passed':True,'case_count':len(cases),'cases':cases,'input_sha256':{k:sha(v)for k,v in snap.items()},'rebound_migration_sha256':sha(B.encode()),'limits':['Only expected-owner metadata JSON is rebound to isolated native pg_proc OIDs/ACLs; all full body MD5s and every other candidate byte stay exact.','Native source65/generation/freeze are explicit controlled boundaries, not actual original inventory proof.','All13 actual owner definitions compile with check_function_bodies off; this suite invokes migration guards, not owner business bodies. Separate19+7 suites qualify connected scope/discovery behavior.','Late-fault variant is explicitly instrumented native rollback control, never production candidate.']},indent=2)+'\n');print(json.dumps({'passed':True,'cases':len(cases),'output':str(a.output)}))
finally:
 if started:subprocess.run([str(a.pg_bin/'pg_ctl'),'-D',str(data),'-m','fast','-w','stop'],env=env,stdout=subprocess.DEVNULL,check=True)
 shutil.rmtree(D)
