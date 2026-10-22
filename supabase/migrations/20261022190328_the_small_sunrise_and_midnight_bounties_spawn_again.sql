-- 20261022190328_the_small_sunrise_and_midnight_bounties_spawn_again.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- The 5-dollar Midway "Sunrise Bounty (NLH)" and "Midnight Bounty (NLH)" have
-- not spawned a single occurrence since 2026-10-20. The last instances on the
-- board were created that morning (start 2026-10-23); nothing exists for
-- Oct 24 or later, while their 50-dollar twins keep spawning normally.
--
-- Two written rules disagreed:
--   * 2026-08-20 (Dan): every buy-in totals a whole number. Enforced by the
--     BEFORE INSERT/UPDATE trigger trg_whole_dollar_buyin ->
--     fn_enforce_whole_dollar_buyin (20260821a_whole_dollar_check_to_insert_trigger).
--   * 2026-10-20 (Dan, docs/changelog/2026-10-20-midway-rebuy-addon-coverage.md):
--     "Sunrise and Midnight are explicit owner exceptions: 5.50 total entry =
--     2 bounty + 3 prize contribution + 0.50 fee". The engine applies it in
--     server/src/tournament/midwayStructurePolicy.ts (buy_in_amount 5,
--     buy_in_fee 0.5) at the original spawn.
--
-- The later explicit owner instruction governs (CLAUDE.md 10.8), but the
-- trigger was never told about it, so every spawn of those two events was
-- refused. Measured 2026-10-22: 244 refusals an hour
-- ("whole-dollar buy-in rule: buy_in_amount (5.00) + buy_in_fee (0.50)"),
-- steadily since 2026-10-20, each a PostgREST INSERT carrying schedule_id.
--
-- THE FIX is the one exception, stated exactly as the owner stated it and no
-- wider: a Midway Union MTT named Sunrise Bounty (NLH) or Midnight Bounty
-- (NLH), fixed bounty (not PKO, not mystery), at exactly 5.00 + 0.50. Every
-- other row, including any other 5.50 total, is still refused. The fee is
-- 0.50 / 5.50 = 9.09%, inside the 10% rake cap the separate
-- tournaments_rake_within_10_pct rule enforces.
--
-- No money, no seats, no existing rows are touched. The schedule spawner's
-- next pass creates the missing occurrences itself.
--
-- ROLLBACK: re-apply fn_enforce_whole_dollar_buyin from
-- 20260823180000_pin_search_path_on_the_last_mutable_functions.sql (the body
-- below without the exception block).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_enforce_whole_dollar_buyin()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.buy_in_amount IS DISTINCT FROM OLD.buy_in_amount
     OR NEW.buy_in_fee    IS DISTINCT FROM OLD.buy_in_fee
  THEN
    -- Owner exception, 2026-10-20: the two small Midway fixed-bounty events
    -- are a 5.50 entry (2 bounty + 3 prize contribution + 0.50 fee).
    IF COALESCE(NEW.buy_in_amount, 0) = 5.00
       AND COALESCE(NEW.buy_in_fee, 0) = 0.50
       AND NEW.name IN ('Sunrise Bounty (NLH)', 'Midnight Bounty (NLH)')
       AND upper(COALESCE(NEW.tournament_type, '')) = 'MTT'
       AND NEW.is_bounty IS TRUE
       AND NEW.is_pko IS NOT TRUE
       AND NEW.is_mystery_bounty IS NOT TRUE
       AND (NEW.club_id = 'fade0000-0000-0000-0000-000000000001'::uuid
            OR NEW.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid)
    THEN
      RETURN NEW;
    END IF;

    IF (COALESCE(NEW.buy_in_amount, 0) + COALESCE(NEW.buy_in_fee, 0))
       <> round(COALESCE(NEW.buy_in_amount, 0) + COALESCE(NEW.buy_in_fee, 0))
    THEN
      RAISE EXCEPTION
        'whole-dollar buy-in rule: buy_in_amount (%) + buy_in_fee (%) must total a whole number - split a whole total via splitBuyIn(), never surcharge the fee on top',
        NEW.buy_in_amount, NEW.buy_in_fee;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DO $assert$
BEGIN
  IF position('Sunrise Bounty (NLH)' IN pg_get_functiondef('public.fn_enforce_whole_dollar_buyin'::regproc)) = 0 THEN
    RAISE EXCEPTION 'fn_enforce_whole_dollar_buyin was not updated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_whole_dollar_buyin'
                  AND tgrelid = 'public.tournaments'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'trg_whole_dollar_buyin is missing';
  END IF;
END
$assert$;

COMMIT;
