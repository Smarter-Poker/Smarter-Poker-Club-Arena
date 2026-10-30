from pathlib import Path
import os,json,subprocess,tempfile,shutil,socket,hashlib,re
import argparse
a=argparse.ArgumentParser();a.add_argument('--repo',type=Path,required=True);a.add_argument('--pg-bin',type=Path,required=True);a.add_argument('--scratch',type=Path,required=True);a.add_argument('--output',type=Path,required=True);args=a.parse_args();FIX=Path(__file__).parent;D=Path(tempfile.mkdtemp(prefix='fee-current-',dir=args.scratch));R=args.repo;PG=args.pg_bin;W=Path(tempfile.mkdtemp(prefix='native-',dir=D));data=W/'data';E=dict(os.environ,LC_ALL='C',LANG='C');started=False;cases=[]
with socket.socket()as sk:sk.bind(('127.0.0.1',0));port=str(sk.getsockname()[1])
def cmd(args,input=None):
 if input is None:return subprocess.run(list(map(str,args)),text=True,capture_output=True,env=E,timeout=60)
 with tempfile.TemporaryFile(mode='w+',dir=W)as f:
  f.write(input);f.seek(0);return subprocess.run(list(map(str,args)),stdin=f,text=True,capture_output=True,env=E,timeout=60)
def q(s,check=True):
 r=cmd([PG/'psql','-XqAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','postgres'],s)
 if check:assert r.returncode==0,(r.stdout,r.stderr)
 return r
old=(FIX/'fee-before.sql').read_text();new=(R/'supabase/accounting/weekly-v3/current/fn_accounting_tournament_fee_net_plan.sql').read_text();cand=new.replace('public.fn_accounting_tournament_fee_net_plan(','public.native_candidate(',1)
def owner(path,name):
 s=path.read_text();m=re.search(r'CREATE (?:OR REPLACE )?FUNCTION public\.'+name+r'\(',s);assert m,name
 a=m.start();tag=re.search(r'AS (\$\w*\$)',s[a:]).group(1);b=s.index(tag,s.index(tag,a)+len(tag))+len(tag);return s[a:b]+';'
try:
 r=cmd([PG/'initdb','-D',data,'-U','postgres','-A','trust','--no-locale']);assert r.returncode==0,r.stderr
 r=cmd([PG/'pg_ctl','-D',data,'-l',W/'pg.log','-w','start','-o',f"-k '' -p {port} -h 127.0.0.1 -c fsync=off"]);assert r.returncode==0,r.stderr;started=True
 # Existing access-contract schema; replace all fee-proof external function
 # boundaries with exact actual owners before any tested feeplan call.
 schema=(R/'scripts/ci/fixtures/weekly-statement-indexed-quality/schema.sql').read_text();q(schema);q((R/'scripts/ci/fixtures/weekly-statement-indexed-quality/cases.sql').read_text())
 q('ALTER TABLE rake_records ADD COLUMN terminal_closed_at timestamptz;ALTER TABLE tournament_cancellation_receipts ADD COLUMN fee_reversal_ids uuid[],ADD COLUMN total_rake_after numeric,ADD COLUMN fees_reversed numeric,ADD COLUMN total_rake_before numeric;CREATE TABLE tournament_unregistration_receipts(tournament_id uuid,fee_reversal_ids uuid[],fee_source_rake_record_ids uuid[],user_id uuid);')
 fp=json.loads((FIX/'fingerprint-owner.json').read_text());q('DROP FUNCTION fn_accounting_tournament_fee_fingerprint(rake_records);'+fp['definition']+';')
 q('SET check_function_bodies=off;'+owner(R/'supabase/migrations/20261019180622_owner_fee_capture_resumes_in_its_original_close.sql','fn_accounting_owner_direct_fee_proof_valid'))
 q('DROP FUNCTION fn_accounting_mixed_cutover_spin_proof_valid(uuid);SET check_function_bodies=off;'+owner(R/'supabase/migrations/20260918085836_original_mixed_cutover_spin_fee_proof.sql','fn_accounting_mixed_cutover_spin_proof_valid'))
 phys=json.loads((R/'scripts/ci/fixtures/tournament-quality-bounded-evidence/physical-installed.json').read_text());
 # Exact maintained raw-size helper; input is JSON, not a replaced proof.
 helper=phys['helper']['definition'];q(helper+';')
 for idx in json.loads((FIX/'exact-cover-indexes.json').read_text()):q(idx+';')
 q('DROP FUNCTION fn_accounting_tournament_fee_net_plan(uuid);'+old+';'+cand+';')
 assert q("SELECT md5(pg_get_functiondef('fn_accounting_tournament_fee_net_plan(uuid)'::regprocedure))").stdout.strip()=='55d5cd47a5432866a544a455d1a774fe'
 seed="SELECT fixture.reset();SELECT fixture.event(100);UPDATE rake_records SET metadata=jsonb_build_object('user_id',fixture.u(50));UPDATE accounting_tournament_fee_batches b SET source_fingerprint=fn_accounting_tournament_fee_fingerprint(r)FROM rake_records r WHERE r.id=b.rake_record_id;"
 def outcome(name,change='',expected=None):
  q(seed+change)
  out=[]
  for fn in ['fn_accounting_tournament_fee_net_plan','native_candidate']:
   r=q('SELECT '+fn+'(fixture.u(100));',False);out.append((r.returncode,r.stdout.strip(),re.search(r'ERROR:  (.*)',r.stderr).group(1)if r.returncode else''))
  assert out[0]==out[1],(name,out)
  if expected:assert expected in out[0][2],(name,out)
  else:assert out[0][0]==0,(name,out)
  cases.append({'case':name,'passed':True,'outcome':out[0]})
 outcome('captured-positive')
 outcome('large-evidence-positive',"UPDATE rake_records SET metadata=metadata||jsonb_build_object('padding',repeat('x',3000));UPDATE accounting_tournament_fee_batches b SET source_fingerprint=fn_accounting_tournament_fee_fingerprint(r)FROM rake_records r WHERE r.id=b.rake_record_id;")
 outcome('terminal-marker-irrelevant',"UPDATE rake_records SET terminal_closed_at='2026-10-07 12:00Z';")
 outcome('invalid-hand',"UPDATE rake_records SET hand_id=fixture.u(42);",'tournament_fee_source_invalid')
 outcome('invalid-NaN',"UPDATE rake_records SET rake_amount='NaN';",'tournament_fee_source_invalid')
 outcome('invalid-cent',"UPDATE rake_records SET rake_amount=100.0001;",'tournament_fee_source_invalid')
 outcome('invalid-fingerprint',"UPDATE accounting_tournament_fee_batches SET source_fingerprint='wrong';",'tournament_fee_sources_require_reconciliation')
 outcome('wrong-batch-event',"UPDATE accounting_tournament_fee_batches SET tournament_id=fixture.u(101);",'tournament_fee_sources_require_reconciliation')
 outcome('source-outside-positive-bag',"UPDATE accounting_tournament_fee_sources SET rake_record_id=fixture.u(999);",'tournament_fee_sources_require_reconciliation')
 refund="INSERT INTO rake_records(id,tournament_id,is_tournament,rake_amount,club_id,created_at,rake_method,source,metadata)VALUES(fixture.u(900),fixture.u(100),true,-100,fixture.u(1),'2026-10-07 12:00Z','fixture','fn_unregister_from_tournament',jsonb_build_object('user_id',fixture.u(50),'original_rake_record_id',fixture.u(100100)));INSERT INTO tournament_unregistration_receipts VALUES(fixture.u(100),ARRAY[fixture.u(900)],ARRAY[fixture.u(100100)],fixture.u(50));"
 outcome('valid-full-refund',refund)
 outcome('wrong-refund-club',refund+"UPDATE rake_records SET club_id=fixture.u(2)WHERE id=fixture.u(900);",'tournament_fee_refund_not_exact_full_sources')
 outcome('foreign-event-refund-reference',refund+"UPDATE rake_records SET metadata=jsonb_set(metadata,'{original_rake_record_id}',to_jsonb(fixture.u(999)::text))WHERE id=fixture.u(900);",'tournament_fee_refund_source_ids_invalid')
 outcome('missing-refund-witness',refund+'TRUNCATE tournament_unregistration_receipts;','tournament_fee_refund_receipt_missing')
 for value in ['NULL',"'Infinity'","'-Infinity'"]:
  q(seed);r=q('UPDATE rake_records SET rake_amount='+value+';',False);assert r.returncode,(value,'expected actual numeric/NULL schema exclusion');cases.append({'case':'actual-schema-refuses-'+value,'passed':True})
 (D/'native-behavior-result.json').write_text(json.dumps({'cases':cases,'candidate_sha256':hashlib.sha256(new.encode()).hexdigest()},indent=2)+'\n')
 # Non-ANALYZE original/candidate parameter reader uses exact same native
 # owners and cover definitions. No fee-net business call executes here.
 q((FIX/'feeplan-original-candidate-PARAMETER-PLANONLY5-READONLY30.sql').read_text())
 out={'cases':cases,'full_original_owner':'55d5cd47a5432866a544a455d1a774fe','candidate_sha256':hashlib.sha256(new.encode()).hexdigest(),'exact_parameter_reader_grammar_and_index_guards':True,'synthetic_scope_only':True,'actual_capacity_proof':False};args.output.write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
finally:
 if started:cmd([PG/'pg_ctl','-D',data,'-m','immediate','stop'])
 shutil.rmtree(W)
 shutil.rmtree(D)
