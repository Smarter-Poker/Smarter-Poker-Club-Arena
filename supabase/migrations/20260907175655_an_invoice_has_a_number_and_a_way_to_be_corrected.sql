-- AN INVOICE HAS A NUMBER, AND A WAY TO BE CORRECTED
-- =============================================================================
-- PHASE 3 of 8, part 1 of 2. The credit note half of this closes a hole I
-- opened myself.
--
-- 20260907044041 made a DELIVERED invoice immutable, so a statement already in
-- a club's hands cannot be silently restated behind their back. That was right.
-- What I did not build was the other half: there was no credit note, no void,
-- no reverse, no adjustment of any kind anywhere in this schema. Immutable plus
-- no correction instrument means a wrong invoice is permanent - which is worse
-- than what was there before, in that one specific respect.
--
-- This is also how real billing works. You never edit an issued invoice; you
-- issue a credit against it and the two net. The audit trail then shows what
-- was claimed, what was corrected, and why - instead of showing a number that
-- quietly became a different number.
--
-- NUMBERING, because a credit note has to reference something a human can say
-- out loud. settlement_invoices had a UUID and nothing else, so a club could
-- not tell you which statement they were disputing and an auditor could not
-- tell whether any were missing.
--
--   MIDWAY-2026-000001
--
-- The sequence is GAPLESS, which a Postgres SEQUENCE cannot give you: a
-- sequence keeps counting through a rollback and leaves a hole. A counter row
-- updated inside the same transaction rolls back with everything else, so a
-- settlement that aborts returns its numbers. That matters because a gap in an
-- invoice sequence is exactly what an auditor asks about. Proven in this
-- migration: the test fixture consumed 3, 4 and 5 and rolled back, and the
-- counter is sitting at 3.
--
-- The two invoices already issued (2026-08-21, for the 2026-08-10 period) are
-- backfilled in created_at order so the series starts where the history does.
-- The three legacy rows of other types are left unnumbered; this series is the
-- weekly union statement series and inventing numbers for unrelated documents
-- would make it less trustworthy, not more.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.union_invoice_counters (
  union_id  uuid   NOT NULL REFERENCES public.unions(id) ON DELETE CASCADE,
  year      int    NOT NULL,
  next_seq  bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (union_id, year)
);

COMMENT ON TABLE public.union_invoice_counters IS
  'Gapless per-union, per-year invoice sequence. A counter row rather than a SEQUENCE, because a rollback must return the number rather than leave a hole in the series.';

ALTER TABLE public.settlement_invoices
  ADD COLUMN IF NOT EXISTS invoice_number text,
  ADD COLUMN IF NOT EXISTS adjusts_invoice_id uuid REFERENCES public.settlement_invoices(id);

CREATE UNIQUE INDEX IF NOT EXISTS settlement_invoices_number_uidx
  ON public.settlement_invoices (invoice_number) WHERE invoice_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS settlement_invoices_adjusts_idx
  ON public.settlement_invoices (adjusts_invoice_id) WHERE adjusts_invoice_id IS NOT NULL;

ALTER TABLE public.settlement_invoices DROP CONSTRAINT IF EXISTS settlement_invoices_invoice_type_check;
ALTER TABLE public.settlement_invoices ADD CONSTRAINT settlement_invoices_invoice_type_check
  CHECK (invoice_type = ANY (ARRAY['union_to_club'::text, 'club_to_agent'::text,
         'agent_to_subagent'::text, 'agent_to_player'::text, 'union_club_pnl'::text,
         'club_to_union'::text, 'union_weekly_squareup'::text,
         'union_weekly_credit_note'::text]));

CREATE OR REPLACE FUNCTION public.fn_next_invoice_number(
  p_union_id uuid,
  p_at       timestamp with time zone DEFAULT now())
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_year   int := EXTRACT(year FROM (p_at AT TIME ZONE 'America/Los_Angeles'))::int;
  v_seq    bigint;
  v_prefix text;
BEGIN
  SELECT upper(left(regexp_replace(COALESCE(u.slug, u.name, 'union'), '[^a-zA-Z0-9]', '', 'g'), 6))
    INTO v_prefix
    FROM unions u WHERE u.id = p_union_id;
  IF v_prefix IS NULL OR v_prefix = '' THEN
    RAISE EXCEPTION 'cannot derive an invoice prefix for union %', p_union_id;
  END IF;

  LOOP
    UPDATE union_invoice_counters
       SET next_seq = next_seq + 1, updated_at = now()
     WHERE union_id = p_union_id AND year = v_year
     RETURNING next_seq - 1 INTO v_seq;
    EXIT WHEN FOUND;

    BEGIN
      INSERT INTO union_invoice_counters (union_id, year, next_seq)
      VALUES (p_union_id, v_year, 2);
      v_seq := 1;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      -- Another session created the row first; go round and take the update path.
    END;
  END LOOP;

  RETURN v_prefix || '-' || v_year::text || '-' || lpad(v_seq::text, 6, '0');
END $function$;

REVOKE ALL ON FUNCTION public.fn_next_invoice_number(uuid, timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_next_invoice_number(uuid, timestamp with time zone) TO service_role;

DO $backfill$
DECLARE r record; v_num text;
BEGIN
  FOR r IN
    SELECT si.id, si.created_at, (si.breakdown->>'union_id')::uuid AS union_id
      FROM settlement_invoices si
     WHERE si.invoice_type = 'union_weekly_squareup'
       AND si.invoice_number IS NULL
       AND si.breakdown ? 'union_id'
     ORDER BY si.created_at, si.id
  LOOP
    v_num := public.fn_next_invoice_number(r.union_id, r.created_at);
    UPDATE settlement_invoices SET invoice_number = v_num WHERE id = r.id;
  END LOOP;
END
$backfill$;

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
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'a credit note must be for a positive amount, got %', p_amount;
  END IF;
  IF COALESCE(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'a credit note must carry a reason';
  END IF;

  SELECT * INTO v_orig FROM settlement_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF v_orig.id IS NULL THEN
    RAISE EXCEPTION 'invoice % not found', p_invoice_id;
  END IF;
  IF v_orig.invoice_type <> 'union_weekly_squareup' THEN
    RAISE EXCEPTION 'only a weekly square-up can be credited, this is %', v_orig.invoice_type;
  END IF;

  v_union_id := (v_orig.breakdown->>'union_id')::uuid;
  IF v_union_id IS NULL THEN
    RAISE EXCEPTION 'invoice % carries no union_id in its breakdown', p_invoice_id;
  END IF;

  IF auth.uid() IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM unions u WHERE u.id = v_union_id AND u.owner_id = auth.uid())
     AND NOT EXISTS (SELECT 1 FROM union_admins ua WHERE ua.union_id = v_union_id AND ua.user_id = auth.uid())
     AND NOT COALESCE(public.fn_is_platform_admin(), false) THEN
    RAISE EXCEPTION 'not_authorised';
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

COMMENT ON FUNCTION public.fn_union_issue_credit_note(uuid, numeric, text, boolean) IS
  'Issues a credit note against a delivered weekly square-up. The original is never modified - a delivered invoice is immutable - and the two documents net. Refuses to over-credit, to credit a credit note, or to issue without a reason.';

REVOKE ALL ON FUNCTION public.fn_union_issue_credit_note(uuid, numeric, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_union_issue_credit_note(uuid, numeric, text, boolean) TO service_role, authenticated;

DO $migrate$
DECLARE v_def text; v_new text; v_a text; v_r text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
    FROM pg_proc WHERE proname='fn_union_issue_weekly_invoices' AND pronamespace='public'::regnamespace;

  v_a := E'    INSERT INTO settlement_invoices (\n      club_id, period_id, invoice_type,';
  v_r := E'    v_number := public.fn_next_invoice_number(p_union_id, now());\n\n    INSERT INTO settlement_invoices (\n      club_id, period_id, invoice_type, invoice_number,';
  IF position(v_a in v_def) = 0 THEN RAISE EXCEPTION 'invoice INSERT anchor not found'; END IF;
  v_new := replace(v_def, v_a, v_r);

  v_a := E'      r.club_id, v_period_id, \'union_weekly_squareup\',';
  v_r := E'      r.club_id, v_period_id, \'union_weekly_squareup\', v_number,';
  IF position(v_a in v_new) = 0 THEN RAISE EXCEPTION 'invoice VALUES anchor not found'; END IF;
  v_new := replace(v_new, v_a, v_r);

  v_a := E'      updated_at       = now()\n    WHERE COALESCE(settlement_invoices.message_sent, false) = false';
  IF position(v_a in v_new) = 0 THEN RAISE EXCEPTION 'DO UPDATE anchor not found'; END IF;

  v_a := E'  v_body text;\n  v_out jsonb := \'[]\'::jsonb;';
  v_r := E'  v_body text;\n  v_number text;\n  v_out jsonb := \'[]\'::jsonb;';
  IF position(v_a in v_new) = 0 THEN RAISE EXCEPTION 'declare anchor not found'; END IF;
  v_new := replace(v_new, v_a, v_r);

  IF v_new = v_def THEN RAISE EXCEPTION 'numbering wiring did not take'; END IF;
  EXECUTE v_new;
END
$migrate$;

DO $assert$
DECLARE v_src text; v_backfilled int;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname='fn_union_issue_weekly_invoices' AND pronamespace='public'::regnamespace;
  IF v_src NOT LIKE '%fn_next_invoice_number%' THEN
    RAISE EXCEPTION 'the issuer does not number its statements';
  END IF;
  IF v_src NOT LIKE '%WHERE COALESCE(settlement_invoices.message_sent, false) = false%' THEN
    RAISE EXCEPTION 'the delivered-invoice freeze was lost';
  END IF;

  SELECT count(*) INTO v_backfilled FROM settlement_invoices
   WHERE invoice_type='union_weekly_squareup' AND invoice_number IS NOT NULL;
  IF v_backfilled <> 2 THEN
    RAISE EXCEPTION 'expected 2 backfilled statement numbers, found %', v_backfilled;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM settlement_invoices WHERE invoice_number = 'MIDWAY-2026-000001') THEN
    RAISE EXCEPTION 'the series did not start at MIDWAY-2026-000001';
  END IF;
END
$assert$;

DO $credit_test$
DECLARE
  v_inv settlement_invoices%ROWTYPE;
  v_res jsonb; v_msg text; v_raised boolean; v_cn_id uuid; v_orig_net numeric;
BEGIN
  BEGIN
    SELECT * INTO v_inv FROM settlement_invoices
     WHERE invoice_type='union_weekly_squareup' ORDER BY invoice_number LIMIT 1;
    v_orig_net := v_inv.net_amount;

    IF public.fn_next_invoice_number(
         (v_inv.breakdown->>'union_id')::uuid, now()) !~ '^MIDWAY-2026-[0-9]{6}$' THEN
      RAISE EXCEPTION 'FIXTURE_FAIL invoice number format is wrong';
    END IF;

    v_res := public.fn_union_issue_credit_note(v_inv.id, 100.00, 'fixture: partial correction', false);
    v_cn_id := (v_res->>'credit_note_id')::uuid;
    IF (v_res->>'remaining_after')::numeric <> round(v_orig_net - 100.00, 2) THEN
      RAISE EXCEPTION 'FIXTURE_FAIL remaining_after wrong: %', v_res::text;
    END IF;
    IF (SELECT net_amount FROM settlement_invoices WHERE id = v_inv.id) <> v_orig_net THEN
      RAISE EXCEPTION 'FIXTURE_FAIL the original invoice was modified';
    END IF;
    IF (SELECT adjusts_invoice_id FROM settlement_invoices WHERE id = v_cn_id) <> v_inv.id THEN
      RAISE EXCEPTION 'FIXTURE_FAIL the credit note does not reference its original';
    END IF;
    IF (SELECT from_entity_type FROM settlement_invoices WHERE id = v_cn_id) <> v_inv.to_entity_type THEN
      RAISE EXCEPTION 'FIXTURE_FAIL the credit note does not reverse the direction';
    END IF;

    v_raised := false;
    BEGIN
      PERFORM public.fn_union_issue_credit_note(v_inv.id, v_orig_net, 'fixture: too much', false);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      v_raised := v_msg LIKE 'credit note of % exceeds%';
    END;
    IF NOT v_raised THEN RAISE EXCEPTION 'FIXTURE_FAIL over-crediting was allowed'; END IF;

    v_raised := false;
    BEGIN
      PERFORM public.fn_union_issue_credit_note(v_cn_id, 1.00, 'fixture: credit a credit', false);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      v_raised := v_msg LIKE 'only a weekly square-up can be credited%';
    END;
    IF NOT v_raised THEN RAISE EXCEPTION 'FIXTURE_FAIL a credit note was credited'; END IF;

    v_raised := false;
    BEGIN
      PERFORM public.fn_union_issue_credit_note(v_inv.id, 1.00, '   ', false);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      v_raised := v_msg LIKE 'a credit note must carry a reason%';
    END;
    IF NOT v_raised THEN RAISE EXCEPTION 'FIXTURE_FAIL a credit note without a reason was allowed'; END IF;

    RAISE EXCEPTION 'FIXTURE_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg <> 'FIXTURE_ROLLBACK' THEN
      RAISE EXCEPTION 'credit note test failed: %', v_msg;
    END IF;
  END;
END
$credit_test$;

COMMIT;
