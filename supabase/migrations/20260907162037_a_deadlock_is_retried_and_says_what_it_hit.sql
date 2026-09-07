-- A DEADLOCK IS RETRIED, AND SAYS WHAT IT HIT
-- =============================================================================
-- PHASE 1 of 8.
--
-- The 2026-09-07 settlement failed FOUR times - 07:05, 08:05, 09:05, 10:05 -
-- every one of them with 'deadlock detected', and the money for the week
-- 2026-08-31 to 2026-09-07 has still not moved. The alerting added in
-- 20260907044041 is the only reason anybody knows: cron logged four
-- 'succeeded' runs, because the job's SQL returns a row whether the settlement
-- worked or not.
--
-- TWO DEFECTS, both mine.
--
-- 1. NOTHING RETRIES. A deadlock is the one error class that is retryable BY
--    DEFINITION: Postgres picks a victim precisely so the other transaction can
--    proceed, and the victim is expected to try again. fn_union_settlement_
--    cascade_all caught it, counted it as a failure, and gave up for the hour.
--
--    Locks taken inside a PL/pgSQL BEGIN...EXCEPTION block are released when
--    that subtransaction aborts, so a retry inside the same outer transaction
--    is meaningful rather than an instant re-collision.
--
-- 2. THE ALERT ONLY CARRIED SQLERRM. 'deadlock detected' names no relation, no
--    statement and no other process, so four failures produced no information
--    about WHAT the settlement collided with. GET STACKED DIAGNOSTICS gives
--    RETURNED_SQLSTATE, PG_EXCEPTION_DETAIL (which for a deadlock names both
--    processes and the relations they were waiting on) and PG_EXCEPTION_CONTEXT
--    (the statement). All three are captured now, on every failure path.
--
-- WHAT IT COLLIDES WITH, for whoever reads the next alert: round 2 stamps
-- settled_at on ~2.1M agent_commissions rows over ~668 s while
-- credit_agent_commission_from_rake inserts into the same table continuously
-- (~390k rows/day), and fn_settle_tournament_rake deadlocked 51 separate times
-- today on the same family of tables. Retrying treats the symptom. Phase 7
-- removes the 2.1M-row write entirely, which removes the collision surface.
--
-- RETRY BUDGET. Three attempts, backoff 3s, 7s. Each attempt re-checks the two
-- guards that make a settlement safe to start at all - the platform freeze and
-- the :45 cutoff before the maintenance break - so a retry can never push the
-- job into the window where zz_freeze_guard would refuse its treasury writes.
--
-- SCHEDULE. The close job moves from four fixed hours to :05 and :35 of every
-- hour. It is idempotent and returns 'already_settled' in milliseconds once the
-- week is done, so extra ticks cost nothing and a failed attempt now heals in
-- thirty minutes instead of a day. Both minutes sit safely outside :53-:00.
--
-- TESTED, in a transaction that was rolled back:
--   retry loop      succeeded on attempt 3 after 2 retries, sqlstate 40P01
--   cascade_all     success=false, unions_failed=1
--   diagnostics     sqlstate=P0001, retryable=false, attempts=1 (a
--                   non-retryable error correctly consumed no retries)
--   context         captured, 298 chars
--   alerting        one critical row written
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_union_settlement_cascade_all(
  p_period_start timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_period_end timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_union   record;
  v_one     jsonb;
  v_results jsonb := '[]'::jsonb;
  v_unions  int := 0;
  v_failed  int := 0;
  v_retries int := 0;
  v_from    timestamptz := COALESCE(p_period_start, public.fn_union_prev_week_start(now()));
  v_to      timestamptz := COALESCE(p_period_end,   public.fn_union_week_start(now()));
  v_r1 numeric := 0; v_r2 numeric := 0; v_r3 numeric := 0;
  v_attempt  int;
  v_sqlstate text; v_msg text; v_detail text; v_context text;
  v_max_attempts constant int := 3;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_platform_admin())) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  FOR v_union IN SELECT u.id FROM unions u LOOP
    v_attempt := 0;

    <<attempts>>
    LOOP
      v_attempt := v_attempt + 1;
      BEGIN
        v_one := public.fn_union_settlement_cascade(v_union.id, v_from, v_to);
        IF v_attempt > 1 THEN
          v_one := v_one || jsonb_build_object('attempts', v_attempt);
        END IF;
        EXIT attempts;

      EXCEPTION
        WHEN deadlock_detected OR serialization_failure THEN
          GET STACKED DIAGNOSTICS
            v_sqlstate = RETURNED_SQLSTATE,
            v_msg      = MESSAGE_TEXT,
            v_detail   = PG_EXCEPTION_DETAIL,
            v_context  = PG_EXCEPTION_CONTEXT;

          -- Out of attempts, or no longer safe to start another one.
          IF v_attempt >= v_max_attempts
             OR public.fn_platform_frozen()
             OR EXTRACT(minute FROM now()) >= 45 THEN
            v_one := jsonb_build_object(
              'union_id', v_union.id, 'success', false,
              'error', v_msg, 'sqlstate', v_sqlstate, 'retryable', true,
              'attempts', v_attempt,
              'gave_up_because',
                CASE WHEN v_attempt >= v_max_attempts THEN 'attempts_exhausted'
                     WHEN public.fn_platform_frozen() THEN 'platform_frozen'
                     ELSE 'too_close_to_maintenance_break' END,
              'exception_detail', v_detail,
              'exception_context', v_context);
            EXIT attempts;
          END IF;

          v_retries := v_retries + 1;
          PERFORM pg_sleep(CASE v_attempt WHEN 1 THEN 3 ELSE 7 END);

        WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS
            v_sqlstate = RETURNED_SQLSTATE,
            v_msg      = MESSAGE_TEXT,
            v_detail   = PG_EXCEPTION_DETAIL,
            v_context  = PG_EXCEPTION_CONTEXT;
          v_one := jsonb_build_object(
            'union_id', v_union.id, 'success', false,
            'error', v_msg, 'sqlstate', v_sqlstate, 'retryable', false,
            'attempts', v_attempt,
            'exception_detail', v_detail,
            'exception_context', v_context);
          EXIT attempts;
      END;
    END LOOP attempts;

    IF COALESCE((v_one->>'success')::boolean, false) THEN
      v_unions := v_unions + 1;
      v_r1 := v_r1 + COALESCE((v_one->'round1_union_to_clubs'->>'total_rakeback')::numeric, 0);
      v_r2 := v_r2 + COALESCE((v_one->'round2_club_to_agents'->>'amount')::numeric, 0);
      v_r3 := v_r3 + COALESCE((v_one->'round3_agents_to_players'->>'amount')::numeric, 0);
    ELSE
      v_failed := v_failed + 1;
    END IF;
    v_results := v_results || jsonb_build_array(v_one);
  END LOOP;

  IF v_failed > 0 THEN
    INSERT INTO financial_alerts (source, severity, message, context)
    VALUES ('fn_union_settlement_cascade_all', 'critical',
            v_failed || ' of ' || (v_failed + v_unions) ||
            ' unions failed weekly settlement for ' ||
            to_char(v_from, 'YYYY-MM-DD') || ' to ' || to_char(v_to, 'YYYY-MM-DD') ||
            '. No rakeback moved and no invoices issued for those unions.' ||
            CASE WHEN v_retries > 0 THEN ' Retried ' || v_retries || ' time(s).' ELSE '' END,
            jsonb_build_object('period_start', v_from, 'period_end', v_to,
                               'unions_failed', v_failed, 'unions_settled', v_unions,
                               'retries', v_retries,
                               'detail', v_results));
  END IF;

  RETURN jsonb_build_object(
    'success', (v_failed = 0),
    'unions_settled', v_unions,
    'unions_failed', v_failed,
    'retries', v_retries,
    'period_start', v_from,
    'period_end', v_to,
    'round1_union_to_clubs', v_r1,
    'round2_club_to_agents', v_r2,
    'round3_agents_to_players', v_r3,
    'ran_at', now(),
    'detail', v_results
  );
END $function$;

-- The cascade's own round-4 handler kept only SQLERRM too.
CREATE OR REPLACE FUNCTION public.fn_union_settlement_cascade(
  p_union_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001'::uuid,
  p_period_start timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_period_end timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_from timestamptz := COALESCE(p_period_start, public.fn_union_prev_week_start(now()));
  v_to   timestamptz := COALESCE(p_period_end,   public.fn_union_week_start(now()));
  v_r1 jsonb; v_r2 jsonb; v_r3 jsonb; v_eco jsonb; v_inv jsonb;
  v_sqlstate text; v_msg text; v_detail text; v_context text;
BEGIN
  IF EXISTS (SELECT 1 FROM settlement_locks WHERE lock_type = 'GLOBAL_SETTLEMENT_FREEZE' AND is_active = true) THEN
    RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK';
  END IF;

  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_union_overseer(p_union_id, auth.uid()))) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  v_r1 := public.fn_union_weekly_rakeback_close(p_union_id, v_from, v_to);
  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payers, payees, amount, detail)
  VALUES (p_union_id, v_from, v_to, 1, 'union_to_clubs', 1,
          COALESCE((v_r1->>'clubs_paid')::int,0),
          COALESCE((v_r1->>'total_rakeback')::numeric,0), v_r1)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO NOTHING;

  v_r2 := public.fn_settle_round2_club_to_agents(p_union_id, v_from, v_to);
  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payees, amount, shortfalls, detail)
  VALUES (p_union_id, v_from, v_to, 2, 'club_to_agents',
          COALESCE((v_r2->>'payees')::int,0), COALESCE((v_r2->>'amount')::numeric,0),
          COALESCE((v_r2->>'shortfalls')::int,0), v_r2)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO NOTHING;

  v_r3 := public.fn_settle_round3_agents_to_players(p_union_id, v_from, v_to);
  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payees, amount, shortfalls, detail)
  VALUES (p_union_id, v_from, v_to, 3, 'agents_to_players',
          COALESCE((v_r3->>'payees')::int,0), COALESCE((v_r3->>'amount')::numeric,0),
          COALESCE((v_r3->>'shortfalls')::int,0), v_r3)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO NOTHING;

  IF public.fn_union_eco_enabled(p_union_id) THEN
    BEGIN
      v_eco := public.fn_union_eco_record(p_union_id, v_from, v_to, NULL);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT,
                              v_detail = PG_EXCEPTION_DETAIL, v_context = PG_EXCEPTION_CONTEXT;
      v_eco := jsonb_build_object('success', false, 'error', v_msg, 'sqlstate', v_sqlstate,
                                  'exception_detail', v_detail, 'exception_context', v_context);
    END;
  ELSE
    v_eco := jsonb_build_object('skipped', true, 'reason', 'eco_disabled');
  END IF;

  IF public.fn_union_setting(p_union_id, 'weekly_invoices_enabled', 1) <> 1 THEN
    v_inv := jsonb_build_object(
      'success', true, 'skipped', true, 'invoices', 0,
      'reason', 'weekly_invoices_disabled: invoice rake basis '
                || '(fn_union_rake_paid_readonly, first-joined club) disagrees with the '
                || 'basis round 1 pays on (ca_union_rake_attribution, seat played). '
                || 'Money moved; statement held pending reconciliation.');
  ELSE
    BEGIN
      v_inv := public.fn_union_issue_weekly_invoices(p_union_id, v_from, v_to, true);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT,
                              v_detail = PG_EXCEPTION_DETAIL, v_context = PG_EXCEPTION_CONTEXT;
      v_inv := jsonb_build_object('success', false, 'error', v_msg, 'sqlstate', v_sqlstate,
                                  'exception_detail', v_detail, 'exception_context', v_context);
    END;
  END IF;

  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payees, amount, detail)
  VALUES (p_union_id, v_from, v_to, 4, 'union_invoices_issued',
          COALESCE((v_inv->>'invoices')::int, 0), 0, v_inv)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO NOTHING;

  IF COALESCE((v_inv->>'success')::boolean, false) IS NOT TRUE THEN
    RETURN jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'round4_invoices_failed: ' || COALESCE(v_inv->>'error','unknown'),
      'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
      'round3_agents_to_players', v_r3, 'eco_recorded', v_eco,
      'round4_invoices', v_inv);
  END IF;

  RETURN jsonb_build_object('success', true, 'union_id', p_union_id,
    'period_start', v_from, 'period_end', v_to,
    'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
    'round3_agents_to_players', v_r3, 'eco_recorded', v_eco,
    'round4_invoices', v_inv);
END $function$;

-- Twice an hour, both minutes safely outside the :53-:00 maintenance window.
SELECT cron.schedule(
  'union-weekly-rakeback-close',
  '5,35 * * * *',
  $cron$
  SET statement_timeout = '2400s';
  select case
           when pg_try_advisory_lock(hashtext('union-weekly-rakeback-close'))
             then (select set_config('statement_timeout','2400s',true) is not null
                      and public.fn_union_settlement_cascade_due() IS NOT NULL)::text
           else 'skipped: previous run still in progress'
         end;
  $cron$);

DO $assert$
DECLARE v_src text; v_sched text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname='fn_union_settlement_cascade_all' AND pronamespace='public'::regnamespace;

  IF v_src NOT LIKE '%deadlock_detected OR serialization_failure%' THEN
    RAISE EXCEPTION 'cascade_all does not catch the retryable error classes';
  END IF;
  IF v_src NOT LIKE '%PG_EXCEPTION_DETAIL%' OR v_src NOT LIKE '%PG_EXCEPTION_CONTEXT%'
     OR v_src NOT LIKE '%RETURNED_SQLSTATE%' THEN
    RAISE EXCEPTION 'cascade_all does not capture full diagnostics';
  END IF;
  IF v_src NOT LIKE '%fn_platform_frozen%' OR v_src NOT LIKE '%EXTRACT(minute FROM now()) >= 45%' THEN
    RAISE EXCEPTION 'the retry loop does not re-check the freeze and break guards';
  END IF;
  IF v_src NOT LIKE '%''success'', (v_failed = 0)%' THEN
    RAISE EXCEPTION 'cascade_all stopped reporting failure honestly';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname='fn_union_settlement_cascade' AND pronamespace='public'::regnamespace;
  IF v_src NOT LIKE '%PG_EXCEPTION_CONTEXT%' THEN
    RAISE EXCEPTION 'the cascade round-4 handler still keeps only SQLERRM';
  END IF;
  IF v_src NOT LIKE '%fn_union_weekly_rakeback_close%'
     OR v_src NOT LIKE '%fn_settle_round2_club_to_agents%'
     OR v_src NOT LIKE '%fn_settle_round3_agents_to_players%'
     OR v_src NOT LIKE '%weekly_invoices_enabled%' THEN
    RAISE EXCEPTION 'a round or the invoice gate went missing from the cascade';
  END IF;

  SELECT schedule INTO v_sched FROM cron.job WHERE jobname='union-weekly-rakeback-close';
  IF v_sched <> '5,35 * * * *' THEN
    RAISE EXCEPTION 'close job schedule is %, expected 5,35 * * * *', v_sched;
  END IF;
END
$assert$;

COMMIT;
