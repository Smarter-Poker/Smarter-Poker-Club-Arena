-- 20260930233329_horse_observation_window_persistence
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-30 23:33:29 UTC.
--

-- Original contribution times are saved in the counter transaction. No history
-- is invented for legacy rows, and no source time is derived from updated_at.
BEGIN;
SET LOCAL lock_timeout = '3s';

DO $preimage$
BEGIN
  IF md5(pg_get_functiondef('public.upsert_horse_mind_stats(jsonb)'::regprocedure)) IS DISTINCT FROM '84df6d650c905cedba86f2698f1fbd3d' THEN RAISE EXCEPTION 'horse source-window preimage drift: upsert_horse_mind_stats(jsonb)'; END IF;
  IF md5(pg_get_functiondef('public.upsert_horse_mind_stats_scoped(jsonb)'::regprocedure)) IS DISTINCT FROM '73884faf30f48913dba34053fdd33337' THEN RAISE EXCEPTION 'horse source-window preimage drift: upsert_horse_mind_stats_scoped(jsonb)'; END IF;
END
$preimage$;

ALTER TABLE public.horse_mind_stats ADD COLUMN source_window jsonb;
ALTER TABLE public.horse_mind_stats_scoped ADD COLUMN source_window jsonb;

CREATE FUNCTION public.fn_horse_mind_source_window_normalize(value jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $fn$
DECLARE
  unknown_window constant jsonb := '{"version":1,"coverage":"unknown","fromMs":null,"toMs":null}';
  lo numeric; hi numeric;
BEGIN
  IF value IS NULL OR jsonb_typeof(value) <> 'object' THEN RETURN unknown_window; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(value)) <> 4
     OR NOT value ?& ARRAY['version','coverage','fromMs','toMs']
     OR value->'version' IS DISTINCT FROM '1'::jsonb THEN RETURN unknown_window; END IF;
  IF value->>'coverage' = 'unknown' THEN RETURN unknown_window; END IF;
  IF value->>'coverage' NOT IN ('complete','partial') OR value->>'coverage' IS NULL
     OR jsonb_typeof(value->'fromMs') IS DISTINCT FROM 'number'
     OR jsonb_typeof(value->'toMs') IS DISTINCT FROM 'number' THEN RETURN unknown_window; END IF;
  lo := (value->>'fromMs')::numeric; hi := (value->>'toMs')::numeric;
  IF lo < 1 OR hi < lo OR hi > 9007199254740991
     OR trunc(lo) <> lo OR trunc(hi) <> hi THEN RETURN unknown_window; END IF;
  RETURN jsonb_build_object('version',1,'coverage',value->>'coverage','fromMs',lo,'toMs',hi);
END
$fn$;

CREATE FUNCTION public.fn_horse_mind_source_window_merge(previous jsonb, incoming jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
  WITH normalized AS (
    SELECT public.fn_horse_mind_source_window_normalize(previous) AS a,
           public.fn_horse_mind_source_window_normalize(incoming) AS b
  )
  SELECT CASE
    WHEN a->>'coverage' = 'unknown' AND b->>'coverage' = 'unknown' THEN a
    ELSE jsonb_build_object(
      'version',1,
      'coverage',CASE WHEN a->>'coverage' = 'complete' AND b->>'coverage' = 'complete'
                      THEN 'complete' ELSE 'partial' END,
      'fromMs',LEAST((a->>'fromMs')::numeric,(b->>'fromMs')::numeric),
      'toMs',GREATEST((a->>'toMs')::numeric,(b->>'toMs')::numeric))
  END FROM normalized;
$fn$;

REVOKE ALL ON FUNCTION public.fn_horse_mind_source_window_normalize(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_horse_mind_source_window_merge(jsonb,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_mind_source_window_normalize(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_horse_mind_source_window_merge(jsonb,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.upsert_horse_mind_stats(rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  n integer := 0;
  r jsonb;
BEGIN
  IF rows IS NULL OR jsonb_typeof(rows) <> 'array' THEN
    RETURN 0;
  END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(rows) LOOP
    CONTINUE WHEN r->>'user_id' IS NULL OR length(r->>'user_id') = 0 OR length(r->>'user_id') > 128;
    INSERT INTO public.horse_mind_stats AS t
      (user_id, hands, vpip, pfr, three_bet, aggr, passive, folds, faced_aggr,
       cbet_opps, cbet_folds, f3b_opps, f3b_folds, bigbet_sd, bigbet_sd_strong,
       post_aggr, post_passive, river_bet_opps, river_bet_folds, checks,
       snap_bet_sd, snap_bet_sd_strong, tank_bet_sd, tank_bet_sd_strong,
       r_hands, r_folds, r_faced_aggr, r_aggr, r_passive, r_checks, source_window, updated_at)
    VALUES
      (r->>'user_id',
       COALESCE((r->>'hands')::integer, 0),
       COALESCE((r->>'vpip')::integer, 0),
       COALESCE((r->>'pfr')::integer, 0),
       COALESCE((r->>'three_bet')::integer, 0),
       COALESCE((r->>'aggr')::integer, 0),
       COALESCE((r->>'passive')::integer, 0),
       COALESCE((r->>'folds')::integer, 0),
       COALESCE((r->>'faced_aggr')::integer, 0),
       COALESCE((r->>'cbet_opps')::integer, 0),
       COALESCE((r->>'cbet_folds')::integer, 0),
       COALESCE((r->>'f3b_opps')::integer, 0),
       COALESCE((r->>'f3b_folds')::integer, 0),
       COALESCE((r->>'bigbet_sd')::integer, 0),
       COALESCE((r->>'bigbet_sd_strong')::integer, 0),
       COALESCE((r->>'post_aggr')::integer, 0),
       COALESCE((r->>'post_passive')::integer, 0),
       COALESCE((r->>'river_bet_opps')::integer, 0),
       COALESCE((r->>'river_bet_folds')::integer, 0),
       COALESCE((r->>'checks')::integer, 0),
       COALESCE((r->>'snap_bet_sd')::integer, 0),
       COALESCE((r->>'snap_bet_sd_strong')::integer, 0),
       COALESCE((r->>'tank_bet_sd')::integer, 0),
       COALESCE((r->>'tank_bet_sd_strong')::integer, 0),
       COALESCE((r->>'r_hands')::real, 0),
       COALESCE((r->>'r_folds')::real, 0),
       COALESCE((r->>'r_faced_aggr')::real, 0),
       COALESCE((r->>'r_aggr')::real, 0),
       COALESCE((r->>'r_passive')::real, 0),
       COALESCE((r->>'r_checks')::real, 0),
       public.fn_horse_mind_source_window_normalize(r->'source_window'),
       now())
    ON CONFLICT (user_id) DO UPDATE SET
      hands            = GREATEST(t.hands, EXCLUDED.hands),
      vpip             = GREATEST(t.vpip, EXCLUDED.vpip),
      pfr              = GREATEST(t.pfr, EXCLUDED.pfr),
      three_bet        = GREATEST(t.three_bet, EXCLUDED.three_bet),
      aggr             = GREATEST(t.aggr, EXCLUDED.aggr),
      passive          = GREATEST(t.passive, EXCLUDED.passive),
      folds            = GREATEST(t.folds, EXCLUDED.folds),
      faced_aggr       = GREATEST(t.faced_aggr, EXCLUDED.faced_aggr),
      cbet_opps        = GREATEST(t.cbet_opps, EXCLUDED.cbet_opps),
      cbet_folds       = GREATEST(t.cbet_folds, EXCLUDED.cbet_folds),
      f3b_opps         = GREATEST(t.f3b_opps, EXCLUDED.f3b_opps),
      f3b_folds        = GREATEST(t.f3b_folds, EXCLUDED.f3b_folds),
      bigbet_sd        = GREATEST(t.bigbet_sd, EXCLUDED.bigbet_sd),
      bigbet_sd_strong = GREATEST(t.bigbet_sd_strong, EXCLUDED.bigbet_sd_strong),
      post_aggr        = GREATEST(t.post_aggr, EXCLUDED.post_aggr),
      post_passive     = GREATEST(t.post_passive, EXCLUDED.post_passive),
      river_bet_opps   = GREATEST(t.river_bet_opps, EXCLUDED.river_bet_opps),
      river_bet_folds  = GREATEST(t.river_bet_folds, EXCLUDED.river_bet_folds),
      checks           = GREATEST(t.checks, EXCLUDED.checks),
      snap_bet_sd        = GREATEST(t.snap_bet_sd, EXCLUDED.snap_bet_sd),
      snap_bet_sd_strong = GREATEST(t.snap_bet_sd_strong, EXCLUDED.snap_bet_sd_strong),
      tank_bet_sd        = GREATEST(t.tank_bet_sd, EXCLUDED.tank_bet_sd),
      tank_bet_sd_strong = GREATEST(t.tank_bet_sd_strong, EXCLUDED.tank_bet_sd_strong),
      r_hands      = EXCLUDED.r_hands,
      r_folds      = EXCLUDED.r_folds,
      r_faced_aggr = EXCLUDED.r_faced_aggr,
      r_aggr       = EXCLUDED.r_aggr,
      r_passive    = EXCLUDED.r_passive,
      r_checks     = EXCLUDED.r_checks,
      source_window = CASE
        WHEN NOT (GREATEST(t.hands,t.vpip,t.pfr,t.three_bet,t.aggr,t.passive,t.folds,t.faced_aggr,t.cbet_opps,t.cbet_folds,t.f3b_opps,t.f3b_folds,t.bigbet_sd,t.bigbet_sd_strong,t.post_aggr,t.post_passive,t.river_bet_opps,t.river_bet_folds,t.checks,t.snap_bet_sd,t.snap_bet_sd_strong,t.tank_bet_sd,t.tank_bet_sd_strong,t.r_hands,t.r_folds,t.r_faced_aggr,t.r_aggr,t.r_passive,t.r_checks) > 0) THEN
          CASE WHEN GREATEST(EXCLUDED.hands,EXCLUDED.vpip,EXCLUDED.pfr,EXCLUDED.three_bet,EXCLUDED.aggr,EXCLUDED.passive,EXCLUDED.folds,EXCLUDED.faced_aggr,EXCLUDED.cbet_opps,EXCLUDED.cbet_folds,EXCLUDED.f3b_opps,EXCLUDED.f3b_folds,EXCLUDED.bigbet_sd,EXCLUDED.bigbet_sd_strong,EXCLUDED.post_aggr,EXCLUDED.post_passive,EXCLUDED.river_bet_opps,EXCLUDED.river_bet_folds,EXCLUDED.checks,EXCLUDED.snap_bet_sd,EXCLUDED.snap_bet_sd_strong,EXCLUDED.tank_bet_sd,EXCLUDED.tank_bet_sd_strong,EXCLUDED.r_hands,EXCLUDED.r_folds,EXCLUDED.r_faced_aggr,EXCLUDED.r_aggr,EXCLUDED.r_passive,EXCLUDED.r_checks) > 0 THEN EXCLUDED.source_window
               ELSE public.fn_horse_mind_source_window_normalize(NULL) END
        WHEN (GREATEST(EXCLUDED.hands,EXCLUDED.vpip,EXCLUDED.pfr,EXCLUDED.three_bet,EXCLUDED.aggr,EXCLUDED.passive,EXCLUDED.folds,EXCLUDED.faced_aggr,EXCLUDED.cbet_opps,EXCLUDED.cbet_folds,EXCLUDED.f3b_opps,EXCLUDED.f3b_folds,EXCLUDED.bigbet_sd,EXCLUDED.bigbet_sd_strong,EXCLUDED.post_aggr,EXCLUDED.post_passive,EXCLUDED.river_bet_opps,EXCLUDED.river_bet_folds,EXCLUDED.checks,EXCLUDED.snap_bet_sd,EXCLUDED.snap_bet_sd_strong,EXCLUDED.tank_bet_sd,EXCLUDED.tank_bet_sd_strong,EXCLUDED.r_hands,EXCLUDED.r_folds,EXCLUDED.r_faced_aggr,EXCLUDED.r_aggr,EXCLUDED.r_passive,EXCLUDED.r_checks) > 0)
             AND EXCLUDED.source_window->>'coverage' <> 'unknown' THEN
          public.fn_horse_mind_source_window_merge(t.source_window, EXCLUDED.source_window)
        -- Recency is replaced even when its numeric value is unchanged. A
        -- nonzero legacy recency payload therefore has unknown source history.
        WHEN GREATEST(EXCLUDED.r_hands,EXCLUDED.r_folds,EXCLUDED.r_faced_aggr,
                      EXCLUDED.r_aggr,EXCLUDED.r_passive,EXCLUDED.r_checks) > 0 OR
             EXCLUDED.hands > t.hands OR
            EXCLUDED.vpip > t.vpip OR
            EXCLUDED.pfr > t.pfr OR
            EXCLUDED.three_bet > t.three_bet OR
            EXCLUDED.aggr > t.aggr OR
            EXCLUDED.passive > t.passive OR
            EXCLUDED.folds > t.folds OR
            EXCLUDED.faced_aggr > t.faced_aggr OR
            EXCLUDED.cbet_opps > t.cbet_opps OR
            EXCLUDED.cbet_folds > t.cbet_folds OR
            EXCLUDED.f3b_opps > t.f3b_opps OR
            EXCLUDED.f3b_folds > t.f3b_folds OR
            EXCLUDED.bigbet_sd > t.bigbet_sd OR
            EXCLUDED.bigbet_sd_strong > t.bigbet_sd_strong OR
            EXCLUDED.post_aggr > t.post_aggr OR
            EXCLUDED.post_passive > t.post_passive OR
            EXCLUDED.river_bet_opps > t.river_bet_opps OR
            EXCLUDED.river_bet_folds > t.river_bet_folds OR
            EXCLUDED.checks > t.checks OR
            EXCLUDED.snap_bet_sd > t.snap_bet_sd OR
            EXCLUDED.snap_bet_sd_strong > t.snap_bet_sd_strong OR
            EXCLUDED.tank_bet_sd > t.tank_bet_sd OR
            EXCLUDED.tank_bet_sd_strong > t.tank_bet_sd_strong OR
            EXCLUDED.r_hands IS DISTINCT FROM t.r_hands OR
            EXCLUDED.r_folds IS DISTINCT FROM t.r_folds OR
            EXCLUDED.r_faced_aggr IS DISTINCT FROM t.r_faced_aggr OR
            EXCLUDED.r_aggr IS DISTINCT FROM t.r_aggr OR
            EXCLUDED.r_passive IS DISTINCT FROM t.r_passive OR
            EXCLUDED.r_checks IS DISTINCT FROM t.r_checks THEN
          public.fn_horse_mind_source_window_merge(t.source_window, NULL)
        ELSE public.fn_horse_mind_source_window_normalize(t.source_window)
      END,
      updated_at = now();
    n := n + 1;
  END LOOP;
  RETURN n;
END
$function$
;

CREATE OR REPLACE FUNCTION public.upsert_horse_mind_stats_scoped(rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare n integer := 0; r jsonb;
begin
  if rows is null or jsonb_typeof(rows) <> 'array' then return 0; end if;
  for r in select * from jsonb_array_elements(rows) loop
    continue when r->>'user_id' is null or length(r->>'user_id') = 0 or length(r->>'user_id') > 128;
    continue when r->>'scope' is null or (r->>'scope') !~ '^(holdem|omaha|sixplus):(hu|short|full)$';
    insert into public.horse_mind_stats_scoped as t
      (user_id, scope, hands, vpip, pfr, three_bet, aggr, passive, folds, faced_aggr,
       cbet_opps, cbet_folds, f3b_opps, f3b_folds, bigbet_sd, bigbet_sd_strong,
       river_bet_opps, river_bet_folds, checks, post_aggr, post_passive,
       snap_bet_sd, snap_bet_sd_strong, tank_bet_sd, tank_bet_sd_strong, source_window, updated_at)
    values
      (r->>'user_id', r->>'scope',
       coalesce((r->>'hands')::integer, 0),
       coalesce((r->>'vpip')::integer, 0),
       coalesce((r->>'pfr')::integer, 0),
       coalesce((r->>'three_bet')::integer, 0),
       coalesce((r->>'aggr')::integer, 0),
       coalesce((r->>'passive')::integer, 0),
       coalesce((r->>'folds')::integer, 0),
       coalesce((r->>'faced_aggr')::integer, 0),
       coalesce((r->>'cbet_opps')::integer, 0),
       coalesce((r->>'cbet_folds')::integer, 0),
       coalesce((r->>'f3b_opps')::integer, 0),
       coalesce((r->>'f3b_folds')::integer, 0),
       coalesce((r->>'bigbet_sd')::integer, 0),
       coalesce((r->>'bigbet_sd_strong')::integer, 0),
       coalesce((r->>'river_bet_opps')::integer, 0),
       coalesce((r->>'river_bet_folds')::integer, 0),
       coalesce((r->>'checks')::integer, 0),
       coalesce((r->>'post_aggr')::integer, 0),
       coalesce((r->>'post_passive')::integer, 0),
       coalesce((r->>'snap_bet_sd')::integer, 0),
       coalesce((r->>'snap_bet_sd_strong')::integer, 0),
       coalesce((r->>'tank_bet_sd')::integer, 0),
       coalesce((r->>'tank_bet_sd_strong')::integer, 0),
       public.fn_horse_mind_source_window_normalize(r->'source_window'),
       now())
    on conflict (user_id, scope) do update set
      hands = greatest(t.hands, excluded.hands),
      vpip = greatest(t.vpip, excluded.vpip),
      pfr = greatest(t.pfr, excluded.pfr),
      three_bet = greatest(t.three_bet, excluded.three_bet),
      aggr = greatest(t.aggr, excluded.aggr),
      passive = greatest(t.passive, excluded.passive),
      folds = greatest(t.folds, excluded.folds),
      faced_aggr = greatest(t.faced_aggr, excluded.faced_aggr),
      cbet_opps = greatest(t.cbet_opps, excluded.cbet_opps),
      cbet_folds = greatest(t.cbet_folds, excluded.cbet_folds),
      f3b_opps = greatest(t.f3b_opps, excluded.f3b_opps),
      f3b_folds = greatest(t.f3b_folds, excluded.f3b_folds),
      bigbet_sd = greatest(t.bigbet_sd, excluded.bigbet_sd),
      bigbet_sd_strong = greatest(t.bigbet_sd_strong, excluded.bigbet_sd_strong),
      river_bet_opps = greatest(t.river_bet_opps, excluded.river_bet_opps),
      river_bet_folds = greatest(t.river_bet_folds, excluded.river_bet_folds),
      checks = greatest(t.checks, excluded.checks),
      post_aggr = greatest(t.post_aggr, excluded.post_aggr),
      post_passive = greatest(t.post_passive, excluded.post_passive),
      snap_bet_sd = greatest(t.snap_bet_sd, excluded.snap_bet_sd),
      snap_bet_sd_strong = greatest(t.snap_bet_sd_strong, excluded.snap_bet_sd_strong),
      tank_bet_sd = greatest(t.tank_bet_sd, excluded.tank_bet_sd),
      tank_bet_sd_strong = greatest(t.tank_bet_sd_strong, excluded.tank_bet_sd_strong),
      source_window = CASE
        WHEN NOT (GREATEST(t.hands,t.vpip,t.pfr,t.three_bet,t.aggr,t.passive,t.folds,t.faced_aggr,t.cbet_opps,t.cbet_folds,t.f3b_opps,t.f3b_folds,t.bigbet_sd,t.bigbet_sd_strong,t.river_bet_opps,t.river_bet_folds,t.checks,t.post_aggr,t.post_passive,t.snap_bet_sd,t.snap_bet_sd_strong,t.tank_bet_sd,t.tank_bet_sd_strong) > 0) THEN
          CASE WHEN GREATEST(EXCLUDED.hands,EXCLUDED.vpip,EXCLUDED.pfr,EXCLUDED.three_bet,EXCLUDED.aggr,EXCLUDED.passive,EXCLUDED.folds,EXCLUDED.faced_aggr,EXCLUDED.cbet_opps,EXCLUDED.cbet_folds,EXCLUDED.f3b_opps,EXCLUDED.f3b_folds,EXCLUDED.bigbet_sd,EXCLUDED.bigbet_sd_strong,EXCLUDED.river_bet_opps,EXCLUDED.river_bet_folds,EXCLUDED.checks,EXCLUDED.post_aggr,EXCLUDED.post_passive,EXCLUDED.snap_bet_sd,EXCLUDED.snap_bet_sd_strong,EXCLUDED.tank_bet_sd,EXCLUDED.tank_bet_sd_strong) > 0 THEN EXCLUDED.source_window
               ELSE public.fn_horse_mind_source_window_normalize(NULL) END
        WHEN (GREATEST(EXCLUDED.hands,EXCLUDED.vpip,EXCLUDED.pfr,EXCLUDED.three_bet,EXCLUDED.aggr,EXCLUDED.passive,EXCLUDED.folds,EXCLUDED.faced_aggr,EXCLUDED.cbet_opps,EXCLUDED.cbet_folds,EXCLUDED.f3b_opps,EXCLUDED.f3b_folds,EXCLUDED.bigbet_sd,EXCLUDED.bigbet_sd_strong,EXCLUDED.river_bet_opps,EXCLUDED.river_bet_folds,EXCLUDED.checks,EXCLUDED.post_aggr,EXCLUDED.post_passive,EXCLUDED.snap_bet_sd,EXCLUDED.snap_bet_sd_strong,EXCLUDED.tank_bet_sd,EXCLUDED.tank_bet_sd_strong) > 0)
             AND EXCLUDED.source_window->>'coverage' <> 'unknown' THEN
          public.fn_horse_mind_source_window_merge(t.source_window, EXCLUDED.source_window)
        WHEN EXCLUDED.hands > t.hands OR
            EXCLUDED.vpip > t.vpip OR
            EXCLUDED.pfr > t.pfr OR
            EXCLUDED.three_bet > t.three_bet OR
            EXCLUDED.aggr > t.aggr OR
            EXCLUDED.passive > t.passive OR
            EXCLUDED.folds > t.folds OR
            EXCLUDED.faced_aggr > t.faced_aggr OR
            EXCLUDED.cbet_opps > t.cbet_opps OR
            EXCLUDED.cbet_folds > t.cbet_folds OR
            EXCLUDED.f3b_opps > t.f3b_opps OR
            EXCLUDED.f3b_folds > t.f3b_folds OR
            EXCLUDED.bigbet_sd > t.bigbet_sd OR
            EXCLUDED.bigbet_sd_strong > t.bigbet_sd_strong OR
            EXCLUDED.river_bet_opps > t.river_bet_opps OR
            EXCLUDED.river_bet_folds > t.river_bet_folds OR
            EXCLUDED.checks > t.checks OR
            EXCLUDED.post_aggr > t.post_aggr OR
            EXCLUDED.post_passive > t.post_passive OR
            EXCLUDED.snap_bet_sd > t.snap_bet_sd OR
            EXCLUDED.snap_bet_sd_strong > t.snap_bet_sd_strong OR
            EXCLUDED.tank_bet_sd > t.tank_bet_sd OR
            EXCLUDED.tank_bet_sd_strong > t.tank_bet_sd_strong THEN
          public.fn_horse_mind_source_window_merge(t.source_window, NULL)
        ELSE public.fn_horse_mind_source_window_normalize(t.source_window)
      END,
      updated_at = now();
    n := n + 1;
  end loop;
  return n;
end $function$
;
-- Existing function owner, ACL, signature and SECURITY DEFINER are retained.
-- No table grants, RLS or policies change; legacy rows are not backfilled.
REVOKE ALL ON FUNCTION public.upsert_horse_mind_stats(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_horse_mind_stats(jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.upsert_horse_mind_stats_scoped(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_horse_mind_stats_scoped(jsonb) TO service_role;
COMMIT;
