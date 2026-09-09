-- 20260908050335_the_daily_challenge_cap_matches_what_players_complete.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (docs/DIAMOND-RULINGS.md 17 and 18; CLAUDE.md 10.84, derive a
-- threshold and write the measurement beside it; docs/changelog/2026-09-08-two-landmines-before-the-flip.md):
--
-- Two rows would have detonated on 2026-09-14, the day ruling 17's refusals flip on. Neither is
-- a bug in code; both are numbers that were right when nothing claimed and are wrong now that
-- horses claim. Found by asking what the flip would actually do, rather than assuming.
--
--   1. THE PER-USER DAILY CAP FOR daily_challenges IS BELOW WHAT PLAYERS COMPLETE. It is 800.
--      Measured over 14 days and 7,713 user-days of completions - the honest predictor of what a
--      claim will ask for, now that the engine claims for a horse the moment it completes:
--
--          p50 195   p90 762   p99 1,357   max 1,726
--
--      So the cap sits between p90 and p99: about one player-day in ten would be refused, and
--      the worst would lose ~900 diamonds it had genuinely earned. On flip day that becomes a
--      P0407 inside the claim - caught and filed as CH3:horse_claim_failed, so nothing breaks,
--      but the player is simply not paid. It is set to 2,000: above the observed maximum with
--      headroom, so it never binds on real play, while still catching the thing a cap is for -
--      a bug or a farm awarding tens of thousands in a day. Identical for horses and humans,
--      and identical for VIP, because the cap is a limit and not a privilege.
--
--   2. THE unclassified BUDGET LINE READS 84,190 SPENT AGAINST A BUDGET OF 0. That 84,190 is an
--      artefact of the 2026-09-07 restatement, which counted historical rows whose class could
--      no longer be determined; it is not this month's issuance and no player received it. Left
--      alone, DR7:engine_over_budget is permanently true for that engine, so on flip day EVERY
--      journal row that lands unclassified is refused - which is the intended end state, but
--      reached by accident and dated to a backfill rather than to a decision. The spend is reset
--      to 0 and the budget stays 0, so the rule means what it says: nothing should ever be
--      unclassified, and the first row that is trips the alarm on its own merits.
--
-- Nothing here moves a diamond. One transaction.

BEGIN;

UPDATE public.diamond_engine_daily_caps
   SET max_per_user_per_day = 2000,
       max_per_user_per_day_vip = 2000,
       note = 'Measured 2026-09-08 over 14 days and 7,713 user-days of completions: p50 195, p90 762, p99 1,357, max 1,726. Set above the maximum so it never binds on real play and still catches a bug or a farm. Identical for horses, humans and VIP. Was 800, which sat between p90 and p99.',
       updated_at = now()
 WHERE engine = 'daily_challenges';

UPDATE public.diamond_reward_budgets
   SET spent_diamonds = 0,
       updated_at = now()
 WHERE period = to_char((now() AT TIME ZONE 'America/Chicago'), 'YYYY-MM')
   AND engine = 'unclassified'
   AND budget_diamonds = 0;

DO $$
DECLARE v_cap integer; v_vip integer; v_spent bigint; v_budget bigint;
BEGIN
  SELECT max_per_user_per_day, max_per_user_per_day_vip INTO v_cap, v_vip
    FROM public.diamond_engine_daily_caps WHERE engine = 'daily_challenges';
  IF v_cap <> 2000 OR v_vip <> 2000 THEN
    RAISE EXCEPTION 'the daily_challenges cap is %/%, not 2000/2000', v_cap, v_vip;
  END IF;

  SELECT spent_diamonds, budget_diamonds INTO v_spent, v_budget
    FROM public.diamond_reward_budgets
   WHERE period = to_char((now() AT TIME ZONE 'America/Chicago'), 'YYYY-MM') AND engine = 'unclassified';
  IF v_spent IS NOT NULL AND (v_spent <> 0 OR v_budget <> 0) THEN
    RAISE EXCEPTION 'the unclassified line reads spent % against budget %, expected 0 and 0', v_spent, v_budget;
  END IF;

  -- the cap must not have become a privilege: no engine may pay VIPs more than it can pay anyone
  IF EXISTS (SELECT 1 FROM public.diamond_engine_daily_caps
              WHERE engine = 'daily_challenges' AND max_per_user_per_day_vip <> max_per_user_per_day) THEN
    RAISE EXCEPTION 'the daily_challenges cap differs for VIP; a limit is not a privilege';
  END IF;

  IF (SELECT public.fn_ca_mint_supply('diamonds')) <> (SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) THEN
    RAISE EXCEPTION 'the register and the players disagree after a change that moves no money';
  END IF;
END $$;

COMMIT;
