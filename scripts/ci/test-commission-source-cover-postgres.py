#!/usr/bin/env python3
"""Unchanged original R2 window/query against one covering index, isolated PG17."""
import argparse,hashlib,json,os,shutil,socket,subprocess,tempfile,sys
from pathlib import Path
R=Path(__file__).resolve().parents[2];FX=R/'scripts/ci/fixtures/commission-source-cover'
p=argparse.ArgumentParser();p.add_argument('--pg-bin',type=Path,default=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'if sys.platform=='darwin'else'/usr/lib/postgresql/17/bin')));p.add_argument('--scratch',type=Path,required=True);p.add_argument('--output',type=Path);a=p.parse_args()
assert __debug__,'optimized financial qualification refused';assert a.scratch.is_dir()
if sys.platform=='darwin':assert str(a.scratch.resolve()).startswith('/Volumes/SmarterWork/agent-work/'),'external SSD required'
files=list((R/'supabase/migrations').glob('*_commission_windows_cover_the_original_source_lookup.sql'));assert len(files)==1;source=files[0].read_text();source_sha=hashlib.sha256(source.encode()).hexdigest()
b=Path(tempfile.mkdtemp(prefix='r2-cover-',dir=a.scratch));started=False;PG=a.pg_bin
with socket.socket()as s:s.bind(('127.0.0.1',0));port=str(s.getsockname()[1])
env={k:v for k,v in os.environ.items()if not k.startswith('PG')};env['TMPDIR']=str(b)
psql=[PG/'psql','-XqAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','postgres','-d','postgres']
def run(cmd,sql=None,error=None):
 r=subprocess.run(list(map(str,cmd)),input=sql,text=True,capture_output=True,env=env,timeout=180)
 if error:assert r.returncode and error in r.stderr,(error,r.stdout+r.stderr)
 else:assert not r.returncode,r.stdout+r.stderr
 return r.stdout.strip()
def q(sql,error=None):return run(psql,sql,error)
def walk(n):
 yield n
 for child in n.get('Plans',[]):yield from walk(child)
args="(fixture.u(99),NULL,ARRAY[fixture.u(1),fixture.u(2)],'2026-10-19 07:00Z','2026-10-19 09:00Z')"
call="SELECT jsonb_build_object('value',value,'cash_ids',cash_ids,'cash_md5',encode(cash_md5,'hex'),'fee_ids',fee_ids,'fee_md5',encode(fee_md5,'hex')) FROM public.fn_settle_accounting_commission_window"+args
faults=json.loads((FX/'cases.json').read_text());results=[];plans={};index='accounting_agent_commissions_source_cover'
def fault_outputs():
 out={}
 for mode in ['force_custom_plan','force_generic_plan']:
  for name,change,expected in faults:
   text=q('BEGIN;SET LOCAL plan_cache_mode='+mode+';'+change+(';'if change else'')+call+';ROLLBACK;')
   value=json.loads(text)
   for key,want in expected.items():assert value['value'].get(key)==want,(mode,name,key,want,value)
   out[mode+':'+name]=value
 return out
try:
 assert ' 17.'in run([PG/'postgres','--version'])
 js="import{readFileSync}from'node:fs';import{pathToFileURL}from'node:url';const{migrationTransactionShape}=await import(pathToFileURL(process.argv[2]));process.stdout.write(JSON.stringify(migrationTransactionShape(process.argv[1].split('/').pop(),readFileSync(process.argv[1],'utf8'))));"
 shape=json.loads(run(['node','--input-type=module','-e',js,files[0],R/'scripts/ci/migration-transaction-shape.mjs']));assert shape['ok']and len(shape['indexes'])==1,shape
 run([PG/'initdb','-D',b/'d','-U','postgres','-A','trust','--no-locale','--encoding=UTF8'])
 with(b/'d'/'postgresql.conf').open('a')as h:h.write("\nunix_socket_directories=''\nshared_buffers='128MB'\nwork_mem='32MB'\nmaintenance_work_mem='64MB'\n")
 run([PG/'pg_ctl','-D',b/'d','-l',b/'log','-o',f'-h 127.0.0.1 -p {port}','-w','start']);started=True
 q((FX/'bootstrap.sql').read_text());original=json.loads((FX/'original-window.json').read_text());assert hashlib.md5(original['definition'].encode()).hexdigest()==original['md5'];q(original['definition'])
 q("REVOKE ALL ON FUNCTION fn_settle_accounting_commission_window(uuid,uuid,uuid[],timestamptz,timestamptz)FROM PUBLIC;GRANT EXECUTE ON FUNCTION fn_settle_accounting_commission_window(uuid,uuid,uuid[],timestamptz,timestamptz)TO service_role")
 before_faults=fault_outputs()
 # Bounded background plus scattered source-key reads, with real full tier contracts.
 q("INSERT INTO agent_commissions(source_type,source_id,club_id,user_id,amount,commission_rate,created_at)SELECT 'cash_rake_accrual',fixture.u(100000+g),fixture.u(77),fixture.u(500000+g),1,.1,'2026-10-18Z'FROM generate_series(1,300000)g")
 q("INSERT INTO accounting_payable_earning_sources SELECT 'cash_rake_accrual',fixture.u(2000+g),fixture.u(1),'2026-10-19 08:00Z',fixture.u(99),jsonb_build_object('club_id',fixture.u(1),'tiers',jsonb_build_array(fixture.tier(10,110,1.25,.2,20),fixture.tier(20,120,2.75,.3)))FROM generate_series(1,12000)g;INSERT INTO agent_commissions(source_type,source_id,club_id,user_id,amount,commission_rate,created_at)SELECT s.source_type,s.source_id,s.club_id,(j->>'user_id')::uuid,(j->>'amount')::numeric,(j->>'rate')::numeric,s.earned_at FROM accounting_payable_earning_sources s CROSS JOIN LATERAL jsonb_array_elements(s.contract->'tiers')j WHERE NOT EXISTS(SELECT FROM agent_commissions c WHERE c.source_id=s.source_id AND c.source_type=s.source_type AND c.user_id=(j->>'user_id')::uuid)")
 q('VACUUM(ANALYZE) agent_commissions;VACUUM(ANALYZE) accounting_payable_earning_sources')
 authority_sql="SELECT md5(jsonb_agg(jsonb_build_array(p.oid,p.prosrc,p.proowner,p.proacl,p.prosecdef,p.provolatile,p.proconfig)ORDER BY p.oid)::text)FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','fixture')"
 state_sql="SELECT jsonb_build_array((SELECT md5(string_agg(md5(to_jsonb(c)::text),''ORDER BY id))FROM agent_commissions c),(SELECT md5(string_agg(md5(to_jsonb(s)::text),''ORDER BY source_type,source_id))FROM accounting_payable_earning_sources s))"
 authority=q(authority_sql);state=q(state_sql);before_full=json.loads(q(call));lookup=(FX/'original-ac-query.sql').read_text()
 setup="DO $setup$ BEGIN PERFORM 1 FROM public.fn_settle_accounting_commission_window"+args+";END $setup$;"
 projection="SELECT jsonb_build_object('ordered',md5(jsonb_agg(to_jsonb(ac)ORDER BY ctid)::text),'bag',md5(jsonb_agg(to_jsonb(ac)ORDER BY source_type,source_id,club_id,user_id,amount,commission_rate,settled_at)::text))FROM pg_temp._rw_ac ac"
 def profile():
  text=q('BEGIN;'+setup+'TRUNCATE pg_temp._rw_ac;EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON,TIMING FALSE)'+lookup+';'+projection+';ROLLBACK;')
  decoder=json.JSONDecoder();plan,end=decoder.raw_decode(text);fingerprint=json.loads(text[end:].strip());return plan[0],fingerprint
 plans['before'],before_projection=profile()
 q(shape['indexes'][0]['statement']);q(shape['body'])
 plans['after'],after_projection=profile()
 assert before_projection==after_projection,(before_projection,after_projection)
 assert before_full==json.loads(q(call)),'original full value/IDs/MD5 arrays changed'
 assert authority==q(authority_sql)and state==q(state_sql),'source/commission/authority changed'
 nodes=[n for n in walk(plans['after']['Plan'])if n.get('Relation Name')=='agent_commissions'];assert len(nodes)==1 and nodes[0]['Node Type']=='Index Only Scan'and nodes[0].get('Index Name')==index and nodes[0].get('Heap Fetches')<=nodes[0]['Actual Rows']*nodes[0]['Actual Loops']/100,nodes
 results+=['maintained_concurrent_preamble_exact_shape','unchanged_actual_rw_ac_ordered_and_bag_projection_parity','whole_original_window_value_cash_fee_ids_md5_arrays_identical','natural_index_only_original_lookup_less_than_one_percent_heap_fetches','source_commission_and_function_authority_immutable']
 # Remove only synthetic bulk rows before comparing the same60 exact fault oracles.
 q("DELETE FROM agent_commissions WHERE source_id IN(SELECT fixture.u(100000+g)FROM generate_series(1,300000)g)OR source_id IN(SELECT fixture.u(2000+g)FROM generate_series(1,12000)g);DELETE FROM accounting_payable_earning_sources WHERE source_id IN(SELECT fixture.u(2000+g)FROM generate_series(1,12000)g)")
 assert before_faults==fault_outputs(),'full original negative values or hashes changed under covering index'
 results+=list(before_faults)
 # The same original query remains correct for a non-all-visible heap page.
 expected=json.loads(q(call));actual=json.loads(q('BEGIN;UPDATE agent_commissions SET amount=amount WHERE user_id=fixture.u(110);'+call+';ROLLBACK;'));assert expected==actual
 results.append('index_only_mvcc_non_all_visible_page_preserves_original_full_result')
 identity=lambda:q("SELECT jsonb_build_array(c.oid,pg_relation_filenode(c.oid))FROM pg_class c WHERE c.oid='"+index+"'::regclass")
 before_identity=identity();q(shape['indexes'][0]['statement']);q(shape['body']);assert before_identity==identity();results.append('valid_replay_preserves_index_oid_and_filenode')
 # Native catalogue faults: no production DDL or system catalogue edits.
 q('DROP INDEX '+index);q(shape['body'],error='commission_source_cover_missing')
 for bad,why in [
  ('(source_id,source_type,club_id)WHERE source_id IS NOT NULL','commission_source_cover_shape_changed'),
  ('(source_id,source_type,club_id)INCLUDE(user_id,amount,commission_rate,settled_at)','commission_source_cover_shape_changed'),
  ('(source_type,source_id,club_id)INCLUDE(user_id,amount,commission_rate,settled_at)WHERE source_id IS NOT NULL','commission_source_cover_column_changed'),
  ('(source_id,source_type,club_id)INCLUDE(user_id,commission_rate,amount,settled_at)WHERE source_id IS NOT NULL','commission_source_cover_column_changed'),
  ('(source_id,source_type text_pattern_ops,club_id)INCLUDE(user_id,amount,commission_rate,settled_at)WHERE source_id IS NOT NULL','commission_source_cover_key_changed'),
  ('(source_id DESC,source_type,club_id)INCLUDE(user_id,amount,commission_rate,settled_at)WHERE source_id IS NOT NULL','commission_source_cover_key_changed')]:
  q('CREATE INDEX '+index+' ON agent_commissions'+bad);q(shape['body'],error=why);q('DROP INDEX '+index)
 results.append('missing_wrong_predicate_key_and_include_order_refused')
 q('CREATE UNIQUE INDEX CONCURRENTLY '+index+' ON agent_commissions(source_id)',error='could not create unique index')
 assert q("SELECT NOT indisvalid FROM pg_index WHERE indexrelid='"+index+"'::regclass")=='t'
 invalid=identity();q(shape['indexes'][0]['statement']);assert invalid==identity();q(shape['body'],error='commission_source_cover_shape_changed');results.append('real_failed_concurrent_build_invalid_leftover_refused_without_blind_repair')
 q('DROP INDEX '+index);q(shape['indexes'][0]['statement']);q(shape['body']);assert before_faults==fault_outputs();results.append('explicit_native_observed_invalid_recovery_restores_original_results')
 assert hashlib.sha256(files[0].read_bytes()).hexdigest()==source_sha
 blocks=lambda p:p['Plan'].get('Shared Hit Blocks',0)+p['Plan'].get('Shared Read Blocks',0)
 out={'passed':True,'cases':results,'migration':files[0].name,'migration_sha256':source_sha,'original_window_md5':original['md5'],'full_original_function_unchanged':True,'source_fingerprints_and_projection':before_projection,'native_lookup_ms':{k:v['Execution Time']for k,v in plans.items()},'native_lookup_buffer_accesses':{k:blocks(v)for k,v in plans.items()},'after_heap_fetches':nodes[0].get('Heap Fetches'),'limits':'Actual unchanged original R2 window/lookup on controlled source and commission relations. Native all-visible/index-only result is not production build duration/size/capacity or whole earning-producer qualification. No production DDL/query. R2 covering index cannot fix split-write payer registration or alone certify04:00 delivery.'}
 if a.output:a.output.write_text(json.dumps(out,indent=2)+'\n');a.output.with_suffix('.plans.json').write_text(json.dumps(plans,indent=2)+'\n')
 print(json.dumps(out))
finally:
 if started:run([PG/'pg_ctl','-D',b/'d','-m','immediate','-w','stop'])
 shutil.rmtree(b)
