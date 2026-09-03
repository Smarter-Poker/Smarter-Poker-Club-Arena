-- ═══════════════════════════════════════════════════════════════════════════
-- V12 HORSE MEMORY PERSISTENCE (Dan 2026-08-22: "constantly improving the
-- more they play")
--
-- HorseMind's per-opponent stats (VPIP / PFR / 3-bet / aggression / fold-vs-
-- aggression + the counter-adaptation recency window) lived only in process
-- memory, restored after a restart by replaying 72h of hand_history. This
-- table gives the fleet an UNLIMITED learning horizon: the engine flushes its
-- accumulated reads every few minutes and hydrates them back instantly on
-- boot, with the history replay reduced to the un-flushed tail.
--
-- Service-role only: RLS enabled with NO policies. Nothing client-side ever
-- reads or writes horse memory.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.horse_mind_stats (
  user_id      text PRIMARY KEY,
  hands        integer NOT NULL DEFAULT 0,
  vpip         integer NOT NULL DEFAULT 0,
  pfr          integer NOT NULL DEFAULT 0,
  three_bet    integer NOT NULL DEFAULT 0,
  aggr         integer NOT NULL DEFAULT 0,
  passive      integer NOT NULL DEFAULT 0,
  folds        integer NOT NULL DEFAULT 0,
  faced_aggr   integer NOT NULL DEFAULT 0,
  -- exponentially-decayed recency window (fractional after decay halvings)
  r_hands      real NOT NULL DEFAULT 0,
  r_folds      real NOT NULL DEFAULT 0,
  r_faced_aggr real NOT NULL DEFAULT 0,
  r_aggr       real NOT NULL DEFAULT 0,
  r_passive    real NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.horse_mind_stats ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS horse_mind_stats_updated_at_idx
  ON public.horse_mind_stats (updated_at);
CREATE INDEX IF NOT EXISTS horse_mind_stats_hands_idx
  ON public.horse_mind_stats (hands DESC);

-- Merge-upsert. Lifetime counters only ever GROW in engine memory between
-- bounded-memory generation swaps; after a swap the engine's numbers restart
-- from zero, and a plain upsert would clobber months of learning with the
-- fresh count. GREATEST keeps the merge monotonic for lifetime counters.
-- The recency window is genuinely "most recent", so it always takes the
-- engine's newest value.
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
       COALESCE((r->>'r_hands')::real, 0),
       COALESCE((r->>'r_folds')::real, 0),
       COALESCE((r->>'r_faced_aggr')::real, 0),
       COALESCE((r->>'r_aggr')::real, 0),
       COALESCE((r->>'r_passive')::real, 0),
       now())
    ON CONFLICT (user_id) DO UPDATE SET
      hands        = GREATEST(t.hands, EXCLUDED.hands),
      vpip         = GREATEST(t.vpip, EXCLUDED.vpip),
      pfr          = GREATEST(t.pfr, EXCLUDED.pfr),
      three_bet    = GREATEST(t.three_bet, EXCLUDED.three_bet),
      aggr         = GREATEST(t.aggr, EXCLUDED.aggr),
      passive      = GREATEST(t.passive, EXCLUDED.passive),
      folds        = GREATEST(t.folds, EXCLUDED.folds),
      faced_aggr   = GREATEST(t.faced_aggr, EXCLUDED.faced_aggr),
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
