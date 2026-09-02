-- ═══════════════════════════════════════════════════════════════════════════
-- THREE RULINGS FROM DAN, 2026-09-02
--
-- 1. "WHEN YOU ARE TAKING CHIPS FROM THE MAIN BANK TO PAY AN OVERLAY OR
--    SHORTAGE, THERE MUST BE A TRANSACTION RECORD OF IT IN THE LEDGER, SAYING
--    WHICH TOURNAMENT IT WAS, AND HOW MUCH IT WAS SHORT."
--
--    one_movement_one_journal_row had got this backwards. When the overlay
--    trigger fired live on Midnight Bounty it produced TWO rows for the same
--    42.50: my descriptive one, and an auto-journal row reading "auto-ledgered
--    union_wallets.chip_balance delta -42.50" that named no tournament. I had
--    deduplicated the earlier backfill by deleting the DESCRIPTIVE rows and
--    keeping the automatic ones - throwing away exactly the detail Dan wants.
--    The rule was right ("never both"); I kept the wrong half.
--
--    Now: the auto-journal is suppressed for the bank debit
--    (app.ledger_autoskip_union_wallets / _clubs, the pattern
--    atomic_distribute_rake already uses) and the surviving row states the
--    tournament, its id, the shortfall, the guarantee, and what the field
--    actually made.
--
-- 2. "NOT EVERY PLAYER GETS PAID, ONLY THE TOP 10-15%... THAT'S A FIELD THAT
--    NEEDS TO BE SELECTED WHEN CREATING A TOURNAMENT - 10% 15% OR 20%."
--
--    tournaments.payout_percent (10/15/20, default 10, CHECK constrained), and
--    fn_ca_payout_structure(entrants, percent) which builds the table:
--    places = ceil(entrants * percent / 100), minimum 1, never more than the
--    field; weight 1/place^0.8 normalised to 100; largest-remainder rounding
--    so it sums to EXACTLY 100.00 at every field size. Verified across 720
--    combinations (1..240 entrants x 10/15/20): 720 sum to 100.00, none off.
--    All live tournaments backfilled to 10.
--
-- 3. The payout table is rebuilt from the field that ACTUALLY entered, in the
--    same write that closes registration - alongside the overlay - so one
--    atomic statement settles three things that must agree: the field is
--    closed, the pool meets the guarantee, and the payout table covers the top
--    payout_percent of exactly the players who entered.
--
-- TWO BUGS THE PROBE CAUGHT BEFORE PRODUCTION DID:
--   * payout_structure is TEXT, not jsonb. COALESCE(...,'[]'::jsonb) is a
--     runtime type error inside the trigger, which would have refused EVERY
--     tournament start on a floor that starts thousands a day.
--   * fn_guard_managed_game_lifecycle protects payout_structure once a player
--     has registered, and BEFORE triggers fire in NAME order - so the engine's
--     own rebuild was presented to the guard as a human edit and refused.
--     The trigger must sort AFTER that guard.
--
-- The rename to zz_ deadlocks against Supabase Realtime (a trigger change on
-- `tournaments` takes an AccessExclusiveLock on realtime.subscription while a
-- Realtime process holds it and wants `tournaments`). Rather than block the
-- floor waiting for it, the FUNCTION detects the rename at runtime and only
-- rebuilds payout_structure once the zz_ trigger exists. Overlay funding and
-- the named ledger row work either way.
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
  'What share of the FIELD finishes in the money: 10, 15 or 20 percent. Chosen when the tournament is created. Paid places = ceil(entrants * payout_percent / 100), minimum 1.';

CREATE OR REPLACE FUNCTION public.fn_ca_payout_structure(
  p_entrants integer, p_percent integer DEFAULT 10
)
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
DECLARE v_places int; v_pct numeric; v_out jsonb;
BEGIN
  v_pct := CASE WHEN p_percent IN (10,15,20) THEN p_percent ELSE 10 END;
  IF COALESCE(p_entrants,0) <= 0 THEN RETURN '[]'::jsonb; END IF;
  v_places := GREATEST(1, LEAST(p_entrants, ceil(p_entrants * v_pct / 100.0)::int));

  WITH w AS (
    SELECT i AS place, 1.0 / power(i, 0.8) AS weight FROM generate_series(1, v_places) i
  ), n AS (
    SELECT place, 100.0 * weight / SUM(weight) OVER () AS exact FROM w
  ), f AS (
    SELECT place, floor(exact * 100) / 100 AS floored,
           (exact * 100) - floor(exact * 100) AS frac FROM n
  ), r AS (
    SELECT place, floored,
           row_number() OVER (ORDER BY frac DESC, place ASC) AS rk,
           round((100.0 - SUM(floored) OVER ()) * 100)::int AS cents_left
      FROM f
  )
  SELECT jsonb_agg(jsonb_build_object('place', place,
           'percentage', floored + CASE WHEN rk <= cents_left THEN 0.01 ELSE 0 END)
         ORDER BY place) INTO v_out FROM r;
  RETURN COALESCE(v_out, '[]'::jsonb);
END;
$fn$;

COMMENT ON FUNCTION public.fn_ca_payout_structure(integer, integer) IS
  'Payout table for a field of p_entrants paying the top p_percent (10/15/20). Weight 1/place^0.8 normalised to 100, largest-remainder rounded so the percentages sum to EXACTLY 100.00 at every field size.';

REVOKE ALL ON FUNCTION public.fn_ca_payout_structure(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_payout_structure(integer, integer) TO service_role, authenticated, anon;

UPDATE public.tournaments
   SET payout_percent = 10
 WHERE status IN ('ANNOUNCED','REGISTERING','RUNNING','COMPLETING')
   AND payout_percent IS DISTINCT FROM 10;
