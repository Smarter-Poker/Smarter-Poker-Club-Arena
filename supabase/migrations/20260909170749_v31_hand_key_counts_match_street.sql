-- A compact hand key must be possible on the cell's exact street. The
-- generic two-suit syntax alone could previously admit impossible matrices,
-- such as AKo:31 on a three-card flop or AKs:55 on a four-card turn. Such
-- unreachable entries can inflate apparent corpus coverage even though the
-- action path can never generate them.
BEGIN;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_hand_key_valid(p_key text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  v_match text[];
  v_ranks constant text := 'AKQJT98765432';
  v_first text;
  v_second text;
  v_suitedness text;
  v_first_count integer;
  v_second_count integer;
BEGIN
  v_match := regexp_match(
    p_key,
    '^([AKQJT98765432])([AKQJT98765432])([so]?):([0-5])([0-5])$'
  );
  IF v_match IS NULL THEN RETURN false; END IF;
  v_first := v_match[1];
  v_second := v_match[2];
  v_suitedness := COALESCE(v_match[3],'');
  v_first_count := v_match[4]::integer;
  v_second_count := v_match[5]::integer;

  IF v_first = v_second THEN
    RETURN v_suitedness = ''
      AND v_first_count >= v_second_count
      AND v_first_count + v_second_count <= 5;
  END IF;
  RETURN COALESCE(
    v_suitedness IN ('s','o')
      AND position(v_first IN v_ranks) < position(v_second IN v_ranks)
      AND CASE v_suitedness
        WHEN 's' THEN v_first_count = v_second_count
        ELSE v_first_count + v_second_count <= 5
      END,
    false
  );
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_hand_key_valid(p_key text,p_street text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  v_match text[];
  v_board_cards integer;
  v_suitedness text;
  v_first_count integer;
  v_second_count integer;
BEGIN
  IF NOT public.fn_gto_v31_hand_key_valid(p_key) THEN RETURN false; END IF;
  v_board_cards := CASE p_street
    WHEN 'flop' THEN 3
    WHEN 'turn' THEN 4
    WHEN 'river' THEN 5
    ELSE NULL
  END;
  IF v_board_cards IS NULL THEN RETURN false; END IF;

  v_match := regexp_match(
    p_key,
    '^([AKQJT98765432])([AKQJT98765432])([so]?):([0-5])([0-5])$'
  );
  v_suitedness := COALESCE(v_match[3],'');
  v_first_count := v_match[4]::integer;
  v_second_count := v_match[5]::integer;
  IF v_suitedness = 's' THEN
    RETURN v_first_count <= v_board_cards;
  END IF;
  RETURN v_first_count + v_second_count <= v_board_cards;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_hand_matrix_valid(
  p_matrix jsonb,
  p_street text
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  v_key text;
BEGIN
  IF p_matrix IS NULL OR jsonb_typeof(p_matrix) <> 'object'
     OR NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_matrix)) THEN
    RETURN false;
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_matrix) LOOP
    IF NOT public.fn_gto_v31_hand_key_valid(v_key,p_street) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_hand_key_valid(text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_gto_v31_hand_key_valid(text,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_gto_v31_hand_matrix_valid(jsonb,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_hand_key_valid(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_hand_key_valid(text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_hand_matrix_valid(jsonb,text) TO service_role;

DO $existing_cells$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.gto_v31_runtime_cells c
     WHERE NOT public.fn_gto_v31_hand_matrix_valid(c.hand_matrix,c.street)
  ) THEN
    RAISE EXCEPTION
      'cannot enforce street-bound V31 hand keys while impossible runtime cells exist; rebuild from licensed source';
  END IF;
END;
$existing_cells$;

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid='public.gto_v31_runtime_cells'::regclass
       AND conname='gto_v31_runtime_cells_hand_keys_match_street_chk'
  ) THEN
    ALTER TABLE public.gto_v31_runtime_cells
      ADD CONSTRAINT gto_v31_runtime_cells_hand_keys_match_street_chk
      CHECK (public.fn_gto_v31_hand_matrix_valid(hand_matrix,street));
  END IF;
END;
$constraint$;

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

DO $contract_assertions$
BEGIN
  IF public.fn_gto_v31_hand_key_valid('AKo:55')
     OR public.fn_gto_v31_hand_key_valid('AA:33')
     OR public.fn_gto_v31_hand_key_valid('AKo:31','flop')
     OR public.fn_gto_v31_hand_key_valid('AKs:44','flop')
     OR public.fn_gto_v31_hand_key_valid('AKo:41','turn')
     OR public.fn_gto_v31_hand_key_valid('AKs:55','turn') THEN
    RAISE EXCEPTION 'V31 validator accepted an impossible suit-count key';
  END IF;
  IF NOT public.fn_gto_v31_hand_key_valid('AKo:21','flop')
     OR NOT public.fn_gto_v31_hand_key_valid('AKs:33','flop')
     OR NOT public.fn_gto_v31_hand_key_valid('AA:21','flop')
     OR NOT public.fn_gto_v31_hand_key_valid('AKo:31','turn')
     OR NOT public.fn_gto_v31_hand_key_valid('AKs:44','turn')
     OR NOT public.fn_gto_v31_hand_key_valid('AKo:50','river') THEN
    RAISE EXCEPTION 'V31 validator rejected a possible street-bound suit-count key';
  END IF;
  IF public.fn_gto_v31_hand_matrix_valid('{"AKo:31":{"check":1}}'::jsonb,'flop')
     OR NOT public.fn_gto_v31_hand_matrix_valid('{"AKo:21":{"check":1}}'::jsonb,'flop') THEN
    RAISE EXCEPTION 'V31 matrix validator disagrees with the street-bound key contract';
  END IF;
END;
$contract_assertions$;

COMMIT;
