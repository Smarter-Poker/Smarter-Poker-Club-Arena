-- THE GRANT IS THE GATE ON THE PROMO PAYOUT, NOT THE CALLER'S JWT.
--
-- fn_bbj_promo_payout_atomic opened with:
--
--     IF auth.role() = 'authenticated' THEN RAISE EXCEPTION 'Unauthorized'; END IF;
--
-- fn_bbj_promo_rain is SECURITY DEFINER and delegates to it, and its own
-- comment says the delegation makes "the raw RPC's revoked authenticated grant
-- irrelevant". That is true of the GRANT and false of this check:
-- SECURITY DEFINER changes the database role, not the request's JWT, so
-- auth.role() still reads 'authenticated' for an owner pressing the button.
-- Every owner-pressed rain has therefore died on 'Unauthorized' before it
-- reached a single line of money code - proven by a rolled-back probe as the
-- union owner, which got exactly that.
--
-- So the check has never protected anything a REVOKE was not already
-- protecting, and it has blocked the one path that is meant to use this
-- function. authenticated and anon hold no EXECUTE grant here: a browser
-- cannot call it directly, and the only way in is through a definer that has
-- already established who is asking. fn_bbj_promo_rain checks the pool's owner
-- or a god/admin profile before it delegates.
--
-- The grant is the gate. Nothing else about the function changes.

CREATE OR REPLACE FUNCTION public.fn_bbj_promo_payout_atomic(
  p_pool_id uuid,
  p_amount numeric,
  p_recipient_user_ids uuid[],
  p_reason text DEFAULT NULL::text,
  p_event_type text DEFAULT 'custom'::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_pool record; v_count int; v_total_cents bigint; v_base_cents bigint;
  v_remainder_cents bigint; v_uid uuid; v_idx int := 0; v_amt numeric;
  v_club uuid; v_paid numeric := 0; v_skipped int := 0;
  v_op_key text;
  v_claimed integer;
  v_union uuid;
  v_float numeric;
  v_after numeric;
BEGIN
  /* The GRANT is the gate: anon and authenticated hold no EXECUTE here, so the
     only callers are service_role and the definers that have already
     established who is asking (fn_bbj_promo_rain checks the pool's owner or a
     god/admin profile). The old auth.role() test blocked those definers too,
     because SECURITY DEFINER changes the database role and not the JWT. */
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN jsonb_build_object('success', true, 'skipped', 'zero_amount'); END IF;
  IF p_recipient_user_ids IS NULL OR array_length(p_recipient_user_ids,1) IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_recipients'); END IF;
  v_count := array_length(p_recipient_user_ids, 1);

  /* ZERO-DRIFT (2026-08-31): idempotency. One payout per
     (pool, event, reason, recipient set, amount) - a retried call returns
     without draining the float twice. */
  v_op_key := 'bbjpromo:' || p_pool_id::text || ':' || p_event_type || ':'
           || COALESCE(p_reason,'') || ':' || p_amount::text || ':'
           || md5(array_to_string(p_recipient_user_ids, ','));
  INSERT INTO public.wallet_credit_idempotency (key, user_id, amount)
  VALUES (left(v_op_key, 255), p_recipient_user_ids[1], p_amount)
  ON CONFLICT (key) DO NOTHING;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    RETURN jsonb_build_object('success', true, 'already_paid', true);
  END IF;

  SELECT * INTO v_pool FROM bbj_pools WHERE id = p_pool_id FOR UPDATE;
  IF v_pool.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'pool_not_found'); END IF;

  /* THE PURSE (2026-09-03, Dan's ruling 3): the promo float, which is where the
     hourly sweep puts this money - the union's promo_wallet when the pool
     belongs to a union, otherwise the standalone club's promo_balance. The pool
     is the occasion, not the purse. */
  v_union := v_pool.union_id;

  IF v_union IS NOT NULL THEN
    SELECT COALESCE(promo_wallet, 0) INTO v_float
      FROM union_wallets WHERE union_id = v_union FOR UPDATE;
  ELSIF v_pool.club_id IS NOT NULL THEN
    SELECT COALESCE(promo_balance, 0) INTO v_float
      FROM clubs WHERE id = v_pool.club_id FOR UPDATE;
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'pool_has_no_owner');
  END IF;

  IF COALESCE(v_float, 0) < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_promo_balance',
                              'available', COALESCE(v_float, 0), 'requested', p_amount);
  END IF;

  /* One declaration for the whole rain: the float is the counterparty and its
     own table is skipped, so each player's credit writes the single row that
     names both sides. */
  IF v_union IS NOT NULL THEN
    PERFORM public.fn_ca_declare_ledger('promo', 'union_wallet', v_union, NULL,
                                        'promo_rain:' || left(v_op_key, 180), ARRAY['union_wallets']);
    UPDATE union_wallets
       SET promo_wallet = promo_wallet - p_amount, updated_at = now()
     WHERE union_id = v_union
     RETURNING round(promo_wallet, 2) INTO v_after;
  ELSE
    PERFORM public.fn_ca_declare_ledger('promo', 'promo_wallet', v_pool.club_id, NULL,
                                        'promo_rain:' || left(v_op_key, 180), ARRAY['clubs']);
    UPDATE clubs
       SET promo_balance = promo_balance - p_amount, updated_at = now()
     WHERE id = v_pool.club_id
     RETURNING round(promo_balance, 2) INTO v_after;
  END IF;

  v_total_cents := round(p_amount * 100); v_base_cents := v_total_cents / v_count;
  v_remainder_cents := v_total_cents - v_base_cents * v_count;

  FOREACH v_uid IN ARRAY p_recipient_user_ids LOOP
    v_amt := (v_base_cents + (CASE WHEN v_idx = 0 THEN v_remainder_cents ELSE 0 END))::numeric / 100;

    /* ORDINARY CHIPS (Dan, 2026-09-03, ruling 4B). The old body credited
       club_members.promo_balance, a locked bucket; before that it paid
       wallets(PROMO), a pool nothing reads. Promo chips are the same chips. */
    v_club := COALESCE(v_pool.club_id, public.fn_player_home_club(v_uid, NULL));
    IF v_club IS NOT NULL AND EXISTS (
         SELECT 1 FROM club_members m WHERE m.user_id = v_uid AND m.club_id = v_club) THEN
      UPDATE club_members
         SET chip_balance = COALESCE(chip_balance, 0) + v_amt,
             updated_at = NOW()
       WHERE user_id = v_uid AND club_id = v_club;
      INSERT INTO chip_transactions (club_id, to_user_id, amount, transaction_type, notes)
      VALUES (v_club, v_uid, v_amt, 'bbj_promo_payout',
              COALESCE(p_reason, 'BBJ promo pool payout') || ' (' || p_event_type || ')');
      v_paid := v_paid + v_amt;
    ELSE
      v_skipped := v_skipped + 1;
      INSERT INTO financial_alerts (severity, source, message, context)
      VALUES ('critical', 'fn_bbj_promo_payout_atomic',
              'BBJ promo payout recipient has no club wallet - share NOT paid, returned to the float',
              jsonb_build_object('pool_id', p_pool_id, 'user_id', v_uid, 'amount', v_amt));
      IF v_union IS NOT NULL THEN
        UPDATE union_wallets SET promo_wallet = promo_wallet + v_amt, updated_at = now()
         WHERE union_id = v_union RETURNING round(promo_wallet, 2) INTO v_after;
      ELSE
        UPDATE clubs SET promo_balance = promo_balance + v_amt, updated_at = now()
         WHERE id = v_pool.club_id RETURNING round(promo_balance, 2) INTO v_after;
      END IF;
    END IF;
    v_idx := v_idx + 1;
  END LOOP;

  PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);
  PERFORM set_config('app.ledger_autoskip_clubs', '', true);

  RETURN jsonb_build_object('success', true, 'amount', v_paid, 'recipient_count', v_count - v_skipped,
                            'skipped', v_skipped, 'event_type', p_event_type, 'reason', p_reason,
                            'float_after', v_after, 'lands_as', 'ordinary_chips');
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_bbj_promo_payout_atomic(uuid, numeric, uuid[], text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_promo_payout_atomic(uuid, numeric, uuid[], text, text)
  TO service_role;