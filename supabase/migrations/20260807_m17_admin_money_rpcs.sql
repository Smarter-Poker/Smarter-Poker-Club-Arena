-- ============================================================================
-- AUDIT M17 (parts 2-6) — the remaining five browser-side credit call sites
-- ============================================================================
--
-- M17 part 1 (fn_claim_special_bonus) established the rule. This migration
-- applies it to everything that is left:
--
--   a SECURITY DEFINER money function must READ its amount from authoritative
--   state and ENFORCE its own authorization. Never both DEFINER and
--   caller-supplied.
--
-- Five call sites, each replaced by one purpose-built function that owns its
-- whole transaction. In every case the client previously did the same thing:
-- two or more independent round trips, with a generic "credit any amount" RPC
-- at the end that RLS silently refused. None of them could ever have worked,
-- and each would have become a mint the moment someone widened the grant.
--
--   TableService.kickPlayer          -> fn_admin_kick_player
--   TableService.closeTable          -> fn_admin_close_table
--   TournamentRegistration remove    -> fn_admin_remove_tournament_player
--   DisputeService.resolveDispute    -> fn_resolve_dispute
--   CreditService.processPayment     -> fn_pay_credit_invoice_from_wallet
--
-- WHAT THE PROBES FOUND ALONG THE WAY
--
--   * force_close_table_and_refund, which closeTable calls as its PRIMARY path,
--     takes THREE arguments (uuid, uuid, text). The client passes one. So the
--     primary path was a signature error, not just a permission error — and it
--     is granted to postgres/service_role only anyway. Both halves of that
--     function were dead, which is why the "fallback" ran every time.
--
--   * atomic_deduct_wallet_and_log is granted to postgres/service_role only, so
--     CreditService.processPayment's STEP 1 throws before anything else runs.
--     Its careful compensating-rollback at the end was therefore unreachable by
--     precondition. The fix is not to repair the rollback: it is to put the
--     deduct and the invoice update in ONE transaction, where there is nothing
--     to compensate for because they cannot diverge.
--
-- ON DISPUTE ADJUSTMENTS, WHICH ARE THE ONE HONEST EXCEPTION
-- An adjustment amount is genuinely a human decision — an admin looks at a
-- dispute and decides what to pay. It cannot be derived from state the way a
-- seat stack or a bonus reward can. So this one keeps a caller-supplied amount,
-- and is made safe by two other means instead: it requires club-admin authority
-- over the dispute's own club, and it CLAMPS the adjustment to the amount in
-- dispute. An adjustment larger than the disputed sum is not a resolution, it
-- is a transfer, and it should go through a path that says so.
-- ============================================================================

-- ─── 1. Admin kicks a seated player ─────────────────────────────────────────
-- Was: read seat -> credit seat.stack -> mark seat left. Three round trips, the
-- middle one permission-denied, and TableOperationsPanel discarded the boolean
-- return so the failure was invisible.
CREATE OR REPLACE FUNCTION public.fn_admin_kick_player(
  p_table_id uuid,
  p_user_id  uuid,
  p_reason   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid     uuid := auth.uid();
  v_club    uuid;
  v_seat    public.table_seats%ROWTYPE;
  v_amount  numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_admin_kick_player requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;

  SELECT club_id INTO v_club FROM public.tables WHERE id = p_table_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;

  IF NOT public.is_club_admin(v_club) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  -- Lock the occupancy row. Everything below reads from it, never from the
  -- caller, so a kick cannot pay out more than the player actually had.
  SELECT * INTO v_seat
  FROM public.table_seats
  WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_seated');
  END IF;

  v_amount := COALESCE(v_seat.stack, 0);

  -- Vacate first, so the seat cannot be double-refunded by a concurrent kick;
  -- the credit below is inside the same transaction, so a failure takes the
  -- vacate with it.
  UPDATE public.table_seats
     SET left_at = now()
   WHERE id = v_seat.id AND left_at IS NULL;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_seated');
  END IF;

  IF v_amount > 0 THEN
    -- Idempotent on the occupancy row id, exactly like the engine's
    -- markSeatAsLeft. Same key shape on purpose: if both paths ever race, the
    -- second one is a no-op instead of a double credit.
    IF NOT public.atomic_credit_wallet_and_log(
         p_user_id,
         v_amount,
         'cashout',
         'Kicked from table: ' || v_amount::text || ' chips returned'
           || COALESCE(' (' || p_reason || ')', ''),
         p_table_id,
         NULL,
         NULL,
         'cashout:' || v_seat.id::text
       ) THEN
      RAISE EXCEPTION 'fn_admin_kick_player: credit failed for seat %', v_seat.id
        USING ERRCODE = '25000';
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'refunded', v_amount, 'seat_id', v_seat.id);
END;
$function$;

-- ─── 2. Admin closes a table and refunds everyone ───────────────────────────
CREATE OR REPLACE FUNCTION public.fn_admin_close_table(p_table_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid       uuid := auth.uid();
  v_club      uuid;
  v_seat      record;
  v_refunded  integer := 0;
  v_total     numeric := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_admin_close_table requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;

  SELECT club_id INTO v_club FROM public.tables WHERE id = p_table_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;

  IF NOT public.is_club_admin(v_club) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  -- Refund BEFORE closing. The old client code closed the table first and then
  -- looped, which is the ordering that would have stranded seats if either half
  -- had actually worked. Here the order barely matters because it is one
  -- transaction — but the safe order costs nothing and reads correctly.
  FOR v_seat IN
    SELECT id, user_id, stack
    FROM public.table_seats
    WHERE table_id = p_table_id AND left_at IS NULL AND COALESCE(stack, 0) > 0
    ORDER BY seat_number
    FOR UPDATE
  LOOP
    IF NOT public.atomic_credit_wallet_and_log(
         v_seat.user_id,
         v_seat.stack,
         'cashout',
         'Table closed: ' || v_seat.stack::text || ' chips returned',
         p_table_id,
         NULL,
         NULL,
         'cashout:' || v_seat.id::text
       ) THEN
      RAISE EXCEPTION 'fn_admin_close_table: credit failed for seat %', v_seat.id
        USING ERRCODE = '25000';
    END IF;

    v_refunded := v_refunded + 1;
    v_total := v_total + v_seat.stack;
  END LOOP;

  UPDATE public.table_seats
     SET left_at = now()
   WHERE table_id = p_table_id AND left_at IS NULL;

  UPDATE public.tables
     SET status = 'closed', current_players = 0, updated_at = now()
   WHERE id = p_table_id;

  RETURN jsonb_build_object(
    'ok', true, 'players_refunded', v_refunded, 'chips_refunded', v_total);
END;
$function$;

-- ─── 3. Admin removes a registered player before a tournament starts ────────
-- The refund is buy_in_amount + buy_in_fee read from the tournaments row. The
-- client used to compute that itself and pass it in, which is the same shape as
-- every other mint in M17.
CREATE OR REPLACE FUNCTION public.fn_admin_remove_tournament_player(
  p_tournament_id uuid,
  p_user_id       uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid    uuid := auth.uid();
  v_t      record;
  v_amount numeric;
  v_rows   integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_admin_remove_tournament_player requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;

  SELECT id, club_id, status, buy_in_amount, buy_in_fee
    INTO v_t
  FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;

  IF NOT public.is_club_admin(v_t.club_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  -- Enforced here rather than in the UI. The client checked this too, but a
  -- check the server does not repeat is a suggestion.
  IF v_t.status NOT IN ('ANNOUNCED', 'REGISTERING') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_already_started');
  END IF;

  DELETE FROM public.tournament_players
   WHERE tournament_id = p_tournament_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_registered');
  END IF;

  v_amount := trunc((COALESCE(v_t.buy_in_amount, 0) + COALESCE(v_t.buy_in_fee, 0)) * 100) / 100;

  IF v_amount > 0 THEN
    IF NOT public.atomic_credit_wallet_and_log(
         p_user_id,
         v_amount,
         'refund',
         'Admin removed from tournament - buy-in refund',
         NULL,
         NULL,
         p_tournament_id,
         'tourn_refund:' || p_tournament_id::text || ':' || p_user_id::text
       ) THEN
      RAISE EXCEPTION 'fn_admin_remove_tournament_player: credit failed for % / %',
        p_tournament_id, p_user_id
        USING ERRCODE = '25000';
    END IF;
  END IF;

  -- The client used to re-INSERT the player when the refund failed, to keep the
  -- tournament consistent. That compensating write is gone because it is no
  -- longer needed: the delete and the credit are one transaction, so a failed
  -- refund un-removes the player by rolling back.
  RETURN jsonb_build_object('ok', true, 'refunded', v_amount);
END;
$function$;

-- ─── 4. Admin resolves a dispute, optionally adjusting the wallet ───────────
CREATE OR REPLACE FUNCTION public.fn_resolve_dispute(
  p_dispute_id        uuid,
  p_resolution        text,
  p_adjustment_type   text    DEFAULT 'none',
  p_adjustment_amount numeric DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid     uuid := auth.uid();
  v_d       public.disputes%ROWTYPE;
  v_amount  numeric;
  v_cap     numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_resolve_dispute requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;

  IF p_adjustment_type IS NULL OR p_adjustment_type NOT IN ('none', 'credit', 'debit') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_adjustment_type');
  END IF;

  SELECT * INTO v_d FROM public.disputes WHERE id = p_dispute_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF NOT public.is_club_admin(v_d.club_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  IF v_d.status = 'resolved' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_resolved');
  END IF;

  v_amount := trunc(COALESCE(p_adjustment_amount, 0) * 100) / 100;

  IF p_adjustment_type <> 'none' AND v_amount > 0 THEN
    IF v_d.submitted_by IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'no_submitter_to_adjust');
    END IF;

    -- THE BOUND. This is the only money function in the set whose amount comes
    -- from the caller, because "what should this dispute pay" is a judgement
    -- rather than a lookup. Capping it at the disputed amount keeps admin
    -- discretion inside the thing being disputed. A NULL or zero disputed
    -- amount means there is no anchor, so no adjustment is allowed at all.
    v_cap := COALESCE(v_d.amount, 0);
    IF v_cap <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'dispute_has_no_amount');
    END IF;

    IF v_amount > v_cap THEN
      RETURN jsonb_build_object(
        'ok', false, 'reason', 'adjustment_exceeds_disputed_amount',
        'cap', v_cap, 'requested', v_amount);
    END IF;
  END IF;

  UPDATE public.disputes
     SET status = 'resolved',
         resolution = p_resolution,
         resolved_at = now(),
         updated_at = now()
   WHERE id = p_dispute_id AND status <> 'resolved';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_resolved');
  END IF;

  IF p_adjustment_type = 'credit' AND v_amount > 0 THEN
    IF NOT public.atomic_credit_wallet_and_log(
         v_d.submitted_by, v_amount, 'dispute_resolution',
         'Dispute ' || p_dispute_id::text || ' resolved: ' || COALESCE(p_resolution, ''),
         NULL, NULL, p_dispute_id,
         'dispute:' || p_dispute_id::text
       ) THEN
      RAISE EXCEPTION 'fn_resolve_dispute: credit failed for %', p_dispute_id
        USING ERRCODE = '25000';
    END IF;

  ELSIF p_adjustment_type = 'debit' AND v_amount > 0 THEN
    IF NOT public.atomic_deduct_wallet_and_log(
         v_d.submitted_by, v_amount, 'dispute_resolution',
         'Dispute ' || p_dispute_id::text || ' resolved: ' || COALESCE(p_resolution, ''),
         NULL, NULL, p_dispute_id
       ) THEN
      -- A debit that cannot be taken (insufficient balance) must not leave the
      -- dispute marked resolved, or the adjustment is silently forgiven.
      RAISE EXCEPTION 'fn_resolve_dispute: debit failed for % (insufficient balance?)',
        p_dispute_id
        USING ERRCODE = '25000';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'adjustment_type', p_adjustment_type, 'amount', v_amount);
END;
$function$;

-- ─── 5. Pay a credit invoice from the agent's wallet ────────────────────────
-- The old client sequence was deduct -> apply -> compensating-credit-on-failure.
-- The compensating leg existed because the two writes were separate round trips
-- that could diverge. Inside one transaction they cannot, so the rollback is
-- deleted rather than fixed: there is nothing to compensate for.
CREATE OR REPLACE FUNCTION public.fn_pay_credit_invoice_from_wallet(
  p_invoice_id uuid,
  p_amount     numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid      uuid := auth.uid();
  v_agent    uuid;
  v_agent_u  uuid;
  v_amount   numeric;
  v_apply    jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_pay_credit_invoice_from_wallet requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;

  v_amount := trunc(COALESCE(p_amount, 0) * 100) / 100;
  IF v_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'non_positive_amount');
  END IF;

  SELECT agent_id INTO v_agent FROM public.credit_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invoice_not_found');
  END IF;

  SELECT user_id INTO v_agent_u FROM public.agents WHERE id = v_agent;
  IF v_agent_u IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'agent_user_not_found');
  END IF;

  -- Authorization: the wallet being drained must belong to the caller. An admin
  -- paying someone else's invoice from that person's wallet is a different
  -- operation and does not belong on this path.
  IF v_agent_u <> v_uid THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_your_wallet');
  END IF;

  IF NOT public.atomic_deduct_wallet_and_log(
       v_agent_u, v_amount, 'settlement',
       'Credit invoice payment: ' || p_invoice_id::text,
       NULL, NULL, p_invoice_id
     ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_balance');
  END IF;

  v_apply := public.fn_apply_credit_payment(p_invoice_id, v_amount, 'wallet');

  IF v_apply IS NULL OR COALESCE((v_apply->>'success')::boolean, false) = false THEN
    -- Raise, do not compensate. The deduct above is in this transaction and
    -- rolls back with it.
    RAISE EXCEPTION 'fn_pay_credit_invoice_from_wallet: apply failed for %: %',
      p_invoice_id, COALESCE(v_apply->>'error', 'unknown')
      USING ERRCODE = '25000';
  END IF;

  RETURN jsonb_build_object('ok', true, 'amount', v_amount, 'payment', v_apply->'payment');
END;
$function$;

-- ─── Grants ─────────────────────────────────────────────────────────────────
-- `anon` is named explicitly every time: Supabase's ALTER DEFAULT PRIVILEGES
-- grants EXECUTE on new public functions to `anon` BY NAME, so revoking from
-- PUBLIC alone leaves it in place (the trap already hit in M7).
DO $grants$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.fn_admin_kick_player(uuid,uuid,text)',
    'public.fn_admin_close_table(uuid)',
    'public.fn_admin_remove_tournament_player(uuid,uuid)',
    'public.fn_resolve_dispute(uuid,text,text,numeric)',
    'public.fn_pay_credit_invoice_from_wallet(uuid,numeric)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END
$grants$;

COMMENT ON FUNCTION public.fn_admin_kick_player(uuid,uuid,text) IS
  'AUDIT M17: club-admin kick. Refund is the seat stack, read server-side; '
  'idempotent on the occupancy row id, same key shape as the engine''s '
  'markSeatAsLeft. Never add an amount parameter.';

COMMENT ON FUNCTION public.fn_admin_close_table(uuid) IS
  'AUDIT M17: club-admin table close. Refunds every seated player their actual '
  'stack and closes the table in one transaction. Replaces a client loop whose '
  'credits were all permission-denied.';

COMMENT ON FUNCTION public.fn_admin_remove_tournament_player(uuid,uuid) IS
  'AUDIT M17: club-admin pre-start removal. Refund is buy_in_amount + '
  'buy_in_fee read from the tournaments row, never from the caller.';

COMMENT ON FUNCTION public.fn_resolve_dispute(uuid,text,text,numeric) IS
  'AUDIT M17: club-admin dispute resolution. The one function in the set with a '
  'caller-supplied amount, because the figure is a judgement rather than a '
  'lookup - made safe by club-admin authority plus a hard cap at the disputed '
  'amount. Do not remove the cap.';

COMMENT ON FUNCTION public.fn_pay_credit_invoice_from_wallet(uuid,numeric) IS
  'AUDIT M17: deduct + apply in ONE transaction, so the compensating-credit '
  'rollback the client used to carry is unnecessary. Only the wallet owner may '
  'call it.';
