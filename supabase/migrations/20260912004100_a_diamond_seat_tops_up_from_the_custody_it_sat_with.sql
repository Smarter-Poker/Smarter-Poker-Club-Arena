-- A seated Diamond player may add whole Diamonds to the seat they already funded.
-- The money arrives the way it arrived at the door: reserved out of
-- profiles.diamonds against settled purchase lots, held by the SAME custody row
-- the seat is bound to, and written to table_seats in the same transaction, so
-- the deferred constraint that keeps a Diamond seat equal to its custody never
-- sees the two apart. No chip wallet, no club balance, no pending add-on ledger
-- is touched, because none of them exists on this side of the arena.
--
-- BETWEEN HANDS ONLY. The engine is the only caller and calls this only when no
-- hand is in progress. The door does not take that on trust: it is handed the
-- stack the caller believes it is topping up and refuses anything else, so a
-- top-up that slipped into a dealt hand fails here instead of moving a stack the
-- hand is already counting. The accepted-hand settler makes the same check from
-- the other side (diamond_hand_stale_seat).
--
-- No app.money_path is declared. That setting exists for the seat CREATION guard
-- (fn_ca_guard_seat_creation, BEFORE INSERT OR UPDATE OF left_at); this path
-- creates no seat and revives none, so declaring a path no guard reads would say
-- something untrue about which door this is.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DO $preflight$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_poker_diamond_reserve(uuid,text,uuid,text,numeric,uuid)'::regprocedure) IS DISTINCT FROM '91a900bfe1bd39e39a007f7fc70b7681'
    OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_poker_diamond_settle_cash_hand(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure) IS DISTINCT FROM 'c1a148d932af73ce8d77743069b6d248'
    OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_poker_diamond_seat_keeps_custody()'::regprocedure) IS DISTINCT FROM 'b4878c966c506b435e3b40ee4a049d9b'
    OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_poker_diamond_buyin(uuid,uuid,integer,numeric,boolean,uuid,uuid)'::regprocedure) IS DISTINCT FROM 'f9a98897558d101de6a010dbfbeb938c' THEN
  RAISE EXCEPTION 'diamond_top_up_prerequisite_changed';
 END IF;
END $preflight$;

-- A function that can move money is registered before it exists, not after.
INSERT INTO public.ca_money_rpc_registry (proname,status,notes) VALUES
 ('fn_poker_diamond_top_up','approved',
  'Moves whole Diamonds from profiles.diamonds into the seat''s own poker_diamond_custody row and raises table_seats.stack in the same transaction. Gated by the Diamond plain cash table boundary, cash_games_enabled, the settled purchase lot window, the table max buy-in and an exact expected stack match. Engine-only (service_role). Journaled as an arena_deposit in diamond_transactions with a poker_diamond_movements reserve row keyed by the caller request id.')
ON CONFLICT (proname) DO UPDATE SET status=EXCLUDED.status,notes=EXCLUDED.notes;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_top_up(
 p_user_id uuid,p_table_id uuid,p_amount numeric,p_expected_stack numeric,p_request_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE
 v_t public.tables%ROWTYPE;
 v_seat public.table_seats%ROWTYPE;
 v_c public.poker_diamond_custody%ROWTYPE;
 v_prev public.poker_diamond_movements%ROWTYPE;
 v_request jsonb; v_receipt jsonb;
 v_wallet bigint; v_locked bigint; v_days integer;
 v_left bigint; v_take bigint; v_lot record; v_journal uuid;
BEGIN
 IF p_user_id IS NULL OR p_table_id IS NULL OR p_request_id IS NULL
    OR p_amount IS NULL OR p_amount NOT BETWEEN 1 AND 2147483647 OR p_amount<>trunc(p_amount)
    OR p_expected_stack IS NULL OR p_expected_stack NOT BETWEEN 0 AND 2147483647
    OR p_expected_stack<>trunc(p_expected_stack) THEN
  RAISE EXCEPTION 'invalid_diamond_top_up' USING ERRCODE='22023';
 END IF;
 v_request:=jsonb_build_object('user_id',p_user_id,'table_id',p_table_id,
  'amount',p_amount,'expected_stack',p_expected_stack,'action','top_up');
 PERFORM pg_advisory_xact_lock(hashtextextended('table_seat:'||p_table_id,0));
 -- Wallet first, exactly as the reserve and the hand settler take it.
 SELECT diamonds INTO v_wallet FROM public.profiles WHERE id=p_user_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'profile_not_found'; END IF;
 SELECT * INTO v_prev FROM public.poker_diamond_movements WHERE request_id=p_request_id;
 IF FOUND THEN
  IF v_prev.request IS DISTINCT FROM v_request THEN
   RAISE EXCEPTION 'idempotency_payload_mismatch';
  END IF;
  RETURN v_prev.receipt;
 END IF;
 SELECT t.* INTO v_t FROM public.tables t
   JOIN public.clubs c ON c.id=t.club_id
   JOIN public.ca_arena_settings a ON a.id=1 AND a.club_id=c.id
 WHERE t.id=p_table_id AND c.asset='diamonds' AND c.is_platform IS TRUE
   AND c.union_id IS NULL AND t.union_id IS NULL AND a.cash_games_enabled
 FOR UPDATE OF t;
 IF NOT FOUND THEN RAISE EXCEPTION 'diamond_cash_not_open' USING ERRCODE='55000'; END IF;
 IF v_t.game_variant IS DISTINCT FROM 'nlh' OR v_t.tournament_id IS NOT NULL
    OR v_t.cluster_id IS NOT NULL
    OR coalesce(v_t.is_template,false) OR v_t.status NOT IN ('waiting','running','playing','active')
    OR coalesce(v_t.rake_percent,0)<>0 OR coalesce(v_t.bbj_percent,0)<>0
    OR coalesce(v_t.insurance_enabled,false) OR coalesce(v_t.bomb_pot_enabled,false)
    OR coalesce(v_t.run_it_twice_enabled,false) OR coalesce(v_t.run_it_twice,false)
    OR coalesce(v_t.allow_run_it_twice,false) OR coalesce(v_t.straddle_enabled,false)
    OR coalesce(v_t.seven_deuce_enabled,false) OR coalesce(v_t.nit_game,false)
    OR coalesce(v_t.all_in_or_fold,false) OR coalesce(v_t.pineapple_holdem,false)
    OR coalesce(v_t.cap_enabled,false) OR coalesce(v_t.auto_utg_straddle,false)
    OR coalesce(v_t.voluntary_straddle,false) THEN
  RAISE EXCEPTION 'diamond_plain_cash_table_required' USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM (VALUES(v_t.small_blind),(v_t.big_blind),
      (v_t.min_buy_in),(v_t.max_buy_in)) AS amount(value)
      WHERE value IS NULL OR value NOT BETWEEN 1 AND 2147483647 OR value<>trunc(value))
    OR COALESCE(v_t.ante,0) NOT BETWEEN 0 AND 9007199254740991
    OR COALESCE(v_t.ante,0)<>trunc(COALESCE(v_t.ante,0)) THEN
  RAISE EXCEPTION 'diamond_cash_requires_whole_amounts' USING ERRCODE='23514';
 END IF;
 SELECT * INTO v_seat FROM public.table_seats
  WHERE table_id=p_table_id AND user_id=p_user_id AND left_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'diamond_top_up_requires_a_live_seat' USING ERRCODE='55000';
 END IF;
 IF v_seat.stack IS DISTINCT FROM p_expected_stack THEN
  RAISE EXCEPTION 'diamond_top_up_stale_seat' USING ERRCODE='55000';
 END IF;
 IF v_seat.stack+p_amount>v_t.max_buy_in THEN
  RAISE EXCEPTION 'diamond_top_up_exceeds_max_buy_in' USING ERRCODE='23514';
 END IF;
 SELECT * INTO v_c FROM public.poker_diamond_custody
  WHERE occupancy_id=v_seat.occupancy_id AND seat_id=v_seat.id
    AND seat_joined_at=v_seat.joined_at AND user_id=p_user_id
    AND target_id=p_table_id AND arena_id=v_t.club_id
    AND purpose='cash_seat' AND state='active' FOR UPDATE;
 IF NOT FOUND OR v_c.balance IS DISTINCT FROM v_seat.stack::bigint THEN
  RAISE EXCEPTION 'diamond_top_up_custody_mismatch' USING ERRCODE='23514';
 END IF;
 SELECT settlement_window_days INTO v_days FROM public.ca_arena_settings
  WHERE id=1 AND club_id=v_t.club_id;
 IF v_days IS NULL THEN RAISE EXCEPTION 'diamond_arena_policy_missing'; END IF;
 IF EXISTS(SELECT 1 FROM public.diamond_debts
   WHERE user_id=p_user_id AND settled_at IS NULL AND amount>0) THEN
  RAISE EXCEPTION 'diamond_debt_requires_settlement';
 END IF;
 PERFORM id FROM public.diamond_purchase_lots WHERE user_id=p_user_id ORDER BY created_at,id FOR UPDATE;
 SELECT COALESCE(sum(GREATEST(issued-consumed-refunded-arena_reserved,0)),0) INTO v_locked
  FROM public.diamond_purchase_lots WHERE user_id=p_user_id
   AND (frozen_at IS NOT NULL OR created_at>now()-make_interval(days=>v_days));
 IF v_wallet IS NULL OR v_wallet-v_locked<p_amount THEN
  RAISE EXCEPTION 'insufficient_settled_diamonds';
 END IF;
 v_left:=p_amount;
 FOR v_lot IN SELECT id,GREATEST(issued-consumed-refunded-arena_reserved,0) available
  FROM public.diamond_purchase_lots WHERE user_id=p_user_id AND frozen_at IS NULL
   AND created_at<=now()-make_interval(days=>v_days) ORDER BY created_at,id LOOP
  EXIT WHEN v_left=0;
  v_take:=LEAST(v_left,v_lot.available);
  IF v_take>0 THEN
   UPDATE public.diamond_purchase_lots SET arena_reserved=arena_reserved+v_take WHERE id=v_lot.id;
   -- (custody_id,lot_id) is the primary key and the hand settler consumes a lot
   -- by that key. A second row for the same pair would let one loss be taken
   -- twice, so a lot this custody already holds has its held amount raised.
   UPDATE public.poker_diamond_lot_reservations SET amount=amount+v_take
     WHERE custody_id=v_c.id AND lot_id=v_lot.id AND released_at IS NULL;
   IF NOT FOUND THEN
    BEGIN
     INSERT INTO public.poker_diamond_lot_reservations(custody_id,lot_id,amount)
      VALUES(v_c.id,v_lot.id,v_take);
    EXCEPTION WHEN unique_violation THEN
     RAISE EXCEPTION 'diamond_top_up_lot_already_released' USING ERRCODE='23514';
    END;
   END IF;
   v_left:=v_left-v_take;
  END IF;
 END LOOP;
 -- Journal before the balance, so the existing DR6 audit sees its evidence in
 -- this same atomic transaction.
 INSERT INTO public.diamond_transactions(user_id,type,transaction_type,amount,balance_after,
  reference_id,description,source,issuance_class,counterparty,metadata)
 VALUES(p_user_id,'arena_deposit','arena_deposit',-p_amount::integer,v_wallet-p_amount,
  'poker-topup:'||p_request_id,'Added diamonds to a Poker Arena seat','poker_arena','arena',
  'arena_custody:'||v_c.id,jsonb_build_object('custody_id',v_c.id,'request_id',p_request_id,
   'purpose','cash_seat','target_id',p_table_id,'seat_id',v_seat.id,
   'purchased_reserved',p_amount-v_left)) RETURNING id INTO v_journal;
 UPDATE public.profiles SET diamonds=diamonds-p_amount::integer,updated_at=now() WHERE id=p_user_id;
 UPDATE public.poker_diamond_custody SET balance=balance+p_amount WHERE id=v_c.id;
 UPDATE public.table_seats SET stack=stack+p_amount
  WHERE id=v_seat.id AND joined_at=v_seat.joined_at AND occupancy_id=v_seat.occupancy_id
    AND left_at IS NULL;
 IF NOT EXISTS(SELECT 1 FROM public.table_seats s
    JOIN public.poker_diamond_custody c ON c.id=v_c.id AND c.seat_id=s.id
   WHERE s.id=v_seat.id AND s.left_at IS NULL
     AND s.stack=v_seat.stack+p_amount AND c.balance=v_c.balance+p_amount) THEN
  RAISE EXCEPTION 'diamond_top_up_seat_write_failed' USING ERRCODE='23514';
 END IF;
 v_receipt:=jsonb_build_object('success',true,'custody_id',v_c.id,'request_id',p_request_id,
  'amount',p_amount,'stack',v_seat.stack+p_amount,'custody_balance',v_c.balance+p_amount,
  'available_balance',v_wallet-p_amount,'journal_id',v_journal);
 INSERT INTO public.poker_diamond_movements(request_id,custody_id,user_id,action,amount,
  source_account,destination_account,wallet_journal_id,request,receipt)
 VALUES(p_request_id,v_c.id,p_user_id,'reserve',p_amount,'player:'||p_user_id,
  'arena_custody:'||v_c.id,v_journal,v_request,v_receipt);
 RETURN v_receipt;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_top_up(uuid,uuid,numeric,numeric,uuid)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_top_up(uuid,uuid,numeric,numeric,uuid) TO service_role;
COMMENT ON FUNCTION public.fn_poker_diamond_top_up(uuid,uuid,numeric,numeric,uuid) IS
 'Engine-only Diamond seat top-up. Reserves settled Diamonds into the seat''s own custody row and raises table_seats.stack in the same transaction. Whole units only, capped at the table max buy-in, refused on a stale seat.';
COMMIT;
