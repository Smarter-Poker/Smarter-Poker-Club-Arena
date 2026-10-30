-- live_md5 76d337b6b86734fb44db277d442afeb9
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_charge(p_user_id uuid, p_tournament_id uuid, p_kind text, p_gross numeric, p_prize numeric, p_bounty numeric, p_fee numeric, p_registration_id uuid, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_arena uuid; v_c public.poker_diamond_custody%ROWTYPE; v_receipt jsonb;
  v_request uuid; v_ledger bigint; v_existing public.poker_diamond_tournament_ledger%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR p_tournament_id IS NULL OR p_idempotency_key IS NULL
     OR p_kind IS NULL OR p_kind NOT IN ('entry','rebuy','reentry','addon')
     OR p_gross IS NULL OR p_prize IS NULL OR p_bounty IS NULL OR p_fee IS NULL
     OR p_gross < 1 OR p_prize < 0 OR p_bounty < 0 OR p_fee < 0
     OR p_gross <> trunc(p_gross) OR p_prize <> trunc(p_prize)
     OR p_bounty <> trunc(p_bounty) OR p_fee <> trunc(p_fee)
     OR p_prize + p_bounty + p_fee <> p_gross THEN
    RAISE EXCEPTION 'diamond_tournament_charge_requires_whole_parts' USING ERRCODE='22023';
  END IF;
  IF p_kind = 'entry' AND p_registration_id IS NULL THEN
    RAISE EXCEPTION 'diamond_tournament_entry_requires_a_registration' USING ERRCODE='22023';
  END IF;
  -- Phase 9: the bounty part is a bank of its own (fn_poker_diamond_tournament_drain
  -- 'bounty'); a knockout bounty event carries one on every entry and re-entry.
  SELECT t.club_id INTO v_arena FROM public.tournaments t JOIN public.clubs c ON c.id=t.club_id
   WHERE t.id=p_tournament_id AND c.asset='diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL AND t.union_id IS NULL;
  IF v_arena IS NULL THEN
    RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE='23514';
  END IF;

  -- The same key twice is the same charge: return what it wrote.
  SELECT * INTO v_existing FROM public.poker_diamond_tournament_ledger WHERE idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF v_existing.user_id<>p_user_id OR v_existing.tournament_id<>p_tournament_id
       OR v_existing.kind<>p_kind OR v_existing.amount<>p_gross THEN
      RAISE EXCEPTION 'idempotency_payload_mismatch';
    END IF;
    RETURN jsonb_build_object('success',true,'idempotent',true,'custody_id',v_existing.custody_id,
      'ledger_id',v_existing.id,'journal_id',v_existing.wallet_journal_id,'amount',v_existing.amount);
  END IF;
  v_request := uuid_in(md5('poker-tournament-charge:'||p_idempotency_key)::cstring);

  SELECT * INTO v_c FROM public.poker_diamond_custody
   WHERE user_id=p_user_id AND purpose='tournament_entry' AND target_id=p_tournament_id AND state<>'released'
   FOR UPDATE;
  IF p_kind = 'entry' THEN
    IF FOUND THEN
      RAISE EXCEPTION 'diamond_tournament_entry_already_held' USING ERRCODE='23505';
    END IF;
    -- The reserve door prices the entry itself (buy-in plus fee, exactly) and
    -- refuses while tournaments_enabled is off. Both refusals surface here.
    v_receipt := public.fn_poker_diamond_reserve(
      p_user_id,'tournament_entry',p_tournament_id,'entry:'||p_registration_id::text,p_gross,v_request);
    IF COALESCE((v_receipt->>'success')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'diamond_tournament_reserve_failed' USING ERRCODE='P0404';
    END IF;
    SELECT * INTO v_c FROM public.poker_diamond_custody WHERE id=(v_receipt->>'custody_id')::uuid FOR UPDATE;
    -- THE ENTRY IS ACTIVE FROM THE MOMENT IT IS PAID. The seat guards (P0810,
    -- P0812) admit a Diamond tournament seat only against an active entry for
    -- its player and event; this is the tournament mirror of the cash binder,
    -- moved to where the money is, and it never binds a seat (P0813).
    UPDATE public.poker_diamond_custody SET state='active' WHERE id=v_c.id AND state='reserved' AND purpose='tournament_entry';
    IF NOT FOUND THEN RAISE EXCEPTION 'diamond_tournament_entry_activation_failed' USING ERRCODE='P0404'; END IF;
    v_c.state := 'active';
    -- The first entry locks the entry contract, as the chip entitlement
    -- trigger does: a price nobody has paid may change, a paid one may not.
    UPDATE public.tournaments t SET entry_contract_locked=true WHERE t.id=p_tournament_id AND NOT t.entry_contract_locked;
  ELSE
    IF NOT FOUND THEN
      RAISE EXCEPTION 'diamond_tournament_entry_not_held' USING ERRCODE='55000';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.ca_arena_settings a WHERE a.id=1 AND a.club_id=v_arena AND a.tournaments_enabled) THEN
      RAISE EXCEPTION 'diamond_tournaments_not_open' USING ERRCODE='55000';
    END IF;
    v_receipt := public.fn_poker_diamond_tournament_custody_add(v_c.id,p_gross,v_request);
    IF COALESCE((v_receipt->>'success')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'diamond_tournament_add_failed' USING ERRCODE='P0404';
    END IF;
  END IF;

  INSERT INTO public.poker_diamond_tournament_ledger(
    tournament_id,arena_id,user_id,custody_id,kind,amount,prize_part,bounty_part,fee_part,
    idempotency_key,wallet_journal_id,registration_id,request)
  VALUES (p_tournament_id,v_arena,p_user_id,v_c.id,p_kind,p_gross::bigint,p_prize::bigint,p_bounty::bigint,p_fee::bigint,
    p_idempotency_key,(v_receipt->>'journal_id')::uuid,p_registration_id,
    jsonb_build_object('kind',p_kind,'gross',p_gross,'prize',p_prize,'bounty',p_bounty,'fee',p_fee,'request_id',v_request))
  RETURNING id INTO v_ledger;

  -- Once the escrow shadow is open (a knockout paid mid-event opens it from
  -- the ledger), every later inflow - a late entry, a re-entry, a rebuy, an
  -- add-on - is applied to it, as a chip entry's wallet row applies itself.
  IF EXISTS (SELECT 1 FROM public.tournament_escrow x WHERE x.tournament_id=p_tournament_id) THEN
    PERFORM public.fn_ca_escrow_apply(p_tournament_id,'diamond '||p_kind,
      p_gross_in => p_gross, p_fee_entries_in => p_fee, p_bounty_in => p_bounty);
  END IF;

  -- The banks and the custody must agree after every charge.
  IF (SELECT prize_balance+bounty_balance+fee_balance FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id))
     IS DISTINCT FROM public.fn_poker_diamond_tournament_custody(p_tournament_id)::numeric THEN
    RAISE EXCEPTION 'diamond_tournament_escrow_disagrees_with_custody' USING ERRCODE='P0404';
  END IF;
  RETURN jsonb_build_object('success',true,'custody_id',v_c.id,'ledger_id',v_ledger,
    'journal_id',v_receipt->>'journal_id','amount',p_gross,'request_id',v_request);
END $function$

