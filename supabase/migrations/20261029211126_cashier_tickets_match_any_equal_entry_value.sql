-- Owner 2026-10-29: grant a value (10,25,40...), usable for any same-value buy-in.
-- Existing event-bound receipts retain their original contract and replay identity.
-- No table, wallet, ticket or historical entitlement is rewritten.
-- @live-proof: exact installed bodies/ACLs and read-only value-match selection.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='8s';
DO $preimage$ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_ca_find_cashier_entry_ticket_for(uuid,uuid)'::regprocedure) IS DISTINCT FROM '7d554e24704fff5b923842a5e8303b73' THEN RAISE EXCEPTION 'VALUE_TICKET_PREIMAGE_CHANGED: fn_ca_find_cashier_entry_ticket_for'; END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_ca_use_cashier_entry_ticket(uuid,uuid,uuid)'::regprocedure) IS DISTINCT FROM '94b42a0cabdfc309bdb67a4e387fe2dc' THEN RAISE EXCEPTION 'VALUE_TICKET_PREIMAGE_CHANGED: fn_ca_use_cashier_entry_ticket'; END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_horse_tournament_entry_ticket_hints(uuid)'::regprocedure) IS DISTINCT FROM '28d1bb7725626dc3a8c5f8765f64b6be' THEN RAISE EXCEPTION 'VALUE_TICKET_PREIMAGE_CHANGED: fn_horse_tournament_entry_ticket_hints'; END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_register_for_tournament_with_ticket_before_terminal_gate(uuid,uuid)'::regprocedure) IS DISTINCT FROM '55a5c8d23cbf01f8788141fb3ffba24b' THEN RAISE EXCEPTION 'VALUE_TICKET_PREIMAGE_CHANGED: fn_register_for_tournament_with_ticket_before_terminal_gate'; END IF;
END $preimage$;

CREATE OR REPLACE FUNCTION public.fn_ca_use_cashier_entry_ticket(p_tournament_id uuid, p_ticket_id uuid, p_beneficiary_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := p_beneficiary_id;
  v_t public.tournaments%ROWTYPE;
  v_tk public.tournament_tickets%ROWTYPE;
  v_bind public.tournament_ticket_entry_targets%ROWTYPE;
  v_split record;
  v_is_bounty boolean;
  v_is_horse boolean;
  v_before numeric;
  v_after_credit numeric;
  v_after numeric;
  v_context jsonb;
  v_setting text;
  v_prev_paying text := current_setting('app.ca_entry_paying_club', true);
  v_result jsonb;
  v_reason text;
  v_registration uuid;
  v_receipt uuid;
BEGIN
  IF p_tournament_id IS NULL OR p_ticket_id IS NULL OR v_uid IS NULL THEN
    RAISE EXCEPTION 'tournament, ticket and beneficiary ids are required'
      USING ERRCODE = '22004';
  END IF;

  -- The satellite ticket door's lock order: settlement lane, the shared
  -- admission lock, the admission contract, the tournament, then the ticket.
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  PERFORM pg_advisory_xact_lock_shared(530090,1);
  PERFORM public.fn_ca_lock_mtt_admission_contract();
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok',false,'reason','platform_frozen');
  END IF;
  SELECT * INTO v_t FROM public.tournaments t WHERE t.id = p_tournament_id FOR UPDATE;
  IF v_t.id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  SELECT * INTO v_tk FROM public.tournament_tickets tk WHERE tk.id = p_ticket_id FOR UPDATE;
  IF v_tk.id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_not_found');
  END IF;
  SELECT * INTO v_bind FROM public.tournament_ticket_entry_targets b
   WHERE b.ticket_id = v_tk.id;
  IF v_bind.ticket_id IS NULL THEN
    -- A value ticket has no event binding. Price it against the selected
    -- event now, under the same event/ticket locks, without persisting a bind.
    -- This cannot convert satellite/refund entitlements or Diamonds to chips.
    IF v_tk.redemption_mode IS DISTINCT FROM 'wallet_chips'
       OR v_tk.source_tournament_id IS NOT NULL
       OR v_tk.source_refund_entitlement_id IS NOT NULL
       OR public.fn_ca_tournament_unit_cents(p_tournament_id) IS DISTINCT FROM 1 THEN
      RETURN jsonb_build_object('ok',false,'reason','not_a_cashier_entry_ticket');
    END IF;
    v_is_bounty := COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
                OR COALESCE(v_t.is_mystery_bounty,false);
    SELECT * INTO v_split FROM public.fn_tournament_entry_split(
      v_t.buy_in_amount,v_t.buy_in_fee,v_t.bounty_amount,v_is_bounty);
    IF v_tk.value IS DISTINCT FROM v_split.charge THEN
      RETURN jsonb_build_object('ok',false,'reason','ticket_entry_contract_mismatch');
    END IF;
    v_bind.ticket_id:=v_tk.id;
    v_bind.tournament_id:=p_tournament_id;
    v_bind.holder_id:=v_tk.holder_id;
    v_bind.club_id:=v_tk.club_id;
    v_bind.issued_by:=v_tk.issued_by;
    v_bind.value:=v_tk.value;
    v_bind.entry_prize:=v_split.prize;
    v_bind.entry_bounty:=v_split.bounty;
    v_bind.entry_fee:=v_split.rake;
  END IF;
  IF v_tk.holder_id IS DISTINCT FROM v_uid OR v_bind.holder_id IS DISTINCT FROM v_uid THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_not_owned');
  END IF;
  IF v_bind.tournament_id IS DISTINCT FROM p_tournament_id THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_for_another_tournament');
  END IF;
  IF v_tk.redemption_mode IS DISTINCT FROM 'wallet_chips'
     OR v_tk.club_id IS DISTINCT FROM v_bind.club_id
     OR v_tk.issued_by IS DISTINCT FROM v_bind.issued_by
     OR v_tk.value IS DISTINCT FROM v_bind.value THEN
    RAISE EXCEPTION 'cashier entry ticket % does not match its binding', v_tk.id
      USING ERRCODE = 'P0404';
  END IF;

  IF v_tk.status = 'redeemed' THEN
    -- An ambiguous-response retry: the entry already happened.
    SELECT ct.id INTO v_receipt FROM public.chip_transactions ct
     WHERE ct.transaction_type = 'tournament_ticket_redeem'
       AND ct.metadata->>'ticket_id' = v_tk.id::text
       AND ct.metadata->>'reason' = 'tournament_entry'
       AND ct.metadata->>'target_tournament_id' = p_tournament_id::text
     LIMIT 1;
    SELECT tp.id INTO v_registration FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id AND tp.user_id = v_uid
     ORDER BY tp.registered_at DESC NULLS LAST LIMIT 1;
    IF v_receipt IS NOT NULL AND v_registration IS NOT NULL THEN
      RETURN jsonb_build_object('ok',true,'replayed',true,'ticket_id',v_tk.id,
        'registration_id',v_registration,'ticket_value',v_tk.value,
        'wallet_chips_credited',0);
    END IF;
    RETURN jsonb_build_object('ok',false,'reason','ticket_already_used');
  END IF;
  IF v_tk.status <> 'issued' THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_not_available');
  END IF;

  v_is_bounty := COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
              OR COALESCE(v_t.is_mystery_bounty,false);
  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount, v_t.buy_in_fee, v_t.bounty_amount, v_is_bounty);
  IF v_split.charge IS DISTINCT FROM v_bind.value
     OR v_split.prize IS DISTINCT FROM v_bind.entry_prize
     OR v_split.bounty IS DISTINCT FROM v_bind.entry_bounty
     OR v_split.rake IS DISTINCT FROM v_bind.entry_fee THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_entry_contract_mismatch');
  END IF;
  IF public.fn_tournament_club_for_user(v_uid, p_tournament_id, v_tk.club_id)
       IS DISTINCT FROM v_tk.club_id THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_source_club_unavailable');
  END IF;

  SELECT COALESCE(p.is_horse,false) INTO v_is_horse FROM public.profiles p WHERE p.id = v_uid;
  v_is_horse := COALESCE(v_is_horse,false);
  IF NOT v_is_horse AND auth.uid() IS DISTINCT FROM v_uid THEN
    -- A person is entered only by their own session; a horse has no browser
    -- and is entered by the engine (CLAUDE.md 10.5, the input device).
    RAISE EXCEPTION 'a cashier entry ticket is used by its own holder'
      USING ERRCODE = '42501';
  END IF;

  SELECT m.chip_balance INTO v_before FROM public.club_members m
   WHERE m.club_id = v_tk.club_id AND m.user_id = v_uid
     AND COALESCE(m.status,'active') IN ('active','approved')
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_club_membership_inactive');
  END IF;
  v_before := COALESCE(v_before,0);

  BEGIN
    -- (a) Escrow -> the holder's wallet in the ticket's club, journaled and
    --     receipted exactly as fn_redeem_tournament_ticket does it.
    SELECT jsonb_object_agg(k,COALESCE(current_setting(k,true),'')) INTO v_context
      FROM unnest(ARRAY['app.ledger_category','app.ledger_counterparty',
                        'app.ledger_counterparty_entity','app.ledger_tournament']) settings(k);
    PERFORM set_config('app.ledger_tournament','',true);
    PERFORM set_config('app.ledger_category','ticket_redeem',true);
    PERFORM set_config('app.ledger_counterparty','escrow',true);
    PERFORM set_config('app.ledger_counterparty_entity',v_tk.id::text,true);
    UPDATE public.club_members
       SET chip_balance = COALESCE(chip_balance,0) + v_tk.value, updated_at = now()
     WHERE club_id = v_tk.club_id AND user_id = v_uid
       AND COALESCE(status,'active') IN ('active','approved')
     RETURNING chip_balance INTO v_after_credit;
    FOR v_setting IN SELECT jsonb_object_keys(v_context) LOOP
      PERFORM set_config(v_setting,v_context->>v_setting,true);
    END LOOP;
    IF v_after_credit IS DISTINCT FROM round(v_before + v_tk.value,2) THEN
      RAISE EXCEPTION 'cashier entry ticket % credit did not land exactly', v_tk.id
        USING ERRCODE = 'P0404';
    END IF;
    UPDATE public.tournament_tickets
       SET status = 'redeemed', redeemed_at = now()
     WHERE id = v_tk.id AND status = 'issued';
    INSERT INTO public.chip_transactions(
      club_id,from_user_id,to_user_id,amount,transaction_type,notes,
      balance_after,metadata)
    VALUES(
      v_tk.club_id,NULL,v_uid,v_tk.value,'tournament_ticket_redeem',
      'Tournament Ticket Used For Entry',v_after_credit,
      jsonb_build_object(
        'ticket_id',v_tk.id,'issuer_id',v_tk.issued_by,'holder_id',v_uid,
        'escrow_action','release_to_holder','reason','tournament_entry',
        'target_tournament_id',p_tournament_id,
        'holder_balance_after',v_after_credit))
    RETURNING id INTO v_receipt;
    INSERT INTO public.wallet_transactions(
      user_id,wallet_type,type,amount,category,description,balance_after)
    VALUES(
      v_uid,'PLAYER','credit',v_tk.value,'transfer',
      'Tournament Ticket Used For Entry',v_after_credit);

    -- (b) The ordinary entry door, paid from that same wallet.
    PERFORM set_config('app.ca_entry_paying_club',
      p_tournament_id::text||':'||v_uid::text||':'||v_tk.club_id::text, true);
    IF v_is_horse THEN
      v_result := public.fn_register_horse_for_tournament_before_atomic_lifecycle_gate(
        p_tournament_id, v_uid);
    ELSE
      v_result := public.fn_register_for_tournament_before_terminal_seat_gate(
        p_tournament_id, false);
    END IF;
    PERFORM set_config('app.ca_entry_paying_club', COALESCE(v_prev_paying,''), true);
    IF NOT COALESCE((v_result->>'ok')::boolean,false) THEN
      RAISE EXCEPTION USING ERRCODE = 'CT001',
        MESSAGE = COALESCE(NULLIF(v_result->>'reason',''),'registration_refused');
    END IF;

    -- (c) The wallet nets to zero exactly, in the ticket's club, or nothing
    --     happened.
    SELECT m.chip_balance INTO v_after FROM public.club_members m
     WHERE m.club_id = v_tk.club_id AND m.user_id = v_uid;
    SELECT tp.id INTO v_registration FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id AND tp.user_id = v_uid
       AND tp.id = (v_result->>'registration_id')::uuid;
    IF v_after IS DISTINCT FROM v_before OR v_registration IS NULL
       OR (v_result->>'cost')::numeric IS DISTINCT FROM v_tk.value THEN
      RAISE EXCEPTION 'cashier entry ticket % entry was not paid exactly from its own credit (% -> %)',
        v_tk.id, v_before, v_after USING ERRCODE = 'P0404';
    END IF;
  EXCEPTION WHEN SQLSTATE 'CT001' THEN
    v_reason := SQLERRM;
    PERFORM set_config('app.ca_entry_paying_club', COALESCE(v_prev_paying,''), true);
    RETURN jsonb_build_object('ok',false,'reason',v_reason,'ticket_id',v_tk.id);
  END;

  RETURN v_result || jsonb_build_object(
    'ok',true,'replayed',false,'ticket_id',v_tk.id,
    'registration_id',v_registration,'ticket_value',v_tk.value,
    'ticket_kind','cashier_entry_ticket','redeem_transaction_id',v_receipt,
    'wallet_chips_credited',0);
END;
$function$;

ALTER FUNCTION public.fn_ca_use_cashier_entry_ticket(uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_use_cashier_entry_ticket(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_use_cashier_entry_ticket(uuid,uuid,uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_ca_find_cashier_entry_ticket_for(p_tournament_id uuid, p_beneficiary_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_split record;
  v_is_bounty boolean;
  v_tk public.tournament_tickets%ROWTYPE;
BEGIN
  IF p_tournament_id IS NULL OR p_beneficiary_id IS NULL THEN
    RETURN jsonb_build_object('ok',true,'ticket_id',NULL);
  END IF;
  SELECT * INTO v_t FROM public.tournaments t WHERE t.id = p_tournament_id;
  IF v_t.id IS NULL THEN
    RETURN jsonb_build_object('ok',true,'ticket_id',NULL);
  END IF;
  v_is_bounty := COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
              OR COALESCE(v_t.is_mystery_bounty,false);
  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount, v_t.buy_in_fee, v_t.bounty_amount, v_is_bounty);
  /* Exact contract only. If the tournament's price moved after the ticket was
     sent, the ticket does not match, the player enters from their wallet like
     anyone else, and the ticket is paid out when the tournament closes. */
  SELECT tk.* INTO v_tk
    FROM public.tournament_tickets tk
    LEFT JOIN public.tournament_ticket_entry_targets b ON tk.id = b.ticket_id
   WHERE public.fn_ca_tournament_unit_cents(p_tournament_id)=1
     AND (b.ticket_id IS NULL OR (b.tournament_id = p_tournament_id AND b.holder_id = p_beneficiary_id))
     AND tk.holder_id = p_beneficiary_id
     AND tk.status = 'issued'
     AND tk.redemption_mode = 'wallet_chips'
     AND tk.value = v_split.charge
     AND ((b.ticket_id IS NULL AND tk.source_tournament_id IS NULL
           AND tk.source_refund_entitlement_id IS NULL)
       OR (tk.club_id = b.club_id AND tk.issued_by = b.issued_by
           AND tk.value = b.value AND b.entry_prize = v_split.prize
           AND b.entry_bounty = v_split.bounty AND b.entry_fee = v_split.rake))
     AND EXISTS (SELECT 1 FROM public.club_members m
                  WHERE m.club_id = tk.club_id AND m.user_id = p_beneficiary_id
                    AND COALESCE(m.status,'active') IN ('active','approved'))
     AND public.fn_tournament_club_for_user(
           p_beneficiary_id, p_tournament_id, tk.club_id) IS NOT DISTINCT FROM tk.club_id
   ORDER BY (b.ticket_id IS NULL), tk.created_at, tk.id
   LIMIT 1;
  IF v_tk.id IS NULL THEN
    RETURN jsonb_build_object('ok',true,'ticket_id',NULL);
  END IF;
  RETURN jsonb_build_object(
    'ok',true,'ticket_id',v_tk.id,'ticket_value',v_tk.value,
    'entry_prize',v_split.prize,'entry_bounty',v_split.bounty,
    'entry_fee',v_split.rake,'source_satellite_id',NULL,
    'ticket_kind','cashier_entry_ticket');
END;
$function$;

ALTER FUNCTION public.fn_ca_find_cashier_entry_ticket_for(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_find_cashier_entry_ticket_for(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_find_cashier_entry_ticket_for(uuid,uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_register_for_tournament_with_ticket_before_terminal_gate(p_tournament_id uuid, p_ticket_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid:=auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION
      'fn_register_for_tournament_with_ticket requires an authenticated caller'
      USING ERRCODE='28000';
  END IF;
  -- 20261015132042: a cashier ticket bound to one tournament enters through
  -- its own door; every other ticket keeps the satellite admission core.
  IF EXISTS (SELECT 1 FROM public.tournament_ticket_entry_targets b
              WHERE b.ticket_id=p_ticket_id)
     OR EXISTS (SELECT 1 FROM public.tournament_tickets tk
                 WHERE tk.id=p_ticket_id AND tk.redemption_mode='wallet_chips'
                   AND tk.source_tournament_id IS NULL
                   AND tk.source_refund_entitlement_id IS NULL) THEN
    RETURN public.fn_ca_use_cashier_entry_ticket(
      p_tournament_id,p_ticket_id,v_uid);
  END IF;
  RETURN public.fn_ca_register_for_tournament_with_ticket_for(
    p_tournament_id,p_ticket_id,v_uid);
END;
$function$;

ALTER FUNCTION public.fn_register_for_tournament_with_ticket_before_terminal_gate(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_register_for_tournament_with_ticket_before_terminal_gate(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.fn_horse_tournament_entry_ticket_hints(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_split record;
  v_is_bounty boolean;
  v_holder_ids jsonb;
BEGIN
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'tournament id is required' USING ERRCODE='22004';
  END IF;
  SELECT * INTO v_t FROM public.tournaments t WHERE t.id=p_tournament_id;
  IF v_t.id IS NULL THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_not_found','holder_ids','[]'::jsonb);
  END IF;
  v_is_bounty:=COALESCE(v_t.is_bounty,false)
            OR COALESCE(v_t.is_pko,false)
            OR COALESCE(v_t.is_mystery_bounty,false);
  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount,v_t.buy_in_fee,v_t.bounty_amount,v_is_bounty);
  IF v_split.charge IS NULL OR v_split.prize IS NULL
     OR v_split.bounty IS NULL OR v_split.rake IS NULL
     OR v_split.charge::text IN ('NaN','Infinity','-Infinity')
     OR v_split.prize::text IN ('NaN','Infinity','-Infinity')
     OR v_split.bounty::text IN ('NaN','Infinity','-Infinity')
     OR v_split.rake::text IN ('NaN','Infinity','-Infinity')
     OR v_split.charge<0 OR v_split.prize<0
     OR v_split.bounty<0 OR v_split.rake<0
     OR v_split.charge IS DISTINCT FROM
          round(v_split.prize+v_split.bounty+v_split.rake,2) THEN
    RAISE EXCEPTION 'tournament % has no finite ticket contract',p_tournament_id
      USING ERRCODE='P0404';
  END IF;
  IF v_split.charge=0 THEN
    RETURN jsonb_build_object('ok',true,'holder_ids','[]'::jsonb);
  END IF;

  SELECT COALESCE(jsonb_agg(candidate.holder_id ORDER BY candidate.holder_id),
                  '[]'::jsonb)
    INTO v_holder_ids
    FROM (
      SELECT tk.holder_id
        FROM public.tournament_tickets tk
        JOIN public.profiles p ON p.id=tk.holder_id
       WHERE COALESCE(p.is_horse,false)
         AND tk.status='issued'
         AND tk.redemption_mode='tournament_entry_only'
         AND tk.value=v_split.charge
         AND tk.entry_prize=v_split.prize
         AND tk.entry_bounty=v_split.bounty
         AND tk.entry_fee=v_split.rake
         AND (tk.source_refund_entitlement_id IS NOT NULL
              OR tk.source_tournament_id=p_tournament_id)
         AND EXISTS(
           SELECT 1 FROM public.club_members m
            WHERE m.club_id=tk.club_id AND m.user_id=tk.holder_id
              AND COALESCE(m.status,'active') IN ('active','approved'))
         AND (v_t.union_id IS NOT NULL OR v_t.club_id IS NULL OR tk.club_id=v_t.club_id)
         AND (v_t.union_id IS NULL OR tk.club_id=v_t.club_id OR EXISTS(
           SELECT 1 FROM public.union_clubs uc
            WHERE uc.union_id=v_t.union_id AND uc.club_id=tk.club_id))
         AND public.fn_tournament_club_for_user(
               tk.holder_id,p_tournament_id,tk.club_id)
               IS NOT DISTINCT FROM tk.club_id
      UNION
      -- 20261015132042: a horse holding a cashier ticket bound to this
      -- tournament is steered to it exactly as a satellite ticket holder is.
      SELECT b.holder_id
        FROM public.tournament_ticket_entry_targets b
        JOIN public.tournament_tickets tk ON tk.id=b.ticket_id
        JOIN public.profiles p ON p.id=b.holder_id
       WHERE b.tournament_id=p_tournament_id
         AND COALESCE(p.is_horse,false)
         AND tk.status='issued'
         AND tk.holder_id=b.holder_id
         AND b.value=v_split.charge
         AND b.entry_prize=v_split.prize
         AND b.entry_bounty=v_split.bounty
         AND b.entry_fee=v_split.rake
         AND EXISTS(
           SELECT 1 FROM public.club_members m
            WHERE m.club_id=tk.club_id AND m.user_id=tk.holder_id
              AND COALESCE(m.status,'active') IN ('active','approved'))
         AND public.fn_tournament_club_for_user(
               tk.holder_id,p_tournament_id,tk.club_id)
               IS NOT DISTINCT FROM tk.club_id
      UNION
      SELECT tk.holder_id FROM public.tournament_tickets tk
      JOIN public.profiles p ON p.id=tk.holder_id
      WHERE p.is_horse IS TRUE AND tk.status='issued'
        AND tk.redemption_mode='wallet_chips' AND tk.value=v_split.charge
        AND tk.source_tournament_id IS NULL AND tk.source_refund_entitlement_id IS NULL
        AND public.fn_ca_tournament_unit_cents(p_tournament_id)=1
        AND NOT EXISTS (SELECT 1 FROM public.tournament_ticket_entry_targets b WHERE b.ticket_id=tk.id)
        AND EXISTS (SELECT 1 FROM public.club_members m
                    WHERE m.club_id=tk.club_id AND m.user_id=tk.holder_id
                      AND COALESCE(m.status,'active') IN ('active','approved'))
        AND public.fn_tournament_club_for_user(tk.holder_id,p_tournament_id,tk.club_id)
              IS NOT DISTINCT FROM tk.club_id
    ) candidate;
  RETURN jsonb_build_object('ok',true,'holder_ids',v_holder_ids);
END;
$function$;

ALTER FUNCTION public.fn_horse_tournament_entry_ticket_hints(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_horse_tournament_entry_ticket_hints(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_horse_tournament_entry_ticket_hints(uuid) TO service_role;
COMMIT;
