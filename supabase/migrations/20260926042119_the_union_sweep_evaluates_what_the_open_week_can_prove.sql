-- 20260926042119_the_union_sweep_evaluates_what_the_open_week_can_prove
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-26 04:21:19 UTC.
--
-- ===========================================================================
--  THE UNION SWEEP EVALUATES WHAT THE OPEN WEEK CAN PROVE
-- ===========================================================================
--
-- Two money controls ride fn_union_integrity_sweep_all every hour at :35. Both
-- have failed every hour for days, and each failure was filed as a warning in
-- financial_alerts: 202 rows for the stop-loss, 183 for the rake basis, read
-- 2026-09-26 04:03 UTC.
--
-- 1. fn_union_enforce_stop_loss   invalid_closed_pnl_evidence_period
--
--    Read from the bodies, not assumed. The enforcer loops over
--    fn_union_club_exposure(union), which reads
--    fn_union_reconciliation_report(union, week_start, now()), which since
--    20260917234315 asks fn_union_pnl_qualified_clubs ->
--    fn_union_pnl_evidence_report. That report certifies CLOSED weeks only and
--    refuses anything else before it reads a row:
--
--      p_end <> fn_union_week_start(p_start + 8 days) OR p_end > clock_timestamp()
--        -> RAISE 'invalid_closed_pnl_evidence_period'
--
--    now() is never the next week boundary, so the enforcer raised on its very
--    first statement every hour since 2026-09-18 01:35 (and on
--    union_earning_source_historical_week_uncertified for the seven hours
--    before that). 20260918091617 expected it to repair itself on 2026-09-21;
--    it did not, because the refusal is structural, not the cutover.
--
--    What that silenced, read from rows on 2026-09-26: Midway Union has
--    weekly_invoices_enabled = 1 and suspend_after_days_overdue = 7 (the
--    default). MIDWAY-2026-000005 (Club JAQK, 33,222.29) and
--    MIDWAY-2026-000006 (SHARK CLUB, 11,244.03) were due 2026-09-17 07:00 and
--    are outstanding; they passed grace at 2026-09-24 07:00. The non-payment
--    leg of the enforcer reads only settlement_invoices - it never needed the
--    open-week P&L - yet it has not run once since they came due, because the
--    exposure leg threw first. Both clubs' stop_loss_limit is NULL, so the
--    exposure leg can never breach for either of them today.
--
--    What this changes. The two legs are evaluated independently:
--      - non-payment: exactly as before (settlement_invoices, gate, grace);
--      - exposure: asked of fn_union_club_exposure inside its own
--        subtransaction. The open week has no certified P&L, so today it
--        answers 'not_evaluable' with the refusal it received. That is its own
--        named outcome (CLAUDE.md 10.86 rule 1), never folded into "within
--        limit" and never into "breached".
--    A club is suspended when an evaluated leg breaches. A club suspended by
--    this enforcer is restored only when EVERY leg that applies to it was
--    evaluated and is clear: a club with a stop_loss_limit whose exposure
--    could not be evaluated is held exactly as it is, never released on an
--    unknown. When a club carries a limit and its exposure cannot be
--    evaluated, one warning per union per open week says so (deduplicated on
--    the unresolved row), instead of 24 identical failures a day.
--
--    Neither silences a breach nor invents one: the loop is over every club
--    with terms on file (the set the old loop filtered to), the non-payment
--    test is byte-for-byte the old one, and the exposure test is the old one
--    whenever the exposure source can answer.
--
--    CONSEQUENCE, stated before it happens. At the first sweep after this
--    applies, the non-payment leg will find Club JAQK (33,222.29) and SHARK
--    CLUB (11,244.03) unpaid more than 7 days past due and set their
--    union_club_terms status to 'suspended', writing one critical alert each.
--    That is the rule the union configured, silenced since 2026-09-24 07:00.
--    Nothing else reads union_club_terms.status (only fn_union_credit_risk_check
--    and fn_union_club_exposure), no chip moves, and the receivables themselves
--    are not touched; the clubs resume automatically once nothing is past due.
--
-- 2. fn_union_rake_basis_refresh  union_cash_sources_do_not_match_bank:<n>
--
--    fn_accounting_union_earned_plan refuses a window in which any cash rake
--    bank receipt has no accrual batch and earning source yet. Those are
--    written by the rakeback settler, which walks rake_records by a durable
--    cursor (daemon_state.rakeback_settler). Measured 2026-09-26 04:08:56: of
--    89,297 receipts in the open week, 74,078 had no batch, and the first of
--    them was banked at 17:38:25.193 on 09-22 - with the cursor at
--    17:38:25.144. The missing set IS the set above the cursor, to the
--    millisecond. The settler was stuck (fixed by #5269), so the count grew.
--
--    It would not have converged to zero on its own. Before the settler stuck
--    the same refusal already fired on 12 of the 30 hourly runs of 09-21/22
--    with counts of 2 to 272: whatever rake was banked between the settler's
--    last page and :35. A refresh that reads through now() is refused
--    whenever the settler is not idle at exactly that moment. That is a
--    plateau, not convergence.
--
--    What this changes. The snapshot reads through the settler's committed
--    cursor, LEAST(p_end, now(), cursor), and records that instant in
--    `through` (a column the snapshot already carries). Everything below the
--    cursor has been accrued; nothing above it is claimed. When the cursor is
--    unknown, or has not yet reached this week, the function returns a named
--    outcome and writes nothing - it does not guess. No reader of the snapshot
--    exists outside this function today (read from pg_proc and both repos),
--    so nothing downstream changes meaning.
--
-- Nothing here adds a cron, a sweep, a repair or a backfill, moves a chip,
-- widens a timeout, or changes what either function does when its inputs are
-- complete. Both bodies are pinned by md5(prosrc) before replacement.
--
-- Wrap ALL DDL for one change in ONE transaction (production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preimage$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'fn_union_enforce_stop_loss'
                    AND md5(p.prosrc) = 'c12ce662cb03bc3f0f0366285a5a6682') THEN
    RAISE EXCEPTION 'STOP_LOSS_PREIMAGE_CHANGED: fn_union_enforce_stop_loss is not the body this migration replaces';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'fn_union_rake_basis_refresh'
                    AND md5(p.prosrc) = '4d54aabd89a2005489a130b7bf06962a') THEN
    RAISE EXCEPTION 'RAKE_BASIS_REFRESH_PREIMAGE_CHANGED: fn_union_rake_basis_refresh is not the body this migration replaces';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.daemon_state WHERE daemon = 'rakeback_settler') THEN
    RAISE EXCEPTION 'SETTLER_CURSOR_MISSING: daemon_state has no rakeback_settler row to bound the snapshot';
  END IF;
END
$preimage$;

-- ---------------------------------------------------------------------------
-- 1. THE STOP LOSS EVALUATES EACH LEG ON ITS OWN
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_union_enforce_stop_loss(p_union_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r              record;
  v_suspended    int := 0;
  v_restored     int := 0;
  v_held         int := 0;
  v_unevaluated  int := 0;
  v_out          jsonb := '[]'::jsonb;
  v_gate_open    boolean;
  v_grace        int;
  v_overdue      numeric;
  v_reason       text;
  v_week         timestamptz := public.fn_union_week_start(now());
  v_week_key     text;
  v_exposure     jsonb := '{}'::jsonb;
  v_exposure_err text;
  v_x            jsonb;
  v_exp_state    text;
  v_breached     boolean;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_platform_admin())) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  v_gate_open := public.fn_union_setting(p_union_id, 'weekly_invoices_enabled', 1) = 1;
  v_grace     := COALESCE(public.fn_union_setting(p_union_id, 'suspend_after_days_overdue', 7), 7)::int;
  v_week_key  := to_char(v_week AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

  -- The exposure leg, asked once, in its own subtransaction. Its source is the
  -- certified weekly P&L, which certifies closed weeks only; for the open week
  -- it refuses. A refusal is recorded as not_evaluable, never as clear.
  BEGIN
    SELECT COALESCE(jsonb_object_agg(e.club_id::text, jsonb_build_object(
             'exposure', e.exposure, 'breached', e.breached,
             'stop_loss_limit', e.stop_loss_limit, 'presettled', e.presettled,
             'security_deposit', e.security_deposit)), '{}'::jsonb)
      INTO v_exposure
      FROM public.fn_union_club_exposure(p_union_id, v_week) e
     WHERE e.terms_on_file;
  EXCEPTION WHEN OTHERS THEN
    v_exposure := NULL;
    v_exposure_err := SQLERRM;
  END;

  FOR r IN
    SELECT t.club_id, COALESCE(c.name, t.club_id::text)::text AS club_name,
           t.status, t.stop_loss_limit, COALESCE(t.security_deposit, 0) AS security_deposit,
           t.suspended_reason
      FROM public.union_club_terms t
      LEFT JOIN public.clubs c ON c.id = t.club_id
     WHERE t.union_id = p_union_id
     ORDER BY t.club_id
  LOOP
    -- What this club owes on statements that are past due plus grace, net of
    -- credit notes. Only counted while the union is actually issuing statements.
    SELECT COALESCE(SUM(public.fn_union_invoice_outstanding(si.id)), 0)
      INTO v_overdue
      FROM settlement_invoices si
     WHERE si.invoice_type = 'union_weekly_squareup'
       AND si.club_id = r.club_id
       AND (si.breakdown->>'union_id')::uuid = p_union_id
       AND si.status = 'overdue'
       AND si.due_at < now() - make_interval(days => v_grace);

    v_x := CASE WHEN v_exposure IS NULL THEN NULL ELSE v_exposure -> r.club_id::text END;
    v_breached := NULL;
    IF r.stop_loss_limit IS NULL THEN
      v_exp_state := 'no_limit';
      v_breached := false;
    ELSIF v_exposure IS NULL THEN
      v_exp_state := 'not_evaluable';
    ELSIF v_x IS NULL THEN
      -- The exposure source answered and has no row for this club: nothing
      -- to carry this week. The old enforcer skipped such a club entirely.
      v_exp_state := 'evaluated';
      v_breached := false;
    ELSE
      v_exp_state := 'evaluated';
      v_breached := COALESCE((v_x->>'breached')::boolean, false);
    END IF;

    v_reason := NULL;
    IF v_breached THEN
      v_reason := 'stop_loss_breached: exposure '
                  || to_char((v_x->>'exposure')::numeric, 'FM999,999,999,990.00')
                  || ' over limit ' || to_char(r.stop_loss_limit, 'FM999,999,999,990.00');
    ELSIF v_gate_open AND v_overdue > 0.005 THEN
      v_reason := 'stop_loss_breached: ' || to_char(v_overdue, 'FM999,999,999,990.00')
                  || ' unpaid more than ' || v_grace || ' days past due';
    END IF;

    IF v_exp_state = 'not_evaluable' THEN
      v_unevaluated := v_unevaluated + 1;
    END IF;

    IF v_reason IS NOT NULL AND r.status = 'active' THEN
      UPDATE union_club_terms t
         SET status = 'suspended', suspended_at = now(),
             suspended_reason = v_reason, updated_at = now()
       WHERE t.union_id = p_union_id AND t.club_id = r.club_id;

      INSERT INTO financial_alerts (source, severity, message, context)
      VALUES ('fn_union_enforce_stop_loss', 'critical',
              r.club_name || ' suspended: ' || v_reason
              || '. It resumes automatically once the position is back inside the limit '
              || 'and nothing is past due.',
              jsonb_build_object('union_id', p_union_id, 'club_id', r.club_id,
                                 'club_name', r.club_name,
                                 'exposure', v_x->'exposure',
                                 'exposure_state', v_exp_state,
                                 'stop_loss_limit', r.stop_loss_limit,
                                 'overdue_past_grace', v_overdue,
                                 'security_deposit', r.security_deposit,
                                 'presettled', v_x->'presettled'));
      v_suspended := v_suspended + 1;
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'club_id', r.club_id, 'club_name', r.club_name, 'action', 'suspended',
        'reason', v_reason, 'exposure_state', v_exp_state));

    ELSIF v_reason IS NULL AND r.status = 'suspended'
          AND COALESCE(r.suspended_reason, '') LIKE 'stop_loss_breached:%' THEN
      -- Released only when every leg that applies was evaluated and is clear.
      IF v_exp_state = 'not_evaluable' THEN
        v_held := v_held + 1;
        v_out := v_out || jsonb_build_array(jsonb_build_object(
          'club_id', r.club_id, 'club_name', r.club_name, 'action', 'held',
          'reason', 'exposure_not_evaluable', 'exposure_state', v_exp_state));
      ELSE
        UPDATE union_club_terms t
           SET status = 'active', suspended_at = NULL, suspended_reason = NULL, updated_at = now()
         WHERE t.union_id = p_union_id AND t.club_id = r.club_id
           AND t.suspended_reason LIKE 'stop_loss_breached:%';
        IF FOUND THEN
          v_restored := v_restored + 1;
          v_out := v_out || jsonb_build_array(jsonb_build_object(
            'club_id', r.club_id, 'club_name', r.club_name, 'action', 'restored',
            'exposure_state', v_exp_state));
        END IF;
      END IF;
    END IF;
  END LOOP;

  -- "I could not tell" has a reader: one warning per union per open week while
  -- any club carrying a limit cannot have its exposure evaluated.
  IF v_unevaluated > 0 AND NOT EXISTS (
       SELECT 1 FROM financial_alerts f
        WHERE f.source = 'fn_union_enforce_stop_loss' AND NOT COALESCE(f.resolved, false)
          AND f.context->>'outcome' = 'exposure_not_evaluable'
          AND f.context->>'union_id' = p_union_id::text
          AND f.context->>'week_start' = v_week_key) THEN
    INSERT INTO financial_alerts (source, severity, message, context)
    VALUES ('fn_union_enforce_stop_loss', 'warning',
            'Stop-loss exposure could not be evaluated for ' || v_unevaluated
            || ' club(s) with a limit on file: the open week has no certified position. '
            || 'Non-payment was still enforced; no club was released on an unknown.',
            jsonb_build_object('union_id', p_union_id, 'outcome', 'exposure_not_evaluable',
                               'week_start', v_week_key,
                               'clubs', v_unevaluated, 'error', v_exposure_err));
  END IF;

  RETURN jsonb_build_object('union_id', p_union_id,
    'suspended', v_suspended, 'restored', v_restored, 'held', v_held,
    'dunning_gated', NOT v_gate_open,
    'exposure_evaluated', v_exposure IS NOT NULL,
    'exposure_error', v_exposure_err,
    'exposure_not_evaluable_clubs', v_unevaluated,
    'detail', v_out, 'ran_at', now());
END $function$;

COMMENT ON FUNCTION public.fn_union_enforce_stop_loss(uuid) IS
  'Suspends a union club on an evaluated breach (exposure over its limit, or statements unpaid past grace). The two legs are evaluated independently; an exposure that cannot be evaluated is reported as not_evaluable and never releases a suspended club. 20260926042119.';

-- ---------------------------------------------------------------------------
-- 2. THE OPEN-WEEK SNAPSHOT READS THROUGH THE ACCRUAL CURSOR
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_union_rake_basis_refresh(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_through timestamptz; v_t0 timestamptz := clock_timestamp(); v_detail jsonb; v_n int;
  v_accrued timestamptz;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR NOT public.fn_is_platform_admin()) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;
  IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR p_end <= p_start THEN
    RETURN jsonb_build_object('success', false, 'error', 'bad_params');
  END IF;
  IF LEAST(p_end, now()) <= p_start THEN
    RETURN jsonb_build_object('success', false, 'error', 'window_not_open_yet');
  END IF;

  -- Cash earning sources are written by the rakeback settler as its durable
  -- cursor advances; every bank receipt below the cursor has been accrued and
  -- none above it is claimed. Read through that instant, never through now().
  SELECT d.high_water_mark INTO v_accrued FROM public.daemon_state d WHERE d.daemon = 'rakeback_settler';
  IF v_accrued IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'accrual_cursor_unknown');
  END IF;
  v_through := LEAST(p_end, now(), v_accrued);
  IF v_through <= p_start THEN
    RETURN jsonb_build_object('success', false, 'error', 'accrual_not_yet_in_window',
                              'accrued_through', v_accrued);
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('club_id', b.club_id, 'game_type', b.game_type,
                                               'rake_in', b.rake_in, 'rate', b.rate, 'payout', b.payout)
                            ORDER BY b.club_id, b.game_type), '[]'::jsonb), count(*)
    INTO v_detail, v_n
    FROM public.fn_union_club_rake_basis(p_union_id, p_start, v_through, true) b;

  INSERT INTO public.union_rake_basis_snapshot (union_id, period_start, period_end, through, computed_at, compute_ms, detail)
  VALUES (p_union_id, p_start, p_end, v_through, now(),
          (extract(epoch from clock_timestamp() - v_t0) * 1000)::int, v_detail)
  ON CONFLICT (union_id, period_start, period_end) DO UPDATE
    SET through = EXCLUDED.through, computed_at = EXCLUDED.computed_at,
        compute_ms = EXCLUDED.compute_ms, detail = EXCLUDED.detail;

  RETURN jsonb_build_object('success', true, 'union_id', p_union_id, 'period_start', p_start,
                            'period_end', p_end, 'through', v_through, 'rows', v_n,
                            'accrued_through', v_accrued,
                            'compute_ms', (extract(epoch from clock_timestamp() - v_t0) * 1000)::int);
END;
$function$;

COMMENT ON FUNCTION public.fn_union_rake_basis_refresh(uuid, timestamptz, timestamptz) IS
  'Snapshots the open-week union rake basis through LEAST(period end, now(), the rakeback settler''s committed cursor), so it never claims rake the accrual has not reached. 20260926042119.';

-- ---------------------------------------------------------------------------
-- POSTIMAGE. The installed bodies are the ones above and no grant widened.
-- ---------------------------------------------------------------------------
DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.fn_union_enforce_stop_loss(uuid)'::regprocedure
                  AND prosrc LIKE '%exposure_not_evaluable%' AND prosecdef) THEN
    RAISE EXCEPTION 'STOP_LOSS_POSTIMAGE: replacement not installed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.fn_union_rake_basis_refresh(uuid,timestamptz,timestamptz)'::regprocedure
                  AND prosrc LIKE '%accrual_cursor_unknown%' AND prosecdef) THEN
    RAISE EXCEPTION 'RAKE_BASIS_POSTIMAGE: replacement not installed';
  END IF;
  IF has_function_privilege('anon', 'public.fn_union_enforce_stop_loss(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_union_enforce_stop_loss(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_union_rake_basis_refresh(uuid,timestamptz,timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_union_rake_basis_refresh(uuid,timestamptz,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'GRANTS_WIDENED: a browser role can execute a union money control';
  END IF;
END
$post$;

COMMIT;
