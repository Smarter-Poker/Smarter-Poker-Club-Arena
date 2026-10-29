#!/usr/bin/env python3
"""PG17 genuine single-expression statistics: unchanged actual linked-cash table and source authorities.
Private fixtures only. Source65/GEN and maintenance gates are explicit controlled
adapters; no production capacity, whole-report, money or original65 execution claim.
"""
import argparse,hashlib,json,os,re,socket,subprocess,tempfile,time,uuid
from pathlib import Path
R=Path(__file__).resolve().parents[2];F=R/'scripts/ci/fixtures/original-linked-cash-spgist';INDEX='union_pnl_cash_links_valid_union_selector';VERSION='20261029190331';GEN='original-inventory-245-v1:72b51e4349fc9cd371bfb7f771b7ae20'
def lit(x):return 'NULL'if x is None else "'"+str(x).replace("'","''")+"'"
def uid(n):return str(uuid.UUID(int=n))
def nodes(n):
 if isinstance(n,dict):
  yield n
  for v in n.values():yield from nodes(v)
 elif isinstance(n,list):
  for v in n:yield from nodes(v)
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--pg-bin',type=Path,default=Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin')));p.add_argument('--scratch',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();assert __debug__ and a.scratch.is_dir()and not a.output.exists();w=Path(tempfile.mkdtemp(prefix='membership-',dir=a.scratch.resolve()));data=w/'d';started=False;cases=[];plans={};E={k:v for k,v in os.environ.items()if not k.startswith('PG')};E.update(TMPDIR=str(w),TMP=str(w),TEMP=str(w),LC_ALL='C',PGTZ='UTC')
 with socket.socket()as sk:sk.bind(('127.0.0.1',0));port=str(sk.getsockname()[1])
 ps=[a.pg_bin/'psql','-XqAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','postgres','-d','postgres']
 def run(args,sql=None,error=None,timeout=90):
  with tempfile.TemporaryFile(mode='w+',dir=w)as f:
   if sql is not None:f.write(sql);f.seek(0)
   z=subprocess.run(list(map(str,args)),stdin=f if sql is not None else None,text=True,capture_output=True,env=E,timeout=timeout)
  assert (z.returncode!=0 and error in z.stderr)if error else z.returncode==0,(z.stdout[-1000:],z.stderr[-5000:]);return z.stdout.strip()
 def q(s,error=None):return run(ps,s,error)
 def js(s):return json.loads(q(s))
 def rec(n):cases.append(n);print('PASS',n,flush=True)
 migration=next((R/'supabase/migrations').glob(VERSION+'_*'));sql=migration.read_text();authority=json.loads((F/'meaningful-table-contract.json').read_text());actual=json.loads((F/'actual-table-authority.json').read_text());owners=json.loads((F/'actual-connected-owners.json').read_text())
 try:
  assert ' 17.'in run([a.pg_bin/'postgres','--version']);run([a.pg_bin/'initdb','-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);run([a.pg_bin/'pg_ctl','-D',data,'-l',w/'server.log','-w','start','-o',f"-k '' -h 127.0.0.1 -p {port} -c shared_buffers=32MB -c maintenance_work_mem=32MB"]);started=True
  q('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA smarter_private;CREATE SCHEMA supabase_migrations;CREATE TABLE supabase_migrations.schema_migrations(version text,name text,statements text[]);CREATE TABLE public.union_pnl_transaction_frames(transaction_id xid8 PRIMARY KEY);INSERT INTO public.union_pnl_transaction_frames VALUES(\'1\');')
  aux=json.loads((R/'scripts/ci/fixtures/original-shaped-cash-boolgate/meaningful-table-contract.json').read_text());cols=[c['name']+' '+c['type']+(' DEFAULT '+c['default']if c['default']else'')+(' NOT NULL'if c['notnull']else'')for c in aux['columns']];q('CREATE TABLE public.union_pnl_cash_outcomes('+','.join(cols)+');')
  for c in aux['constraints']:q('ALTER TABLE public.union_pnl_cash_outcomes ADD CONSTRAINT '+c['name']+' '+c['definition']+';')
  for i in aux['indexes']:
   name=i['definition'].split('INDEX ')[1].split(' ON ')[0]
   if q('SELECT to_regclass('+lit(name)+')IS NULL;')=='t':q(i['definition']+';')
  q('CREATE TABLE public.union_pnl_cash_outcome_touches(table_id uuid NOT NULL,hand_number bigint NOT NULL,recognized_at timestamptz,game_union_id text,shaped boolean NOT NULL,accepted_rake text,participants jsonb,PRIMARY KEY(table_id,hand_number));CREATE INDEX touch_week ON public.union_pnl_cash_outcome_touches(game_union_id,recognized_at);')
  for o in owners:
   q('SET check_function_bodies=false;'+o['definition']+';')
   if o['metadata']['proacl'] is not None:
    q('REVOKE ALL ON FUNCTION '+o['signature']+' FROM PUBLIC,postgres,anon,authenticated,service_role;')
    for g in o['metadata']['proacl']:q('GRANT EXECUTE ON FUNCTION '+o['signature']+' TO '+(g.split('=')[0]or'PUBLIC')+';')
  q((R/'scripts/ci/fixtures/original-shaped-cash-boolgate/original-touch-producers.sql').read_text())
  q("CREATE FUNCTION fn_ca_break_window_refuses_migrations(timestamptz)RETURNS text LANGUAGE sql STABLE AS $$SELECT CASE WHEN current_setting('native.window',true)='on'THEN'window'END$$;CREATE FUNCTION fn_platform_frozen()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT COALESCE(current_setting('native.frozen',true)='on',false)$$;CREATE FUNCTION fn_active_maintenance_release_boundary()RETURNS timestamptz LANGUAGE sql STABLE AS $$SELECT CASE WHEN current_setting('native.boundary',true)='on'THEN clock_timestamp()END$$;CREATE OR REPLACE FUNCTION smarter_private.original_inventory_proof_sources_match()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT COALESCE(current_setting('native.source65',true)<>'off',true)$$;CREATE OR REPLACE FUNCTION smarter_private.original_inventory_basis_generation()RETURNS text LANGUAGE sql STABLE AS $$SELECT CASE WHEN current_setting('native.gen',true)='off'THEN NULL ELSE '"+GEN+"'END$$;")

  target='union_pnl_cash_outcome_link_resolutions';U='fade0000-0000-0000-0000-000000000001';START='2026-10-19 07:00Z';END='2026-10-26 07:00Z'
  cols=[c['name']+' '+c['type']+(' DEFAULT '+c['default']if c['default']else'')+(' NOT NULL'if c['notnull']else'')for c in authority['columns']];q('CREATE TABLE '+target+'('+','.join(cols)+');')
  for c in authority['constraints']:q('ALTER TABLE '+target+' ADD CONSTRAINT '+c['name']+' '+c['definition']+';')
  for i in authority['indexes']:
   if q('SELECT to_regclass('+lit(i['definition'].split('INDEX ')[1].split(' ON ')[0])+')IS NULL;')=='t':q(i['definition']+';')
  q("ALTER TABLE "+target+" ENABLE ROW LEVEL SECURITY;GRANT SELECT ON "+target+" TO service_role;")
  for t in authority['triggers']:q(t['definition']+';')
  proj=(F/'table-contract-projection.sql').read_text();assert js(proj)==authority;rec('actual14columns10constraints3indexes_immutable_trigger_RLS_ACL')
  q("INSERT INTO union_pnl_cash_outcomes SELECT 'fade0000-0000-0000-0000-000000000010',g,md5(('hand'||g)::text)::uuid,'1',CASE WHEN g=20002 THEN '2026-10-26 07:00Z'::timestamptz ELSE '2026-10-19 07:00Z'::timestamptz END,'payload','{}','{\"ready\":true}'FROM generate_series(1,20006)g;")
  q("WITH b AS(SELECT o.table_id,o.hand_number,o.hand_id,CASE WHEN hand_number=20003 THEN 'wrong'ELSE payload_hash END outcome_payload_hash,CASE WHEN hand_number=20004 THEN md5('wrong')ELSE md5(o.evidence::text)END outcome_evidence_md5,'seat_inventory'::text roster_source,jsonb_build_object('game_union_id',CASE WHEN hand_number=20005 THEN NULL WHEN hand_number=20006 THEN(SELECT string_agg(md5(x::text),'')FROM generate_series(1,192)x)WHEN hand_number>20000 OR hand_number%100<89 THEN '"+U+"' ELSE 'fade0000-0000-0000-0000-000000000002'END,'host_club_id',null,'tournament_id',null,'is_private',false,'asset','CHIPS','unit_scale',1)game_scope FROM union_pnl_cash_outcomes o),e AS(SELECT b.*,jsonb_build_object('provenance_link','resolved','game_scope',game_scope)evidence FROM b),p AS(SELECT e.*,jsonb_build_object('status','proven','resolution_kind','cash_outcome_provenance_link','table_id',table_id,'hand_number',hand_number,'hand_id',hand_id,'outcome_payload_hash',outcome_payload_hash,'outcome_evidence_md5',outcome_evidence_md5,'roster_source',roster_source,'manifest_id',null,'game_scope',game_scope,'evidence',evidence,'padding',(SELECT string_agg(md5(e.hand_number::text||':'||x::text),'')FROM generate_series(1,160)x))proof FROM e)INSERT INTO "+target+"(table_id,hand_number,hand_id,outcome_payload_hash,outcome_evidence_md5,roster_source,game_scope,evidence,proof,proof_md5,reason)SELECT table_id,hand_number,hand_id,outcome_payload_hash,outcome_evidence_md5,roster_source,game_scope,evidence,proof,md5(proof::text),'native exact linked cash fixture'FROM p;")
  def bag():return js("SELECT jsonb_build_object('count',count(*),'bag',md5(COALESCE(string_agg(md5(to_jsonb(x)::text),''ORDER BY table_id,hand_number),'')))FROM fn_union_pnl_linked_cash_outcomes("+lit(U)+','+lit(START)+','+lit(END)+')x;')
  q("INSERT INTO "+target+"(table_id,hand_number,hand_id,outcome_payload_hash,outcome_evidence_md5,roster_source,manifest_id,game_scope,evidence,proof,proof_md5,reason)SELECT table_id,999999,'fade9999-0000-0000-0000-000000000099',outcome_payload_hash,outcome_evidence_md5,roster_source,manifest_id,game_scope,evidence,proof,repeat('0',32),reason FROM "+target+" LIMIT1;".replace('LIMIT1','LIMIT 1'),'violates check constraint "union_pnl_cash_outcome_link_resolutions_check"');rec('invalid_proof_original_CHECK_refuses')
  q("SET ROLE anon;SELECT * FROM fn_union_pnl_linked_cash_outcomes("+lit(U)+','+lit(START)+','+lit(END)+');','permission denied for function fn_union_pnl_linked_cash_outcomes');rec('original_nonowner_function_permission_refuses')
  before=bag();assert before['count']==17801;rec('original_function_boundary_payload_evidence_NULLunion_bag')
  linked=(F/'original-linked-cash.sql').read_text();query=linked.split('AS $function$',1)[1].split('$function$',1)[0]
  for old,new in [('p_union_id','$1'),('p_start','$2'),('p_end','$3')]:query=query.replace(old,new)
  installed=R/'supabase/migrations/20261029172002_original_cash_links_use_a_lossless_partial_union_selector.sql';installed_sql=installed.read_text();assert hashlib.sha256(installed.read_bytes()).hexdigest()=='ffb6048bbe418e9558fe8c78aa051d09bb6771ccd9e74ddaed32c668905494dd'
  split="import{splitConcurrentPreamble}from"+json.dumps((R/'scripts/ci/migration-concurrent-preamble.mjs').as_uri())+";import fs from'node:fs';console.log(JSON.stringify(splitConcurrentPreamble(fs.readFileSync(process.argv[1],'utf8'))));";parts=json.loads(run(['node','--input-type=module','-e',split,installed]));assert parts['ok']and len(parts['indexes'])==1;q(parts['indexes'][0]['statement']);q("INSERT INTO supabase_migrations.schema_migrations VALUES('20261029172002','original_cash_links_use_a_lossless_partial_union_selector',ARRAY["+lit(installed_sql)+']);')
  rawtr="SELECT jsonb_agg(to_jsonb(t)ORDER BY oid)FROM pg_trigger t WHERE tgrelid='"+target+"'::regclass";fns="SELECT jsonb_agg(jsonb_build_object('definition',pg_get_functiondef(oid),'metadata',to_jsonb(p))ORDER BY oid)FROM pg_proc p WHERE pronamespace IN('public'::regnamespace,'smarter_private'::regnamespace)";rb=q(rawtr);fb=q(fns);before=bag()
  selector=query.replace('AND r.proof_md5=md5(r.proof::text)','');settings="SET jit=off;SET random_page_cost=1.1;SET effective_cache_size='48GB';SET work_mem='32MB';"
  def explain(label):
   for mode in ('auto','force_custom_plan','force_generic_plan'):
    pl=js(settings+'SET plan_cache_mode='+mode+';PREPARE candidate(uuid,timestamptz,timestamptz)AS '+selector+';EXPLAIN(VERBOSE,FORMAT JSON)EXECUTE candidate('+lit(U)+','+lit(START)+','+lit(END)+');');plans[label+'_'+mode]=pl
   ns=list(nodes(plans[label+'_force_custom_plan']));r=next(n for n in ns if n.get('Relation Name')==target);return r['Plan Rows']
  q('ANALYZE '+target+';ANALYZE union_pnl_cash_outcomes;');assert explain('ordinary_analyze')==100;rec('ordinary_analyze_partial_index_stats_leave_union_default_selectivity')
  q(sql.replace('COMMIT;','ROLLBACK;'));assert q("SELECT count(*)FROM pg_statistic_ext WHERE stxname='union_pnl_cash_links_union_distribution';")=='0';rec('rollback_removes_new_statistics_object_and_keeps_sources')
  q(sql);assert explain('genuine_expression_statistics')==17804;rec('single_expression_stats_correct_custom_union_estimate_to_actual17804')
  assert q("SELECT count(*)FROM pg_stats_ext_exprs WHERE statistics_name='union_pnl_cash_links_union_distribution'AND most_common_freqs[1]>.88 AND most_common_freqs[1]<.90;")=='1';rec('real_collected_union_MCV89percent_no_fabrication')
  assert bag()==before and q(rawtr)==rb and q(fns)==fb and js(proj)==authority;rec('all27_functions_fullmetadata_original_bag_schema_old3_rawtrigger_unchanged')
  q(sql,'linked_union_statistics_existing_object_refused');q('DROP STATISTICS public.union_pnl_cash_links_union_distribution;');rec('unexpected_existing_object_refuses_without_overwrite')
  q(sql.replace('COMMIT;',"DO $$BEGIN RAISE EXCEPTION 'native_atomic_post_failure';END$$;COMMIT;"),'native_atomic_post_failure');assert q("SELECT count(*)FROM pg_statistic_ext WHERE stxname='union_pnl_cash_links_union_distribution';")=='0';rec('post_failure_atomic_rollback_no_orphan_statistics')
  for flag,err in [('source65','source65_required'),('gen','original_generation_required')]:q("SELECT set_config('native."+flag+"','off',false);"+sql,'original_linked_cash_spgist_'+err);rec(flag+'_refuses')
  for flag in('window','frozen','boundary'):q("SELECT set_config('native."+flag+"','on',false);"+sql,'original_linked_cash_spgist_window_refused');rec(flag+'_refuses')
  q("SET request.jwt.claims='{}';"+sql,'original_linked_cash_spgist_operator_refused');rec('JWT_operator_refuses')
  q("INSERT INTO supabase_migrations.schema_migrations VALUES('"+VERSION+"','native',ARRAY['fixture']);");q(sql,'linked_union_statistics_history_replay');q("DELETE FROM supabase_migrations.schema_migrations WHERE version='"+VERSION+"';");rec('history_replay_refuses')
  q('GRANT SELECT ON '+target+' TO anon;');q(sql,'original_linked_cash_spgist_actual_table_required');q('REVOKE SELECT ON '+target+' FROM anon;');rec('ACL_drift_refuses')
  q('ALTER INDEX union_pnl_cash_links_proof_gate_hand RENAME TO native_old;');q(sql,'original_linked_cash_spgist_actual_table_required');q('ALTER INDEX native_old RENAME TO union_pnl_cash_links_proof_gate_hand;');rec('old_index_drift_refuses')
  q('ALTER TABLE '+target+' DISABLE TRIGGER original_pnl_immutable;');q(sql,'original_linked_cash_spgist_actual_table_required');q('ALTER TABLE '+target+' ENABLE TRIGGER original_pnl_immutable;');rec('immutable_trigger_drift_refuses')
  q('GRANT EXECUTE ON FUNCTION fn_union_pnl_linked_cash_outcomes(uuid,timestamptz,timestamptz)TO anon;');q(sql,'original_linked_cash_spgist_query_authority_changed');q('REVOKE EXECUTE ON FUNCTION fn_union_pnl_linked_cash_outcomes(uuid,timestamptz,timestamptz)FROM anon;');rec('linked_owner_ACL_drift_refuses')
  q('ALTER INDEX '+INDEX+' RENAME TO native_selector;');q(sql,'original_linked_cash_spgist_actual_table_required');q('ALTER INDEX native_selector RENAME TO '+INDEX+';');rec('installed_SPGiST_drift_refuses')
  drift=owners[0]['definition'].replace('AS $function$','AS $function$\n-- native after-snapshot body drift\n')+';'
  q(sql.replace('ANALYZE public.union_pnl_cash_outcome_link_resolutions;',drift+'ANALYZE public.union_pnl_cash_outcome_link_resolutions;'),'original_linked_cash_spgist_original_authority_changed');assert q(fns)==fb;rec('noncritical27_full_body_after_snapshot_drift_atomic_refusal')
  q(sql);assert bag()==before and q(rawtr)==rb and q(fns)==fb;report={'status':'passed','cases':cases,'migration_sha256':hashlib.sha256(sql.encode()).hexdigest(),'source65_GEN_gate_fixtures_explicit':True,'production_capacity_claimed':False,'all27_authorities_unchanged':True,'fixture_rows':20006};a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(report,indent=2)+'\n');a.output.with_name(a.output.stem+'-plans.json').write_text(json.dumps(plans,indent=2)+'\n');print(json.dumps(report))
 finally:
  if started:run([a.pg_bin/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
if __name__=='__main__':main()
