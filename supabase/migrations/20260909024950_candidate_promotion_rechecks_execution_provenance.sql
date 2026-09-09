-- 20260909024950_candidate_promotion_rechecks_execution_provenance
--
-- Release receipts are admitted through fn_gto_v31_record_evaluation, but the
-- candidate and promotion gates must also defend themselves. Recheck all eight
-- benchmark receipts against their immutable source rows, exact V2 configs,
-- full dataset checksum, zero post-legalization mismatches, one evaluator
-- commit, and one current incumbent. This prevents a stale or legacy receipt
-- from becoming sufficient merely because its kind, family, and verdict match.

CREATE OR REPLACE FUNCTION public.fn_gto_v31_freeze_evaluation_source()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.gto_v31_release_evaluations e
     WHERE e.source_result_id=OLD.id
  ) THEN
    RAISE EXCEPTION 'a league result used as certified solver evidence is immutable';
  END IF;
  IF TG_OP='DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_freeze_evaluation_source()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS gto_v31_evaluation_source_is_immutable
  ON public.horse_league_results;
CREATE TRIGGER gto_v31_evaluation_source_is_immutable
BEFORE UPDATE OR DELETE ON public.horse_league_results
FOR EACH ROW
EXECUTE FUNCTION public.fn_gto_v31_freeze_evaluation_source();

CREATE OR REPLACE FUNCTION public.fn_gto_v31_candidate_evaluations_valid(
  p_dataset_id uuid,
  p_dataset_checksum text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_incumbent text;
  v_active_incumbents integer;
  v_receipts integer;
  v_engine_commits integer;
BEGIN
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

CREATE OR REPLACE FUNCTION public.fn_gto_v31_mark_candidate(p_dataset_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_dataset public.gto_v31_datasets%ROWTYPE;
  v_paired jsonb;
  v_league jsonb;
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  SELECT * INTO v_dataset FROM public.gto_v31_datasets
   WHERE dataset_id=p_dataset_id AND state='evaluating' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dataset is not awaiting evaluation'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.gto_v31_input_bundles b
      WHERE b.input_bundle_id=v_dataset.input_bundle_id AND b.approval_status='approved'
        AND b.bundle_checksum=v_dataset.input_bundle_checksum)
     OR NOT EXISTS (SELECT 1 FROM public.gto_v31_release_evaluations e
      WHERE e.dataset_id=p_dataset_id AND e.dataset_checksum=v_dataset.dataset_checksum
        AND e.evaluation_kind='heldout' AND e.game_family='all' AND e.verdict='pass')
     OR NOT public.fn_gto_v31_candidate_evaluations_valid(
       p_dataset_id,v_dataset.dataset_checksum)
     OR EXISTS (
       SELECT 1
         FROM unnest(ARRAY['paired_replay','league']) required_kind(value)
         CROSS JOIN unnest(ARRAY['open','cbet','probe','delayed_cbet','barrel',
           'facing_bet','facing_raise','check_raise','bet_raise','all_in']) required_role(value)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.gto_v31_release_evaluations e
          CROSS JOIN LATERAL jsonb_array_elements_text(e.metrics->'candidate_node_roles') seen(value)
           WHERE e.dataset_id=p_dataset_id AND e.dataset_checksum=v_dataset.dataset_checksum
             AND e.evaluation_kind=required_kind.value AND e.verdict IN ('win','tie')
             AND seen.value=required_role.value)) THEN
    RAISE EXCEPTION 'candidate is missing approved, execution-bound release evidence';
  END IF;
  SELECT jsonb_build_object('verdict','pass',
      'evaluations',jsonb_agg(to_jsonb(e) ORDER BY e.game_family))
    INTO v_paired FROM public.gto_v31_release_evaluations e
   WHERE e.dataset_id=p_dataset_id AND e.dataset_checksum=v_dataset.dataset_checksum
     AND e.evaluation_kind='paired_replay' AND e.verdict IN ('win','tie');
  SELECT jsonb_build_object('verdict','pass',
      'evaluations',jsonb_agg(to_jsonb(e) ORDER BY e.game_family))
    INTO v_league FROM public.gto_v31_release_evaluations e
   WHERE e.dataset_id=p_dataset_id AND e.dataset_checksum=v_dataset.dataset_checksum
     AND e.evaluation_kind='league' AND e.verdict IN ('win','tie');
  UPDATE public.gto_v31_datasets SET state='candidate',paired_replay=v_paired,
    league_gate=v_league,candidate_at=now(),audited_at=now()
   WHERE dataset_id=p_dataset_id;
  RETURN v_dataset.dataset_checksum;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_mark_candidate(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_mark_candidate(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_promote_dataset(p_dataset_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_dataset public.gto_v31_datasets%ROWTYPE;
  v_expected_checksum text;
  v_expected_source_checksum text;
  v_paired jsonb;
  v_league jsonb;
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  SELECT * INTO v_dataset FROM public.gto_v31_datasets
   WHERE dataset_id=p_dataset_id AND state='candidate' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dataset is not a candidate'; END IF;
  SELECT encode(digest(v_dataset.dataset_key||':'||v_dataset.pipeline_bundle_checksum||':'||
    v_dataset.manifest_checksum||':'||
    v_dataset.input_bundle_checksum||':'||string_agg(cell_key_checksum||':'||
      cell_payload_checksum||':'||lineage_checksum,'' ORDER BY cell_key_checksum),'sha256'),'hex')
    INTO v_expected_checksum FROM public.gto_v31_runtime_cells WHERE dataset_id=p_dataset_id;
  SELECT encode(digest(string_agg(DISTINCT source_artifact_checksum,'' ORDER BY source_artifact_checksum),'sha256'),'hex')
    INTO v_expected_source_checksum FROM public.gto_v31_source_artifacts WHERE dataset_id=p_dataset_id;
  SELECT jsonb_build_object('verdict','pass',
      'evaluations',jsonb_agg(to_jsonb(e) ORDER BY e.game_family))
    INTO v_paired FROM public.gto_v31_release_evaluations e
   WHERE e.dataset_id=p_dataset_id AND e.dataset_checksum=v_dataset.dataset_checksum
     AND e.evaluation_kind='paired_replay' AND e.verdict IN ('win','tie');
  SELECT jsonb_build_object('verdict','pass',
      'evaluations',jsonb_agg(to_jsonb(e) ORDER BY e.game_family))
    INTO v_league FROM public.gto_v31_release_evaluations e
   WHERE e.dataset_id=p_dataset_id AND e.dataset_checksum=v_dataset.dataset_checksum
     AND e.evaluation_kind='league' AND e.verdict IN ('win','tie');
  IF v_dataset.quality_status <> 'validated' OR v_dataset.invalid_rows <> 0
     OR v_dataset.dataset_checksum IS NULL OR v_dataset.source_artifact_checksum IS NULL
     OR v_dataset.dataset_checksum IS DISTINCT FROM v_expected_checksum
     OR v_dataset.source_artifact_checksum IS DISTINCT FROM v_expected_source_checksum
     OR COALESCE((v_dataset.coverage->>'complete')::boolean,false) IS NOT true
     OR COALESCE((v_dataset.heldout_metrics->>'frequency_mae')::numeric,99) > (v_dataset.quality_gates->>'max_frequency_mae')::numeric
     OR COALESCE((v_dataset.heldout_metrics->>'sizing_mae')::numeric,99) > (v_dataset.quality_gates->>'max_sizing_mae')::numeric
     OR COALESCE((v_dataset.heldout_metrics->>'sizing_observations')::bigint,0)<=0
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['cash','spin','tourney_ev','tourney_icm']) family(value)
       WHERE COALESCE((v_dataset.heldout_metrics#>>ARRAY['by_family',family.value,'sizing_observations'])::bigint,0)<=0)
     OR COALESCE((v_dataset.heldout_metrics->>'policy_ev_mae_bb')::numeric,99) > (v_dataset.quality_gates->>'max_policy_ev_mae_bb')::numeric
     OR COALESCE((v_dataset.heldout_metrics->>'mean_action_regret_bb')::numeric,99) > (v_dataset.quality_gates->>'max_action_regret_bb')::numeric
     OR COALESCE((v_dataset.heldout_metrics->>'regret_coverage')::numeric,-1) < (v_dataset.quality_gates->>'min_regret_coverage')::numeric
     OR v_dataset.paired_replay IS DISTINCT FROM v_paired
     OR v_dataset.league_gate IS DISTINCT FROM v_league
     OR NOT EXISTS (SELECT 1 FROM public.gto_v31_input_bundles b
       WHERE b.input_bundle_id=v_dataset.input_bundle_id AND b.approval_status='approved'
         AND b.bundle_checksum=v_dataset.input_bundle_checksum)
     OR NOT public.fn_gto_v31_candidate_evaluations_valid(
       p_dataset_id,v_dataset.dataset_checksum)
     OR EXISTS (
       SELECT 1
         FROM unnest(ARRAY['paired_replay','league']) required_kind(value)
         CROSS JOIN unnest(ARRAY['open','cbet','probe','delayed_cbet','barrel',
           'facing_bet','facing_raise','check_raise','bet_raise','all_in']) required_role(value)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.gto_v31_release_evaluations e
          CROSS JOIN LATERAL jsonb_array_elements_text(e.metrics->'candidate_node_roles') seen(value)
           WHERE e.dataset_id=p_dataset_id AND e.dataset_checksum=v_dataset.dataset_checksum
             AND e.evaluation_kind=required_kind.value AND e.verdict IN ('win','tie')
             AND seen.value=required_role.value))
     OR (SELECT count(*) FROM public.gto_v31_release_evaluations e
       WHERE e.dataset_id=p_dataset_id AND e.dataset_checksum=v_dataset.dataset_checksum
         AND ((e.evaluation_kind='heldout' AND e.game_family='all' AND e.verdict='pass')
           OR (e.evaluation_kind IN ('paired_replay','league') AND e.game_family IN
             ('cash','spin','tourney_ev','tourney_icm') AND e.verdict IN ('win','tie'))))<>9 THEN
    RAISE EXCEPTION 'candidate does not meet its protected promotion gates';
  END IF;

  UPDATE public.gto_v31_datasets SET state='retired', retired_at=now()
   WHERE state='active' AND dataset_id <> p_dataset_id;
  UPDATE public.gto_v31_datasets SET state='active', promoted_at=now()
   WHERE dataset_id=p_dataset_id;
  RETURN v_dataset.dataset_checksum;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_promote_dataset(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_promote_dataset(uuid) TO service_role;
