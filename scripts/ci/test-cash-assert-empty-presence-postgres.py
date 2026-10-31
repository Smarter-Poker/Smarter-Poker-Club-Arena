from pathlib import Path
import subprocess,socket,json,re,hashlib,shutil,sys
import argparse,tempfile,os
p=argparse.ArgumentParser();p.add_argument('--pg-bin',type=Path,required=True);p.add_argument('--scratch',type=Path,required=True);p.add_argument('--out-dir',type=Path,required=True);p.add_argument('--candidate',type=Path,required=True);p.add_argument('--guard-only',action='store_true');args=p.parse_args()
if os.environ.get('DATABASE_URL'):raise RuntimeError('remote database forbidden')
W=Path(__file__).resolve().parents[2];D=W/'scripts/ci/fixtures/cash-assert-empty-presence';B=args.pg_bin
if sys.platform=='darwin'and not str(args.scratch.resolve()).startswith('/Volumes/SmarterWork/agent-work/'):raise RuntimeError('external SSD scratch required')
assert re.search(r'\b17\.',subprocess.run([str(B/'postgres'),'--version'],check=True,capture_output=True,text=True).stdout),'PG17 required'
assert (D/'after.sql').read_text().rstrip()in args.candidate.read_text(),'actual maintained candidate must contain exact qualified49069 function body'
args.out_dir.mkdir(parents=True,exist_ok=True)
work=Path(tempfile.mkdtemp(prefix='cash-empty-',dir=args.scratch));data=work/'pgdata'
subprocess.run([str(B/'initdb'),'-D',str(data),'-U','postgres','--auth=trust','--no-locale'],check=True,capture_output=True)
with socket.socket()as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
subprocess.run([str(B/'pg_ctl'),'-D',str(data),'-l',str(work/'native.log'),'-o',f"-k '' -p {port} -h 127.0.0.1",'-w','start'],check=True,capture_output=True)
def q(sql):
 p=subprocess.run([str(B/'psql'),'-XqAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',str(port),'-U','postgres','-d','postgres'],input=sql,text=True,capture_output=True);assert not p.returncode,p.stderr;return p.stdout.strip()
def uid(n):return 'ca351340-0000-0000-0000-'+str(n).zfill(12)
def sqluid(n):return "'"+uid(n)+"'::uuid"if n is not None else 'NULL::uuid'
def row(n=100,club=1,amount='1',tournament='NULL',tid='NULL',hand=None,table=90,metadata='{}',created='2026-10-21 12:00Z'):
 return f"INSERT INTO public.rake_records VALUES({sqluid(n)},'{created}'::timestamptz,{amount},{tournament},{tid},{sqluid(club)},{sqluid(hand)},{sqluid(table)},'{metadata}'::jsonb);"
try:
 F=W/'tests/fixtures/weekly-close-scale/preimage'
 ddl="""CREATE SCHEMA auth;CREATE FUNCTION auth.role()RETURNS text LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('request.jwt.claim.role',true),'')$$;CREATE FUNCTION auth.uid()RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid$$;CREATE TABLE public.rake_records(id uuid PRIMARY KEY,created_at timestamptz,rake_amount numeric,is_tournament boolean,tournament_id uuid,club_id uuid,hand_id uuid,table_id uuid,metadata jsonb);CREATE TABLE public.accounting_cash_accrual_batches(rake_record_id uuid PRIMARY KEY,status text);CREATE TABLE public.rake_attributions(rake_record_id uuid,club_id uuid);CREATE TABLE public.union_clubs(union_id uuid,club_id uuid);CREATE TABLE public.ca_launch_accounting_boundaries(scope_kind text,scope_id uuid,cutoff_at timestamptz,undone_at timestamptz);SET check_function_bodies=off;"""
 q(ddl+';'.join((F/n).read_text().rstrip()for n in ['fn_caller_is_engine.sql','fn_is_union_overseer.sql','fn_rake_record_is_ghost_twin.sql'])+';')
 launch=(W/'supabase/migrations/20261012181905_scoped_club_launch_reset_and_guarded_recovery.sql').read_text()
 for name in ['fn_ca_launch_accounting_cutoff','fn_ca_launch_accounting_accepts']:
  m=re.search(r'CREATE FUNCTION public\.'+name+r'\(.*?\$\$\s*;',launch,re.S);assert m;q(m.group())
 q("CREATE FUNCTION public.native_observe(u uuid,c uuid,f timestamptz,t timestamptz)RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN PERFORM public.fn_assert_cash_commission_period(u,c,f,t);RETURN jsonb_build_object('success',true);EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('success',false,'sqlstate',SQLSTATE,'message',SQLERRM);END$$;")
 old=(D/'before.sql').read_text();new=(D/'after.sql').read_text();q(old+';');oldmd5=q("SELECT md5(pg_get_functiondef('public.fn_assert_cash_commission_period(uuid,uuid,timestamptz,timestamptz)'::regprocedure));");assert oldmd5=='0df1c3e9fe3e1a0e53a043baf57127d7';assert 'scoped_unaccrued AS MATERIALIZED' in new and "AND (b.status IS DISTINCT FROM 'accrued')" in new;q(new+';');newmd5=q("SELECT md5(pg_get_functiondef('public.fn_assert_cash_commission_period(uuid,uuid,timestamptz,timestamptz)'::regprocedure));");assert newmd5==hashlib.md5(new.encode()).hexdigest()=='49069d66667813f6f332b8f72c523295'
 import importlib.util
 spec=importlib.util.spec_from_file_location('cash_assert_guard_smoke',D/'guard_smoke.py');smoke=importlib.util.module_from_spec(spec);spec.loader.exec_module(smoke)
 guard_result=smoke.run(q,args.candidate,old,new,args.out_dir)
 cases=[]
 def add(name,setup='',u=None,c=1,expected='OK',role=None,f='2026-10-19 07:00Z',t='2026-10-26 07:00Z'):cases.append((name,setup,u,c,expected,role,f,t))
 add('empty_club');add('empty_union',u=10,c=None);add('unrelated_missing_receipt',row(club=2));add('direct_missing_receipt',row(),expected='55000');add('partial_pending_receipt',row()+f"INSERT INTO accounting_cash_accrual_batches VALUES({sqluid(100)},'pending');",expected='55000');add('null_status',row()+f"INSERT INTO accounting_cash_accrual_batches VALUES({sqluid(100)},NULL);",expected='55000');add('accrued_receipt',row()+f"INSERT INTO accounting_cash_accrual_batches VALUES({sqluid(100)},'accrued');")
 add('multi_attribution',row(club=2)+f"INSERT INTO rake_attributions VALUES({sqluid(100)},{sqluid(1)}),({sqluid(100)},{sqluid(1)}),({sqluid(100)},{sqluid(3)});",expected='55000')
 add('union_direct_id',row(club=10),u=10,c=None,expected='55000');add('union_member',row(club=2)+f"INSERT INTO union_clubs VALUES({sqluid(10)},{sqluid(2)});",u=10,c=None,expected='55000');add('union_attributed_member',row(club=3)+f"INSERT INTO union_clubs VALUES({sqluid(10)},{sqluid(2)});INSERT INTO rake_attributions VALUES({sqluid(100)},{sqluid(2)});",u=10,c=None,expected='55000')
 add('null_global_scope',row(),u=None,c=None,expected='22023');add('both_scopes_invalid',row(),u=10,c=1,expected='22023');add('null_from',row(),expected='22023',f=None);add('reversed_period',row(),expected='22023',f='2026-10-26 07:00Z',t='2026-10-19 07:00Z');add('unauthenticated_claim',row(),role='authenticated',expected='42501')
 add('horse_record_same_refusal',row(metadata='{"is_horse":true}'),expected='55000');add('cash_NULL_tournament_flag',row(tournament='NULL'),expected='55000');add('tournament_flag_excluded',row(tournament='true'));add('tournament_id_excluded',row(tid=sqluid(55)));add('zero_amount_excluded',row(amount='0'));add('negative_amount_excluded',row(amount='-1'))
 add('ghost_global_hand_twin',row(hand=None,metadata='{"hand_number":"1000001"}')+row(n=101,club=2,amount='0',hand=75,metadata='{"hand_number":"1000001"}'))
 add('null_hand_not_ghost',row(hand=None,metadata='{"hand_number":"12"}'),expected='55000');add('linked_hand_never_ghost',row(hand=75,metadata='{"hand_number":"1000001"}'),expected='55000')
 add('launch_before_cutoff_excluded',row()+f"INSERT INTO ca_launch_accounting_boundaries VALUES('club',{sqluid(1)},'2026-10-22Z',NULL);")
 add('launch_at_cutoff_refuses',row()+f"INSERT INTO ca_launch_accounting_boundaries VALUES('club',{sqluid(1)},'2026-10-21 12:00Z',NULL);",expected='55000')
 add('undone_launch_cutoff_ignored',row()+f"INSERT INTO ca_launch_accounting_boundaries VALUES('club',{sqluid(1)},'2026-10-22Z','2026-10-23Z');",expected='55000')
 results=[]
 if args.guard_only:cases=[]
 for name,setup,u,c,expected,role,f,t in cases:
  q('TRUNCATE rake_records,accounting_cash_accrual_batches,rake_attributions,union_clubs,ca_launch_accounting_boundaries;'+setup)
  call="SELECT public.native_observe("+sqluid(u)+','+sqluid(c)+','+("'"+f+"'::timestamptz"if f else'NULL::timestamptz')+','+("'"+t+"'::timestamptz"if t else'NULL::timestamptz')+');'
  prefix="SET request.jwt.claim.role='"+(role or '')+"';"
  before=json.loads(q(old+';'+prefix+call));after=json.loads(q(new+';'+prefix+call));assert before==after,(name,before,after);assert ('OK'if after.get('success')else after['sqlstate'])==expected,(name,after);results.append({'case':name,'same_exact_success_or_sqlstate_message':True,'result':after})
 result={'source_only_native_PG17':True,'original_canonical_md5':oldmd5,'candidate_canonical_md5':newmd5,'cases':results,'case_count':len(results),'actual_auth_caller_ghost_and_current_launch_helpers':True,'authorization_overseer_helper_body_present_but_no_nonnull_overseer_claim_case':True,'no_production_calls':True,'native_installer_guards':guard_result,'guard_only':args.guard_only};(args.out_dir/'cash-assert-empty-presence-native-result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'cases':len(results),'candidate_md5':newmd5,'PASS':True}))
finally:
 subprocess.run([str(B/'pg_ctl'),'-D',str(data),'-m','fast','-w','stop'],check=True,capture_output=True);shutil.rmtree(work)
