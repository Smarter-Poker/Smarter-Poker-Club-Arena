-- A health report cannot certify comparisons that its source could not make.
DO $guard$
BEGIN
  IF to_regprocedure('public.fn_ca_diamond_health()') IS NULL
     OR md5(pg_get_functiondef('public.fn_ca_diamond_health()'::regprocedure))
        NOT IN ('84752474901fcc22302dae65fe42dbb6','3ed2ac4e441befea2072b3c3e941b37e') THEN
    RAISE EXCEPTION 'diamond health reader changed; requalify its current definition';
  END IF;
  IF to_regprocedure('public.fn_ca_diamond_trial_balance(timestamptz)') IS NULL
     OR md5(pg_get_functiondef('public.fn_ca_diamond_trial_balance(timestamptz)'::regprocedure))
        <> '52bc0ea036ad5dcbc2662376c2dfefff' THEN
    RAISE EXCEPTION 'trial balance contract changed; requalify the reconciling accounts';
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_health()
 RETURNS TABLE(area text, status text, detail text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_n bigint; v_h bigint; v_m numeric; v_t text; v_e text;
  v_trial_rows bigint; v_trial_accounts bigint; v_trial_unknown bigint;
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
           - ((SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) + public.fn_ca_diamond_offledger_float()
             + (SELECT COALESCE(sum(balance),0) FROM public.ca_diamond_house));
    RETURN QUERY SELECT 'money identity'::text,
      CASE WHEN v_m = 0 THEN 'ok' ELSE 'critical' END,
      CASE WHEN v_m = 0 THEN 'players + house + custody = register, exactly.'
           ELSE 'players + house + custody differs from the register by ' || v_m || '.' END;
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
    -- These five rows are the reconciling accounts in the trial-balance contract.
    -- NULL differences on informational rows (for example arena_wallets) are expected.
    -- Missing, duplicated, or unknown reconciling rows cannot prove a clean reading.
    SELECT count(*) FILTER (WHERE x.difference IS NOT NULL AND x.difference <> 0),
           count(*) FILTER (WHERE x.account IN ('player_diamonds','fixture_accounts','diamond_house','register','total')),
           count(DISTINCT x.account) FILTER (WHERE x.account IN ('player_diamonds','fixture_accounts','diamond_house','register','total')),
           count(*) FILTER (WHERE x.account IN ('player_diamonds','fixture_accounts','diamond_house','register','total') AND x.difference IS NULL)
      INTO v_n, v_trial_rows, v_trial_accounts, v_trial_unknown
      FROM public.fn_ca_diamond_trial_balance() x;
    RETURN QUERY SELECT 'trial balance'::text,
      CASE WHEN v_n > 0 THEN 'critical'
           WHEN v_trial_rows <> 5 OR v_trial_accounts <> 5 OR v_trial_unknown > 0 THEN 'unknown'
           ELSE 'ok' END,
      CASE WHEN v_n > 0 THEN v_n || ' account(s) do not reconcile.'
           WHEN v_trial_rows <> 5 OR v_trial_accounts <> 5 OR v_trial_unknown > 0
             THEN 'Trial balance is incomplete: require one known comparison for each of the five reconciling accounts.'
           ELSE 'Every reconciling account balances against the journal.' END;
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
END $function$
;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_health() TO service_role;

