-- Actual installed readiness definition, read-only catalog snapshot 2026-10-17.
-- Qualification pins pg_get_functiondef MD5 d5fe0f2eb62a16f7e4587fdb5bf82caa.
CREATE OR REPLACE FUNCTION public.fn_lightning_rollout_readiness(p_cluster_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- EVERY LIGHTNING MIGRATION, in order (a later Lightning file adds itself).
  c_versions constant text[] := ARRAY[
    '20260920172736', '20260920234647', '20260920235343', '20260921025504', '20260921025523',
    '20260921044045', '20260921064717', '20260921142954', '20260921151618', '20260925204249',
    '20260925215731', '20260926023047', '20260926072527', '20260926072551', '20260926072615',
    '20260926072638', '20260926080332', '20261001154813', '20261001201216', '20261001222856',
    '20261007212735', '20261007222717', '20261008043021', '20261008050805', '20261008111425',
    '20261008142857', '20261008161509', '20261009143757', '20261009144343', '20261009151825',
    '20261009181945', '20261009235505'];
  v_now      timestamptz := now();
  g          record;
  v_club     record;
  v_row      jsonb;
  v_cfg      jsonb;
  v_reasons  jsonb := '[]'::jsonb;
  v_missing  text[];
  v_seven    boolean;
  v_anti     boolean;
  v_law      boolean;
  v_doors    boolean;
  v_sr       jsonb;
  v_scope    text;
  v_aa       jsonb;
  v_cand     jsonb;
  v_live_v   text;
  v_over     jsonb := '[]'::jsonb;
  v_leg      text;
  v_reg      jsonb;
  v_lat_to   timestamptz;
  v_horse    text := 'is_' || 'horse|horse_' || 'id';
  v_verdict  text;
  v_strip    text := '--[^' || chr(10) || ']*';
BEGIN
  SELECT cg.id, cg.club_id, cg.enabled, cg.must_move, cg.lightning_enabled, cg.cluster_mode,
         coalesce(((cg.ruleset_snapshot -> 'options') ->> 'is_private')::boolean, false) AS is_private
    INTO g FROM public.cash_games cg WHERE cg.id = p_cluster_id;
  IF NOT public.fn_lightning_operator_may(g.club_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_AUTHORIZED', 'reason', 'NOT_AUTHORIZED');
  END IF;
  IF g.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'reason', 'NOT_FOUND');
  END IF;
  SELECT (to_jsonb(cl) ->> 'is_public')::boolean AS is_public INTO v_club FROM public.clubs cl WHERE cl.id = g.club_id;
  IF NOT public.fn_lightning_template_allowed((SELECT cg.template_name FROM public.cash_games cg WHERE cg.id=g.id),(SELECT cg.ruleset_snapshot FROM public.cash_games cg WHERE cg.id=g.id)) THEN
    v_reasons:=v_reasons||jsonb_build_object('code','LIGHTNING_TEMPLATE_NOT_ALLOWED','severity','blocking','detail','Only Action and Madness support Lightning');
  END IF;
  v_row := public.fn_lightning_operator_cluster_row(g.id, v_now);
  v_cfg := public.fn_lightning_config(g.id);
  v_live_v := v_cfg ->> 'matcher_version';

  -- EVERY LIGHTNING MIGRATION IS RECORDED.
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'MIGRATION_LEDGER_UNREADABLE', 'severity', 'blocking',
                                                 'detail', 'supabase_migrations.schema_migrations is not readable');
  ELSE
    EXECUTE 'SELECT coalesce(array_agg(v ORDER BY v), ARRAY[]::text[]) FROM unnest($1) v
              WHERE NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations m WHERE m.version = v)'
       INTO v_missing USING c_versions;
    IF cardinality(v_missing) > 0 THEN
      v_reasons := v_reasons || jsonb_build_object('code', 'MIGRATIONS_MISSING', 'severity', 'blocking',
                                                   'detail', to_jsonb(v_missing));
    END IF;
  END IF;

  -- THE STRUCTURAL INVARIANTS THE LIVE PROOFS PIN, re-derived here.
  v_seven := (SELECT count(*) = 7 FROM information_schema.role_table_grants
               WHERE table_schema = 'public' AND table_name LIKE 'lightning\_%'
                 AND grantee = 'service_role' AND privilege_type = 'SELECT')
             AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                              WHERE table_schema = 'public' AND table_name LIKE 'lightning\_%'
                                AND grantee IN ('anon', 'authenticated', 'PUBLIC'));
  v_anti := (SELECT coalesce(bool_and(regexp_replace(pg_get_functiondef(p.oid), v_strip, '', 'g')
                                      !~ 'integrity|shadow_comparison|quality_|latency|lightning_alert|fn_lightning_operator_'), false)
                    AND count(*) = 6
               FROM pg_proc p
              WHERE p.oid IN ('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)'::regprocedure,
                              'public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)'::regprocedure,
                              'public.fn_lightning_match(uuid,timestamp with time zone,uuid[],text,jsonb)'::regprocedure,
                              'public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer,jsonb)'::regprocedure,
                              'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)'::regprocedure,
                              'public.fn_cash_clusters_tick_all(jsonb)'::regprocedure));
  v_law := NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname LIKE 'fn\_lightning\_%'
                          AND regexp_replace(pg_get_functiondef(p.oid), v_strip, '', 'g') ~ v_horse);
  v_doors := NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                          WHERE n.nspname = 'public' AND p.proname LIKE 'fn\_lightning\_%'
                            AND has_function_privilege('anon', p.oid, 'EXECUTE'));
  IF NOT (v_seven AND v_anti AND v_law AND v_doors) THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'INVARIANT_FAILED', 'severity', 'blocking',
      'detail', jsonb_build_object('seven_tables', v_seven, 'anti_manipulation', v_anti,
                                   'law_10_5', v_law, 'no_anon_door', v_doors));
  END IF;

  -- THE CLUSTER.
  IF g.cluster_mode = 'frozen' THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'CLUSTER_FROZEN', 'severity', 'blocking', 'detail', v_row -> 'frozen');
  ELSIF g.cluster_mode IN ('pending_on', 'pending_off', 'draining', 'paused') OR jsonb_typeof(v_row -> 'drain') = 'object' THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'CLUSTER_BUSY', 'severity', 'blocking',
                                                 'detail', jsonb_build_object('cluster_mode', g.cluster_mode, 'drain', v_row -> 'drain'));
  ELSIF g.cluster_mode NOT IN ('must_move', 'lightning') THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'CLUSTER_NOT_READY', 'severity', 'blocking', 'detail', g.cluster_mode);
  END IF;
  IF g.enabled IS DISTINCT FROM true THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'GAME_DISABLED', 'severity', 'blocking', 'detail', NULL);
  END IF;
  IF NOT coalesce(g.must_move, false) THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'NOT_A_MUST_MOVE_GAME', 'severity', 'blocking', 'detail', NULL);
  END IF;
  IF coalesce((v_row ->> 'open_alerts')::integer, 0) > 0 THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'OPEN_ALERTS', 'severity', 'blocking',
                                                 'detail', (v_row ->> 'open_alerts')::integer);
  END IF;
  IF coalesce((v_row ->> 'integrity_open_high')::integer, 0) > 0 THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'INTEGRITY_HIGH_SIGNALS_OPEN', 'severity', 'blocking',
                                                 'detail', (v_row ->> 'integrity_open_high')::integer);
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(v_cfg -> 'invalid', '[]'::jsonb)) x(v)
              WHERE x.v ->> 'key' = 'matcher_version') THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'MATCHER_VERSION_INVALID', 'severity', 'blocking',
      'detail', (SELECT jsonb_agg(x.v) FROM jsonb_array_elements(v_cfg -> 'invalid') x(v) WHERE x.v ->> 'key' = 'matcher_version'));
  END IF;
  IF (v_cfg ->> 'worker_mode') = 'off' THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'WORKER_OFF', 'severity', 'blocking',
      'detail', 'worker_mode off: a converted pool would form no hands (set_worker_mode form)');
  ELSIF (v_cfg ->> 'worker_mode') = 'shadow' THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'WORKER_SHADOW_ONLY', 'severity', 'evidence',
      'detail', 'worker_mode shadow plans and compares and forms no hands');
  END IF;

  -- THE SHADOW: the A/A calibration of the live matcher against its port,
  -- and the candidate, from this Cluster's comparisons or else the estate's.
  v_sr := public.fn_lightning_shadow_report(g.id, v_now - interval '7 days', v_now);
  v_scope := 'cluster';
  IF jsonb_array_length(coalesce(v_sr -> 'version_pairs', '[]'::jsonb)) = 0 THEN
    v_sr := public.fn_lightning_shadow_report(NULL, v_now - interval '7 days', v_now);
    v_scope := CASE WHEN jsonb_array_length(coalesce(v_sr -> 'version_pairs', '[]'::jsonb)) = 0 THEN NULL ELSE 'estate' END;
  END IF;
  SELECT p.v INTO v_aa FROM jsonb_array_elements(coalesce(v_sr -> 'version_pairs', '[]'::jsonb)) p(v)
   WHERE p.v ->> 'live_matcher_version' = v_live_v AND coalesce((p.v ->> 'aa_calibration')::boolean, false)
   LIMIT 1;
  SELECT p.v INTO v_cand FROM jsonb_array_elements(coalesce(v_sr -> 'version_pairs', '[]'::jsonb)) p(v)
   WHERE p.v ->> 'live_matcher_version' = v_live_v AND p.v ->> 'shadow_matcher_version' = v_cfg ->> 'shadow_matcher_version'
     AND NOT coalesce((p.v ->> 'aa_calibration')::boolean, false)
   LIMIT 1;
  IF v_aa ->> 'verdict' = 'calibration_bias' THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'AA_CALIBRATION_BIAS', 'severity', 'blocking', 'detail', v_aa);
  ELSIF v_aa IS NULL OR v_aa ->> 'verdict' IS DISTINCT FROM 'calibrated' THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'NO_AA_CALIBRATION', 'severity', 'evidence',
                                                 'detail', coalesce(v_aa -> 'verdict', 'null'::jsonb));
  END IF;

  -- THE LATENCY: no leg above its ceiling over the configured windows.
  FOR v_leg IN SELECT x.k FROM jsonb_object_keys(coalesce(v_cfg -> 'alert_latency_p95_ms', '{}'::jsonb)) x(k) ORDER BY x.k LOOP
    v_reg := public.fn_lightning_latency_regression(g.id, v_leg, v_cfg, v_now);
    IF v_reg IS NOT NULL THEN
      v_over := v_over || jsonb_build_object('leg', v_leg, 'ceiling_ms', v_cfg -> 'alert_latency_p95_ms' -> v_leg,
                                             'windows', v_reg);
    END IF;
  END LOOP;
  IF jsonb_array_length(v_over) > 0 THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'LATENCY_ABOVE_CEILING', 'severity', 'blocking', 'detail', v_over);
  END IF;
  v_lat_to := (v_row -> 'latency' ->> 'window_to')::timestamptz;
  IF v_lat_to IS NULL OR v_lat_to < v_now - interval '24 hours' THEN
    v_reasons := v_reasons || jsonb_build_object('code', 'NO_LATENCY_EVIDENCE', 'severity', 'evidence',
                                                 'detail', to_jsonb(v_lat_to));
  END IF;

  v_verdict := CASE
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_reasons) r(v) WHERE r.v ->> 'severity' = 'blocking') THEN 'no_go'
    WHEN jsonb_array_length(v_reasons) > 0 THEN 'insufficient_evidence'
    ELSE 'go' END;

  RETURN public.fn_lightning_operator_redact(jsonb_build_object(
    'ok', true,
    'cluster_id', g.id,
    'as_of', v_now,
    'verdict', v_verdict,
    'reasons', v_reasons,
    'evidence', jsonb_build_object(
      'migrations', jsonb_build_object('expected', cardinality(c_versions),
                                       'applied', cardinality(c_versions) - coalesce(cardinality(v_missing), cardinality(c_versions)),
                                       'missing', to_jsonb(v_missing)),
      'invariants', jsonb_build_object('seven_tables', v_seven, 'anti_manipulation', v_anti, 'law_10_5', v_law,
                                       'no_anon_door', v_doors, 'proofs_evaluated_in_sql', false),
      'cluster', jsonb_build_object(
        'cluster_mode', g.cluster_mode, 'lightning_enabled', coalesce(g.lightning_enabled, false),
        'game_enabled', g.enabled, 'must_move', g.must_move,
        'frozen', g.cluster_mode = 'frozen', 'paused', g.cluster_mode = 'paused',
        'drain_open', jsonb_typeof(v_row -> 'drain') = 'object',
        'worker_mode', v_cfg ->> 'worker_mode',
        'live_eligible', v_row -> 'live_eligible', 'on_threshold', v_row -> 'on_threshold',
        'off_threshold', v_row -> 'off_threshold',
        'would_turn_on', coalesce((v_row ->> 'live_eligible')::integer, 0) >= coalesce((v_row ->> 'on_threshold')::integer, 0),
        'club_is_public', v_club.is_public, 'game_is_private', g.is_private),
      'alerts', jsonb_build_object('open', v_row -> 'open_alerts'),
      'integrity', jsonb_build_object('open', v_row -> 'integrity_open_signals', 'open_high', v_row -> 'integrity_open_high'),
      'shadow', jsonb_build_object('scope', v_scope, 'aa_calibration', v_aa, 'candidate', v_cand),
      'latency', jsonb_build_object('latest_window_to', v_lat_to, 'over', v_over),
      'matcher', v_row -> 'matcher')));
END
$function$

