-- live_md5 aedd11231bccabd633d56fa474c5db38
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_refund(p_tournament_id uuid, p_user_id uuid, p_kind text, p_source text, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t record; v_c public.poker_diamond_custody%ROWTYPE; v_parts record;
  v_receipt jsonb; v_key text; v_ledger bigint; v_ob uuid; v_existing public.poker_diamond_tournament_ledger%ROWTYPE;
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL OR p_request_id IS NULL
     OR p_kind IS NULL OR p_kind NOT IN ('unregister','cancel')
     OR p_source IS NULL OR length(btrim(p_source))=0 THEN
    RAISE EXCEPTION 'invalid_diamond_tournament_refund' USING ERRCODE='22023';
  END IF;
  SELECT t.id,t.status,t.started_at,t.name INTO v_t FROM public.tournaments t WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND OR NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE='23514';
  END IF;
  v_key := 'poker-tournament-refund:'||p_tournament_id::text||':'||p_user_id::text||':'||p_kind||':'||p_request_id::text;
  SELECT * INTO v_existing FROM public.poker_diamond_tournament_ledger WHERE idempotency_key=v_key;
  IF FOUND THEN
    RETURN jsonb_build_object('ok',true,'idempotent',true,'fully_settled',true,'remaining',0,
      'paid',v_existing.amount,'refund_prize',v_existing.prize_part,'refund_bounty',v_existing.bounty_part,
      'refund_fee',v_existing.fee_part,'custody_id',v_existing.custody_id,'ledger_id',v_existing.id);
  END IF;

  -- DIAMOND PHASE 9: A DRAWN SPIN IS NOT REFUNDED. Once a Diamond Spin's draw
  -- has written its receipt (and moved its reserve legs), its entries are its
  -- prize pool: every exit - a withdrawal, a seat exit, a cancellation - comes
  -- through this door and is refused here by name, as the chip unregistration
  -- refuses a booked Spin (spin_entry_already_booked). A 3x draw moves no leg,
  -- so the receipt, not the ledger, is what decides.
  IF EXISTS (SELECT 1 FROM public.spin_draw_receipts r WHERE r.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger l
                 WHERE l.tournament_id=p_tournament_id AND l.kind IN ('spin_underwrite','spin_surplus')) THEN
    RAISE EXCEPTION 'diamond_spin_entry_already_booked' USING ERRCODE='55000';
  END IF;
  -- 2026-10-06 (20261007000010): a guaranteed event whose overlay the house
  -- has paid into custody has started; its entries are its prize pool.
  IF EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger l
              WHERE l.tournament_id=p_tournament_id AND l.kind IN ('overlay','overlay_return')) THEN
    RAISE EXCEPTION 'diamond_guaranteed_entry_already_funded' USING ERRCODE='55000';
  END IF;

  -- The roster decides whether this Diamond can go home: before the event
  -- starts a registration may be withdrawn; once it has started only a
  -- cancellation returns entries, and a cancellation returns every entry.
  IF p_kind='unregister' THEN
    IF upper(COALESCE(v_t.status,'')) NOT IN ('ANNOUNCED','REGISTERING') OR v_t.started_at IS NOT NULL THEN
      RAISE EXCEPTION 'diamond_tournament_entry_in_play' USING ERRCODE='55000';
    END IF;
  ELSE
    IF upper(COALESCE(v_t.status,'')) IN ('COMPLETED','COMPLETING') THEN
      RAISE EXCEPTION 'diamond_tournament_already_settled' USING ERRCODE='55000';
    END IF;
  END IF;
  -- An event that has paid anybody is not refundable by this door.
  IF EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger l
              WHERE l.tournament_id=p_tournament_id AND l.kind IN ('prize','bounty','fee')) THEN
    RAISE EXCEPTION 'diamond_tournament_already_paid' USING ERRCODE='55000';
  END IF;

  SELECT * INTO v_c FROM public.poker_diamond_custody
   WHERE user_id=p_user_id AND purpose='tournament_entry' AND target_id=p_tournament_id AND state<>'released'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'diamond_tournament_entry_not_held' USING ERRCODE='55000';
  END IF;
  -- 2026-10-06 (20261007000010): A FREEROLL ENTRY HOLDS NOTHING. Its custody
  -- row was opened at zero (fn_poker_diamond_tournament_free_entry) and has
  -- taken no inflow, so it is released whole, at zero, and no ledger row is
  -- written: there is nothing to return.
  IF v_c.state='active' AND v_c.balance=0 AND v_c.seat_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger l WHERE l.custody_id=v_c.id) THEN
    PERFORM set_config('app.poker_diamond_tournament_release', v_c.id::text, true);
    v_receipt := public.fn_poker_diamond_release(v_c.id, p_request_id);
    PERFORM set_config('app.poker_diamond_tournament_release', '', true);
    IF COALESCE((v_receipt->>'success')::boolean,false) IS NOT TRUE OR (v_receipt->>'amount')::bigint <> 0 THEN
      RAISE EXCEPTION 'diamond_tournament_release_failed' USING ERRCODE='P0404';
    END IF;
    RETURN jsonb_build_object('ok',true,'fully_settled',true,'remaining',0,'paid',0,'free_entry',true,
      'refund_prize',0,'refund_bounty',0,'refund_fee',0,'custody_id',v_c.id,'ledger_id',NULL,
      'obligation_id',NULL,'journal_id',NULL,'available_balance',v_receipt->>'available_balance');
  END IF;
  IF v_c.state<>'active' OR v_c.balance<1 OR v_c.seat_id IS NOT NULL THEN
    RAISE EXCEPTION 'diamond_custody_requires_settlement' USING ERRCODE='55000';
  END IF;
  -- What this custody row holds, by bank: everything that entered it, less
  -- nothing, because nothing has left it (asserted above).
  SELECT COALESCE(sum(prize_part),0) AS prize, COALESCE(sum(bounty_part),0) AS bounty,
         COALESCE(sum(fee_part),0) AS fee, COALESCE(sum(amount),0) AS gross
    INTO v_parts FROM public.poker_diamond_tournament_ledger
   WHERE custody_id=v_c.id AND kind IN ('entry','rebuy','reentry','addon');
  IF v_parts.gross IS DISTINCT FROM v_c.balance THEN
    RAISE EXCEPTION 'diamond_tournament_custody_disagrees_with_ledger' USING ERRCODE='P0404';
  END IF;

  -- Open the release for this one row, in this transaction only, then close it.
  PERFORM set_config('app.poker_diamond_tournament_release', v_c.id::text, true);
  v_receipt := public.fn_poker_diamond_release(v_c.id, p_request_id);
  PERFORM set_config('app.poker_diamond_tournament_release', '', true);
  IF COALESCE((v_receipt->>'success')::boolean,false) IS NOT TRUE
     OR (v_receipt->>'amount')::bigint IS DISTINCT FROM v_c.balance THEN
    RAISE EXCEPTION 'diamond_tournament_release_failed' USING ERRCODE='P0404';
  END IF;

  -- The refund is an obligation the way a chip refund is, so the reconciler
  -- and the receipt see one vocabulary. amount_paid closes at amount_owed.
  INSERT INTO public.tournament_obligations(tournament_id,kind,place,user_id,amount_owed,amount_paid,source,settled_at)
  VALUES (p_tournament_id,'refund',NULL,p_user_id,v_c.balance,v_c.balance,p_source,now())
  ON CONFLICT (tournament_id,kind,user_id) WHERE place IS NULL DO UPDATE
    SET amount_owed = public.tournament_obligations.amount_owed + EXCLUDED.amount_owed,
        amount_paid = public.tournament_obligations.amount_paid + EXCLUDED.amount_paid,
        updated_at = now(), settled_at = now()
  RETURNING id INTO v_ob;

  INSERT INTO public.poker_diamond_tournament_ledger(
    tournament_id,arena_id,user_id,custody_id,kind,amount,prize_part,bounty_part,fee_part,
    idempotency_key,wallet_journal_id,obligation_id,request)
  VALUES (p_tournament_id,v_c.arena_id,p_user_id,v_c.id,'refund',v_c.balance,v_parts.prize,v_parts.bounty,v_parts.fee,
    v_key,NULLIF(v_receipt->>'journal_id','')::uuid,v_ob,
    jsonb_build_object('kind',p_kind,'source',p_source,'request_id',p_request_id))
  RETURNING id INTO v_ledger;

  IF (SELECT prize_balance+bounty_balance+fee_balance FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id))
     IS DISTINCT FROM public.fn_poker_diamond_tournament_custody(p_tournament_id)::numeric THEN
    RAISE EXCEPTION 'diamond_tournament_escrow_disagrees_with_custody' USING ERRCODE='P0404';
  END IF;
  RETURN jsonb_build_object('ok',true,'fully_settled',true,'remaining',0,'paid',v_c.balance,
    'refund_prize',v_parts.prize,'refund_bounty',v_parts.bounty,'refund_fee',v_parts.fee,
    'custody_id',v_c.id,'ledger_id',v_ledger,'obligation_id',v_ob,'journal_id',v_receipt->>'journal_id',
    'available_balance',v_receipt->>'available_balance');
END $function$

