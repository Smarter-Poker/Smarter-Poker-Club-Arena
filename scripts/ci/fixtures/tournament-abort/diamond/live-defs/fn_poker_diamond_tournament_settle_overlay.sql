-- live_md5 3a48520cfc2c31b2279f1d14ef9b41fe
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_settle_overlay(p_tournament_id uuid, p_moment text, p_guarantee numeric)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_house constant uuid := '00000000-0000-0000-0000-00000000d1a0';
  v_t record; v_l record; v_g bigint; v_collected bigint; v_funded bigint; v_delta bigint; v_amount bigint;
  v_key text; v_n integer; v_share bigint; v_rest bigint; v_take bigint; v_i integer := 0;
  v_c public.poker_diamond_custody%ROWTYPE; v_wallet bigint; v_label text; v_register text;
  v_registers text[] := ARRAY[]::text[]; v_running numeric;
  v_req uuid; v_before numeric; v_after numeric; v_supply numeric; v_registered numeric;
  v_drained jsonb; v_d jsonb; v_open bigint;
BEGIN
  IF p_tournament_id IS NULL OR p_moment NOT IN ('lock','finalize') OR p_guarantee IS NULL
     OR p_guarantee < 0 OR p_guarantee <> trunc(p_guarantee) THEN
    RAISE EXCEPTION 'invalid_diamond_overlay_request' USING ERRCODE = '22023';
  END IF;
  IF NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE = '23514';
  END IF;
  SELECT t.id, t.club_id, t.name INTO v_t FROM public.tournaments t WHERE t.id = p_tournament_id;
  v_g := p_guarantee;
  SELECT COALESCE(sum(prize_part) FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0)
           - COALESCE(sum(prize_part) FILTER (WHERE kind = 'refund'),0) AS collected,
         COALESCE(sum(amount) FILTER (WHERE kind = 'overlay'),0)
           - COALESCE(sum(amount) FILTER (WHERE kind = 'overlay_return'),0) AS funded
    INTO v_l FROM public.poker_diamond_tournament_ledger WHERE tournament_id = p_tournament_id;
  v_collected := v_l.collected; v_funded := v_l.funded;
  v_delta := GREATEST(v_g, v_collected) - (v_collected + v_funded);
  IF v_delta = 0 THEN RETURN 0; END IF;

  INSERT INTO public.ca_diamond_house (id, balance) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
  SELECT COALESCE(h.balance, 0) INTO v_before FROM public.ca_diamond_house h WHERE h.id = 1 FOR UPDATE;
  SELECT COALESCE(SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END), 0) INTO v_supply
    FROM public.ca_mint_ledger m WHERE m.asset = 'diamonds';

  IF v_delta > 0 THEN
    v_amount := v_delta;
    v_key := 'poker-guarantee-overlay:' || p_tournament_id::text || ':' || p_moment;
    -- The promise was set aside at creation; it is kept from the earmark and
    -- from nothing else (A7). Ruling 21: no cap is read here.
    v_open := public.fn_ca_diamond_earmark_open('guarantee:' || p_tournament_id::text);
    IF v_open < v_amount THEN
      RAISE EXCEPTION 'diamond_guarantee_overlay_exceeds_its_earmark:% set aside, % needed', v_open, v_amount
        USING ERRCODE = '23514';
    END IF;
    IF v_before < v_amount THEN
      RAISE EXCEPTION 'diamond_house_cannot_pay_the_overlay:% held, % needed', v_before, v_amount
        USING ERRCODE = '23514';
    END IF;
    SELECT count(*) INTO v_n FROM public.poker_diamond_custody c
     WHERE c.purpose = 'tournament_entry' AND c.target_id = p_tournament_id AND c.state = 'active';
    IF v_n = 0 THEN
      RAISE EXCEPTION 'diamond_overlay_has_no_entry_to_hold_it' USING ERRCODE = '55000';
    END IF;
    UPDATE public.ca_diamond_house SET balance = balance - v_amount, updated_at = now()
     WHERE id = 1 RETURNING balance INTO v_after;
    INSERT INTO public.ca_mint_ledger
      (op_id, action, asset, holder_type, holder_id, holder_label, amount, balance_before, balance_after, supply_after, reason)
    VALUES (v_key, 'burn', 'diamonds', 'house', c_house, 'the house', v_amount, v_before, v_after, v_supply - v_amount,
      'Diamond guarantee overlay paid from the house into the event custody (' || COALESCE(v_t.name, 'tournament')
      || ', ' || p_moment || '), the guarantee set aside at creation');
    SET CONSTRAINTS public.zzz_diamond_entry_custody_is_the_entry IMMEDIATE;
    v_running := v_supply - v_amount;
    v_share := v_amount / v_n;
    v_rest := v_amount % v_n;
    FOR v_c IN SELECT c.* FROM public.poker_diamond_custody c
                WHERE c.purpose = 'tournament_entry' AND c.target_id = p_tournament_id AND c.state = 'active'
                ORDER BY c.created_at, c.id FOR UPDATE LOOP
      v_i := v_i + 1;
      v_take := v_share + CASE WHEN v_i <= v_rest THEN 1 ELSE 0 END;
      CONTINUE WHEN v_take = 0;
      -- THE SHARE LANDS IN CUSTODY, NEVER IN A WALLET, SO IT WRITES NO WALLET
      -- JOURNAL ROW (20261007132503). The register counts custody Diamonds as
      -- the player's, so it is minted to the player there, directly, with the
      -- wallet unchanged on both sides. A diamond_transactions credit here
      -- would tell the wallet it grew by Diamonds that are not in it.
      SELECT COALESCE(pr.diamonds, 0), COALESCE(NULLIF(btrim(pr.username), ''), pr.full_name, pr.id::text)
        INTO v_wallet, v_label FROM public.profiles pr WHERE pr.id = v_c.user_id;
      v_register := v_key || ':' || v_c.id::text;
      v_running := v_running + v_take;
      INSERT INTO public.ca_mint_ledger
        (op_id, action, asset, holder_type, holder_id, holder_label, amount, balance_before, balance_after, supply_after, reason)
      VALUES (v_register, 'mint', 'diamonds', 'player', v_c.user_id, COALESCE(v_label, v_c.user_id::text), v_take,
        v_wallet, v_wallet, v_running,
        'Diamond guarantee overlay paid by the house into this player''s entry custody: ' || COALESCE(v_t.name, 'tournament')
          || ' (' || p_moment || '). Paid out only as prizes; the wallet does not move.');
      v_registers := v_registers || v_register;
      v_req := uuid_in(md5(v_key || ':' || v_c.id::text)::cstring);
      INSERT INTO public.poker_diamond_movements(request_id, custody_id, user_id, action, amount,
        source_account, destination_account, wallet_journal_id, request, receipt)
      VALUES (v_req, v_c.id, v_c.user_id, 'reserve', v_take, 'house:' || c_house::text, 'arena_custody:' || v_c.id::text,
        NULL,
        jsonb_build_object('action', 'guarantee_overlay', 'bank', 'prize', 'tournament_id', p_tournament_id,
                           'custody_id', v_c.id, 'amount', v_take),
        jsonb_build_object('success', true, 'custody_id', v_c.id, 'amount', v_take,
                           'custody_balance', v_c.balance + v_take, 'journal_id', NULL, 'register_op_id', v_register));
      UPDATE public.poker_diamond_custody SET balance = balance + v_take WHERE id = v_c.id;
      INSERT INTO public.poker_diamond_tournament_ledger(tournament_id, arena_id, user_id, custody_id, kind, amount,
        prize_part, bounty_part, fee_part, idempotency_key, wallet_journal_id, request)
      VALUES (p_tournament_id, v_t.club_id, v_c.user_id, v_c.id, 'overlay', v_take, v_take, 0, 0,
        v_key || ':' || v_c.id::text, NULL,
        jsonb_build_object('kind', 'overlay', 'source', 'house', 'moment', p_moment, 'request_id', v_req,
                           'register_op_id', v_register));
    END LOOP;
    SET CONSTRAINTS public.zzz_diamond_entry_custody_is_the_entry DEFERRED;
    SELECT COALESCE(sum(m.amount), 0) INTO v_registered FROM public.ca_mint_ledger m
     WHERE m.asset = 'diamonds' AND m.action = 'mint' AND m.holder_type = 'player'
       AND m.op_id = ANY (v_registers);
    IF v_registered IS DISTINCT FROM v_amount::numeric THEN
      RAISE EXCEPTION 'diamond_overlay_not_registered_to_players (% of %)', v_registered, v_amount USING ERRCODE = 'P0404';
    END IF;
    INSERT INTO public.ca_diamond_house_earmarks (entry, earmark_key, purpose, amount, tournament_id, reason)
    VALUES ('pay', 'guarantee:' || p_tournament_id::text, 'guarantee', v_amount, p_tournament_id,
            'Guarantee overlay paid into the event custody at ' || p_moment);
    IF EXISTS (SELECT 1 FROM public.tournament_escrow x WHERE x.tournament_id = p_tournament_id) THEN
      PERFORM public.fn_ca_escrow_apply(p_tournament_id, 'diamond guarantee overlay', p_overlay_in => v_amount);
    END IF;
  ELSE
    v_amount := LEAST(-v_delta, v_funded);
    IF v_amount <= 0 THEN RETURN 0; END IF;
    v_key := 'poker-guarantee-overlay-return:' || p_tournament_id::text || ':' || p_moment;
    v_drained := public.fn_poker_diamond_tournament_drain(p_tournament_id, 'prize', v_amount, v_key, 'house', NULL);
    SELECT COALESCE(sum(m.amount), 0) INTO v_registered FROM public.ca_mint_ledger m
     WHERE m.asset = 'diamonds' AND m.action = 'burn' AND m.holder_type = 'player'
       AND m.op_id IN (SELECT d->>'register_op_id' FROM jsonb_array_elements(v_drained) d);
    IF v_registered IS DISTINCT FROM v_amount::numeric THEN
      RAISE EXCEPTION 'diamond_overlay_return_not_retired_from_players (% of %)', v_registered, v_amount USING ERRCODE = 'P0404';
    END IF;
    -- The drain has just retired v_amount from the players; the house mint's
    -- supply_after is read after it, as the fee settlement reads it.
    SELECT COALESCE(SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END), 0) INTO v_supply
      FROM public.ca_mint_ledger m WHERE m.asset = 'diamonds';
    UPDATE public.ca_diamond_house SET balance = balance + v_amount, updated_at = now()
     WHERE id = 1 RETURNING balance INTO v_after;
    INSERT INTO public.ca_mint_ledger
      (op_id, action, asset, holder_type, holder_id, holder_label, amount, balance_before, balance_after, supply_after, reason)
    VALUES (v_key, 'mint', 'diamonds', 'house', c_house, 'the house', v_amount, v_before, v_after, v_supply + v_amount,
      'Diamond guarantee overlay the entries made unnecessary returned from the event custody to the house ('
      || COALESCE(v_t.name, 'tournament') || ', ' || p_moment || ')');
    FOR v_d IN SELECT d.value FROM jsonb_array_elements(v_drained) d LOOP
      INSERT INTO public.poker_diamond_tournament_ledger(tournament_id, arena_id, user_id, custody_id, kind, amount,
        prize_part, bounty_part, fee_part, idempotency_key, wallet_journal_id, request)
      VALUES (p_tournament_id, v_t.club_id, (v_d->>'user_id')::uuid, (v_d->>'custody_id')::uuid, 'overlay_return',
        (v_d->>'amount')::bigint, (v_d->>'amount')::bigint, 0, 0,
        v_key || ':' || (v_d->>'custody_id'), NULL,
        jsonb_build_object('kind', 'overlay_return', 'destination', 'house', 'moment', p_moment,
                           'request_id', v_d->>'request_id', 'register_op_id', v_d->>'register_op_id'));
    END LOOP;
    IF EXISTS (SELECT 1 FROM public.tournament_escrow x WHERE x.tournament_id = p_tournament_id) THEN
      PERFORM public.fn_ca_escrow_apply(p_tournament_id, 'diamond guarantee overlay return', p_overlay_in => -v_amount);
    END IF;
    v_amount := -v_amount;
  END IF;

  IF (SELECT prize_balance + bounty_balance + fee_balance FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id))
     IS DISTINCT FROM public.fn_poker_diamond_tournament_custody(p_tournament_id)::numeric THEN
    RAISE EXCEPTION 'diamond_tournament_escrow_disagrees_with_custody' USING ERRCODE = 'P0404';
  END IF;
  RETURN v_amount;
END $function$

