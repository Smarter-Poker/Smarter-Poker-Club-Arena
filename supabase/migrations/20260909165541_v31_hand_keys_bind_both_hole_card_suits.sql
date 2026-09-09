-- V31 compact policies must preserve the board-suit relationship of BOTH
-- hole cards. The prior CLASS:count key selected one board suit (with an
-- arbitrary c/d/h/s tie break), so it merged:
--   * a real backdoor flush with an absent suit on rainbow/two-tone boards;
--   * an ace front-door blocker with a king front-door blocker;
--   * the two live flush suits on a 2-2 turn board.
-- A two-count key is suit-isomorphic while retaining rank-specific blocker
-- identity: CLASS:<high-rank-suit-board-count><low-rank-suit-board-count>.
-- Pair counts are sorted because equal ranks have no high/low identity.
--
-- Existing compact datasets cannot be rewritten without their licensed source
-- corpus. Refuse the first transition if any certified V31 dataset exists.
-- A replay after this exact function is installed remains safe.
BEGIN;

-- Serialize the emptiness proof with dataset registration. Otherwise a first
-- dataset could be inserted between the guard and the function replacement.
LOCK TABLE public.gto_v31_datasets IN ACCESS EXCLUSIVE MODE;

DO $migration_guard$
BEGIN
  IF public.fn_gto_v31_hand_key(1321,'Qs7s2c') IS DISTINCT FROM 'AKo:20' THEN
    IF EXISTS (SELECT 1 FROM public.gto_v31_datasets) THEN
      RAISE EXCEPTION
        'cannot change the V31 hand-key contract while certified datasets exist; rebuild from licensed source';
    END IF;
  END IF;
END;
$migration_guard$;

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
    RETURN v_suitedness = '' AND v_first_count >= v_second_count;
  END IF;
  RETURN COALESCE(
    v_suitedness IN ('s','o')
      AND position(v_first IN v_ranks) < position(v_second IN v_ranks)
      AND (v_suitedness <> 's' OR v_first_count = v_second_count),
    false
  );
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_hand_key_valid(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_hand_key_valid(text) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_hand_key(p_combo_index integer, p_board text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = public
AS $fn$
DECLARE
  v_cards text[] := public.fn_gto_v31_combo_cards(p_combo_index);
  v_ranks constant text := '23456789TJQKA';
  v_r1 text;
  v_r2 text;
  v_s1 text;
  v_s2 text;
  v_high text;
  v_low text;
  v_suffix text;
  v_count1 integer;
  v_count2 integer;
  v_high_count integer;
  v_low_count integer;
BEGIN
  IF p_board !~ '^([2-9TJQKA][cdhs]){3,5}$' THEN RETURN NULL; END IF;
  v_r1 := left(v_cards[1],1);
  v_s1 := right(v_cards[1],1);
  v_r2 := left(v_cards[2],1);
  v_s2 := right(v_cards[2],1);

  SELECT count(*) INTO v_count1
    FROM generate_series(2,length(p_board),2) n
   WHERE substr(p_board,n,1)=v_s1;
  SELECT count(*) INTO v_count2
    FROM generate_series(2,length(p_board),2) n
   WHERE substr(p_board,n,1)=v_s2;

  IF position(v_r1 IN v_ranks) > position(v_r2 IN v_ranks) THEN
    v_high := v_r1;
    v_low := v_r2;
    v_high_count := v_count1;
    v_low_count := v_count2;
  ELSIF position(v_r2 IN v_ranks) > position(v_r1 IN v_ranks) THEN
    v_high := v_r2;
    v_low := v_r1;
    v_high_count := v_count2;
    v_low_count := v_count1;
  ELSE
    v_high := v_r1;
    v_low := v_r2;
    v_high_count := greatest(v_count1,v_count2);
    v_low_count := least(v_count1,v_count2);
  END IF;

  v_suffix := CASE
    WHEN v_high=v_low THEN ''
    WHEN v_s1=v_s2 THEN 's'
    ELSE 'o'
  END;
  RETURN v_high || v_low || v_suffix || ':' || v_high_count || v_low_count;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_hand_key(integer,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_hand_key(integer,text) TO service_role;

COMMENT ON FUNCTION public.fn_gto_v31_hand_key(integer,text) IS
  'Canonical V31 hand abstraction CLASS:<board count in high-rank hole suit><board count in low-rank hole suit>; pair counts descending.';
COMMENT ON COLUMN public.gto_v31_runtime_cells.hand_matrix IS
  'Certified policy matrix keyed by the two-hole-suit V31 hand-key contract (for example AKo:20 or AKs:22).';

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
    IF NOT public.fn_gto_v31_hand_key_valid(v_hand.key)
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
  -- Rainbow: the suit present once is a real backdoor; an absent suit is not.
  IF public.fn_gto_v31_hand_key(1124,'As7d2c') IS DISTINCT FROM 'KQs:11'
     OR public.fn_gto_v31_hand_key(1077,'As7d2c') IS DISTINCT FROM 'KQs:00' THEN
    RAISE EXCEPTION 'V31 rainbow backdoor identity is lossy';
  END IF;

  -- Two-tone: bind the front-door suit to the exact hole-card rank.
  IF public.fn_gto_v31_hand_key(1172,'Qs7s2c') IS DISTINCT FROM 'AKs:11'
     OR public.fn_gto_v31_hand_key(1271,'Qs7s2c') IS DISTINCT FROM 'AKs:00'
     OR public.fn_gto_v31_hand_key(1321,'Qs7s2c') IS DISTINCT FROM 'AKo:20'
     OR public.fn_gto_v31_hand_key(1272,'Qs7s2c') IS DISTINCT FROM 'AKo:02' THEN
    RAISE EXCEPTION 'V31 rank-specific suit identity is lossy';
  END IF;

  -- A 2-2 turn has two live flush suits; neither may win a tie break.
  IF public.fn_gto_v31_hand_key(1322,'Qs7s2c3c') IS DISTINCT FROM 'AKs:22'
     OR public.fn_gto_v31_hand_key(1172,'Qs7s2c3c') IS DISTINCT FROM 'AKs:22'
     OR public.fn_gto_v31_hand_key(1271,'Qs7s2c3c') IS DISTINCT FROM 'AKs:00'
     OR public.fn_gto_v31_hand_key(1224,'Qs7s2c3c') IS DISTINCT FROM 'AA:20' THEN
    RAISE EXCEPTION 'V31 turn or pair suit identity is not canonical';
  END IF;

  IF NOT public.fn_gto_v31_hand_key_valid('AKo:20')
     OR NOT public.fn_gto_v31_hand_key_valid('AKo:02')
     OR NOT public.fn_gto_v31_hand_key_valid('AKs:22')
     OR NOT public.fn_gto_v31_hand_key_valid('AA:20')
     OR public.fn_gto_v31_hand_key_valid('AKs:20')
     OR public.fn_gto_v31_hand_key_valid('AA:02')
     OR public.fn_gto_v31_hand_key_valid('KAo:20')
     OR public.fn_gto_v31_hand_key_valid('AKs:2') THEN
    RAISE EXCEPTION 'V31 hand-key validator disagrees with the canonical contract';
  END IF;

END;
$contract_assertions$;

COMMIT;
