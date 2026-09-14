-- ============================================================================
-- A DIAMOND TOURNAMENT PAYS FROM ITS OWN CUSTODY
-- ============================================================================
--
-- The second half of the Phase 8 money path. The first (a Diamond tournament
-- entry is custody) put every entry, re-entry and add-on into
-- poker_diamond_custody rows and taught the refund doors to return them. This
-- one teaches the SETTLEMENT doors where a Diamond prize and a Diamond fee
-- come from and where they go, without adding a payer: the chip estate's one
-- terminal path (fn_complete_tournament_terminal -> fn_settle_tournament_places
-- -> fn_settle_tournament_obligation -> fn_credit_and_log, then
-- fn_settle_tournament_rake) is kept, and only its two last steps - the wallet
-- credit and the fee destination - are answered for a Diamond event by
-- draining the event's custody rows.
--
-- THE SHAPE.
--   prize   the prize parts of the event's custody rows, oldest first  ->  winner's profiles.diamonds
--           journaled as arena_withdraw (a move inside the player supply, not
--           issuance: the register does not follow it, exactly as a cash-out),
--           recorded in the poker_diamond_tournament_ledger as 'prize' against
--           the prize bank, and in poker_diamond_movements as a 'release' from
--           each drained row (P0814: an entry holds exactly its movements).
--   fee     the fee parts of the event's custody rows  ->  ca_diamond_house.
--           Every custody row knows its parts from the ledger (an entry is
--           99 prize + 11 fee; an add-on is all prize), so a prize drains
--           prize parts only and the fee drains each player's OWN fee part.
--           DR14: what leaves a player and reaches no player lands in the
--           house. The house is outside the player supply, so each player's
--           fee is journaled as that player's 'spend' (the register retires
--           it from that player, as it retires every spend) and the same
--           amount is minted to the house in the register, exactly as
--           fn_ca_mint issues to the house. players + house + custody =
--           register, before and after.
--   close   when every bank is empty the zero-balance custody rows are
--           released (a release of nothing), so a settled event leaves no open
--           entry behind.
--
-- WHAT THE OBLIGATION MODEL STILL DOES. Every prize is still an obligation row
-- with amount_owed and amount_paid, still capped by the bank
-- (fn_ca_escrow_can_pay answers from the Diamond banks since the first
-- migration), still keyed by the same credit key claimed in
-- wallet_credit_idempotency before a Diamond moves, still recorded in
-- tournament_payouts as evidence, and still proved by the immutable terminal
-- receipt. The escrow shadow (tournament_escrow) that the receipt and the
-- reconciler read is opened for a Diamond event at the start of its terminal
-- settlement from the Diamond banks, and every prize and the fee are applied
-- to it as they are to a chip event, so the terminal writer's exact-zero
-- close and the receipt's checks hold unchanged.
--
-- THE CHIP PATH IS PROVED UNCHANGED: every chip function edited here is
-- edited in place with its md5 pinned, and the migration undoes its own
-- insertions on the live text and requires the pinned md5 back.
--
-- Applied once to kuklfnapbkmacvwxktbh. Never reapply.
-- ============================================================================

DO $do$
DECLARE v_n integer;
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled) THEN
    RAISE EXCEPTION 'tournaments_enabled is already on somewhere; this migration expects it closed';
  END IF;
  SELECT count(*) INTO v_n FROM public.poker_diamond_tournament_ledger WHERE kind IN ('prize','bounty','fee');
  IF v_n<>0 THEN RAISE EXCEPTION 'the ledger already carries % settlement row(s); this migration expects none', v_n; END IF;
END $do$;

INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_poker_diamond_tournament_drain', 'approved',
   'Diamond Phase 8. Takes a whole number of Diamonds out of one bank (prize or fee) of a Diamond event''s custody rows, oldest first, each row giving only what it holds in that bank, consuming the purchased lots each row held and recording one release movement per drained row. Owner-only; the prize and fee settlers are its only callers.'),
  ('fn_poker_diamond_tournament_pay', 'approved',
   'Diamond Phase 8. The Diamond leg of fn_credit_and_log: claims the credit key, checks the bank, drains custody, credits the winner''s wallet as arena_withdraw and applies the prize to the escrow shadow. Owner-only.'),
  ('fn_poker_diamond_tournament_settle_fee', 'approved',
   'Diamond Phase 8. The Diamond leg of fn_settle_tournament_rake: drains the fee bank out of custody into ca_diamond_house, journaling each player''s share as a spend and minting the same to the house in the register. Owner-only.'),
  ('fn_poker_diamond_tournament_close_custody', 'approved',
   'Diamond Phase 8. Releases the zero-balance custody rows of a settled Diamond event (a release of nothing). Owner-only.'),
  ('fn_poker_diamond_tournament_open_shadow', 'approved',
   'Diamond Phase 8. Opens the tournament_escrow shadow of a Diamond event at the start of its terminal settlement, copied from the Diamond ledger with its exact parts. Owner-only; the terminal writer is its only caller.')
ON CONFLICT (proname) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 1. THE DRAIN. One bank of the event's custody rows, oldest first, until the
--    amount is out; a row gives only what it holds in that bank (its parts
--    from the ledger, less what this bank already drained from it). Lots held
--    by a drained row are consumed exactly as a lost hand consumes them, so
--    purchased provenance closes with the money, and each drained row records
--    a release movement naming the bank and carrying the journal row the
--    Diamonds arrived in, so the entry still holds exactly its movements.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_drain(
  p_tournament_id uuid, p_bank text, p_amount bigint, p_reason text, p_destination_account text, p_journal_for uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_left bigint := p_amount; v_take bigint; v_c record; v_lot record; v_loss bigint;
  v_drained jsonb := '[]'::jsonb; v_req uuid; v_journal uuid; v_wallet bigint; v_name text;
BEGIN
  IF p_tournament_id IS NULL OR p_bank NOT IN ('prize','fee') OR p_amount IS NULL OR p_amount < 1 OR p_reason IS NULL
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
           (SELECT COALESCE(sum(CASE WHEN p_bank='prize' THEN l.prize_part ELSE l.fee_part END),0)
              FROM public.poker_diamond_tournament_ledger l
             WHERE l.custody_id=c.id AND l.kind IN ('entry','rebuy','reentry','addon'))
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
    -- prize; for a fee, this player's own spend, which the register retires.
    IF p_journal_for IS NOT NULL THEN
      v_journal := p_journal_for;
    ELSE
      SELECT COALESCE(diamonds,0) INTO v_wallet FROM public.profiles WHERE id=v_c.user_id;
      INSERT INTO public.diamond_transactions(user_id,type,transaction_type,amount,balance_after,
        reference_id,description,source,issuance_class,counterparty,metadata)
      VALUES (v_c.user_id,'tournament_fee','tournament_fee',-v_take::integer,v_wallet,
        p_reason||':'||v_c.id::text,'Tournament entry fee: '||COALESCE(v_name,'tournament')||' (from custody to the house)',
        'poker_arena','spend','house',
        jsonb_build_object('custody_id',v_c.id,'tournament_id',p_tournament_id,'reason',p_reason,'destination','house'))
      RETURNING id INTO v_journal;
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
      jsonb_build_object('success',true,'custody_id',v_c.id,'amount',v_take,'custody_balance',v_c.balance-v_take,'journal_id',v_journal));
    UPDATE public.poker_diamond_custody SET balance=balance-v_take WHERE id=v_c.id;
    v_drained := v_drained || jsonb_build_object('custody_id',v_c.id,'user_id',v_c.user_id,'amount',v_take,'journal_id',v_journal,'request_id',v_req);
    v_left := v_left - v_take;
  END LOOP;
  SET CONSTRAINTS public.zzz_diamond_entry_custody_is_the_entry DEFERRED;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'diamond_tournament_custody_short' USING ERRCODE='P0404';
  END IF;
  RETURN v_drained;
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_drain(uuid,text,bigint,text,text,uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. THE PRIZE. The Diamond leg of fn_credit_and_log. Returns what
--    fn_credit_player_wallet_once returns: true when this call moved money,
--    false when the key was already spent.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_pay(
  p_user_id uuid, p_amount numeric, p_idempotency_key text, p_category text, p_tournament_id uuid, p_description text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_arena uuid; v_kind text; v_bank numeric; v_inserted integer; v_drained jsonb; v_credit jsonb; v_e record;
  v_category text := lower(COALESCE(p_category,''));
BEGIN
  IF p_user_id IS NULL OR p_tournament_id IS NULL OR p_idempotency_key IS NULL
     OR p_amount IS NULL OR p_amount < 1 OR p_amount <> trunc(p_amount) OR p_amount > 2147483647 THEN
    RAISE EXCEPTION 'diamond_tournament_pay_requires_whole_diamonds' USING ERRCODE='22023';
  END IF;
  SELECT t.club_id INTO v_arena FROM public.tournaments t JOIN public.clubs c ON c.id=t.club_id
   WHERE t.id=p_tournament_id AND c.asset='diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL AND t.union_id IS NULL;
  IF v_arena IS NULL THEN RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE='23514'; END IF;
  v_kind := CASE WHEN v_category='bounty' THEN 'bounty'
                 WHEN v_category='prize' THEN 'prize'
                 ELSE NULL END;
  IF v_kind IS NULL THEN
    -- A refund never reaches this door: the Diamond refund authority returns
    -- entries whole through fn_poker_diamond_release.
    RAISE EXCEPTION 'diamond_tournament_pay_unknown_category:%', v_category USING ERRCODE='22023';
  END IF;
  -- Phase 9 owns the bounty pools; a Diamond event has no bounty bank yet.
  IF v_kind='bounty' THEN
    RAISE EXCEPTION 'diamond_tournament_bounties_not_open' USING ERRCODE='55000';
  END IF;

  -- The key is claimed before any Diamond moves, as the chip credit claims it.
  INSERT INTO public.wallet_credit_idempotency(key,user_id,amount)
  VALUES (p_idempotency_key,p_user_id,p_amount) ON CONFLICT (key) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN RETURN false; END IF;

  SELECT * INTO v_e FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id);
  v_bank := v_e.prize_balance;
  IF v_bank < p_amount THEN
    RAISE EXCEPTION 'diamond_tournament_bank_short' USING ERRCODE='P0404';
  END IF;

  -- The winner's wallet first (its journal row is what every drained row's
  -- movement carries), then the custody rows, oldest first.
  v_credit := public.add_diamonds_to_balance(
    p_user_id, p_amount::integer, 'arena_withdraw',
    COALESCE(NULLIF(btrim(p_description),''), 'Tournament prize'),
    'poker-tournament-pay:'||p_idempotency_key);
  IF COALESCE((v_credit->>'success')::boolean,false) IS NOT TRUE OR NULLIF(v_credit->>'transaction_id','') IS NULL THEN
    RAISE EXCEPTION 'diamond_tournament_pay_credit_failed:%', v_credit->>'error' USING ERRCODE='P0404';
  END IF;
  v_drained := public.fn_poker_diamond_tournament_drain(
    p_tournament_id, 'prize', p_amount::bigint, 'poker-tournament-pay:'||p_idempotency_key, 'player:'||p_user_id::text,
    (v_credit->>'transaction_id')::uuid);

  INSERT INTO public.poker_diamond_tournament_ledger(
    tournament_id,arena_id,user_id,custody_id,kind,amount,prize_part,bounty_part,fee_part,
    idempotency_key,wallet_journal_id,request)
  VALUES (p_tournament_id,v_arena,p_user_id,NULL,v_kind,p_amount::bigint,p_amount::bigint,0,0,
    'poker-tournament-pay:'||p_idempotency_key,(v_credit->>'transaction_id')::uuid,
    jsonb_build_object('kind',v_kind,'credit_key',p_idempotency_key,'drained',v_drained,'description',p_description));

  -- The escrow shadow follows, as a chip prize's wallet row makes it follow.
  PERFORM public.fn_ca_escrow_apply(p_tournament_id,'diamond prize',p_prize_out => p_amount);

  IF (SELECT prize_balance+bounty_balance+fee_balance FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id))
     IS DISTINCT FROM public.fn_poker_diamond_tournament_custody(p_tournament_id)::numeric THEN
    RAISE EXCEPTION 'diamond_tournament_escrow_disagrees_with_custody' USING ERRCODE='P0404';
  END IF;
  RETURN true;
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_pay(uuid,numeric,text,text,uuid,text) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. THE FEE. The Diamond leg of fn_settle_tournament_rake.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_settle_fee(p_tournament_id uuid, p_source text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_house constant uuid := '00000000-0000-0000-0000-00000000d1a0';
  v_arena uuid; v_e record; v_fee bigint; v_drained jsonb; v_before numeric; v_after numeric;
  v_supply numeric; v_key text; v_ledger bigint; v_name text; v_existing bigint; v_burned numeric;
BEGIN
  IF p_tournament_id IS NULL THEN RAISE EXCEPTION 'invalid_diamond_tournament_fee' USING ERRCODE='22023'; END IF;
  SELECT t.club_id, t.name INTO v_arena, v_name FROM public.tournaments t JOIN public.clubs c ON c.id=t.club_id
   WHERE t.id=p_tournament_id AND c.asset='diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL AND t.union_id IS NULL;
  IF v_arena IS NULL THEN RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE='23514'; END IF;
  v_key := 'poker-tournament-fee:'||p_tournament_id::text;
  SELECT id INTO v_existing FROM public.poker_diamond_tournament_ledger WHERE idempotency_key=v_key;
  IF FOUND THEN
    RETURN jsonb_build_object('ok',true,'already_settled',true,'amount',(SELECT amount FROM public.poker_diamond_tournament_ledger WHERE id=v_existing));
  END IF;
  SELECT * INTO v_e FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id);
  v_fee := v_e.fee_balance::bigint;
  IF v_fee <= 0 THEN
    RETURN jsonb_build_object('ok',true,'amount',0,'destination','none');
  END IF;

  -- Out of the fee parts of the custody rows: each player's own fee,
  -- journaled as that player's spend, which the register retires from that
  -- player (trg_ca_diamond_register_follows_journal).
  v_drained := public.fn_poker_diamond_tournament_drain(p_tournament_id, 'fee', v_fee, v_key, 'house', NULL);
  SELECT COALESCE(sum(m.amount),0) INTO v_burned FROM public.ca_mint_ledger m
   WHERE m.asset='diamonds' AND m.action='burn' AND m.holder_type='player'
     AND m.diamond_tx_id IN (SELECT (d->>'journal_id')::uuid FROM jsonb_array_elements(v_drained) d);
  IF v_burned IS DISTINCT FROM v_fee::numeric THEN
    RAISE EXCEPTION 'diamond_tournament_fee_not_retired_from_players (% of %)', v_burned, v_fee USING ERRCODE='P0404';
  END IF;

  -- Into the house: the balance and the register, exactly as fn_ca_mint
  -- issues to the house (no house journal row: that journal is keyed by a
  -- user, and ca_mint_ledger is the record of a house-side issuance; the
  -- register's generated origin reads 'operator' for every non-journal op_id,
  -- as it does for fn_ca_mint's own house rows).
  INSERT INTO public.ca_diamond_house (id, balance) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
  SELECT COALESCE(balance,0) INTO v_before FROM public.ca_diamond_house WHERE id=1 FOR UPDATE;
  UPDATE public.ca_diamond_house SET balance=COALESCE(balance,0)+v_fee, updated_at=now() WHERE id=1 RETURNING balance INTO v_after;
  SELECT COALESCE(SUM(CASE WHEN action='mint' THEN amount ELSE -amount END),0) INTO v_supply FROM public.ca_mint_ledger WHERE asset='diamonds';
  INSERT INTO public.ca_mint_ledger
    (op_id, action, asset, holder_type, holder_id, holder_label, amount, balance_before, balance_after, supply_after, reason)
  VALUES
    (v_key, 'mint', 'diamonds', 'house', c_house, 'the house', v_fee, v_before, v_after, v_supply+v_fee,
     'Tournament entry fees banked to the house from the players'' custody ('||COALESCE(v_name,'tournament')||'), DR14 (poker_tournament_fee)');

  INSERT INTO public.poker_diamond_tournament_ledger(
    tournament_id,arena_id,user_id,custody_id,kind,amount,prize_part,bounty_part,fee_part,idempotency_key,request)
  VALUES (p_tournament_id,v_arena,NULL,NULL,'fee',v_fee,0,0,v_fee,v_key,
    jsonb_build_object('source',p_source,'drained',v_drained,'house_balance_after',v_after))
  RETURNING id INTO v_ledger;

  IF (SELECT prize_balance+bounty_balance+fee_balance FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id))
     IS DISTINCT FROM public.fn_poker_diamond_tournament_custody(p_tournament_id)::numeric THEN
    RAISE EXCEPTION 'diamond_tournament_escrow_disagrees_with_custody' USING ERRCODE='P0404';
  END IF;
  RETURN jsonb_build_object('ok',true,'amount',v_fee,'destination','diamond_house','ledger_id',v_ledger,'house_balance_after',v_after);
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_settle_fee(uuid,text) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. CLOSING. When the banks are empty, every custody row is empty; release
--    them so a closed event leaves no open row behind.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_close_custody(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_c record; v_n integer := 0; v_open bigint; v_receipt jsonb;
BEGIN
  IF NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE='23514';
  END IF;
  v_open := public.fn_poker_diamond_tournament_custody(p_tournament_id);
  IF v_open <> 0 THEN
    RETURN jsonb_build_object('ok',true,'closed',0,'still_held',v_open);
  END IF;
  FOR v_c IN SELECT c.id FROM public.poker_diamond_custody c
              WHERE c.purpose='tournament_entry' AND c.target_id=p_tournament_id AND c.state<>'released' AND c.balance=0
              ORDER BY c.created_at, c.id
  LOOP
    PERFORM set_config('app.poker_diamond_tournament_release', v_c.id::text, true);
    v_receipt := public.fn_poker_diamond_release(v_c.id, uuid_in(md5('poker-tournament-close:'||v_c.id::text)::cstring));
    PERFORM set_config('app.poker_diamond_tournament_release', '', true);
    IF COALESCE((v_receipt->>'success')::boolean,false) IS NOT TRUE OR (v_receipt->>'amount')::bigint <> 0 THEN
      RAISE EXCEPTION 'diamond_tournament_close_failed' USING ERRCODE='P0404';
    END IF;
    v_n := v_n + 1;
  END LOOP;
  RETURN jsonb_build_object('ok',true,'closed',v_n,'still_held',0);
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_close_custody(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4b. THE SHADOW. tournament_escrow is what the terminal writer, the receipt
--     reader and the reconciler read; for a Diamond event it opens at the
--     start of terminal settlement, copied from the ledger with its exact
--     parts (a Diamond refund returns an entry's own prize and fee parts, and
--     the chip shadow's proportional split of a refund is not that when an
--     add-on carried no fee). From then on every apply moves it as a chip
--     event's evidence moves it, so the exact-zero close is the same close.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_open_shadow(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE l record; v_x record;
BEGIN
  IF NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE='23514';
  END IF;
  SELECT
    COALESCE(sum(prize_part)  FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS prize_in,
    COALESCE(sum(bounty_part) FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS bounty_in,
    COALESCE(sum(fee_part)    FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS fee_in,
    COALESCE(sum(amount)      FILTER (WHERE kind = 'prize'),0)  AS prize_out,
    COALESCE(sum(amount)      FILTER (WHERE kind = 'bounty'),0) AS bounty_out,
    COALESCE(sum(amount)      FILTER (WHERE kind = 'fee'),0)    AS fee_out,
    COALESCE(sum(prize_part)  FILTER (WHERE kind = 'refund'),0) AS refund_prize,
    COALESCE(sum(bounty_part) FILTER (WHERE kind = 'refund'),0) AS refund_bounty,
    COALESCE(sum(fee_part)    FILTER (WHERE kind = 'refund'),0) AS refund_fee
    INTO l
    FROM public.poker_diamond_tournament_ledger WHERE tournament_id = p_tournament_id;
  INSERT INTO public.tournament_escrow
    (tournament_id, enforced, gross_in, fee_entries_in, satellite_fee_in, bounty_in, overlay_in, satellite_in,
     prize_out, bounty_out, fee_out, refund_prize, refund_bounty, refund_fee, reserve_out, reserve_in,
     prize_balance, bounty_balance, fee_balance, opened_from)
  VALUES
    (p_tournament_id, true, l.prize_in + l.bounty_in + l.fee_in, l.fee_in, 0, l.bounty_in, 0, 0,
     l.prize_out, l.bounty_out, l.fee_out, l.refund_prize, l.refund_bounty, l.refund_fee, 0, 0,
     l.prize_in - l.prize_out - l.refund_prize, l.bounty_in - l.bounty_out - l.refund_bounty,
     l.fee_in - l.fee_out - l.refund_fee, 'diamond terminal shadow (from the Diamond ledger)')
  ON CONFLICT (tournament_id) DO NOTHING;
  SELECT x.* INTO v_x FROM public.tournament_escrow x WHERE x.tournament_id = p_tournament_id;
  IF v_x.prize_balance IS DISTINCT FROM (l.prize_in - l.prize_out - l.refund_prize)::numeric
     OR v_x.bounty_balance IS DISTINCT FROM (l.bounty_in - l.bounty_out - l.refund_bounty)::numeric
     OR v_x.fee_balance IS DISTINCT FROM (l.fee_in - l.fee_out - l.refund_fee)::numeric
     OR v_x.prize_balance + v_x.bounty_balance + v_x.fee_balance
        IS DISTINCT FROM public.fn_poker_diamond_tournament_custody(p_tournament_id)::numeric THEN
    RAISE EXCEPTION 'tournament % escrow shadow disagrees with its Diamond banks', p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  RETURN jsonb_build_object('ok',true,'prize_balance',v_x.prize_balance,'bounty_balance',v_x.bounty_balance,'fee_balance',v_x.fee_balance);
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_open_shadow(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. fn_credit_and_log: the wallet credit is the Diamond leg for a Diamond
--    event, and the chip receipt row is not written for one. In place.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE v_def text; v_new text; v_n integer;
v_old1 constant text := $o$DECLARE
  v_credited boolean;$o$;
v_new1 constant text := $n$DECLARE
  v_diamond boolean := false;  -- DIAMOND PHASE 8
  v_credited boolean;$n$;
v_old2 constant text := $o$  v_credited := public.fn_credit_player_wallet_once(
    p_user_id, p_amount, p_idempotency_key);$o$;
v_new2 constant text := $n$  -- DIAMOND PHASE 8: a Diamond event pays from its own custody, never from a
  -- club chip wallet. Same key, same obligation, same evidence row below.
  v_diamond := p_related_entity_id IS NOT NULL AND public.fn_poker_diamond_tournament(p_related_entity_id);
  IF v_diamond THEN
    v_credited := public.fn_poker_diamond_tournament_pay(
      p_user_id, p_amount, p_idempotency_key, p_category, p_related_entity_id, p_description);
  ELSE
  v_credited := public.fn_credit_player_wallet_once(
    p_user_id, p_amount, p_idempotency_key);
  END IF;$n$;
v_old3 constant text := $o$  PERFORM public.log_wallet_transaction(
    p_user_id, p_wallet_type, p_amount, 'credit', p_category, p_description,
    p_table_id, p_hand_id, p_related_entity_id);$o$;
v_new3 constant text := $n$  IF NOT v_diamond THEN -- DIAMOND PHASE 8: wallet_transactions is the chip receipt
  PERFORM public.log_wallet_transaction(
    p_user_id, p_wallet_type, p_amount, 'credit', p_category, p_description,
    p_table_id, p_hand_id, p_related_entity_id);
  END IF;$n$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_credit_and_log';
  IF md5(v_def) <> '215820042e2ef7969132f25d14148061' THEN
    RAISE EXCEPTION 'fn_credit_and_log is not the text this migration was written against (md5 %)', md5(v_def);
  END IF;
  FOREACH v_new IN ARRAY ARRAY[v_old1, v_old2, v_old3] LOOP
    v_n := (length(v_def) - length(replace(v_def, v_new, ''))) / length(v_new);
    IF v_n <> 1 THEN RAISE EXCEPTION 'a fn_credit_and_log clause is not unique (% matches): %', v_n, left(v_new, 60); END IF;
  END LOOP;
  EXECUTE replace(replace(replace(v_def, v_old1, v_new1), v_old2, v_new2), v_old3, v_new3);
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_credit_and_log';
  IF md5(replace(replace(replace(v_def, v_new1, v_old1), v_new2, v_old2), v_new3, v_old3)) <> '215820042e2ef7969132f25d14148061' THEN
    RAISE EXCEPTION 'fn_credit_and_log is NOT the pinned chip text plus the three documented insertions';
  END IF;
END $do$;

-- ---------------------------------------------------------------------------
-- 6. fn_settle_tournament_rake: the fee of a Diamond event goes to the house
--    from custody; the chip body (rake_records -> union or treasury) is the
--    ELSE of a branch that is false for every chip event. In place.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE v_def text; v_n integer;
v_old constant text := $o$  SELECT round(COALESCE(sum(r.rake_amount), 0), 2) INTO v_net
    FROM public.rake_records r
   WHERE r.tournament_id = p_tournament_id AND r.is_tournament;
$o$;
v_add constant text := $n$  -- DIAMOND PHASE 8: a Diamond event's fee sits in its custody rows, not in
  -- rake_records; it goes to the house, and then the emptied custody closes.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    v_res := public.fn_poker_diamond_tournament_settle_fee(p_tournament_id, COALESCE(p_source, 'engine'));
    v_net := COALESCE((v_res->>'amount')::numeric, 0);
    UPDATE public.tournament_rake_settlements
       SET amount = v_net,
           destination = CASE WHEN v_net > 0 THEN 'diamond_house' ELSE 'none' END,
           settled_at = now(), attributed_at = now(), attributed_users = 0
     WHERE tournament_id = p_tournament_id;
    v_res := public.fn_poker_diamond_tournament_close_custody(p_tournament_id);
    RETURN jsonb_build_object('ok', true, 'amount', v_net,
      'destination', CASE WHEN v_net > 0 THEN 'diamond_house' ELSE 'none' END,
      'attributed', true, 'attributed_users', 0, 'members', 0, 'asset', 'diamonds',
      'custody_closed', v_res->>'closed', 'custody_still_held', v_res->>'still_held');
  END IF;
  SELECT round(COALESCE(sum(r.rake_amount), 0), 2) INTO v_net
    FROM public.rake_records r
   WHERE r.tournament_id = p_tournament_id AND r.is_tournament;
$n$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_settle_tournament_rake';
  IF md5(v_def) <> '657781a399203068a1a4888354757878' THEN
    RAISE EXCEPTION 'fn_settle_tournament_rake is not the text this migration was written against (md5 %)', md5(v_def);
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'the rake sum clause is not unique (% matches)', v_n; END IF;
  EXECUTE replace(v_def, v_old, v_add);
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_settle_tournament_rake';
  IF md5(replace(v_def, v_add, v_old)) <> '657781a399203068a1a4888354757878' THEN
    RAISE EXCEPTION 'fn_settle_tournament_rake is NOT the pinned chip text plus the one documented branch';
  END IF;
END $do$;

-- ---------------------------------------------------------------------------
-- 7. THE TERMINAL WRITER (fn_complete_tournament_terminal_pre_seat_guard)
--    learns four things about a Diamond event, each in place:
--      a. the event's fee is the Diamond fee bank, not a rake_records sum;
--      b. its escrow shadow is opened from the Diamond banks before the
--         first check, so the exact-zero close and every subsequent apply
--         hold as they hold for a chip event;
--      c. and d. a fee that went to the house is an attributed fee.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE v_def text; v_new text; v_n integer;
v_old1 constant text := $o$  v_mode text := lower(btrim(COALESCE(p_settlement_mode,'')));
  v_t record;$o$;
v_new1 constant text := $n$  v_mode text := lower(btrim(COALESCE(p_settlement_mode,'')));
  v_diamond boolean := false;  -- DIAMOND PHASE 8
  v_t record;$n$;
v_old2 constant text := $o$    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;$o$;
v_new2 constant text := $n$    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  v_diamond := public.fn_poker_diamond_tournament(p_tournament_id);  -- DIAMOND PHASE 8$n$;
v_old3 constant text := $o$  SELECT round(COALESCE(sum(rr.rake_amount),0),2) INTO v_rake_total
    FROM public.rake_records rr
   WHERE rr.tournament_id = p_tournament_id AND rr.is_tournament;
  IF v_rake_total < 0$o$;
v_new3 constant text := $n$  SELECT round(COALESCE(sum(rr.rake_amount),0),2) INTO v_rake_total
    FROM public.rake_records rr
   WHERE rr.tournament_id = p_tournament_id AND rr.is_tournament;
  IF v_diamond THEN
    -- DIAMOND PHASE 8: the fee of a Diamond event is its fee bank (what came
    -- in as fee, less what was refunded), held in custody until it settles.
    SELECT e.fee_balance + e.fee_out INTO v_rake_total
      FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;
  END IF;
  IF v_rake_total < 0$n$;
v_old4 constant text := $o$  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id FOR UPDATE;
  IF v_e.tournament_id IS NULL
     OR v_e.prize_balance IS DISTINCT FROM round(v_t.prize_pool-v_cash_before,2)$o$;
v_new4 constant text := $n$  IF v_diamond THEN
    -- DIAMOND PHASE 8: the escrow shadow of a Diamond event opens here, from
    -- its ledger with its exact parts, so every apply below moves it as a chip
    -- event's evidence moves it and the exact-zero close is the same close.
    PERFORM public.fn_poker_diamond_tournament_open_shadow(p_tournament_id);
  END IF;
  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id FOR UPDATE;
  IF v_e.tournament_id IS NULL
     OR v_e.prize_balance IS DISTINCT FROM round(v_t.prize_pool-v_cash_before,2)$n$;
v_old5 constant text := $o$v_prior_rake.amount > 0 AND v_t.club_id IS NOT NULL$o$;
v_new5 constant text := $n$v_prior_rake.amount > 0 AND v_t.club_id IS NOT NULL AND NOT v_diamond$n$;
v_old6 constant text := $o$(v_rake.amount > 0 AND v_t.club_id IS NOT NULL$o$;
v_new6 constant text := $n$(v_rake.amount > 0 AND v_t.club_id IS NOT NULL AND NOT v_diamond$n$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_complete_tournament_terminal_pre_seat_guard';
  IF md5(v_def) <> '8397b4f24c6d1a072d7b2d946f45e3d6' THEN
    RAISE EXCEPTION 'the terminal writer is not the text this migration was written against (md5 %)', md5(v_def);
  END IF;
  FOREACH v_new IN ARRAY ARRAY[v_old1, v_old2, v_old3, v_old4, v_old5, v_old6] LOOP
    v_n := (length(v_def) - length(replace(v_def, v_new, ''))) / length(v_new);
    IF v_n <> 1 THEN RAISE EXCEPTION 'a terminal-writer clause is not unique (% matches): %', v_n, left(v_new, 60); END IF;
  END LOOP;
  v_new := replace(replace(replace(replace(replace(replace(v_def, v_old1, v_new1), v_old2, v_new2), v_old3, v_new3), v_old4, v_new4), v_old5, v_new5), v_old6, v_new6);
  EXECUTE v_new;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_complete_tournament_terminal_pre_seat_guard';
  IF md5(replace(replace(replace(replace(replace(replace(v_def, v_new1, v_old1), v_new2, v_old2), v_new3, v_old3), v_new4, v_old4), v_new5, v_old5), v_new6, v_old6)) <> '8397b4f24c6d1a072d7b2d946f45e3d6' THEN
    RAISE EXCEPTION 'the terminal writer is NOT the pinned chip text plus the six documented insertions';
  END IF;
END $do$;

-- ---------------------------------------------------------------------------
-- 8. THE TERMINAL RECEIPT READER (fn_ca_tournament_terminal_receipt) proves a
--    Diamond event's fee against its fee bank and admits the house as its
--    attributed destination. Everything else it proves - the standings, the
--    payouts and their claimed keys, the obligations, the seats, the tables,
--    the exact-zero escrow close - is proved for a Diamond event unchanged.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE v_def text; v_new text; v_n integer;
v_old1 constant text := $o$  SELECT round(COALESCE(sum(rr.rake_amount),0),2) INTO v_rake_total
    FROM public.rake_records rr
   WHERE rr.tournament_id = p_tournament_id AND rr.is_tournament;
  SELECT rs.* INTO v_r$o$;
v_new1 constant text := $n$  SELECT round(COALESCE(sum(rr.rake_amount),0),2) INTO v_rake_total
    FROM public.rake_records rr
   WHERE rr.tournament_id = p_tournament_id AND rr.is_tournament;
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    -- DIAMOND PHASE 8: a Diamond event's fee is its fee bank, settled to the house.
    SELECT e.fee_balance + e.fee_out INTO v_rake_total
      FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;
  END IF;
  SELECT rs.* INTO v_r$n$;
v_old2 constant text := $o$(v_r.amount > 0 AND v_t.club_id IS NOT NULL$o$;
v_new2 constant text := $n$(v_r.amount > 0 AND v_t.club_id IS NOT NULL AND NOT public.fn_poker_diamond_tournament(p_tournament_id)$n$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_ca_tournament_terminal_receipt';
  IF md5(v_def) <> '185dcb02134aa1f1fd2d87cdddbcfd26' THEN
    RAISE EXCEPTION 'the terminal receipt reader is not the text this migration was written against (md5 %)', md5(v_def);
  END IF;
  FOREACH v_new IN ARRAY ARRAY[v_old1, v_old2] LOOP
    v_n := (length(v_def) - length(replace(v_def, v_new, ''))) / length(v_new);
    IF v_n <> 1 THEN RAISE EXCEPTION 'a terminal-receipt clause is not unique (% matches): %', v_n, left(v_new, 60); END IF;
  END LOOP;
  v_new := replace(replace(v_def, v_old1, v_new1), v_old2, v_new2);
  EXECUTE v_new;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_ca_tournament_terminal_receipt';
  IF md5(replace(replace(v_def, v_new1, v_old1), v_new2, v_old2)) <> '185dcb02134aa1f1fd2d87cdddbcfd26' THEN
    RAISE EXCEPTION 'the terminal receipt reader is NOT the pinned chip text plus the two documented insertions';
  END IF;
END $do$;

-- ---------------------------------------------------------------------------
-- 9. THE ESTATE IS AS IT WAS.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE v_n integer; r record;
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled) THEN
    RAISE EXCEPTION 'this migration must not open the tournament door';
  END IF;
  SELECT count(*) INTO v_n FROM public.poker_diamond_tournament_ledger WHERE kind IN ('prize','bounty','fee');
  IF v_n<>0 THEN RAISE EXCEPTION 'the ledger gained a settlement row during apply'; END IF;
  FOR r IN SELECT p.proname, p.oid FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN (
     'fn_poker_diamond_tournament_drain','fn_poker_diamond_tournament_pay','fn_poker_diamond_tournament_settle_fee','fn_poker_diamond_tournament_close_custody','fn_poker_diamond_tournament_open_shadow')
  LOOP
    IF has_function_privilege('anon', r.oid, 'EXECUTE') OR has_function_privilege('authenticated', r.oid, 'EXECUTE')
       OR has_function_privilege('service_role', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is callable by a client role; it is an internal step', r.proname;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN (
     'fn_poker_diamond_tournament_drain','fn_poker_diamond_tournament_pay','fn_poker_diamond_tournament_settle_fee','fn_poker_diamond_tournament_close_custody','fn_poker_diamond_tournament_open_shadow')) <> 5 THEN
    RAISE EXCEPTION 'a Diamond settlement step is missing';
  END IF;
  -- The chip credit and the chip rake rails are still there, byte for byte.
  FOR r IN SELECT p.proname, pg_get_functiondef(p.oid) AS def FROM pg_proc p
            WHERE p.pronamespace='public'::regnamespace AND p.proname IN (
              'fn_credit_and_log','fn_settle_tournament_rake','fn_complete_tournament_terminal_pre_seat_guard','fn_ca_tournament_terminal_receipt')
  LOOP
    IF r.proname='fn_credit_and_log' AND (
         position('public.fn_credit_player_wallet_once(' in r.def)=0
      OR position('public.log_wallet_transaction(' in r.def)=0
      OR position('fn_poker_diamond_tournament_pay(' in r.def)=0) THEN
      RAISE EXCEPTION 'fn_credit_and_log lost its chip credit, its chip receipt or its Diamond leg';
    END IF;
    IF r.proname='fn_settle_tournament_rake' AND (
         position('public.increment_union_wallet(' in r.def)=0
      OR position('public.credit_club_rake_to_treasury(' in r.def)=0
      OR position('fn_poker_diamond_tournament_settle_fee(' in r.def)=0) THEN
      RAISE EXCEPTION 'fn_settle_tournament_rake lost its chip destinations or its Diamond leg';
    END IF;
    IF r.proname='fn_complete_tournament_terminal_pre_seat_guard' AND (
         position($c$'terminal receipt: exact zero'$c$ in r.def)=0
      OR position('fn_poker_diamond_tournament_open_shadow(' in r.def)=0) THEN
      RAISE EXCEPTION 'the terminal writer lost its exact-zero close or its Diamond shadow';
    END IF;
    IF r.proname='fn_ca_tournament_terminal_receipt' AND (
         position($c$'tournament % rake is not durably and successfully attributed'$c$ in r.def)=0
      OR position('fn_poker_diamond_tournament_escrow(p_tournament_id) e' in r.def)=0) THEN
      RAISE EXCEPTION 'the terminal receipt reader lost its rake proof or its Diamond fee';
    END IF;
  END LOOP;
  RAISE NOTICE 'a Diamond tournament pays from its own custody: settlement legs installed, nothing opened';
END $do$;
