-- 20260908201749_the_solver_holdout_must_change_board_ranks
--
-- The first holdout gate rejected only byte-identical board strings. A board
-- with the same ranks and permuted suits (or reordered flop cards) is the same
-- game tree under suit isomorphism, so it does not test whether a texture-level
-- compact cell generalizes to an unseen board. The committed fixture itself
-- demonstrated this gap by using AK7 rainbow on both M1 and M2.
--
-- This migration gives boards a suit-agnostic, flop-order-agnostic rank-runout
-- signature and refuses a compact cell when the M1 and M2 signatures overlap.
-- Turn and river ranks remain ordered because they identify different streets.
-- No active V31 dataset exists, so no published policy is reclassified.

CREATE OR REPLACE FUNCTION public.fn_gto_v31_board_rank_signature(p_board text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = public
AS $fn$
DECLARE
  v_ranks constant text := '23456789TJQKA';
  v_cards integer := length(p_board)/2;
  v_seen text[] := ARRAY[]::text[];
  v_card text;
  v_flop text;
  v_runout text := '';
  v_i integer;
BEGIN
  IF length(p_board) NOT IN (6,8,10)
     OR p_board !~ '^([2-9TJQKA][cdhs]){3,5}$' THEN
    RETURN NULL;
  END IF;
  FOR v_i IN 0..v_cards-1 LOOP
    v_card:=substr(p_board,v_i*2+1,2);
    IF v_card=ANY(v_seen) THEN RETURN NULL; END IF;
    v_seen:=array_append(v_seen,v_card);
  END LOOP;
  SELECT string_agg(substr(p_board,n,1),'' ORDER BY position(substr(p_board,n,1) IN v_ranks),n)
    INTO v_flop
    FROM unnest(ARRAY[1,3,5]) n;
  IF v_cards>=4 THEN v_runout:=substr(p_board,7,1); END IF;
  IF v_cards=5 THEN v_runout:=v_runout||substr(p_board,9,1); END IF;
  RETURN v_cards::text||':'||v_flop||':'||v_runout;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_board_rank_signature(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_board_rank_signature(text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_build_cell(
  p_dataset_id uuid,
  p_context jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_dataset public.gto_v31_datasets%ROWTYPE;
  v_source_rows integer;
  v_train_rows integer;
  v_holdout_rows integer;
  v_spec_variants integer;
  v_machine_variants integer;
  v_cross_split_board_overlaps integer;
  v_specs jsonb;
  v_hand_matrix jsonb;
  v_policy_evs jsonb;
  v_action_evs jsonb;
  v_lineage text;
  v_cell jsonb;
  v_existing_checksum text;
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  SELECT * INTO v_dataset FROM public.gto_v31_datasets
   WHERE dataset_id=p_dataset_id AND state='building' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dataset is not building'; END IF;
  IF p_context IS NULL OR jsonb_typeof(p_context)<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_context))<>13
     OR NOT (p_context ?& ARRAY['street','game_family','objective','utility_context',
       'table_size','pot_type','hero_position','opponent_position','depth_bucket',
       'texture_class','node_role','facing_kind','facing_size_bucket']) THEN
    RAISE EXCEPTION 'compact cell context is invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_dataset.declared_coverage) d(value)
    WHERE d.value=p_context) THEN
    RAISE EXCEPTION 'compact cell is not in declared coverage';
  END IF;
  SELECT c.cell_key_checksum INTO v_existing_checksum
    FROM public.gto_v31_runtime_cells c
   WHERE c.dataset_id=p_dataset_id
     AND c.street=p_context->>'street'
     AND c.game_family=p_context->>'game_family'
     AND c.objective=p_context->>'objective'
     AND c.utility_context=p_context->>'utility_context'
     AND c.table_size=(p_context->>'table_size')::smallint
     AND c.pot_type=p_context->>'pot_type'
     AND c.hero_position=p_context->>'hero_position'
     AND c.opponent_position=p_context->>'opponent_position'
     AND c.depth_bucket=(p_context->>'depth_bucket')::integer
     AND c.texture_class=p_context->>'texture_class'
     AND c.node_role=p_context->>'node_role'
     AND c.facing_kind=p_context->>'facing_kind'
     AND c.facing_size_bucket=p_context->>'facing_size_bucket';
  IF v_existing_checksum IS NOT NULL THEN RETURN v_existing_checksum; END IF;

  WITH source_nodes AS MATERIALIZED (
    SELECT a.source_row_id,a.machine_id,a.source_artifact_checksum,n.value AS node,
           CASE WHEN a.machine_id='M2' THEN 'holdout' ELSE 'train' END AS split
      FROM public.gto_v31_source_artifacts a
      JOIN public.solved_spots_gold s ON s.id=a.source_row_id
       AND s.quality_status='validated' AND s.audited_at IS NOT NULL
       AND s.source_artifact_checksum=a.source_artifact_checksum
       AND s.source_artifact_checksum=public.fn_gto_v31_source_artifact_checksum(s.scenario_hash,s.strategy_matrix_v2)
      CROSS JOIN LATERAL jsonb_array_elements(s.strategy_matrix_v2->'nodes') n(value)
     WHERE a.dataset_id=p_dataset_id
       AND n.value#>>'{node_context,street}'=p_context->>'street'
       AND n.value#>>'{node_context,game_family}'=p_context->>'game_family'
       AND n.value#>>'{node_context,objective}'=p_context->>'objective'
       AND n.value#>>'{node_context,utility_context}'=p_context->>'utility_context'
       AND (n.value#>>'{node_context,table_size}')::integer=(p_context->>'table_size')::integer
       AND n.value#>>'{node_context,pot_type}'=p_context->>'pot_type'
       AND n.value#>>'{node_context,hero_position}'=p_context->>'hero_position'
       AND n.value#>>'{node_context,opponent_position}'=p_context->>'opponent_position'
       AND (n.value#>>'{node_context,depth_bucket}')::integer=(p_context->>'depth_bucket')::integer
       AND n.value#>>'{node_context,texture_class}'=p_context->>'texture_class'
       AND n.value#>>'{node_context,node_role}'=p_context->>'node_role'
       AND n.value#>>'{node_context,facing_kind}'=p_context->>'facing_kind'
       AND n.value#>>'{node_context,facing_size_bucket}'=p_context->>'facing_size_bucket'
  )
  SELECT count(*),count(*) FILTER (WHERE split='train'),count(*) FILTER (WHERE split='holdout'),
         count(DISTINCT node->'action_specs'),count(DISTINCT machine_id),
         (SELECT count(*) FROM source_nodes train
           JOIN source_nodes holdout
             ON public.fn_gto_v31_board_rank_signature(holdout.node#>>'{node_context,board}')=
                public.fn_gto_v31_board_rank_signature(train.node#>>'{node_context,board}')
          WHERE train.split='train' AND holdout.split='holdout'),
         (array_agg(node->'action_specs'))[1],
         encode(digest(string_agg(source_row_id::text||':'||(node->>'node')||':'||
           (node->>'node_checksum'),'' ORDER BY source_row_id::text,node->>'node'),'sha256'),'hex')
    INTO v_source_rows,v_train_rows,v_holdout_rows,v_spec_variants,v_machine_variants,
         v_cross_split_board_overlaps,v_specs,v_lineage
    FROM source_nodes;
  IF v_source_rows<2 OR v_train_rows<1 OR v_holdout_rows<1 OR v_spec_variants<>1
     OR v_machine_variants<>2 OR v_cross_split_board_overlaps<>0
     OR v_specs IS NULL OR v_lineage IS NULL THEN
    RAISE EXCEPTION 'cell needs M1 and M2, one action topology, and rank-disjoint train and holdout sources';
  END IF;

  WITH source_nodes AS MATERIALIZED (
    SELECT n.value AS node,
           CASE WHEN a.machine_id='M2' THEN 'holdout' ELSE 'train' END AS split
      FROM public.gto_v31_source_artifacts a
      JOIN public.solved_spots_gold s ON s.id=a.source_row_id
       AND s.quality_status='validated' AND s.audited_at IS NOT NULL
       AND s.source_artifact_checksum=a.source_artifact_checksum
       AND s.source_artifact_checksum=public.fn_gto_v31_source_artifact_checksum(s.scenario_hash,s.strategy_matrix_v2)
      CROSS JOIN LATERAL jsonb_array_elements(s.strategy_matrix_v2->'nodes') n(value)
     WHERE a.dataset_id=p_dataset_id
       AND n.value#>>'{node_context,street}'=p_context->>'street'
       AND n.value#>>'{node_context,game_family}'=p_context->>'game_family'
       AND n.value#>>'{node_context,objective}'=p_context->>'objective'
       AND n.value#>>'{node_context,utility_context}'=p_context->>'utility_context'
       AND (n.value#>>'{node_context,table_size}')::integer=(p_context->>'table_size')::integer
       AND n.value#>>'{node_context,pot_type}'=p_context->>'pot_type'
       AND n.value#>>'{node_context,hero_position}'=p_context->>'hero_position'
       AND n.value#>>'{node_context,opponent_position}'=p_context->>'opponent_position'
       AND (n.value#>>'{node_context,depth_bucket}')::integer=(p_context->>'depth_bucket')::integer
       AND n.value#>>'{node_context,texture_class}'=p_context->>'texture_class'
       AND n.value#>>'{node_context,node_role}'=p_context->>'node_role'
       AND n.value#>>'{node_context,facing_kind}'=p_context->>'facing_kind'
       AND n.value#>>'{node_context,facing_size_bucket}'=p_context->>'facing_size_bucket'
  ), combo_observations AS MATERIALIZED (
    SELECT public.fn_gto_v31_hand_key(i,n.node#>>'{node_context,board}') AS hand_key,
           i,(n.node->'matchups'->>i)::numeric AS weight,
           (n.node->'policy_evs_bb'->>i)::numeric AS policy_ev,n.node
      FROM source_nodes n CROSS JOIN generate_series(0,1325) i
     WHERE n.split='train' AND (n.node->'matchups'->>i)::numeric>0
  ), action_observations AS MATERIALIZED (
    SELECT o.hand_key,a.key AS action_id,o.weight,
           (o.node->'frequencies'->a.key->>o.i)::numeric AS frequency,
           (o.node->'action_evs_bb'->a.key->>o.i)::numeric AS action_ev
      FROM combo_observations o CROSS JOIN LATERAL jsonb_each(v_specs) a
  ), action_aggregate AS (
    SELECT hand_key,action_id,
           sum(frequency*weight)/sum(weight) AS frequency,
           sum(action_ev*weight)/sum(weight) AS action_ev
      FROM action_observations GROUP BY hand_key,action_id
  ), per_hand AS (
    SELECT hand_key,
           jsonb_object_agg(action_id,to_jsonb(round(frequency,6)) ORDER BY action_id) AS mix,
           jsonb_object_agg(action_id,to_jsonb(round(action_ev,6)) ORDER BY action_id) AS action_evs
      FROM action_aggregate GROUP BY hand_key
  ), policy_aggregate AS (
    SELECT hand_key,sum(policy_ev*weight)/sum(weight) AS policy_ev
      FROM combo_observations GROUP BY hand_key
  )
  SELECT jsonb_object_agg(h.hand_key,h.mix ORDER BY h.hand_key),
         jsonb_object_agg(h.hand_key,to_jsonb(round(p.policy_ev,6)) ORDER BY h.hand_key),
         jsonb_object_agg(h.hand_key,h.action_evs ORDER BY h.hand_key)
    INTO v_hand_matrix,v_policy_evs,v_action_evs
    FROM per_hand h JOIN policy_aggregate p USING (hand_key);
  IF v_hand_matrix IS NULL OR v_policy_evs IS NULL OR v_action_evs IS NULL THEN
    RAISE EXCEPTION 'cell has no live training combinations';
  END IF;

  v_cell:=p_context||jsonb_build_object(
    'hand_matrix',v_hand_matrix,'action_specs',v_specs,
    'policy_ev_matrix',v_policy_evs,'action_ev_matrix',v_action_evs,
    'source_rows',v_source_rows,'train_source_rows',v_train_rows,
    'holdout_source_rows',v_holdout_rows,'lineage_checksum',v_lineage
  );
  v_cell:=v_cell||jsonb_build_object('cell_key_checksum',public.fn_gto_v31_cell_key_checksum(v_cell));
  v_cell:=v_cell||jsonb_build_object('cell_payload_checksum',public.fn_gto_v31_cell_payload_checksum(v_cell));
  IF NOT public.fn_gto_v31_cell_payload_valid(v_cell) THEN
    RAISE EXCEPTION 'database-computed compact cell failed its release validator';
  END IF;

  INSERT INTO public.gto_v31_runtime_cells (
    dataset_id,cell_key_checksum,street,game_family,objective,utility_context,
    table_size,pot_type,hero_position,opponent_position,depth_bucket,texture_class,
    node_role,facing_kind,facing_size_bucket,hand_matrix,action_specs,
    policy_ev_matrix,action_ev_matrix,source_rows,train_source_rows,
    holdout_source_rows,cell_payload_checksum,lineage_checksum
  ) VALUES (
    p_dataset_id,v_cell->>'cell_key_checksum',v_cell->>'street',v_cell->>'game_family',
    v_cell->>'objective',v_cell->>'utility_context',(v_cell->>'table_size')::smallint,
    v_cell->>'pot_type',v_cell->>'hero_position',v_cell->>'opponent_position',
    (v_cell->>'depth_bucket')::integer,v_cell->>'texture_class',v_cell->>'node_role',
    v_cell->>'facing_kind',v_cell->>'facing_size_bucket',v_cell->'hand_matrix',
    v_cell->'action_specs',v_cell->'policy_ev_matrix',v_cell->'action_ev_matrix',
    (v_cell->>'source_rows')::integer,(v_cell->>'train_source_rows')::integer,
    (v_cell->>'holdout_source_rows')::integer,v_cell->>'cell_payload_checksum',v_cell->>'lineage_checksum'
  );

  INSERT INTO public.gto_v31_cell_source_receipts (
    dataset_id,cell_id,source_row_id,source_node,source_node_checksum,
    source_artifact_checksum,machine_id,split
  )
  SELECT p_dataset_id,c.cell_id,a.source_row_id,n.value->>'node',n.value->>'node_checksum',
         a.source_artifact_checksum,a.machine_id,
         CASE WHEN a.machine_id='M2' THEN 'holdout' ELSE 'train' END
    FROM public.gto_v31_runtime_cells c
    JOIN public.gto_v31_source_artifacts a ON a.dataset_id=p_dataset_id
    JOIN public.solved_spots_gold s ON s.id=a.source_row_id
     AND s.quality_status='validated' AND s.source_artifact_checksum=a.source_artifact_checksum
    CROSS JOIN LATERAL jsonb_array_elements(s.strategy_matrix_v2->'nodes') n(value)
   WHERE c.dataset_id=p_dataset_id AND c.cell_key_checksum=v_cell->>'cell_key_checksum'
     AND n.value#>>'{node_context,street}'=p_context->>'street'
     AND n.value#>>'{node_context,game_family}'=p_context->>'game_family'
     AND n.value#>>'{node_context,objective}'=p_context->>'objective'
     AND n.value#>>'{node_context,utility_context}'=p_context->>'utility_context'
     AND (n.value#>>'{node_context,table_size}')::integer=(p_context->>'table_size')::integer
     AND n.value#>>'{node_context,pot_type}'=p_context->>'pot_type'
     AND n.value#>>'{node_context,hero_position}'=p_context->>'hero_position'
     AND n.value#>>'{node_context,opponent_position}'=p_context->>'opponent_position'
     AND (n.value#>>'{node_context,depth_bucket}')::integer=(p_context->>'depth_bucket')::integer
     AND n.value#>>'{node_context,texture_class}'=p_context->>'texture_class'
     AND n.value#>>'{node_context,node_role}'=p_context->>'node_role'
     AND n.value#>>'{node_context,facing_kind}'=p_context->>'facing_kind'
     AND n.value#>>'{node_context,facing_size_bucket}'=p_context->>'facing_size_bucket';
  IF NOT FOUND THEN RAISE EXCEPTION 'database-computed cell did not retain source receipts'; END IF;
  RETURN v_cell->>'cell_key_checksum';
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_build_cell(uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_build_cell(uuid,jsonb) TO service_role;

DO $assert$
DECLARE
  v_source text;
BEGIN
  IF public.fn_gto_v31_board_rank_signature('AsKd7c') IS DISTINCT FROM
       public.fn_gto_v31_board_rank_signature('7hAcKd') THEN
    RAISE EXCEPTION 'suit or flop-order permutations did not share a rank signature';
  END IF;
  IF public.fn_gto_v31_board_rank_signature('AsKd7c') IS NOT DISTINCT FROM
       public.fn_gto_v31_board_rank_signature('AhQc6d') THEN
    RAISE EXCEPTION 'different flop ranks shared a rank signature';
  END IF;
  IF public.fn_gto_v31_board_rank_signature('AsKd7c2h3s') IS NOT DISTINCT FROM
       public.fn_gto_v31_board_rank_signature('AhKc7d3s4c') THEN
    RAISE EXCEPTION 'different ordered runout ranks shared a rank signature';
  END IF;
  SELECT pg_get_functiondef(
    'public.fn_gto_v31_build_cell(uuid,jsonb)'::regprocedure
  ) INTO v_source;
  IF position('fn_gto_v31_board_rank_signature' IN v_source)=0
     OR position('rank-disjoint train and holdout sources' IN v_source)=0 THEN
    RAISE EXCEPTION 'the compact-cell authority is not using rank-disjoint holdouts';
  END IF;
END;
$assert$;
