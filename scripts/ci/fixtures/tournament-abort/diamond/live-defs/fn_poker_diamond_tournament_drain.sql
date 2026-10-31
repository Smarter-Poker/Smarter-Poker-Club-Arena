-- live_md5 e3bac937c649c8f68ba23b9c2fe83c4e
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_drain(p_tournament_id uuid, p_bank text, p_amount bigint, p_reason text, p_destination_account text, p_journal_for uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_left bigint := p_amount; v_take bigint; v_c record; v_lot record; v_loss bigint;
  v_drained jsonb := '[]'::jsonb; v_req uuid; v_journal uuid; v_wallet bigint; v_name text;
  v_register text; v_label text; v_supply numeric;
BEGIN
  IF p_tournament_id IS NULL OR p_bank NOT IN ('prize','fee','bounty') OR p_amount IS NULL OR p_amount < 1 OR p_reason IS NULL
     OR p_destination_account IS NULL OR length(btrim(p_destination_account))=0 THEN
    RAISE EXCEPTION 'invalid_diamond_tournament_drain' USING ERRCODE='22023';
  END IF;
  IF public.fn_poker_diamond_tournament_custody(p_tournament_id) < p_amount THEN
    RAISE EXCEPTION 'diamond_tournament_custody_short' USING ERRCODE='P0404';
  END IF;
  SELECT t.name INTO v_name FROM public.tournaments t WHERE t.id=p_tournament_id;
  SET CONSTRAINTS public.zzz_diamond_entry_custody_is_the_entry IMMEDIATE;
  FOR v_c IN
    SELECT c.id, c.user_id, c.balance, c.arena_id,
           (SELECT COALESCE(sum(CASE WHEN p_bank='prize' THEN l.prize_part
                                     WHEN p_bank='bounty' THEN l.bounty_part
                                     ELSE l.fee_part END),0)
              FROM public.poker_diamond_tournament_ledger l
             WHERE l.custody_id=c.id AND l.kind IN ('entry','rebuy','reentry','addon','spin_underwrite','overlay'))
         - (SELECT COALESCE(sum(m.amount),0) FROM public.poker_diamond_movements m
             WHERE m.custody_id=c.id AND m.action='release'
               AND m.request->>'action'='tournament_drain' AND m.request->>'bank'=p_bank) AS held
      FROM public.poker_diamond_custody c
     WHERE c.purpose='tournament_entry' AND c.target_id=p_tournament_id AND c.state<>'released' AND c.balance > 0
     ORDER BY c.created_at, c.id
     FOR UPDATE OF c
  LOOP
    EXIT WHEN v_left = 0;
    CONTINUE WHEN v_c.held <= 0;
    v_take := LEAST(v_left, v_c.held, v_c.balance);
    -- The lots this row holds are consumed for what leaves it, oldest first,
    -- exactly as fn_poker_diamond_settle_cash_hand consumes a lost stack.
    v_loss := v_take;
    FOR v_lot IN
      SELECT l.id, r.amount-r.consumed AS held, greatest(l.issued-l.consumed-l.refunded,0) AS outstanding
        FROM public.poker_diamond_lot_reservations r
        JOIN public.diamond_purchase_lots l ON l.id=r.lot_id
       WHERE r.custody_id=v_c.id AND r.released_at IS NULL
       ORDER BY l.created_at, l.id FOR UPDATE OF l, r
    LOOP
      EXIT WHEN v_loss = 0;
      IF v_lot.held > 0 THEN
        UPDATE public.diamond_purchase_lots
           SET arena_reserved=arena_reserved-LEAST(v_loss,v_lot.held),
               consumed=consumed+LEAST(LEAST(v_loss,v_lot.held),v_lot.outstanding)::integer
         WHERE id=v_lot.id;
        UPDATE public.poker_diamond_lot_reservations SET consumed=consumed+LEAST(v_loss,v_lot.held)
         WHERE custody_id=v_c.id AND lot_id=v_lot.id;
        v_loss := v_loss - LEAST(v_loss,v_lot.held);
      END IF;
    END LOOP;
    -- The journal row the movement carries: the recipient's credit for a
    -- prize or a bounty, which moved that recipient's wallet.
    --
    -- A HOUSE-BOUND DRAIN (a fee, a Spin surplus, a guarantee overlay return)
    -- MOVES NO WALLET, SO IT WRITES NO WALLET JOURNAL ROW (20261007132503).
    -- The Diamonds left the player's wallet once, when the entry was bought
    -- (that arena_deposit row is the wallet's record of it); here they leave
    -- custody for the house. A diamond_transactions row would record the same
    -- Diamonds leaving the wallet a second time, and from 13:03 UTC on
    -- 2026-10-07 it did (four tournament_fee rows, 800 Diamonds). The register
    -- still retires them from the player, because it counts custody Diamonds as
    -- the player's: that burn is written here directly, with the wallet
    -- unchanged on both sides, exactly as fn_ca_diamond_sweep_cash_rake writes
    -- the cash rake (20261007112751).
    IF p_journal_for IS NOT NULL THEN
      v_journal := p_journal_for;
      v_register := NULL;
    ELSE
      v_journal := NULL;
      v_register := p_reason||':'||v_c.id::text;
      SELECT COALESCE(diamonds,0), COALESCE(NULLIF(btrim(username),''), full_name, id::text)
        INTO v_wallet, v_label FROM public.profiles WHERE id=v_c.user_id;
      IF v_supply IS NULL THEN
        SELECT COALESCE(SUM(CASE WHEN action='mint' THEN amount ELSE -amount END),0) INTO v_supply
          FROM public.ca_mint_ledger WHERE asset='diamonds';
      END IF;
      v_supply := v_supply - v_take;
      INSERT INTO public.ca_mint_ledger
        (op_id, action, asset, holder_type, holder_id, holder_label, amount,
         balance_before, balance_after, supply_after, reason)
      VALUES
        (v_register, 'burn', 'diamonds', 'player', v_c.user_id, COALESCE(v_label, v_c.user_id::text), v_take,
         COALESCE(v_wallet,0), COALESCE(v_wallet,0), v_supply,
         CASE WHEN p_bank='prize' AND p_reason LIKE 'poker-guarantee-overlay-return:%'
              THEN 'Diamond guarantee overlay returned from this player''s entry custody to the house: '||COALESCE(v_name,'tournament')
              WHEN p_bank='prize'
              THEN 'Diamond Spin surplus returned from this player''s entry custody to the house: '||COALESCE(v_name,'spin')
              ELSE 'Tournament entry fee retired from this player''s entry custody for the house: '||COALESCE(v_name,'tournament') END
         ||'. The wallet does not move: the Diamonds left it when the entry was bought.');
    END IF;
    -- The movement first, then the balance: P0814 (an entry holds exactly its
    -- movements) is checked at the end of this UPDATE, not at commit, because
    -- a row drained twice in one settlement (the fee, then a prize) would
    -- otherwise present its first version against the final movement sum.
    v_req := uuid_in(md5(p_reason||':'||v_c.id::text)::cstring);
    INSERT INTO public.poker_diamond_movements(request_id,custody_id,user_id,action,amount,
      source_account,destination_account,wallet_journal_id,request,receipt)
    VALUES (v_req,v_c.id,v_c.user_id,'release',v_take,'arena_custody:'||v_c.id,p_destination_account,v_journal,
      jsonb_build_object('action','tournament_drain','bank',p_bank,'reason',p_reason,'custody_id',v_c.id,'amount',v_take),
      jsonb_build_object('success',true,'custody_id',v_c.id,'amount',v_take,'custody_balance',v_c.balance-v_take,'journal_id',v_journal,
                         'register_op_id',v_register));
    UPDATE public.poker_diamond_custody SET balance=balance-v_take WHERE id=v_c.id;
    v_drained := v_drained || jsonb_build_object('custody_id',v_c.id,'user_id',v_c.user_id,'amount',v_take,'journal_id',v_journal,
                                                 'register_op_id',v_register,'request_id',v_req);
    v_left := v_left - v_take;
  END LOOP;
  SET CONSTRAINTS public.zzz_diamond_entry_custody_is_the_entry DEFERRED;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'diamond_tournament_custody_short' USING ERRCODE='P0404';
  END IF;
  RETURN v_drained;
END $function$

