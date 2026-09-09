-- ============================================================================
-- V31 AGREEMENT RECEIPTS BIND THE RUNTIME CELL
--
-- The nightly chart agreement is preflop-only.  A certified V31 postflop
-- corpus needs its own evidence path, and neither path may trust JSON text
-- coercions or caller-supplied summary arithmetic.  Persist every executed
-- V31 decision, bind it back to the promoted dataset and immutable runtime
-- cell, recompute policy agreement/regret in PostgreSQL, and audit each
-- reference independently so one receipt cannot hide the other's absence.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.horse_solver_agreement_v31_decisions (
  run_date                 date NOT NULL,
  reference                text NOT NULL CHECK (reference='gto_v31_certified'),
  state_key                text NOT NULL CHECK (length(state_key) BETWEEN 8 AND 512),
  decision_state           jsonb NOT NULL CHECK (jsonb_typeof(decision_state)='object'),
  stage                    text NOT NULL CHECK (stage IN ('flop','turn','river')),
  game_family              text NOT NULL CHECK (game_family IN ('cash','spin','tourney_ev','tourney_icm')),
  objective                text NOT NULL CHECK (objective IN ('cash_ev','chip_ev','icm')),
  utility_context          text NOT NULL CHECK (utility_context IN ('cash_ev','chip_ev','spin_ladder','satellite','bubble','final_table','in_money','ladder')),
  table_size               smallint NOT NULL CHECK (table_size BETWEEN 2 AND 10),
  pot_type                 text NOT NULL CHECK (pot_type IN ('limped','srp','3bet','4bet_plus')),
  hero_position            text NOT NULL CHECK (hero_position IN ('UTG','UTG1','UTG2','UTG3','MP','HJ','CO','BTN','SB','BB')),
  opponent_position        text NOT NULL CHECK (opponent_position IN ('UTG','UTG1','UTG2','UTG3','MP','HJ','CO','BTN','SB','BB')),
  depth_bucket             integer NOT NULL CHECK (depth_bucket IN (10,20,40,80,150)),
  texture_class            text NOT NULL CHECK (texture_class ~ '^[ABML][mtr][pu][cd]$'),
  node_role                text NOT NULL CHECK (node_role IN ('open','cbet','probe','delayed_cbet','barrel','facing_bet','facing_raise','check_raise','bet_raise','all_in')),
  facing_kind              text NOT NULL CHECK (facing_kind IN ('none','bet','raise','all_in')),
  facing_size_bucket       text NOT NULL CHECK (facing_size_bucket IN ('none','small','mid','big','all_in')),
  cell                     text NOT NULL CHECK (length(cell) BETWEEN 20 AND 512),
  hand_key                 text NOT NULL CHECK (length(hand_key) BETWEEN 5 AND 8),
  sampled_action_id        text NOT NULL CHECK (
    sampled_action_id ~ '^(c|f|b[1-9][0-9]{0,78})$'
  ),
  sampled_action_family    text NOT NULL CHECK (sampled_action_family IN ('check','fold','call','bet','raise','all_in')),
  final_action             text NOT NULL CHECK (final_action IN ('check','fold','call','bet','raise','all_in')),
  executed_as_intended     boolean NOT NULL,
  reference_distribution  jsonb NOT NULL CHECK (jsonb_typeof(reference_distribution)='object'),
  chosen_probability       numeric NOT NULL CHECK (chosen_probability BETWEEN 0 AND 1),
  action_regret_bb         numeric CHECK (action_regret_bb IS NULL OR action_regret_bb>=0),
  regret_eligible          boolean NOT NULL,
  pure_miss                boolean NOT NULL,
  source_seal              jsonb NOT NULL CHECK (jsonb_typeof(source_seal)='object'),
  created_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_date,reference,state_key),
  FOREIGN KEY (run_date,reference)
    REFERENCES public.horse_solver_agreement(run_date,reference) ON DELETE CASCADE,
  CHECK (hero_position<>opponent_position),
  CHECK ((regret_eligible AND action_regret_bb IS NOT NULL) OR
         (NOT regret_eligible AND action_regret_bb IS NULL))
);

CREATE INDEX IF NOT EXISTS horse_solver_agreement_v31_source
  ON public.horse_solver_agreement_v31_decisions
  (run_date DESC,(source_seal->>'dataset_id'),(source_seal->>'cell_key_checksum'));

ALTER TABLE public.horse_solver_agreement_v31_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.horse_solver_agreement_v31_decisions
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_horse_solver_v31_card_text(p_card jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path=public
AS $fn$
DECLARE
  v_suit text;
BEGIN
  IF p_card IS NULL OR jsonb_typeof(p_card)<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_card))<>2
     OR NOT (p_card ?& ARRAY['rank','suit'])
     OR jsonb_typeof(p_card->'rank')<>'string'
     OR jsonb_typeof(p_card->'suit')<>'string'
     OR p_card->>'rank' NOT IN ('2','3','4','5','6','7','8','9','T','J','Q','K','A')
     OR p_card->>'suit' NOT IN ('clubs','diamonds','hearts','spades') THEN
    RETURN NULL;
  END IF;
  v_suit:=CASE p_card->>'suit'
    WHEN 'clubs' THEN 'c' WHEN 'diamonds' THEN 'd'
    WHEN 'hearts' THEN 'h' WHEN 'spades' THEN 's' END;
  RETURN (p_card->>'rank')||v_suit;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.fn_horse_solver_v31_cards_text(
  p_cards jsonb,
  p_expected_count integer
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path=public
AS $fn$
DECLARE
  v_card jsonb;
  v_card_text text;
  v_result text:='';
  v_seen text[]:='{}'::text[];
BEGIN
  IF p_cards IS NULL OR jsonb_typeof(p_cards)<>'array'
     OR jsonb_array_length(p_cards)<>p_expected_count THEN RETURN NULL; END IF;
  FOR v_card IN SELECT value FROM jsonb_array_elements(p_cards) LOOP
    v_card_text:=public.fn_horse_solver_v31_card_text(v_card);
    IF v_card_text IS NULL OR v_card_text=ANY(v_seen) THEN RETURN NULL; END IF;
    v_seen:=v_seen||v_card_text;
    v_result:=v_result||v_card_text;
  END LOOP;
  RETURN v_result;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_horse_solver_v31_card_text(jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_horse_solver_v31_cards_text(jsonb,integer)
  FROM PUBLIC,anon,authenticated,service_role;

-- Keep the chart receipt contract strict as well.  Chart action EVs are not
-- stored in PostgreSQL, so regret remains a source-sealed diagnostic there;
-- probability and pure-miss arithmetic are nevertheless recomputed exactly.
CREATE OR REPLACE FUNCTION public.fn_horse_solver_agreement_decision(
  p_decision jsonb,
  p_reference text
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path=public
AS $fn$
DECLARE
  v_distribution jsonb:=p_decision->'reference_distribution';
  v_state jsonb:=p_decision->'decision_state';
  v_seal jsonb:=p_decision->'source_seal';
  v_sum numeric;
  v_chosen numeric;
  v_max numeric;
  v_expected_key text;
  v_expected_chart text;
  v_pure boolean;
BEGIN
  IF p_decision IS NULL OR jsonb_typeof(p_decision)<>'object'
     OR p_reference<>'gto_charts'
     OR (SELECT count(*) FROM jsonb_object_keys(p_decision))<>14
     OR NOT (p_decision ?& ARRAY[
       'state_key','decision_state','kind','game_type','position','stack_bb','hand',
       'final_action','reference_distribution','chosen_probability','action_regret_bb',
       'regret_eligible','pure_miss','source_seal'])
     OR EXISTS (SELECT 1 FROM unnest(ARRAY[
       'state_key','kind','game_type','position','hand','final_action'
     ]) f(key) WHERE jsonb_typeof(p_decision->f.key)<>'string')
     OR jsonb_typeof(p_decision->'stack_bb')<>'number'
     OR jsonb_typeof(p_decision->'chosen_probability')<>'number'
     OR jsonb_typeof(p_decision->'action_regret_bb') NOT IN ('number','null')
     OR jsonb_typeof(p_decision->'regret_eligible')<>'boolean'
     OR jsonb_typeof(p_decision->'pure_miss')<>'boolean'
     OR jsonb_typeof(v_state)<>'object'
     OR jsonb_typeof(v_distribution)<>'object'
     OR jsonb_typeof(v_seal)<>'object' THEN RETURN false; END IF;

  IF length(p_decision->>'state_key') NOT BETWEEN 8 AND 256
     OR p_decision->>'kind' NOT IN ('open_jam','bb_defend')
     OR p_decision->>'game_type' NOT IN ('Cash','Tournament')
     OR p_decision->>'position' NOT IN ('UTG','MP','HJ','CO','BTN','SB','BB')
     OR p_decision->>'hand' !~ '^[AKQJT98765432]{2}(s|o)?$'
     OR NOT public.fn_gto_v31_json_safe_integer(p_decision->'stack_bb',1,25)
     OR (p_decision->>'chosen_probability')::numeric NOT BETWEEN 0 AND 1
     OR (p_decision->'action_regret_bb'<>'null'::jsonb AND
         (p_decision->>'action_regret_bb')::numeric<0)
     OR (SELECT count(*) FROM jsonb_object_keys(v_state))<>12
     OR NOT (v_state ?& ARRAY[
       'schema_version','stage','game_variant','game_type','format','kind','position',
       'stack_bb','hand','chart','villain_action','legal_actions'])
     OR EXISTS (SELECT 1 FROM unnest(ARRAY[
       'stage','game_variant','game_type','format','kind','position','hand','chart','villain_action'
     ]) f(key) WHERE jsonb_typeof(v_state->f.key)<>'string')
     OR jsonb_typeof(v_state->'schema_version')<>'number'
     OR jsonb_typeof(v_state->'stack_bb')<>'number'
     OR jsonb_typeof(v_state->'legal_actions')<>'array'
     OR NOT public.fn_gto_v31_json_safe_integer(v_state->'schema_version',1,1)
     OR v_state->>'stage'<>'preflop' OR v_state->>'game_variant'<>'nlh'
     OR v_state->>'game_type'<>p_decision->>'game_type'
     OR v_state->>'format'<>(CASE WHEN p_decision->>'game_type'='Tournament' THEN 'mtt' ELSE 'cash' END)
     OR v_state->>'kind'<>p_decision->>'kind'
     OR v_state->>'position'<>p_decision->>'position'
     OR v_state->'stack_bb'<>p_decision->'stack_bb'
     OR v_state->>'hand'<>p_decision->>'hand'
     OR (SELECT count(*) FROM jsonb_object_keys(v_distribution))<>2
     OR EXISTS (SELECT 1 FROM jsonb_each(v_distribution)
                 WHERE jsonb_typeof(value)<>'number' OR (value#>>'{}')::numeric NOT BETWEEN 0 AND 1)
     OR (SELECT count(*) FROM jsonb_object_keys(v_seal))<>9
     OR NOT (v_seal ?& ARRAY[
       'quality_seal','policy_version','policy_checksum','system','artifact_id',
       'scenario_hash','source_artifact_checksum','provenance_complete','audited_at'])
     OR EXISTS (SELECT 1 FROM unnest(ARRAY[
       'quality_seal','policy_version','policy_checksum','system'
     ]) f(key) WHERE jsonb_typeof(v_seal->f.key)<>'string')
     OR EXISTS (SELECT 1 FROM unnest(ARRAY[
       'artifact_id','scenario_hash','source_artifact_checksum','audited_at'
     ]) f(key) WHERE jsonb_typeof(v_seal->f.key) NOT IN ('string','null'))
     OR jsonb_typeof(v_seal->'provenance_complete')<>'boolean'
     OR v_seal->>'quality_seal'<>'CHART_AUDITED'
     OR length(v_seal->>'policy_version') NOT BETWEEN 1 AND 160
     OR v_seal->>'policy_checksum'!~'^[0-9a-f]{64}$'
     OR v_seal->>'policy_checksum'=repeat('0',64)
     OR length(v_seal->>'system') NOT BETWEEN 1 AND 160
     OR (v_seal->>'provenance_complete')::boolean IS NOT true THEN RETURN false; END IF;

  IF v_seal->'audited_at'<>'null'::jsonb THEN
    PERFORM (v_seal->>'audited_at')::timestamptz;
  END IF;
  IF p_decision->>'kind'='open_jam' THEN
    IF NOT (v_distribution ?& ARRAY['push','fold'])
       OR p_decision->>'final_action' NOT IN ('push','fold')
       OR v_state->>'villain_action'<>'fold_to_hero'
       OR v_state->'legal_actions'<>'["push","fold"]'::jsonb THEN RETURN false; END IF;
  ELSE
    IF NOT (v_distribution ?& ARRAY['call','fold'])
       OR p_decision->>'final_action' NOT IN ('call','fold')
       OR v_state->>'villain_action'<>'sb_push'
       OR v_state->'legal_actions'<>'["call","fold"]'::jsonb THEN RETURN false; END IF;
  END IF;

  SELECT sum((value#>>'{}')::numeric),max((value#>>'{}')::numeric)
    INTO v_sum,v_max FROM jsonb_each(v_distribution);
  v_chosen:=(v_distribution->>(p_decision->>'final_action'))::numeric;
  v_pure:=v_max>=0.9 AND v_chosen<0.9;
  IF abs(v_sum-1)>0.000001
     OR abs(v_chosen-(p_decision->>'chosen_probability')::numeric)>0.000001
     OR (p_decision->>'pure_miss')::boolean IS DISTINCT FROM v_pure
     OR ((p_decision->>'regret_eligible')::boolean AND p_decision->'action_regret_bb'='null'::jsonb)
     OR (NOT (p_decision->>'regret_eligible')::boolean AND p_decision->'action_regret_bb'<>'null'::jsonb)
  THEN RETURN false; END IF;

  v_expected_key:=concat_ws('|',p_decision->>'game_type',p_decision->>'kind',
    p_decision->>'position',p_decision->>'stack_bb',p_decision->>'hand');
  v_expected_chart:=concat_ws('|',p_decision->>'game_type',
    CASE WHEN p_decision->>'kind'='open_jam' THEN 'fold_to_hero' ELSE 'sb_push' END,
    p_decision->>'position',p_decision->>'stack_bb');
  RETURN p_decision->>'state_key'=v_expected_key AND v_state->>'chart'=v_expected_chart;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.fn_horse_solver_agreement_v31_decision(p_decision jsonb)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=public
AS $fn$
DECLARE
  v_state jsonb:=p_decision->'decision_state';
  v_seal jsonb:=p_decision->'source_seal';
  v_distribution jsonb:=p_decision->'reference_distribution';
  v_dataset public.gto_v31_datasets%ROWTYPE;
  v_cell public.gto_v31_runtime_cells%ROWTYPE;
  v_board_count integer;
  v_board_text text;
  v_hole_text text;
  v_card_one integer;
  v_card_two integer;
  v_combo integer;
  v_expected_hand_key text;
  v_expected_cell text;
  v_expected_state_key text;
  v_spec jsonb;
  v_action_evs jsonb;
  v_selected_probability numeric;
  v_max_probability numeric;
  v_selected_ev numeric;
  v_regret numeric;
  v_expected_sample numeric;
  v_step numeric;
  v_amount_preserved boolean;
  v_executed boolean;
  v_expected_pure boolean;
BEGIN
  IF p_decision IS NULL OR jsonb_typeof(p_decision)<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_decision))<>27
     OR NOT (p_decision ?& ARRAY[
       'state_key','decision_state','stage','game_family','objective','utility_context',
       'table_size','pot_type','hero_position','opponent_position','depth_bucket',
       'texture_class','node_role','facing_kind','facing_size_bucket','cell','hand_key',
       'sampled_action_id','sampled_action_family','final_action','executed_as_intended',
       'reference_distribution','chosen_probability','action_regret_bb','regret_eligible',
       'pure_miss','source_seal'])
     OR EXISTS (SELECT 1 FROM unnest(ARRAY[
       'state_key','stage','game_family','objective','utility_context','pot_type',
       'hero_position','opponent_position','texture_class','node_role','facing_kind',
       'facing_size_bucket','cell','hand_key','sampled_action_id','sampled_action_family',
       'final_action'
     ]) f(key) WHERE jsonb_typeof(p_decision->f.key)<>'string')
     OR jsonb_typeof(p_decision->'table_size')<>'number'
     OR jsonb_typeof(p_decision->'depth_bucket')<>'number'
     OR jsonb_typeof(p_decision->'executed_as_intended')<>'boolean'
     OR jsonb_typeof(v_distribution)<>'object'
     OR jsonb_typeof(p_decision->'chosen_probability')<>'number'
     OR jsonb_typeof(p_decision->'action_regret_bb') NOT IN ('number','null')
     OR jsonb_typeof(p_decision->'regret_eligible')<>'boolean'
     OR jsonb_typeof(p_decision->'pure_miss')<>'boolean'
     OR jsonb_typeof(v_state)<>'object'
     OR jsonb_typeof(v_seal)<>'object' THEN RETURN false; END IF;

  IF length(p_decision->>'state_key') NOT BETWEEN 8 AND 512
     OR p_decision->>'stage' NOT IN ('flop','turn','river')
     OR p_decision->>'game_family' NOT IN ('cash','spin','tourney_ev','tourney_icm')
     OR p_decision->>'objective' NOT IN ('cash_ev','chip_ev','icm')
     OR p_decision->>'utility_context' NOT IN ('cash_ev','chip_ev','spin_ladder','satellite','bubble','final_table','in_money','ladder')
     OR NOT public.fn_gto_v31_json_safe_integer(p_decision->'table_size',2,10)
     OR p_decision->>'pot_type' NOT IN ('limped','srp','3bet','4bet_plus')
     OR p_decision->>'hero_position' NOT IN ('UTG','UTG1','UTG2','UTG3','MP','HJ','CO','BTN','SB','BB')
     OR p_decision->>'opponent_position' NOT IN ('UTG','UTG1','UTG2','UTG3','MP','HJ','CO','BTN','SB','BB')
     OR p_decision->>'hero_position'=p_decision->>'opponent_position'
     OR NOT public.fn_gto_v31_json_safe_integer(p_decision->'depth_bucket',10,150)
     OR (p_decision->>'depth_bucket')::integer NOT IN (10,20,40,80,150)
     OR p_decision->>'texture_class'!~'^[ABML][mtr][pu][cd]$'
     OR p_decision->>'node_role' NOT IN ('open','cbet','probe','delayed_cbet','barrel','facing_bet','facing_raise','check_raise','bet_raise','all_in')
     OR p_decision->>'facing_kind' NOT IN ('none','bet','raise','all_in')
     OR p_decision->>'facing_size_bucket' NOT IN ('none','small','mid','big','all_in')
     OR length(p_decision->>'cell') NOT BETWEEN 20 AND 512
     OR NOT public.fn_gto_v31_hand_key_valid(p_decision->>'hand_key',p_decision->>'stage')
     OR p_decision->>'sampled_action_id' !~ '^(c|f|b[1-9][0-9]{0,78})$'
     OR p_decision->>'sampled_action_family' NOT IN ('check','fold','call','bet','raise','all_in')
     OR p_decision->>'final_action' NOT IN ('check','fold','call','bet','raise','all_in')
     OR (p_decision->>'chosen_probability')::numeric NOT BETWEEN 0 AND 1
     OR (p_decision->'action_regret_bb'<>'null'::jsonb AND
         (p_decision->>'action_regret_bb')::numeric<0) THEN RETURN false; END IF;

  IF (SELECT count(*) FROM jsonb_object_keys(v_state))<>34
     OR NOT (v_state ?& ARRAY[
       'schema_version','street','game_variant','game_family','objective','utility_context',
       'format','table_size','pot_type','hero_position','opponent_position','stack_bb',
       'depth_bucket','texture_class','node_role','facing_kind','facing_size_bucket',
       'hand','hand_key','cell','board','hole_cards','pot','current_bet','to_call',
       'big_blind','probe_scenario','probe_ordinal','sampled_action_id',
       'sampled_action_family','sampled_amount','final_action','final_amount',
       'executed_as_intended'])
     OR EXISTS (SELECT 1 FROM unnest(ARRAY[
       'street','game_variant','game_family','objective','utility_context','format','pot_type',
       'hero_position','opponent_position','texture_class','node_role','facing_kind',
       'facing_size_bucket','hand','hand_key','cell','probe_scenario','sampled_action_id',
       'sampled_action_family','final_action'
     ]) f(key) WHERE jsonb_typeof(v_state->f.key)<>'string')
     OR EXISTS (SELECT 1 FROM unnest(ARRAY[
       'schema_version','table_size','stack_bb','depth_bucket','pot','current_bet',
       'to_call','big_blind','probe_ordinal'
     ]) f(key) WHERE jsonb_typeof(v_state->f.key)<>'number')
     OR jsonb_typeof(v_state->'sampled_amount') NOT IN ('number','null')
     OR jsonb_typeof(v_state->'final_amount') NOT IN ('number','null')
     OR jsonb_typeof(v_state->'board')<>'array'
     OR jsonb_typeof(v_state->'hole_cards')<>'array'
     OR jsonb_typeof(v_state->'executed_as_intended')<>'boolean'
     OR NOT public.fn_gto_v31_json_safe_integer(v_state->'schema_version',1,1)
     OR NOT public.fn_gto_v31_json_safe_integer(v_state->'table_size',2,10)
     OR NOT public.fn_gto_v31_json_safe_integer(v_state->'depth_bucket',10,150)
     OR NOT public.fn_gto_v31_json_safe_integer(v_state->'probe_ordinal',1,5000)
     OR (v_state->>'stack_bb')::numeric<=0 OR (v_state->>'stack_bb')::numeric>1000000
     OR (v_state->>'pot')::numeric<0 OR (v_state->>'pot')::numeric>9007199254740991
     OR (v_state->>'current_bet')::numeric<0 OR (v_state->>'current_bet')::numeric>9007199254740991
     OR (v_state->>'to_call')::numeric<0 OR (v_state->>'to_call')::numeric>9007199254740991
     OR (v_state->>'big_blind')::numeric<=0 OR (v_state->>'big_blind')::numeric>1000000
     OR (v_state->'sampled_amount'<>'null'::jsonb AND
         ((v_state->>'sampled_amount')::numeric<0 OR (v_state->>'sampled_amount')::numeric>9007199254740991))
     OR (v_state->'final_amount'<>'null'::jsonb AND
         ((v_state->>'final_amount')::numeric<0 OR (v_state->>'final_amount')::numeric>9007199254740991))
  THEN RETURN false; END IF;

  IF v_state->>'game_variant'<>'nlh'
     OR v_state->>'street'<>p_decision->>'stage'
     OR v_state->>'game_family'<>p_decision->>'game_family'
     OR v_state->>'objective'<>p_decision->>'objective'
     OR v_state->>'utility_context'<>p_decision->>'utility_context'
     OR v_state->'table_size'<>p_decision->'table_size'
     OR v_state->>'pot_type'<>p_decision->>'pot_type'
     OR v_state->>'hero_position'<>p_decision->>'hero_position'
     OR v_state->>'opponent_position'<>p_decision->>'opponent_position'
     OR v_state->'depth_bucket'<>p_decision->'depth_bucket'
     OR v_state->>'texture_class'<>p_decision->>'texture_class'
     OR v_state->>'node_role'<>p_decision->>'node_role'
     OR v_state->>'facing_kind'<>p_decision->>'facing_kind'
     OR v_state->>'facing_size_bucket'<>p_decision->>'facing_size_bucket'
     OR v_state->>'hand_key'<>p_decision->>'hand_key'
     OR v_state->>'cell'<>p_decision->>'cell'
     OR v_state->>'probe_scenario'<>v_state->>'utility_context'
     OR v_state->>'sampled_action_id'<>p_decision->>'sampled_action_id'
     OR v_state->>'sampled_action_family'<>p_decision->>'sampled_action_family'
     OR v_state->>'final_action'<>p_decision->>'final_action'
     OR (v_state->>'executed_as_intended')::boolean IS DISTINCT FROM
        (p_decision->>'executed_as_intended')::boolean
     OR NOT ((p_decision->>'game_family'='cash' AND p_decision->>'objective'='cash_ev'
              AND p_decision->>'utility_context'='cash_ev' AND v_state->>'format'='cash')
       OR (p_decision->>'game_family'='tourney_ev' AND p_decision->>'objective'='chip_ev'
              AND p_decision->>'utility_context'='chip_ev' AND v_state->>'format'='mtt')
       OR (p_decision->>'game_family'='spin' AND p_decision->>'objective'='chip_ev'
              AND p_decision->>'utility_context'='chip_ev' AND v_state->>'format'='spin')
       OR (p_decision->>'game_family'='spin' AND p_decision->>'objective'='icm'
              AND p_decision->>'utility_context'='spin_ladder' AND v_state->>'format'='spin')
       OR (p_decision->>'game_family'='tourney_icm' AND p_decision->>'objective'='icm'
              AND p_decision->>'utility_context' IN ('satellite','bubble','final_table','in_money','ladder')
              AND v_state->>'format'='mtt'))
  THEN RETURN false; END IF;

  v_board_count:=CASE p_decision->>'stage' WHEN 'flop' THEN 3 WHEN 'turn' THEN 4 ELSE 5 END;
  v_board_text:=public.fn_horse_solver_v31_cards_text(v_state->'board',v_board_count);
  v_hole_text:=public.fn_horse_solver_v31_cards_text(v_state->'hole_cards',2);
  IF v_board_text IS NULL OR v_hole_text IS NULL
     OR EXISTS (
       SELECT 1 FROM (
         SELECT public.fn_horse_solver_v31_card_text(value) card
           FROM jsonb_array_elements((v_state->'board')||(v_state->'hole_cards'))
       ) cards GROUP BY card HAVING count(*)>1
     ) THEN RETURN false; END IF;

  v_card_one:=(position(left(v_hole_text,1) IN '23456789TJQKA')-1)*4+
    position(substr(v_hole_text,2,1) IN 'cdhs')-1;
  v_card_two:=(position(substr(v_hole_text,3,1) IN '23456789TJQKA')-1)*4+
    position(substr(v_hole_text,4,1) IN 'cdhs')-1;
  v_combo:=greatest(v_card_one,v_card_two)*(greatest(v_card_one,v_card_two)-1)/2+
    least(v_card_one,v_card_two);
  v_expected_hand_key:=public.fn_gto_v31_hand_key(v_combo,v_board_text);
  IF v_expected_hand_key IS NULL OR v_state->>'hand_key'<>v_expected_hand_key
     OR v_state->>'hand'<>split_part(v_expected_hand_key,':',1)
     OR v_state->>'texture_class'<>public.fn_gto_texture_class_any(v_board_text)
  THEN RETURN false; END IF;

  v_expected_cell:=concat_ws('|',v_state->>'street',v_state->>'game_family',
    v_state->>'objective',v_state->>'utility_context',v_state->>'table_size',
    v_state->>'pot_type',v_state->>'hero_position',v_state->>'opponent_position',
    v_state->>'depth_bucket',v_state->>'texture_class',v_state->>'node_role',
    v_state->>'facing_kind',v_state->>'facing_size_bucket');
  v_expected_state_key:=concat_ws('|','v31',v_expected_cell,v_expected_hand_key,
    v_state->>'probe_scenario',v_state->>'probe_ordinal');
  IF v_state->>'cell'<>v_expected_cell OR p_decision->>'state_key'<>v_expected_state_key THEN
    RETURN false;
  END IF;

  IF (SELECT count(*) FROM jsonb_object_keys(v_seal))<>25
     OR NOT (v_seal ?& ARRAY[
       'dataset_id','dataset_key','dataset_checksum','solver_version',
       'solver_binary_checksum','pipeline_commit','pipeline_bundle_checksum',
       'manifest_version','manifest_checksum','source_artifact_checksum',
       'source_combo_order_checksum','range_bundle_checksum','icm_model_checksum',
       'input_bundle_checksum','cell_key_checksum','cell_payload_checksum',
       'lineage_checksum','quality_status','dataset_state','dataset_cells','source_rows',
       'train_source_rows','holdout_source_rows','invalid_rows','audited_at'])
     OR EXISTS (SELECT 1 FROM unnest(ARRAY[
       'dataset_id','dataset_key','dataset_checksum','solver_version',
       'solver_binary_checksum','pipeline_commit','pipeline_bundle_checksum',
       'manifest_version','manifest_checksum','source_artifact_checksum',
       'source_combo_order_checksum','range_bundle_checksum','icm_model_checksum',
       'input_bundle_checksum','cell_key_checksum','cell_payload_checksum',
       'lineage_checksum','quality_status','dataset_state','audited_at'
     ]) f(key) WHERE jsonb_typeof(v_seal->f.key)<>'string')
     OR EXISTS (SELECT 1 FROM unnest(ARRAY[
       'dataset_cells','source_rows','train_source_rows','holdout_source_rows','invalid_rows'
     ]) f(key) WHERE jsonb_typeof(v_seal->f.key)<>'number')
     OR v_seal->>'dataset_id' !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR v_seal->>'quality_status'<>'validated'
     OR v_seal->>'dataset_state'<>'active'
     OR NOT public.fn_gto_v31_json_safe_integer(v_seal->'dataset_cells',1,9007199254740991)
     OR NOT public.fn_gto_v31_json_safe_integer(v_seal->'source_rows',1,9007199254740991)
     OR NOT public.fn_gto_v31_json_safe_integer(v_seal->'train_source_rows',1,9007199254740991)
     OR NOT public.fn_gto_v31_json_safe_integer(v_seal->'holdout_source_rows',1,9007199254740991)
     OR NOT public.fn_gto_v31_json_safe_integer(v_seal->'invalid_rows',0,0)
  THEN RETURN false; END IF;

  SELECT * INTO v_dataset FROM public.gto_v31_datasets d
   WHERE d.dataset_id=(v_seal->>'dataset_id')::uuid
     AND d.state='active' AND d.promoted_at IS NOT NULL
     AND d.quality_status='validated' AND d.invalid_rows=0;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.gto_v31_input_bundles b
     WHERE b.input_bundle_id=v_dataset.input_bundle_id
       AND b.approval_status='approved' AND b.bundle_checksum=v_dataset.input_bundle_checksum
  ) THEN RETURN false; END IF;
  SELECT * INTO v_cell FROM public.gto_v31_runtime_cells c
   WHERE c.dataset_id=v_dataset.dataset_id
     AND c.cell_key_checksum=v_seal->>'cell_key_checksum';
  IF NOT FOUND THEN RETURN false; END IF;

  IF v_seal->>'dataset_key'<>v_dataset.dataset_key
     OR v_seal->>'dataset_checksum'<>v_dataset.dataset_checksum
     OR v_seal->>'solver_version'<>v_dataset.solver_version
     OR v_seal->>'solver_binary_checksum'<>v_dataset.solver_binary_checksum
     OR v_seal->>'pipeline_commit'<>v_dataset.pipeline_commit
     OR v_seal->>'pipeline_bundle_checksum'<>v_dataset.pipeline_bundle_checksum
     OR v_seal->>'manifest_version'<>v_dataset.manifest_version
     OR v_seal->>'manifest_checksum'<>v_dataset.manifest_checksum
     OR v_seal->>'source_artifact_checksum'<>v_dataset.source_artifact_checksum
     OR v_seal->>'source_combo_order_checksum'<>v_dataset.source_combo_order_checksum
     OR v_seal->>'range_bundle_checksum'<>v_dataset.range_bundle_checksum
     OR v_seal->>'icm_model_checksum'<>v_dataset.icm_model_checksum
     OR v_seal->>'input_bundle_checksum'<>v_dataset.input_bundle_checksum
     OR v_seal->>'cell_payload_checksum'<>v_cell.cell_payload_checksum
     OR v_seal->>'lineage_checksum'<>v_cell.lineage_checksum
     OR (v_seal->>'dataset_cells')::bigint<>(v_dataset.coverage->>'cells')::bigint
     OR (v_seal->>'source_rows')::bigint<>v_dataset.source_rows
     OR (v_seal->>'train_source_rows')::bigint<>v_dataset.train_source_rows
     OR (v_seal->>'holdout_source_rows')::bigint<>v_dataset.holdout_source_rows
     OR (v_seal->>'audited_at')::timestamptz IS DISTINCT FROM v_dataset.audited_at
     OR v_cell.street<>p_decision->>'stage'
     OR v_cell.game_family<>p_decision->>'game_family'
     OR v_cell.objective<>p_decision->>'objective'
     OR v_cell.utility_context<>p_decision->>'utility_context'
     OR v_cell.table_size<>(p_decision->>'table_size')::integer
     OR v_cell.pot_type<>p_decision->>'pot_type'
     OR v_cell.hero_position<>p_decision->>'hero_position'
     OR v_cell.opponent_position<>p_decision->>'opponent_position'
     OR v_cell.depth_bucket<>(p_decision->>'depth_bucket')::integer
     OR v_cell.texture_class<>p_decision->>'texture_class'
     OR v_cell.node_role<>p_decision->>'node_role'
     OR v_cell.facing_kind<>p_decision->>'facing_kind'
     OR v_cell.facing_size_bucket<>p_decision->>'facing_size_bucket'
  THEN RETURN false; END IF;

  v_spec:=v_cell.action_specs->(p_decision->>'sampled_action_id');
  v_action_evs:=v_cell.action_ev_matrix->(p_decision->>'hand_key');
  IF jsonb_typeof(v_spec)<>'object'
     OR v_spec->>'family'<>p_decision->>'sampled_action_family'
     OR NOT (v_cell.hand_matrix ? (p_decision->>'hand_key'))
     OR v_distribution<>v_cell.hand_matrix->(p_decision->>'hand_key')
     OR NOT (v_distribution ? (p_decision->>'sampled_action_id'))
     OR jsonb_typeof(v_action_evs)<>'object'
     OR NOT (v_action_evs ? (p_decision->>'sampled_action_id')) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each(v_distribution)
              WHERE jsonb_typeof(value)<>'number' OR (value#>>'{}')::numeric NOT BETWEEN 0 AND 1)
     OR abs((SELECT sum((value#>>'{}')::numeric) FROM jsonb_each(v_distribution))-1)>0.002
  THEN RETURN false; END IF;

  v_selected_probability:=(v_distribution->>(p_decision->>'sampled_action_id'))::numeric;
  SELECT max((value#>>'{}')::numeric) INTO v_max_probability FROM jsonb_each(v_distribution);
  v_selected_ev:=(v_action_evs->>(p_decision->>'sampled_action_id'))::numeric;
  SELECT greatest(0,max((value#>>'{}')::numeric)-v_selected_ev)
    INTO v_regret FROM jsonb_each(v_action_evs);

  IF p_decision->>'sampled_action_family' IN ('check','fold','all_in') THEN
    IF v_state->'sampled_amount'<>'null'::jsonb THEN RETURN false; END IF;
  ELSIF p_decision->>'sampled_action_family'='call' THEN
    v_expected_sample:=(v_state->>'to_call')::numeric;
  ELSIF p_decision->>'sampled_action_family'='bet' THEN
    v_expected_sample:=(v_state->>'pot')::numeric*(v_spec->>'size_value')::numeric;
  ELSE
    v_expected_sample:=(v_state->>'current_bet')::numeric+
      ((v_state->>'pot')::numeric+(v_state->>'to_call')::numeric)*(v_spec->>'size_value')::numeric;
  END IF;
  IF v_expected_sample IS NOT NULL AND
     (v_state->'sampled_amount'='null'::jsonb OR
      abs((v_state->>'sampled_amount')::numeric-v_expected_sample)>0.0001) THEN RETURN false; END IF;

  IF p_decision->>'final_action' IN ('check','fold','all_in') THEN
    IF v_state->'final_amount'<>'null'::jsonb THEN RETURN false; END IF;
  ELSIF v_state->'final_amount'='null'::jsonb THEN RETURN false;
  END IF;
  v_step:=CASE WHEN (v_state->>'big_blind')::numeric>=1
                    AND (v_state->>'big_blind')::numeric=trunc((v_state->>'big_blind')::numeric)
               THEN 1 ELSE 0.01 END;
  v_amount_preserved:=v_state->'sampled_amount'<>'null'::jsonb
    AND v_state->'final_amount'<>'null'::jsonb
    AND abs((v_state->>'sampled_amount')::numeric-(v_state->>'final_amount')::numeric)<=v_step+0.005;
  v_executed:=CASE p_decision->>'sampled_action_family'
    WHEN 'call' THEN p_decision->>'final_action'='all_in' OR
      (p_decision->>'final_action'='call' AND v_amount_preserved)
    WHEN 'bet' THEN p_decision->>'final_action'='bet' AND v_amount_preserved
    WHEN 'raise' THEN p_decision->>'final_action'='raise' AND v_amount_preserved
    ELSE p_decision->>'final_action'=p_decision->>'sampled_action_family' END;
  v_expected_pure:=v_max_probability>=0.9 AND
    (NOT v_executed OR v_selected_probability<0.9);

  IF (p_decision->>'executed_as_intended')::boolean IS DISTINCT FROM v_executed
     OR abs((p_decision->>'chosen_probability')::numeric-
       CASE WHEN v_executed THEN v_selected_probability ELSE 0 END)>0.000001
     OR (p_decision->>'regret_eligible')::boolean IS DISTINCT FROM v_executed
     OR (v_executed AND (p_decision->'action_regret_bb'='null'::jsonb OR
         abs((p_decision->>'action_regret_bb')::numeric-v_regret)>0.0001))
     OR (NOT v_executed AND p_decision->'action_regret_bb'<>'null'::jsonb)
     OR (p_decision->>'pure_miss')::boolean IS DISTINCT FROM v_expected_pure
  THEN RETURN false; END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_horse_solver_agreement_decision(jsonb,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_solver_agreement_decision(jsonb,text)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_horse_solver_agreement_v31_decision(jsonb)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_horse_solver_agreement_add(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $fn$
DECLARE
  r jsonb;
  d jsonb;
  n integer:=0;
  v_run_date date;
  v_reference text;
  v_decisions jsonb;
  v_count integer;
  v_pure integer;
  v_regret_count integer;
  v_agreement numeric;
  v_regret numeric;
  v_checksum text;
  v_contexts integer;
  v_context_min integer;
  v_context_max integer;
BEGIN
  IF COALESCE(auth.role(),'')<>'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows)<>'array'
     OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 2 THEN
    RAISE EXCEPTION 'p_rows must be an array of one or two reference rows';
  END IF;
  IF (SELECT count(DISTINCT concat_ws('|',value->>'run_date',value->>'reference'))
        FROM jsonb_array_elements(p_rows))<>jsonb_array_length(p_rows) THEN
    RAISE EXCEPTION 'p_rows repeats a solver agreement reference day';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rows) item(value)
     WHERE item.value->>'reference'='gto_v31_certified'
  ) THEN
    -- Serialize current-corpus proof with promotion. Otherwise a store loaded
    -- before a concurrent promotion could begin on the old active dataset and
    -- finish after it was retired, producing a mixed or stale daily receipt.
    PERFORM pg_advisory_xact_lock(
      hashtextextended('smarter-poker:gto-v31-release-gate',0)
    );
  END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    IF jsonb_typeof(r)<>'object'
       OR (SELECT count(*) FROM jsonb_object_keys(r))<>11
       OR NOT (r ?& ARRAY[
         'run_date','reference','spots','agreement','pure_misses','eligible_spots',
         'reconciled_spots','action_regret_bb','regret_eligible_spots',
         'decision_checksum','decisions'])
       OR jsonb_typeof(r->'run_date')<>'string'
       OR jsonb_typeof(r->'reference')<>'string'
       OR EXISTS (SELECT 1 FROM unnest(ARRAY[
         'spots','pure_misses','eligible_spots','reconciled_spots','regret_eligible_spots'
       ]) f(key) WHERE jsonb_typeof(r->f.key)<>'number')
       OR jsonb_typeof(r->'agreement')<>'number'
       OR jsonb_typeof(r->'action_regret_bb') NOT IN ('number','null')
       OR jsonb_typeof(r->'decision_checksum')<>'string'
       OR jsonb_typeof(r->'decisions')<>'array'
       OR r->>'run_date'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       OR r->>'reference' NOT IN ('gto_charts','gto_v31_certified')
       OR r->>'decision_checksum'!~'^[0-9a-f]{64}$'
       OR r->>'decision_checksum'=repeat('0',64)
       OR jsonb_array_length(r->'decisions') NOT BETWEEN 1 AND 5000
       OR NOT public.fn_gto_v31_json_safe_integer(r->'spots',1,5000)
       OR NOT public.fn_gto_v31_json_safe_integer(r->'pure_misses',0,5000)
       OR NOT public.fn_gto_v31_json_safe_integer(r->'eligible_spots',1,5000)
       OR NOT public.fn_gto_v31_json_safe_integer(r->'reconciled_spots',1,5000)
       OR NOT public.fn_gto_v31_json_safe_integer(r->'regret_eligible_spots',0,5000)
       OR (r->>'agreement')::numeric NOT BETWEEN 0 AND 1
       OR (r->'action_regret_bb'<>'null'::jsonb AND (r->>'action_regret_bb')::numeric<0)
    THEN RAISE EXCEPTION 'solver agreement row is incomplete'; END IF;
    v_run_date:=(r->>'run_date')::date;
    IF to_char(v_run_date,'YYYY-MM-DD')<>r->>'run_date' THEN
      RAISE EXCEPTION 'solver agreement date is not canonical';
    END IF;
    v_reference:=r->>'reference';
    v_decisions:=r->'decisions';

    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_decisions) item(value)
       WHERE CASE v_reference
         WHEN 'gto_charts' THEN NOT public.fn_horse_solver_agreement_decision(item.value,v_reference)
         ELSE NOT public.fn_horse_solver_agreement_v31_decision(item.value) END
    ) THEN RAISE EXCEPTION 'solver agreement contains an invalid decision'; END IF;
    IF (SELECT count(DISTINCT value->>'state_key') FROM jsonb_array_elements(v_decisions))
       <>jsonb_array_length(v_decisions) THEN
      RAISE EXCEPTION 'solver agreement contains duplicate state keys';
    END IF;
    IF v_reference='gto_v31_certified' AND (
      SELECT count(DISTINCT concat_ws('|',value#>>'{source_seal,dataset_id}',
        value#>>'{source_seal,dataset_checksum}')) FROM jsonb_array_elements(v_decisions)
    )<>1 THEN RAISE EXCEPTION 'V31 agreement mixes dataset identities'; END IF;
    IF v_reference='gto_v31_certified' THEN
      SELECT count(*),min(context_rows),max(context_rows)
        INTO v_contexts,v_context_min,v_context_max
        FROM (
          SELECT count(*)::integer AS context_rows
            FROM jsonb_array_elements(v_decisions) item(value)
           GROUP BY value->>'game_family',value->>'utility_context'
        ) context_counts;
      IF v_contexts=9 AND v_context_max-v_context_min>1 THEN
        RAISE EXCEPTION 'V31 agreement context sampling is imbalanced';
      END IF;
    END IF;

    SELECT count(*),count(*) FILTER (WHERE (value->>'pure_miss')::boolean),
           count(*) FILTER (WHERE (value->>'regret_eligible')::boolean),
           avg((value->>'chosen_probability')::numeric),
           avg((value->>'action_regret_bb')::numeric)
             FILTER (WHERE (value->>'regret_eligible')::boolean)
      INTO v_count,v_pure,v_regret_count,v_agreement,v_regret
      FROM jsonb_array_elements(v_decisions);
    IF (r->>'spots')::integer<>v_count
       OR (r->>'eligible_spots')::integer<>v_count
       OR (r->>'reconciled_spots')::integer<>v_count
       OR (r->>'pure_misses')::integer<>v_pure
       OR (r->>'regret_eligible_spots')::integer<>v_regret_count
       OR abs((r->>'agreement')::numeric-v_agreement)>0.0001
       OR (v_regret IS NULL AND r->'action_regret_bb'<>'null'::jsonb)
       OR (v_regret IS NOT NULL AND (r->'action_regret_bb'='null'::jsonb OR
           abs((r->>'action_regret_bb')::numeric-v_regret)>0.0001)) THEN
      RAISE EXCEPTION 'solver agreement summary does not reconcile to decisions';
    END IF;

    INSERT INTO public.horse_solver_agreement AS t (
      run_date,reference,spots,agreement,pure_misses,eligible_spots,reconciled_spots,
      action_regret_bb,regret_eligible_spots,decision_checksum
    ) VALUES (
      v_run_date,v_reference,v_count,v_agreement,v_pure,v_count,v_count,
      v_regret,v_regret_count,NULL
    ) ON CONFLICT (run_date,reference) DO UPDATE SET
      spots=excluded.spots,agreement=excluded.agreement,pure_misses=excluded.pure_misses,
      eligible_spots=excluded.eligible_spots,reconciled_spots=excluded.reconciled_spots,
      action_regret_bb=excluded.action_regret_bb,
      regret_eligible_spots=excluded.regret_eligible_spots,
      decision_checksum=NULL,created_at=now();

    DELETE FROM public.horse_solver_agreement_decisions
     WHERE run_date=v_run_date AND reference=v_reference;
    DELETE FROM public.horse_solver_agreement_v31_decisions
     WHERE run_date=v_run_date AND reference=v_reference;
    FOR d IN SELECT value FROM jsonb_array_elements(v_decisions) LOOP
      IF v_reference='gto_charts' THEN
        INSERT INTO public.horse_solver_agreement_decisions (
          run_date,reference,state_key,decision_state,kind,game_type,position,stack_bb,
          hand,final_action,reference_distribution,chosen_probability,action_regret_bb,
          regret_eligible,pure_miss,source_seal
        ) VALUES (
          v_run_date,v_reference,d->>'state_key',d->'decision_state',d->>'kind',
          d->>'game_type',d->>'position',(d->>'stack_bb')::numeric,d->>'hand',
          d->>'final_action',d->'reference_distribution',(d->>'chosen_probability')::numeric,
          (d->>'action_regret_bb')::numeric,(d->>'regret_eligible')::boolean,
          (d->>'pure_miss')::boolean,d->'source_seal');
      ELSE
        INSERT INTO public.horse_solver_agreement_v31_decisions (
          run_date,reference,state_key,decision_state,stage,game_family,objective,
          utility_context,table_size,pot_type,hero_position,opponent_position,
          depth_bucket,texture_class,node_role,facing_kind,facing_size_bucket,cell,
          hand_key,sampled_action_id,sampled_action_family,final_action,
          executed_as_intended,reference_distribution,chosen_probability,
          action_regret_bb,regret_eligible,pure_miss,source_seal
        ) VALUES (
          v_run_date,v_reference,d->>'state_key',d->'decision_state',d->>'stage',
          d->>'game_family',d->>'objective',d->>'utility_context',
          (d->>'table_size')::integer,d->>'pot_type',d->>'hero_position',
          d->>'opponent_position',(d->>'depth_bucket')::integer,d->>'texture_class',
          d->>'node_role',d->>'facing_kind',d->>'facing_size_bucket',d->>'cell',
          d->>'hand_key',d->>'sampled_action_id',d->>'sampled_action_family',
          d->>'final_action',(d->>'executed_as_intended')::boolean,
          d->'reference_distribution',(d->>'chosen_probability')::numeric,
          (d->>'action_regret_bb')::numeric,(d->>'regret_eligible')::boolean,
          (d->>'pure_miss')::boolean,d->'source_seal');
      END IF;
    END LOOP;

    IF v_reference='gto_charts' THEN
      SELECT public.fn_gto_v31_json_checksum(jsonb_agg(
        to_jsonb(x)-ARRAY['run_date','reference','created_at']::text[] ORDER BY x.state_key))
        INTO v_checksum FROM public.horse_solver_agreement_decisions x
       WHERE x.run_date=v_run_date AND x.reference=v_reference;
    ELSE
      SELECT public.fn_gto_v31_json_checksum(jsonb_agg(
        to_jsonb(x)-ARRAY['run_date','reference','created_at']::text[] ORDER BY x.state_key))
        INTO v_checksum FROM public.horse_solver_agreement_v31_decisions x
       WHERE x.run_date=v_run_date AND x.reference=v_reference;
    END IF;
    UPDATE public.horse_solver_agreement SET decision_checksum=v_checksum
     WHERE run_date=v_run_date AND reference=v_reference;
    n:=n+1;
  END LOOP;
  RETURN n;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_horse_solver_agreement_add(jsonb)
  FROM PUBLIC,authenticated,anon;
GRANT EXECUTE ON FUNCTION public.fn_horse_solver_agreement_add(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_audit_solver_agreement(p_day date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=public
AS $fn$
DECLARE
  v jsonb:='[]'::jsonb;
  r record;
  prev numeric;
  v_details integer;
  v_checksum text;
  v_chart_seen boolean:=false;
  v_v31_seen boolean:=false;
  v_v31_required boolean;
  v_code text;
  v_scope text;
  v_active_dataset_id uuid;
  v_active_dataset_checksum text;
  v_v31_contexts integer;
  v_v31_context_min integer;
  v_v31_context_max integer;
  v_v31_dataset_count integer;
  v_v31_dataset_id text;
  v_v31_dataset_checksum text;
BEGIN
  SELECT dataset_id,dataset_checksum INTO v_active_dataset_id,v_active_dataset_checksum
    FROM public.gto_v31_datasets WHERE state='active' LIMIT 1;
  v_v31_required:=FOUND;
  FOR r IN
    SELECT * FROM public.horse_solver_agreement
     WHERE reference IN ('gto_charts','gto_v31_certified')
       AND run_date=p_day
     ORDER BY reference
  LOOP
    v_v31_contexts:=NULL;
    v_v31_dataset_count:=NULL;
    v_v31_dataset_id:=NULL;
    v_v31_dataset_checksum:=NULL;
    v_v31_context_min:=NULL;
    v_v31_context_max:=NULL;
    v_chart_seen:=v_chart_seen OR r.reference='gto_charts';
    v_v31_seen:=v_v31_seen OR r.reference='gto_v31_certified';
    IF r.reference='gto_charts' THEN
      SELECT count(*),CASE WHEN count(*)>0 THEN public.fn_gto_v31_json_checksum(jsonb_agg(
          to_jsonb(d)-ARRAY['run_date','reference','created_at']::text[] ORDER BY d.state_key)) END
        INTO v_details,v_checksum FROM public.horse_solver_agreement_decisions d
       WHERE d.run_date=r.run_date AND d.reference=r.reference;
      v_scope:='preflop chart agreement';
    ELSE
      SELECT count(*),CASE WHEN count(*)>0 THEN public.fn_gto_v31_json_checksum(jsonb_agg(
          to_jsonb(d)-ARRAY['run_date','reference','created_at']::text[] ORDER BY d.state_key)) END,
          count(DISTINCT d.game_family||'|'||d.utility_context),
          count(DISTINCT concat_ws('|',d.source_seal->>'dataset_id',
            d.source_seal->>'dataset_checksum')),
          min(d.source_seal->>'dataset_id'),min(d.source_seal->>'dataset_checksum')
        INTO v_details,v_checksum,v_v31_contexts,v_v31_dataset_count,
          v_v31_dataset_id,v_v31_dataset_checksum
        FROM public.horse_solver_agreement_v31_decisions d
       WHERE d.run_date=r.run_date AND d.reference=r.reference;
      SELECT min(context_rows),max(context_rows)
        INTO v_v31_context_min,v_v31_context_max
        FROM (
          SELECT count(*)::integer AS context_rows
            FROM public.horse_solver_agreement_v31_decisions d
           WHERE d.run_date=r.run_date AND d.reference=r.reference
           GROUP BY d.game_family,d.utility_context
        ) context_counts;
      v_scope:='certified V31 execution agreement';
    END IF;
    SELECT agreement INTO prev FROM public.horse_solver_agreement
     WHERE reference=r.reference AND run_date<r.run_date ORDER BY run_date DESC LIMIT 1;

    IF r.reference='gto_v31_certified' AND v_v31_required AND
       (v_v31_dataset_count<>1
        OR v_v31_dataset_id IS DISTINCT FROM v_active_dataset_id::text
        OR v_v31_dataset_checksum IS DISTINCT FROM v_active_dataset_checksum) THEN
      v:=v||jsonb_build_object('severity','critical','category','gto',
        'code','solver_agreement_v31_stale_dataset',
        'title','Certified V31 agreement is not bound to the current active dataset',
        'evidence',jsonb_build_object('run_date',r.run_date,
          'receipt_dataset_id',v_v31_dataset_id,
          'receipt_dataset_checksum',v_v31_dataset_checksum,
          'receipt_dataset_count',v_v31_dataset_count,
          'active_dataset_id',v_active_dataset_id,
          'active_dataset_checksum',v_active_dataset_checksum),
        'recommendation','Re-run HorseLeague.agreement.v31 against the currently active in-memory corpus; a retired corpus cannot prove current execution.');
    END IF;
    IF r.reference='gto_v31_certified' AND COALESCE(v_v31_contexts,0)<>9 THEN
      v:=v||jsonb_build_object('severity','critical','category','gto',
        'code','solver_agreement_v31_missing_scenarios',
        'title','Certified V31 agreement did not execute all nine required family and utility contexts',
        'evidence',jsonb_build_object('run_date',r.run_date,
          'scenario_contexts',COALESCE(v_v31_contexts,0),'required_contexts',9),
        'recommendation','Inspect the active-cell gates for the missing scenario and reject partial V31 agreement evidence.');
    END IF;
    IF r.reference='gto_v31_certified' AND v_v31_contexts=9
       AND v_v31_context_max-v_v31_context_min>1 THEN
      v:=v||jsonb_build_object('severity','critical','category','gto',
        'code','solver_agreement_v31_imbalanced_scenarios',
        'title','Certified V31 agreement over-sampled some required contexts',
        'evidence',jsonb_build_object('run_date',r.run_date,
          'scenario_contexts',v_v31_contexts,'minimum_context_spots',v_v31_context_min,
          'maximum_context_spots',v_v31_context_max),
        'recommendation','Re-run the balanced nine-context V31 probe; no context may exceed another by more than one spot.');
    END IF;

    IF r.eligible_spots<>r.reconciled_spots OR r.reconciled_spots<>v_details
       OR r.decision_checksum IS NULL OR r.decision_checksum IS DISTINCT FROM v_checksum THEN
      v:=v||jsonb_build_object('severity','critical','category','gto',
        'code','solver_agreement_unreconciled','title',v_scope||' decisions do not reconcile',
        'evidence',jsonb_build_object('run_date',r.run_date,'reference',r.reference,
          'eligible',r.eligible_spots,'reconciled',r.reconciled_spots,
          'decision_rows',v_details,'checksum',r.decision_checksum),
        'recommendation','Re-run the exact agreement probe through fn_horse_solver_agreement_add; never use a summary-only score as release evidence.');
    ELSIF r.spots<50 THEN
      v_code:=CASE WHEN r.reference='gto_v31_certified' THEN 'solver_agreement_v31_thin' ELSE 'solver_agreement_thin' END;
      v:=v||jsonb_build_object('severity','warn','category','gto','code',v_code,
        'title',v_scope||' probed only '||r.spots||' spots on '||r.run_date,
        'evidence',jsonb_build_object('spots',r.spots,'reference',r.reference),
        'recommendation','Inspect the immutable decision receipts and active in-memory reference coverage; thin coverage is not evidence of improvement.');
    ELSIF prev IS NOT NULL AND r.agreement<prev-0.03 THEN
      v_code:=CASE WHEN r.reference='gto_v31_certified' THEN 'solver_agreement_v31_dropped' ELSE 'solver_agreement_dropped' END;
      v:=v||jsonb_build_object('severity','critical','category','gto','code',v_code,
        'title',v_scope||' fell to '||round(r.agreement,3)||' from '||round(prev,3),
        'evidence',jsonb_build_object('agreement',r.agreement,'previous',prev,
          'spots',r.spots,'pure_misses',r.pure_misses,'reference',r.reference,
          'checksum',r.decision_checksum),
        'recommendation','Diff the engine deploy and inspect the persisted pure-miss and execution-mismatch decisions before changing strategy.');
    ELSE
      v_code:=CASE WHEN r.reference='gto_v31_certified' THEN 'solver_agreement_v31' ELSE 'solver_agreement' END;
      v:=v||jsonb_build_object('severity','info','category','gto','code',v_code,
        'title',v_scope||' '||round(r.agreement,3)||' over '||r.spots||' reconciled spots',
        'evidence',jsonb_build_object('agreement',r.agreement,'previous',prev,
          'spots',r.spots,'pure_misses',r.pure_misses,'reference',r.reference,
          'action_regret_bb',r.action_regret_bb,
          'regret_eligible_spots',r.regret_eligible_spots,'checksum',r.decision_checksum),
        'recommendation','Use immutable decision receipts for diagnosis. Agreement is execution/reference evidence, not exploitability.');
    END IF;
  END LOOP;
  IF NOT v_chart_seen THEN
    v:=v||jsonb_build_object('severity','critical','category','gto',
      'code','solver_agreement_missing','title','No chart solver agreement row for the target day',
      'evidence',jsonb_build_object('day',p_day,'reference','gto_charts'),
      'recommendation','HorseLeague writes this before the matchup card. Check HorseLeague.agreement and the chart loader.');
  END IF;
  IF v_v31_required AND NOT v_v31_seen THEN
    v:=v||jsonb_build_object('severity','critical','category','gto',
      'code','solver_agreement_v31_missing',
      'title','An active certified V31 corpus has no agreement receipt for the target day',
      'evidence',jsonb_build_object('day',p_day,'reference','gto_v31_certified'),
      'recommendation','Check HorseLeague.agreement.v31 and the active-cell loader; do not infer V31 execution from chart agreement.');
  END IF;
  RETURN v;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_audit_solver_agreement(date)
  FROM PUBLIC,authenticated,anon;
GRANT EXECUTE ON FUNCTION public.fn_audit_solver_agreement(date) TO service_role;

-- Preserve the existing panel RPC contract, but route the requested reference
-- to its own physical decision table.  Without this branch the new summary
-- row would be visible while its drill-down misleadingly returned no rows.
CREATE OR REPLACE FUNCTION public.ca_horse_solver_agreement_decisions(
  p_day date DEFAULT NULL,
  p_reference text DEFAULT 'gto_charts',
  p_limit integer DEFAULT 100
)
RETURNS TABLE (
  run_date date,reference text,state_key text,decision_state jsonb,kind text,
  game_type text,hero_position text,stack_bb numeric,hand text,final_action text,
  reference_distribution jsonb,chosen_probability numeric,action_regret_bb numeric,
  regret_eligible boolean,pure_miss boolean,source_seal jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=public
AS $fn$
DECLARE
  v_day date;
BEGIN
  IF COALESCE(auth.role(),'')<>'service_role'
     AND (auth.uid() IS NULL OR NOT public.fn_is_horse_admin()) THEN
    RAISE EXCEPTION 'admin only';
  END IF;
  IF p_reference NOT IN ('gto_charts','gto_v31_certified') THEN
    RAISE EXCEPTION 'unknown solver agreement reference';
  END IF;
  IF p_reference='gto_charts' THEN
    SELECT COALESCE(p_day,max(d.run_date)) INTO v_day
      FROM public.horse_solver_agreement_decisions d
     WHERE d.reference=p_reference;
    IF v_day IS NULL THEN RETURN; END IF;
    RETURN QUERY SELECT d.run_date,d.reference,d.state_key,d.decision_state,d.kind,
      d.game_type,d.position,d.stack_bb,d.hand,d.final_action,
      d.reference_distribution,d.chosen_probability,d.action_regret_bb,
      d.regret_eligible,d.pure_miss,d.source_seal
      FROM public.horse_solver_agreement_decisions d
     WHERE d.run_date=v_day AND d.reference=p_reference
     ORDER BY d.pure_miss DESC,d.action_regret_bb DESC NULLS LAST,d.state_key
     LIMIT least(greatest(COALESCE(p_limit,100),1),1000);
  ELSE
    SELECT COALESCE(p_day,max(d.run_date)) INTO v_day
      FROM public.horse_solver_agreement_v31_decisions d;
    IF v_day IS NULL THEN RETURN; END IF;
    RETURN QUERY SELECT d.run_date,d.reference,d.state_key,d.decision_state,d.node_role,
      d.game_family,d.hero_position,(d.decision_state->>'stack_bb')::numeric,
      d.decision_state->>'hand',d.final_action,d.reference_distribution,
      d.chosen_probability,d.action_regret_bb,d.regret_eligible,d.pure_miss,d.source_seal
      FROM public.horse_solver_agreement_v31_decisions d
     WHERE d.run_date=v_day
     ORDER BY d.pure_miss DESC,d.executed_as_intended,
              d.action_regret_bb DESC NULLS LAST,d.state_key
     LIMIT least(greatest(COALESCE(p_limit,100),1),1000);
  END IF;
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_horse_solver_agreement_decisions(date,text,integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ca_horse_solver_agreement_decisions(date,text,integer)
  TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.ca_horse_solver_agreement_v31_decisions(
  p_day date DEFAULT NULL,
  p_limit integer DEFAULT 100
)
RETURNS TABLE (
  run_date date,reference text,state_key text,decision_state jsonb,stage text,
  game_family text,objective text,utility_context text,table_size smallint,
  pot_type text,hero_position text,opponent_position text,depth_bucket integer,
  texture_class text,node_role text,facing_kind text,facing_size_bucket text,
  cell text,hand_key text,sampled_action_id text,sampled_action_family text,
  final_action text,executed_as_intended boolean,reference_distribution jsonb,
  chosen_probability numeric,action_regret_bb numeric,regret_eligible boolean,
  pure_miss boolean,source_seal jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=public
AS $fn$
DECLARE
  v_day date;
BEGIN
  IF COALESCE(auth.role(),'')<>'service_role'
     AND (auth.uid() IS NULL OR NOT public.fn_is_horse_admin()) THEN
    RAISE EXCEPTION 'admin only';
  END IF;
  SELECT COALESCE(p_day,max(d.run_date)) INTO v_day
    FROM public.horse_solver_agreement_v31_decisions d;
  IF v_day IS NULL THEN RETURN; END IF;
  RETURN QUERY SELECT d.run_date,d.reference,d.state_key,d.decision_state,d.stage,
    d.game_family,d.objective,d.utility_context,d.table_size,d.pot_type,
    d.hero_position,d.opponent_position,d.depth_bucket,d.texture_class,d.node_role,
    d.facing_kind,d.facing_size_bucket,d.cell,d.hand_key,d.sampled_action_id,
    d.sampled_action_family,d.final_action,d.executed_as_intended,
    d.reference_distribution,d.chosen_probability,d.action_regret_bb,
    d.regret_eligible,d.pure_miss,d.source_seal
    FROM public.horse_solver_agreement_v31_decisions d
   WHERE d.run_date=v_day
   ORDER BY d.pure_miss DESC,d.executed_as_intended,d.action_regret_bb DESC NULLS LAST,
            d.state_key
   LIMIT least(greatest(COALESCE(p_limit,100),1),1000);
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_horse_solver_agreement_v31_decisions(date,integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ca_horse_solver_agreement_v31_decisions(date,integer)
  TO authenticated,service_role;

DO $postcheck$
DECLARE
  v_open text;
BEGIN
  IF has_function_privilege('anon',
       'public.ca_horse_solver_agreement_v31_decisions(date,integer)'::regprocedure,'EXECUTE')
     OR has_function_privilege('anon',
       'public.ca_horse_solver_agreement_decisions(date,text,integer)'::regprocedure,'EXECUTE')
     OR NOT has_function_privilege('authenticated',
       'public.ca_horse_solver_agreement_v31_decisions(date,integer)'::regprocedure,'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.ca_horse_solver_agreement_v31_decisions(date,integer)'::regprocedure,'EXECUTE') THEN
    RAISE EXCEPTION 'POST-APPLY: V31 agreement operator grants are wrong';
  END IF;
  SELECT string_agg(t.proname,', ' ORDER BY t.proname) INTO v_open
    FROM public.fn_ca_browser_reachable_telemetry() t
   WHERE t.proname IN (
     'ca_horse_solver_agreement_decisions',
     'ca_horse_solver_agreement_v31_decisions'
   );
  IF v_open IS NOT NULL THEN
    RAISE EXCEPTION 'POST-APPLY: V31 agreement operator read is unscoped';
  END IF;
END;
$postcheck$;

COMMENT ON TABLE public.horse_solver_agreement_v31_decisions IS
  'Phase 4 per-decision evidence for active certified V31 execution. PostgreSQL binds every receipt to the promoted dataset and immutable runtime cell and recomputes agreement/regret.';
COMMENT ON FUNCTION public.fn_horse_solver_agreement_v31_decision(jsonb) IS
  'Private database-bound validator for one certified V31 agreement decision; intentionally not executable by API roles.';
COMMENT ON FUNCTION public.ca_horse_solver_agreement_v31_decisions(date,integer) IS
  'Admin-only immutable certified V31 agreement evidence, ordered by pure misses, execution mismatches, and regret.';

COMMIT;
