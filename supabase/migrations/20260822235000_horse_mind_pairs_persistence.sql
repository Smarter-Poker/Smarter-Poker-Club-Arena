-- ═══════════════════════════════════════════════════════════════════════════
-- V12.1 HORSE ANTI-EXPLOIT PAIR PERSISTENCE (2026-08-22)
--
-- The V12 anti-exploit defense (PR #268) tracks per-(attacker, victim)
-- aggression counters — who 3-bets whose opens, who raises whose postflop
-- bets — to detect players HUNTING a specific horse. Those counters lived
-- only in process memory, rebuilt after every restart by the 72h
-- hand_history replay; a hunter with a longer memory than that got a clean
-- slate every deploy. This table gives the pair counters the same unlimited
-- horizon the opponent stats got in migration 20260822210000: flushed every
-- few minutes, hydrated instantly on boot, replay reduced to the un-flushed
-- tail.
--
-- Service-role only: RLS enabled with NO policies. Nothing client-side ever
-- reads or writes horse memory.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.horse_mind_pairs (
  attacker_id text NOT NULL,
  victim_id   text NOT NULL,
  -- 3-bets made over the victim's preflop opens / opportunities to do so
  n3    integer NOT NULL DEFAULT 0,
  opp3  integer NOT NULL DEFAULT 0,
  -- raises made over the victim's postflop bets / opportunities to do so
  n_r   integer NOT NULL DEFAULT 0,
  opp_r integer NOT NULL DEFAULT 0,
  -- hydrate ordering: the most-contested pairs restore first
  opps  integer GENERATED ALWAYS AS (opp3 + opp_r) STORED,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (attacker_id, victim_id)
);

ALTER TABLE public.horse_mind_pairs ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS horse_mind_pairs_updated_at_idx
  ON public.horse_mind_pairs (updated_at);
CREATE INDEX IF NOT EXISTS horse_mind_pairs_opps_idx
  ON public.horse_mind_pairs (opps DESC);

-- Merge-upsert. Pair counters only ever GROW in engine memory between
-- bounded-memory generation swaps; after a swap the engine's numbers restart
-- from zero, and a plain upsert would clobber accumulated history. GREATEST
-- keeps the merge monotonic — the exact contract upsert_horse_mind_stats
-- established for the stats table.
CREATE OR REPLACE FUNCTION public.upsert_horse_mind_pairs(rows jsonb)
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
    CONTINUE WHEN r->>'attacker_id' IS NULL OR length(r->>'attacker_id') = 0 OR length(r->>'attacker_id') > 128;
    CONTINUE WHEN r->>'victim_id' IS NULL OR length(r->>'victim_id') = 0 OR length(r->>'victim_id') > 128;
    INSERT INTO public.horse_mind_pairs AS t
      (attacker_id, victim_id, n3, opp3, n_r, opp_r, updated_at)
    VALUES
      (r->>'attacker_id',
       r->>'victim_id',
       COALESCE((r->>'n3')::integer, 0),
       COALESCE((r->>'opp3')::integer, 0),
       COALESCE((r->>'n_r')::integer, 0),
       COALESCE((r->>'opp_r')::integer, 0),
       now())
    ON CONFLICT (attacker_id, victim_id) DO UPDATE SET
      n3         = GREATEST(t.n3, EXCLUDED.n3),
      opp3       = GREATEST(t.opp3, EXCLUDED.opp3),
      n_r        = GREATEST(t.n_r, EXCLUDED.n_r),
      opp_r      = GREATEST(t.opp_r, EXCLUDED.opp_r),
      updated_at = now();
    n := n + 1;
  END LOOP;
  RETURN n;
END
$$;

REVOKE ALL ON FUNCTION public.upsert_horse_mind_pairs(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_horse_mind_pairs(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.upsert_horse_mind_pairs(jsonb) FROM authenticated;
