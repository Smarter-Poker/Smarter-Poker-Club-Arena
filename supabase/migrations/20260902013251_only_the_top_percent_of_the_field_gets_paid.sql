-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902013251; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- DAN, 2026-09-02: "NOT EVERY PLAYER IN A TOURNAMENT GETS PAID, ONLY THE TOP
-- 10-15% OF THE FIELD GET PAID, AND THAT'S ALSO A FIELD THAT NEEDS TO BE
-- SELECTED WHEN CREATING A TOURNAMENT - 10% 15% OR 20%."
--
-- Today `payout_structure` is a fixed jsonb array chosen per event and
-- unrelated to how many people actually entered: 53,293 tournaments carry
-- [{"place":1,"percentage":100}] regardless of field size. Nothing ties paid
-- places to the size of the field.
--
-- This adds the field Dan asked for and the arithmetic behind it.
--
--   payout_percent  smallint, one of 10 / 15 / 20, default 10
--   paid places  =  ceil(entrants * payout_percent / 100), minimum 1
--
-- The curve: place i gets weight 1/i^0.8, normalised to 100. That is the shape
-- real payout tables have - steep at the top, flattening out - without needing
-- a hand-maintained table per field size. Largest-remainder rounding puts the
-- rounding pennies on the largest shares, so the structure sums to EXACTLY
-- 100.00 for every field size rather than 99.99 or 100.01. A structure that
-- does not sum to 100 either underpays the pool or overdraws it, which is the
-- defect class this whole sweep has been chasing.
--
-- All existing REGISTERING and RUNNING tournaments are backfilled to 10, as
-- instructed. Completed events are left alone: their payouts already happened
-- and rewriting the structure would rewrite history.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS payout_percent smallint NOT NULL DEFAULT 10;

DO $c$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournaments_payout_percent_check') THEN
    ALTER TABLE public.tournaments
      ADD CONSTRAINT tournaments_payout_percent_check
      CHECK (payout_percent IN (10, 15, 20)) NOT VALID;
  END IF;
END $c$;

COMMENT ON COLUMN public.tournaments.payout_percent IS
  'What share of the FIELD finishes in the money: 10, 15 or 20 percent. Chosen when the tournament is created. Paid places = ceil(entrants * payout_percent / 100), minimum 1. Drives fn_ca_payout_structure.';

-- ── The structure generator ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_payout_structure(
  p_entrants integer,
  p_percent  integer DEFAULT 10
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_places int;
  v_pct    numeric;
  v_out    jsonb;
BEGIN
  v_pct := CASE WHEN p_percent IN (10,15,20) THEN p_percent ELSE 10 END;

  -- at least one place, never more places than players
  v_places := GREATEST(1, LEAST(COALESCE(p_entrants,0),
                                ceil(COALESCE(p_entrants,0) * v_pct / 100.0)::int));
  IF COALESCE(p_entrants,0) <= 0 THEN
    RETURN '[]'::jsonb;
  END IF;

  WITH w AS (
    SELECT i AS place, 1.0 / power(i, 0.8) AS weight
      FROM generate_series(1, v_places) i
  ), n AS (
    SELECT place, weight, 100.0 * weight / SUM(weight) OVER () AS exact
      FROM w
  ), f AS (
    SELECT place, exact,
           floor(exact * 100) / 100 AS floored,
           (exact * 100) - floor(exact * 100) AS frac
      FROM n
  ), r AS (
    -- largest remainder: hand the leftover cents to the biggest fractions, so
    -- the structure sums to exactly 100.00 for any field size
    SELECT place, floored,
           row_number() OVER (ORDER BY frac DESC, place ASC) AS rk,
           round((100.0 - SUM(floored) OVER ()) * 100)::int AS cents_left
      FROM f
  )
  SELECT jsonb_agg(
           jsonb_build_object('place', place,
                              'percentage', floored + CASE WHEN rk <= cents_left THEN 0.01 ELSE 0 END)
           ORDER BY place)
    INTO v_out
    FROM r;

  RETURN COALESCE(v_out, '[]'::jsonb);
END;
$fn$;

COMMENT ON FUNCTION public.fn_ca_payout_structure(integer, integer) IS
  'Payout table for a field of p_entrants paying the top p_percent (10/15/20). Places = ceil(entrants * percent / 100), min 1, never more than the field. Weight 1/place^0.8 normalised to 100, with largest-remainder rounding so the percentages sum to EXACTLY 100.00 at every field size.';

REVOKE ALL ON FUNCTION public.fn_ca_payout_structure(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_payout_structure(integer, integer) TO service_role, authenticated, anon;

-- ── Backfill every live tournament to 10 percent, as instructed ────────────
UPDATE public.tournaments
   SET payout_percent = 10
 WHERE status IN ('ANNOUNCED','REGISTERING','RUNNING','COMPLETING')
   AND payout_percent IS DISTINCT FROM 10;

