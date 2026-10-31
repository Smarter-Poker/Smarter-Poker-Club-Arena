#!/usr/bin/env python3
"""Isolated PG17 qualification of the original pending-boundary query and one index.
No production access; this harness owns, stops and removes its private cluster.
"""
from pathlib import Path
import argparse,hashlib,json,os,re,select,shutil,subprocess,tempfile,uuid
p=argparse.ArgumentParser();p.add_argument('--pg-bin',type=Path,required=True);p.add_argument('--scratch',type=Path,required=True);p.add_argument('--socket-root',type=Path);p.add_argument('--output',type=Path,required=True);p.add_argument('--repo',type=Path);p.add_argument('--candidate',type=Path,required=True);a=p.parse_args()
wrapper_bytes=Path(__file__).read_bytes();wrapper_sha256=hashlib.sha256(wrapper_bytes).hexdigest()
R=a.repo or Path(__file__).resolve().parents[2]
F=R/'scripts/ci/fixtures/weekly-linked-window-proof/generation-inputs.json'
NATIVE=Path(__file__).parent/'fixtures/weekly-pending-frame-cover/seed.sql';seed_bytes=NATIVE.read_bytes()
fixture_bytes=F.read_bytes();inputs=json.loads(fixture_bytes);row=next(r for r in inputs['source_definitions']if r['signature']=='public.fn_union_pnl_boundary(uuid,timestamptz)');source=row['definition'];assert hashlib.md5(source.encode()).hexdigest()=='5e4e878524a91518de209bc5e008db36'
original=source.split(' FOR f IN\n',1)[1].split('\n LOOP',1)[0];assert original.count('r.pending_addon_id IS NOT NULL')==1
query=original
for old,new in [('inv','$1'),('p_at','$2'),('p_union_id','$3')]:query=re.sub(r'\b'+old+r'\b',lambda m:new,query)
assert all(re.search(r'\b'+k+r'\b',query)is None for k in ['inv','p_at','p_union_id'])
candidate_bytes=a.candidate.read_bytes();candidate_sha256=hashlib.sha256(candidate_bytes).hexdigest();M=candidate_bytes.decode();assert M.count('CREATE INDEX CONCURRENTLY IF NOT EXISTS ')==1 and M.rstrip().endswith('COMMIT;')
INDEX=re.search(r'CREATE INDEX CONCURRENTLY IF NOT EXISTS (\w+)',M).group(1);assert INDEX=='cash_boundary_frame_observed_at_cover'
assert 'ON public.union_pnl_transaction_frames (transaction_id) INCLUDE(observed_at);'in M
body=M.split('BEGIN;',1)[1].rsplit('COMMIT;',1)[0]
index_condition=M.split(' IF NOT EXISTS(\n',1)[1].split('\n ) THEN RAISE EXCEPTION',1)[0]
U='fade0000-0000-0000-0000-000000000001';V='fade0000-0000-0000-0000-000000000002';AT='2026-10-26 07:00Z'
a.socket_root=a.socket_root or a.scratch
assert a.scratch.is_dir()and a.socket_root.is_dir()and not a.output.exists()
O=Path(tempfile.mkdtemp(prefix='pending-index-',dir=a.scratch));data=O/'data';sock=a.socket_root/('pi-'+uuid.uuid4().hex[:6]);sock.mkdir();port='55472';assert len(str(sock/('.s.PGSQL.'+port)))<100
started=False;cases=[];plan_cases=[];logs={}
lit=lambda x:"'"+str(x).replace("'","''")+"'"
def call(sql):
 r=subprocess.run([str(a.pg_bin/'psql'),'-XqAt','-h',str(sock),'-p',port,'-U','postgres','-v','ON_ERROR_STOP=1'],input=sql,capture_output=True,text=True,timeout=90)
 return r

def q(sql):
 r=call(sql);assert r.returncode==0,r.stderr+'\n'+r.stdout
 return r.stdout.strip()

def contract(index=INDEX):
 return 'SELECT EXISTS('+index_condition.replace('public.'+INDEX,'public.'+index)+');'

def inventory(n,empty=False,total=13079,adversarial=True):
 rows=[]
 if not empty:
  for i in range(1,total+1):rows.append({'row':{'id':str(uuid.UUID(hashlib.md5(('table'+str(i)).encode()).hexdigest())),'union_id':U if i<=n else V}})
  # An EXISTS semi-join cannot duplicate a receipt for duplicate table entries.
  if adversarial:
   if n:rows.append(rows[0])
   rows.append({'row':{'id':str(uuid.UUID(hashlib.md5(('table'+str(total+1)).encode()).hexdigest())),'union_id':None}})
 return json.dumps({'population':{'tables':rows}},separators=(',',':'))

def prepare(name):return 'PREPARE '+name+'(jsonb,timestamptz,uuid)AS '+query+';'
def params(inv):return '('+lit(inv)+'::jsonb,'+lit(AT)+'::timestamptz,'+lit(U)+'::uuid)'
def plan(inv,analyze=False):
 options='FORMAT JSON,SETTINGS TRUE'+(',ANALYZE TRUE,BUFFERS TRUE,TIMING TRUE,SUMMARY TRUE'if analyze else '')
 x=json.loads(q(prepare('original_pending')+'EXPLAIN('+options+')EXECUTE original_pending'+params(inv)+';'))
 def nodes(v):
  if isinstance(v,dict):
   yield v
   for z in v.values():yield from nodes(z)
  elif isinstance(v,list):
   for z in v:yield from nodes(z)
 return x,list(nodes(x))
try:
 with(O/'initdb.log').open('w')as f:subprocess.run([str(a.pg_bin/'initdb'),'-D',str(data),'--no-locale','-E','UTF8','-A','trust','-U','postgres'],stdout=f,stderr=subprocess.STDOUT,check=True)
 subprocess.run([str(a.pg_bin/'pg_ctl'),'-D',str(data),'-l',str(O/'postgres.log'),'-o',f"-k {sock} -p {port} -c listen_addresses='' -c fsync=off -c shared_buffers=16MB",'-w','start'],stdout=subprocess.DEVNULL,check=True);started=True
 q("SET check_function_bodies=off;CREATE SCHEMA smarter_private;"+source+";CREATE FUNCTION public.fn_platform_frozen()RETURNS boolean LANGUAGE sql AS $$SELECT false$$;CREATE FUNCTION smarter_private.original_inventory_proof_sources_match()RETURNS boolean LANGUAGE sql AS $$SELECT true$$;CREATE FUNCTION smarter_private.original_inventory_basis_generation()RETURNS text LANGUAGE sql AS $$SELECT 'original-inventory-245-v1:05f51b14eb6ebcb361fd88f7ba7a7343'::text$$;")
 owners_sql="SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('definition',pg_get_functiondef(p.oid),'metadata',to_jsonb(p)))FROM pg_proc p WHERE p.oid IN('public.fn_union_pnl_boundary(uuid,timestamptz)'::regprocedure,'public.fn_platform_frozen()'::regprocedure,'smarter_private.original_inventory_proof_sources_match()'::regprocedure,'smarter_private.original_inventory_basis_generation()'::regprocedure);"
 owners_before=json.loads(q(owners_sql));assert hashlib.md5(owners_before['fn_union_pnl_boundary(uuid,timestamp with time zone)']['definition'].encode()).hexdigest()=='5e4e878524a91518de209bc5e008db36'
 q(seed_bytes.decode())
 invs={'selective':inventory(1),'multiunion':inventory(25),'broad':inventory(250),'none':inventory(0),'empty':inventory(0,True),'representative74':inventory(9725,total=13079,adversarial=False)}
 rep_rows=json.loads(invs['representative74'])['population']['tables'];assert len(rep_rows)==13079 and sum(r['row']['union_id']==U for r in rep_rows)==9725
 for name,inv in invs.items():
  q(prepare('original_pending')+'CREATE TABLE public.native_before_'+name+' AS EXECUTE original_pending'+params(inv)+';')
  px,pnodes=plan(inv,analyze=name=='representative74');plan_cases.append({'case':name,'phase':'before','native_analyze_buffers_only':name=='representative74','plan':px});assert not any(n.get('Index Name')==INDEX for n in pnodes)
 q(M)
 assert q(contract())=='t';cases.append('actual_concurrent_index_exact_valid_ready_live_nonunique_xid8_key_observed_at_INCLUDE_shape')
 for name,inv in invs.items():
  q(prepare('original_pending')+'CREATE TABLE public.native_after_'+name+' AS EXECUTE original_pending'+params(inv)+';')
  q("DO $$BEGIN IF EXISTS((SELECT to_jsonb(b) FROM public.native_before_"+name+" b EXCEPT ALL SELECT to_jsonb(a) FROM public.native_after_"+name+" a)UNION ALL(SELECT to_jsonb(a)FROM public.native_after_"+name+" a EXCEPT ALL SELECT to_jsonb(b)FROM public.native_before_"+name+" b))THEN RAISE EXCEPTION 'full_duplicate_preserving_original_pending_bag_changed';END IF;IF EXISTS((SELECT funding_club_id,sum(held) FROM public.native_before_"+name+" GROUP BY 1 EXCEPT ALL SELECT funding_club_id,sum(held)FROM public.native_after_"+name+" GROUP BY 1)UNION ALL(SELECT funding_club_id,sum(held)FROM public.native_after_"+name+" GROUP BY 1 EXCEPT ALL SELECT funding_club_id,sum(held)FROM public.native_before_"+name+" GROUP BY 1))THEN RAISE EXCEPTION 'pending_club_held_totals_changed';END IF;END$$;")
  px,pnodes=plan(inv,analyze=name=='representative74');plan_cases.append({'case':name,'phase':'after','native_analyze_buffers_only':name=='representative74','plan':px});
  if name in ['selective','representative74']:assert any(n.get('Index Name')==INDEX and n.get('Node Type')=='Index Only Scan'for n in pnodes),'Unforced frame lookup did not use covering Index Only Scan'
  cases.append(name+'_full_EXCEPT_ALL_bag_and_club_held_totals_exact')
 # Real two-session MVCC controls: an included observed_at never outruns visibility.
 mvcc_proofs=[]
 for mode in ['uncommitted_insert_missing_frame','uncommitted_update_old_frame']:
  target_sql="SELECT jsonb_build_object('transaction_id',r.transaction_id::text,'table_id',r.table_id)FROM public.cash_participant_funding_receipts r WHERE r.pending_addon_id IS NOT NULL AND r.transaction_id IS NOT NULL AND r.recorded_at<timestamptz '2026-10-26 07:00Z' AND "+("NOT EXISTS(SELECT FROM public.union_pnl_transaction_frames f WHERE f.transaction_id=r.transaction_id)"if mode.startswith('uncommitted_insert')else "EXISTS(SELECT FROM public.union_pnl_transaction_frames f WHERE f.transaction_id=r.transaction_id AND f.observed_at<timestamptz '2026-10-26 07:00Z')")+"LIMIT 1;"
  target=json.loads(q(target_sql));inv=json.dumps({'population':{'tables':[{'row':{'id':target['table_id'],'union_id':U}}]}},separators=(',',':'))
  ident=lit(target['transaction_id'])+'::xid8'
  frame_read="SELECT COALESCE(jsonb_agg(to_jsonb(f)),'[]'::jsonb)FROM public.union_pnl_transaction_frames f WHERE transaction_id="+ident+';'
  old_rows=q(frame_read)
  q(prepare('original_pending')+'CREATE TABLE public.native_mvcc_before AS EXECUTE original_pending'+params(inv)+';')
  change=('INSERT INTO public.union_pnl_transaction_frames VALUES('+ident+",timestamptz '2026-10-27 07:00Z');")if mode.startswith('uncommitted_insert')else ("UPDATE public.union_pnl_transaction_frames SET observed_at=timestamptz '2026-10-27 07:00Z' WHERE transaction_id="+ident+';')
  writer=subprocess.Popen([str(a.pg_bin/'psql'),'-XqAt','-h',str(sock),'-p',port,'-U','postgres','-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
  try:
   writer.stdin.write('BEGIN;'+change+"SELECT 'native_writer_ready:'||pg_backend_pid();\n");writer.stdin.flush()
   ready=select.select([writer.stdout],[],[],10)[0];assert ready,'Native MVCC writer did not enter its transaction'
   ack=writer.stdout.readline().strip();assert ack.startswith('native_writer_ready:');writer_pid=int(ack.split(':')[1]);reader_pid=int(q('SELECT pg_backend_pid();'));assert writer_pid!=reader_pid
   q("SET statement_timeout='5s';"+prepare('original_pending')+'CREATE TABLE public.native_mvcc_during AS EXECUTE original_pending'+params(inv)+';')
   q("DO $$BEGIN IF EXISTS((SELECT to_jsonb(b)FROM public.native_mvcc_before b EXCEPT ALL SELECT to_jsonb(d)FROM public.native_mvcc_during d)UNION ALL(SELECT to_jsonb(d)FROM public.native_mvcc_during d EXCEPT ALL SELECT to_jsonb(b)FROM public.native_mvcc_before b))THEN RAISE EXCEPTION 'MVCC_original_pending_bag_changed';END IF;END$$;")
   px,pnodes=plan(inv,analyze=True);leaves=[n for n in pnodes if n.get('Relation Name')=='union_pnl_transaction_frames'and n.get('Node Type')=='Index Only Scan'and n.get('Index Name')==INDEX]
   assert leaves and sum(n.get('Heap Fetches',0)for n in leaves)>0,'Included frame lookup did not demonstrate heap visibility fallback'
   singleton_sql='SELECT observed_at FROM public.union_pnl_transaction_frames WHERE transaction_id='+ident
   singleton_rows=q("SELECT COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb)FROM("+singleton_sql+")t;")
   expected_rows=json.dumps([{'observed_at':v['observed_at']}for v in json.loads(old_rows)])
   assert json.loads(singleton_rows)==json.loads(expected_rows)
   sx=json.loads(q('EXPLAIN(ANALYZE TRUE,BUFFERS TRUE,FORMAT JSON)'+singleton_sql+';'));sn=sx[0]['Plan']
   assert sn.get('Node Type')=='Index Only Scan'and sn.get('Index Name')==INDEX and sn.get('Heap Fetches',0)>0,'Changed singleton did not use visibility-safe covering heap fallback'
   mvcc_proofs.append({'writer_backend_pid':writer_pid,'reader_backend_pid':reader_pid,'singleton_plan':sx,'singleton_observed_at_rows':json.loads(singleton_rows),'singleton_heap_fetches':sn['Heap Fetches'],'case':mode,'full_original_bag_unchanged_in_other_session':True,'reader_did_not_see_uncommitted_frame_value':True,'index_only_heap_fetches':sum(n.get('Heap Fetches',0)for n in leaves),'plan':px})
  finally:
   if writer.poll()is None:
    writer.stdin.write('ROLLBACK;\n\\q\n');writer.stdin.flush();writer.stdin.close()
    writer.wait(timeout=10)
   assert writer.returncode==0,writer.stderr.read()
  assert q(frame_read)==old_rows,'Native MVCC writer rollback changed frame rows'
  q('DROP TABLE public.native_mvcc_before,public.native_mvcc_during;');cases.append(mode+'_two_session_full_bag_and_visibility_fallback')
 # The ACTUAL migration body refuses native catalog validity faults; each rollback restores them.
 for field in ['indisvalid','indisready','indislive']:
  failed=call("BEGIN;UPDATE pg_index SET "+field+"=false WHERE indexrelid='public."+INDEX+"'::regclass;"+body+'ROLLBACK;')
  assert failed.returncode!=0 and 'cash_boundary_frame_cover_exact_valid_shape_required'in failed.stderr,failed.stderr
  assert q(contract())=='t'and json.loads(q(owners_sql))==owners_before;cases.append('actual_migration_catalog_'+field+'_false_refused_and_rollback_exact')
 for name,ddl in [('wrong_key','(observed_at) INCLUDE(transaction_id)'),('missing_include','(transaction_id)')]:
  q('DROP INDEX CONCURRENTLY public.'+INDEX+';CREATE INDEX '+INDEX+' ON public.union_pnl_transaction_frames '+ddl+';')
  failed=call(M);assert failed.returncode!=0 and 'cash_boundary_frame_cover_exact_valid_shape_required'in failed.stderr,failed.stderr
  q('DROP INDEX CONCURRENTLY public.'+INDEX+';');q(M);assert q(contract())=='t';cases.append('actual_migration_'+name+'_leftover_refused')
 q('DROP INDEX CONCURRENTLY public.'+INDEX+';')
 failed=call('CREATE UNIQUE INDEX CONCURRENTLY '+INDEX+' ON public.union_pnl_transaction_frames(observed_at) INCLUDE(transaction_id);')
 assert failed.returncode!=0 and 'duplicated'in failed.stderr,failed.stderr
 assert q("SELECT NOT indisvalid FROM pg_index WHERE indexrelid='public."+INDEX+"'::regclass;")=='t'
 failed_install=call(M);assert failed_install.returncode!=0 and 'cash_boundary_frame_cover_exact_valid_shape_required'in failed_install.stderr,failed_install.stderr
 q('DROP INDEX CONCURRENTLY public.'+INDEX+';');q(M);assert q(contract())=='t';cases.append('actual_migration_real_failed_CCI_INVALID_leftover_refused_then_native_cleanup')
 # Exercise the ACTUAL installation authority guards with native-only context changes.
 authority_controls=[
 ('source65_false',"CREATE OR REPLACE FUNCTION smarter_private.original_inventory_proof_sources_match()RETURNS boolean LANGUAGE sql AS $$SELECT false$$;",'cash_boundary_frame_cover_original_authority_changed'),
 ('generation_wrong',"CREATE OR REPLACE FUNCTION smarter_private.original_inventory_basis_generation()RETURNS text LANGUAGE sql AS $$SELECT 'wrong'::text$$;",'cash_boundary_frame_cover_original_authority_changed'),
 ('frozen_true',"CREATE OR REPLACE FUNCTION public.fn_platform_frozen()RETURNS boolean LANGUAGE sql AS $$SELECT true$$;",'cash_boundary_frame_cover_operator_or_freeze_refused'),
 ('jwt_present',"SET LOCAL request.jwt.claims='{\"role\":\"native_untrusted\"}';",'cash_boundary_frame_cover_operator_or_freeze_refused'),
 ('boundary_body_changed',source.replace('DECLARE inv jsonb;','DECLARE inv jsonb;\n -- deliberate native source-body drift',1)+';','cash_boundary_frame_cover_original_authority_changed')]
 for name,change,expected in authority_controls:
  failed=call('BEGIN;SET LOCAL check_function_bodies=off;'+change+body+'ROLLBACK;')
  assert failed.returncode!=0 and expected in failed.stderr,(name,failed.stderr)
  assert json.loads(q(owners_sql))==owners_before and q(contract())=='t',name
  cases.append('actual_migration_'+name+'_refused_and_full_native_owner_rollback_exact')
 owners_after=json.loads(q(owners_sql));assert owners_before==owners_after
 cases.append('all_four_native_owner_full_definitions_metadata_ACLs_unchanged')
 counts=json.loads(q("SELECT jsonb_build_object('selective',(SELECT count(*)FROM public.native_after_selective),'multiunion',(SELECT count(*)FROM public.native_after_multiunion),'broad',(SELECT count(*)FROM public.native_after_broad),'representative74',(SELECT count(*)FROM public.native_after_representative74),'none',(SELECT count(*)FROM public.native_after_none),'empty',(SELECT count(*)FROM public.native_after_empty),'null_funding_club',(SELECT count(*)FROM public.native_after_broad WHERE funding_club_id IS NULL),'negative_held',(SELECT count(*)FROM public.native_after_broad WHERE held<0),'zero_held',(SELECT count(*)FROM public.native_after_broad WHERE held=0));"))
 assert counts['selective']>0 and counts['none']==counts['empty']==0 and all(counts[k]>0 for k in ['null_funding_club','negative_held','zero_held'])
 metadata=json.loads(q("SELECT jsonb_build_object('definition',pg_get_indexdef(i.indexrelid),'expression',pg_get_expr(i.indexprs,i.indrelid),'predicate',pg_get_expr(i.indpred,i.indrelid),'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive)FROM pg_index i WHERE i.indexrelid='public."+INDEX+"'::regclass;"))
 result={'passed':True,'native_only_not_production_capacity_proof':True,'actual_candidate':str(a.candidate.resolve()),'actual_candidate_sha256':candidate_sha256,'native_wrapper_sha256':wrapper_sha256,'native_seed_sha256':hashlib.sha256(seed_bytes).hexdigest(),'actual_migration_executed_byte_exact':True,'native_context_only_stubs':['fn_platform_frozen=false','original_inventory_proof_sources_match=true','original_inventory_basis_generation=GEN05'],'real_full_boundary_body_md5_checked':True,'all_four_native_owner_definitions_metadata_ACLs_unchanged':True,'original_boundary_source_md5':'5e4e878524a91518de209bc5e008db36','qualified_source_fixture_sha256':hashlib.sha256(fixture_bytes).hexdigest(),'original_pending_query_sha256':hashlib.sha256(original.encode()).hexdigest(),'parameterized_only_original_query_no_other_change':True,'no_forced_planner_settings':True,'representative_table_population':{'total':13079,'midway':9725,'midway_fraction':9725/13079,'global_pending_receipts':51000,'funding_rows':300616,'frame_rows_seeded':1100000,'distribution':'native_modular_pending_and_randomized_frame_ids_not_actual_production_distribution','visibility_fixture':'VACUUM then unchanged-value HOT update one per25thframepage'},'representative_native_analyze_buffers_captured_before_after':True,'before_after_full_duplicate_preserving_bags_and_club_totals':True,'fixture_columns_used_by_exact_original_query_with_extra_payload_not_full_production_catalog':True,'case_counts':counts,'two_session_mvcc':mvcc_proofs,'cases':cases,'plans':plan_cases,'actual_native_index':metadata,'index_contract_sql':contract(),'limitation':'Native plans prove an isolated access path, not production speed or capacity. Production source/GEN/paid identities, index installation, fresh original rehearsal and saved book closure remain required. Pending SQL had no ORDER BY; JSON holding array order is not promised unchanged by physical plans.'}
 assert a.candidate.read_bytes()==candidate_bytes,'Candidate changed during native qualification'
 assert Path(__file__).read_bytes()==wrapper_bytes,'Native wrapper changed during qualification'
 assert F.read_bytes()==fixture_bytes,'Source fixture changed during qualification'
 assert NATIVE.read_bytes()==seed_bytes,'Native seed changed during qualification'
 a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'passed':True,'cases':len(cases),'counts':counts,'output':str(a.output)}))
finally:
 if started:subprocess.run([str(a.pg_bin/'pg_ctl'),'-D',str(data),'-m','fast','-w','stop'],stdout=subprocess.DEVNULL,check=True)
 if data.exists():shutil.rmtree(data)
 if sock.exists():sock.rmdir()
 shutil.rmtree(O)
