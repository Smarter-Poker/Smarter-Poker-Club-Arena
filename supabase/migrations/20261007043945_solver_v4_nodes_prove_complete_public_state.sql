-- 20261007043945_solver_v4_nodes_prove_complete_public_state.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';

-- TIER: 2. Additive opt-in V4 validation. V3 nodes/checksums and all source
-- quality, action, physical-role and provenance checks remain unchanged.
-- Reconstruct public chip state from the independently validated Pio line;
-- never accept the worker's public-state summary as its own proof.
CREATE FUNCTION public.fn_gto_v31_complete_public_state(p_node jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $fn$
DECLARE
 lp jsonb:=p_node->'line_proof'; c jsonb:=p_node->'node_context';
 state jsonb:=p_node->'complete_public_state';
 bb numeric; root numeric; stack numeric; actor integer:=0; stage integer:=0;
 pot numeric; bet numeric:=0; increment numeric; old numeric; remaining numeric;
 target numeric; paid numeric; raised numeric; family text; token text;
 contribution numeric[]:=ARRAY[0,0]::numeric[]; spent numeric[]:=ARRAY[0,0]::numeric[];
 positions text[]; board text; history jsonb:='[]'; derived jsonb;
BEGIN
 IF NOT public.fn_gto_v31_json_safe_integer(lp->'chips_per_bb',1,9007199254740991)
 OR NOT public.fn_gto_v31_json_safe_integer(lp->'root_pot_chips',1,9007199254740991)
 OR NOT public.fn_gto_v31_json_safe_integer(lp->'effective_stack_chips',1,9007199254740991)
 OR NOT public.fn_gto_v31_physical_positions_valid(p_node) THEN RETURN NULL; END IF;
 bb:=(lp->>'chips_per_bb')::numeric; root:=(lp->>'root_pot_chips')::numeric;
 stack:=(lp->>'effective_stack_chips')::numeric; pot:=root; increment:=bb;
 derived:=public.fn_gto_v31_node_line_proof(p_node->>'node',
   (lp->>'preflop_aggressor_solver_player')::integer,root,stack);
 IF derived IS NULL THEN RETURN NULL; END IF;
 positions:=CASE (lp->>'hero_solver_player')::integer WHEN 0
   THEN ARRAY[c->>'hero_position',c->>'opponent_position']
   ELSE ARRAY[c->>'opponent_position',c->>'hero_position'] END;
 board:=left(c->>'board',6);
 FOREACH token IN ARRAY (string_to_array(p_node->>'node',':'))[3:] LOOP
  IF token ~ '^[2-9TJQKA][cdhs]$' THEN
   stage:=stage+1; actor:=0; bet:=0; increment:=bb; contribution:=ARRAY[0,0]::numeric[];
   board:=board||token; CONTINUE;
  END IF;
  old:=contribution[actor+1]; remaining:=stack-spent[actor+1];
  IF token='c' THEN
   family:=CASE WHEN bet>old THEN 'call' ELSE 'check' END; target:=bet;
  ELSIF token ~ '^b[1-9][0-9]*$' THEN
   target:=substring(token FROM 2)::numeric;
   IF target<=bet OR target>old+remaining OR
      (target<bet+increment AND target<>old+remaining) THEN RETURN NULL; END IF;
   family:=CASE WHEN target=old+remaining THEN 'all_in' WHEN bet>0 THEN 'raise' ELSE 'bet' END;
   raised:=target-bet; IF raised>=increment THEN increment:=raised; END IF; bet:=target;
  ELSE RETURN NULL; END IF;
  paid:=target-old; IF paid<0 OR paid>remaining THEN RETURN NULL; END IF;
  contribution[actor+1]:=target; spent[actor+1]:=spent[actor+1]+paid; pot:=pot+paid;
  history:=history||jsonb_build_array(jsonb_build_object('street',(ARRAY['flop','turn','river'])[stage+1],
   'solver_player',actor,'position',positions[actor+1],'family',family,'target_chips',target));
  actor:=1-actor;
 END LOOP;
 IF stage NOT BETWEEN 0 AND 2 OR board IS DISTINCT FROM c->>'board'
 OR actor IS DISTINCT FROM (lp->>'hero_solver_player')::integer
 OR actor IS DISTINCT FROM (derived->>'current_actor_solver_player')::integer
 OR pot>9007199254740991 OR bet+increment>9007199254740991 THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('schema','smarter-poker.pio-complete-public-state.v1',
  'stack_semantics','solver-effective-behind-at-root','utility',state->'utility',
  'node',p_node->>'node','board',board,'root_board',left(board,6),
  'street',(ARRAY['flop','turn','river'])[stage+1],'acting_solver_player',actor,
  'table_size',c->'table_size','positions',to_jsonb(positions),
  'chips_per_bb',bb,'root_pot_chips',root,'root_behind_chips',jsonb_build_array(stack,stack),
  'pot_chips',pot,'contributions_chips',to_jsonb(contribution),'total_spent_chips',to_jsonb(spent),
  'remaining_chips',jsonb_build_array(stack-spent[1],stack-spent[2]),
  'current_target_chips',bet,'to_call_chips',bet-contribution[actor+1],
  'last_full_raise_increment_chips',increment,'minimum_raise_target_chips',bet+increment,
  'public_history',history);
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_complete_public_state(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_complete_public_state(jsonb) TO service_role;

-- Preserve the exact installed V3 predicate under a private versioned name.
DO $clone$
DECLARE definition text;
BEGIN
 definition:=pg_get_functiondef('public.fn_gto_v31_source_node_valid(jsonb)'::regprocedure);
 IF md5(definition)<>'25b7c968e4d45776486c60564384c96d' THEN
  RAISE EXCEPTION 'V4 admission requires the exact physical-role V3 predicate'; END IF;
 EXECUTE replace(definition,'public.fn_gto_v31_source_node_valid(',
  'public.fn_gto_v31_source_node_v3_valid(');
END;
$clone$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_source_node_v3_valid(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_source_node_v3_valid(jsonb) TO service_role;

CREATE FUNCTION public.fn_gto_v31_source_node_v4_valid(p_node jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $fn$
DECLARE
 projected jsonb; state jsonb:=p_node->'complete_public_state';
 ranges jsonb:=p_node->'solver_ranges'; utility jsonb:=state->'utility';
 model jsonb:=utility->'icm_model'; rake jsonb:=utility->'rake';
 actor text; side text; value numeric; i integer; a integer; b integer;
 board_ids integer[]:=ARRAY[]::integer[]; card text; weight numeric;
BEGIN
 IF p_node IS NULL OR jsonb_typeof(p_node) IS DISTINCT FROM 'object'
 OR (SELECT count(*) FROM jsonb_object_keys(p_node))<>14
 OR NOT (p_node ?& ARRAY['schema','node','node_checksum','node_context','line_proof','action_specs',
 'frequencies','policy_evs_bb','action_evs_bb','matchups','source_combo_order_checksum',
 'range_bundle_checksum','complete_public_state','solver_ranges'])
 OR p_node->>'schema' IS DISTINCT FROM 'smarter-poker.pio-policy.v4'
 OR p_node->>'node_checksum' IS DISTINCT FROM public.fn_gto_v31_node_checksum(p_node)
 OR jsonb_typeof(state) IS DISTINCT FROM 'object'
 OR state IS DISTINCT FROM public.fn_gto_v31_complete_public_state(p_node)
 OR jsonb_typeof(utility) IS DISTINCT FROM 'object'
 OR (SELECT count(*) FROM jsonb_object_keys(utility))<>5
 OR NOT utility ?& ARRAY['objective','utility_context','rake','icm_model_bundle_checksum','icm_model']
 OR utility->'objective' IS DISTINCT FROM p_node#>'{node_context,objective}'
 OR utility->'utility_context' IS DISTINCT FROM p_node#>'{node_context,utility_context}'
 OR jsonb_typeof(utility->'icm_model_bundle_checksum') IS DISTINCT FROM 'string'
 OR COALESCE(utility->>'icm_model_bundle_checksum','') !~ '^[0-9a-f]{64}$'
 OR utility->>'icm_model_bundle_checksum'=repeat('0',64)
 OR jsonb_typeof(ranges) IS DISTINCT FROM 'object'
 OR (SELECT count(*) FROM jsonb_object_keys(ranges))<>3
 OR NOT ranges ?& ARRAY['schema','OOP','IP']
 OR ranges->>'schema' IS DISTINCT FROM 'smarter-poker.pio-exact-node-ranges.v1' THEN RETURN false; END IF;
 IF utility->>'objective'='icm' THEN
  IF rake IS DISTINCT FROM '[0,0]'::jsonb OR jsonb_typeof(model) IS DISTINCT FROM 'object'
  OR (SELECT count(*) FROM jsonb_object_keys(model))<>6
  OR NOT model ?& ARRAY['model_id','source_snapshot_checksum','oop_stack_chips','ip_stack_chips','root_pot_chips','payout_per_chip']
  OR jsonb_typeof(model->'model_id') IS DISTINCT FROM 'string' OR length(model->>'model_id') NOT BETWEEN 1 AND 128
  OR jsonb_typeof(model->'source_snapshot_checksum') IS DISTINCT FROM 'string'
  OR model->>'source_snapshot_checksum' !~ '^[0-9a-f]{64}$'
  OR model->>'source_snapshot_checksum'=repeat('0',64)
  OR NOT public.fn_gto_v31_json_safe_integer(model->'oop_stack_chips',1,9007199254740991)
  OR NOT public.fn_gto_v31_json_safe_integer(model->'ip_stack_chips',1,9007199254740991)
  OR model->'root_pot_chips' IS DISTINCT FROM p_node#>'{line_proof,root_pot_chips}'
  OR jsonb_typeof(model->'payout_per_chip') IS DISTINCT FROM 'number'
  OR (model->>'payout_per_chip')::numeric<=0 THEN RETURN false; END IF;
 ELSE
  IF model IS DISTINCT FROM 'null'::jsonb OR jsonb_typeof(rake) IS DISTINCT FROM 'array'
  OR jsonb_array_length(rake)<>2 OR jsonb_typeof(rake->0) IS DISTINCT FROM 'number'
  OR (rake->>0)::numeric NOT BETWEEN 0 AND 1
  OR NOT public.fn_gto_v31_json_safe_integer(rake->1,0,9007199254740991) THEN RETURN false; END IF;
 END IF;
 projected:=(p_node-'complete_public_state'-'solver_ranges'-'node_checksum')||
  jsonb_build_object('schema','smarter-poker.pio-policy.v3');
 projected:=projected||jsonb_build_object('node_checksum',public.fn_gto_v31_node_checksum(projected));
 IF NOT public.fn_gto_v31_source_node_v3_valid(projected) THEN RETURN false; END IF;
 FOR card IN SELECT substring(p_node#>>'{node_context,board}' FROM k FOR 2)
   FROM generate_series(1,length(p_node#>>'{node_context,board}'),2) k LOOP
  board_ids:=array_append(board_ids,(strpos('23456789TJQKA',left(card,1))-1)*4+strpos('cdhs',right(card,1))-1);
 END LOOP;
 actor:=CASE p_node#>>'{line_proof,hero_solver_player}' WHEN '0' THEN 'OOP' ELSE 'IP' END;
 FOREACH side IN ARRAY ARRAY['OOP','IP'] LOOP
  IF jsonb_typeof(ranges->side) IS DISTINCT FROM 'array' OR jsonb_array_length(ranges->side)<>1326 THEN RETURN false; END IF;
  i:=0;
  FOR b IN 1..51 LOOP FOR a IN 0..b-1 LOOP
   IF jsonb_typeof(ranges->side->i) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
   value:=(ranges->side->>i)::numeric;
   IF value NOT BETWEEN 0 AND 1 OR ((a=ANY(board_ids) OR b=ANY(board_ids)) AND value<>0) THEN RETURN false; END IF;
   weight:=(p_node->'matchups'->>i)::numeric;
   IF side=actor AND weight>0 AND value<=0 THEN RETURN false; END IF;
   i:=i+1;
  END LOOP; END LOOP;
 END LOOP;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_source_node_v4_valid(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_source_node_v4_valid(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_source_node_valid(p_node jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $fn$
BEGIN
 CASE p_node->>'schema'
 WHEN 'smarter-poker.pio-policy.v3' THEN RETURN public.fn_gto_v31_source_node_v3_valid(p_node);
 WHEN 'smarter-poker.pio-policy.v4' THEN RETURN public.fn_gto_v31_source_node_v4_valid(p_node);
 ELSE RETURN false; END CASE;
END;
$fn$;

-- your change here

CREATE FUNCTION public.fn_gto_v31_assert_source_contract(p_node jsonb,p_schema text,p_icm_checksum text)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $fn$
BEGIN
 IF p_schema IS NOT NULL AND p_schema<>'smarter-poker.pio-policy.v4'
 OR p_node->>'schema' IS DISTINCT FROM COALESCE(p_schema,'smarter-poker.pio-policy.v3')
 OR NOT public.fn_gto_v31_physical_positions_valid(p_node)
 OR (p_schema IS NOT NULL AND NOT public.fn_gto_v31_source_node_v4_valid(p_node))
 OR (p_schema IS NOT NULL AND p_node#>>'{complete_public_state,utility,icm_model_bundle_checksum}' IS DISTINCT FROM p_icm_checksum)
 THEN RAISE EXCEPTION 'source node disagrees with immutable dataset policy contract' USING ERRCODE='55000'; END IF;
 RETURN p_node;
END;
$fn$;
REVOKE ALL ON FUNCTION public.fn_gto_v31_assert_source_contract(jsonb,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_assert_source_contract(jsonb,text,text) TO service_role;

CREATE TEMP TABLE v31_v4_preimages ON COMMIT DROP AS
 SELECT oid,oid::regprocedure::text signature,pg_get_functiondef(oid) definition,
 proowner,proacl,proconfig,prosecdef FROM pg_proc WHERE oid IN
 ('public.fn_gto_v31_ingest_source_artifact(uuid,text,jsonb)'::regprocedure,
 'public.fn_gto_v31_build_cell(uuid,jsonb)'::regprocedure,
 'public.fn_gto_v31_heldout_metrics(uuid,text)'::regprocedure,
 'public.fn_gto_v31_seal_build(uuid)'::regprocedure,
 'public.fn_gto_v31_cell_key_checksum(jsonb)'::regprocedure,
 'public.fn_gto_v31_promote_dataset(uuid)'::regprocedure);

CREATE FUNCTION pg_temp.v31_v4_replace(p_definition text,p_anchor text,p_replacement text)
RETURNS text LANGUAGE plpgsql AS $fn$
BEGIN
 IF (length(p_definition)-length(replace(p_definition,p_anchor,'')))/length(p_anchor)<>1 THEN
  RAISE EXCEPTION 'V4 exact source anchor differs: %',p_anchor; END IF;
 RETURN replace(p_definition,p_anchor,p_replacement);
END;
$fn$;

CREATE FUNCTION pg_temp.v31_v4_patch(p_signature text,p_definition text)
RETURNS text LANGUAGE plpgsql AS $fn$
DECLARE result text:=p_definition; anchor text;
BEGIN
 CASE p_signature
 WHEN 'fn_gto_v31_ingest_source_artifact(uuid,text,jsonb)' THEN
  anchor:='    IF NOT public.fn_gto_v31_source_node_valid(v_node)';
  result:=pg_temp.v31_v4_replace(result,anchor,$sql$    IF jsonb_typeof(v_node)='object'
       AND v_node->>'schema'='smarter-poker.pio-policy.v4'
       AND (SELECT count(*) FROM jsonb_object_keys(v_node))=13
       AND NOT (v_node?'node_checksum')
       AND v_node ?& ARRAY['schema','node','node_context','line_proof','action_specs',
         'frequencies','policy_evs_bb','action_evs_bb','matchups',
         'source_combo_order_checksum','range_bundle_checksum','complete_public_state','solver_ranges'] THEN
      v_node:=v_node||jsonb_build_object('node_checksum',public.fn_gto_v31_node_checksum(v_node));
    END IF;
    PERFORM public.fn_gto_v31_assert_source_contract(v_node,v_dataset.policy_export_schema,v_dataset.icm_model_checksum);
    IF NOT public.fn_gto_v31_source_node_valid(v_node)$sql$);
 WHEN 'fn_gto_v31_build_cell(uuid,jsonb)' THEN
  anchor:='public.fn_gto_v31_assert_physical_positions(n.value->''node'')';
 result:=pg_temp.v31_v4_replace(result,anchor,
   'public.fn_gto_v31_assert_source_contract(n.value->''node'',v_dataset.policy_export_schema,v_dataset.icm_model_checksum)');
  anchor:='public.fn_gto_v31_feature_identity(v_dataset.feature_contract_version)||jsonb_build_object(';
  result:=pg_temp.v31_v4_replace(result,anchor,
   'public.fn_gto_v31_feature_identity(v_dataset.feature_contract_version)||public.fn_gto_v31_policy_identity(v_dataset.policy_export_schema)||jsonb_build_object(');
  result:=pg_temp.v31_v4_replace(result,'lineage_checksum,feature_contract_version',
   'lineage_checksum,feature_contract_version,policy_export_schema');
  result:=pg_temp.v31_v4_replace(result,'v_cell->>''lineage_checksum'',v_dataset.feature_contract_version',
   'v_cell->>''lineage_checksum'',v_dataset.feature_contract_version,v_dataset.policy_export_schema');
 WHEN 'fn_gto_v31_heldout_metrics(uuid,text)' THEN
  anchor:='public.fn_gto_v31_assert_physical_positions(n.value) AS node';
  result:=pg_temp.v31_v4_replace(result,anchor,$sql$public.fn_gto_v31_assert_source_contract(n.value,
           (SELECT d.policy_export_schema FROM public.gto_v31_datasets d WHERE d.dataset_id=p_dataset_id),
           (SELECT d.icm_model_checksum FROM public.gto_v31_datasets d WHERE d.dataset_id=p_dataset_id)) AS node$sql$);
 WHEN 'fn_gto_v31_seal_build(uuid)' THEN
  anchor:='public.fn_gto_v31_assert_physical_positions(n.value)';
  result:=pg_temp.v31_v4_replace(result,anchor,
   'public.fn_gto_v31_assert_source_contract(n.value,v_dataset.policy_export_schema,v_dataset.icm_model_checksum)');
  anchor:='CASE WHEN v_dataset.feature_contract_version IS NULL THEN '''' ELSE v_dataset.feature_contract_version||'':'' END';
  result:=pg_temp.v31_v4_replace(result,anchor,
   anchor||'||CASE WHEN v_dataset.policy_export_schema IS NULL THEN '''' ELSE v_dataset.policy_export_schema||'':'' END');
 WHEN 'fn_gto_v31_promote_dataset(uuid)' THEN
  anchor:='CASE WHEN v_dataset.feature_contract_version IS NULL THEN '''' ELSE v_dataset.feature_contract_version||'':'' END';
  result:=pg_temp.v31_v4_replace(result,anchor,
   anchor||'||CASE WHEN v_dataset.policy_export_schema IS NULL THEN '''' ELSE v_dataset.policy_export_schema||'':'' END');
 WHEN 'fn_gto_v31_cell_key_checksum(jsonb)' THEN
  anchor:='public.fn_gto_v31_feature_identity(p_cell->>''feature_contract_version'')';
  result:=pg_temp.v31_v4_replace(result,anchor,anchor||'||public.fn_gto_v31_policy_identity(p_cell->>''policy_export_schema'')');
 ELSE RAISE EXCEPTION 'unknown V4 source patch'; END CASE;
 IF p_signature IN ('fn_gto_v31_seal_build(uuid)','fn_gto_v31_promote_dataset(uuid)') THEN
  anchor:='c.feature_contract_version IS DISTINCT FROM v_dataset.feature_contract_version) THEN';
  result:=pg_temp.v31_v4_replace(result,anchor,
   'c.feature_contract_version IS DISTINCT FROM v_dataset.feature_contract_version OR c.policy_export_schema IS DISTINCT FROM v_dataset.policy_export_schema) THEN');
 END IF;
 RETURN result;
END;
$fn$;

DO $install$
DECLARE r record; expected text;
BEGIN
 IF (SELECT count(*) FROM v31_v4_preimages)<>6 THEN RAISE EXCEPTION 'V4 source owner signatures missing'; END IF;
 FOR r IN SELECT * FROM v31_v4_preimages LOOP
  expected:=CASE r.signature
   WHEN 'fn_gto_v31_cell_key_checksum(jsonb)' THEN '5a615f7751b42cb5c8a4e3c7e68cdd2b'
   WHEN 'fn_gto_v31_ingest_source_artifact(uuid,text,jsonb)' THEN 'b03a99ee2ae9bab5369573742c4f7f4b'
   WHEN 'fn_gto_v31_build_cell(uuid,jsonb)' THEN '0eb032c2971a6339f3bf25053eb765d2'
   WHEN 'fn_gto_v31_heldout_metrics(uuid,text)' THEN '3536decd52bc0b53775690f1e43e0b49'
   WHEN 'fn_gto_v31_seal_build(uuid)' THEN '282e711753e111e23b03f8dc6cfdd7b3'
   WHEN 'fn_gto_v31_promote_dataset(uuid)' THEN '478cd8df8870cd77e00c96ccaf3bb508' END;
  IF md5(r.definition) IS DISTINCT FROM expected THEN RAISE EXCEPTION 'V4 preimage differs: %',r.signature; END IF;
  RAISE NOTICE 'V31_V4_PREIMAGE % %',r.signature,md5(r.definition);
  EXECUTE pg_temp.v31_v4_patch(r.signature,r.definition);
 END LOOP;
END;
$install$;

DO $post$
DECLARE r record;
BEGIN
 FOR r IN SELECT * FROM v31_v4_preimages LOOP
  RAISE NOTICE 'V31_V4_POSTIMAGE % %',r.signature,md5(pg_get_functiondef(r.oid));
  IF pg_get_functiondef(r.oid) IS DISTINCT FROM pg_temp.v31_v4_patch(r.signature,r.definition)
  OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=r.oid AND p.proowner=r.proowner
    AND p.proacl IS NOT DISTINCT FROM r.proacl AND p.proconfig IS NOT DISTINCT FROM r.proconfig
    AND p.prosecdef=r.prosecdef) THEN RAISE EXCEPTION 'V4 source postimage/ACL mismatch'; END IF;
 END LOOP;
 IF md5(replace(pg_get_functiondef('public.fn_gto_v31_source_node_v3_valid(jsonb)'::regprocedure),
  'public.fn_gto_v31_source_node_v3_valid(','public.fn_gto_v31_source_node_valid('))
  IS DISTINCT FROM '25b7c968e4d45776486c60564384c96d'
  OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_gto_v31_source_node_v3_valid(jsonb)'::regprocedure
   AND proconfig @> ARRAY['search_path=public'] AND NOT prosecdef) THEN
   RAISE EXCEPTION 'V3 private predicate exact bytes/config changed'; END IF;
END;
$post$;

COMMIT;

-- @live-proof: md5(pg_get_functiondef('public.fn_gto_v31_cell_key_checksum(jsonb)'::regprocedure)) = 'f792e7ea0d7c1e745a91090232431912'
-- @live-proof: md5(pg_get_functiondef('public.fn_gto_v31_ingest_source_artifact(uuid,text,jsonb)'::regprocedure)) = '2aca57b64e932f3c63fde8a8e421c9f3'
-- @live-proof: md5(pg_get_functiondef('public.fn_gto_v31_build_cell(uuid,jsonb)'::regprocedure)) = '0cce33869507f52e2c4153099e3cdbcf'
-- @live-proof: md5(pg_get_functiondef('public.fn_gto_v31_heldout_metrics(uuid,text)'::regprocedure)) = '175142d5874201c25319cb4155a6aa1a'
-- @live-proof: md5(pg_get_functiondef('public.fn_gto_v31_seal_build(uuid)'::regprocedure)) = '07add58bf732501c8d8d37121d40890e'
-- @live-proof: md5(pg_get_functiondef('public.fn_gto_v31_promote_dataset(uuid)'::regprocedure)) = 'e8c13cfcebd14832f3bc6e68f145b1cc'
-- @live-proof: md5(pg_get_functiondef('public.fn_gto_v31_source_node_valid(jsonb)'::regprocedure)) = '35394efc3321b593ee1b2da1d17fa5a9'
-- @live-proof: md5(pg_get_functiondef('public.fn_gto_v31_source_node_v3_valid(jsonb)'::regprocedure)) = 'c164d9ef0bbc981a072296d71382f02e'
-- @live-proof: md5(pg_get_functiondef('public.fn_gto_v31_source_node_v4_valid(jsonb)'::regprocedure)) = 'dbf093b7fb87b86d756464ba3531085e'
-- @live-proof: md5(pg_get_functiondef('public.fn_gto_v31_complete_public_state(jsonb)'::regprocedure)) = '7696a9230d4681ff75dd203d33140381'
-- @live-proof: md5(pg_get_functiondef('public.fn_gto_v31_assert_source_contract(jsonb,text,text)'::regprocedure)) = '69ea62a35a05157f32c372c173d4d584'
