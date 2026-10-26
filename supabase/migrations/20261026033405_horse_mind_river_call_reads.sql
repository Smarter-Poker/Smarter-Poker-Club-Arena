-- @install-window: daily-maintenance
-- 20261026033405_horse_mind_river_call_reads.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan ruled on 2026-10-25 that a hand whose last river decision was a call is
-- shown at showdown. Humans now see what an opponent called the river with, and
-- CLAUDE.md 10.5 requires the horses to learn from the same information. The
-- engine adds two HorseMind counters per observed player (river call read):
--   riverCallSD     - shown hands whose last river action was a call
--   riverCallSDWeak - ... shown as one pair or worse (a light call)
-- read by HorseMind.riverCallLightTendency and HorseLogic's heads-up river
-- bluff / thin-value decision. This file persists them like every other
-- counter (GREATEST-merged), in the pooled and the scoped table.
--
-- WHY THE DAILY WINDOW. horse_mind_stats and horse_mind_stats_scoped are
-- written by the engine's flush throughout play (pg_stat_user_tables,
-- 2026-10-26 03:3x UTC: 7,747,352 and 9,996,386 updates). ADD COLUMN takes
-- ACCESS EXCLUSIVE, so per CLAUDE.md section 2 rules 9 and 10 it installs in
-- the 04:00 America/Chicago maintenance window. Both ADD COLUMNs carry a
-- constant default, so they are catalogue-only (no table rewrite).
--
-- ORDER WITH THE ENGINE. Either may land first:
--   * engine first: the flush sends river_call_sd / river_call_sd_weak, which
--     the current RPCs ignore (they read named keys from each JSON row); the
--     hydrate drops the two absent columns from its projection on 42703 only
--     and reads them as 0. Nothing fails; the counters are simply not stored.
--   * migration first: the old engine sends no such keys, so the RPCs store 0
--     (COALESCE) and GREATEST never lowers a stored value.
--
-- The two RPC bodies are the live bodies (pg_get_functiondef md5 read
-- 2026-10-26: upsert_horse_mind_stats 648dd5565a2e07e320cf7e8ff6a84f0b,
-- upsert_horse_mind_stats_scoped d0c06a49e33ea919e8dabf87020bc0da) with the
-- two columns added to the insert list, the values, the GREATEST merge and the
-- source-window contribution lists, nothing else. If either body has changed
-- since, the preimage check refuses and the file stays queued.
--
-- One transaction (production DDL policy). No data is written.
--
-- @live-proof: (SELECT count(*) = 4 FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('horse_mind_stats', 'horse_mind_stats_scoped') AND column_name IN ('river_call_sd', 'river_call_sd_weak')) AND position('river_call_sd_weak' in pg_get_functiondef('public.upsert_horse_mind_stats(jsonb)'::regprocedure)) > 0 AND position('river_call_sd_weak' in pg_get_functiondef('public.upsert_horse_mind_stats_scoped(jsonb)'::regprocedure)) > 0

BEGIN;
SET LOCAL lock_timeout = '1s';

DO $preimage$
BEGIN
  IF md5(pg_get_functiondef('public.upsert_horse_mind_stats(jsonb)'::regprocedure)) IS DISTINCT FROM '648dd5565a2e07e320cf7e8ff6a84f0b' THEN RAISE EXCEPTION 'horse river-call preimage drift: upsert_horse_mind_stats(jsonb)'; END IF;
  IF md5(pg_get_functiondef('public.upsert_horse_mind_stats_scoped(jsonb)'::regprocedure)) IS DISTINCT FROM 'd0c06a49e33ea919e8dabf87020bc0da' THEN RAISE EXCEPTION 'horse river-call preimage drift: upsert_horse_mind_stats_scoped(jsonb)'; END IF;
END
$preimage$;

ALTER TABLE public.horse_mind_stats
  ADD COLUMN river_call_sd integer NOT NULL DEFAULT 0,
  ADD COLUMN river_call_sd_weak integer NOT NULL DEFAULT 0;
ALTER TABLE public.horse_mind_stats_scoped
  ADD COLUMN river_call_sd integer NOT NULL DEFAULT 0,
  ADD COLUMN river_call_sd_weak integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.horse_mind_stats.river_call_sd IS 'River call read (2026-10-25): shown hands whose last river action was a call. Consumer: HorseMind.riverCallLightTendency.';
COMMENT ON COLUMN public.horse_mind_stats.river_call_sd_weak IS 'River call read (2026-10-25): ... shown as one pair or worse. Consumer: HorseMind.riverCallLightTendency.';
COMMENT ON COLUMN public.horse_mind_stats_scoped.river_call_sd IS 'River call read (2026-10-25): shown hands whose last river action was a call, per read scope.';
COMMENT ON COLUMN public.horse_mind_stats_scoped.river_call_sd_weak IS 'River call read (2026-10-25): ... shown as one pair or worse, per read scope.';

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
  -- KEY ORDER, INPUT ORDER WITHIN A KEY (2026-10-01). Concurrent flushes upserted
  -- overlapping keys in the order each caller listed them and deadlocked on this
  -- table. Every caller now takes the rows in key order; repeats of one key keep
  -- their input order, so the value each column ends with is unchanged.
  FOR r IN SELECT e.value FROM jsonb_array_elements(rows) WITH ORDINALITY AS e(value, ord)
            ORDER BY e.value->>'user_id', e.ord LOOP
    CONTINUE WHEN r->>'user_id' IS NULL OR length(r->>'user_id') = 0 OR length(r->>'user_id') > 128;
    INSERT INTO public.horse_mind_stats AS t
      (user_id, hands, vpip, pfr, three_bet, aggr, passive, folds, faced_aggr,
       cbet_opps, cbet_folds, f3b_opps, f3b_folds, bigbet_sd, bigbet_sd_strong,
       post_aggr, post_passive, river_bet_opps, river_bet_folds, checks,
       snap_bet_sd, snap_bet_sd_strong, tank_bet_sd, tank_bet_sd_strong,
       river_call_sd, river_call_sd_weak,
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
       COALESCE((r->>'river_call_sd')::integer, 0),
       COALESCE((r->>'river_call_sd_weak')::integer, 0),
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
      river_call_sd      = GREATEST(t.river_call_sd, EXCLUDED.river_call_sd),
      river_call_sd_weak = GREATEST(t.river_call_sd_weak, EXCLUDED.river_call_sd_weak),
      r_hands      = EXCLUDED.r_hands,
      r_folds      = EXCLUDED.r_folds,
      r_faced_aggr = EXCLUDED.r_faced_aggr,
      r_aggr       = EXCLUDED.r_aggr,
      r_passive    = EXCLUDED.r_passive,
      r_checks     = EXCLUDED.r_checks,
      source_window = CASE
        WHEN NOT (GREATEST(t.hands,t.vpip,t.pfr,t.three_bet,t.aggr,t.passive,t.folds,t.faced_aggr,t.cbet_opps,t.cbet_folds,t.f3b_opps,t.f3b_folds,t.bigbet_sd,t.bigbet_sd_strong,t.post_aggr,t.post_passive,t.river_bet_opps,t.river_bet_folds,t.checks,t.snap_bet_sd,t.snap_bet_sd_strong,t.tank_bet_sd,t.tank_bet_sd_strong,t.river_call_sd,t.river_call_sd_weak,t.r_hands,t.r_folds,t.r_faced_aggr,t.r_aggr,t.r_passive,t.r_checks) > 0) THEN
          CASE WHEN GREATEST(EXCLUDED.hands,EXCLUDED.vpip,EXCLUDED.pfr,EXCLUDED.three_bet,EXCLUDED.aggr,EXCLUDED.passive,EXCLUDED.folds,EXCLUDED.faced_aggr,EXCLUDED.cbet_opps,EXCLUDED.cbet_folds,EXCLUDED.f3b_opps,EXCLUDED.f3b_folds,EXCLUDED.bigbet_sd,EXCLUDED.bigbet_sd_strong,EXCLUDED.post_aggr,EXCLUDED.post_passive,EXCLUDED.river_bet_opps,EXCLUDED.river_bet_folds,EXCLUDED.checks,EXCLUDED.snap_bet_sd,EXCLUDED.snap_bet_sd_strong,EXCLUDED.tank_bet_sd,EXCLUDED.tank_bet_sd_strong,EXCLUDED.river_call_sd,EXCLUDED.river_call_sd_weak,EXCLUDED.r_hands,EXCLUDED.r_folds,EXCLUDED.r_faced_aggr,EXCLUDED.r_aggr,EXCLUDED.r_passive,EXCLUDED.r_checks) > 0 THEN EXCLUDED.source_window
               ELSE public.fn_horse_mind_source_window_normalize(NULL) END
        WHEN (GREATEST(EXCLUDED.hands,EXCLUDED.vpip,EXCLUDED.pfr,EXCLUDED.three_bet,EXCLUDED.aggr,EXCLUDED.passive,EXCLUDED.folds,EXCLUDED.faced_aggr,EXCLUDED.cbet_opps,EXCLUDED.cbet_folds,EXCLUDED.f3b_opps,EXCLUDED.f3b_folds,EXCLUDED.bigbet_sd,EXCLUDED.bigbet_sd_strong,EXCLUDED.post_aggr,EXCLUDED.post_passive,EXCLUDED.river_bet_opps,EXCLUDED.river_bet_folds,EXCLUDED.checks,EXCLUDED.snap_bet_sd,EXCLUDED.snap_bet_sd_strong,EXCLUDED.tank_bet_sd,EXCLUDED.tank_bet_sd_strong,EXCLUDED.river_call_sd,EXCLUDED.river_call_sd_weak,EXCLUDED.r_hands,EXCLUDED.r_folds,EXCLUDED.r_faced_aggr,EXCLUDED.r_aggr,EXCLUDED.r_passive,EXCLUDED.r_checks) > 0)
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
            EXCLUDED.river_call_sd > t.river_call_sd OR
            EXCLUDED.river_call_sd_weak > t.river_call_sd_weak OR
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
$function$;

CREATE OR REPLACE FUNCTION public.upsert_horse_mind_stats_scoped(rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare n integer := 0; r jsonb;
begin
  if rows is null or jsonb_typeof(rows) <> 'array' then return 0; end if;
  -- KEY ORDER, INPUT ORDER WITHIN A KEY (2026-10-01). Concurrent flushes upserted
  -- overlapping keys in the order each caller listed them and deadlocked on this
  -- table. Every caller now takes the rows in key order; repeats of one key keep
  -- their input order, so the value each column ends with is unchanged.
  for r in select e.value from jsonb_array_elements(rows) with ordinality as e(value, ord)
            order by e.value->>'user_id', e.value->>'scope', e.ord loop
    continue when r->>'user_id' is null or length(r->>'user_id') = 0 or length(r->>'user_id') > 128;
    continue when r->>'scope' is null or (r->>'scope') !~ '^(holdem|omaha|sixplus):(hu|short|full)$';
    insert into public.horse_mind_stats_scoped as t
      (user_id, scope, hands, vpip, pfr, three_bet, aggr, passive, folds, faced_aggr,
       cbet_opps, cbet_folds, f3b_opps, f3b_folds, bigbet_sd, bigbet_sd_strong,
       river_bet_opps, river_bet_folds, checks, post_aggr, post_passive,
       snap_bet_sd, snap_bet_sd_strong, tank_bet_sd, tank_bet_sd_strong,
       river_call_sd, river_call_sd_weak, source_window, updated_at)
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
       coalesce((r->>'river_call_sd')::integer, 0),
       coalesce((r->>'river_call_sd_weak')::integer, 0),
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
      river_call_sd = greatest(t.river_call_sd, excluded.river_call_sd),
      river_call_sd_weak = greatest(t.river_call_sd_weak, excluded.river_call_sd_weak),
      source_window = CASE
        WHEN NOT (GREATEST(t.hands,t.vpip,t.pfr,t.three_bet,t.aggr,t.passive,t.folds,t.faced_aggr,t.cbet_opps,t.cbet_folds,t.f3b_opps,t.f3b_folds,t.bigbet_sd,t.bigbet_sd_strong,t.river_bet_opps,t.river_bet_folds,t.checks,t.post_aggr,t.post_passive,t.snap_bet_sd,t.snap_bet_sd_strong,t.tank_bet_sd,t.tank_bet_sd_strong,t.river_call_sd,t.river_call_sd_weak) > 0) THEN
          CASE WHEN GREATEST(EXCLUDED.hands,EXCLUDED.vpip,EXCLUDED.pfr,EXCLUDED.three_bet,EXCLUDED.aggr,EXCLUDED.passive,EXCLUDED.folds,EXCLUDED.faced_aggr,EXCLUDED.cbet_opps,EXCLUDED.cbet_folds,EXCLUDED.f3b_opps,EXCLUDED.f3b_folds,EXCLUDED.bigbet_sd,EXCLUDED.bigbet_sd_strong,EXCLUDED.river_bet_opps,EXCLUDED.river_bet_folds,EXCLUDED.checks,EXCLUDED.post_aggr,EXCLUDED.post_passive,EXCLUDED.snap_bet_sd,EXCLUDED.snap_bet_sd_strong,EXCLUDED.tank_bet_sd,EXCLUDED.tank_bet_sd_strong,EXCLUDED.river_call_sd,EXCLUDED.river_call_sd_weak) > 0 THEN EXCLUDED.source_window
               ELSE public.fn_horse_mind_source_window_normalize(NULL) END
        WHEN (GREATEST(EXCLUDED.hands,EXCLUDED.vpip,EXCLUDED.pfr,EXCLUDED.three_bet,EXCLUDED.aggr,EXCLUDED.passive,EXCLUDED.folds,EXCLUDED.faced_aggr,EXCLUDED.cbet_opps,EXCLUDED.cbet_folds,EXCLUDED.f3b_opps,EXCLUDED.f3b_folds,EXCLUDED.bigbet_sd,EXCLUDED.bigbet_sd_strong,EXCLUDED.river_bet_opps,EXCLUDED.river_bet_folds,EXCLUDED.checks,EXCLUDED.post_aggr,EXCLUDED.post_passive,EXCLUDED.snap_bet_sd,EXCLUDED.snap_bet_sd_strong,EXCLUDED.tank_bet_sd,EXCLUDED.tank_bet_sd_strong,EXCLUDED.river_call_sd,EXCLUDED.river_call_sd_weak) > 0)
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
            EXCLUDED.tank_bet_sd_strong > t.tank_bet_sd_strong OR
            EXCLUDED.river_call_sd > t.river_call_sd OR
            EXCLUDED.river_call_sd_weak > t.river_call_sd_weak THEN
          public.fn_horse_mind_source_window_merge(t.source_window, NULL)
        ELSE public.fn_horse_mind_source_window_normalize(t.source_window)
      END,
      updated_at = now();
    n := n + 1;
  end loop;
  return n;
end $function$;

COMMIT;
