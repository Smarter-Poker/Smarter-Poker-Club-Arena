"""Actual PG17 non-inlined original SQL-function calls; no planner flags/stats maintenance."""
import json,time,re

def nested_plan(log):
 decoder=json.JSONDecoder()
 for match in re.finditer(r'(?m)^\s*\{',log):
  try:value,_=decoder.raw_decode(log[match.start():].lstrip())
  except json.JSONDecodeError:continue
  if 'proof_md5'in value.get('Query Text','')and'SELECT r.table_id'in value.get('Query Text',''):return value
 raise AssertionError('actual nested SQL-function body plan missing')

def qualify(q,env,prefix,statement,t,cases):
 raw=prefix;results=[]
 for mode in ['boolean','hash']:
  for pct in [95,100]:
   for week in [1,20]:
    db=mode+str(pct)+'w'+str(week);q('CREATE DATABASE '+db);env['PGDATABASE']=db
    fixture=raw.replace('n%100=0 THEN','n<='+str(5700 if pct==95 else 6000)+' THEN').replace("'1','2026-10-20',","'1',CASE WHEN n%"+str(100 if week==1 else 5)+"=0 THEN '2026-10-20'::timestamptz ELSE '2025-10-20'::timestamptz END,").replace('CREATE ROLE service_role;CREATE ROLE authenticated;CREATE ROLE anon;','')
    fixture='\n'.join(l for l in fixture.splitlines()if not l.startswith('CREATE TEMP TABLE baseline'))
    q(fixture);call="SELECT*FROM public.fn_union_pnl_linked_cash_outcomes('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z')"
    bag="SELECT jsonb_build_object('count',count(*),'bag',md5(jsonb_agg(to_jsonb(x)ORDER BY to_jsonb(x)::text)::text))FROM("+call+")x"
    before=q(bag);authority=q("SELECT jsonb_build_object('definition',pg_get_functiondef(oid),'metadata',to_jsonb(p))FROM pg_proc p WHERE oid='public.fn_union_pnl_linked_cash_outcomes(uuid,timestamptz,timestamptz)'::regprocedure")
    q('DROP INDEX public.union_pnl_cash_links_valid_proof_hand;')
    create=statement if mode=='boolean'else"CREATE INDEX native_selected_union ON public.union_pnl_cash_outcome_link_resolutions USING hash((game_scope->>'game_union_id'))"
    q(create+';');offset=(t/'server.log').stat().st_size
    started=time.monotonic();after=q("LOAD 'auto_explain';SET log_min_messages='log';SET auto_explain.log_min_duration=0;SET auto_explain.log_nested_statements=on;SET auto_explain.log_analyze=on;SET auto_explain.log_buffers=on;SET auto_explain.log_format='json';SET auto_explain.log_level='log';"+bag+';');elapsed=(time.monotonic()-started)*1000
    assert before==after;assert q("SELECT jsonb_build_object('definition',pg_get_functiondef(oid),'metadata',to_jsonb(p))FROM pg_proc p WHERE oid='public.fn_union_pnl_linked_cash_outcomes(uuid,timestamptz,timestamptz)'::regprocedure")==authority
    log=(t/'server.log').read_text()[offset:]
    assert 'proof_md5' in log and 'Plan'in log,log
    entry={'mode':mode,'target_percent':pct,'week_percent':week,'four_field_bag':json.loads(after),'authority_unchanged':True,'original_md5':'0c3a826553e9ef65a03030c3ef78eaaf','cold_no_postbuild_ANALYZE':True,'actual_function_ms_includes_client_startup':elapsed,'actual_nested_log':log}
    # Equivalent COST1 instrumented function/index body; original remains intact.
    q("CREATE SEQUENCE native_proof_calls;CREATE FUNCTION public.native_counted_md5(text)RETURNS text LANGUAGE plpgsql IMMUTABLE COST 1 AS $c$BEGIN PERFORM nextval('public.native_proof_calls');RETURN md5($1);END$c$;")
    q('DROP INDEX '+('public.union_pnl_cash_links_proof_gate_hand'if mode=='boolean'else'native_selected_union')+';')
    q(create.replace('union_pnl_cash_links_proof_gate_hand','native_counted_proof').replace('native_selected_union','native_counted_union').replace('md5(proof::text)','public.native_counted_md5(proof::text)')+';')
    definition=json.loads(authority)['definition'];copy=definition.replace('public.fn_union_pnl_linked_cash_outcomes(', 'public.native_counted_linked(').replace('md5(r.proof::text)','public.native_counted_md5(r.proof::text)');q(copy)
    # last_value alone starts at1 even before nextval. is_called captures0.
    count_sql="SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM native_proof_calls";before_count=int(q(count_sql));counted_call=bag.replace('public.fn_union_pnl_linked_cash_outcomes','public.native_counted_linked');counter_offset=(t/'server.log').stat().st_size
    counted=q("LOAD 'auto_explain';SET log_min_messages='log';SET auto_explain.log_min_duration=0;SET auto_explain.log_nested_statements=on;SET auto_explain.log_analyze=on;SET auto_explain.log_format='json';SET auto_explain.log_level='log';"+counted_call+';');assert counted==after
    entry['actual_counted_function_proof_evaluations']=int(q(count_sql))-before_count;entry['counter_nested_log']=(t/'server.log').read_text()[counter_offset:];entry['counter_delta']='only proof md5(text) replaced by equivalent IMMUTABLE COST1 counted md5(text), same index expression and SQL-function SET configuration; original authority unchanged'
    original_plan=nested_plan(entry['actual_nested_log']);counted_plan=nested_plan(entry['counter_nested_log']);
    assert original_plan['Plan']['Actual Rows']==(57 if week==1 and pct==95 else 60 if week==1 else 1140 if pct==95 else 1200)
    if mode=='boolean':
     for checked,index_name in [(original_plan,'union_pnl_cash_links_proof_gate_hand'),(counted_plan,'native_counted_proof')]:
      outer,inner=checked['Plan']['Plans'];assert outer.get('Relation Name')=='union_pnl_cash_outcomes';assert outer['Actual Rows']==(60 if week==1 else 1200);assert inner.get('Index Name')==index_name and inner['Actual Loops']==outer['Actual Rows'];assert 'proof_md5'not in inner.get('Filter','');assert '= true' in inner['Index Cond']
     assert entry['actual_counted_function_proof_evaluations']==0
    else:assert entry['actual_counted_function_proof_evaluations']==(5700 if pct==95 else 6000)
    entry['actual_body_plan']=original_plan;entry['counter_body_plan']=counted_plan;results.append(entry);cases.append('actual_cold_'+mode+'_'+str(pct)+'pct_union_'+str(week)+'pct_week_function_fullbag_metadata_proof_counter')
    env['PGDATABASE']='postgres'
 return results

