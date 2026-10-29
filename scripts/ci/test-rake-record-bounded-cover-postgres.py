#!/usr/bin/env python3
"""Private PG17 physical-only helper/CCI qualification. Never connects to a live DB.
Native snapshot OIDs and inert financial/maintenance collaborators are explicit
adapters. Production snapshots retain all34 actual owner definitions verbatim.
"""
import argparse,concurrent.futures,time,hashlib,json,os,re,shutil,subprocess,tempfile
from pathlib import Path
R=Path(__file__).resolve().parents[2];F=R/'scripts/ci/fixtures/rake-record-bounded-cover'
def lit(x):return "'"+str(x).replace("'","''")+"'"
def nodes(p):
 yield p
 for c in p.get('Plans',[]):yield from nodes(c)
def main():
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--pg-bin',type=Path,default=Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin')));ap.add_argument('--scratch',type=Path,required=True);ap.add_argument('--output',type=Path,required=True);a=ap.parse_args();assert __debug__ and a.scratch.is_dir()and not a.output.exists()
 w=Path(tempfile.mkdtemp(prefix='rrc-',dir=a.scratch.resolve()));assert len(str(w).encode())<90;d=w/'d';started=False;cases=[];plans=[]
 env={k:v for k,v in os.environ.items()if not k.startswith('PG')};env.update(TMPDIR=str(w),TMP=str(w),TEMP=str(w),LC_ALL='C');ps=[a.pg_bin/'psql','-XqAt','-v','ON_ERROR_STOP=1','-h',w,'-U','postgres','-d','postgres']
 def run(args,sql=None,error=None):
  p=subprocess.run(list(map(str,args)),input=sql,text=True,capture_output=True,env=env,timeout=90);assert (p.returncode!=0 and error in p.stderr)if error else p.returncode==0,(p.stdout[-2000:],p.stderr[-6000:]);return p.stdout.strip()
 def q(s,error=None):return run(ps,s,error)
 def js(s):return json.loads(q(s))
 def ok(s):cases.append(s);print('PASS',s,flush=True)
 authority=json.loads((F/'authority.json').read_text());manifest=json.loads((F/'manifest.json').read_text());files=[R/n for n in manifest['migrations']];sources=[f.read_text()for f in files];pred=(F/'predicate.sql').read_text().strip();guard=(F/'guard.sql').read_text();select=(F/'guard-select.sql').read_text();snapshot=re.search(r'\$bounded_rr_snapshot\$(.*?)\$bounded_rr_snapshot\$',guard,re.S).group(1)
 try:
  assert ' 17.'in run([a.pg_bin/'postgres','--version']);run([a.pg_bin/'initdb','-D',d,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8'])
  with(d/'postgresql.conf').open('a')as f:f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(w)+"'\nshared_buffers='16MB'\nwork_mem='16MB'\nmaintenance_work_mem='32MB'\ntemp_file_limit='256MB'\n")
  run([a.pg_bin/'pg_ctl','-D',d,'-l',w/'server.log','-w','start']);started=True
  q('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA smarter_private;GRANT USAGE ON SCHEMA smarter_private TO service_role;CREATE SCHEMA supabase_migrations;CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,name text,statements text[]);')
  q('CREATE SEQUENCE public.hand_id_seq;CREATE TABLE public.tables(id uuid PRIMARY KEY);CREATE TABLE public.clubs(id uuid PRIMARY KEY);CREATE TABLE public.tournaments(id uuid PRIMARY KEY);')
  cols=[c['attribute']['attname']+' '+c['type']+(' DEFAULT '+c['default']if c['default']else'')+(' NOT NULL'if c['attribute']['attnotnull']else'')for c in authority['columns']];q('CREATE TABLE public.rake_records('+','.join(cols)+');')
  for c in authority['constraints']:
   if c['contype']!='t':q('ALTER TABLE public.rake_records ADD CONSTRAINT '+c['conname']+' '+c['definition']+';')
  for name in ['accounting_cash_bank_receipts','accounting_cash_accrual_batches','accounting_tournament_fee_batches','accounting_cash_source_receipts','accounting_cash_source_work','ca_stranded_fee_reconciliations']:q('CREATE TABLE public.'+name+'(rake_record_id uuid REFERENCES public.rake_records(id));')
  made=set()
  for t in authority['triggers']:
   if t['tgisinternal']:continue
   fn=t['definition'].split('EXECUTE FUNCTION ',1)[1]
   if fn not in made:q('CREATE FUNCTION public.'+fn+"RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF TG_LEVEL='STATEMENT'THEN RETURN NULL;END IF;RETURN COALESCE(NEW,OLD);END$$;");made.add(fn)
   q(t['definition']+';')
  for ix in authority['indexes']:
   if q('SELECT to_regclass('+lit(ix['index_relation_catalog']['relname'])+')IS NULL')=='t':q(ix['definition']+';')
  q("ALTER TABLE public.rake_records ENABLE ROW LEVEL SECURITY;GRANT SELECT ON public.rake_records TO anon,authenticated;GRANT ALL ON public.rake_records TO service_role;CREATE FUNCTION public.fn_ca_break_window_refuses_migrations(timestamptz)RETURNS text LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('native.window_refusal',true),'')$$;CREATE FUNCTION public.fn_platform_frozen()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT coalesce(current_setting('native.frozen',true),'off')='on'$$;CREATE FUNCTION public.fn_active_maintenance_release_boundary()RETURNS timestamptz LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('native.boundary',true),'')::timestamptz$$;CREATE FUNCTION smarter_private.original_inventory_proof_sources_match()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT coalesce(current_setting('native.source65',true),'on')='on'$$;CREATE FUNCTION smarter_private.original_inventory_basis_generation()RETURNS text LANGUAGE sql STABLE AS $$SELECT CASE WHEN current_setting('native.gen',true)='off'THEN NULL ELSE 'original-inventory-245-v1:72b51e4349fc9cd371bfb7f771b7ae20'END$$;")
  # Exact production guard logic, only its expected catalog payload is native.
  native_owners=js("SELECT jsonb_agg(jsonb_build_object('metadata',to_jsonb(p))ORDER BY oid)FROM pg_proc p WHERE pronamespace IN('public'::regnamespace,'smarter_private'::regnamespace)")
  get="DO $$DECLARE expected jsonb:="+lit(json.dumps({'owners':native_owners}))+"::jsonb;actual jsonb;BEGIN "+select+"RAISE NOTICE 'NATIVE_SNAPSHOT:%',actual;END$$;"
  p=subprocess.run(list(map(str,ps)),input=get,text=True,capture_output=True,env=env,timeout=30);assert p.returncode==0,p.stderr
  native=json.loads(next(l.split('NATIVE_SNAPSHOT:',1)[1]for l in p.stderr.splitlines()if'NATIVE_SNAPSHOT:'in l));native_payload=json.dumps(native,separators=(',',':'))
  def adapt(s):assert snapshot in s;return s.replace(snapshot,native_payload)
  native_guard=adapt(guard);q(native_guard)
  assert len(native['columns'])==20 and len(native['constraints'])==8 and len(native['indexes'])==19 and len(native['triggers'])==39
  ok('actual20_types_defaults_8constraints_19indexes_39trigger_ABIs_native_snapshot_guard')
  q(adapt(sources[0]));q((F/'helper-guard.sql').read_text());ok('exact_helper_migration_and_owner_ACL_body_contract')
  q("INSERT INTO supabase_migrations.schema_migrations VALUES('20261029180415','rake_record_json_size_is_decompressed',ARRAY["+lit(sources[0])+']);')
  parts=[]
  for s in sources[1:]:
   at=s.index('BEGIN;');parts.append((s[:at],adapt(s[at:])))
  q("CREATE TABLE public.native_json_identity(j jsonb);INSERT INTO native_json_identity VALUES(NULL),('null'),('0'),('true'),('[]'),('{}'),('\"☃é\"'),(jsonb_build_object('x',repeat('x',10000))),(jsonb_build_object('external',(SELECT string_agg(md5(g::text),'')FROM generate_series(1,256)g))),(('['||repeat('[',127)||'0'||repeat(']',128))::jsonb);DO $$BEGIN IF EXISTS(SELECT FROM native_json_identity WHERE j IS DISTINCT FROM jsonb_extract_path(j,VARIADIC '{}'::text[]))OR NOT EXISTS(SELECT FROM native_json_identity WHERE pg_column_compression(j)IS NOT NULL AND smarter_private.rake_record_jsonb_raw_size(j)>pg_column_size(j))OR(SELECT pg_relation_size(reltoastrelid)FROM pg_class WHERE oid='native_json_identity'::regclass)=0 THEN RAISE EXCEPTION 'identity_coverage_missing';END IF;END$$;")
  for role in ['anon','authenticated']:q('SET ROLE '+role+";SELECT smarter_private.rake_record_jsonb_raw_size('{}');",'permission denied')
  q("SET ROLE service_role;SELECT smarter_private.rake_record_jsonb_raw_size('{}');")
  ok('decompressed_identity_compressed_external_NULL_scalar_UTF8_depth128_and_private_permissions')
  q("DO $$DECLARE rejected boolean:=false;n bigint;BEGIN BEGIN PERFORM 2147483647::int+2147483647::int;EXCEPTION WHEN numeric_value_out_of_range THEN rejected:=true;END;n:=COALESCE(2147483647::int,0)::bigint+COALESCE(2147483647::int,0)::bigint+COALESCE(2147483647::int,0)::bigint;IF NOT rejected OR n<>6442450941 OR n<=1864 THEN RAISE EXCEPTION 'bigint_bound_failed';END IF;END$$;")
  q("INSERT INTO tournaments SELECT md5(n::text)::uuid FROM generate_series(0,999)n;INSERT INTO rake_records(id,hand_id,rake_amount,bbj_contribution,pot_size,num_players,created_at,player_contributions,global_hand_id,is_tournament,tournament_id,source,metadata,rake_method,returned_uncalled)SELECT md5(i::text)::uuid,md5((i+100000)::text)::uuid,12.34,0.01,99.99,2147483647,'2026-10-20Z',CASE WHEN i%13=0 THEN NULL ELSE '{}'::jsonb END,9223372036854775807,true,md5((i%1000)::text)::uuid,'native',CASE WHEN i%10=0 THEN jsonb_build_array(repeat('x',3000))ELSE jsonb_build_object('small',i,'utf8','☃')END,'DEALT_EQUAL',CASE WHEN i%3=0 THEN NULL WHEN i%3=1 THEN '{}'::jsonb ELSE '[]'::jsonb END FROM generate_series(1,12000)i;")
  before=q("SELECT md5(string_agg(to_jsonb(r)::text,''ORDER BY id))FROM rake_records r")
  for pre,body in parts:q(pre);q(body)
  q('VACUUM ANALYZE rake_records;');q(native_guard);assert q("SELECT md5(string_agg(to_jsonb(r)::text,''ORDER BY id))FROM rake_records r")==before
  fields=[c['attribute']['attname']for c in authority['columns'][:17]];projection=','.join(fields);target="tournament_id=ANY(ARRAY[md5('1')::uuid,md5('10')::uuid])";old='SELECT '+projection+' FROM rake_records WHERE is_tournament AND '+target;split=old+' AND '+pred+' UNION ALL '+old+' AND NOT '+pred
  q('DO $$BEGIN IF EXISTS(('+old+' EXCEPT ALL SELECT*FROM('+split+')s)UNION ALL(SELECT*FROM('+split+')s EXCEPT ALL '+old+"))THEN RAISE EXCEPTION 'partition_bag_changed';END IF;END$$;")
  plan=js('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)'+split);ns=list(nodes(plan[0]['Plan']));assert any(n.get('Index Name')=='rake_records_tournament_small_evidence_cover'and n['Node Type']=='Index Only Scan'for n in ns),ns;assert any(n.get('Index Name')=='rake_records_tournament_large_evidence_keys'for n in ns),ns;assert not any(n.get('Relation Name')=='rake_records'and n['Node Type']=='Seq Scan'for n in ns);plans.append(plan)
  ok('two_exact_CCI_migrations_all17_fields_partition_bag_natural_fast_IndexOnly_bounded_fallback')
  for name,setup,error in [('source65',"SET LOCAL native.source65='off';",'original_source65_GEN_changed'),('GEN',"SET LOCAL native.gen='off';",'original_source65_GEN_changed'),('freeze',"SET LOCAL native.frozen='on';",'window_refused'),('window',"SET LOCAL native.window_refusal='refused';",'window_refused'),('RLS','ALTER TABLE rake_records FORCE ROW LEVEL SECURITY;','existing_authority_changed'),('old_index','DROP INDEX idx_rake_records_date;','existing_authority_changed'),('trigger','ALTER TABLE rake_records DISABLE TRIGGER aa_poker_arena_no_chip_money;','existing_authority_changed'),('ACL','REVOKE SELECT ON rake_records FROM anon;','existing_authority_changed'),('column','ALTER TABLE rake_records ALTER COLUMN source SET DEFAULT \'wrong\';','existing_authority_changed')]:
   q('BEGIN;'+setup+native_guard,error);q(native_guard);ok('guard_'+name+'_refusal_rollback')
  for pre,body in parts:
   name=re.search(r'CREATE INDEX CONCURRENTLY IF NOT EXISTS (\w+)',pre).group(1);oid=q('SELECT '+lit(name)+'::regclass::oid');q(pre);q(body);assert q('SELECT '+lit(name)+'::regclass::oid')==oid
   q("BEGIN;UPDATE pg_index SET indisvalid=false WHERE indexrelid="+lit(name)+"::regclass;"+body,'exact_index_structure_required');q(body)
  ok('VALID_prefix_resumes_without_rebuild_INVALID_prefix_refuses_atomically')
  q("SET ROLE service_role;INSERT INTO rake_records(id,is_tournament,tournament_id,metadata,rake_method,global_hand_id)VALUES(md5('writer')::uuid,true,md5('1')::uuid,'{}','DEALT_EQUAL',1000000);UPDATE rake_records SET metadata=jsonb_build_array(repeat('x',3000))WHERE id=md5('writer')::uuid;UPDATE rake_records SET metadata='{}'WHERE id=md5('writer')::uuid;")
  q(native_guard);ok('service_role_INSERT_UPDATE_index_maintenance_across_both_predicates')
  # Owning applier's exact atomic history template; wrong history must roll back
  # the body while retaining the independent VALID CCI prefix for safe resume.
  applier=(R/'scripts/ci/apply-recorded-migration.mjs').read_text();template=re.search(r'const historyStatement = `([\s\S]*?)`;',applier).group(1)
  for file,source,(pre,body) in zip(files[1:],sources[1:],parts):
   version=file.name[:14];slug=file.name[15:-4];tag='$ca_file_history_'+version+'$';literal=tag+source+tag
   history=template.replace('${version}',version).replace('${slug}',slug).replace('${exactSQLLiteral}',literal)
   wrong=history.replace('ARRAY['+literal+'::text]',"ARRAY['wrong-source']",1);assert wrong!=history
   q(body.rsplit('COMMIT;',1)[0]+wrong+'COMMIT;','atomic migration history does not match the exact source file')
   assert q('SELECT count(*)FROM supabase_migrations.schema_migrations WHERE version='+lit(version))=='0';q(body)
   q(body.rsplit('COMMIT;',1)[0]+history+'COMMIT;')
   assert q('SELECT statements=ARRAY['+lit(source)+']FROM supabase_migrations.schema_migrations WHERE version='+lit(version))=='t'
  ok('actual_applier_atomic_history_mismatch_rolls_back_VALID_prefix_then_exact_file_records')
  # Real old-snapshot CCI wait in PRIVATE fixture, with concurrent FK writer.
  pre,body=parts[0];q('DROP INDEX rake_records_tournament_small_evidence_cover;')
  hold=subprocess.Popen(list(map(str,ps)),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env,bufsize=1)
  try:
   hold.stdin.write('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;SELECT count(*)FROM rake_records;\n');hold.stdin.flush();assert hold.stdout.readline().strip()=='12001'
   with concurrent.futures.ThreadPoolExecutor(max_workers=1)as pool:
    build=pool.submit(q,pre);deadline=time.monotonic()+20
    while True:
     phase=q("SELECT phase FROM pg_stat_progress_create_index WHERE relid='rake_records'::regclass")
     if phase=='waiting for old snapshots':break
     assert not build.done()and time.monotonic()<deadline,('no real snapshot phase',phase)
     time.sleep(.02)
    q("SET ROLE service_role;INSERT INTO rake_records(id,is_tournament,tournament_id,metadata,rake_method,global_hand_id)VALUES(md5('concurrent-writer')::uuid,true,md5('1')::uuid,'{}','DEALT_EQUAL',1000001);")
    hold.stdin.write('SELECT count(*)FROM rake_records;COMMIT;\n');hold.stdin.flush();assert hold.stdout.readline().strip()=='12001';build.result(timeout=30)
   hold.stdin.close();assert hold.wait(timeout=10)==0,hold.stderr.read()
  finally:
   if hold.poll()is None:hold.kill();hold.wait()
  q(body);q(native_guard);assert q('SELECT count(*)FROM rake_records')=='12002'
  ok('real_CCI_old_RR_snapshot_wait_and_concurrent_service_FK_writer_preserve_authority')
  result={'qualification':'passed','cases':cases,'plans':plans,'migrations':{str(f.relative_to(R)):hashlib.sha256(s.encode()).hexdigest()for f,s in zip(files,sources)},'limits':'Private PG17/8192/MAXALIGN8 only. Actual20 schema types/defaults,8 constraints,19 indexes,39 trigger identities; financial bodies and five guard collaborators are explicit inert adapters. Native catalog payload OIDs substituted only in fixture. No production build/runtime/wholeScope qualification; no business function changed.'};a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'qualification':'passed','case_count':len(cases)}))
 finally:
  if started:run([a.pg_bin/'pg_ctl','-D',d,'-m','immediate','-w','stop'])
  shutil.rmtree(w)
if __name__=='__main__':main()
