-- Weekly invoice payment acknowledgement must account for every cent.
-- Reproduced 99.99 / 100 being marked paid; actual-function pg_temp rollback
-- probe verifies both directions, remainder/default replay, reversal history
-- and malformed payment rejection. This records acknowledgements only; it
-- does not move chips, rewrite historical invoices or add a repair job.
CREATE OR REPLACE FUNCTION public.ca_union_set_statement_paid(p_invoice_id uuid, p_paid boolean DEFAULT true, p_amount numeric DEFAULT NULL::numeric, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid      uuid := auth.uid();
  v_inv      settlement_invoices%ROWTYPE;
  v_union    uuid;
  v_owed     numeric;
  v_prev     numeric;
  v_add      numeric;
  v_total    numeric;
  v_status   text;
  v_payments jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'sign in required' USING ERRCODE = '42501';
  END IF;

  -- lock the row: two union admins clicking at once must not both read the
  -- same paid_total and each add their payment to it
  SELECT * INTO v_inv FROM settlement_invoices
   WHERE id = p_invoice_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'statement not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_inv.invoice_type <> 'union_weekly_squareup' THEN
    RAISE EXCEPTION 'not a weekly square-up statement' USING ERRCODE = '22023';
  END IF;

  SELECT uc.union_id INTO v_union FROM union_clubs uc WHERE uc.club_id = v_inv.club_id LIMIT 1;
  IF v_union IS NULL OR NOT ca_can_oversee_union(v_union) THEN
    RAISE EXCEPTION 'not authorized for this union' USING ERRCODE = '42501';
  END IF;

  IF v_inv.status = 'cancelled' THEN
    RAISE EXCEPTION 'this statement was cancelled' USING ERRCODE = '22023';
  END IF;

  -- the amount owed is an absolute: a statement where the union owes the club
  -- is settled by the same act of paying it, in the other direction
  v_owed     := abs(COALESCE(v_inv.net_amount, 0));
  v_prev     := COALESCE((v_inv.breakdown->>'paid_total')::numeric, 0);
  v_payments := COALESCE(v_inv.breakdown->'payments', '[]'::jsonb);

  IF p_paid IS NULL THEN
    RAISE EXCEPTION 'payment action is required' USING ERRCODE = '22023';
  END IF;
  IF v_inv.net_amount IS NULL OR EXISTS (
    SELECT 1 FROM unnest(ARRAY[v_inv.net_amount, v_prev]) n
    WHERE n::text IN ('NaN','Infinity','-Infinity') OR n <> round(n,2)
  ) OR v_prev < 0 THEN
    RAISE EXCEPTION 'statement amounts must be finite whole cents' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NOT NULL AND
    (p_amount::text IN ('NaN','Infinity','-Infinity') OR p_amount <= 0 OR p_amount <> round(p_amount,2)) THEN
    RAISE EXCEPTION 'payment amount must be positive finite whole cents' USING ERRCODE = '22023';
  END IF;

  IF p_paid THEN
    -- no amount given means "settled in full", which is the common case and
    -- should not require the caller to restate a number the row already holds
    v_add   := COALESCE(p_amount, GREATEST(v_owed - v_prev, 0));
    IF v_add <= 0 AND v_prev >= v_owed THEN
      RETURN jsonb_build_object(
        'success', true, 'already_settled', true,
        'invoice_id', p_invoice_id, 'status', v_inv.status,
        'paid_total', v_prev, 'owed', v_owed);
    END IF;
    v_total := round(v_prev + GREATEST(v_add, 0), 2);
    -- A short payment remains outstanding down to the last cent.
    v_status := CASE WHEN v_total >= v_owed THEN 'paid'
      WHEN v_inv.status = 'paid' THEN 'generated' ELSE v_inv.status END;
    v_payments := v_payments || jsonb_build_object(
      'amount', round(GREATEST(v_add, 0), 2),
      'at', now(),
      'by', v_uid,
      'note', NULLIF(btrim(COALESCE(p_note, '')), ''));
  ELSE
    -- reopening: mistakes get made, and a statement that can only ever move
    -- one way turns a misclick into a permanent falsehood in the record. The
    -- payment history is kept, with the reversal appended to it.
    v_total  := 0;
    v_status := 'generated';
    v_payments := v_payments || jsonb_build_object(
      'amount', 0, 'reversal', true, 'at', now(), 'by', v_uid,
      'note', NULLIF(btrim(COALESCE(p_note, '')), ''));
  END IF;

  UPDATE settlement_invoices
     SET status     = v_status,
         updated_at = now(),
         breakdown  = COALESCE(breakdown, '{}'::jsonb) || jsonb_build_object(
           'paid_total', v_total,
           'paid_at',    CASE WHEN v_status = 'paid' THEN now() ELSE NULL END,
           'paid_by',    CASE WHEN v_status = 'paid' THEN v_uid  ELSE NULL END,
           'payments',   v_payments)
   WHERE id = p_invoice_id;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_id', p_invoice_id,
    'status', v_status,
    'paid_total', v_total,
    'owed', v_owed,
    'fully_settled', (v_status = 'paid'));
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_union_set_statement_paid(uuid,boolean,numeric,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ca_union_set_statement_paid(uuid,boolean,numeric,text) TO authenticated,service_role;
