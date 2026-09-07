-- A NUMBER IS ONLY TAKEN WHEN A DOCUMENT IS MADE
-- =============================================================================
-- PHASE 3 of 8, correction. Two defects I shipped in 20260907175655 and
-- 20260907175852, both found by verifying the phase instead of trusting it.
--
-- 1. THE GAPLESS SEQUENCE WAS NOT GAPLESS.
--
--    fn_union_issue_weekly_invoices took a number at the top of every loop
--    iteration, BEFORE the upsert. On a re-issue the upsert takes the ON
--    CONFLICT path, keeps the existing row and its existing number, and the
--    number just taken is thrown away. A rollback returns it; a COMMITTED
--    re-run does not.
--
--    Measured, on the already-issued 2026-08-10 period:
--
--      counter 3 -> 5   (burned 2)
--      squareup invoices 2 -> 2   (created 0)
--
--    Two numbers consumed, no documents made. That is precisely the hole in an
--    invoice series an auditor asks about, and I claimed in the previous
--    migration that it could not happen. A number is now taken ONLY when no
--    invoice exists yet for that club and period; an existing document keeps
--    the number it was issued with, because renumbering a document is worse
--    than never numbering it.
--
-- 2. ALL THREE NEW WRITERS AUTHORIZED LAST.
--
--    fn_union_dispute_invoice, fn_union_resolve_invoice_dispute and
--    fn_union_issue_credit_note each loaded the invoice, then ran their type,
--    status and business checks, and only THEN asked who was calling. Measured
--    by character offset in the live source:
--
--      dispute_invoice          type check 554, early return 721, auth 1667
--      issue_credit_note        type check 755, auth 1341
--      resolve_invoice_dispute  status check 634, auth 1175
--
--    All three are granted to `authenticated`. So any logged-in player could
--    call them with a guessed or harvested invoice id and learn from the error
--    text whether it exists, what type it is, what its invoice_number is and
--    whether it is disputed - before being refused. Read-only, but it is other
--    clubs' billing metadata, and the whole point of Phase 3 was that a
--    statement is a document with a name a human can say out loud.
--
--    Authorization now runs immediately after the row is loaded and the union
--    is known, before any check that could describe the document. The
--    not-found message is generic for the same reason.
-- =============================================================================

BEGIN;

-- 1. A NUMBER ONLY FOR A NEW DOCUMENT ----------------------------------------

DO $migrate$
DECLARE v_def text; v_new text; v_a text; v_r text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
    FROM pg_proc WHERE proname='fn_union_issue_weekly_invoices' AND pronamespace='public'::regnamespace;

  v_a := E'    v_number := public.fn_next_invoice_number(p_union_id, now());';
  v_r := E'    -- Reuse the number this document already carries. Take a new one ONLY\n'
      || E'    -- when there is no document yet: the upsert below may take the ON\n'
      || E'    -- CONFLICT path, and a number taken and not used is a gap in the series.\n'
      || E'    SELECT si.invoice_number INTO v_number\n'
      || E'      FROM settlement_invoices si\n'
      || E'     WHERE si.club_id = r.club_id AND si.period_id = v_period_id\n'
      || E'       AND si.invoice_type = ''union_weekly_squareup'';\n'
      || E'    IF NOT FOUND THEN\n'
      || E'      v_number := public.fn_next_invoice_number(p_union_id, now());\n'
      || E'    END IF;';

  IF position(v_a in v_def) = 0 THEN RAISE EXCEPTION 'numbering anchor not found'; END IF;
  v_new := replace(v_def, v_a, v_r);

  v_a := E'      breakdown        = EXCLUDED.breakdown,';
  v_r := E'      invoice_number   = COALESCE(settlement_invoices.invoice_number, EXCLUDED.invoice_number),\n      breakdown        = EXCLUDED.breakdown,';
  IF position(v_a in v_new) = 0 THEN RAISE EXCEPTION 'DO UPDATE breakdown anchor not found'; END IF;
  v_new := replace(v_new, v_a, v_r);

  IF v_new = v_def THEN RAISE EXCEPTION 'numbering fix did not take'; END IF;
  EXECUTE v_new;
END
$migrate$;

-- 2. AUTHORIZE BEFORE DESCRIBING ----------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_union_issue_credit_note(
  p_invoice_id uuid,
  p_amount     numeric,
  p_reason     text,
  p_notify     boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_orig      settlement_invoices%ROWTYPE;
  v_union_id  uuid;
  v_union_name text;
  v_club_name text;
  v_credited  numeric;
  v_remaining numeric;
  v_number    text;
  v_new_id    uuid;
  v_msg       jsonb;
  v_body      text;
BEGIN
  SELECT * INTO v_orig FROM settlement_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF v_orig.id IS NULL THEN
    RAISE EXCEPTION 'invoice not found';
  END IF;

  v_union_id := (v_orig.breakdown->>'union_id')::uuid;

  -- WHO IS CALLING, before anything that would describe the document.
  IF auth.uid() IS NOT NULL
     AND (v_union_id IS NULL
          OR (NOT EXISTS (SELECT 1 FROM unions u WHERE u.id = v_union_id AND u.owner_id = auth.uid())
              AND NOT EXISTS (SELECT 1 FROM union_admins ua WHERE ua.union_id = v_union_id AND ua.user_id = auth.uid())
              AND NOT COALESCE(public.fn_is_platform_admin(), false))) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'a credit note must be for a positive amount, got %', p_amount;
  END IF;
  IF COALESCE(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'a credit note must carry a reason';
  END IF;
  IF v_orig.invoice_type <> 'union_weekly_squareup' THEN
    RAISE EXCEPTION 'only a weekly square-up can be credited, this is %', v_orig.invoice_type;
  END IF;
  IF v_union_id IS NULL THEN
    RAISE EXCEPTION 'invoice % carries no union_id in its breakdown', p_invoice_id;
  END IF;

  SELECT COALESCE(SUM(net_amount), 0) INTO v_credited
    FROM settlement_invoices
   WHERE adjusts_invoice_id = p_invoice_id
     AND invoice_type = 'union_weekly_credit_note';

  v_remaining := round(v_orig.net_amount - v_credited, 2);
  IF p_amount > v_remaining + 0.005 THEN
    RAISE EXCEPTION
      'credit note of % exceeds what is left on invoice % (net %, already credited %, remaining %)',
      p_amount, COALESCE(v_orig.invoice_number, v_orig.id::text),
      v_orig.net_amount, v_credited, v_remaining;
  END IF;

  SELECT u.name INTO v_union_name FROM unions u WHERE u.id = v_union_id;
  SELECT c.name INTO v_club_name FROM clubs c WHERE c.id = v_orig.club_id;
  v_number := public.fn_next_invoice_number(v_union_id, now());

  INSERT INTO settlement_invoices (
    club_id, period_id, invoice_type, invoice_number, adjusts_invoice_id,
    from_entity_type, from_entity_id, to_entity_type, to_entity_id,
    gross_amount, net_amount, deductions, breakdown, status,
    chips_transferred, due_at, notes)
  VALUES (
    v_orig.club_id, v_orig.period_id, 'union_weekly_credit_note', v_number, v_orig.id,
    v_orig.to_entity_type,   v_orig.to_entity_id,
    v_orig.from_entity_type, v_orig.from_entity_id,
    p_amount, p_amount, 0,
    jsonb_build_object(
      'union_id', v_union_id, 'union_name', v_union_name,
      'club_id', v_orig.club_id, 'club_name', v_club_name,
      'credit_note_for', COALESCE(v_orig.invoice_number, v_orig.id::text),
      'original_invoice_id', v_orig.id,
      'original_net_amount', v_orig.net_amount,
      'previously_credited', v_credited,
      'remaining_before_this', v_remaining,
      'reason', p_reason,
      'period_start', v_orig.breakdown->>'period_start',
      'period_end', v_orig.breakdown->>'period_end',
      'issued_at', now()),
    'generated', false, v_orig.due_at,
    'Credit note against ' || COALESCE(v_orig.invoice_number, v_orig.id::text) || '. ' || p_reason)
  RETURNING id INTO v_new_id;

  IF p_notify THEN
    v_body :=
      COALESCE(v_union_name, 'Union') || ' credit note ' || v_number || E'\n'
      || 'Against statement ' || COALESCE(v_orig.invoice_number, v_orig.id::text) || E'\n\n'
      || 'Credit amount       ' || to_char(p_amount, 'FM999,999,999,990.00') || E'\n'
      || 'Original statement  ' || to_char(v_orig.net_amount, 'FM999,999,999,990.00') || E'\n'
      || CASE WHEN v_credited > 0
              THEN 'Previously credited ' || to_char(v_credited, 'FM999,999,999,990.00') || E'\n'
              ELSE '' END
      || 'Remaining after     ' || to_char(round(v_remaining - p_amount, 2), 'FM999,999,999,990.00')
      || E'\n\n'
      || 'Reason: ' || p_reason || E'\n\n'
      || 'The original statement is unchanged. This credit note adjusts it.';

    v_msg := fn_union_send_club_message(
      v_union_id, v_orig.club_id, v_body,
      jsonb_build_object(
        'kind', 'union_credit_note',
        'credit_note_id', v_new_id,
        'credit_note_number', v_number,
        'adjusts_invoice_id', v_orig.id,
        'adjusts_invoice_number', v_orig.invoice_number,
        'amount', p_amount,
        'reason', p_reason),
      'invoice');

    IF COALESCE((v_msg->>'delivered')::int, 0) > 0 THEN
      UPDATE settlement_invoices
         SET message_sent = true, message_sent_at = now()
       WHERE id = v_new_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'credit_note_id', v_new_id,
    'credit_note_number', v_number,
    'adjusts', COALESCE(v_orig.invoice_number, v_orig.id::text),
    'amount', p_amount,
    'original_net', v_orig.net_amount,
    'total_credited_now', round(v_credited + p_amount, 2),
    'remaining_after', round(v_remaining - p_amount, 2),
    'delivered', COALESCE((v_msg->>'delivered')::int, 0));
END $function$;

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
  SELECT * INTO v_inv FROM settlement_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF v_inv.id IS NULL THEN
    RAISE EXCEPTION 'invoice not found';
  END IF;

  v_union_id := (v_inv.breakdown->>'union_id')::uuid;

  -- WHO IS CALLING, before anything that would describe the document.
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

  IF COALESCE(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'a dispute must carry a reason';
  END IF;
  IF v_inv.invoice_type <> 'union_weekly_squareup' THEN
    RAISE EXCEPTION 'only a weekly square-up can be disputed, this is %', v_inv.invoice_type;
  END IF;
  IF v_inv.status = 'disputed' THEN
    RETURN jsonb_build_object('success', true, 'already_disputed', true,
                              'invoice', COALESCE(v_inv.invoice_number, v_inv.id::text));
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
  SELECT * INTO v_inv FROM settlement_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF v_inv.id IS NULL THEN RAISE EXCEPTION 'invoice not found'; END IF;

  v_union_id := (v_inv.breakdown->>'union_id')::uuid;

  -- WHO IS CALLING, before anything that would describe the document.
  IF auth.uid() IS NOT NULL
     AND (v_union_id IS NULL
          OR (NOT EXISTS (SELECT 1 FROM unions u WHERE u.id = v_union_id AND u.owner_id = auth.uid())
              AND NOT EXISTS (SELECT 1 FROM union_admins ua WHERE ua.union_id = v_union_id AND ua.user_id = auth.uid())
              AND NOT COALESCE(public.fn_is_platform_admin(), false))) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  IF COALESCE(btrim(p_resolution), '') = '' THEN
    RAISE EXCEPTION 'a resolution must say what was decided';
  END IF;
  IF p_new_status NOT IN ('generated','paid','cancelled') THEN
    RAISE EXCEPTION 'a resolved dispute must land on generated, paid or cancelled, not %', p_new_status;
  END IF;
  IF v_inv.status <> 'disputed' THEN
    RAISE EXCEPTION 'invoice % is not disputed (status %)',
      COALESCE(v_inv.invoice_number, v_inv.id::text), v_inv.status;
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

-- ASSERTIONS -------------------------------------------------------------------

DO $assert$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.proname, p.prosrc
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public'
       AND p.proname IN ('fn_union_dispute_invoice','fn_union_resolve_invoice_dispute','fn_union_issue_credit_note')
  LOOP
    IF position('not_authorised' in r.prosrc) = 0 THEN
      RAISE EXCEPTION '% lost its authorization check', r.proname;
    END IF;
    IF position('only a weekly square-up' in r.prosrc) > 0
       AND position('not_authorised' in r.prosrc) > position('only a weekly square-up' in r.prosrc) THEN
      RAISE EXCEPTION '% still authorizes after its type check', r.proname;
    END IF;
    IF position('already_disputed' in r.prosrc) > 0
       AND position('not_authorised' in r.prosrc) > position('already_disputed' in r.prosrc) THEN
      RAISE EXCEPTION '% still authorizes after its early return', r.proname;
    END IF;
    IF position('is not disputed' in r.prosrc) > 0
       AND position('not_authorised' in r.prosrc) > position('is not disputed' in r.prosrc) THEN
      RAISE EXCEPTION '% still authorizes after its status check', r.proname;
    END IF;
    IF position('exceeds what is left' in r.prosrc) > 0
       AND position('not_authorised' in r.prosrc) > position('exceeds what is left' in r.prosrc) THEN
      RAISE EXCEPTION '% still authorizes after its over-credit check', r.proname;
    END IF;
  END LOOP;
END
$assert$;

-- The burn is measured, not assumed.
DO $burn_test$
DECLARE
  v_before bigint; v_after bigint; v_created int; v_inv_before int; v_msg text; v_res jsonb;
BEGIN
  BEGIN
    SELECT next_seq INTO v_before FROM union_invoice_counters
     WHERE union_id='fade0000-0000-0000-0000-000000000001' AND year=2026;
    SELECT count(*) INTO v_inv_before FROM settlement_invoices WHERE invoice_type='union_weekly_squareup';

    v_res := public.fn_union_issue_weekly_invoices(
               'fade0000-0000-0000-0000-000000000001',
               '2026-08-10 00:00:00+00','2026-08-17 00:00:00+00', false);

    SELECT next_seq INTO v_after FROM union_invoice_counters
     WHERE union_id='fade0000-0000-0000-0000-000000000001' AND year=2026;
    SELECT count(*) - v_inv_before INTO v_created FROM settlement_invoices WHERE invoice_type='union_weekly_squareup';

    IF v_after <> v_before THEN
      RAISE EXCEPTION 'FIXTURE_FAIL re-issue still burned % number(s) while creating % document(s)',
        v_after - v_before, v_created;
    END IF;
    IF v_created <> 0 THEN
      RAISE EXCEPTION 'FIXTURE_FAIL re-issue created % unexpected document(s)', v_created;
    END IF;

    RAISE EXCEPTION 'FIXTURE_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg <> 'FIXTURE_ROLLBACK' THEN
      RAISE EXCEPTION 'invoice number burn test failed: %', v_msg;
    END IF;
  END;
END
$burn_test$;

COMMIT;
