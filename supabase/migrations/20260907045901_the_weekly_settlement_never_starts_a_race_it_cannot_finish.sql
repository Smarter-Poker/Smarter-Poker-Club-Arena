-- THE WEEKLY SETTLEMENT NEVER STARTS A RACE IT CANNOT FINISH
-- =============================================================================
-- Three defects found by probing the real settlement path in a transaction that
-- was rolled back (CLAUDE.md 11.5: one call, one DO block, RAISE at the end).
-- Every one of them would have hit the 2026-09-07 07:00 run.
--
-- 1. THE HOURLY MAINTENANCE FREEZE KILLS THE CASCADE MID-FLIGHT.
--    Probing round 2 at 04:55 UTC returned, from zz_freeze_guard:
--      PLATFORM_FROZEN: INSERT on chip_transactions was refused
--    The break announces at :53, freezes :55 to :00, and enforce_freeze was
--    true. Rounds 1 to 3 move chips through fn_debit_treasury, so a cascade
--    still running at :53 dies and rolls back every round it had completed.
--    Section 13 rule 5 already required this gate for any periodic sweep that
--    moves money. The settlement never had it.
--
-- 2. THE DUE RUNNER WOULD REPLAY AN ANCIENT WEEK IF CALLED EARLY.
--    Before the Monday boundary, fn_union_week_start(now()) is still LAST
--    Monday, so fn_union_settlement_cascade_due() called at, say, 05:00 on
--    2026-09-07 would have settled 2026-08-24 to 2026-08-31 - one of the two
--    anomalous frozen weeks carrying 1,242,950.74 of ECO against SHARK CLUB.
--    It now refuses any period that closed more than three days ago.
--
-- 3. fn_union_club_invoice IS REACHABLE WITHOUT AN ACCOUNT.
--    SECURITY DEFINER, EXECUTE held by PUBLIC, and it never calls auth.uid().
--    It runs as the owner, past RLS, and returns every member club's rake,
--    rakeback, player win/loss and amount outstanding to anybody who asks.
--    Caught by check-definer-authorization in .husky/pre-push. Pre-existing;
--    re-declaring it in 20260907044041 is what surfaced it.
--    Verified before revoking: it backs no RLS policy, no view depends on it,
--    and its only caller is pages/api/club-arena/union-invoice.js, which uses
--    the service role key. Club owners read their own statements through
--    ca_club_union_invoices, not this.
--
-- The cron also moves from Monday-only to DAILY at :05. The runner is
-- idempotent and now refuses stale periods, so a Monday that is missed
-- entirely heals on Tuesday instead of waiting a full week - which is the
-- failure mode that hid three unsettled weeks and 2,592,517.16 of rake.
-- :05 rather than :20 buys the whole :00-to-:53 window before the next break.
-- =============================================================================

BEGIN;

-- 1. THE DUE RUNNER, WITH BOTH GUARDS ----------------------------------------

CREATE OR REPLACE FUNCTION public.fn_union_settlement_cascade_due()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_to    timestamptz := public.fn_union_week_start(now());
  v_from  timestamptz := public.fn_union_prev_week_start(now());
  v_total int;
  v_done  int;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_platform_admin())) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  -- GUARD 1: never start a settlement the maintenance break will kill. Rounds
  -- 1 to 3 write chip_transactions, which zz_freeze_guard refuses while the
  -- platform is frozen, and a refusal mid-cascade rolls back the rounds that
  -- had already succeeded. Skipping is free: the runner is idempotent and is
  -- offered another attempt within the hour.
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('success', true, 'skipped', true,
      'reason', 'platform_frozen',
      'period_start', v_from, 'period_end', v_to);
  END IF;

  -- The break announces at :53 and freezes at :55. Anything started after :45
  -- is starting a race it cannot finish.
  IF EXTRACT(minute FROM now()) >= 45 THEN
    RETURN jsonb_build_object('success', true, 'skipped', true,
      'reason', 'too_close_to_maintenance_break',
      'period_start', v_from, 'period_end', v_to);
  END IF;

  -- GUARD 2: settle the week that just closed, never an archived one. Called
  -- before the Monday boundary, v_to is still LAST Monday and the period would
  -- be a week old. Replaying an old period is a decision for a person, not a
  -- side effect of a cron running at the wrong minute.
  IF v_to < now() - interval '3 days' THEN
    RETURN jsonb_build_object('success', true, 'skipped', true,
      'reason', 'period_closed_more_than_three_days_ago',
      'period_start', v_from, 'period_end', v_to, 'now', now());
  END IF;

  SELECT count(*) INTO v_total FROM unions;
  SELECT count(*) INTO v_done
    FROM union_settlement_rounds
   WHERE period_start = v_from AND period_end = v_to AND round_no = 1;

  IF v_total > 0 AND v_done >= v_total THEN
    RETURN jsonb_build_object('success', true, 'skipped', true,
      'reason', 'already_settled', 'period_start', v_from, 'period_end', v_to);
  END IF;

  RETURN public.fn_union_settlement_cascade_all(v_from, v_to);
END $function$;

COMMENT ON FUNCTION public.fn_union_settlement_cascade_due() IS
  'Settles the union week that has just closed, once. Refuses while the platform is frozen, after :45, and for any period that closed more than three days ago. Safe on any schedule; a missed day heals on the next tick.';

-- 2. CLOSE THE ANON SURFACE --------------------------------------------------
-- GRANT and REVOKE do not fire pgrst_ddl_watch, so these are free.

REVOKE ALL ON FUNCTION public.fn_union_club_invoice(uuid, timestamp with time zone, timestamp with time zone)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_club_invoice(uuid, timestamp with time zone, timestamp with time zone)
  TO service_role;

-- The money movers this migration and its predecessor declared. None of them
-- has any business being reachable from a browser.
REVOKE ALL ON FUNCTION public.fn_union_settlement_cascade_due() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_settlement_cascade_due() TO service_role;

REVOKE ALL ON FUNCTION public.fn_union_settlement_cascade_all(timestamp with time zone, timestamp with time zone)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_union_settlement_cascade(uuid, timestamp with time zone, timestamp with time zone)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_union_issue_weekly_invoices(uuid, timestamp with time zone, timestamp with time zone, boolean)
  FROM PUBLIC, anon;

-- 3. DAILY, AT :05 -----------------------------------------------------------

SELECT cron.schedule(
  'union-weekly-rakeback-close',
  '5 7,8,9,10 * * *',
  $cron$
  SET statement_timeout = '600s';
  select case
           when pg_try_advisory_lock(hashtext('union-weekly-rakeback-close'))
             then (select set_config('statement_timeout','600s',true) is not null
                      and public.fn_union_settlement_cascade_due() IS NOT NULL)::text
           else 'skipped: previous run still in progress'
         end;
  $cron$);

-- 4. ASSERTIONS --------------------------------------------------------------

DO $assert$
DECLARE
  v_anon   int;
  v_sched  text;
  v_result jsonb;
BEGIN
  -- anon must not hold EXECUTE on the invoice basis, directly or through PUBLIC.
  SELECT count(*) INTO v_anon
    FROM pg_proc p
   WHERE p.oid = 'public.fn_union_club_invoice(uuid, timestamp with time zone, timestamp with time zone)'::regprocedure
     AND (has_function_privilege('anon', p.oid, 'EXECUTE')
          OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_anon <> 0 THEN
    RAISE EXCEPTION 'fn_union_club_invoice is still executable by anon or authenticated';
  END IF;

  IF NOT has_function_privilege('service_role',
        'public.fn_union_club_invoice(uuid, timestamp with time zone, timestamp with time zone)'::regprocedure,
        'EXECUTE') THEN
    RAISE EXCEPTION 'service_role lost EXECUTE on fn_union_club_invoice; the API route would break';
  END IF;

  SELECT schedule INTO v_sched FROM cron.job WHERE jobname = 'union-weekly-rakeback-close';
  IF v_sched <> '5 7,8,9,10 * * *' THEN
    RAISE EXCEPTION 'close job schedule is %, expected 5 7,8,9,10 * * *', v_sched;
  END IF;

  -- The staleness guard must refuse RIGHT NOW, because the boundary has not
  -- passed yet and the period on offer is a week old. This is the specific
  -- accident it exists to prevent, so assert it rather than trust it.
  IF now() < public.fn_union_week_start(now()) + interval '3 days' THEN
    v_result := public.fn_union_settlement_cascade_due();
    IF COALESCE((v_result->>'skipped')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'cascade_due did not skip a stale period: %', v_result::text;
    END IF;
  END IF;
END
$assert$;

COMMIT;

-- NOTE: the statement_timeout in section 3 above is superseded minutes later by
-- 20260907050337_the_settlement_gets_the_time_it_actually_needs.sql, which
-- raises it to 2400s after measuring round 2 at 668 s. Both are kept as
-- separate migrations because both were applied to production in that order.
