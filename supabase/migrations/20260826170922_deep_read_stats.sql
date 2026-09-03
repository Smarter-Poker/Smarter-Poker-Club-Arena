-- ═══════════════════════════════════════════════════════════════════════════
-- V16 DEEP READS (2026-08-26): fold-to-c-bet, fold-to-3-bet, sizing tells
--
-- HorseMind's reads stopped at VPIP/PFR/3-bet/AF. The three most exploitable
-- tendencies at real tables were invisible: does this player fold to c-bets,
-- does this player fold when their open gets 3-bet, and do their BIG river
-- bets mean it. Six new lifetime counters, observed once per completed hand
-- at settlement (HorseMind.observeHandComplete), persisted with the same
-- GREATEST-monotonic merge as every other lifetime counter.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.horse_mind_stats
  ADD COLUMN IF NOT EXISTS cbet_opps        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cbet_folds       integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS f3b_opps         integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS f3b_folds        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bigbet_sd        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bigbet_sd_strong integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.upsert_horse_mind_stats(rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
       r_hands, r_folds, r_faced_aggr, r_aggr, r_passive, updated_at)
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
       COALESCE((r->>'r_hands')::real, 0),
       COALESCE((r->>'r_folds')::real, 0),
       COALESCE((r->>'r_faced_aggr')::real, 0),
       COALESCE((r->>'r_aggr')::real, 0),
       COALESCE((r->>'r_passive')::real, 0),
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
      r_hands      = EXCLUDED.r_hands,
      r_folds      = EXCLUDED.r_folds,
      r_faced_aggr = EXCLUDED.r_faced_aggr,
      r_aggr       = EXCLUDED.r_aggr,
      r_passive    = EXCLUDED.r_passive,
      updated_at   = now();
    n := n + 1;
  END LOOP;
  RETURN n;
END
$$;

REVOKE ALL ON FUNCTION public.upsert_horse_mind_stats(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_horse_mind_stats(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.upsert_horse_mind_stats(jsonb) FROM authenticated;
