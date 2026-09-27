-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821151217 "pay_chips_on_retired_but_owed_challenges"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 43f9a777c817ac1f88a989b8d53d2be1 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Four generic catalog rows survived 20260821_specific_challenge_catalog.sql
-- because player rows still reference them, and every one of those references
-- is a COMPLETED, UNCLAIMED challenge: five rewards the player earned and was
-- never paid, one of them outstanding since March.
--
-- They are unreachable by assignment (the client only ever assigns ids from
-- the pool, and these are no longer in it), so their reward now matters for
-- exactly those five claims. Left alone they would pay diamonds and zero
-- chips, which is the bug this whole change set exists to remove -- so the
-- invariant "every claimable challenge pays chips" would hold everywhere
-- except on the rewards a player had actually already earned.
--
-- Amounts are matched to the equivalent rung of the new ladder rather than
-- invented: hands_10 -> hp_10, hands_25 -> hp_25, showdown_3 -> sd_3, and the
-- 250-hand weekly to half of the 500-hand weekly.
UPDATE public.daily_challenge_catalog SET chip_reward = 500   WHERE id = 'hands_10'         AND COALESCE(chip_reward,0) = 0;
UPDATE public.daily_challenge_catalog SET chip_reward = 1200  WHERE id = 'hands_25'         AND COALESCE(chip_reward,0) = 0;
UPDATE public.daily_challenge_catalog SET chip_reward = 600   WHERE id = 'showdown_3'       AND COALESCE(chip_reward,0) = 0;
UPDATE public.daily_challenge_catalog SET chip_reward = 15000 WHERE id = 'weekly_hands_250' AND COALESCE(chip_reward,0) = 0;

DO $do$
DECLARE v_bad int;
BEGIN
  -- After this, nothing a player can still claim pays zero chips.
  SELECT count(*) INTO v_bad
    FROM public.daily_challenge_catalog c
   WHERE COALESCE(c.chip_reward, 0) = 0
     AND EXISTS (SELECT 1 FROM public.user_daily_challenges u
                  WHERE u.challenge_id = c.id AND u.completed AND NOT u.claimed);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'ABORT: % claimable challenges still pay zero chips', v_bad;
  END IF;
END $do$;
