#!/usr/bin/env python3
"""PG17 Boolean expression statistics: exact installed authorities and original bags.
Private fixtures only. Source65/GEN and maintenance gates are explicit controlled
adapters; no production capacity, whole-report, money or original65 execution claim.
"""
import argparse,hashlib,json,os,re,socket,subprocess,tempfile,time,uuid
from pathlib import Path
R=Path(__file__).resolve().parents[2];F=R/'scripts/ci/fixtures/original-shaped-cash-boolgate';INDEX='union_pnl_cash_outcomes_shape_gate_window';VERSION='20261029084451';GEN='original-inventory-245-v1:72b51e4349fc9cd371bfb7f771b7ae20'
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
  cols=[c['name']+' '+c['type']+(' DEFAULT '+c['default']if c['default']else'')+(' NOT NULL'if c['notnull']else'')for c in authority['columns']];q('CREATE TABLE public.union_pnl_cash_outcomes('+','.join(cols)+');')
  for c in authority['constraints']:q('ALTER TABLE public.union_pnl_cash_outcomes ADD CONSTRAINT '+c['name']+' '+c['definition']+';')
  for i in authority['indexes']:
   name=i['definition'].split('INDEX ')[1].split(' ON ')[0]
   if q('SELECT to_regclass('+lit(name)+')IS NULL;')=='t':q(i['definition']+';')
  q('CREATE TABLE public.union_pnl_cash_outcome_touches(table_id uuid NOT NULL,hand_number bigint NOT NULL,recognized_at timestamptz,game_union_id text,shaped boolean NOT NULL,accepted_rake text,participants jsonb,PRIMARY KEY(table_id,hand_number));CREATE INDEX touch_week ON public.union_pnl_cash_outcome_touches(game_union_id,recognized_at);')
  for o in owners:
   q('SET check_function_bodies=false;'+o['definition']+';')
   if o['metadata']['proacl'] is not None:
    q('REVOKE ALL ON FUNCTION '+o['signature']+' FROM PUBLIC,postgres,anon,authenticated,service_role;')
    for g in o['metadata']['proacl']:q('GRANT EXECUTE ON FUNCTION '+o['signature']+' TO '+(g.split('=')[0]or'PUBLIC')+';')
  q((F/'original-touch-producers.sql').read_text())
  q("CREATE FUNCTION fn_ca_break_window_refuses_migrations(timestamptz)RETURNS text LANGUAGE sql STABLE AS $$SELECT CASE WHEN current_setting('native.window',true)='on'THEN'window'END$$;CREATE FUNCTION fn_platform_frozen()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT COALESCE(current_setting('native.frozen',true)='on',false)$$;CREATE FUNCTION fn_active_maintenance_release_boundary()RETURNS timestamptz LANGUAGE sql STABLE AS $$SELECT CASE WHEN current_setting('native.boundary',true)='on'THEN clock_timestamp()END$$;CREATE OR REPLACE FUNCTION smarter_private.original_inventory_proof_sources_match()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT COALESCE(current_setting('native.source65',true)<>'off',true)$$;CREATE OR REPLACE FUNCTION smarter_private.original_inventory_basis_generation()RETURNS text LANGUAGE sql STABLE AS $$SELECT CASE WHEN current_setting('native.gen',true)='off'THEN NULL ELSE '"+GEN+"'END$$;")
  Q=R/'scripts/ci/fixtures/original-shaped-cash-statistics';installed=R/'supabase/migrations/20261029071236_original_shaped_cash_selects_the_stored_boolean_gate.sql';assert hashlib.sha256(installed.read_bytes()).hexdigest()=='7b29ac92bc3f68052c70d66166d1a4177c6de0118bee7d081190255c6c8cf658'
  q((Q/'causal-200k.sql').read_text());q('INSERT INTO union_pnl_cash_outcome_touches SELECT t.* FROM union_pnl_cash_outcomes o CROSS JOIN LATERAL fn_union_pnl_cash_outcome_touch_row(o.table_id,o.hand_number,o.recognized_at,o.game_scope,o.evidence)t;')
  for t in authority['triggers']:
   if not t['catalog']['tgisinternal']:q(t['definition']+';')
  q('ALTER TABLE union_pnl_cash_outcomes ENABLE ROW LEVEL SECURITY;REVOKE ALL ON union_pnl_cash_outcomes FROM PUBLIC,anon,authenticated,service_role;ANALYZE union_pnl_cash_outcomes;ANALYZE union_pnl_cash_outcome_touches;')
  q(installed.read_text());q("INSERT INTO supabase_migrations.schema_migrations VALUES('20261029071236','original_shaped_cash_selects_the_stored_boolean_gate',ARRAY["+lit(installed.read_text())+']);')
  rec('exact_installed71236_history_index_and26_owner_actual_table_contract')
  U='fade0000-0000-0000-0000-000000000001';START='2026-10-19 07:00Z';END='2026-10-26 07:00Z';EIOC=0 if __import__('sys').platform=='darwin' else 200
  settings="SET jit=off;SET effective_cache_size='48GB';SET effective_io_concurrency="+str(EIOC)+";SET max_parallel_workers=16;SET random_page_cost=1.1;SET work_mem='32MB';SET search_path=public,pg_temp;"
  shape=(F/'original-shaped-hands.sql').read_text();query=shape.split('RETURN QUERY ',1)[1].split(';\n ELSE',1)[0]
  for old,new in [('p_union_id','$1'),('p_start','$2'),('p_end','$3')]:query=query.replace(old,new)
  def stats():return js("SELECT COALESCE(jsonb_agg(to_jsonb(s)),'[]'::jsonb)FROM pg_statistic s WHERE starelid="+lit(INDEX)+"::regclass;")
  def bag(projected='true',mode='auto'):return js(settings+'SET plan_cache_mode='+mode+';'+"SELECT jsonb_build_object('count',count(*),'bag',md5(COALESCE(string_agg(md5(to_jsonb(x)::text),''ORDER BY table_id,hand_number),'')))FROM fn_union_pnl_week_shaped_hands("+lit(U)+','+lit(START)+','+lit(END)+','+projected+')x;')
  def explain(label):
   for mode in('auto','force_custom_plan','force_generic_plan'):
    pl=js(settings+'SET plan_cache_mode='+mode+';PREPARE shaped(uuid,timestamptz,timestamptz)AS '+query+';EXPLAIN(ANALYZE FALSE,VERBOSE TRUE,SETTINGS TRUE,FORMAT JSON)EXECUTE shaped('+lit(U)+','+lit(START)+','+lit(END)+');');plans[label+'_'+mode]=pl
   a.output.parent.mkdir(parents=True,exist_ok=True);a.output.with_name(a.output.stem+'-plans.json').write_text(json.dumps(plans,indent=2)+'\n')
   return {mode:{x.get('Index Name')for x in nodes(plans[label+'_'+mode])if x.get('Relation Name')=='union_pnl_cash_outcomes'}for mode in('auto','force_custom_plan','force_generic_plan')}
  fns="SELECT jsonb_agg(jsonb_build_object('definition',pg_get_functiondef(oid),'metadata',to_jsonb(p))ORDER BY oid)FROM pg_proc p WHERE pronamespace IN('public'::regnamespace,'smarter_private'::regnamespace)";fn_before=q(fns);allrows="SELECT md5(string_agg(md5(to_jsonb(t)::text),''ORDER BY hand_number))FROM union_pnl_cash_outcomes t";rows_before=q(allrows)
  before_bags={p:bag(p)for p in('true','false','NULL')};assert all(x['count']==160 for x in before_bags.values());assert stats()==[]
  before_plans=explain('no_expression_statistics');assert all(INDEX not in v for v in before_plans.values()),before_plans;rec('faithful200k_missing_expression_statistics_reproduces_original_date_selector_all3_modes')
  base_stats=js("SELECT jsonb_agg(to_jsonb(s)ORDER BY attname)FROM pg_stats s WHERE schemaname='public'AND tablename='union_pnl_cash_outcomes'");width=sum(s['avg_width']for s in base_stats);clock=next(s for s in base_stats if s['attname']=='recognized_at');assert 1260<=width<=1290 and .96<clock['correlation']<.995,(width,clock)
  for columns in ['recognized_at','evidence','game_scope','recognized_at,evidence,game_scope']:
   q('ANALYZE union_pnl_cash_outcomes('+columns+');');assert stats()==[]
  rec('all_selected_column_variants_leave_Boolean_index_statistics_missing')
  fault=sql.replace('COMMIT;',"DO $$BEGIN RAISE EXCEPTION 'native_post_guard_failure';END$$;COMMIT;");q(fault,'native_post_guard_failure');assert stats()==[] and q(fns)==fn_before;rec('ANALYZE_statistics_catalog_rolls_back_with_post_guard_failure')
  target='fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)'
  q(sql.replace('ANALYZE public.union_pnl_cash_outcomes;','ANALYZE public.union_pnl_cash_outcomes;ALTER FUNCTION '+target+' COST 999;'),'original_shaped_cash_statistics_original_authority_changed');assert stats()==[] and q(fns)==fn_before;rec('noncritical26_owner_full_raw_metadata_drift_after_snapshot_refuses_and_rolls_back')
  original=q('SELECT pg_get_functiondef('+lit(target)+'::regprocedure);');bits=original.split('$function$');assert len(bits)==3;mutated=bits[0]+'$function$\nBEGIN RETURN \'{}\'::jsonb;END\n$function$;'
  q(sql.replace('ANALYZE public.union_pnl_cash_outcomes;','ANALYZE public.union_pnl_cash_outcomes;'+mutated),'original_shaped_cash_statistics_original_authority_changed');assert stats()==[] and q(fns)==fn_before;rec('noncritical26_owner_body_drift_after_snapshot_refuses_and_rolls_back')
  budget="DO $$BEGIN IF current_setting('statement_timeout')<>'15s'OR current_setting('lock_timeout')<>'1s'OR current_setting('transaction_timeout')<>'1min'THEN RAISE EXCEPTION 'native_budget_not_exact';END IF;END$$;"
  # The exact source runs uninstrumented below; this extra assertion only observes native phase budgets.
  q(sql.replace('ANALYZE public.union_pnl_cash_outcomes;',budget+'ANALYZE public.union_pnl_cash_outcomes;'));collected=stats();assert len(collected)==1 and collected[0]['stadistinct']==2 and collected[0]['stanullfrac']==0
  rec('whole_table_ANALYZE_collects_real_Boolean_distribution_under_exact15_1_60_budgets')
  after_plans=explain('collected_expression_statistics');assert all(INDEX in after_plans[m]for m in('auto','force_custom_plan')),after_plans
  mode_bags={m:bag(mode=m)for m in('auto','force_custom_plan','force_generic_plan')};assert all(b==before_bags['true']for b in mode_bags.values());rec('natural_auto_custom_causal_flip_with_generic_plan_settings_and_exact_bag_preserved')
  assert all(bag(p)==v for p,v in before_bags.items())and q(fns)==fn_before;rec('original_true_false_NULL_function_bags_and_all_owner_definitions_metadata_unchanged')
  # Keep table statistics unchanged while recreating ONLY the owned native index:
  # the inverse removes index-expression statistics without fabricating catalog data.
  statement="CREATE INDEX "+INDEX+" ON public.union_pnl_cash_outcomes USING btree ((((evidence->>'status'IS DISTINCT FROM'ready')OR(evidence->'basis_certified'IS DISTINCT FROM'true'::jsonb)OR(evidence->'all_players_included'IS DISTINCT FROM'true'::jsonb)OR(evidence->'game_scope'IS DISTINCT FROM game_scope))),recognized_at)INCLUDE(table_id,hand_number)"
  q('DROP INDEX '+INDEX+';'+statement+';');assert stats()==[];inverse=explain('index_statistics_removed_again');assert all(INDEX not in inverse[m]for m in('auto','force_custom_plan')),inverse;rec('causal_inverse_same_table_statistics_no_index_statistics_returns_to_date_selectors')
  q(sql);assert len(stats())==1;rec('byte_exact_uninstrumented_migration_collects_statistics_successfully')
  for flag,err in [('source65','source65_required'),('gen','original_generation_required')]:q("SELECT set_config('native."+flag+"','off',false);"+sql,'original_shaped_cash_statistics_'+err);rec(flag+'_refuses')
  for flag in('window','frozen','boundary'):q("SELECT set_config('native."+flag+"','on',false);"+sql,'original_shaped_cash_statistics_window_refused');rec(flag+'_refuses')
  for prefix in["SET request.jwt.claims='{}';","SET request.jwt.claim.role='service_role';","SET ROLE anon;","SET ca.break_window_migration_override='native';"]:q(prefix+sql,'original_shaped_cash_statistics_operator_refused');rec('operator_'+prefix)
  q("UPDATE supabase_migrations.schema_migrations SET statements=ARRAY['tampered']WHERE version='20261029071236';");q(sql,'original_shaped_cash_statistics_installed71236_required');q("UPDATE supabase_migrations.schema_migrations SET statements=ARRAY["+lit(installed.read_text())+"]WHERE version='20261029071236';");rec('exact_installed71236_source_history_required')
  q("INSERT INTO supabase_migrations.schema_migrations VALUES('"+VERSION+"','native',ARRAY['fixture']);");q(sql,'original_shaped_cash_statistics_history_replay');q("DELETE FROM supabase_migrations.schema_migrations WHERE version='"+VERSION+"';");rec('history_replay_refuses')
  assert q(fns)==fn_before and q(allrows)==rows_before and all(bag(p)==v for p,v in before_bags.items())
  rec('all200k_economic_fixture_rows_and_26_connected_authorities_preserved')
  report={'status':'passed','cases':cases,'migration_sha256':hashlib.sha256(sql.encode()).hexdigest(),'installed71236_sha256':hashlib.sha256(installed.read_bytes()).hexdigest(),'native_rows':200000,'original_bags_by_plan_mode':mode_bags,'generic_index_choice_not_forced_or_guaranteed':True,'native_full_width':width,'native_recognized_correlation':clock['correlation'],'base_stats':base_stats,'collected_index_statistics':collected,'observed_production_cost_settings_used':True,'effective_io_concurrency':EIOC,'macOS_prefetch_limitation':EIOC==0,'source65_generation_maintenance_controlled_fixture_boundaries':True,'statistics_fabricated':False,'production_capacity_claimed':False};a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(report,indent=2)+'\n');a.output.with_name(a.output.stem+'-plans.json').write_text(json.dumps(plans,indent=2)+'\n');print(json.dumps(report))
 finally:
  if started:run([a.pg_bin/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
if __name__=='__main__':main()
