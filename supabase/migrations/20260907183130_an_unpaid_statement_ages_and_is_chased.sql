-- AN UNPAID STATEMENT AGES, AND IS CHASED
-- =============================================================================
-- PHASE 4 of 8: collections.
--
-- settlement_invoices.status has allowed 'overdue' since long before any of
-- this, and NOTHING has ever set it. due_at has been written correctly on every
-- statement - period_end plus three days, which since the Pacific boundary
-- lands at midnight Wednesday night, exactly the "settle by end of Wednesday in
-- the union's time zone" charter these unions publish - and then nothing ever
-- looked at it again. A statement went out, the date passed, and the platform
-- had no opinion about it.
--
-- Right now that is 228,146.79 sitting 18.8 days past due across two clubs,
-- both delivered, neither chased, neither marked.
--
-- WHAT THIS ADDS
--
--   fn_union_age_invoices   marks a delivered, club-owed, uncredited statement
--                           'overdue' once due_at has passed, and chases it on
--                           an escalating schedule.
--
-- THE CLOCK STOPS FOR A DISPUTE. A disputed statement never ages and is never
-- chased - you do not send a reminder about a bill the club has formally
-- contested. Phase 3 built the dispute path; this is what makes it worth
-- entering.
--
-- CREDIT NOTES COUNT. Overdue is judged on what is actually still owed:
-- net_amount minus every credit note against it. A statement credited to zero
-- is settled, not overdue.
--
-- ESCALATION, configurable per union through unions.settings with these
-- defaults: a first reminder on the due date, a second at 3 days, a third at 7,
-- and past that a critical alert rather than a fourth message. Nobody is
-- helped by a nightly nag. At most ONE message per run: a statement 18 days
-- overdue jumps straight to the final level instead of firing three reminders
-- in a row.
--
-- DUNNING RESPECTS THE INVOICE GATE. 20260907053223 held statements for Midway
-- Union because the invoice's rake basis disagrees with the basis round 1 pays
-- on. Chasing a bill whose issuing is paused would be indefensible, so
-- reminders and overdue-driven suspension both check the same
-- weekly_invoices_enabled setting. Marking a statement overdue is internal
-- bookkeeping and still happens - it is simply true - but nothing is sent and
-- nobody is suspended over it while the gate is closed.
--
-- AND IT FEEDS THE STOP LOSS. Phase 2 built enforcement that suspends a club
-- whose exposure passes its limit, and the published charter suspends on
-- non-payment too. fn_union_enforce_stop_loss now also suspends a club with a
-- statement past due plus grace - where the union has terms on file to suspend
-- against, and where the gate is open.
-- =============================================================================

BEGIN;

ALTER TABLE public.settlement_invoices
  ADD COLUMN IF NOT EXISTS overdue_at       timestamptz,
  ADD COLUMN IF NOT EXISTS reminders_sent   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reminder_at timestamptz;

CREATE INDEX IF NOT EXISTS settlement_invoices_due_open_idx
  ON public.settlement_invoices (due_at)
  WHERE invoice_type = 'union_weekly_squareup' AND status IN ('generated','overdue');

-- WHAT IS STILL OWED ON A STATEMENT, net of every credit note against it.
CREATE OR REPLACE FUNCTION public.fn_union_invoice_outstanding(p_invoice_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT round(si.net_amount - COALESCE((
           SELECT SUM(cn.net_amount) FROM settlement_invoices cn
            WHERE cn.adjusts_invoice_id = si.id
              AND cn.invoice_type = 'union_weekly_credit_note'), 0), 2)
    FROM settlement_invoices si WHERE si.id = p_invoice_id;
$function$;

REVOKE ALL ON FUNCTION public.fn_union_invoice_outstanding(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_invoice_outstanding(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_union_age_invoices(p_union_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r            record;
  v_gate_open  boolean;
  v_d1 int; v_d2 int; v_d3 int;
  v_days       numeric;
  v_level_due  int;
  v_marked     int := 0;
  v_reminded   int := 0;
  v_escalated  int := 0;
  v_owed_total numeric := 0;
  v_union_name text;
  v_body       text;
  v_msg        jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_platform_admin())) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  v_gate_open := public.fn_union_setting(p_union_id, 'weekly_invoices_enabled', 1) = 1;
  v_d1 := COALESCE(public.fn_union_setting(p_union_id, 'dunning_days_1', 0), 0)::int;
  v_d2 := COALESCE(public.fn_union_setting(p_union_id, 'dunning_days_2', 3), 3)::int;
  v_d3 := COALESCE(public.fn_union_setting(p_union_id, 'dunning_days_3', 7), 7)::int;
  SELECT u.name INTO v_union_name FROM unions u WHERE u.id = p_union_id;

  FOR r IN
    SELECT si.id, si.invoice_number, si.club_id, si.due_at, si.status,
           si.reminders_sent, si.breakdown->>'club_name' AS club_name,
           public.fn_union_invoice_outstanding(si.id) AS outstanding
      FROM settlement_invoices si
     WHERE si.invoice_type = 'union_weekly_squareup'
       AND (si.breakdown->>'union_id')::uuid = p_union_id
       AND si.status IN ('generated','overdue')     -- never a disputed, paid or cancelled one
       AND si.from_entity_type = 'club'             -- only what the CLUB owes
       AND si.due_at IS NOT NULL
       AND si.due_at < now()
     ORDER BY si.due_at
  LOOP
    CONTINUE WHEN COALESCE(r.outstanding, 0) <= 0.005;   -- credited to zero is settled

    v_owed_total := v_owed_total + r.outstanding;
    v_days := round(EXTRACT(epoch FROM (now() - r.due_at)) / 86400.0, 2);

    IF r.status <> 'overdue' THEN
      UPDATE settlement_invoices
         SET status = 'overdue', overdue_at = COALESCE(overdue_at, now()), updated_at = now()
       WHERE id = r.id;
      v_marked := v_marked + 1;
    END IF;

    -- Which reminder is owed. One message per run, never a burst.
    v_level_due := CASE WHEN v_days >= v_d3 THEN 3
                        WHEN v_days >= v_d2 THEN 2
                        WHEN v_days >= v_d1 THEN 1
                        ELSE 0 END;

    IF v_gate_open AND v_level_due > COALESCE(r.reminders_sent, 0) THEN
      IF v_level_due >= 3 THEN
        -- Past the last reminder: a person is told, not the club again.
        IF NOT EXISTS (SELECT 1 FROM financial_alerts a
                        WHERE a.source = 'fn_union_age_invoices' AND NOT a.resolved
                          AND a.context->>'invoice_id' = r.id::text) THEN
          INSERT INTO financial_alerts (source, severity, message, context)
          VALUES ('fn_union_age_invoices', 'critical',
                  COALESCE(r.club_name,'A club') || ' has not settled statement '
                  || COALESCE(r.invoice_number, r.id::text) || ': '
                  || to_char(r.outstanding, 'FM999,999,999,990.00') || ' is '
                  || v_days || ' days past due.',
                  jsonb_build_object('invoice_id', r.id, 'invoice_number', r.invoice_number,
                                     'union_id', p_union_id, 'club_id', r.club_id,
                                     'outstanding', r.outstanding, 'days_past_due', v_days));
          v_escalated := v_escalated + 1;
        END IF;
      END IF;

      v_body :=
        COALESCE(v_union_name,'Union') || ' payment reminder' || E'\n'
        || 'Statement ' || COALESCE(r.invoice_number, r.id::text) || E'\n\n'
        || 'Amount outstanding  ' || to_char(r.outstanding, 'FM999,999,999,990.00') || E'\n'
        || 'Due                 ' || to_char(r.due_at, 'YYYY-MM-DD') || E'\n'
        || 'Days past due       ' || v_days || E'\n\n'
        || CASE WHEN v_level_due >= 3
                THEN 'This is the final reminder. The union has been notified.'
                ELSE 'Please settle this statement.' END
        || E'\n\n'
        || 'If you believe this statement is wrong, contest it rather than ignore it.';

      v_msg := fn_union_send_club_message(
        p_union_id, r.club_id, v_body,
        jsonb_build_object('kind', 'union_payment_reminder',
                           'invoice_id', r.id, 'invoice_number', r.invoice_number,
                           'outstanding', r.outstanding, 'days_past_due', v_days,
                           'reminder_level', v_level_due),
        'invoice');

      UPDATE settlement_invoices
         SET reminders_sent = v_level_due, last_reminder_at = now(), updated_at = now()
       WHERE id = r.id;
      v_reminded := v_reminded + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('union_id', p_union_id,
    'newly_overdue', v_marked, 'reminders_sent', v_reminded, 'escalated', v_escalated,
    'total_outstanding_past_due', round(v_owed_total, 2),
    'dunning_gated', NOT v_gate_open, 'ran_at', now());
END $function$;

COMMENT ON FUNCTION public.fn_union_age_invoices(uuid) IS
  'Marks a delivered, club-owed, uncredited statement overdue once due_at passes, and chases it at 0/3/7 days with one message per run, escalating to a critical alert past the last reminder. A disputed statement never ages. Reminders and overdue-driven suspension both respect the weekly_invoices_enabled gate. Runs hourly from fn_union_integrity_sweep_all.';

REVOKE ALL ON FUNCTION public.fn_union_age_invoices(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_age_invoices(uuid) TO service_role;

-- NON-PAYMENT FEEDS THE STOP LOSS --------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_union_enforce_stop_loss(p_union_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r           record;
  v_suspended int := 0;
  v_restored  int := 0;
  v_out       jsonb := '[]'::jsonb;
  v_gate_open boolean;
  v_grace     int;
  v_overdue   numeric;
  v_reason    text;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_platform_admin())) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  v_gate_open := public.fn_union_setting(p_union_id, 'weekly_invoices_enabled', 1) = 1;
  v_grace     := COALESCE(public.fn_union_setting(p_union_id, 'suspend_after_days_overdue', 7), 7)::int;

  FOR r IN
    SELECT * FROM public.fn_union_club_exposure(p_union_id) e WHERE e.terms_on_file
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

    v_reason := NULL;
    IF r.breached THEN
      v_reason := 'stop_loss_breached: exposure '
                  || to_char(r.exposure, 'FM999,999,999,990.00')
                  || ' over limit ' || to_char(r.stop_loss_limit, 'FM999,999,999,990.00');
    ELSIF v_gate_open AND v_overdue > 0.005 THEN
      v_reason := 'stop_loss_breached: ' || to_char(v_overdue, 'FM999,999,999,990.00')
                  || ' unpaid more than ' || v_grace || ' days past due';
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
                                 'club_name', r.club_name, 'exposure', r.exposure,
                                 'stop_loss_limit', r.stop_loss_limit,
                                 'overdue_past_grace', v_overdue,
                                 'security_deposit', r.security_deposit,
                                 'presettled', r.presettled));
      v_suspended := v_suspended + 1;
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'club_id', r.club_id, 'club_name', r.club_name, 'action', 'suspended',
        'reason', v_reason));

    ELSIF v_reason IS NULL AND r.status = 'suspended' THEN
      UPDATE union_club_terms t
         SET status = 'active', suspended_at = NULL, suspended_reason = NULL, updated_at = now()
       WHERE t.union_id = p_union_id AND t.club_id = r.club_id
         AND t.suspended_reason LIKE 'stop_loss_breached:%';

      IF FOUND THEN
        v_restored := v_restored + 1;
        v_out := v_out || jsonb_build_array(jsonb_build_object(
          'club_id', r.club_id, 'club_name', r.club_name, 'action', 'restored'));
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('union_id', p_union_id,
    'suspended', v_suspended, 'restored', v_restored,
    'dunning_gated', NOT v_gate_open,
    'detail', v_out, 'ran_at', now());
END $function$;

-- WIRING ----------------------------------------------------------------------

DO $migrate$
DECLARE v_def text; v_new text; v_a text; v_r text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
    FROM pg_proc WHERE proname='fn_union_integrity_sweep_all' AND pronamespace='public'::regnamespace;

  v_a := E'    -- Stop-loss enforcement rides the sweep rather than taking a schedule of';
  v_r := E'    -- Age and chase what is past due, before enforcement reads it.\n'
      || E'    BEGIN\n'
      || E'      PERFORM public.fn_union_age_invoices(u.id);\n'
      || E'    EXCEPTION WHEN OTHERS THEN\n'
      || E'      INSERT INTO financial_alerts (source, severity, message, context)\n'
      || E'      VALUES (''fn_union_age_invoices'', ''warning'',\n'
      || E'              ''Ageing unpaid statements failed for a union'',\n'
      || E'              jsonb_build_object(''union_id'', u.id, ''error'', SQLERRM));\n'
      || E'    END;\n\n'
      || E'    -- Stop-loss enforcement rides the sweep rather than taking a schedule of';

  IF position(v_a in v_def) = 0 THEN RAISE EXCEPTION 'stop-loss anchor not found in the sweep'; END IF;
  v_new := replace(v_def, v_a, v_r);
  IF v_new = v_def THEN RAISE EXCEPTION 'ageing wiring did not take'; END IF;
  EXECUTE v_new;
END
$migrate$;

-- ASSERTIONS -------------------------------------------------------------------

DO $assert$
DECLARE v_src text; v_res jsonb; v_owed numeric;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname='fn_union_integrity_sweep_all' AND pronamespace='public'::regnamespace;
  IF v_src NOT LIKE '%fn_union_age_invoices%' THEN
    RAISE EXCEPTION 'the hourly sweep does not age invoices';
  END IF;
  IF v_src NOT LIKE '%fn_union_enforce_stop_loss%'
     OR v_src NOT LIKE '%fn_close_due_settlement_periods%'
     OR v_src NOT LIKE '%fn_settlement_lock_hygiene%'
     OR v_src NOT LIKE '%expire_settlement_locks%'
     OR v_src NOT LIKE '%fn_union_integrity_sweep(%' THEN
    RAISE EXCEPTION 'the sweep lost one of its existing jobs';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname='fn_union_enforce_stop_loss' AND pronamespace='public'::regnamespace;
  IF v_src NOT LIKE '%unpaid more than%' THEN
    RAISE EXCEPTION 'enforcement does not consider non-payment';
  END IF;
  IF v_src NOT LIKE '%suspended_reason LIKE ''stop_loss_breached:%%' THEN
    RAISE EXCEPTION 'enforcement no longer restores only its own suspensions';
  END IF;

  -- Outstanding nets credit notes.
  SELECT public.fn_union_invoice_outstanding(id) INTO v_owed
    FROM settlement_invoices WHERE invoice_number = 'MIDWAY-2026-000002';
  IF v_owed <> 220615.68 THEN
    RAISE EXCEPTION 'outstanding on an uncredited statement is %, expected 220615.68', v_owed;
  END IF;
END
$assert$;

-- Behaviour, on the real overdue statements, inside a rolled-back subtransaction.
DO $age_test$
DECLARE
  v_res jsonb; v_msg text; v_status text; v_rem int; v_before int; v_after int;
  v_inv uuid; v_cn jsonb;
BEGIN
  BEGIN
    SELECT count(*) INTO v_before FROM settlement_invoices WHERE status='overdue';

    -- The gate is CLOSED for Midway, so: marked overdue, nothing sent.
    v_res := public.fn_union_age_invoices('fade0000-0000-0000-0000-000000000001');
    IF (v_res->>'newly_overdue')::int <> 2 THEN
      RAISE EXCEPTION 'FIXTURE_FAIL expected 2 newly overdue, got %', v_res::text;
    END IF;
    IF (v_res->>'reminders_sent')::int <> 0 THEN
      RAISE EXCEPTION 'FIXTURE_FAIL reminders were sent while the invoice gate is closed: %', v_res::text;
    END IF;
    IF (v_res->>'dunning_gated') <> 'true' THEN
      RAISE EXCEPTION 'FIXTURE_FAIL the gate was not reported: %', v_res::text;
    END IF;
    IF round((v_res->>'total_outstanding_past_due')::numeric, 2) <> 228146.79 THEN
      RAISE EXCEPTION 'FIXTURE_FAIL outstanding total is %, expected 228146.79',
        v_res->>'total_outstanding_past_due';
    END IF;

    -- Idempotent: a second pass marks nothing new.
    v_res := public.fn_union_age_invoices('fade0000-0000-0000-0000-000000000001');
    IF (v_res->>'newly_overdue')::int <> 0 THEN
      RAISE EXCEPTION 'FIXTURE_FAIL ageing was not idempotent: %', v_res::text;
    END IF;

    -- A DISPUTED statement stops ageing.
    SELECT id INTO v_inv FROM settlement_invoices WHERE invoice_number='MIDWAY-2026-000001';
    UPDATE settlement_invoices SET status='generated', overdue_at=NULL WHERE id=v_inv;
    PERFORM public.fn_union_dispute_invoice(v_inv, 'fixture: contested');
    v_res := public.fn_union_age_invoices('fade0000-0000-0000-0000-000000000001');
    SELECT status INTO v_status FROM settlement_invoices WHERE id=v_inv;
    IF v_status <> 'disputed' THEN
      RAISE EXCEPTION 'FIXTURE_FAIL a disputed statement was aged to %', v_status;
    END IF;

    -- A statement credited to zero is settled, not overdue.
    SELECT id INTO v_inv FROM settlement_invoices WHERE invoice_number='MIDWAY-2026-000002';
    UPDATE settlement_invoices SET status='generated', overdue_at=NULL WHERE id=v_inv;
    v_cn := public.fn_union_issue_credit_note(v_inv, 220615.68, 'fixture: credited in full', false);
    IF public.fn_union_invoice_outstanding(v_inv) <> 0.00 THEN
      RAISE EXCEPTION 'FIXTURE_FAIL outstanding after full credit is %',
        public.fn_union_invoice_outstanding(v_inv);
    END IF;
    v_res := public.fn_union_age_invoices('fade0000-0000-0000-0000-000000000001');
    SELECT status INTO v_status FROM settlement_invoices WHERE id=v_inv;
    IF v_status = 'overdue' THEN
      RAISE EXCEPTION 'FIXTURE_FAIL a fully credited statement was marked overdue';
    END IF;

    RAISE EXCEPTION 'FIXTURE_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg <> 'FIXTURE_ROLLBACK' THEN
      RAISE EXCEPTION 'ageing test failed: %', v_msg;
    END IF;
  END;
END
$age_test$;

COMMIT;
