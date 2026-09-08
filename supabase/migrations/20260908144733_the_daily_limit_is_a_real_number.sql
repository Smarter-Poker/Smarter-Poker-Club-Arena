-- 20260908144733_the_daily_limit_is_a_real_number.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- APPLIED TO PRODUCTION 2026-09-08 via the us-west-2 session pooler; this file is
-- the record of what ran, and is registered in supabase_migrations.schema_migrations.

-- THE DAILY EARNING LIMIT, DERIVED RATHER THAN GUESSED - AND THE FORECAST STOPS MISREADING A FIX.
-- (Dan 2026-09-08: "YOU NEED TO CREATE THE DAILY LIMIT NUMBER"; ruling 21; CLAUDE.md 10.9, 10.86;
--  docs/changelog/2026-09-08-the-daily-limit.md)
--
-- Since ruling 21 the per-user daily cap is the ONLY control that can refuse an award, and it arms
-- itself on 2026-09-14. It was set to 2,000 for `daily_challenges`, and the forecast built this
-- morning says that would refuse 4,541 movements across 800 players - 94 percent of claim-days,
-- every day.
--
-- WHY 2,000 IS WRONG, AND IT IS NOT A CLOSE CALL. Measured over 14 days and 7,526 user-days of
-- assignments: the game hands each player 6.9 challenges a day on average and up to 17, and a
-- player who completes EVERY challenge assigned to them in one day earns **2,969 diamonds**.
--
--     The cap was set below what the game itself pays out.
--
-- A cap under the design ceiling does not limit abuse, it refuses the product. Nobody chose that;
-- the number was picked when a shared monthly pot was expected to do the real work, and ruling 21
-- removed that pot this morning without the cap being revisited. This revisits it.
--
-- THE NUMBER, AND THE ARITHMETIC BEHIND IT
--
--   design ceiling  2,969   what a player earns completing everything assigned in one day
--   observed max    2,492   highest actual day in 14 days
--   observed p99    2,445
--   observed p50    2,278
--   CAP SET TO      4,000   = 1.35x the design ceiling, 1.60x the highest real day
--
-- 4,000 leaves room for the challenge catalogue to grow by a third before anybody legitimate is
-- refused, and a single account earning more than 4,000 in a day from challenges means a duplicate
-- claim, a replay or an exploit - which is the only thing a per-user cap should ever stop.
--
-- `catalog_v2` gets the same treatment for the same reason: cap 110, observed maximum 260, four
-- real human user-days over the line in 14 days. Set to 500, about twice the observed maximum.
--
-- EVERY OTHER CAP IS LEFT ALONE, because every other cap has produced no breach at all:
-- daily_missions 500 (highest day 150), club_arena_daily 110 (15), trivia 2,000, wheel 10,000,
-- referrals 1,500 (no activity in the window). Changing a limit nobody has touched would be
-- inventing policy rather than correcting a measurement.
--
-- ---------------------------------------------------------------------------
-- AND A CORRECTION TO THE FORECAST ITSELF, found by using it
--
-- The same forecast reported `DR6:balance_changed_without_journal` at 161 and
-- `DR2:balance_born_outside_the_mint` at 124 over 24 hours, which reads as two rules about to
-- refuse hundreds of legitimate writes. Both are already fixed. Every one of those incidents
-- predates 2026-09-07 22:01, when the fixture exemption landed; since then DR2 has filed 21 rows,
-- all `info`, all fixtures, and DR6 has filed nothing at all.
--
-- A WINDOW THAT STRADDLES A FIX REPORTS A SOLVED PROBLEM AS A LIVE ONE. That is the same class of
-- defect as everything else found today - a signal that answers confidently without saying what it
-- cannot distinguish (10.86) - and it is worse in a forecast than in an alarm, because a forecast
-- exists to be trusted on a deadline.
--
-- The forecast now reports WHEN each rule last fired, and says in words how long ago. A reader can
-- tell "4,541, most recent 2 minutes ago" from "161, most recent 18 hours ago and nothing since".
--
-- One transaction. No money moves.

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

-- ---------------------------------------------------------------------------
-- 1. The limit.
-- ---------------------------------------------------------------------------
UPDATE public.diamond_engine_daily_caps
   SET max_per_user_per_day = 4000
 WHERE engine = 'daily_challenges';

UPDATE public.diamond_engine_daily_caps
   SET max_per_user_per_day = 500
 WHERE engine = 'catalog_v2';

COMMENT ON TABLE public.diamond_engine_daily_caps IS
  'The per-user, per-engine, per-day earning limit - since ruling 21 the ONLY control that refuses an award. A cap must sit ABOVE the design ceiling of its engine (what a player earns completing everything the game assigns in a day) or it refuses the product rather than limiting abuse. daily_challenges: ceiling 2,969 measured over 7,526 user-days, cap 4,000. catalog_v2: observed maximum 260, cap 500.';

-- ---------------------------------------------------------------------------
-- 2. The forecast says how long ago, so a window cannot misreport a fix.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.fn_ca_diamond_flip_forecast(integer);

CREATE FUNCTION public.fn_ca_diamond_flip_forecast(p_hours integer DEFAULT 24)
RETURNS TABLE (
  rule           text,
  mode           text,
  arms_on        date,
  would_refuse   bigint,
  players_hit    bigint,
  diamonds       numeric,
  last_seen      timestamptz,
  verdict        text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_since timestamptz := now() - make_interval(hours => GREATEST(COALESCE(p_hours, 24), 1));
        v_blind bigint; v_blind_last timestamptz;
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
         max(i.occurred_at),
         CASE
           WHEN m.mode = 'refuse' THEN
             'ALREADY ARMED. It is refusing now; the count is what it has refused.'
           WHEN count(i.id) = 0 THEN
             'SAFE TO ARM. Nothing in the window would have been refused.'
           -- A WINDOW CAN STRADDLE A FIX. Saying only "161 in 24 hours" reported two already-fixed
           -- rules as live problems on 2026-09-08; the age of the most recent one is what tells
           -- those apart, so it is in the verdict rather than only in a column.
           WHEN max(i.occurred_at) < now() - interval '6 hours' THEN
             'PROBABLY FIXED ALREADY. ' || count(i.id) || ' in the window, but the most recent was '
             || date_trunc('minute', now() - max(i.occurred_at))
             || ' ago and nothing since. Re-run over a window that starts after the fix to confirm.'
           WHEN m.flip_after IS NULL THEN
             'WOULD REFUSE ' || count(i.id) || ' - no arming date set, so this is advisory only.'
           WHEN m.flip_after <= now() THEN
             'OVERDUE AND LOUD. Its date has passed, it is still logging, and it would refuse '
             || count(i.id) || ' movement(s) affecting ' || count(DISTINCT i.user_id) || ' player(s).'
           ELSE
             'WOULD REFUSE ' || count(i.id) || ' movement(s) worth ' || COALESCE(sum(abs(i.amount)), 0)
             || ' diamonds across ' || count(DISTINCT i.user_id) || ' player(s), most recent '
             || date_trunc('minute', now() - max(i.occurred_at)) || ' ago, arming in '
             || (m.flip_after::date - now()::date) || ' day(s). Read this before that date.'
         END
    FROM public.ca_diamond_rule_modes m
    LEFT JOIN public.ca_diamond_incidents i
           ON i.rule = m.rule AND i.occurred_at >= v_since
   GROUP BY m.rule, m.mode, m.flip_after
   ORDER BY count(i.id) DESC, m.flip_after NULLS LAST;

  -- THE BLIND SPOT, ON ITS OWN ROW. A rule can only be forecast from what it filed, so a window in
  -- which the ledger could not write is a window in which every count above is a floor.
  SELECT count(*), max(x.occurred_at) INTO v_blind, v_blind_last
    FROM public.ca_diamond_incidents x
   WHERE x.rule = 'DR7:ledger_write_failed' AND x.occurred_at >= v_since;
  RETURN QUERY SELECT
    '(forecast confidence)'::text,
    CASE WHEN v_blind = 0 THEN 'complete' ELSE 'incomplete' END::text,
    NULL::date, v_blind, 0::bigint, 0::numeric, v_blind_last,
    CASE WHEN v_blind = 0
         THEN 'Every award in the window was evaluated, so the counts above are totals.'
         ELSE v_blind || ' award(s) could not be evaluated at all because the ledger write failed, '
              || 'most recent ' || date_trunc('minute', now() - v_blind_last)
              || ' ago. Every count above is a FLOOR, not a total.'
    END;
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_diamond_flip_forecast(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_flip_forecast(integer) TO service_role;

COMMENT ON FUNCTION public.fn_ca_diamond_flip_forecast(integer) IS
  'For every diamond rule: what it would refuse if armed today, how many players that hits, WHEN IT LAST FIRED, and when it arms itself. Counted from the incidents each rule already files on exactly the condition it refuses on. The age of the most recent occurrence matters: a window that straddles a fix otherwise reports a solved problem as a live one, which it did on 2026-09-08.';

-- ---------------------------------------------------------------------------
-- 3. Is a cap set right? A forward-looking instrument, because the forecast cannot be.
-- ---------------------------------------------------------------------------
-- The flip forecast counts INCIDENTS, which were filed under whatever cap was in force at the
-- time. Raise a cap and history does not change, so the forecast keeps reporting refusals the new
-- cap would not make - it is backward-looking by construction and cannot show a cap change
-- working. Saying "the forecast still shows 4,541" after fixing the cap would be reading the wrong
-- instrument, so here is the right one.
--
-- This asks the two tables the cap rule itself reads - what players actually earned, against what
-- the cap allows - plus the design ceiling from the challenge catalogue. It answers, today, for
-- the cap in force right now.
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_cap_headroom(p_days integer DEFAULT 14)
RETURNS TABLE (
  engine          text,
  cap_now         integer,
  design_ceiling  bigint,
  observed_max    bigint,
  observed_p99    bigint,
  user_days       bigint,
  would_refuse    bigint,
  verdict         text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_from date := current_date - GREATEST(COALESCE(p_days, 14), 1);
BEGIN
  IF COALESCE(auth.role(), 'service_role') <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required';
  END IF;

  RETURN QUERY
  WITH awarded AS (
    SELECT a.engine, a.awarded FROM public.diamond_user_daily_awards a
     WHERE a.day >= v_from AND a.awarded > 0),
  -- The design ceiling exists only where the catalogue says what a full day pays. Today that is
  -- the daily challenges; other engines report NULL rather than a guess.
  ceiling AS (
    SELECT 'daily_challenges'::text AS engine,
           max(possible)::bigint AS design_ceiling
      FROM (SELECT sum(u.diamond_reward_snapshot) possible
              FROM public.user_daily_challenges u
             WHERE u.created_at >= now() - make_interval(days => GREATEST(COALESCE(p_days, 14), 1))
             GROUP BY u.user_id, (u.created_at AT TIME ZONE 'America/Chicago')::date) s)
  SELECT c.engine,
         c.max_per_user_per_day,
         cl.design_ceiling,
         COALESCE(max(w.awarded), 0)::bigint,
         COALESCE(percentile_disc(0.99) WITHIN GROUP (ORDER BY w.awarded), 0)::bigint,
         count(w.awarded),
         count(*) FILTER (WHERE w.awarded > c.max_per_user_per_day),
         CASE
           WHEN c.max_per_user_per_day IS NULL THEN 'NO CAP. Nothing limits one account on this engine.'
           WHEN cl.design_ceiling IS NOT NULL AND c.max_per_user_per_day <= cl.design_ceiling THEN
             'BELOW THE DESIGN CEILING (' || cl.design_ceiling || '). This refuses a player who completed '
             || 'everything the game assigned them. Raise it above the ceiling.'
           WHEN count(*) FILTER (WHERE w.awarded > c.max_per_user_per_day) > 0 THEN
             'REFUSES REAL DAYS: ' || count(*) FILTER (WHERE w.awarded > c.max_per_user_per_day)
             || ' of ' || count(w.awarded) || ' user-days in the window are over it.'
           WHEN count(w.awarded) = 0 THEN 'NO ACTIVITY in the window; nothing to judge it against.'
           ELSE 'HEALTHY. ' || count(w.awarded) || ' user-days, highest ' || COALESCE(max(w.awarded), 0)
                || ', cap ' || c.max_per_user_per_day || ' - '
                || round(c.max_per_user_per_day::numeric / NULLIF(max(w.awarded), 0), 2) || 'x headroom.'
         END
    FROM public.diamond_engine_daily_caps c
    LEFT JOIN awarded w ON w.engine = c.engine
    LEFT JOIN ceiling cl ON cl.engine = c.engine
   GROUP BY c.engine, c.max_per_user_per_day, cl.design_ceiling
   ORDER BY count(*) FILTER (WHERE w.awarded > c.max_per_user_per_day) DESC, c.engine;
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_diamond_cap_headroom(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_cap_headroom(integer) TO service_role;

COMMENT ON FUNCTION public.fn_ca_diamond_cap_headroom(integer) IS
  'Is each per-user daily cap set right? Reads what players actually earned against the cap in force NOW, plus the design ceiling from the catalogue. The flip forecast cannot answer this: it counts incidents filed under whatever cap applied at the time, so it is blind to a cap change until new history accumulates.';

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_cap integer; v_ceiling integer; v_over integer; r record;
BEGIN
  SELECT max_per_user_per_day INTO v_cap FROM public.diamond_engine_daily_caps WHERE engine = 'daily_challenges';
  IF v_cap <> 4000 THEN RAISE EXCEPTION 'the daily challenge cap is % not 4000', v_cap; END IF;

  -- THE CAP MUST SIT ABOVE THE DESIGN CEILING. This is the check that would have caught the
  -- original 2,000, and it is measured from the catalogue rather than from an opinion.
  SELECT max(possible) INTO v_ceiling FROM (
    SELECT sum(diamond_reward_snapshot) possible
      FROM public.user_daily_challenges
     WHERE created_at >= now() - interval '14 days'
     GROUP BY user_id, (created_at AT TIME ZONE 'America/Chicago')::date) s;
  IF v_ceiling IS NULL THEN RAISE EXCEPTION 'no assignments to derive a ceiling from'; END IF;
  IF v_cap <= v_ceiling THEN
    RAISE EXCEPTION 'the cap % is not above the design ceiling % - it would refuse a player who completed everything', v_cap, v_ceiling;
  END IF;

  -- and nobody in the measured history would now be refused
  SELECT count(*) INTO v_over FROM public.diamond_user_daily_awards a
    JOIN public.diamond_engine_daily_caps c ON c.engine = a.engine
   WHERE a.day >= current_date - 14 AND a.awarded > c.max_per_user_per_day;
  IF v_over <> 0 THEN
    RAISE EXCEPTION '% user-day(s) in the last 14 days would still be refused by the new caps', v_over;
  END IF;

  -- the forecast reports recency, and still finds what it is for
  IF NOT EXISTS (SELECT 1 FROM public.fn_ca_diamond_flip_forecast(24) f WHERE f.last_seen IS NOT NULL) THEN
    RAISE EXCEPTION 'the forecast reports no recency at all';
  END IF;
  IF (SELECT count(*) FROM public.fn_ca_diamond_flip_forecast(24)) <>
     (SELECT count(*) + 1 FROM public.ca_diamond_rule_modes) THEN
    RAISE EXCEPTION 'the forecast stopped covering every rule';
  END IF;

  FOR r IN SELECT * FROM public.fn_ca_diamond_flip_forecast(24) LOOP
    RAISE NOTICE '% [%] arms % -> % refusals, last seen % : %',
      r.rule, r.mode, COALESCE(r.arms_on::text, '-'), r.would_refuse,
      COALESCE(r.last_seen::text, 'never'), left(r.verdict, 70);
  END LOOP;

  IF (SELECT public.fn_ca_mint_supply('diamonds'))
     <> (SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) + public.fn_ca_diamond_offledger_float() THEN
    RAISE EXCEPTION 'players + float <> register after a change that moves no money';
  END IF;
END $$;

COMMIT;
