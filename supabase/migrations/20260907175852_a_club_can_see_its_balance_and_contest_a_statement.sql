-- A CLUB CAN SEE ITS BALANCE, AND CONTEST A STATEMENT
-- =============================================================================
-- PHASE 3 of 8, part 2 of 2.
--
-- 1. NO STATEMENT OF ACCOUNT. Every invoice stood alone. Real unions settle
--    against a RUNNING BALANCE carried week to week - which this schema already
--    implies, because an unapplied presettlement is money sitting against a
--    balance that nothing was totalling. Without it, a club that underpays by
--    500 has that 500 living nowhere: not on the old statement, which is
--    immutable, and not on the new one, which only covers its own week.
--
--    SIGN CONVENTION, stated once: POSITIVE means the club owes the union.
--    A square-up billed to the club is positive, a credit note against it is
--    negative because it reverses the document's direction, and a payment
--    received is negative. The closing balance is what the club owes today.
--
-- 2. THE DISPUTE PATH WAS HALF-BUILT. settlement_periods has carried a
--    'disputed' status all along, with one row in it, and NOTHING connected an
--    invoice to raising, tracking or resolving a dispute. A club could be told
--    it owed 92,653.67 with no way in the product to contest it. Phase 2 made
--    fn_close_due_settlement_periods skip a disputed period, so the state
--    already had teeth - there was just no way to enter it.
--
-- ONE DELIBERATE REFUSAL: disputing does NOT reopen a CLOSED period. Phase 2
-- made a closed period immutable on purpose, and reopening it to register a
-- dispute would hollow that out on day one. The invoice is marked disputed, the
-- closed period is left alone, and the resolution is a credit note - which is
-- exactly the "correct it forward, never edit history quiet" rule from
-- CLAUDE.md 10.9.
-- =============================================================================

BEGIN;

ALTER TABLE public.settlement_invoices DROP CONSTRAINT IF EXISTS settlement_invoices_status_check;
ALTER TABLE public.settlement_invoices ADD CONSTRAINT settlement_invoices_status_check
  CHECK (status = ANY (ARRAY['pending'::text, 'generated'::text, 'paid'::text,
                             'cancelled'::text, 'overdue'::text, 'disputed'::text]));

CREATE OR REPLACE FUNCTION public.fn_union_club_statement_of_account(
  p_union_id uuid,
  p_club_id  uuid,
  p_since    timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(
   entry_at        timestamp with time zone,
   entry_type      text,
   reference       text,
   description     text,
   amount          numeric,
   running_balance numeric,
   status          text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH entries AS (
    SELECT si.created_at AS entry_at,
           CASE WHEN si.invoice_type = 'union_weekly_credit_note'
                THEN 'credit_note' ELSE 'statement' END AS entry_type,
           COALESCE(si.invoice_number, si.id::text) AS reference,
           CASE WHEN si.invoice_type = 'union_weekly_credit_note'
                THEN 'Credit note against ' || COALESCE(si.breakdown->>'credit_note_for', '(unknown)')
                     || COALESCE(' - ' || (si.breakdown->>'reason'), '')
                ELSE 'Weekly statement '
                     || COALESCE(to_char((si.breakdown->>'period_start')::timestamptz, 'YYYY-MM-DD'), '?')
                     || ' to '
                     || COALESCE(to_char((si.breakdown->>'period_end')::timestamptz, 'YYYY-MM-DD'), '?')
                END AS description,
           CASE WHEN si.from_entity_type = 'club'
                THEN  si.net_amount
                ELSE -si.net_amount END AS amount,
           si.status
      FROM settlement_invoices si
     WHERE si.club_id = p_club_id
       AND si.invoice_type IN ('union_weekly_squareup', 'union_weekly_credit_note')
       AND (si.breakdown->>'union_id')::uuid = p_union_id
       AND (p_since IS NULL OR si.created_at >= p_since)

    UNION ALL

    SELECT p.received_at,
           'payment',
           COALESCE(p.reference, p.id::text),
           'Payment received'
             || COALESCE(' by ' || p.method, '')
             || CASE WHEN p.applied_settlement_id IS NULL THEN ' (unapplied)' ELSE '' END,
           -p.amount,
           CASE WHEN p.applied_settlement_id IS NULL THEN 'unapplied' ELSE 'applied' END
      FROM union_presettlements p
     WHERE p.union_id = p_union_id
       AND p.club_id = p_club_id
       AND (p_since IS NULL OR p.received_at >= p_since)
  )
  SELECT e.entry_at, e.entry_type, e.reference, e.description,
         round(e.amount, 2),
         round(SUM(e.amount) OVER (ORDER BY e.entry_at, e.reference
                                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), 2),
         e.status
    FROM entries e
   ORDER BY e.entry_at, e.reference;
$function$;

COMMENT ON FUNCTION public.fn_union_club_statement_of_account(uuid, uuid, timestamp with time zone) IS
  'One ordered ledger of a club position with the union: weekly statements, credit notes and payments received, with a running balance. Positive means the club owes the union.';

REVOKE ALL ON FUNCTION public.fn_union_club_statement_of_account(uuid, uuid, timestamp with time zone) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_union_club_statement_of_account(uuid, uuid, timestamp with time zone) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_union_dispute_invoice(
  p_invoice_id uuid,
  p_reason     text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inv       settlement_invoices%ROWTYPE;
  v_union_id  uuid;
  v_period    settlement_periods%ROWTYPE;
  v_caller    uuid := auth.uid();
  v_period_marked boolean := false;
BEGIN
  IF COALESCE(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'a dispute must carry a reason';
  END IF;

  SELECT * INTO v_inv FROM settlement_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF v_inv.id IS NULL THEN
    RAISE EXCEPTION 'invoice % not found', p_invoice_id;
  END IF;
  IF v_inv.invoice_type <> 'union_weekly_squareup' THEN
    RAISE EXCEPTION 'only a weekly square-up can be disputed, this is %', v_inv.invoice_type;
  END IF;
  IF v_inv.status = 'disputed' THEN
    RETURN jsonb_build_object('success', true, 'already_disputed', true,
                              'invoice', COALESCE(v_inv.invoice_number, v_inv.id::text));
  END IF;

  v_union_id := (v_inv.breakdown->>'union_id')::uuid;

  IF v_caller IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM clubs c WHERE c.id = v_inv.club_id AND c.owner_id = v_caller)
     AND NOT EXISTS (SELECT 1 FROM club_members cm
                      WHERE cm.club_id = v_inv.club_id AND cm.user_id = v_caller
                        AND cm.role IN ('owner','co_owner','admin')
                        AND COALESCE(cm.status,'active') NOT IN ('banned','suspended'))
     AND NOT EXISTS (SELECT 1 FROM unions u WHERE u.id = v_union_id AND u.owner_id = v_caller)
     AND NOT EXISTS (SELECT 1 FROM union_admins ua WHERE ua.union_id = v_union_id AND ua.user_id = v_caller)
     AND NOT COALESCE(public.fn_is_platform_admin(), false) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  UPDATE settlement_invoices
     SET status = 'disputed',
         notes = COALESCE(notes, '') || E'\nDISPUTED ' || to_char(now(), 'YYYY-MM-DD HH24:MI')
                 || ': ' || p_reason,
         updated_at = now()
   WHERE id = p_invoice_id;

  SELECT * INTO v_period FROM settlement_periods WHERE id = v_inv.period_id;
  IF v_period.id IS NOT NULL AND v_period.status NOT IN ('closed', 'disputed') THEN
    UPDATE settlement_periods SET status = 'disputed', updated_at = now()
     WHERE id = v_inv.period_id;
    v_period_marked := true;
  END IF;

  INSERT INTO notifications (user_id, type, title, message, data, read)
  SELECT DISTINCT uid, 'union_invoice_disputed',
         'Statement ' || COALESCE(v_inv.invoice_number, '') || ' disputed',
         COALESCE((v_inv.breakdown->>'club_name'), 'A club')
           || ' has disputed statement ' || COALESCE(v_inv.invoice_number, v_inv.id::text)
           || ': ' || p_reason,
         jsonb_build_object('invoice_id', v_inv.id, 'invoice_number', v_inv.invoice_number,
                            'club_id', v_inv.club_id, 'union_id', v_union_id,
                            'reason', p_reason, 'source', 'club_arena'),
         false
    FROM (
      SELECT u.owner_id AS uid FROM unions u WHERE u.id = v_union_id AND u.owner_id IS NOT NULL
      UNION
      SELECT ua.user_id FROM union_admins ua WHERE ua.union_id = v_union_id
    ) x WHERE uid IS NOT NULL;

  RETURN jsonb_build_object(
    'success', true,
    'invoice', COALESCE(v_inv.invoice_number, v_inv.id::text),
    'invoice_id', v_inv.id,
    'period_marked_disputed', v_period_marked,
    'period_status', COALESCE(v_period.status, '(none)'),
    'note', CASE WHEN v_period.status = 'closed'
                 THEN 'The period is closed and was not reopened. Resolve with a credit note.'
                 ELSE 'The period is marked disputed and will not be closed until resolved.' END);
END $function$;

CREATE OR REPLACE FUNCTION public.fn_union_resolve_invoice_dispute(
  p_invoice_id uuid,
  p_resolution text,
  p_new_status text DEFAULT 'generated')
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inv      settlement_invoices%ROWTYPE;
  v_union_id uuid;
  v_open     int;
BEGIN
  IF COALESCE(btrim(p_resolution), '') = '' THEN
    RAISE EXCEPTION 'a resolution must say what was decided';
  END IF;
  IF p_new_status NOT IN ('generated','paid','cancelled') THEN
    RAISE EXCEPTION 'a resolved dispute must land on generated, paid or cancelled, not %', p_new_status;
  END IF;

  SELECT * INTO v_inv FROM settlement_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF v_inv.id IS NULL THEN RAISE EXCEPTION 'invoice % not found', p_invoice_id; END IF;
  IF v_inv.status <> 'disputed' THEN
    RAISE EXCEPTION 'invoice % is not disputed (status %)',
      COALESCE(v_inv.invoice_number, v_inv.id::text), v_inv.status;
  END IF;

  v_union_id := (v_inv.breakdown->>'union_id')::uuid;

  IF auth.uid() IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM unions u WHERE u.id = v_union_id AND u.owner_id = auth.uid())
     AND NOT EXISTS (SELECT 1 FROM union_admins ua WHERE ua.union_id = v_union_id AND ua.user_id = auth.uid())
     AND NOT COALESCE(public.fn_is_platform_admin(), false) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  UPDATE settlement_invoices
     SET status = p_new_status,
         notes = COALESCE(notes, '') || E'\nRESOLVED ' || to_char(now(), 'YYYY-MM-DD HH24:MI')
                 || ': ' || p_resolution,
         updated_at = now()
   WHERE id = p_invoice_id;

  SELECT count(*) INTO v_open
    FROM settlement_invoices
   WHERE period_id = v_inv.period_id AND status = 'disputed';

  IF v_open = 0 THEN
    UPDATE settlement_periods
       SET status = 'settled', updated_at = now()
     WHERE id = v_inv.period_id AND status = 'disputed';
  END IF;

  RETURN jsonb_build_object('success', true,
    'invoice', COALESCE(v_inv.invoice_number, v_inv.id::text),
    'new_status', p_new_status,
    'disputes_still_open_on_period', v_open,
    'period_returned_to_settled', (v_open = 0));
END $function$;

REVOKE ALL ON FUNCTION public.fn_union_dispute_invoice(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_union_dispute_invoice(uuid, text) TO service_role, authenticated;
REVOKE ALL ON FUNCTION public.fn_union_resolve_invoice_dispute(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_union_resolve_invoice_dispute(uuid, text, text) TO service_role, authenticated;

DO $assert$
DECLARE v_rows int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid='public.settlement_invoices'::regclass
                    AND conname='settlement_invoices_status_check'
                    AND pg_get_constraintdef(oid) LIKE '%disputed%') THEN
    RAISE EXCEPTION 'disputed is not an allowed invoice status';
  END IF;

  SELECT count(*) INTO v_rows FROM public.fn_union_club_statement_of_account(
    'fade0000-0000-0000-0000-000000000001', 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4');
  IF v_rows < 1 THEN
    RAISE EXCEPTION 'the statement of account returned nothing for a club with an invoice';
  END IF;
END
$assert$;

DO $dispute_test$
DECLARE
  v_inv settlement_invoices%ROWTYPE; v_res jsonb; v_msg text; v_raised boolean;
  v_bal numeric; v_bal_after numeric; v_cn jsonb;
BEGIN
  BEGIN
    SELECT * INTO v_inv FROM settlement_invoices
     WHERE invoice_type='union_weekly_squareup' AND invoice_number='MIDWAY-2026-000002';

    SELECT running_balance INTO v_bal FROM public.fn_union_club_statement_of_account(
      'fade0000-0000-0000-0000-000000000001', v_inv.club_id)
     ORDER BY entry_at DESC, reference DESC LIMIT 1;
    IF v_bal IS NULL THEN RAISE EXCEPTION 'FIXTURE_FAIL no running balance'; END IF;

    v_cn := public.fn_union_issue_credit_note(v_inv.id, 250.00, 'fixture: statement check', false);
    SELECT running_balance INTO v_bal_after FROM public.fn_union_club_statement_of_account(
      'fade0000-0000-0000-0000-000000000001', v_inv.club_id)
     ORDER BY entry_at DESC, reference DESC LIMIT 1;
    IF round(v_bal - v_bal_after, 2) <> 250.00 THEN
      RAISE EXCEPTION 'FIXTURE_FAIL credit note did not move the balance by 250: % -> %', v_bal, v_bal_after;
    END IF;

    v_res := public.fn_union_dispute_invoice(v_inv.id, 'fixture: the rake basis looks wrong');
    IF (SELECT status FROM settlement_invoices WHERE id=v_inv.id) <> 'disputed' THEN
      RAISE EXCEPTION 'FIXTURE_FAIL the invoice was not marked disputed';
    END IF;

    v_res := public.fn_union_dispute_invoice(v_inv.id, 'fixture: again');
    IF (v_res->>'already_disputed') <> 'true' THEN
      RAISE EXCEPTION 'FIXTURE_FAIL a second dispute was not idempotent: %', v_res::text;
    END IF;

    v_raised := false;
    BEGIN
      PERFORM public.fn_union_dispute_invoice((v_cn->>'credit_note_id')::uuid, 'fixture');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      v_raised := v_msg LIKE 'only a weekly square-up can be disputed%';
    END;
    IF NOT v_raised THEN RAISE EXCEPTION 'FIXTURE_FAIL a credit note was disputed'; END IF;

    v_raised := false;
    BEGIN
      PERFORM public.fn_union_resolve_invoice_dispute(v_inv.id, 'fixture', 'nonsense');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      v_raised := v_msg LIKE 'a resolved dispute must land on%';
    END;
    IF NOT v_raised THEN RAISE EXCEPTION 'FIXTURE_FAIL an illegal resolution status was accepted'; END IF;

    v_res := public.fn_union_resolve_invoice_dispute(v_inv.id, 'fixture: credited and closed', 'generated');
    IF (SELECT status FROM settlement_invoices WHERE id=v_inv.id) <> 'generated' THEN
      RAISE EXCEPTION 'FIXTURE_FAIL the dispute did not resolve';
    END IF;

    RAISE EXCEPTION 'FIXTURE_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg <> 'FIXTURE_ROLLBACK' THEN
      RAISE EXCEPTION 'dispute/statement test failed: %', v_msg;
    END IF;
  END;
END
$dispute_test$;

COMMIT;
