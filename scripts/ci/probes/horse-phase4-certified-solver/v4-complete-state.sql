\set ON_ERROR_STOP on
-- Isolated fixture only. It consumes an independently valid V3 node and
-- constructs the known root-state expectation without calling reconstruction.
CREATE FUNCTION public.v31_v4_probe(base jsonb,artifact jsonb,legacy_dataset uuid)
RETURNS void LANGUAGE plpgsql AS $probe$
DECLARE
 node jsonb; state jsonb; ranges jsonb; weights jsonb; candidate jsonb;
 key text; bad jsonb; old_hash text; bundle_payload jsonb; declaration jsonb;
 bundle uuid; dataset uuid; checksum text; admitted jsonb; failed boolean;
BEGIN
 IF base->>'node'<>'r:0' OR base#>>'{node_context,table_size}'<>'2' THEN RETURN; END IF;
 old_hash:=public.fn_gto_v31_node_checksum(base);
 state:=jsonb_build_object('schema','smarter-poker.pio-complete-public-state.v1',
  'stack_semantics','solver-effective-behind-at-root',
  'utility',jsonb_build_object('objective','cash_ev','utility_context','cash_ev',
   'rake',jsonb_build_array(0,0),'icm_model_bundle_checksum',repeat('f',64),'icm_model',NULL),
  'node','r:0','board','AsKd7c','root_board','AsKd7c','street','flop',
  'acting_solver_player',0,'table_size',2,'positions',jsonb_build_array('BB','SB'),
  'chips_per_bb',100,'root_pot_chips',1000,'root_behind_chips',jsonb_build_array(8000,8000),
  'pot_chips',1000,'contributions_chips',jsonb_build_array(0,0),
  'total_spent_chips',jsonb_build_array(0,0),'remaining_chips',jsonb_build_array(8000,8000),
  'current_target_chips',0,'to_call_chips',0,'last_full_raise_increment_chips',100,
  'minimum_raise_target_chips',100,'public_history','[]'::jsonb);
 SELECT jsonb_agg(CASE WHEN (base->'matchups'->>i)::numeric>0 THEN 1 ELSE 0 END ORDER BY i)
 INTO weights FROM generate_series(0,1325) i;
 ranges:=jsonb_build_object('schema','smarter-poker.pio-exact-node-ranges.v1','OOP',weights,'IP',weights);
 node:=(base-'node_checksum')||jsonb_build_object('schema','smarter-poker.pio-policy.v4',
  'complete_public_state',state,'solver_ranges',ranges);
 node:=node||jsonb_build_object('node_checksum',public.fn_gto_v31_node_checksum(node));
 IF public.fn_gto_v31_complete_public_state(node) IS DISTINCT FROM state
 OR NOT public.fn_gto_v31_source_node_valid(node) THEN RAISE EXCEPTION 'valid reconstructed V4 root rejected'; END IF;
 -- Independent wager expectation: 100 paid once, IP owes 100, full raise to
 -- 200. Do not derive these expectations with the implementation under test.
 bad:=jsonb_set(node,'{node}','"r:0:b100"');
 bad:=jsonb_set(bad,'{line_proof,hero_solver_player}','1');
 bad:=jsonb_set(bad,'{node_context,hero_position}','"SB"');
 bad:=jsonb_set(bad,'{node_context,opponent_position}','"BB"');
 candidate:=state||jsonb_build_object('node','r:0:b100','acting_solver_player',1,
  'pot_chips',1100,'contributions_chips',jsonb_build_array(100,0),
  'total_spent_chips',jsonb_build_array(100,0),'remaining_chips',jsonb_build_array(7900,8000),
  'current_target_chips',100,'to_call_chips',100,'minimum_raise_target_chips',200,
  'public_history',jsonb_build_array(jsonb_build_object('street','flop','solver_player',0,
   'position','BB','family','bet','target_chips',100)));
 IF public.fn_gto_v31_complete_public_state(bad) IS DISTINCT FROM candidate THEN
  RAISE EXCEPTION 'independent wager reconstruction differs'; END IF;
 bad:=jsonb_set(bad,'{node}','"r:0:b50"');
 IF public.fn_gto_v31_complete_public_state(bad) IS NOT NULL THEN
  RAISE EXCEPTION 'under-minimum non-all-in wager accepted'; END IF;
 bad:=jsonb_set(node,'{node}','"r:0:c:c:2h"');
 bad:=jsonb_set(bad,'{node_context,board}','"AsKd7c2h"');
 candidate:=state||jsonb_build_object('node','r:0:c:c:2h','board','AsKd7c2h','street','turn',
  'public_history',jsonb_build_array(
   jsonb_build_object('street','flop','solver_player',0,'position','BB','family','check','target_chips',0),
   jsonb_build_object('street','flop','solver_player',1,'position','SB','family','check','target_chips',0)));
 IF public.fn_gto_v31_complete_public_state(bad) IS DISTINCT FROM candidate THEN
  RAISE EXCEPTION 'independent closed-street reconstruction differs'; END IF;
 FOREACH key IN ARRAY ARRAY['pot_chips','acting_solver_player','minimum_raise_target_chips',
   'last_full_raise_increment_chips','to_call_chips','table_size'] LOOP
  bad:=jsonb_set(node,ARRAY['complete_public_state',key],'999'::jsonb);
  bad:=jsonb_set(bad,'{node_checksum}',to_jsonb(public.fn_gto_v31_node_checksum(bad)));
  IF public.fn_gto_v31_source_node_valid(bad) THEN RAISE EXCEPTION 'forged V4 % accepted',key; END IF;
 END LOOP;
 FOREACH bad IN ARRAY ARRAY[
  jsonb_set(node,'{complete_public_state,public_history}','[{"family":"check"}]'),
  jsonb_set(node,'{complete_public_state,positions}','["SB","BB"]'),
  jsonb_set(node,'{complete_public_state,board}','"AsKd8c"'),
  jsonb_set(node,'{solver_ranges,OOP}','[]'),
  jsonb_set(node,'{solver_ranges,IP,0}','1.1'),
  jsonb_set(node,'{solver_ranges,IP,1275}','1'),
  jsonb_set(node,'{solver_ranges,OOP,0}','"0"'),
  jsonb_set(node,'{solver_ranges,schema}','"unknown"'),
  jsonb_set(node,'{complete_public_state,utility,icm_model_bundle_checksum}','"unknown"'),
  jsonb_set(node,'{complete_public_state,utility,objective}','"icm"')
 ] LOOP
  bad:=jsonb_set(bad,'{node_checksum}',to_jsonb(public.fn_gto_v31_node_checksum(bad)));
  IF public.fn_gto_v31_source_node_valid(bad) THEN RAISE EXCEPTION 'malformed V4 state/range accepted'; END IF;
 END LOOP;
 SELECT jsonb_set(node,ARRAY['solver_ranges','OOP',i::text],'0') INTO bad
 FROM generate_series(0,1325) i WHERE (base->'matchups'->>i)::numeric>0 LIMIT 1;
 bad:=jsonb_set(bad,'{node_checksum}',to_jsonb(public.fn_gto_v31_node_checksum(bad)));
 IF public.fn_gto_v31_source_node_valid(bad) THEN RAISE EXCEPTION 'positive matchup with zero actor reach accepted'; END IF;
 IF public.fn_gto_v31_source_node_valid(jsonb_set(node,'{node_checksum}',to_jsonb(repeat('0',64)))) THEN
  RAISE EXCEPTION 'forged V4 checksum accepted'; END IF;
 bad:=jsonb_set(node,'{node_context,game_family}','"tourney_icm"');
 bad:=jsonb_set(bad,'{node_context,objective}','"icm"');
 bad:=jsonb_set(bad,'{node_context,utility_context}','"satellite"');
 bad:=jsonb_set(bad,'{complete_public_state,utility}',jsonb_build_object(
  'objective','icm','utility_context','satellite','rake',jsonb_build_array(0,0),
  'icm_model_bundle_checksum',repeat('f',64),'icm_model',jsonb_build_object(
   'model_id','independent.fixture','source_snapshot_checksum',repeat('9',64),
   'oop_stack_chips',9000,'ip_stack_chips',9000,'root_pot_chips',1000,'payout_per_chip',0.5)));
 bad:=jsonb_set(bad,'{node_checksum}',to_jsonb(public.fn_gto_v31_node_checksum(bad)));
 IF NOT public.fn_gto_v31_source_node_valid(bad) THEN RAISE EXCEPTION 'valid numerical ICM V4 rejected'; END IF;
 bad:=jsonb_set(bad,'{complete_public_state,utility,icm_model,payout_per_chip}','0');
 bad:=jsonb_set(bad,'{node_checksum}',to_jsonb(public.fn_gto_v31_node_checksum(bad)));
 IF public.fn_gto_v31_source_node_valid(bad) THEN RAISE EXCEPTION 'zero utility conversion accepted'; END IF;
 failed:=false;
 BEGIN PERFORM public.fn_gto_v31_assert_source_contract(node,NULL,repeat('f',64));
 EXCEPTION WHEN SQLSTATE '55000' THEN failed:=true; END;
 IF NOT failed THEN RAISE EXCEPTION 'V4 node accepted by V3 dataset'; END IF;
 failed:=false;
 BEGIN PERFORM public.fn_gto_v31_assert_source_contract(node,'smarter-poker.pio-policy.v4',repeat('a',64));
 EXCEPTION WHEN SQLSTATE '55000' THEN failed:=true; END;
 IF NOT failed THEN RAISE EXCEPTION 'cross-ICM bundle accepted'; END IF;
 SELECT b.bundle_manifest||jsonb_build_object('bundle_key','v4.complete-state.fixture',
  'policy_export_schema','smarter-poker.pio-policy.v4') INTO bundle_payload
 FROM public.gto_v31_datasets d JOIN public.gto_v31_input_bundles b USING(input_bundle_id)
 WHERE d.dataset_id=legacy_dataset;
 CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $auth$ SELECT 'authenticated'::text $auth$;
 bundle:=public.ca_gto_v31_approve_input_bundle(bundle_payload);
 SELECT b.bundle_checksum INTO checksum FROM public.gto_v31_input_bundles b WHERE b.input_bundle_id=bundle;
 CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $auth$ SELECT 'service_role'::text $auth$;
 SELECT jsonb_build_object('dataset_key','v4.complete-state.fixture','solver_version',d.solver_version,
  'solver_binary_checksum',d.solver_binary_checksum,'pipeline_commit',d.pipeline_commit,
  'pipeline_bundle_checksum',d.pipeline_bundle_checksum,'manifest_version',d.manifest_version,
  'manifest_checksum',d.manifest_checksum,'source_combo_order_checksum',d.source_combo_order_checksum,
  'range_bundle_checksum',d.range_bundle_checksum,'icm_model_checksum',d.icm_model_checksum,
  'input_bundle_id',bundle,'input_bundle_checksum',checksum,'machine_ids',to_jsonb(d.machine_ids),
  'declared_coverage',d.declared_coverage,'quality_gates',d.quality_gates,
  'policy_export_schema','smarter-poker.pio-policy.v4') INTO declaration
 FROM public.gto_v31_datasets d WHERE d.dataset_id=legacy_dataset;
 dataset:=public.fn_gto_v31_register_dataset(declaration);
 candidate:=artifact||jsonb_build_object('id','fab00000-0000-4000-8000-000000000001',
  'strategy_matrix_v2',(artifact->'strategy_matrix_v2')||jsonb_build_object('nodes',jsonb_build_array(node-'node_checksum')));
 admitted:=public.fn_gto_v31_ingest_source_artifact(dataset,'M1',candidate);
 IF NOT EXISTS(SELECT 1 FROM public.gto_v31_source_artifacts WHERE dataset_id=dataset AND node_count=1)
 OR NOT EXISTS(SELECT 1 FROM public.solved_spots_gold WHERE id='fab00000-0000-4000-8000-000000000001'
 AND strategy_matrix_v2#>>'{nodes,0,node_checksum}'=node->>'node_checksum') THEN
  RAISE EXCEPTION 'V4 admission did not persist canonical signed-content checksum'; END IF;
 failed:=false;
 BEGIN PERFORM public.fn_gto_v31_ingest_source_artifact(dataset,'M1',artifact);
 EXCEPTION WHEN SQLSTATE '55000' THEN failed:=true; END;
 IF NOT failed THEN RAISE EXCEPTION 'V3 artifact accepted by V4 dataset'; END IF;
 IF public.fn_gto_v31_node_checksum(base)<>old_hash OR NOT public.fn_gto_v31_source_node_valid(base) THEN
  RAISE EXCEPTION 'V3 bytes or predicate changed'; END IF;
 -- All fixture writes share the enclosing V3 behavior transaction and rollback.
 DELETE FROM public.gto_v31_source_artifacts WHERE dataset_id=dataset;
 DELETE FROM public.gto_v31_datasets WHERE dataset_id=dataset;
 DELETE FROM public.gto_v31_input_bundles WHERE input_bundle_id=bundle;
 DELETE FROM public.solved_spots_gold WHERE id='fab00000-0000-4000-8000-000000000001';
 RAISE NOTICE 'V31_V4_COMPLETE_STATE_ADMISSION_OK';
END;
$probe$;
