-- ═══════════════════════════════════════════════════════════════════════════
--  THE MINI FLOOR'S DEFAULT IS DERIVED, NOT TYPED
--  BBJ programme, closing the last parked decision (2026-09-11)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan, 2026-09-11: "NOTHING IS MINE TO DECIDE, YOU FIGURE IT OUT." Three
-- questions had been parked as his under CLAUDE.md 10.9 - the floor's default,
-- the tier amounts, and the mini's players-dealt threshold. He has handed them
-- back, so they are decided here, from measurement, and written down.
--
-- ── THE NUMBER IS RIGHT; ITS FORM IS NOT ──────────────────────────────────
--
-- `bbj_pools.mini_reserve_floor` DEFAULT 5000.00, a literal on the column.
-- Measured on production 2026-09-11, across all 21 mini hits there have been:
--
--   largest enabled tier                          1,500.00
--   mean mini payout                                619.05
--   worst single DAY on one pool        7 hits,   4,075.00
--   5,000 as a multiple of the largest tier          3.33x
--   5,000 as a multiple of the worst day             1.23x
--   5,000 as days of the busiest pool's income        2.09
--
-- So 5,000 is a sound floor: it covers the worst day this jackpot has ever had
-- with 925 to spare, and about two days of the busiest pool's own backup
-- income. IT IS NOT CHANGED.
--
-- What is wrong is that it is a CONSTANT. The floor exists so a burst of hits
-- cannot take the reserve dark; its whole job is defined relative to what a
-- hit costs. Raise the tiers - which is exactly the kind of tuning this
-- programme has now made measurable - and a literal 5,000 silently stops
-- covering a bad day, with nothing to say so.
--
-- The default is derived instead: THREE TIMES THE LARGEST ENABLED TIER, never
-- below 5,000. Today that is GREATEST(4,500, 5,000) = 5,000 - byte-identical
-- behaviour - and if the tiers ever double it becomes 9,000 on its own.
--
-- ── THE OTHER TWO DECISIONS, RECORDED HERE BECAUSE THEY WERE PARKED ───────
--
-- TIER AMOUNTS (250 / 425 / 700 / 950 / 1,200 / 1,500): UNCHANGED. Both live
-- pools are net positive on the mini - the union pool +1,476.52/day and Deep
-- Stack Society +255.57/day, measured over one window - against a platform
-- spend of roughly 3,700/day. They are affordable and nothing in the data
-- argues for moving them. Retuning a price with no reason to is how a jackpot
-- gets a number nobody can explain.
--
-- MINI PLAYERS-DEALT (`BBJ_RULES.miniMinPlayersDealt`): STAYS AT 3, equal to
-- the main's. Dan, same day: "BBJ ONLY NEEDS 3 PLAYERS FOR THE RECORD." The
-- mini lives under the main and inherits its floors; the knob exists so the
-- two CAN be separated, and there is no measurement today that says they
-- should be. It is a knob, not an instruction to turn it.
--
-- Data only where it counts: no existing pool's floor moves, and the default
-- evaluates to the same 5,000 it did before.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_bbj_default_mini_floor()
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  /* Three times the largest ENABLED mini tier, never below 5,000.
     Three because the worst day this jackpot has had cost 2.72 tiers
     (4,075.00 against a 1,500.00 top tier), so three covers it with room;
     the 5,000 floor-under-the-floor keeps today's value exactly where it is
     and stops a club with only small tiers enabled from running a reserve
     too thin to absorb any burst at all. */
  SELECT GREATEST(
    COALESCE((SELECT max(mt.amount) FROM public.bbj_mini_tiers mt WHERE mt.enabled), 0) * 3,
    5000
  );
$function$;

COMMENT ON FUNCTION public.fn_bbj_default_mini_floor() IS
  'The reserve floor a NEW pool starts with: three times the largest enabled '
  'mini tier, never below 5,000. Derived rather than typed so that retuning '
  'bbj_mini_tiers cannot leave the floor covering less than a bad day. '
  'Evaluates to 5,000 as at 2026-09-11, which is what the column literal was. '
  'An existing pool''s floor is its own - fn_bbj_set_club_mini_floor.';

ALTER TABLE public.bbj_pools
  ALTER COLUMN mini_reserve_floor SET DEFAULT public.fn_bbj_default_mini_floor();

DO $$
DECLARE v_default numeric; v_moved integer;
BEGIN
  SELECT public.fn_bbj_default_mini_floor() INTO v_default;
  IF v_default <> 5000 THEN
    RAISE EXCEPTION
      'the derived default must equal the literal it replaces (5000), got %', v_default;
  END IF;

  SELECT count(*) INTO v_moved FROM public.bbj_pools
   WHERE COALESCE(mini_reserve_floor, 0) <> 5000;
  IF v_moved <> 0 THEN
    RAISE EXCEPTION
      'this migration must not move an existing pool floor, but % did', v_moved;
  END IF;

  IF (SELECT column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'bbj_pools'
         AND column_name = 'mini_reserve_floor') NOT LIKE '%fn_bbj_default_mini_floor%' THEN
    RAISE EXCEPTION 'the column default was not repointed at the derived function';
  END IF;
END $$;

COMMIT;
