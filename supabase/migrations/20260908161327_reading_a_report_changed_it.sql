-- 20260908161327_reading_a_report_changed_it.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- APPLIED TO PRODUCTION 2026-09-08 via the us-west-2 session pooler; this file is
-- the record of what ran, and is registered in supabase_migrations.schema_migrations.

-- READING THE HEALTH REPORT CHANGED THE THING IT WAS REPORTING ON.
-- (CLAUDE.md 10.86, 13; ruling 3; docs/changelog/2026-09-08-reading-a-report-changed-it.md)
--
-- An adversarial review of this afternoon's work found thirteen items. **The most expensive one is
-- not a defect**, and establishing that first is the point of this header.
--
-- IT REPORTED 4,674 HORSE REWARDS WORTH 159,275 DIAMONDS EXPIRED UNCLAIMED, and recommended
-- settling them as the same defect fixed at 15:29. The rows are real. Measured against the humans:
-- 29 rows and 772 diamonds expired the same way, so horses lost 206 times more. That looks exactly
-- like the 10.5 disparity settled earlier today.
--
-- **It is Ruling 3, already applied, and the arithmetic proves it.** Dan's ruling reads: "The
-- 897,095 completed before the standard expire under the same 7-day rule: no clawback, NO
-- RETROACTIVE MINT INTO IDLE WALLETS, humans and horses treated alike." Amendment 2 records the
-- backlog expiring at apply time as **4,703 rows**. The review's own counts are 4,674 horse + 29
-- human = **4,703 exactly**. Same rows, same sweep, one written decision already covering them.
-- Paying them would violate a ruling, and "horses lost 206x more" is not evidence of unequal
-- treatment here - it is 972 horses against 5 humans holding stale rows when one rule expired both.
--
-- The one real gap in that finding is recorded below: the decision lives in a markdown file, and
-- somebody querying the database finds 159,275 diamonds gone with nothing beside them saying why.
--
-- THE ELEVEN THAT ARE REAL. Five are mine from this afternoon, and every one is the same shape.
--
-- 1. **READING THE REPORT WROTE TO THE DATABASE.** `fn_ca_diamond_health()` is declared STABLE and
--    calls `fn_ca_diamond_snapshot()`, which is VOLATILE and INSERTs. Its own `deploy gate` area
--    reports "unexplained since the last snapshot" - so reading the report advanced the baseline it
--    was about to measure against. Measured: 25 snapshots in eight hours, only 8 on the hourly
--    cadence; one timestamp appears 7 times (this migration's own assertion block calling health
--    seven times inside one transaction). The hourly series the deploy gate depends on was
--    destroyed by the instrument built to watch it. It reads the stored row now.
--
-- 2. **THE CLAIM SWEEP MOVED MONEY DURING THE MAINTENANCE FREEZE.** CLAUDE.md 13 rule 5: a periodic
--    sweep that moves money checks the freeze. `fn_ca_horse_claim_due` did not, and the Postgres
--    backstop does not cover it either - `zz_freeze_guard` is on chip_ledger, chip_transactions,
--    club_members, clubs, table_seats, tournaments, tournament_players, wallets and
--    wallet_transactions, and **neither `profiles` nor `diamond_transactions` is among them**. It
--    fires five more times inside a :55-:00 break. Latent only because `engine_maintenance_break`
--    is empty today, which is the worst kind of safe.
--
-- 3. **A CAPPED HORSE REWARD WOULD DIE SILENTLY, AND THE HEALTH ROW WOULD GO GREEN AS IT DIED.**
--    Three things compose. The sweep deliberately does not file when the message matches
--    `DR7:user_over_daily_cap` - correct, a thousand horses meet the cap daily. The health `horse
--    claims` area counts only `expired_at IS NULL`, so the moment the nightly job stamps a row it
--    leaves the count. So after DR7 arms on 2026-09-14: seven days of amber, then green at the
--    instant the diamonds are lost. **The number that must never be non-zero is rewards that
--    expired unclaimed, and nothing was watching it.** It is an area now, and the sweep reports how
--    many it could not pay instead of returning a bare count.
--
-- 4. **THE FOURTH GATE WAS INERT.** `since_config` counts incidents since the rule's configuration
--    changed, and `zz_touch_updated_at` fires on ANY column - so editing a `note` resets the
--    window. For DR7 the epoch is the newest of ALL FOURTEEN cap rows, so touching the `wheel` cap
--    erases DR7's evidence. Live: DR7 shows would_refuse 4,553 over seven days and since_config 0,
--    on a 43-minute window. The gate passed for three rules holding 7,471 pending refusals. It
--    gates on `would_refuse` now, and a window younger than the evidence period returns `unknown`
--    rather than a clean zero.
--
-- 5. **THE ADVISORY LOCK COULD LEAK, AND "DID NOT RUN" READ AS "NOTHING OWED".**
--    `EXCEPTION WHEN OTHERS` does not trap `query_canceled`, so a statement timeout skipped the
--    unlock; under pg_cron the backend exits, but service_role also holds EXECUTE and a pooled
--    backend does not. `pg_try_advisory_xact_lock` has no unlock path to miss. And `RETURN 0` for
--    "could not get the lock" was byte-identical to "nothing was owed" (10.86 rule 1).
--
-- 6-11 are smaller and are commented where they occur: per-area failure isolation and an `unknown`
-- status in health; cron liveness read from `job_run_details` rather than from `active` alone; the
-- forecast's OVERDUE branch ordered above "probably fixed already"; the stale comment the earlier
-- regex surgery left behind describing a claim that is no longer there; `fn_ca_normalise_claim_loop`
-- revoked from PUBLIC/anon/authenticated; the append-only trigger extended to TRUNCATE; and the
-- liveness beacon registered so the forecast stops reporting it as a retired rule.
--
-- One transaction.

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

-- ---------------------------------------------------------------------------
-- 0. The Ruling 3 write-off becomes findable in the database, not only in a doc.
-- ---------------------------------------------------------------------------
-- 10.9 requires the record to be part of the fix. The DECISION exists and is Dan's; what did not
-- exist was anything a person querying the database would find beside 159,275 missing diamonds.
-- This is not a settlement and pays nobody - it is the explanation, filed where people look.
DO $$
DECLARE v_rows bigint; v_horses bigint; v_humans bigint; v_players bigint; v_diamonds numeric;
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_diamond_incidents WHERE rule = 'DR0:ruling_3_backlog_expired') THEN
    RETURN;
  END IF;
  SELECT count(*), count(*) FILTER (WHERE p.is_horse),
         count(*) FILTER (WHERE NOT COALESCE(p.is_horse, false)),
         count(DISTINCT u.user_id), COALESCE(sum(u.diamond_reward_snapshot), 0)
    INTO v_rows, v_horses, v_humans, v_players, v_diamonds
    FROM public.user_daily_challenges u
    JOIN public.profiles p ON p.id = u.user_id
   WHERE u.expired_at IS NOT NULL AND NOT u.claimed
     AND u.expired_at < '2026-09-08 12:00:00+00';
  IF v_rows = 0 THEN RETURN; END IF;

  PERFORM public.fn_ca_diamond_incident(
    'DR0:ruling_3_backlog_expired', 'info', NULL, v_diamonds,
    'ruling 3 / amendment 2 (migration 20260908024742)',
    jsonb_build_object(
      'rows', v_rows, 'players', v_players, 'diamonds', v_diamonds,
      'horses', v_horses, 'humans', v_humans,
      'decision', 'Ruling 3 (Dan): completed-unclaimed challenges older than seven days expire, '
                  || 'no clawback, no retroactive mint into idle wallets, humans and horses treated '
                  || 'alike. These are that backlog and they are NOT owed. An adversarial review on '
                  || '2026-09-08 proposed settling them as a 10.5 disparity; the counts match '
                  || 'amendment 2 exactly (4674 horse + 29 human = 4703 rows), so they are the '
                  || 'ruling being applied, not a defect. Do not pay them.'));
  RAISE NOTICE 'recorded the Ruling 3 write-off: % rows, % diamonds, % horses, % humans',
    v_rows, v_diamonds, v_horses, v_humans;
END $$;

-- ---------------------------------------------------------------------------
-- 5 + 2 + 3: the claim sweep.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.fn_ca_horse_claim_due(integer);

CREATE OR REPLACE FUNCTION public.fn_ca_horse_claim_due(p_limit integer DEFAULT 500)
RETURNS TABLE (claimed integer, capped integer, failed integer, ran boolean)
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE r record; v_claimed integer := 0; v_capped integer := 0; v_failed integer := 0; v_msg text;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'fn_ca_horse_claim_due: service_role required';
  END IF;

  -- THE PLATFORM FREEZE (CLAUDE.md 13 rule 5). This moves money every minute, and profiles and
  -- diamond_transactions are NOT among the tables zz_freeze_guard protects - so nothing else would
  -- have stopped it crediting inside a :55-:00 break.
  IF public.fn_platform_frozen() THEN
    RETURN QUERY SELECT 0, 0, 0, false;
    RETURN;
  END IF;

  -- xact-scoped: released at commit or rollback, with no unlock path to miss. The session-scoped
  -- form skipped its unlock on a statement timeout, because EXCEPTION WHEN OTHERS does not trap
  -- query_canceled - harmless under pg_cron (the backend exits) and a permanent leak from a pooled
  -- service_role backend, which also holds EXECUTE on this.
  IF NOT pg_try_advisory_xact_lock(hashtext('ca_horse_claim_due')) THEN
    -- `ran = false` and not a zero count: "another run holds the lock" and "nothing was owed" are
    -- different answers and must not share a representation (CLAUDE.md 10.86 rule 1).
    RETURN QUERY SELECT 0, 0, 0, false;
    RETURN;
  END IF;

  FOR r IN
    SELECT u.id, u.user_id
      FROM public.user_daily_challenges u
      JOIN public.profiles p ON p.id = u.user_id AND p.is_horse
     WHERE u.completed AND NOT u.claimed AND u.expired_at IS NULL
       AND u.completed_at >= now() - interval '7 days'
     ORDER BY u.completed_at, u.id
     LIMIT GREATEST(COALESCE(p_limit, 500), 1)
  LOOP
    BEGIN
      PERFORM public.claim_daily_challenge_serialized_body(r.user_id, r.id, NULL);
      v_claimed := v_claimed + 1;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      IF v_msg LIKE '%DR7:user_over_daily_cap%' THEN
        -- COUNTED, NOT FILED. A thousand horses meet the cap daily so an incident would be an
        -- always-on alarm, but returning it means the caller can see a run that paid nothing
        -- because everything was capped - which after DR7 arms is the difference between a
        -- backlog draining and a backlog dying.
        v_capped := v_capped + 1;
      ELSE
        v_failed := v_failed + 1;
        BEGIN
          PERFORM public.fn_ca_diamond_incident(
            'CH3:horse_claim_failed', 'warning', r.user_id, NULL, 'fn_ca_horse_claim_due',
            jsonb_build_object('challenge_row_id', r.id, 'sqlerrm', v_msg));
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
      END IF;
    END;
  END LOOP;

  RETURN QUERY SELECT v_claimed, v_capped, v_failed, true;
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_horse_claim_due(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_horse_claim_due(integer) TO service_role;

COMMENT ON FUNCTION public.fn_ca_horse_claim_due(integer) IS
  'A horse has no browser, so this presses its claim button - keyed to who is OWED, not to who just acted. Not a repair job (CLAUDE.md 10.12): it IS the button, the same legitimate horse branch as scheduleHorseAction. Returns (claimed, capped, failed, ran): ran=false means the freeze is on or another run holds the lock, which is not the same answer as nothing being owed.';

SELECT cron.unschedule('ca-horse-claim-due-minute')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-horse-claim-due-minute');
SELECT cron.schedule('ca-horse-claim-due-minute', '* * * * *',
                     $cron$SELECT public.fn_ca_horse_claim_due(500)$cron$);

-- ---------------------------------------------------------------------------
-- 4 + 9: the flip gate and the forecast's branch order.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_rule_flip_due(p_dry_run boolean DEFAULT false)
RETURNS TABLE (rule text, action text, detail text)
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE r record; v_msg text; v_fc record; v_armed int := 0; v_blocked int := 0; v_n bigint;
        v_window integer;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'fn_ca_diamond_rule_flip_due: service_role required';
  END IF;

  FOR r IN SELECT m.rule AS rl, m.flip_after, m.clean_days_required
             FROM public.ca_diamond_rule_modes m
            WHERE m.mode = 'log' ORDER BY m.flip_after, m.rule
  LOOP
    v_window := GREATEST(24, r.clean_days_required * 24);
    SELECT * INTO v_fc FROM public.fn_ca_diamond_flip_forecast(v_window) f WHERE f.rule = r.rl;

    IF v_fc IS NULL THEN
      v_blocked := v_blocked + 1;
      RETURN QUERY SELECT r.rl, 'unknown'::text,
        'the forecast does not cover this rule, so nothing can say what arming it would do'::text;
      CONTINUE;
    END IF;

    -- GATE ON would_refuse, NOT ON since_config.
    --
    -- since_config was the gate and it was inert. zz_touch_updated_at fires on ANY column, so
    -- editing a note resets the epoch; and for DR7 the epoch is the newest of all fourteen cap
    -- rows, so touching the `wheel` cap erased DR7's evidence. Measured 2026-09-08: DR7 showed
    -- would_refuse 4,553 over seven days and since_config 0 on a 43-minute window, and the gate
    -- passed. A window younger than the evidence period is UNKNOWN, never clean.
    IF v_fc.config_at IS NOT NULL
       AND v_fc.config_at > now() - make_interval(days => r.clean_days_required) THEN
      v_blocked := v_blocked + 1;
      RETURN QUERY SELECT r.rl, 'unknown'::text,
        format('its configuration changed %s ago, less than the %s clean days required, so the '
               || 'evidence window is too short to judge (%s refusals in the last %s hours)',
               to_char(now() - v_fc.config_at, 'DD"d" HH24"h"'), r.clean_days_required,
               v_fc.would_refuse, v_window);
      CONTINUE;
    END IF;

    IF v_fc.would_refuse > 0 THEN
      v_blocked := v_blocked + 1;
      RETURN QUERY SELECT r.rl, 'blocked'::text,
        format('would refuse %s movement(s) affecting %s player(s) in the last %s hours',
               v_fc.would_refuse, v_fc.players_hit, v_window);
      CONTINUE;
    END IF;

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

    IF p_dry_run THEN
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
      RETURN QUERY SELECT r.rl, 'blocked'::text, v_msg;
    END;
  END LOOP;

  -- THE BEACON ONLY ON A REAL RUN. It was filed on every call, and fn_ca_diamond_health calls this
  -- as a dry run - so reading the report wrote 19 beacon rows against 1 scheduled run, and the
  -- signal that a scheduler is alive became a signal that somebody opened a report.
  IF NOT p_dry_run THEN
    BEGIN
      PERFORM public.fn_ca_diamond_incident(
        'DR0:rule_flip_sweep', 'info', NULL, NULL, 'fn_ca_diamond_rule_flip_due',
        jsonb_build_object('armed', v_armed, 'blocked', v_blocked));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_diamond_rule_flip_due(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_rule_flip_due(boolean) TO service_role;

-- 9 + 13: two corrections to the forecast, in one rewrite.
--
-- (a) OVERDUE outranks "probably fixed already". A rule past its arming date that would refuse
--     thousands must not read as probably-fixed because it happened to be quiet for three hours.
--
-- (b) A BEACON IS NOT A RETIRED RULE. `DR0:rule_flip_sweep` is the liveness signal saying the flip
--     sweep ran; it has no mode and no arming date, so the retired-rule query - which reports any
--     incident whose rule is absent from ca_diamond_rule_modes - classified the liveness beacon as
--     "RETIRED RULE, 19 incident(s)... nothing acts on them". The signal that a scheduler is alive
--     appeared in its own report as noise to ignore. Registering it as a rule was the wrong fix:
--     `flip_after` is NOT NULL, so it would have needed a fake arming date, and the flip sweep
--     would then loop over its own beacon. `DR0:` is the beacon namespace and is excluded.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_diamond_flip_forecast';
  v_new := v_def;

  IF position('WHEN max(i.occurred_at) < now() - interval ''3 hours'' THEN' IN v_new) = 0 THEN
    RAISE EXCEPTION 'the probably-fixed branch was not found in the forecast';
  END IF;
  IF position('WHEN c.fa <= now() THEN' IN v_new) = 0 THEN
    RAISE EXCEPTION 'the overdue branch was not found in the forecast';
  END IF;
  IF position('WHEN c.fa <= now() THEN' IN v_new) > position('WHEN max(i.occurred_at) < now() - interval ''3 hours'' THEN' IN v_new) THEN
    v_new := replace(v_new,
      'WHEN max(i.occurred_at) < now() - interval ''3 hours'' THEN',
      'WHEN c.fa IS NOT NULL AND c.fa <= now() THEN '
      || '''OVERDUE AND LOUD. Its date has passed, it is still logging, and it would refuse '' '
      || '|| count(i.id) || '' movement(s) affecting '' || count(DISTINCT i.user_id) || '' player(s).'' '
      || 'WHEN max(i.occurred_at) < now() - interval ''3 hours'' THEN');
  END IF;

  IF position('AND NOT EXISTS (SELECT 1 FROM public.ca_diamond_rule_modes m WHERE m.rule = x.rule)' IN v_new) = 0 THEN
    RAISE EXCEPTION 'the retired-rule query was not found in the forecast';
  END IF;
  v_new := replace(v_new,
    'AND NOT EXISTS (SELECT 1 FROM public.ca_diamond_rule_modes m WHERE m.rule = x.rule)',
    'AND x.rule NOT LIKE ''DR0:%''' || chr(10)
    || '     AND NOT EXISTS (SELECT 1 FROM public.ca_diamond_rule_modes m WHERE m.rule = x.rule)');

  IF v_new = v_def THEN
    RAISE NOTICE 'the forecast already carries both corrections';
  ELSE
    EXECUTE v_new;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1 + 3 + 7 + 8: the health report reads, isolates, and knows when it cannot tell.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_health()
RETURNS TABLE (area text, status text, detail text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_n bigint; v_h bigint; v_m numeric; v_t text; v_e text;
BEGIN
  IF COALESCE(auth.role(), 'service_role') <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required';
  END IF;

  -- EVERY AREA IS WRAPPED. The previous version called eight external functions with no handler,
  -- so one raise anywhere returned ZERO ROWS rather than twelve answers and one unknown - a report
  -- that vanishes rather than admitting what it could not read (CLAUDE.md 10.86 rule 1).

  -- A JOB IS NOT ALIVE BECAUSE IT IS SCHEDULED. This read cron.job.active alone, so a job failing
  -- on every run for a week reported ok. Same shape as 10.84's "a rule is not live because it
  -- merged". It reads job_run_details now.
  BEGIN
    SELECT count(*) FILTER (WHERE d.status = 'succeeded' AND d.end_time >= now() - interval '25 hours')
      INTO v_n
      FROM cron.job j LEFT JOIN cron.job_run_details d ON d.jobid = j.jobid
     WHERE j.jobname = 'ca-diamond-rule-flip-daily' AND j.active;
    RETURN QUERY SELECT 'rule arming'::text,
      CASE WHEN NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-diamond-rule-flip-daily' AND active)
             THEN 'critical'
           WHEN v_n > 0 THEN 'ok' ELSE 'attention' END,
      CASE WHEN NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-diamond-rule-flip-daily' AND active)
             THEN 'NOTHING ARMS THE RULES. Every flip_after date will pass unremarked.'
           WHEN v_n > 0 THEN 'ca-diamond-rule-flip-daily is scheduled and has succeeded in the last 25 hours.'
           ELSE 'ca-diamond-rule-flip-daily is scheduled but has not succeeded in 25 hours. '
                || 'Scheduled is not running.' END;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_e = MESSAGE_TEXT;
    RETURN QUERY SELECT 'rule arming'::text, 'unknown'::text, 'could not be read: ' || v_e;
  END;

  BEGIN
    SELECT count(*) FILTER (WHERE d.status = 'succeeded' AND d.end_time >= now() - interval '10 minutes')
      INTO v_n
      FROM cron.job j LEFT JOIN cron.job_run_details d ON d.jobid = j.jobid
     WHERE j.jobname = 'ca-horse-claim-due-minute' AND j.active;
    RETURN QUERY SELECT 'horse claim button'::text,
      CASE WHEN NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-horse-claim-due-minute' AND active)
             THEN 'critical'
           WHEN v_n > 0 THEN 'ok' ELSE 'critical' END,
      CASE WHEN NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-horse-claim-due-minute' AND active)
             THEN 'NOTHING PRESSES A HORSE''S CLAIM BUTTON. Every horse reward will expire unclaimed.'
           WHEN v_n > 0 THEN 'ca-horse-claim-due-minute has succeeded ' || v_n || ' time(s) in ten minutes.'
           ELSE 'ca-horse-claim-due-minute is scheduled but has not succeeded in ten minutes, and it '
                || 'runs every minute. Horse rewards are accumulating toward expiry.' END;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_e = MESSAGE_TEXT;
    RETURN QUERY SELECT 'horse claim button'::text, 'unknown'::text, 'could not be read: ' || v_e;
  END;

  -- THE NUMBER THAT MUST NEVER BE NON-ZERO, and nothing was watching it. A reward that expires
  -- unclaimed leaves the `horse claims` count, so that area would have gone GREEN at the exact
  -- moment the diamonds were lost.
  --
  -- IT EXCLUDES RULING 3's BACKLOG BY REFERENCE, NOT BY A DATE. 4,703 rows (4,674 horse + 29 human,
  -- 159,275 diamonds) expired at 2026-09-08 03:11 under Dan's ruling - "no retroactive mint into
  -- idle wallets, humans and horses treated alike" - and they are NOT owed. A plain 36-hour window
  -- flagged them as a critical defect the moment this area was written, which is how a new alarm
  -- teaches people to ignore it on day one. The bound reads the recorded write-off's own timestamp,
  -- so it needs no magic date and retires itself once the window moves past it.
  BEGIN
    SELECT count(*) FILTER (WHERE p.is_horse), COALESCE(sum(u.diamond_reward_snapshot) FILTER (WHERE p.is_horse), 0)
      INTO v_h, v_m
      FROM public.user_daily_challenges u JOIN public.profiles p ON p.id = u.user_id
     WHERE u.expired_at IS NOT NULL AND NOT u.claimed
       AND u.expired_at >= now() - interval '36 hours'
       AND u.expired_at > COALESCE((SELECT max(i.occurred_at) FROM public.ca_diamond_incidents i
                                     WHERE i.rule = 'DR0:ruling_3_backlog_expired'), '-infinity'::timestamptz);
    RETURN QUERY SELECT 'rewards lost to expiry'::text,
      CASE WHEN v_h = 0 THEN 'ok' ELSE 'critical' END,
      CASE WHEN v_h = 0 THEN 'No horse reward expired unclaimed in the last 36 hours.'
           ELSE v_h || ' horse reward(s) worth ' || v_m || ' diamonds expired UNCLAIMED in the last '
                || '36 hours. Something was owed and nothing paid it before the clock ran out.' END;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_e = MESSAGE_TEXT;
    RETURN QUERY SELECT 'rewards lost to expiry'::text, 'unknown'::text, 'could not be read: ' || v_e;
  END;

  BEGIN
    SELECT count(*) FILTER (WHERE p.is_horse), count(*) FILTER (WHERE NOT COALESCE(p.is_horse, false))
      INTO v_h, v_n
      FROM public.user_daily_challenges u JOIN public.profiles p ON p.id = u.user_id
     WHERE u.completed AND NOT u.claimed AND u.expired_at IS NULL
       AND u.completed_at >= now() - interval '7 days'
       AND u.completed_at < now() - interval '5 minutes';
    RETURN QUERY SELECT 'horse claims'::text,
      CASE WHEN v_h = 0 THEN 'ok' WHEN v_h < 50 THEN 'attention' ELSE 'critical' END,
      CASE WHEN v_h = 0
           THEN 'No horse is owed a reward it cannot claim. ' || v_n || ' human reward(s) are '
                || 'unclaimed, which is a person choosing not to press a button, not a defect.'
           ELSE v_h || ' horse reward(s) are owed past the sweep interval; nothing but '
                || 'fn_ca_horse_claim_due presses a horse''s button.' END;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_e = MESSAGE_TEXT;
    RETURN QUERY SELECT 'horse claims'::text, 'unknown'::text, 'could not be read: ' || v_e;
  END;

  BEGIN
    SELECT count(*) INTO v_n FROM public.fn_ca_diamond_rule_flip_due(true) x
      JOIN public.ca_diamond_rule_modes m ON m.rule = x.rule
     WHERE x.action IN ('blocked', 'unknown') AND m.flip_after IS NOT NULL AND m.flip_after <= now();
    RETURN QUERY SELECT 'rules overdue'::text,
      CASE WHEN v_n = 0 THEN 'ok' ELSE 'attention' END,
      CASE WHEN v_n = 0 THEN 'No rule is past its arming date and still stuck.'
           ELSE v_n || ' rule(s) are past their arming date and cannot arm; read '
                || 'fn_ca_diamond_rule_flip_due(true) for each reason.' END;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_e = MESSAGE_TEXT;
    RETURN QUERY SELECT 'rules overdue'::text, 'unknown'::text, 'could not be read: ' || v_e;
  END;

  BEGIN
    v_m := (SELECT public.fn_ca_mint_supply('diamonds'))
           - ((SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) + public.fn_ca_diamond_offledger_float());
    RETURN QUERY SELECT 'money identity'::text,
      CASE WHEN v_m = 0 THEN 'ok' ELSE 'critical' END,
      CASE WHEN v_m = 0 THEN 'players + float = register, exactly.'
           ELSE 'players + float differs from the register by ' || v_m || '.' END;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_e = MESSAGE_TEXT;
    RETURN QUERY SELECT 'money identity'::text, 'unknown'::text, 'could not be read: ' || v_e;
  END;

  -- READS THE STORED SNAPSHOT; NEVER TAKES ONE. fn_ca_diamond_snapshot() is VOLATILE and INSERTs,
  -- so the previous version advanced the baseline it was reporting against - 25 snapshots in eight
  -- hours where 8 belonged to the hourly cron, one timestamp repeated seven times. The instrument
  -- destroyed the series it existed to read, and STABLE was a lie.
  BEGIN
    SELECT s.unexplained, s.taken_at::text INTO v_m, v_t
      FROM public.ca_diamond_snapshots s ORDER BY s.taken_at DESC LIMIT 1;
    RETURN QUERY SELECT 'deploy gate'::text,
      CASE WHEN v_t IS NULL THEN 'unknown'
           WHEN v_t::timestamptz < now() - interval '3 hours' THEN 'attention'
           WHEN COALESCE(v_m, -1) = 0 THEN 'ok' ELSE 'critical' END,
      CASE WHEN v_t IS NULL THEN 'no snapshot has ever been taken; ca-diamond-snapshot-hourly may not be running'
           WHEN v_t::timestamptz < now() - interval '3 hours'
             THEN 'the newest snapshot is from ' || v_t || ', over three hours old - the hourly job is not running'
           WHEN COALESCE(v_m, -1) = 0 THEN 'The snapshot at ' || v_t || ' explains every movement.'
           ELSE COALESCE(v_m::text, 'NULL') || ' unexplained at the snapshot taken ' || v_t || '.' END;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_e = MESSAGE_TEXT;
    RETURN QUERY SELECT 'deploy gate'::text, 'unknown'::text, 'could not be read: ' || v_e;
  END;

  BEGIN
    SELECT count(*) INTO v_n FROM public.fn_ca_diamond_trial_balance() x
     WHERE x.difference IS NOT NULL AND x.difference <> 0;
    RETURN QUERY SELECT 'trial balance'::text,
      CASE WHEN v_n = 0 THEN 'ok' ELSE 'critical' END,
      CASE WHEN v_n = 0 THEN 'Every reconciling account balances against the journal.'
           ELSE v_n || ' account(s) do not reconcile.' END;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_e = MESSAGE_TEXT;
    RETURN QUERY SELECT 'trial balance'::text, 'unknown'::text, 'could not be read: ' || v_e;
  END;

  BEGIN
    SELECT COALESCE(sum(x.would_refuse), 0) INTO v_n FROM public.fn_ca_diamond_cap_headroom(14) x;
    RETURN QUERY SELECT 'per-user caps'::text,
      CASE WHEN v_n = 0 THEN 'ok' ELSE 'attention' END,
      CASE WHEN v_n = 0 THEN 'No real user-day in fourteen days exceeds the cap that applies to it.'
           ELSE v_n || ' user-day(s) exceed the cap that applies to them.' END;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_e = MESSAGE_TEXT;
    RETURN QUERY SELECT 'per-user caps'::text, 'unknown'::text, 'could not be read: ' || v_e;
  END;

  BEGIN
    SELECT count(*) INTO v_n FROM public.diamond_engine_daily_caps
     WHERE max_per_user_per_day_vip IS NOT NULL AND max_per_user_per_day IS NOT NULL
       AND max_per_user_per_day_vip < max_per_user_per_day;
    RETURN QUERY SELECT 'VIP caps'::text,
      CASE WHEN v_n = 0 THEN 'ok' ELSE 'attention' END,
      CASE WHEN v_n = 0 THEN 'No cap gives a VIP less than a standard player receives.'
           ELSE v_n || ' cap(s) make VIP a downgrade.' END;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_e = MESSAGE_TEXT;
    RETURN QUERY SELECT 'VIP caps'::text, 'unknown'::text, 'could not be read: ' || v_e;
  END;

  BEGIN
    SELECT count(*) INTO v_n FROM public.profiles p
     WHERE p.is_horse AND (public.fn_ca_is_cert_account(p.id) OR public.fn_ca_is_fixture_account(p.id));
    RETURN QUERY SELECT 'horses are players'::text,
      CASE WHEN v_n = 0 THEN 'ok' ELSE 'critical' END,
      CASE WHEN v_n = 0 THEN 'No horse is classified as test equipment.'
           ELSE v_n || ' horse(s) read as harness equipment.' END;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_e = MESSAGE_TEXT;
    RETURN QUERY SELECT 'horses are players'::text, 'unknown'::text, 'could not be read: ' || v_e;
  END;

  BEGIN
    SELECT count(*) INTO v_n FROM public.fn_ca_diamond_budget_reality() x
     WHERE x.verdict LIKE 'ALREADY OVER%' OR x.verdict LIKE 'FUTURE PLAN BELOW%' OR x.verdict LIKE 'BUDGETED ZERO%';
    RETURN QUERY SELECT 'budget plans'::text,
      CASE WHEN v_n = 0 THEN 'ok' ELSE 'attention' END,
      CASE WHEN v_n = 0 THEN 'Every reward budget is plausible against actual issuance.'
           ELSE v_n || ' budget line(s) are fiction. They refuse nobody (ruling 21); setting them is Dan''s.' END;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_e = MESSAGE_TEXT;
    RETURN QUERY SELECT 'budget plans'::text, 'unknown'::text, 'could not be read: ' || v_e;
  END;

  BEGIN
    SELECT count(*) INTO v_n FROM public.fn_ca_diamond_unreachable_money();
    RETURN QUERY SELECT 'unreachable money'::text,
      CASE WHEN v_n = 0 THEN 'ok' ELSE 'attention' END,
      CASE WHEN v_n = 0 THEN 'No diamonds are stranded where nothing can reach them.'
           ELSE v_n || ' finding(s); read fn_ca_diamond_unreachable_money().' END;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_e = MESSAGE_TEXT;
    RETURN QUERY SELECT 'unreachable money'::text, 'unknown'::text, 'could not be read: ' || v_e;
  END;

  BEGIN
    SELECT count(*), max(i.occurred_at)::text INTO v_n, v_t
      FROM public.ca_diamond_incidents i
     WHERE i.rule = 'DR7:ledger_write_failed' AND i.occurred_at >= now() - interval '24 hours';
    RETURN QUERY SELECT 'evaluation coverage'::text,
      CASE WHEN COALESCE(v_n, 0) = 0 THEN 'ok'
           WHEN v_t::timestamptz >= now() - interval '1 hour' THEN 'critical'
           ELSE 'attention' END,
      CASE WHEN COALESCE(v_n, 0) = 0
           THEN 'Every award in the last 24 hours was evaluated by the rules.'
           WHEN v_t::timestamptz >= now() - interval '1 hour'
           THEN v_n || ' award(s) could not be evaluated and it is STILL HAPPENING (most recent '
                || to_char(now() - v_t::timestamptz, 'HH24:MI') || ' ago).'
           ELSE v_n || ' award(s) could not be evaluated in 24 hours, but none for '
                || to_char(now() - v_t::timestamptz, 'HH24:MI') || '; the cause appears fixed.' END;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_e = MESSAGE_TEXT;
    RETURN QUERY SELECT 'evaluation coverage'::text, 'unknown'::text, 'could not be read: ' || v_e;
  END;
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_diamond_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_health() TO service_role;

-- ---------------------------------------------------------------------------
-- 10, 11, 12: the small ones.
-- ---------------------------------------------------------------------------
-- 10: the regex surgery anchored on the IF and left the paragraph above it, which still describes
-- the claim happening "in the transaction that completed the challenge". Stale text teaches the
-- next agent (CLAUDE.md 10.7).
DO $$
DECLARE v_oid oid; v_def text; v_new text; v_n integer := 0;
BEGIN
  FOR v_oid IN
    SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname LIKE 'record_daily_challenge_event%'
       AND strpos(p.prosrc, 'through the SAME claim') > 0
  LOOP
    v_def := pg_get_functiondef(v_oid);
    v_new := regexp_replace(v_def,
      '\n[ \t]*--[^\n]*(A horse is a player|through the SAME claim|a human''s click reaches|THIS IS THE PATH THE ENGINE CALLS|completed_at = now\(\) names|claim that fails is filed)[^\n]*', '', 'g');
    IF v_new <> v_def THEN EXECUTE v_new; v_n := v_n + 1; END IF;
  END LOOP;
  RAISE NOTICE 'cleared the stale claim commentary from % function(s)', v_n;
END $$;

-- 11: every other function in this programme is service_role only.
REVOKE ALL ON FUNCTION public.fn_ca_normalise_claim_loop(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_normalise_claim_loop(text) TO service_role;

-- 12: a row trigger does not see TRUNCATE.
DROP TRIGGER IF EXISTS zz_engine_spend_no_truncate ON public.ca_diamond_engine_spend;
CREATE TRIGGER zz_engine_spend_no_truncate
  BEFORE TRUNCATE ON public.ca_diamond_engine_spend
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_engine_spend_append_only();

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_n bigint; v_before bigint; v_after bigint; v_r record;
BEGIN
  -- 1. reading health takes no snapshot
  SELECT count(*) INTO v_before FROM public.ca_diamond_snapshots;
  PERFORM count(*) FROM public.fn_ca_diamond_health();
  PERFORM count(*) FROM public.fn_ca_diamond_health();
  SELECT count(*) INTO v_after FROM public.ca_diamond_snapshots;
  IF v_after <> v_before THEN
    RAISE EXCEPTION 'reading the health report still writes snapshots (% -> %)', v_before, v_after;
  END IF;
  -- and it no longer writes a beacon either
  SELECT count(*) INTO v_before FROM public.ca_diamond_incidents WHERE rule = 'DR0:rule_flip_sweep';
  PERFORM count(*) FROM public.fn_ca_diamond_rule_flip_due(true);
  SELECT count(*) INTO v_after FROM public.ca_diamond_incidents WHERE rule = 'DR0:rule_flip_sweep';
  IF v_after <> v_before THEN
    RAISE EXCEPTION 'a dry run still files the liveness beacon';
  END IF;

  -- 2. the sweep checks the freeze
  IF (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'fn_ca_horse_claim_due') NOT LIKE '%fn_platform_frozen%' THEN
    RAISE EXCEPTION 'the claim sweep still moves money without checking the maintenance freeze';
  END IF;

  -- 5. it distinguishes "did not run" from "nothing owed", and still pays
  SELECT * INTO v_r FROM public.fn_ca_horse_claim_due(500);
  IF v_r.ran IS NOT TRUE THEN
    RAISE EXCEPTION 'the sweep reported it did not run outside a freeze';
  END IF;
  IF (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'fn_ca_horse_claim_due') NOT LIKE '%pg_try_advisory_xact_lock%' THEN
    RAISE EXCEPTION 'the sweep still uses a session lock it can fail to release';
  END IF;

  -- 3. the number that must never be non-zero has an area, and Ruling 3 does not colour it
  IF NOT EXISTS (SELECT 1 FROM public.fn_ca_diamond_health() h WHERE h.area = 'rewards lost to expiry') THEN
    RAISE EXCEPTION 'nothing watches rewards that expire unclaimed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.fn_ca_diamond_health() h
                  WHERE h.area = 'rewards lost to expiry' AND h.status = 'ok') THEN
    RAISE EXCEPTION 'the expiry area is not ok, or Ruling 3''s backlog is colouring it: %',
      (SELECT h.detail FROM public.fn_ca_diamond_health() h WHERE h.area = 'rewards lost to expiry');
  END IF;

  -- 4. the flip gate reads would_refuse and calls a reset window unknown
  IF EXISTS (SELECT 1 FROM public.fn_ca_diamond_rule_flip_due(true) x
              WHERE x.rule = 'DR7:user_over_daily_cap' AND x.action = 'would-arm') THEN
    RAISE EXCEPTION 'the cap rule would arm despite thousands of refusals in its window';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.fn_ca_diamond_rule_flip_due(true) x WHERE x.action = 'unknown') THEN
    RAISE NOTICE 'no rule currently reports unknown; the branch exists but is unexercised';
  END IF;

  -- 7. every area answers, and none is missing
  SELECT count(*) INTO v_n FROM public.fn_ca_diamond_health();
  IF v_n < 14 THEN RAISE EXCEPTION 'the health report covers only % areas', v_n; END IF;
  IF EXISTS (SELECT 1 FROM public.fn_ca_diamond_health() h
              WHERE h.status NOT IN ('ok', 'attention', 'critical', 'unknown')) THEN
    RAISE EXCEPTION 'the health report returned a status outside its four';
  END IF;
  IF EXISTS (SELECT 1 FROM public.fn_ca_diamond_health() h WHERE h.status = 'unknown') THEN
    RAISE EXCEPTION 'an area could not be read: %',
      (SELECT string_agg(h.area || ' - ' || h.detail, '; ') FROM public.fn_ca_diamond_health() h WHERE h.status = 'unknown');
  END IF;

  -- 11: the normaliser is not public
  IF has_function_privilege('authenticated', 'public.fn_ca_normalise_claim_loop(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the normaliser is still executable by authenticated';
  END IF;

  -- 0: the Ruling 3 write-off is findable in the database
  IF NOT EXISTS (SELECT 1 FROM public.ca_diamond_incidents WHERE rule = 'DR0:ruling_3_backlog_expired') THEN
    RAISE EXCEPTION 'the Ruling 3 write-off is still recorded only in a markdown file';
  END IF;

  -- and the money still adds up
  IF (SELECT public.fn_ca_mint_supply('diamonds'))
     <> (SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) + public.fn_ca_diamond_offledger_float() THEN
    RAISE EXCEPTION 'players + float <> register';
  END IF;

  RAISE NOTICE 'health: % areas, % ok, % attention, % critical, % unknown',
    (SELECT count(*) FROM public.fn_ca_diamond_health()),
    (SELECT count(*) FROM public.fn_ca_diamond_health() h WHERE h.status = 'ok'),
    (SELECT count(*) FROM public.fn_ca_diamond_health() h WHERE h.status = 'attention'),
    (SELECT count(*) FROM public.fn_ca_diamond_health() h WHERE h.status = 'critical'),
    (SELECT count(*) FROM public.fn_ca_diamond_health() h WHERE h.status = 'unknown');
END $$;

COMMIT;
