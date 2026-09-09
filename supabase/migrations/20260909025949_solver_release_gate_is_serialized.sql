-- 20260909025949_solver_release_gate_is_serialized
--
-- Candidate and active dataset rows are different lock targets. Without one
-- release-wide lock, two concurrent promotions could validate against the
-- same incumbent, then a later statement could retire the first winner and
-- activate the second using stale incumbent evidence. Serialize the private
-- evidence helper for the full caller transaction. Both mark_candidate and
-- promote_dataset invoke it before changing dataset state, so no strategy or
-- data is changed by this migration; it closes the release race only.

DO $preflight$
BEGIN
  IF to_regprocedure('public.fn_gto_v31_candidate_evaluations_valid(uuid,text)') IS NULL
     OR to_regprocedure('public.fn_gto_v31_mark_candidate(uuid)') IS NULL
     OR to_regprocedure('public.fn_gto_v31_promote_dataset(uuid)') IS NULL THEN
    RAISE EXCEPTION 'the certified solver release functions must exist before serialization';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_candidate_evaluations_valid(
  p_dataset_id uuid,
  p_dataset_checksum text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_incumbent text;
  v_active_incumbents integer;
  v_receipts integer;
  v_engine_commits integer;
BEGIN
  -- Mark-candidate and promotion both call this helper before changing state.
  -- The transaction-scoped estate lock survives the function return, so the
  -- incumbent read, receipt validation, and later state transition are one
  -- serialized release operation even for two different candidate rows.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('smarter-poker:gto-v31-release-gate', 0)
  );

  IF p_dataset_id IS NULL
     OR COALESCE(p_dataset_checksum,'')!~'^[0-9a-f]{64}$'
     OR p_dataset_checksum=repeat('0',64) THEN
    RETURN false;
  END IF;

  SELECT count(*),max(d.dataset_checksum)
    INTO v_active_incumbents,v_incumbent
    FROM public.gto_v31_datasets d
   WHERE d.state='active' AND d.dataset_id<>p_dataset_id;
  IF v_active_incumbents=0 THEN
    v_incumbent:='legacy_v30';
  ELSIF v_active_incumbents<>1
     OR COALESCE(v_incumbent,'')!~'^[0-9a-f]{64}$'
     OR v_incumbent=repeat('0',64) THEN
    RETURN false;
  END IF;

  SELECT count(*),
         count(DISTINCT e.metrics#>>'{candidate_config,evaluation_engine_commit}')
    INTO v_receipts,v_engine_commits
    FROM public.gto_v31_release_evaluations e
    JOIN public.horse_league_results r ON r.id=e.source_result_id
   WHERE e.dataset_id=p_dataset_id
     AND e.dataset_checksum=p_dataset_checksum
     AND e.evaluation_kind IN ('paired_replay','league')
     AND e.game_family IN ('cash','spin','tourney_ev','tourney_icm');

  IF v_receipts<>8 OR v_engine_commits<>1 THEN
    RETURN false;
  END IF;

  RETURN NOT EXISTS (
    WITH required(evaluation_kind,game_family,evaluation_profile,scenarios) AS (
      VALUES
        ('paired_replay','cash','policy_only_duplicate_deals',ARRAY['cash_ev']::text[]),
        ('paired_replay','spin','policy_only_duplicate_deals',ARRAY['chip_ev','spin_ladder']::text[]),
        ('paired_replay','tourney_ev','policy_only_duplicate_deals',ARRAY['chip_ev']::text[]),
        ('paired_replay','tourney_icm','policy_only_duplicate_deals',ARRAY['satellite','bubble','final_table','in_money','ladder']::text[]),
        ('league','cash','full_brain_duplicate_deal_league',ARRAY['cash_ev']::text[]),
        ('league','spin','full_brain_duplicate_deal_league',ARRAY['chip_ev','spin_ladder']::text[]),
        ('league','tourney_ev','full_brain_duplicate_deal_league',ARRAY['chip_ev']::text[]),
        ('league','tourney_icm','full_brain_duplicate_deal_league',ARRAY['satellite','bubble','final_table','in_money','ladder']::text[])
    )
    SELECT 1
      FROM required q
      LEFT JOIN public.gto_v31_release_evaluations e
        ON e.dataset_id=p_dataset_id
       AND e.dataset_checksum=p_dataset_checksum
       AND e.evaluation_kind=q.evaluation_kind
       AND e.game_family=q.game_family
      LEFT JOIN public.horse_league_results r ON r.id=e.source_result_id
     WHERE e.evaluation_id IS NULL
        OR r.id IS NULL
        OR e.verdict NOT IN ('win','tie')
        OR e.verdict IS DISTINCT FROM CASE
             WHEN r.bb100>2*r.stderr THEN 'win'
             WHEN r.bb100<(-2*r.stderr) THEN 'loss'
             ELSE 'tie'
           END
        OR r.hands<10000
        OR r.illegal_actions<>0
        OR r.truncated_streets<>0
        OR r.candidate_policy_hits<=0
        OR r.candidate_execution_mismatches<>0
        OR r.duration_ms<=0
        OR r.stderr<0
        OR r.matchup IS DISTINCT FROM
           'gto_v31_'||q.evaluation_kind||'_'||q.game_family||'_'||p_dataset_checksum
        OR jsonb_typeof(r.config_a)<>'object'
        OR CASE WHEN jsonb_typeof(r.config_a)='object'
             THEN (SELECT count(*) FROM jsonb_object_keys(r.config_a))
             ELSE -1
           END<>8
        OR NOT (r.config_a ?& ARRAY['evaluation_contract','evaluation_kind',
          'game_family','dataset_checksum','candidate','evaluation_profile','scenarios',
          'evaluation_engine_commit']::text[])
        OR r.config_a->>'evaluation_contract'<>'gto_v31_candidate.v2'
        OR r.config_a->>'evaluation_kind'<>q.evaluation_kind
        OR r.config_a->>'game_family'<>q.game_family
        OR r.config_a->>'dataset_checksum'<>p_dataset_checksum
        OR r.config_a->>'candidate'<>'v31_certified'
        OR r.config_a->>'evaluation_profile'<>q.evaluation_profile
        OR r.config_a->'scenarios' IS DISTINCT FROM to_jsonb(q.scenarios)
        OR COALESCE(r.config_a->>'evaluation_engine_commit','')!~'^[0-9a-f]{40}$'
        OR r.config_a->>'evaluation_engine_commit'=repeat('0',40)
        OR jsonb_typeof(r.config_b)<>'object'
        OR CASE WHEN jsonb_typeof(r.config_b)='object'
             THEN (SELECT count(*) FROM jsonb_object_keys(r.config_b))
             ELSE -1
           END<>2
        OR NOT (r.config_b ?& ARRAY['incumbent_dataset_checksum','candidate']::text[])
        OR r.config_b->>'incumbent_dataset_checksum'<>v_incumbent
        OR r.config_b->>'candidate'<>'incumbent'
        OR jsonb_typeof(r.candidate_benchmark_components)<>'array'
        OR jsonb_array_length(r.candidate_benchmark_components)<>array_length(q.scenarios,1)
        OR EXISTS (
          SELECT 1
            FROM jsonb_array_elements(r.candidate_benchmark_components) component(value)
           WHERE jsonb_typeof(component.value)<>'object'
              OR component.value->'candidate_execution_mismatches' IS DISTINCT FROM '0'::jsonb
        )
        OR e.metrics IS DISTINCT FROM jsonb_build_object(
          'source_result_id',r.id,'run_date',r.run_date,'matchup',r.matchup,
          'hands',r.hands,'bb100',r.bb100,'stderr',r.stderr,
          'illegal_actions',r.illegal_actions,'truncated_streets',r.truncated_streets,
          'duration_ms',r.duration_ms,'candidate_policy_hits',r.candidate_policy_hits,
          'candidate_execution_mismatches',r.candidate_execution_mismatches,
          'candidate_node_roles',r.candidate_node_roles,
          'benchmark_components',r.candidate_benchmark_components,
          'candidate_config',r.config_a,'incumbent_config',r.config_b)
        OR e.result_checksum IS DISTINCT FROM public.fn_gto_v31_json_checksum(
          jsonb_build_object('dataset_checksum',p_dataset_checksum,
            'kind',q.evaluation_kind,'family',q.game_family,
            'verdict',e.verdict,'metrics',e.metrics))
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_candidate_evaluations_valid(uuid,text)
  FROM PUBLIC, anon, authenticated, service_role;

DO $post_apply$
DECLARE
  v_source text;
  v_volatility "char";
BEGIN
  SELECT p.prosrc,p.provolatile
    INTO v_source,v_volatility
    FROM pg_proc p
   WHERE p.oid='public.fn_gto_v31_candidate_evaluations_valid(uuid,text)'::regprocedure;
  IF position('pg_advisory_xact_lock' in COALESCE(v_source,''))=0
     OR position('smarter-poker:gto-v31-release-gate' in COALESCE(v_source,''))=0
     OR v_volatility<>'v' THEN
    RAISE EXCEPTION 'the certified solver release gate is not transaction-serialized';
  END IF;
  IF has_function_privilege(
       'service_role',
       'public.fn_gto_v31_candidate_evaluations_valid(uuid,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'the private release validator became directly callable';
  END IF;
END;
$post_apply$;
