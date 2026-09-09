-- The signed solver hosts are intentionally narrow, untrusted producers.
-- PostgreSQL must reject type-coercible action metadata rather than relying on
-- Python or JavaScript to have emitted the canonical JSON shape. Compact cells
-- must likewise contain every action (including explicit zero frequencies),
-- exact EV domains, and count-consistent source evidence before they can be
-- sealed or loaded by the horse.
BEGIN;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_action_specs_valid(p_specs jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  v_action record;
  v_family text;
  v_unit text;
  v_size numeric;
BEGIN
  IF p_specs IS NULL OR jsonb_typeof(p_specs) <> 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_specs)) < 2 THEN
    RETURN false;
  END IF;
  FOR v_action IN SELECT key,value FROM jsonb_each(p_specs) LOOP
    IF v_action.key = ''
       OR jsonb_typeof(v_action.value) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(v_action.value)) <> 4
       OR NOT (v_action.value ?& ARRAY['family','size_unit','size_value','all_in'])
       OR jsonb_typeof(v_action.value->'family') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_action.value->'size_unit') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_action.value->'all_in') IS DISTINCT FROM 'boolean' THEN
      RETURN false;
    END IF;
    v_family := v_action.value->>'family';
    v_unit := v_action.value->>'size_unit';
    IF v_family NOT IN ('check','fold','call','bet','raise','all_in') THEN RETURN false; END IF;
    IF v_family IN ('check','fold','call') THEN
      IF v_unit <> 'none'
         OR v_action.value->'size_value' IS DISTINCT FROM 'null'::jsonb
         OR (v_action.value->>'all_in')::boolean IS DISTINCT FROM false THEN
        RETURN false;
      END IF;
    ELSIF v_family = 'all_in' THEN
      IF v_unit <> 'all_in'
         OR v_action.value->'size_value' IS DISTINCT FROM 'null'::jsonb
         OR (v_action.value->>'all_in')::boolean IS DISTINCT FROM true THEN
        RETURN false;
      END IF;
    ELSE
      IF jsonb_typeof(v_action.value->'size_value') IS DISTINCT FROM 'number'
         OR (v_action.value->>'all_in')::boolean IS DISTINCT FROM false THEN
        RETURN false;
      END IF;
      v_size := (v_action.value->>'size_value')::numeric;
      IF v_size <= 0 OR v_size > 20
         OR (v_family = 'bet' AND v_unit <> 'pot_fraction')
         OR (v_family = 'raise' AND v_unit <> 'pot_after_call_fraction') THEN
        RETURN false;
      END IF;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_source_node_scalar_types_valid(p_node jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  v_context jsonb := p_node->'node_context';
  v_line jsonb := p_node->'line_proof';
  v_key text;
BEGIN
  IF p_node IS NULL OR jsonb_typeof(p_node) <> 'object' THEN RETURN false; END IF;
  FOREACH v_key IN ARRAY ARRAY[
    'schema','node','node_checksum','source_combo_order_checksum','range_bundle_checksum'
  ] LOOP
    IF jsonb_typeof(p_node->v_key) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  END LOOP;
  IF jsonb_typeof(v_context) <> 'object' OR jsonb_typeof(v_line) <> 'object' THEN RETURN false; END IF;
  FOREACH v_key IN ARRAY ARRAY[
    'street','game_family','objective','utility_context','pot_type','hero_position',
    'opponent_position','texture_class','node_role','facing_kind','facing_size_bucket','board'
  ] LOOP
    IF jsonb_typeof(v_context->v_key) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  END LOOP;
  IF jsonb_typeof(v_context->'table_size') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_context->'depth_bucket') IS DISTINCT FROM 'number'
     OR COALESCE(jsonb_typeof(v_context->'facing_target_chips'),'missing') NOT IN ('number','null')
     OR COALESCE(jsonb_typeof(v_context->'facing_actor_total_chips'),'missing') NOT IN ('number','null') THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(v_line->'schema') IS DISTINCT FROM 'string'
     OR jsonb_typeof(v_line->'manifest_checksum') IS DISTINCT FROM 'string'
     OR jsonb_typeof(v_line->'hero_solver_player') IS DISTINCT FROM 'number'
     OR COALESCE(jsonb_typeof(v_line->'preflop_aggressor_solver_player'),'missing') NOT IN ('number','null')
     OR jsonb_typeof(v_line->'root_pot_chips') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_line->'effective_stack_chips') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_line->'chips_per_bb') IS DISTINCT FROM 'number' THEN
    RETURN false;
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_compact_matrices_valid(
  p_matrix jsonb,
  p_specs jsonb,
  p_policy_evs jsonb,
  p_action_evs jsonb,
  p_street text
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  v_hand record;
  v_action text;
  v_value numeric;
  v_sum numeric;
  v_action_count integer;
BEGIN
  IF NOT public.fn_gto_v31_action_specs_valid(p_specs)
     OR NOT public.fn_gto_v31_hand_matrix_valid(p_matrix,p_street)
     OR jsonb_typeof(p_policy_evs) <> 'object'
     OR jsonb_typeof(p_action_evs) <> 'object' THEN
    RETURN false;
  END IF;
  v_action_count := (SELECT count(*) FROM jsonb_object_keys(p_specs));
  IF (SELECT count(*) FROM jsonb_object_keys(p_policy_evs)) <>
       (SELECT count(*) FROM jsonb_object_keys(p_matrix))
     OR (SELECT count(*) FROM jsonb_object_keys(p_action_evs)) <>
       (SELECT count(*) FROM jsonb_object_keys(p_matrix)) THEN
    RETURN false;
  END IF;

  FOR v_hand IN SELECT key,value FROM jsonb_each(p_matrix) LOOP
    IF jsonb_typeof(v_hand.value) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(v_hand.value)) <> v_action_count
       OR EXISTS (
         SELECT 1 FROM jsonb_object_keys(p_specs) a(key)
          WHERE NOT (v_hand.value ? a.key)
       )
       OR NOT (p_policy_evs ? v_hand.key)
       OR jsonb_typeof(p_policy_evs->v_hand.key) <> 'number'
       OR NOT (p_action_evs ? v_hand.key)
       OR jsonb_typeof(p_action_evs->v_hand.key) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(p_action_evs->v_hand.key)) <> v_action_count
       OR EXISTS (
         SELECT 1 FROM jsonb_object_keys(p_specs) a(key)
          WHERE NOT ((p_action_evs->v_hand.key) ? a.key)
       ) THEN
      RETURN false;
    END IF;
    v_sum := 0;
    FOR v_action IN SELECT jsonb_object_keys(p_specs) LOOP
      IF jsonb_typeof(v_hand.value->v_action) <> 'number'
         OR jsonb_typeof(p_action_evs->v_hand.key->v_action) <> 'number' THEN
        RETURN false;
      END IF;
      v_value := (v_hand.value->>v_action)::numeric;
      IF v_value < 0 OR v_value > 1 THEN RETURN false; END IF;
      v_sum := v_sum + v_value;
    END LOOP;
    IF abs(v_sum - 1) > 0.002 THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_action_specs_valid(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_gto_v31_source_node_scalar_types_valid(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_gto_v31_compact_matrices_valid(jsonb,jsonb,jsonb,jsonb,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_action_specs_valid(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_source_node_scalar_types_valid(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_compact_matrices_valid(jsonb,jsonb,jsonb,jsonb,text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_source_node_valid(p_node jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  v_context jsonb := p_node->'node_context';
  v_line_proof jsonb := p_node->'line_proof';
  v_specs jsonb := p_node->'action_specs';
  v_frequencies jsonb := p_node->'frequencies';
  v_action_evs jsonb := p_node->'action_evs_bb';
  v_policy_evs jsonb := p_node->'policy_evs_bb';
  v_matchups jsonb := p_node->'matchups';
  v_action record;
  v_family text;
  v_unit text;
  v_size numeric;
  v_role text := v_context->>'node_role';
  v_facing text := v_context->>'facing_kind';
  v_bucket text := v_context->>'facing_size_bucket';
  v_has_check boolean := false;
  v_has_fold boolean := false;
  v_has_call boolean := false;
  v_has_bet boolean := false;
  v_table_size integer;
  v_allowed_positions text[];
  v_board text := v_context->>'board';
  v_cards text[] := ARRAY[]::text[];
  v_card text;
  v_i integer;
  v_weight numeric;
  v_frequency numeric;
  v_frequency_sum numeric;
  v_action_ev numeric;
  v_expected_ev numeric;
  v_policy_ev numeric;
  v_derived_line jsonb;
  v_line_role text;
  v_hero_solver_player integer;
  v_preflop_aggressor integer;
  v_node_cards text[];
  v_expected_node_cards text[]:=ARRAY[]::text[];
  v_facing_target numeric;
  v_facing_actor_total numeric;
  v_root_pot_chips numeric;
  v_effective_stack_chips numeric;
  v_chips_per_bb numeric;
  v_last_token text;
BEGIN
  IF p_node IS NULL OR jsonb_typeof(p_node)<>'object'
     OR NOT public.fn_gto_v31_source_node_scalar_types_valid(p_node)
     OR NOT public.fn_gto_v31_action_specs_valid(v_specs)
     OR (SELECT count(*) FROM jsonb_object_keys(p_node))<>12
     OR NOT (p_node ?& ARRAY['schema','node','node_checksum','node_context','line_proof','action_specs',
       'frequencies','policy_evs_bb','action_evs_bb','matchups',
       'source_combo_order_checksum','range_bundle_checksum'])
     OR p_node->>'schema' IS DISTINCT FROM 'smarter-poker.pio-policy.v3'
     OR COALESCE(p_node->>'node','') !~ '^r:[0-9]+(:[cf]|:b[1-9][0-9]*|:[2-9TJQKA][cdhs])*$'
     OR COALESCE(p_node->>'node_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_node->>'node_checksum' IS DISTINCT FROM public.fn_gto_v31_node_checksum(p_node)
     OR COALESCE(p_node->>'source_combo_order_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_node->>'source_combo_order_checksum'=repeat('0',64)
     OR COALESCE(p_node->>'range_bundle_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_node->>'range_bundle_checksum'=repeat('0',64)
     OR jsonb_typeof(v_context)<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(v_context))<>16
     OR NOT (v_context ?& ARRAY['street','game_family','objective','utility_context',
       'table_size','pot_type','hero_position','opponent_position','depth_bucket',
       'texture_class','node_role','facing_kind','facing_size_bucket','board',
       'facing_target_chips','facing_actor_total_chips'])
     OR COALESCE(v_board,'') !~ '^([2-9TJQKA][cdhs]){3,5}$'
     OR length(v_board) <> (CASE v_context->>'street'
       WHEN 'flop' THEN 6 WHEN 'turn' THEN 8 WHEN 'river' THEN 10 ELSE 0 END)
     OR COALESCE(v_context->>'game_family','') NOT IN ('cash','spin','tourney_ev','tourney_icm')
     OR COALESCE(v_context->>'objective','') NOT IN ('cash_ev','chip_ev','icm')
     OR COALESCE(v_context->>'utility_context','') NOT IN
       ('cash_ev','chip_ev','spin_ladder','satellite','bubble','final_table','in_money','ladder')
     OR COALESCE(v_context->>'pot_type','') NOT IN ('limped','srp','3bet','4bet_plus')
     OR COALESCE((v_context->>'depth_bucket')::integer,0) NOT IN (10,20,40,80,150)
     OR COALESCE(v_context->>'texture_class','') !~ '^[ABML][mtr][pu][cd]$'
     OR v_context->>'texture_class' IS DISTINCT FROM public.fn_gto_texture_class_any(v_board)
     OR COALESCE(v_role,'') NOT IN ('open','cbet','probe','delayed_cbet','barrel','facing_bet','facing_raise','check_raise','bet_raise','all_in')
     OR jsonb_typeof(v_line_proof)<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(v_line_proof))<>7
     OR NOT (v_line_proof ?& ARRAY['schema','manifest_checksum','hero_solver_player',
       'preflop_aggressor_solver_player','root_pot_chips','effective_stack_chips',
       'chips_per_bb'])
     OR v_line_proof->>'schema' IS DISTINCT FROM 'smarter-poker.pio-line-proof.v1'
     OR COALESCE(v_line_proof->>'manifest_checksum','') !~ '^[0-9a-f]{64}$'
     OR v_line_proof->>'manifest_checksum'=repeat('0',64)
     OR jsonb_typeof(v_line_proof->'hero_solver_player')<>'number'
     OR COALESCE((v_line_proof->>'hero_solver_player')::integer,-1) NOT IN (0,1)
     OR jsonb_typeof(v_line_proof->'preflop_aggressor_solver_player') NOT IN ('number','null')
     OR (jsonb_typeof(v_line_proof->'preflop_aggressor_solver_player')='number'
       AND (v_line_proof->>'preflop_aggressor_solver_player')::integer NOT IN (0,1))
     OR jsonb_typeof(v_line_proof->'root_pot_chips')<>'number'
     OR jsonb_typeof(v_line_proof->'effective_stack_chips')<>'number'
     OR jsonb_typeof(v_line_proof->'chips_per_bb')<>'number'
     OR jsonb_typeof(v_specs)<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(v_specs))<2
     OR jsonb_typeof(v_frequencies)<>'object'
     OR jsonb_typeof(v_action_evs)<>'object'
     OR jsonb_typeof(v_policy_evs)<>'array' OR jsonb_array_length(v_policy_evs)<>1326
     OR jsonb_typeof(v_matchups)<>'array' OR jsonb_array_length(v_matchups)<>1326
     OR (SELECT count(*) FROM jsonb_object_keys(v_frequencies))<>(SELECT count(*) FROM jsonb_object_keys(v_specs))
     OR (SELECT count(*) FROM jsonb_object_keys(v_action_evs))<>(SELECT count(*) FROM jsonb_object_keys(v_specs)) THEN
    RETURN false;
  END IF;

  v_hero_solver_player:=(v_line_proof->>'hero_solver_player')::integer;
  IF jsonb_typeof(v_line_proof->'preflop_aggressor_solver_player')='number' THEN
    v_preflop_aggressor:=(v_line_proof->>'preflop_aggressor_solver_player')::integer;
  END IF;
  v_root_pot_chips:=(v_line_proof->>'root_pot_chips')::numeric;
  v_effective_stack_chips:=(v_line_proof->>'effective_stack_chips')::numeric;
  v_chips_per_bb:=(v_line_proof->>'chips_per_bb')::numeric;
  IF v_root_pot_chips<=0 OR v_effective_stack_chips<=0 OR v_chips_per_bb<=0
     OR v_root_pot_chips<>trunc(v_root_pot_chips)
     OR v_effective_stack_chips<>trunc(v_effective_stack_chips)
     OR v_chips_per_bb<>trunc(v_chips_per_bb)
     OR v_effective_stack_chips<>((v_context->>'depth_bucket')::numeric*v_chips_per_bb) THEN
    RETURN false;
  END IF;
  IF (v_context->>'pot_type'='limped') IS DISTINCT FROM (v_preflop_aggressor IS NULL) THEN
    RETURN false;
  END IF;

  FOR v_i IN 0..length(v_board)/2-1 LOOP
    v_card:=substr(v_board,v_i*2+1,2);
    IF v_card=ANY(v_cards) THEN RETURN false; END IF;
    v_cards:=array_append(v_cards,v_card);
  END LOOP;
  SELECT COALESCE(array_agg(token ORDER BY ordinal),'{}'::text[]) INTO v_node_cards
    FROM unnest(string_to_array(p_node->>'node',':')) WITH ORDINALITY part(token,ordinal)
   WHERE token~'^[2-9TJQKA][cdhs]$';
  IF length(v_board)/2>3 THEN
    FOR v_i IN 3..length(v_board)/2-1 LOOP
      v_expected_node_cards:=array_append(v_expected_node_cards,substr(v_board,v_i*2+1,2));
    END LOOP;
  END IF;
  IF v_node_cards IS DISTINCT FROM v_expected_node_cards THEN RETURN false; END IF;
  v_derived_line:=public.fn_gto_v31_node_line_proof(
    p_node->>'node',
    v_preflop_aggressor,
    v_root_pot_chips,
    v_effective_stack_chips
  );
  v_line_role:=v_derived_line->>'derived_node_role';
  IF v_derived_line IS NULL
     OR v_derived_line->>'street' IS DISTINCT FROM v_context->>'street'
     OR COALESCE((v_derived_line->>'current_actor_solver_player')::integer,-1)<>v_hero_solver_player
     OR v_line_role<>v_role
     OR v_derived_line->>'derived_facing_kind' IS DISTINCT FROM v_facing
     OR v_derived_line->>'derived_facing_size_bucket' IS DISTINCT FROM v_bucket
     OR v_derived_line->'facing_target_chips' IS DISTINCT FROM v_context->'facing_target_chips'
     OR v_derived_line->'facing_actor_total_chips' IS DISTINCT FROM v_context->'facing_actor_total_chips' THEN
    RETURN false;
  END IF;
  v_last_token := (string_to_array(p_node->>'node',':'))[
    array_length(string_to_array(p_node->>'node',':'),1)
  ];
  IF v_role IN ('open','cbet','probe','delayed_cbet','barrel') THEN
    IF v_context->'facing_target_chips' IS DISTINCT FROM 'null'::jsonb
       OR v_context->'facing_actor_total_chips' IS DISTINCT FROM 'null'::jsonb THEN
      RETURN false;
    END IF;
  ELSE
    IF v_last_token !~ '^b[1-9][0-9]*$'
       OR jsonb_typeof(v_context->'facing_target_chips')<>'number'
       OR jsonb_typeof(v_context->'facing_actor_total_chips')<>'number' THEN
      RETURN false;
    END IF;
    v_facing_target := (v_context->>'facing_target_chips')::numeric;
    v_facing_actor_total := (v_context->>'facing_actor_total_chips')::numeric;
    IF v_facing_target <= 0 OR v_facing_actor_total <= 0
       OR v_facing_target > v_facing_actor_total
       OR v_facing_target <> substring(v_last_token FROM 2)::numeric
       OR (v_role='all_in' AND v_facing_target<>v_facing_actor_total)
       OR (v_role<>'all_in' AND v_facing_target>=v_facing_actor_total) THEN
      RETURN false;
    END IF;
  END IF;
  v_table_size := (v_context->>'table_size')::integer;
  v_allowed_positions := CASE v_table_size
    WHEN 2 THEN ARRAY['SB','BB'] WHEN 3 THEN ARRAY['SB','BB','BTN']
    WHEN 4 THEN ARRAY['SB','BB','CO','BTN'] WHEN 5 THEN ARRAY['SB','BB','HJ','CO','BTN']
    WHEN 6 THEN ARRAY['SB','BB','UTG','HJ','CO','BTN']
    WHEN 7 THEN ARRAY['SB','BB','UTG','MP','HJ','CO','BTN']
    WHEN 8 THEN ARRAY['SB','BB','UTG','UTG1','MP','HJ','CO','BTN']
    WHEN 9 THEN ARRAY['SB','BB','UTG','UTG1','UTG2','MP','HJ','CO','BTN']
    WHEN 10 THEN ARRAY['SB','BB','UTG','UTG1','UTG2','UTG3','MP','HJ','CO','BTN']
    ELSE NULL END;
  IF v_allowed_positions IS NULL
     OR NOT (v_context->>'hero_position'=ANY(v_allowed_positions))
     OR NOT (v_context->>'opponent_position'=ANY(v_allowed_positions))
     OR v_context->>'hero_position'=v_context->>'opponent_position'
     OR NOT ((v_context->>'game_family'='cash' AND v_context->>'objective'='cash_ev' AND v_context->>'utility_context'='cash_ev')
       OR (v_context->>'game_family'='spin' AND v_context->>'objective'='chip_ev' AND v_context->>'utility_context'='chip_ev')
       OR (v_context->>'game_family'='spin' AND v_context->>'objective'='icm' AND v_context->>'utility_context'='spin_ladder')
       OR (v_context->>'game_family'='tourney_ev' AND v_context->>'objective'='chip_ev' AND v_context->>'utility_context'='chip_ev')
       OR (v_context->>'game_family'='tourney_icm' AND v_context->>'objective'='icm' AND
           v_context->>'utility_context' IN ('satellite','bubble','final_table','in_money','ladder'))) THEN
    RETURN false;
  END IF;
  IF (v_role IN ('open','cbet','probe','delayed_cbet','barrel') AND (v_facing<>'none' OR v_bucket<>'none'))
     OR (v_role='all_in' AND (v_facing<>'all_in' OR v_bucket<>'all_in'))
     OR (v_role='facing_bet' AND (v_facing<>'bet' OR v_bucket NOT IN ('small','mid','big')))
     OR (v_role IN ('facing_raise','check_raise','bet_raise') AND
         (v_facing<>'raise' OR v_bucket NOT IN ('small','mid','big'))) THEN RETURN false; END IF;

  FOR v_action IN SELECT key,value FROM jsonb_each(v_specs) LOOP
    IF NOT (v_frequencies?v_action.key) OR NOT (v_action_evs?v_action.key)
       OR jsonb_typeof(v_action.value)<>'object'
       OR jsonb_typeof(v_frequencies->v_action.key)<>'array'
       OR jsonb_array_length(v_frequencies->v_action.key)<>1326
       OR jsonb_typeof(v_action_evs->v_action.key)<>'array'
       OR jsonb_array_length(v_action_evs->v_action.key)<>1326 THEN RETURN false; END IF;
    v_family:=v_action.value->>'family'; v_unit:=v_action.value->>'size_unit';
    IF v_family NOT IN ('check','fold','call','bet','raise','all_in') THEN RETURN false; END IF;
    v_has_check:=v_has_check OR v_family='check'; v_has_fold:=v_has_fold OR v_family='fold';
    v_has_call:=v_has_call OR v_family='call'; v_has_bet:=v_has_bet OR v_family='bet';
    IF v_family IN ('check','fold','call') THEN
      IF v_unit IS DISTINCT FROM 'none' OR v_action.value->'size_value' IS DISTINCT FROM 'null'::jsonb
         OR (v_action.value->>'all_in')::boolean IS DISTINCT FROM false THEN RETURN false; END IF;
    ELSIF v_family='all_in' THEN
      IF v_unit IS DISTINCT FROM 'all_in' OR v_action.value->'size_value' IS DISTINCT FROM 'null'::jsonb
         OR (v_action.value->>'all_in')::boolean IS DISTINCT FROM true THEN RETURN false; END IF;
    ELSE
      v_size:=(v_action.value->>'size_value')::numeric;
      IF v_size<=0 OR v_size>20 OR COALESCE((v_action.value->>'all_in')::boolean,false)
         OR (v_family='bet' AND v_unit<>'pot_fraction')
         OR (v_family='raise' AND v_unit<>'pot_after_call_fraction') THEN RETURN false; END IF;
    END IF;
  END LOOP;
  IF v_role IN ('open','cbet','probe','delayed_cbet','barrel') THEN
    IF NOT v_has_check OR v_has_fold OR v_has_call THEN RETURN false; END IF;
  ELSIF v_role='all_in' THEN
    IF NOT v_has_fold OR NOT v_has_call OR v_has_check OR v_has_bet
       OR EXISTS (SELECT 1 FROM jsonb_each(v_specs) s WHERE s.value->>'family' NOT IN ('fold','call')) THEN RETURN false; END IF;
  ELSE
    IF NOT v_has_fold OR NOT v_has_call OR v_has_check OR v_has_bet THEN RETURN false; END IF;
  END IF;

  FOR v_i IN 0..1325 LOOP
    IF jsonb_typeof(v_matchups->v_i)<>'number' THEN RETURN false; END IF;
    v_weight:=(v_matchups->>v_i)::numeric;
    -- calc_ev's second vector is matchup mass, not a [0,1] range weight.
    -- It must be finite/nonnegative JSON numeric, but can legitimately exceed
    -- one when many weighted opponent combinations remain.
    IF v_weight<0 THEN RETURN false; END IF;
    v_frequency_sum:=0; v_expected_ev:=0;
    FOR v_action IN SELECT key FROM jsonb_each(v_specs) LOOP
      IF jsonb_typeof(v_frequencies->v_action.key->v_i)<>'number' THEN RETURN false; END IF;
      v_frequency:=(v_frequencies->v_action.key->>v_i)::numeric;
      IF v_frequency<0 OR v_frequency>1 THEN RETURN false; END IF;
      v_frequency_sum:=v_frequency_sum+v_frequency;
      IF v_weight>0 THEN
        IF jsonb_typeof(v_action_evs->v_action.key->v_i)<>'number' THEN RETURN false; END IF;
        v_action_ev:=(v_action_evs->v_action.key->>v_i)::numeric;
        v_expected_ev:=v_expected_ev+v_frequency*v_action_ev;
      ELSIF v_frequency<>0 OR jsonb_typeof(v_action_evs->v_action.key->v_i)<>'null' THEN
        RETURN false;
      END IF;
    END LOOP;
    IF v_weight>0 THEN
      IF abs(v_frequency_sum-1)>0.00002 OR jsonb_typeof(v_policy_evs->v_i)<>'number' THEN RETURN false; END IF;
      v_policy_ev:=(v_policy_evs->>v_i)::numeric;
      IF abs(v_policy_ev-v_expected_ev)>0.02 THEN RETURN false; END IF;
    ELSIF v_frequency_sum<>0 OR jsonb_typeof(v_policy_evs->v_i)<>'null' THEN RETURN false;
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(public.fn_gto_v31_combo_cards(v_i)) c(card) WHERE c.card=ANY(v_cards))
       AND v_weight<>0 THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_source_node_valid(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_source_node_valid(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_cell_payload_valid(p_cell jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  v_role text := p_cell->>'node_role';
  v_facing text := p_cell->>'facing_kind';
  v_bucket text := p_cell->>'facing_size_bucket';
  v_action record;
  v_hand record;
  v_frequency record;
  v_sum numeric;
  v_family text;
  v_unit text;
  v_size numeric;
  v_actions jsonb := p_cell->'action_specs';
  v_matrix jsonb := p_cell->'hand_matrix';
  v_policy_evs jsonb := COALESCE(p_cell->'policy_ev_matrix', '{}'::jsonb);
  v_action_evs jsonb := COALESCE(p_cell->'action_ev_matrix', '{}'::jsonb);
  v_has_check boolean := false;
  v_has_fold boolean := false;
  v_has_call boolean := false;
  v_has_bet boolean := false;
  v_has_raise boolean := false;
  v_has_all_in boolean := false;
  v_table_size integer := COALESCE((p_cell->>'table_size')::integer,0);
  v_allowed_positions text[];
BEGIN
  IF p_cell IS NULL OR jsonb_typeof(p_cell) <> 'object'
     OR NOT public.fn_gto_v31_compact_matrices_valid(
       v_matrix,v_actions,v_policy_evs,v_action_evs,p_cell->>'street'
     )
     OR jsonb_typeof(p_cell->'source_rows') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_cell->'train_source_rows') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_cell->'holdout_source_rows') IS DISTINCT FROM 'number'
     OR (p_cell->>'source_rows')::integer IS DISTINCT FROM
        (p_cell->>'train_source_rows')::integer + (p_cell->>'holdout_source_rows')::integer
     OR COALESCE(p_cell->>'cell_key_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_cell->>'cell_key_checksum' = repeat('0',64)
     OR p_cell->>'cell_key_checksum' IS DISTINCT FROM public.fn_gto_v31_cell_key_checksum(p_cell)
     OR COALESCE(p_cell->>'cell_payload_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_cell->>'cell_payload_checksum' = repeat('0',64)
     OR p_cell->>'cell_payload_checksum' IS DISTINCT FROM public.fn_gto_v31_cell_payload_checksum(p_cell)
     OR COALESCE(p_cell->>'lineage_checksum','') !~ '^[0-9a-f]{64}$'
     OR p_cell->>'lineage_checksum' = repeat('0',64)
     OR COALESCE(p_cell->>'street','') NOT IN ('flop','turn','river')
     OR COALESCE(p_cell->>'game_family','') NOT IN ('cash','spin','tourney_ev','tourney_icm')
     OR COALESCE(p_cell->>'objective','') NOT IN ('cash_ev','chip_ev','icm')
     OR COALESCE(p_cell->>'utility_context','') NOT IN ('cash_ev','chip_ev','spin_ladder','satellite','bubble','final_table','in_money','ladder')
     OR v_table_size NOT BETWEEN 2 AND 10
     OR COALESCE(p_cell->>'pot_type','') NOT IN ('limped','srp','3bet','4bet_plus')
     OR COALESCE(p_cell->>'hero_position','') NOT IN ('UTG','UTG1','UTG2','UTG3','MP','HJ','CO','BTN','SB','BB')
     OR COALESCE(p_cell->>'opponent_position','') NOT IN ('UTG','UTG1','UTG2','UTG3','MP','HJ','CO','BTN','SB','BB')
     OR p_cell->>'hero_position' = p_cell->>'opponent_position'
     OR COALESCE((p_cell->>'depth_bucket')::integer,0) NOT IN (10,20,40,80,150)
     OR COALESCE(p_cell->>'texture_class','') !~ '^[ABML][mtr][pu][cd]$'
     OR COALESCE(v_role,'') NOT IN ('open','cbet','probe','delayed_cbet','barrel','facing_bet','facing_raise','check_raise','bet_raise','all_in')
     OR COALESCE(v_facing,'') NOT IN ('none','bet','raise','all_in')
     OR COALESCE(v_bucket,'') NOT IN ('none','small','mid','big','all_in')
     OR jsonb_typeof(v_actions) <> 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(v_actions)) < 2
     OR jsonb_typeof(v_matrix) <> 'object'
     OR NOT EXISTS (SELECT 1 FROM jsonb_object_keys(v_matrix))
     OR jsonb_typeof(v_policy_evs) <> 'object'
     OR jsonb_typeof(v_action_evs) <> 'object'
     OR COALESCE((p_cell->>'source_rows')::integer,0) <= 0
     OR COALESCE((p_cell->>'train_source_rows')::integer,0) <= 0
     OR COALESCE((p_cell->>'holdout_source_rows')::integer,0) <= 0 THEN
    RETURN false;
  END IF;

  IF NOT ((p_cell->>'game_family' = 'cash' AND p_cell->>'objective' = 'cash_ev') OR
          (p_cell->>'game_family' = 'tourney_icm' AND p_cell->>'objective' = 'icm') OR
          (p_cell->>'game_family' = 'tourney_ev' AND p_cell->>'objective' = 'chip_ev') OR
          (p_cell->>'game_family' = 'spin' AND p_cell->>'objective' IN ('chip_ev','icm'))) THEN
    RETURN false;
  END IF;
  IF NOT ((p_cell->>'objective' = 'cash_ev' AND p_cell->>'utility_context' = 'cash_ev') OR
          (p_cell->>'objective' = 'chip_ev' AND p_cell->>'utility_context' = 'chip_ev') OR
          (p_cell->>'objective' = 'icm' AND p_cell->>'game_family' = 'spin' AND
           p_cell->>'utility_context' = 'spin_ladder') OR
          (p_cell->>'objective' = 'icm' AND p_cell->>'game_family' = 'tourney_icm' AND
           p_cell->>'utility_context' IN ('satellite','bubble','final_table','in_money','ladder'))) THEN
    RETURN false;
  END IF;

  v_allowed_positions := CASE v_table_size
    WHEN 2 THEN ARRAY['SB','BB']
    WHEN 3 THEN ARRAY['SB','BB','BTN']
    WHEN 4 THEN ARRAY['SB','BB','CO','BTN']
    WHEN 5 THEN ARRAY['SB','BB','HJ','CO','BTN']
    WHEN 6 THEN ARRAY['SB','BB','UTG','HJ','CO','BTN']
    WHEN 7 THEN ARRAY['SB','BB','UTG','MP','HJ','CO','BTN']
    WHEN 8 THEN ARRAY['SB','BB','UTG','UTG1','MP','HJ','CO','BTN']
    WHEN 9 THEN ARRAY['SB','BB','UTG','UTG1','UTG2','MP','HJ','CO','BTN']
    WHEN 10 THEN ARRAY['SB','BB','UTG','UTG1','UTG2','UTG3','MP','HJ','CO','BTN']
  END;
  IF NOT (p_cell->>'hero_position' = ANY(v_allowed_positions))
     OR NOT (p_cell->>'opponent_position' = ANY(v_allowed_positions)) THEN
    RETURN false;
  END IF;

  IF v_role IN ('open','cbet','probe','delayed_cbet','barrel') THEN
    IF v_facing <> 'none' OR v_bucket <> 'none' THEN RETURN false; END IF;
  ELSIF v_role = 'all_in' THEN
    IF v_facing <> 'all_in' OR v_bucket <> 'all_in' THEN RETURN false; END IF;
  ELSIF (v_role = 'facing_bet' AND v_facing <> 'bet')
     OR (v_role IN ('facing_raise','check_raise','bet_raise') AND v_facing <> 'raise')
     OR v_bucket NOT IN ('small','mid','big') THEN
    RETURN false;
  END IF;

  FOR v_action IN SELECT key, value FROM jsonb_each(v_actions) LOOP
    IF v_action.key = '' OR jsonb_typeof(v_action.value) <> 'object' THEN RETURN false; END IF;
    v_family := v_action.value->>'family';
    v_unit := v_action.value->>'size_unit';
    IF v_family NOT IN ('check','fold','call','bet','raise','all_in') THEN RETURN false; END IF;
    IF v_family = 'check' THEN v_has_check := true; END IF;
    IF v_family = 'fold' THEN v_has_fold := true; END IF;
    IF v_family = 'call' THEN v_has_call := true; END IF;
    IF v_family = 'bet' THEN v_has_bet := true; END IF;
    IF v_family = 'raise' THEN v_has_raise := true; END IF;
    IF v_family = 'all_in' THEN v_has_all_in := true; END IF;
    IF v_family IN ('check','fold','call') THEN
      IF v_unit IS DISTINCT FROM 'none'
         OR v_action.value->'size_value' IS DISTINCT FROM 'null'::jsonb
         OR (v_action.value->>'all_in')::boolean IS DISTINCT FROM false THEN RETURN false; END IF;
    ELSIF v_family = 'all_in' THEN
      IF v_unit IS DISTINCT FROM 'all_in'
         OR v_action.value->'size_value' IS DISTINCT FROM 'null'::jsonb
         OR (v_action.value->>'all_in')::boolean IS DISTINCT FROM true THEN RETURN false; END IF;
    ELSE
      BEGIN v_size := (v_action.value->>'size_value')::numeric; EXCEPTION WHEN OTHERS THEN RETURN false; END;
      IF v_size <= 0 OR v_size > 20 OR COALESCE((v_action.value->>'all_in')::boolean,false)
         OR (v_family = 'bet' AND v_unit <> 'pot_fraction')
         OR (v_family = 'raise' AND v_unit <> 'pot_after_call_fraction') THEN RETURN false; END IF;
    END IF;
  END LOOP;

  IF v_role IN ('open','cbet','probe','delayed_cbet','barrel') THEN
    IF NOT v_has_check OR v_has_fold OR v_has_call THEN RETURN false; END IF;
  ELSE
    IF NOT v_has_fold OR NOT v_has_call OR v_has_check OR v_has_bet THEN RETURN false; END IF;
    IF v_role = 'all_in' AND (v_has_raise OR v_has_all_in) THEN RETURN false; END IF;
  END IF;

  FOR v_hand IN SELECT key, value FROM jsonb_each(v_matrix) LOOP
    IF NOT public.fn_gto_v31_hand_key_valid(v_hand.key,p_cell->>'street')
       OR jsonb_typeof(v_hand.value) <> 'object'
       OR NOT EXISTS (SELECT 1 FROM jsonb_object_keys(v_hand.value)) THEN
      RETURN false;
    END IF;
    v_sum := 0;
    FOR v_frequency IN SELECT key, value FROM jsonb_each(v_hand.value) LOOP
      IF NOT (v_actions ? v_frequency.key) OR jsonb_typeof(v_frequency.value) <> 'number' THEN RETURN false; END IF;
      BEGIN v_size := (v_frequency.value #>> '{}')::numeric; EXCEPTION WHEN OTHERS THEN RETURN false; END;
      IF v_size < 0 OR v_size > 1 THEN RETURN false; END IF;
      v_sum := v_sum + v_size;
    END LOOP;
    IF abs(v_sum - 1) > 0.002 THEN RETURN false; END IF;

    IF NOT (v_policy_evs ? v_hand.key)
       OR jsonb_typeof(v_policy_evs -> (v_hand.key)) <> 'number' THEN
      RETURN false;
    END IF;
    IF NOT (v_action_evs ? v_hand.key)
       OR jsonb_typeof(v_action_evs -> (v_hand.key)) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(v_action_evs -> (v_hand.key))) <>
          (SELECT count(*) FROM jsonb_object_keys(v_actions))
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_actions) a(key)
            WHERE NOT ((v_action_evs -> (v_hand.key)) ? a.key)) THEN
      RETURN false;
    END IF;
    FOR v_frequency IN SELECT key, value FROM jsonb_each(v_action_evs -> (v_hand.key)) LOOP
      IF NOT (v_actions ? v_frequency.key)
         OR jsonb_typeof(v_frequency.value) <> 'number' THEN
        RETURN false;
      END IF;
    END LOOP;
  END LOOP;

  IF EXISTS (
       SELECT 1 FROM jsonb_object_keys(v_policy_evs) AS k(value) WHERE NOT (v_matrix ? k.value)
     ) OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(v_action_evs) AS k(value) WHERE NOT (v_matrix ? k.value)
     ) THEN
    RETURN false;
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_cell_payload_valid(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_cell_payload_valid(jsonb) TO service_role;

DO $existing_contracts$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.gto_v31_source_artifacts a
      JOIN public.solved_spots_gold s ON s.id=a.source_row_id
      CROSS JOIN LATERAL jsonb_array_elements(s.strategy_matrix_v2->'nodes') n(value)
     WHERE NOT public.fn_gto_v31_source_node_valid(n.value)
  ) THEN
    RAISE EXCEPTION
      'cannot enforce canonical V31 source JSON while noncanonical certified artifacts exist; rebuild from licensed source';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.gto_v31_runtime_cells c
     WHERE NOT public.fn_gto_v31_cell_payload_valid(to_jsonb(c))
  ) THEN
    RAISE EXCEPTION
      'cannot enforce canonical V31 compact JSON while noncanonical runtime cells exist; rebuild from licensed source';
  END IF;
END;
$existing_contracts$;

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid='public.gto_v31_runtime_cells'::regclass
       AND conname='gto_v31_runtime_cells_compact_matrices_valid_chk'
  ) THEN
    ALTER TABLE public.gto_v31_runtime_cells
      ADD CONSTRAINT gto_v31_runtime_cells_compact_matrices_valid_chk
      CHECK (public.fn_gto_v31_compact_matrices_valid(
        hand_matrix,action_specs,policy_ev_matrix,action_ev_matrix,street
      ));
  END IF;
END;
$constraint$;

DO $contract_assertions$
DECLARE
  v_specs jsonb := jsonb_build_object(
    'check',jsonb_build_object(
      'family','check','size_unit','none','size_value',NULL,'all_in',false
    ),
    'bet75',jsonb_build_object(
      'family','bet','size_unit','pot_fraction','size_value',0.75,'all_in',false
    )
  );
  v_matrix jsonb := '{"AKo:21":{"check":0,"bet75":1}}'::jsonb;
  v_policy jsonb := '{"AKo:21":1}'::jsonb;
  v_action_evs jsonb := '{"AKo:21":{"check":0,"bet75":1}}'::jsonb;
BEGIN
  IF NOT public.fn_gto_v31_action_specs_valid(v_specs)
     OR NOT public.fn_gto_v31_compact_matrices_valid(
       v_matrix,v_specs,v_policy,v_action_evs,'flop'
     ) THEN
    RAISE EXCEPTION 'V31 canonical action or compact matrix was rejected';
  END IF;
  IF public.fn_gto_v31_action_specs_valid(
       jsonb_set(v_specs,'{bet75,size_value}','"0.75"'::jsonb)
     )
     OR public.fn_gto_v31_action_specs_valid(
       jsonb_set(v_specs,'{bet75,all_in}','"false"'::jsonb)
     )
     OR public.fn_gto_v31_compact_matrices_valid(
       '{"AKo:21":{"bet75":1}}'::jsonb,v_specs,v_policy,v_action_evs,'flop'
     ) THEN
    RAISE EXCEPTION 'V31 coercible action or sparse compact policy was accepted';
  END IF;
END;
$contract_assertions$;

COMMIT;
