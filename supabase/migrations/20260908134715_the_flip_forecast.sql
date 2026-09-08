-- 20260908134715_the_flip_forecast.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--

-- NOBODY ARMS A RULE BLIND AGAIN.
-- (CLAUDE.md 10.86; rulings 17, 18, 21; docs/changelog/2026-09-08-the-flip-forecast.md)
--
-- Every diamond rule is written in `log` mode with a date on which it starts REFUSING. Between
-- those two moments nobody has any way to ask the only question that matters: on the day this
-- arms itself, what will it actually stop?
--
-- That gap has now nearly cost real money twice in one week, both found by hand:
--
--   * `DR7:engine_over_budget` was six days from refusing EVERY daily-mission award for the rest
--     of September, because the engine sat at 4.2x a line nobody had revisited. Retired under
--     ruling 21.
--   * `DR7:user_over_daily_cap` arms on 2026-09-14 against a daily limit of 2,000 while a normal
--     day is 2,148 - so it refuses 94 percent of claim-days, every day. Still live, still armed.
--
-- Neither was a subtle bug. Both were plainly visible the moment somebody counted. Nobody counted,
-- because counting took an afternoon of hand-written SQL per rule.
--
-- THE FORECAST IS GENERAL, NOT PER-RULE, and that is what makes it trustworthy. Every one of these
-- rules already files an incident on EXACTLY the condition it would refuse on - the refusal and
-- the incident sit in the same IF. So "what would it refuse" is answered by "what has it been
-- filing", with no second implementation to drift from the first. A per-rule forecast would be a
-- copy of the rule, and a copy of a rule is a lie waiting to happen.
--
-- WHAT IT REPORTS, per rule: the mode, the date it arms, how many refusals it would have made in
-- the window, how many distinct players those would have hit, and a verdict in words.
--
-- WHAT IT CANNOT SEE, stated because a forecast that hides its blind spot is worse than none:
-- a rule whose incident was never filed because the write recording it failed. That was real until
-- this morning - 5,860 awards were evaluated by nothing at all - and is why the ledger's failure
-- path now files a CRITICAL incident naming the rules that were armed. If `ledger_write_failed`
-- is non-zero for the window, the forecast says so on its own row rather than quietly
-- understating every other one.
--
-- One transaction. Read-only; it refuses nothing and moves nothing.

BEGIN;

SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_flip_forecast(p_hours integer DEFAULT 24)
RETURNS TABLE (
  rule           text,
  mode           text,
  arms_on        date,
  would_refuse   bigint,
  players_hit    bigint,
  diamonds       numeric,
  verdict        text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_since timestamptz := now() - make_interval(hours => GREATEST(COALESCE(p_hours, 24), 1));
        v_blind bigint;
BEGIN
  IF COALESCE(auth.role(), 'service_role') <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required';
  END IF;

  RETURN QUERY
  SELECT m.rule,
         m.mode,
         m.flip_after::date,
         count(i.id),
         count(DISTINCT i.user_id),
         COALESCE(sum(abs(i.amount)), 0)::numeric,
         CASE
           WHEN m.mode = 'refuse' THEN
             'ALREADY ARMED. It is refusing now; the count is what it has refused.'
           WHEN count(i.id) = 0 THEN
             'SAFE TO ARM. Nothing in the window would have been refused.'
           WHEN m.flip_after IS NULL THEN
             'WOULD REFUSE ' || count(i.id) || ' - no arming date set, so this is advisory only.'
           WHEN m.flip_after <= now() THEN
             'OVERDUE AND LOUD. Its date has passed, it is still logging, and it would refuse '
             || count(i.id) || ' movement(s) affecting ' || count(DISTINCT i.user_id) || ' player(s).'
           ELSE
             'WOULD REFUSE ' || count(i.id) || ' movement(s) worth ' || COALESCE(sum(abs(i.amount)), 0)
             || ' diamonds across ' || count(DISTINCT i.user_id) || ' player(s), starting in '
             || (m.flip_after::date - now()::date) || ' day(s). Read this before that date.'
         END
    FROM public.ca_diamond_rule_modes m
    LEFT JOIN public.ca_diamond_incidents i
           ON i.rule = m.rule AND i.occurred_at >= v_since
   GROUP BY m.rule, m.mode, m.flip_after
   ORDER BY count(i.id) DESC, m.flip_after NULLS LAST;

  -- THE BLIND SPOT, ON ITS OWN ROW. A rule can only be forecast from what it filed, so a window
  -- in which the ledger could not write is a window in which every count above is a floor rather
  -- than a total. Saying so is the difference between a forecast and a guess (10.86).
  -- qualified: `rule` alone is ambiguous against this function's own OUT column
  SELECT count(*) INTO v_blind FROM public.ca_diamond_incidents x
   WHERE x.rule = 'DR7:ledger_write_failed' AND x.occurred_at >= v_since;
  RETURN QUERY SELECT
    '(forecast confidence)'::text,
    CASE WHEN v_blind = 0 THEN 'complete' ELSE 'incomplete' END::text,
    NULL::date, v_blind, 0::bigint, 0::numeric,
    CASE WHEN v_blind = 0
         THEN 'Every award in the window was evaluated, so the counts above are totals.'
         ELSE v_blind || ' award(s) could not be evaluated at all because the ledger write failed. '
              || 'Every count above is a FLOOR, not a total.'
    END;
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_diamond_flip_forecast(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_flip_forecast(integer) TO service_role;

COMMENT ON FUNCTION public.fn_ca_diamond_flip_forecast(integer) IS
  'For every diamond rule: what it would refuse if it were armed today, how many players that hits, and when it arms itself. Counted from the incidents each rule already files on exactly the condition it refuses on, so there is no second implementation to drift. Reports its own blind spot on a final row. Read it before any flip date.';

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record; v_rules integer; v_conf integer; v_cap record;
BEGIN
  SELECT count(*) INTO v_rules FROM public.ca_diamond_rule_modes;
  SELECT count(*) INTO v_conf FROM public.fn_ca_diamond_flip_forecast(24)
   WHERE rule = '(forecast confidence)';
  IF v_conf <> 1 THEN RAISE EXCEPTION 'the forecast does not report its own confidence'; END IF;

  IF (SELECT count(*) FROM public.fn_ca_diamond_flip_forecast(24)) <> v_rules + 1 THEN
    RAISE EXCEPTION 'the forecast covers % of % rules',
      (SELECT count(*) - 1 FROM public.fn_ca_diamond_flip_forecast(24)), v_rules;
  END IF;

  -- IT MUST FIND THE ONE WE ALREADY KNOW ABOUT BY HAND. The per-user daily cap arms on
  -- 2026-09-14 and has been filing thousands a day; a forecast that reports it as quiet is
  -- broken, and this is the only way to tell.
  SELECT * INTO v_cap FROM public.fn_ca_diamond_flip_forecast(24)
   WHERE rule = 'DR7:user_over_daily_cap';
  IF v_cap IS NULL THEN RAISE EXCEPTION 'the forecast does not cover the per-user daily cap'; END IF;
  IF v_cap.would_refuse < 100 THEN
    RAISE EXCEPTION 'the forecast says the daily cap would refuse only % in 24h, which contradicts what was measured by hand', v_cap.would_refuse;
  END IF;
  IF v_cap.verdict NOT LIKE '%WOULD REFUSE%' THEN
    RAISE EXCEPTION 'the forecast does not warn about the daily cap: %', v_cap.verdict;
  END IF;

  -- and a rule that files nothing must read as safe rather than as unknown
  IF NOT EXISTS (SELECT 1 FROM public.fn_ca_diamond_flip_forecast(24)
                  WHERE would_refuse = 0 AND verdict LIKE 'SAFE TO ARM%') THEN
    RAISE EXCEPTION 'no rule reads as safe to arm, which is implausible and suggests the join is wrong';
  END IF;

  FOR r IN SELECT * FROM public.fn_ca_diamond_flip_forecast(24) LOOP
    RAISE NOTICE '% [%] arms % -> % refusals, % players : %',
      r.rule, r.mode, COALESCE(r.arms_on::text, '-'), r.would_refuse, r.players_hit, left(r.verdict, 80);
  END LOOP;

  -- nothing moved
  IF (SELECT public.fn_ca_mint_supply('diamonds'))
     <> (SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) + public.fn_ca_diamond_offledger_float() THEN
    RAISE EXCEPTION 'players + float <> register after a read-only change';
  END IF;
END $$;

COMMIT;
