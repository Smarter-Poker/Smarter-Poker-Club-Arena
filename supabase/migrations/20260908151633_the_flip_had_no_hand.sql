-- 20260908151633_the_flip_had_no_hand.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- APPLIED TO PRODUCTION 2026-09-08 via the us-west-2 session pooler; this file is
-- the record of what ran, and is registered in supabase_migrations.schema_migrations.

-- NINE RULES WERE WRITTEN TO ARM THEMSELVES ON A DATE, AND NOTHING ANYWHERE CALLS THE FUNCTION
-- THAT ARMS THEM.
-- (CLAUDE.md 10.86, 10.11; rulings 13-20; docs/changelog/2026-09-08-the-flip-had-no-hand.md)
--
-- Every diamond rule in `ca_diamond_rule_modes` carries a `flip_after` date on which it stops
-- logging and starts refusing. Nine rules, three dates - 2026-09-14, 2026-09-22, 2026-10-08 - and a
-- week of work went into making those dates safe: the flip forecast, the cap headroom report, the
-- VIP cap fix, the horse settlement. All of it to answer "what will this refuse on the day it arms".
--
-- **NOTHING ARMS THEM.** `fn_ca_diamond_rule_flip` is the only thing that sets mode to 'refuse'.
-- Measured on production 2026-09-08:
--
--     cron jobs calling it ......... 0   (the four ca-diamond-* jobs are snapshot, trial balance,
--                                        prune history - none touches the rule modes)
--     database functions calling it  0
--     application callers ......... none found
--
-- So `flip_after` is a date on which NOTHING HAPPENS. Nine rules stay in `log` mode for ever, the
-- three dates pass unremarked, and every instrument built to make them safe reports on a transition
-- that will not occur. This is the estate's own signature failure - a guard that reads as armed
-- while being unreachable - and CLAUDE.md's engine-restart handoff records finding three more of
-- exactly this shape. It is worth saying plainly that the elaborate safety apparatus around the
-- flip is what made it invisible: everyone, including me, was checking whether the flip was SAFE
-- and nobody checked whether it was CONNECTED.
--
-- WHAT THIS ADDS, and the safety reasoning for each part.
--
-- 1. A HAND. `fn_ca_diamond_rule_flip_due()` walks every log-mode rule and tries to arm it, on a
--    daily pg_cron tick beside the four ca-diamond-* jobs that already run this subsystem's work.
--    It is NOT a repair job (10.12): it repairs nothing and compensates for nothing. Its schedule
--    IS the product - `flip_after` is a date, and a date needs something that notices it.
--
--    IT DECIDES NOTHING. Arming these rules was decided when they were written (rulings 13-20,
--    with dates); this executes recorded intent, and it is strictly more conservative than a human
--    doing it by hand, because it passes all of `fn_ca_diamond_rule_flip`'s existing gates
--    (`flip_after` reached, zero non-info incidents in `clean_days_required`, and some function
--    must actually consult the rule) AND a fourth this migration adds: **the forecast must report
--    zero would-refuse since the rule's configuration last changed.** The forecast stops being a
--    report somebody might read and becomes the gate.
--
--    A rule it cannot arm is REPORTED, not silently skipped, so "blocked" and "nothing to do" are
--    never the same reading.
--
-- 2. THE FORECAST LEARNS WHEN THE CONFIGURATION CHANGED. It counts incidents over a time window,
--    and a rule's configuration can change INSIDE that window - which makes every count before the
--    change evidence about a rule that no longer exists in that form.
--
--    Today that misreads harmlessly: it says `DR7:user_over_daily_cap` would refuse 4,549, and
--    every one of those predates the 14:33 cap fix; zero have been filed since. **THE DANGEROUS
--    DIRECTION IS THE REVERSE.** Lower a cap and the forecast reads "SAFE TO ARM" for 24 hours on
--    evidence gathered under the old, looser setting - and with (1) above, that stale "safe" is now
--    wired to something that acts on it. It reports `since_config` beside `would_refuse`, and the
--    flip gate reads the former.
--
-- 3. `updated_at` IS ACTUALLY MAINTAINED. Both config tables carry the column and NEITHER had a
--    trigger, so it recorded whatever the last writer happened to set by hand. My own cap change at
--    14:33 today left it reading 05:05. A configuration epoch that the configuration does not
--    update is worse than none, because (2) would trust it.
--
-- 4. ONE FRONT DOOR. There are 28 `fn_ca_diamond_*` / `fn_ca_mint_*` reporting functions. A person
--    has to know which to read, in what order, and what a bad answer looks like in each - so in
--    practice nobody reads most of them, and this defect lived among them for a week.
--    `fn_ca_diamond_health()` runs the set and returns one row per area with a status and a
--    sentence. Its first row is whether the flip has a hand.
--
-- One transaction.

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

-- ---------------------------------------------------------------------------
-- 3 first: the epoch has to be real before anything reads it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS zz_touch_updated_at ON public.diamond_engine_daily_caps;
CREATE TRIGGER zz_touch_updated_at
  BEFORE INSERT OR UPDATE ON public.diamond_engine_daily_caps
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_touch_updated_at();

DROP TRIGGER IF EXISTS zz_touch_updated_at ON public.ca_diamond_rule_modes;
CREATE TRIGGER zz_touch_updated_at
  BEFORE INSERT OR UPDATE ON public.ca_diamond_rule_modes
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_touch_updated_at();

-- The two caps changed at 14:33 today still read 05:05 and 22:26, because nothing maintained the
-- column. Correcting them forward: an epoch that is EARLIER than the real change is the unsafe
-- direction - it would let the forecast count pre-change incidents as current evidence.
UPDATE public.diamond_engine_daily_caps
   SET note = note
 WHERE engine IN ('daily_challenges', 'catalog_v2');

-- ---------------------------------------------------------------------------
-- 2. The forecast reports what postdates the configuration.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.fn_ca_diamond_flip_forecast(integer);

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_flip_forecast(p_hours integer DEFAULT 24)
RETURNS TABLE (
  rule          text,
  mode          text,
  arms_on       date,
  would_refuse  bigint,
  since_config  bigint,
  players_hit   bigint,
  diamonds      numeric,
  last_seen     timestamptz,
  config_at     timestamptz,
  verdict       text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_since timestamptz := now() - make_interval(hours => GREATEST(COALESCE(p_hours, 24), 1));
        v_blind bigint; v_blind_new timestamptz; v_caps timestamptz;
BEGIN
  IF COALESCE(auth.role(), 'service_role') <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required';
  END IF;

  -- DR7:user_over_daily_cap is the one rule whose behaviour is set by a SECOND table: change a row
  -- in diamond_engine_daily_caps and the rule refuses differently without its own row moving. Every
  -- other rule's configuration is its own row.
  SELECT max(updated_at) INTO v_caps FROM public.diamond_engine_daily_caps;

  RETURN QUERY
  WITH cfg AS (
    SELECT m.rule AS r, m.mode AS md, m.flip_after AS fa,
           GREATEST(m.updated_at,
                    CASE WHEN m.rule = 'DR7:user_over_daily_cap' THEN v_caps ELSE m.updated_at END)
             AS epoch
      FROM public.ca_diamond_rule_modes m)
  SELECT c.r, c.md, c.fa::date,
         count(i.id),
         count(i.id) FILTER (WHERE i.occurred_at >= c.epoch),
         count(DISTINCT i.user_id),
         COALESCE(sum(abs(i.amount)), 0)::numeric,
         max(i.occurred_at),
         c.epoch,
         CASE
           WHEN c.md = 'refuse' THEN
             'ALREADY ARMED. It is refusing now; the count is what it has refused.'
           WHEN count(i.id) = 0 THEN
             'SAFE TO ARM. Nothing in the window would have been refused.'
           -- The configuration moved inside the window, so the older incidents describe a rule that
           -- no longer exists in that form. Say so rather than reporting a total that mixes both.
           WHEN c.epoch > v_since AND count(i.id) FILTER (WHERE i.occurred_at >= c.epoch) = 0 THEN
             'SAFE TO ARM SINCE THE CONFIGURATION CHANGED at ' || to_char(c.epoch, 'YYYY-MM-DD HH24:MI')
             || '. The ' || count(i.id) || ' in the window all predate it and describe the old setting.'
           WHEN c.epoch > v_since THEN
             'WOULD REFUSE ' || count(i.id) FILTER (WHERE i.occurred_at >= c.epoch)
             || ' SINCE THE CONFIGURATION CHANGED at ' || to_char(c.epoch, 'YYYY-MM-DD HH24:MI')
             || ' (' || count(i.id) || ' in the whole window). Read the first number.'
           WHEN max(i.occurred_at) < now() - interval '3 hours' THEN
             'PROBABLY FIXED ALREADY. ' || count(i.id) || ' in the window, but the most recent was '
             || to_char(now() - max(i.occurred_at), 'HH24:MI') || ' ago and nothing since. Re-read '
             || 'over a shorter window before acting.'
           WHEN c.fa IS NULL THEN
             'WOULD REFUSE ' || count(i.id) || ' - no arming date set, so this is advisory only.'
           WHEN c.fa <= now() THEN
             'OVERDUE AND LOUD. Its date has passed, it is still logging, and it would refuse '
             || count(i.id) || ' movement(s) affecting ' || count(DISTINCT i.user_id) || ' player(s).'
           ELSE
             'WOULD REFUSE ' || count(i.id) || ' movement(s) worth ' || COALESCE(sum(abs(i.amount)), 0)
             || ' diamonds across ' || count(DISTINCT i.user_id) || ' player(s), most recent '
             || to_char(now() - max(i.occurred_at), 'HH24:MI') || ' ago, starting in '
             || (c.fa::date - now()::date) || ' day(s). Read this before that date.'
         END
    FROM cfg c
    LEFT JOIN public.ca_diamond_incidents i ON i.rule = c.r AND i.occurred_at >= v_since
   GROUP BY c.r, c.md, c.fa, c.epoch;

  RETURN QUERY
  SELECT x.rule, 'retired'::text, NULL::date,
         count(*), count(*), count(DISTINCT x.user_id), COALESCE(sum(abs(x.amount)), 0)::numeric,
         max(x.occurred_at), NULL::timestamptz,
         'RETIRED RULE, ' || count(*) || ' incident(s) still in the window. It refuses nothing and '
         || 'arms on no date. The rows are history and stay; nothing acts on them.'
    FROM public.ca_diamond_incidents x
   WHERE x.occurred_at >= v_since
     AND NOT EXISTS (SELECT 1 FROM public.ca_diamond_rule_modes m WHERE m.rule = x.rule)
   GROUP BY x.rule;

  SELECT count(*), max(x.occurred_at) INTO v_blind, v_blind_new
    FROM public.ca_diamond_incidents x
   WHERE x.rule = 'DR7:ledger_write_failed' AND x.occurred_at >= v_since;
  RETURN QUERY SELECT
    '(forecast confidence)'::text,
    CASE WHEN v_blind = 0 THEN 'complete' ELSE 'incomplete' END::text,
    NULL::date, v_blind, v_blind, 0::bigint, 0::numeric, v_blind_new, NULL::timestamptz,
    CASE WHEN v_blind = 0
         THEN 'Every award in the window was evaluated, so the counts above are totals.'
         ELSE v_blind || ' award(s) could not be evaluated at all because the ledger write failed, '
              || 'most recent ' || to_char(now() - v_blind_new, 'HH24:MI') || ' ago. Every count '
              || 'above is a FLOOR, not a total.'
    END;
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_diamond_flip_forecast(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_flip_forecast(integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 1. The hand.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_rule_flip_due(p_dry_run boolean DEFAULT false)
RETURNS TABLE (rule text, action text, detail text)
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE r record; v_msg text; v_fc record; v_armed int := 0; v_blocked int := 0; v_n bigint;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'fn_ca_diamond_rule_flip_due: service_role required';
  END IF;

  FOR r IN SELECT m.rule AS rl, m.flip_after, m.clean_days_required
             FROM public.ca_diamond_rule_modes m
            WHERE m.mode = 'log' ORDER BY m.flip_after, m.rule
  LOOP
    -- THE FOURTH GATE, AND THE REASON THE FORECAST EXISTS. The three gates inside
    -- fn_ca_diamond_rule_flip ask whether the rule has been quiet. This asks what it would DO -
    -- counted only over the window since its configuration last changed, because evidence from
    -- before a cap moved describes a rule that no longer exists in that form.
    SELECT * INTO v_fc FROM public.fn_ca_diamond_flip_forecast(
      GREATEST(24, r.clean_days_required * 24)) f WHERE f.rule = r.rl;

    IF v_fc IS NULL THEN
      v_blocked := v_blocked + 1;
      RETURN QUERY SELECT r.rl, 'blocked'::text,
        'the forecast does not cover this rule, so nothing can say what arming it would do'::text;
      CONTINUE;
    END IF;

    IF v_fc.since_config > 0 THEN
      v_blocked := v_blocked + 1;
      RETURN QUERY SELECT r.rl, 'blocked'::text,
        format('would refuse %s movement(s) since its configuration changed at %s',
               v_fc.since_config, to_char(v_fc.config_at, 'YYYY-MM-DD HH24:MI'));
      CONTINUE;
    END IF;

    IF p_dry_run THEN
      -- A DRY RUN MUST EVALUATE THE SAME GATES THE REAL ONE DOES. An earlier draft checked only the
      -- forecast gate above and then reported "every gate passes" - so all nine rules read as
      -- ready to arm while fn_ca_diamond_rule_flip would have refused every one of them on its
      -- date. The health report counts blocked rows, so that draft would have reported the whole
      -- subsystem healthy on the strength of a check it had not run: the exact defect this
      -- migration exists to fix, reintroduced one level up (CLAUDE.md 10.86 rule 4).
      IF now() < r.flip_after THEN
        v_blocked := v_blocked + 1;
        RETURN QUERY SELECT r.rl, 'blocked'::text,
          format('may not arm before %s', to_char(r.flip_after, 'YYYY-MM-DD'));
        CONTINUE;
      END IF;
      SELECT count(*) INTO v_n FROM public.ca_diamond_incidents i
       WHERE i.rule = r.rl AND i.severity <> 'info'
         AND i.occurred_at >= now() - make_interval(days => r.clean_days_required);
      IF v_n > 0 THEN
        v_blocked := v_blocked + 1;
        RETURN QUERY SELECT r.rl, 'blocked'::text,
          format('%s non-info incident(s) in the last %s days; not clean', v_n, r.clean_days_required);
        CONTINUE;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prosrc LIKE '%fn_ca_diamond_rule_mode%'
           AND p.prosrc LIKE '%' || r.rl || '%') THEN
        v_blocked := v_blocked + 1;
        RETURN QUERY SELECT r.rl, 'blocked'::text,
          'no function consults this rule; arming it would change nothing'::text;
        CONTINUE;
      END IF;
      RETURN QUERY SELECT r.rl, 'would-arm'::text,
        format('every gate passes; arming date %s', COALESCE(r.flip_after::date::text, 'unset'));
      CONTINUE;
    END IF;

    BEGIN
      PERFORM public.fn_ca_diamond_rule_flip(r.rl, 'auto:flip_due');
      v_armed := v_armed + 1;
      RETURN QUERY SELECT r.rl, 'armed'::text, 'now refusing'::text;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      v_blocked := v_blocked + 1;
      -- A rule that cannot be armed is REPORTED. "Blocked" and "nothing to do" must never read the
      -- same, which is the whole reason this function had to be written (CLAUDE.md 10.86).
      RETURN QUERY SELECT r.rl, 'blocked'::text, v_msg;
    END;
  END LOOP;

  -- One info line per run, so the fact that this ran at all is visible in the same place the rules
  -- report themselves. Without it, a dead scheduler and a quiet week look identical.
  BEGIN
    PERFORM public.fn_ca_diamond_incident(
      'DR0:rule_flip_sweep', 'info', NULL, NULL, 'fn_ca_diamond_rule_flip_due',
      jsonb_build_object('armed', v_armed, 'blocked', v_blocked, 'dry_run', p_dry_run));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_diamond_rule_flip_due(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_rule_flip_due(boolean) TO service_role;

COMMENT ON FUNCTION public.fn_ca_diamond_rule_flip_due(boolean) IS
  'Arms every diamond rule whose flip_after date has passed and whose gates all pass, and REPORTS every rule it could not arm. Exists because nine rules carried arming dates and nothing anywhere called fn_ca_diamond_rule_flip - the dates would have passed unremarked for ever. It decides nothing: arming was decided when each rule was written (rulings 13-20). Scheduled daily as ca-diamond-rule-flip-daily.';

SELECT cron.schedule('ca-diamond-rule-flip-daily', '50 6 * * *',
                     $cron$SELECT count(*) FROM public.fn_ca_diamond_rule_flip_due()$cron$)
 WHERE NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-diamond-rule-flip-daily');

-- ---------------------------------------------------------------------------
-- 4. One front door.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_health()
RETURNS TABLE (area text, status text, detail text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_n bigint; v_m numeric; v_t text;
BEGIN
  IF COALESCE(auth.role(), 'service_role') <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required';
  END IF;

  -- FIRST, because it was invisible for a week among twenty-eight other reports.
  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'ca-diamond-rule-flip-daily' AND active;
  RETURN QUERY SELECT 'rule arming'::text,
    CASE WHEN v_n = 1 THEN 'ok' ELSE 'critical' END,
    CASE WHEN v_n = 1
         THEN 'ca-diamond-rule-flip-daily is scheduled and active; flip_after dates will be acted on.'
         ELSE 'NOTHING ARMS THE RULES. Every flip_after date will pass unremarked and every rule '
              || 'stays in log mode for ever.' END;

  -- ONLY RULES WHOSE DATE HAS PASSED COUNT AS STUCK. A rule waiting for 2026-10-08 is not a
  -- problem, it is a rule waiting; reporting it as one would make this line amber for a month and
  -- teach whoever reads it to ignore the row.
  SELECT count(*) INTO v_n
    FROM public.fn_ca_diamond_rule_flip_due(true) x
    JOIN public.ca_diamond_rule_modes m ON m.rule = x.rule
   WHERE x.action = 'blocked' AND m.flip_after IS NOT NULL AND m.flip_after <= now();
  RETURN QUERY SELECT 'rules overdue'::text,
    CASE WHEN v_n = 0 THEN 'ok' ELSE 'attention' END,
    CASE WHEN v_n = 0 THEN 'No rule is past its arming date and still stuck.'
         ELSE v_n || ' rule(s) are past their arming date and still cannot arm; read '
              || 'fn_ca_diamond_rule_flip_due(true) for each reason.' END;

  -- The money identity. If this is ever false nothing else on this list matters.
  v_m := (SELECT public.fn_ca_mint_supply('diamonds'))
         - ((SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) + public.fn_ca_diamond_offledger_float());
  RETURN QUERY SELECT 'money identity'::text,
    CASE WHEN v_m = 0 THEN 'ok' ELSE 'critical' END,
    CASE WHEN v_m = 0 THEN 'players + float = register, exactly.'
         ELSE 'players + float differs from the register by ' || v_m || '.' END;

  v_m := public.fn_ca_diamond_snapshot();
  RETURN QUERY SELECT 'deploy gate'::text,
    CASE WHEN COALESCE(v_m, -1) = 0 THEN 'ok' ELSE 'critical' END,
    CASE WHEN COALESCE(v_m, -1) = 0 THEN 'The snapshot explains every movement.'
         ELSE COALESCE(v_m::text, 'NULL') || ' unexplained since the last snapshot.' END;

  SELECT count(*) INTO v_n FROM public.fn_ca_diamond_trial_balance() x
   WHERE x.difference IS NOT NULL AND x.difference <> 0;
  RETURN QUERY SELECT 'trial balance'::text,
    CASE WHEN v_n = 0 THEN 'ok' ELSE 'critical' END,
    CASE WHEN v_n = 0 THEN 'Every reconciling account balances.'
         ELSE v_n || ' account(s) do not reconcile.' END;

  SELECT COALESCE(sum(x.would_refuse), 0) INTO v_n FROM public.fn_ca_diamond_cap_headroom(14) x;
  RETURN QUERY SELECT 'per-user caps'::text,
    CASE WHEN v_n = 0 THEN 'ok' ELSE 'attention' END,
    CASE WHEN v_n = 0 THEN 'No real user-day in fourteen days exceeds the cap that applies to it.'
         ELSE v_n || ' user-day(s) exceed the cap that applies to them; arming would refuse them.' END;

  SELECT count(*) INTO v_n FROM public.diamond_engine_daily_caps
   WHERE max_per_user_per_day_vip IS NOT NULL AND max_per_user_per_day IS NOT NULL
     AND max_per_user_per_day_vip < max_per_user_per_day;
  RETURN QUERY SELECT 'VIP caps'::text,
    CASE WHEN v_n = 0 THEN 'ok' ELSE 'attention' END,
    CASE WHEN v_n = 0 THEN 'No cap gives a VIP less than a standard player.'
         ELSE v_n || ' cap(s) make VIP a downgrade.' END;

  -- The class of defect that cost 759 rewards: earned, unclaimed, and inside its window.
  SELECT count(*) INTO v_n FROM public.user_daily_challenges u
   WHERE u.completed AND NOT u.claimed AND u.expired_at IS NULL
     AND u.completed_at >= now() - interval '7 days';
  RETURN QUERY SELECT 'unclaimed rewards'::text,
    CASE WHEN v_n = 0 THEN 'ok' WHEN v_n < 50 THEN 'attention' ELSE 'critical' END,
    CASE WHEN v_n = 0 THEN 'Nothing earned is sitting unclaimed inside its window.'
         ELSE v_n || ' earned reward(s) are unclaimed and will expire. 759 did this on 2026-09-08 '
              || 'because a horse claims only when a new engine event arrives.' END;

  SELECT count(*) INTO v_n FROM public.profiles p
   WHERE p.is_horse AND (public.fn_ca_is_cert_account(p.id) OR public.fn_ca_is_fixture_account(p.id));
  RETURN QUERY SELECT 'horses are players'::text,
    CASE WHEN v_n = 0 THEN 'ok' ELSE 'critical' END,
    CASE WHEN v_n = 0 THEN 'No horse is classified as test equipment.'
         ELSE v_n || ' horse(s) read as harness equipment and are being denied what players get.' END;

  SELECT count(*) INTO v_n FROM public.fn_ca_diamond_budget_reality() x
   WHERE x.verdict LIKE 'ALREADY OVER%' OR x.verdict LIKE 'FUTURE PLAN BELOW%' OR x.verdict LIKE 'BUDGETED ZERO%';
  RETURN QUERY SELECT 'budget plans'::text,
    CASE WHEN v_n = 0 THEN 'ok' ELSE 'attention' END,
    CASE WHEN v_n = 0 THEN 'Every reward budget is plausible against actual issuance.'
         ELSE v_n || ' budget line(s) are fiction. They refuse nobody (ruling 21), but somebody is '
              || 'reading them. Setting them is Dan''s (10.9).' END;

  SELECT count(*) INTO v_n FROM public.fn_ca_diamond_unreachable_money();
  RETURN QUERY SELECT 'unreachable money'::text,
    CASE WHEN v_n = 0 THEN 'ok' ELSE 'attention' END,
    CASE WHEN v_n = 0 THEN 'No diamonds are stranded where nothing can reach them.'
         ELSE v_n || ' finding(s); read fn_ca_diamond_unreachable_money().' END;

  -- The forecast's own blind spot, carried up rather than left one level down.
  --
  -- STILL HAPPENING AND ALREADY STOPPED ARE DIFFERENT ANSWERS. A count over 24 hours cannot tell
  -- them apart, and the first draft of this row reported `critical` for 5,861 coverage failures
  -- that had all occurred in one burst and stopped three minutes before the fix landed. An alarm
  -- that stays red for a day after the cause is fixed is an alarm somebody mutes - and this row is
  -- the one that says whether any of the others can be trusted, so it is the worst one to mute.
  SELECT count(*), max(i.occurred_at) INTO v_n, v_t
    FROM public.ca_diamond_incidents i
   WHERE i.rule = 'DR7:ledger_write_failed' AND i.occurred_at >= now() - interval '24 hours';
  RETURN QUERY SELECT 'evaluation coverage'::text,
    CASE WHEN COALESCE(v_n, 0) = 0 THEN 'ok'
         WHEN v_t::timestamptz >= now() - interval '1 hour' THEN 'critical'
         ELSE 'attention' END,
    CASE WHEN COALESCE(v_n, 0) = 0
         THEN 'Every award in the last 24 hours was evaluated by the rules, so their counts are totals.'
         WHEN v_t::timestamptz >= now() - interval '1 hour'
         THEN v_n || ' award(s) could not be evaluated at all in the last 24 hours and it is STILL '
              || 'HAPPENING (most recent ' || to_char(now() - v_t::timestamptz, 'HH24:MI')
              || ' ago). Every rule count is a floor, not a total.'
         ELSE v_n || ' award(s) could not be evaluated in the last 24 hours, but none for '
              || to_char(now() - v_t::timestamptz, 'HH24:MI') || '. Counts covering that burst are '
              || 'floors; the cause appears fixed.' END;
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_diamond_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_health() TO service_role;

COMMENT ON FUNCTION public.fn_ca_diamond_health() IS
  'One call over the diamond economy: eleven areas, each with ok/attention/critical and a sentence. Exists because there are 28 fn_ca_diamond_*/fn_ca_mint_* reporting functions and a person has to know which to read - which is how "nothing arms the rules" survived a week of daily review. Its first row is whether the flip has a hand.';

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_n bigint; v_t timestamptz; v_row record; v_before timestamptz;
BEGIN
  -- 3. updated_at is maintained now.
  -- The test is `= now()`, not `> the previous value`. `now()` is TRANSACTION time and does not
  -- advance inside a transaction, so a before/after comparison here compares a value this same
  -- transaction already stamped against itself and always reports failure - which is exactly what
  -- the first draft of this assertion did. Equality with now() proves the trigger fired, because
  -- nothing else in this transaction writes that column.
  UPDATE public.diamond_engine_daily_caps SET note = note WHERE engine = 'daily_challenges';
  SELECT updated_at INTO v_t FROM public.diamond_engine_daily_caps WHERE engine = 'daily_challenges';
  IF v_t IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'diamond_engine_daily_caps.updated_at is not stamped by a write (got %, expected %)', v_t, now();
  END IF;
  UPDATE public.ca_diamond_rule_modes SET note = note WHERE rule = 'DR4:credit_without_reference';
  SELECT updated_at INTO v_t FROM public.ca_diamond_rule_modes WHERE rule = 'DR4:credit_without_reference';
  IF v_t IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'ca_diamond_rule_modes.updated_at is not stamped by a write (got %, expected %)', v_t, now();
  END IF;
  -- and both triggers exist, so this cannot pass by accident on a table nothing wrote
  IF (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE t.tgname = 'zz_touch_updated_at' AND NOT t.tgisinternal
         AND c.relname IN ('diamond_engine_daily_caps', 'ca_diamond_rule_modes')) <> 2 THEN
    RAISE EXCEPTION 'both configuration tables must stamp updated_at';
  END IF;

  -- 2. the forecast reports the configuration epoch and what postdates it
  IF NOT EXISTS (SELECT 1 FROM public.fn_ca_diamond_flip_forecast(24) x
                  WHERE x.rule = 'DR7:user_over_daily_cap' AND x.config_at IS NOT NULL) THEN
    RAISE EXCEPTION 'the forecast does not report when the cap rule was last configured';
  END IF;
  SELECT * INTO v_row FROM public.fn_ca_diamond_flip_forecast(24) x
   WHERE x.rule = 'DR7:user_over_daily_cap';
  IF v_row.since_config > v_row.would_refuse THEN
    RAISE EXCEPTION 'since_config (%) exceeds the window total (%)', v_row.since_config, v_row.would_refuse;
  END IF;
  -- The cap was fixed at 14:33 and nothing has been refused since; if this reports otherwise the
  -- epoch is being read from the wrong table.
  IF v_row.since_config <> 0 THEN
    RAISE EXCEPTION 'the cap rule reports % refusals since its configuration changed at %',
      v_row.since_config, v_row.config_at;
  END IF;
  IF v_row.verdict NOT LIKE '%SINCE THE CONFIGURATION CHANGED%' THEN
    RAISE EXCEPTION 'the forecast does not say the evidence predates the configuration change: %', v_row.verdict;
  END IF;

  -- 1. the hand exists, is scheduled, and reports rather than skips
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-diamond-rule-flip-daily' AND active) THEN
    RAISE EXCEPTION 'nothing is scheduled to arm the rules';
  END IF;
  SELECT count(*) INTO v_n FROM public.fn_ca_diamond_rule_flip_due(true);
  IF v_n <> (SELECT count(*) FROM public.ca_diamond_rule_modes WHERE mode = 'log') THEN
    RAISE EXCEPTION 'the flip sweep reported on % of % log-mode rules', v_n,
      (SELECT count(*) FROM public.ca_diamond_rule_modes WHERE mode = 'log');
  END IF;
  -- A DRY RUN MUST NOT ARM ANYTHING. This is the one way this function could cost something.
  IF EXISTS (SELECT 1 FROM public.ca_diamond_rule_modes WHERE mode = 'refuse' AND flipped_by = 'auto:flip_due') THEN
    RAISE EXCEPTION 'the dry run armed a rule';
  END IF;
  -- and no rule is silently skipped: every log-mode rule gets a row with an action
  IF EXISTS (SELECT 1 FROM public.fn_ca_diamond_rule_flip_due(true) x
              WHERE x.action IS NULL OR x.detail IS NULL OR x.detail = '') THEN
    RAISE EXCEPTION 'the flip sweep returned a row with no reason';
  END IF;

  -- 4. the front door covers every area and starts with the one that was invisible
  SELECT count(*) INTO v_n FROM public.fn_ca_diamond_health();
  IF v_n < 11 THEN RAISE EXCEPTION 'the health report covers only % areas', v_n; END IF;
  IF (SELECT h.area FROM public.fn_ca_diamond_health() h LIMIT 1) <> 'rule arming' THEN
    RAISE EXCEPTION 'the health report does not lead with whether the flip has a hand';
  END IF;
  IF EXISTS (SELECT 1 FROM public.fn_ca_diamond_health() h WHERE h.status NOT IN ('ok','attention','critical')) THEN
    RAISE EXCEPTION 'the health report returned a status outside ok/attention/critical';
  END IF;
  -- ASSERT THE INSTRUMENT WORKS, NOT THAT THE PLATFORM IS PERFECT. A migration that refuses to
  -- commit unless every area reads ok would be unshippable the moment anything anywhere is amber,
  -- and the pressure would be to soften the report rather than fix the thing - which is how a
  -- health report becomes decorative. So: the areas THIS migration is responsible for must be ok,
  -- and every row must be well formed.
  IF EXISTS (SELECT 1 FROM public.fn_ca_diamond_health() h
              WHERE h.area IN ('rule arming', 'money identity', 'deploy gate', 'trial balance',
                               'horses are players', 'VIP caps', 'per-user caps')
                AND h.status <> 'ok') THEN
    RAISE EXCEPTION 'an area this migration is responsible for is not ok: %',
      (SELECT string_agg(h.area || ' [' || h.status || '] ' || h.detail, '; ')
         FROM public.fn_ca_diamond_health() h
        WHERE h.area IN ('rule arming', 'money identity', 'deploy gate', 'trial balance',
                         'horses are players', 'VIP caps', 'per-user caps') AND h.status <> 'ok');
  END IF;
  IF EXISTS (SELECT 1 FROM public.fn_ca_diamond_health() h
              WHERE h.detail IS NULL OR length(h.detail) < 20) THEN
    RAISE EXCEPTION 'the health report returned a row with no usable explanation';
  END IF;
  -- and the coverage row distinguishes a live gap from one that has stopped
  IF NOT EXISTS (SELECT 1 FROM public.fn_ca_diamond_health() h
                  WHERE h.area = 'evaluation coverage'
                    AND (h.status = 'ok' OR h.detail LIKE '%STILL HAPPENING%' OR h.detail LIKE '%appears fixed%')) THEN
    RAISE EXCEPTION 'the coverage row does not say whether the gap is live or stopped';
  END IF;

  -- and nothing moved
  IF (SELECT public.fn_ca_mint_supply('diamonds'))
     <> (SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) + public.fn_ca_diamond_offledger_float() THEN
    RAISE EXCEPTION 'players + float <> register after a change that moves no money';
  END IF;

  -- Count them; do not assert them. An earlier draft of this line said "none critical" as a fixed
  -- string while asserting nothing of the kind - a claim with no reader behind it, in the migration
  -- whose whole subject is claims with no reader behind them.
  RAISE NOTICE 'the flip has a hand; health reports % area(s): % ok, % attention, % critical',
    (SELECT count(*) FROM public.fn_ca_diamond_health()),
    (SELECT count(*) FROM public.fn_ca_diamond_health() h WHERE h.status = 'ok'),
    (SELECT count(*) FROM public.fn_ca_diamond_health() h WHERE h.status = 'attention'),
    (SELECT count(*) FROM public.fn_ca_diamond_health() h WHERE h.status = 'critical');
END $$;

COMMIT;
