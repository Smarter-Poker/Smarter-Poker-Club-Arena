-- 20260909022146_certified_solver_evaluation_executes_sampled_action
--
-- A V31 benchmark incremented candidate_policy_hits when a solver action was
-- sampled, before HorseLogic's final legalizer ran. An impossible raise could
-- therefore become a call while release evidence still claimed the candidate
-- policy executed. Same-day result reuse was also keyed by a 12-character
-- checksum prefix and did not bind the receipt to the exact Club Arena commit
-- that ran the evaluator.
--
-- Add a reconciled zero-only execution-mismatch counter, require it globally
-- and in every component, move the immutable evaluation contract to v2, use
-- the full dataset checksum in the matchup identity, and record one exact,
-- non-placeholder evaluator commit shared by all eight release gates. Existing
-- ordinary league rows receive the safe zero default. No strategy threshold,
-- active dataset, or player balance changes here.

ALTER TABLE public.horse_league_results
  ADD COLUMN IF NOT EXISTS candidate_execution_mismatches integer NOT NULL DEFAULT 0
    CHECK (candidate_execution_mismatches >= 0);

CREATE OR REPLACE FUNCTION public.fn_gto_v31_record_evaluation(
  p_dataset_id uuid,
  p_evaluation_kind text,
  p_game_family text,
  p_source_result_id bigint
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_dataset public.gto_v31_datasets%ROWTYPE;
  v_result public.horse_league_results%ROWTYPE;
  v_incumbent text;
  v_verdict text;
  v_metrics jsonb;
  v_checksum text;
  v_id uuid;
  v_expected_scenarios text[];
  v_expected_profile text;
  v_actual_scenarios text[];
  v_component_hands bigint;
  v_component_hits bigint;
  v_component_mismatches bigint;
  v_component_duration bigint;
  v_component_bb100 numeric;
  v_component_stderr numeric;
  v_component_roles text[];
  v_result_roles text[];
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  IF p_evaluation_kind NOT IN ('paired_replay','league')
     OR p_game_family NOT IN ('cash','spin','tourney_ev','tourney_icm') THEN
    RAISE EXCEPTION 'evaluation kind or family is invalid';
  END IF;
  SELECT * INTO v_dataset FROM public.gto_v31_datasets
   WHERE dataset_id=p_dataset_id AND state='evaluating' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dataset is not awaiting evaluation'; END IF;
  SELECT COALESCE((SELECT dataset_checksum FROM public.gto_v31_datasets
    WHERE state='active' AND dataset_id<>p_dataset_id LIMIT 1),'legacy_v30') INTO v_incumbent;
  SELECT * INTO v_result FROM public.horse_league_results WHERE id=p_source_result_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'league result does not exist'; END IF;
  v_expected_scenarios:=CASE p_game_family
    WHEN 'cash' THEN ARRAY['cash_ev']::text[]
    WHEN 'spin' THEN ARRAY['chip_ev','spin_ladder']::text[]
    WHEN 'tourney_ev' THEN ARRAY['chip_ev']::text[]
    ELSE ARRAY['satellite','bubble','final_table','in_money','ladder']::text[]
  END;
  v_expected_profile:=CASE p_evaluation_kind
    WHEN 'paired_replay' THEN 'policy_only_duplicate_deals'
    ELSE 'full_brain_duplicate_deal_league'
  END;

  IF jsonb_typeof(v_result.config_a)<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(v_result.config_a))<>8
     OR NOT (v_result.config_a ?& ARRAY['evaluation_contract','evaluation_kind',
       'game_family','dataset_checksum','candidate','evaluation_profile','scenarios',
       'evaluation_engine_commit']::text[])
     OR jsonb_typeof(v_result.config_b)<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(v_result.config_b))<>2
     OR NOT (v_result.config_b ?& ARRAY['incumbent_dataset_checksum','candidate']::text[])
     OR jsonb_typeof(v_result.config_a->'scenarios')<>'array'
     OR v_result.config_a->'scenarios' IS DISTINCT FROM to_jsonb(v_expected_scenarios)
     OR v_result.config_a->>'evaluation_profile'<>v_expected_profile
     OR COALESCE(v_result.config_a->>'evaluation_engine_commit','')!~'^[0-9a-f]{40}$'
     OR v_result.config_a->>'evaluation_engine_commit'=repeat('0',40) THEN
    RAISE EXCEPTION 'evaluation configuration is incomplete or aliases another test profile';
  END IF;

  IF jsonb_array_length(v_result.candidate_benchmark_components)<>array_length(v_expected_scenarios,1)
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_result.candidate_benchmark_components) component(value)
        WHERE jsonb_typeof(component.value)<>'object'
          OR (SELECT count(*) FROM jsonb_object_keys(component.value))<>10
          OR NOT (component.value ?& ARRAY['scenario','hands','bb100','stderr','duration_ms',
            'illegal_actions','truncated_streets','candidate_policy_hits',
            'candidate_execution_mismatches','candidate_node_roles']::text[])
          OR jsonb_typeof(component.value->'scenario')<>'string'
          OR COALESCE(component.value->>'hands','')!~'^[1-9][0-9]*$'
          OR jsonb_typeof(component.value->'bb100')<>'number'
          OR jsonb_typeof(component.value->'stderr')<>'number'
          OR (component.value->>'stderr')::numeric<0
          OR COALESCE(component.value->>'duration_ms','')!~'^[1-9][0-9]*$'
          OR COALESCE(component.value->>'illegal_actions','')!~'^[0-9]+$'
          OR (component.value->>'illegal_actions')::bigint<>0
          OR COALESCE(component.value->>'truncated_streets','')!~'^[0-9]+$'
          OR (component.value->>'truncated_streets')::bigint<>0
          OR COALESCE(component.value->>'candidate_policy_hits','')!~'^[1-9][0-9]*$'
          OR COALESCE(component.value->>'candidate_execution_mismatches','')!~'^[0-9]+$'
          OR (component.value->>'candidate_execution_mismatches')::bigint<>0
          OR jsonb_typeof(component.value->'candidate_node_roles')<>'array'
          OR jsonb_array_length(component.value->'candidate_node_roles')=0
          OR jsonb_array_length(component.value->'candidate_node_roles')<>(
            SELECT count(DISTINCT role.value)
              FROM jsonb_array_elements_text(component.value->'candidate_node_roles') role(value))
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(component.value->'candidate_node_roles') role(value)
             WHERE role.value NOT IN ('open','cbet','probe','delayed_cbet','barrel',
               'facing_bet','facing_raise','check_raise','bet_raise','all_in'))
     ) THEN
    RAISE EXCEPTION 'benchmark components do not carry exact scenario and decision evidence';
  END IF;

  SELECT array_agg(component.value->>'scenario' ORDER BY component.ordinality),
         sum((component.value->>'hands')::bigint),
         sum((component.value->>'candidate_policy_hits')::bigint),
         sum((component.value->>'candidate_execution_mismatches')::bigint),
         sum((component.value->>'duration_ms')::bigint),
         sum((component.value->>'bb100')::numeric*(component.value->>'hands')::numeric)
           /sum((component.value->>'hands')::numeric),
         sqrt(sum(power((component.value->>'stderr')::numeric*
           (component.value->>'hands')::numeric,2)))
           /sum((component.value->>'hands')::numeric)
    INTO v_actual_scenarios,v_component_hands,v_component_hits,v_component_mismatches,
         v_component_duration,
         v_component_bb100,v_component_stderr
    FROM jsonb_array_elements(v_result.candidate_benchmark_components)
      WITH ORDINALITY component(value,ordinality);
  SELECT array_agg(DISTINCT role.value ORDER BY role.value)
    INTO v_component_roles
    FROM jsonb_array_elements(v_result.candidate_benchmark_components) component(value)
    CROSS JOIN LATERAL jsonb_array_elements_text(component.value->'candidate_node_roles') role(value);
  SELECT array_agg(DISTINCT role.value ORDER BY role.value) INTO v_result_roles
    FROM unnest(v_result.candidate_node_roles) role(value);

  IF v_result.run_date<current_date-2 OR v_result.run_date>current_date
     OR v_result.hands<10000 OR v_result.illegal_actions<>0 OR v_result.truncated_streets<>0
     OR v_result.candidate_policy_hits<=0 OR v_result.candidate_execution_mismatches<>0
     OR COALESCE(array_length(v_result.candidate_node_roles,1),0)<=0
     OR v_actual_scenarios IS DISTINCT FROM v_expected_scenarios
     OR v_component_hands<>v_result.hands
     OR v_component_hits<>v_result.candidate_policy_hits
     OR v_component_mismatches<>v_result.candidate_execution_mismatches
     OR v_component_duration<>v_result.duration_ms
     OR abs(v_component_bb100-v_result.bb100)>0.000001
     OR abs(v_component_stderr-v_result.stderr)>0.000001
     OR v_component_roles IS DISTINCT FROM v_result_roles
     OR COALESCE(array_length(v_result.candidate_node_roles,1),0)<>
        COALESCE(array_length(v_result_roles,1),0)
     OR EXISTS (SELECT 1 FROM unnest(v_result.candidate_node_roles) role(value)
       WHERE role.value NOT IN ('open','cbet','probe','delayed_cbet','barrel',
         'facing_bet','facing_raise','check_raise','bet_raise','all_in'))
     OR v_result.duration_ms<=0 OR v_result.stderr<0
     OR v_result.matchup<>'gto_v31_'||p_evaluation_kind||'_'||p_game_family||'_'||v_dataset.dataset_checksum
     OR v_result.config_a->>'evaluation_contract'<>'gto_v31_candidate.v2'
     OR v_result.config_a->>'evaluation_kind'<>p_evaluation_kind
     OR v_result.config_a->>'game_family'<>p_game_family
     OR v_result.config_a->>'dataset_checksum'<>v_dataset.dataset_checksum
     OR v_result.config_a->>'candidate'<>'v31_certified'
     OR v_result.config_b->>'incumbent_dataset_checksum'<>v_incumbent
     OR v_result.config_b->>'candidate'<>'incumbent' THEN
    RAISE EXCEPTION 'league result is stale, unsafe, or not bound to this candidate and incumbent';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.gto_v31_release_evaluations e
     WHERE e.dataset_id=p_dataset_id
       AND e.evaluation_kind IN ('paired_replay','league')
       AND e.metrics#>>'{candidate_config,evaluation_engine_commit}'
           IS DISTINCT FROM v_result.config_a->>'evaluation_engine_commit'
  ) THEN
    RAISE EXCEPTION 'candidate evaluations were produced by different engine commits';
  END IF;

  v_verdict:=CASE WHEN v_result.bb100>2*v_result.stderr THEN 'win'
                  WHEN v_result.bb100<(-2*v_result.stderr) THEN 'loss' ELSE 'tie' END;
  v_metrics:=jsonb_build_object('source_result_id',v_result.id,'run_date',v_result.run_date,
    'matchup',v_result.matchup,'hands',v_result.hands,'bb100',v_result.bb100,
    'stderr',v_result.stderr,'illegal_actions',v_result.illegal_actions,
    'truncated_streets',v_result.truncated_streets,'duration_ms',v_result.duration_ms,
    'candidate_policy_hits',v_result.candidate_policy_hits,
    'candidate_execution_mismatches',v_result.candidate_execution_mismatches,
    'candidate_node_roles',v_result.candidate_node_roles,
    'benchmark_components',v_result.candidate_benchmark_components,
    'candidate_config',v_result.config_a,'incumbent_config',v_result.config_b);
  v_checksum:=public.fn_gto_v31_json_checksum(jsonb_build_object(
    'dataset_checksum',v_dataset.dataset_checksum,'kind',p_evaluation_kind,
    'family',p_game_family,'verdict',v_verdict,'metrics',v_metrics));
  INSERT INTO public.gto_v31_release_evaluations (
    dataset_id,dataset_checksum,evaluation_kind,game_family,verdict,metrics,
    source_result_id,result_checksum
  ) VALUES (
    p_dataset_id,v_dataset.dataset_checksum,p_evaluation_kind,p_game_family,
    v_verdict,v_metrics,p_source_result_id,v_checksum
  ) ON CONFLICT (dataset_id,evaluation_kind,game_family) DO NOTHING
  RETURNING evaluation_id INTO v_id;
  IF v_id IS NULL THEN
    SELECT evaluation_id INTO v_id FROM public.gto_v31_release_evaluations
     WHERE dataset_id=p_dataset_id AND evaluation_kind=p_evaluation_kind
       AND game_family=p_game_family AND result_checksum=v_checksum;
    IF v_id IS NULL THEN RAISE EXCEPTION 'an evaluation receipt already exists with another result'; END IF;
  END IF;
  RETURN v_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_record_evaluation(uuid,text,text,bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_record_evaluation(uuid,text,text,bigint)
  TO service_role;
