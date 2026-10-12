-- LIVE DIAMOND CASH DOORS, captured read-only from production (pg_get_functiondef) on 2026-09-30 at 11:4x UTC
-- for scripts/qualification/diamond-lock-waits.py (Diamond Phase 11 line 5). The harness loads these over the
-- tests/sql accepted-hand fixture (whose own copies date from 2026-09-10 and no longer match production) and
-- refuses to measure unless md5(pg_get_functiondef(...)) of each equals the live md5 below. The table
-- columns the plain-cash rule reads are added first by diamond-lock-waits-schema.sql.
--   fn_poker_diamond_settle_cash_hand      3aab9170062e97840afc7d15999691ad
--   fn_poker_diamond_reserve               cf2150429728d8d796711e9bdbb22f51
--   fn_poker_diamond_release               d525cb1e20d6fb05e5b5e51497b127e7
--   fn_poker_diamond_seat_keeps_custody    d80aed613a97e567268cb2bf6fdfd094
--   fn_ca_share_settlement_lane_for_table  409b14ee72ce888d3b26524c52d49a68
--   fn_poker_diamond_cash_variant          929c207a922004eb0e764011a2fe386c
--   fn_poker_diamond_plain_cash_table      94fb4dd7359850d388262de813c0caf1
--   fn_poker_diamond_top_up                fe1cf0ce225ef0977ceef3dd8bfb4598


CREATE OR REPLACE FUNCTION public.fn_poker_diamond_cash_variant(p_variant text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  /* NULL-SAFE ON PURPOSE. `NULL IN (...)` is NULL, not false, so without the
     first clause an unset `game_variant` made the whole plain-cash rule return
     NULL rather than false: a row that is neither admitted nor refused. Every
     caller today happens to treat unknown as refusal, which is exactly the
     kind of accident that holds until one of them writes `IF fn(...) = false`.
     An unset game is not a game. */
  SELECT p_variant IS NOT NULL
     AND p_variant IN ('nlh','plo4','plo5','plo6','plo8','pineapple','short_deck','flh','flo8');
$function$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_settle_cash_hand(p_table_id uuid, p_hand_number bigint, p_stacks jsonb, p_rake numeric, p_bbj numeric, p_ref text, p_inflow numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_arena uuid;
  v_request jsonb;
  v_stacks jsonb;
  v_prior public.poker_diamond_hand_receipts%ROWTYPE;
  v_c public.poker_diamond_custody%ROWTYPE;
  v_seat public.table_seats%ROWTYPE;
  v_e jsonb;
  v_lot record;
  v_before bigint;
  v_after bigint;
  v_loss bigint;
  v_take bigint;
  v_written jsonb := '{}'::jsonb;
  v_result jsonb;
BEGIN
  IF p_table_id IS NULL OR p_hand_number IS NULL OR p_hand_number < 1000000
     OR COALESCE(p_rake,0) <> 0 OR COALESCE(p_bbj,0) <> 0
     OR COALESCE(p_inflow,0) <> 0 THEN
    RAISE EXCEPTION 'diamond_plain_cash_hand_required' USING ERRCODE='22023';
  END IF;
  IF jsonb_typeof(p_stacks) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'diamond_hand_roster_required' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(p_stacks) < 2 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_stacks) x
    WHERE jsonb_typeof(x) IS DISTINCT FROM 'object'
       OR jsonb_typeof(x->'user_id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
       OR jsonb_typeof(x->'stack_before') IS DISTINCT FROM 'number'
       OR jsonb_typeof(x->'stack') IS DISTINCT FROM 'number'
  ) THEN
    RAISE EXCEPTION 'diamond_exact_hand_roster_required' USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_stacks) x
    WHERE NOT pg_input_is_valid(x->>'user_id','uuid')
       OR NOT pg_input_is_valid(x->>'seat_id','uuid')
       OR NOT pg_input_is_valid(x->>'seat_joined_at','timestamp with time zone')
       OR (x->>'stack')::numeric NOT BETWEEN 0 AND 2147483647
       OR (x->>'stack_before')::numeric NOT BETWEEN 0 AND 2147483647
       OR (x->>'stack')::numeric <> trunc((x->>'stack')::numeric)
       OR (x->>'stack_before')::numeric <> trunc((x->>'stack_before')::numeric)
  ) OR (SELECT count(*) <> count(DISTINCT (x->>'user_id')::uuid)
         OR count(*) <> count(DISTINCT (x->>'seat_id')::uuid)
        FROM jsonb_array_elements(p_stacks) x) THEN
    RAISE EXCEPTION 'diamond_invalid_hand_amount_or_generation' USING ERRCODE='22023';
  END IF;
  IF (SELECT sum((x->>'stack')::numeric - (x->>'stack_before')::numeric)
      FROM jsonb_array_elements(p_stacks) x) <> 0 THEN
    RAISE EXCEPTION 'diamond_hand_does_not_conserve' USING ERRCODE='23514';
  END IF;

  SELECT t.club_id INTO v_arena FROM public.tables t
  JOIN public.clubs c ON c.id=t.club_id
  WHERE t.id=p_table_id AND c.asset='diamonds' AND c.is_platform IS TRUE
    AND c.union_id IS NULL AND t.union_id IS NULL
    AND t.tournament_id IS NULL AND public.fn_poker_diamond_cash_variant(t.game_variant)
  FOR UPDATE OF t;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'diamond_plain_cash_table_required' USING ERRCODE='23514';
  END IF;
  SELECT jsonb_agg(jsonb_build_object(
    'user_id',(x->>'user_id')::uuid, 'seat_id',(x->>'seat_id')::uuid,
    'seat_joined_at',(x->>'seat_joined_at')::timestamptz,
    'stack_before',(x->>'stack_before')::bigint, 'stack',(x->>'stack')::bigint)
    ORDER BY (x->>'user_id')::uuid) INTO v_stacks
    FROM jsonb_array_elements(p_stacks) x;
  v_request := jsonb_build_object('stacks',v_stacks,'ref',p_ref,
    'rake',p_rake,'bbj',p_bbj,'inflow',p_inflow);

  SELECT * INTO v_prior FROM public.poker_diamond_hand_receipts
    WHERE table_id=p_table_id AND hand_number=p_hand_number;
  IF FOUND THEN
    IF v_prior.request IS DISTINCT FROM v_request THEN
      RAISE EXCEPTION 'diamond_hand_payload_mismatch' USING ERRCODE='22023';
    END IF;
    RETURN v_prior.receipt || jsonb_build_object('replay',true);
  END IF;

  -- Match the wallet/refund lock order before touching purchase lots.
  PERFORM p.id FROM public.profiles p
    JOIN jsonb_array_elements(v_stacks) x ON (x->>'user_id')::uuid=p.id
    ORDER BY p.id FOR UPDATE OF p;
  -- Validate the entire roster while locks are held before changing one balance.
  FOR v_e IN SELECT value FROM jsonb_array_elements(v_stacks) LOOP
    SELECT * INTO v_seat FROM public.table_seats
      WHERE id=(v_e->>'seat_id')::uuid AND table_id=p_table_id
        AND user_id=(v_e->>'user_id')::uuid
        AND joined_at=(v_e->>'seat_joined_at')::timestamptz
        AND left_at IS NULL FOR UPDATE;
    IF NOT FOUND OR v_seat.stack IS DISTINCT FROM (v_e->>'stack_before')::numeric THEN
      RAISE EXCEPTION 'diamond_hand_stale_seat' USING ERRCODE='55000';
    END IF;
    SELECT * INTO v_c FROM public.poker_diamond_custody
      WHERE occupancy_id=v_seat.occupancy_id AND seat_id=v_seat.id
        AND seat_joined_at=v_seat.joined_at AND user_id=v_seat.user_id
        AND target_id=p_table_id AND arena_id=v_arena
        AND purpose='cash_seat' AND state='active' FOR UPDATE;
    IF NOT FOUND OR v_c.balance IS DISTINCT FROM (v_e->>'stack_before')::bigint THEN
      RAISE EXCEPTION 'diamond_hand_custody_mismatch' USING ERRCODE='23514';
    END IF;
  END LOOP;

  FOR v_e IN SELECT value FROM jsonb_array_elements(v_stacks) LOOP
    SELECT * INTO STRICT v_c FROM public.poker_diamond_custody
      WHERE seat_id=(v_e->>'seat_id')::uuid
        AND seat_joined_at=(v_e->>'seat_joined_at')::timestamptz
        AND user_id=(v_e->>'user_id')::uuid AND target_id=p_table_id AND state='active';
    v_before := (v_e->>'stack_before')::bigint;
    v_after := (v_e->>'stack')::bigint;
    v_loss := greatest(v_before-v_after,0);
    FOR v_lot IN
      SELECT l.id,r.amount-r.consumed AS held,
        greatest(l.issued-l.consumed-l.refunded,0) AS outstanding
      FROM public.poker_diamond_lot_reservations r
      JOIN public.diamond_purchase_lots l ON l.id=r.lot_id
      WHERE r.custody_id=v_c.id AND r.released_at IS NULL
      ORDER BY l.created_at,l.id FOR UPDATE OF l,r
    LOOP
      EXIT WHEN v_loss=0;
      v_take := least(v_loss,v_lot.held);
      IF v_take>0 THEN
        -- A provider reversal may already have retired this liability.
        -- Remove the hold once; consume only liability still outstanding.
        UPDATE public.diamond_purchase_lots
          SET arena_reserved=arena_reserved-v_take,
              consumed=consumed+least(v_take,v_lot.outstanding)::integer
          WHERE id=v_lot.id;
        UPDATE public.poker_diamond_lot_reservations
          SET consumed=consumed+v_take
          WHERE custody_id=v_c.id AND lot_id=v_lot.id;
        v_loss := v_loss-v_take;
      END IF;
    END LOOP;
    UPDATE public.poker_diamond_custody SET balance=v_after WHERE id=v_c.id;
    UPDATE public.table_seats SET stack=v_after
      WHERE id=v_c.seat_id AND joined_at=v_c.seat_joined_at
        AND occupancy_id=v_c.occupancy_id AND left_at IS NULL;
    IF NOT EXISTS (SELECT 1 FROM public.table_seats
      WHERE id=v_c.seat_id AND joined_at=v_c.seat_joined_at
        AND occupancy_id=v_c.occupancy_id AND left_at IS NULL AND stack=v_after) THEN
      RAISE EXCEPTION 'diamond_hand_seat_write_failed' USING ERRCODE='23514';
    END IF;
    v_written := v_written || jsonb_build_object(v_c.user_id::text,v_after);
  END LOOP;
  v_result := jsonb_build_object('success',true,'asset','diamonds',
    'players',jsonb_array_length(v_stacks),'table_id',p_table_id,
    'hand_id',md5('ca-hand:'||p_table_id||':'||p_hand_number
      ||CASE WHEN p_ref IS NULL OR p_ref='' THEN '' ELSE ':'||p_ref END)::uuid,
    'hand_number',p_hand_number,'net_deltas',0,'rake',p_rake,'bbj',p_bbj,
    'inflow',p_inflow,'mode','delta','rebased','{}'::jsonb,
    'written',v_written,'departed','[]'::jsonb,'conservation_checked',true,
    'request',v_request);
  INSERT INTO public.poker_diamond_hand_receipts(table_id,hand_number,request,receipt)
    VALUES(p_table_id,p_hand_number,v_request,v_result);
  RETURN v_result;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_reserve(p_user_id uuid, p_purpose text, p_target_id uuid, p_entry_key text, p_amount numeric, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
 v_request jsonb; v_previous public.poker_diamond_movements%ROWTYPE;
 v_wallet bigint; v_arena uuid; v_asset text; v_platform boolean; v_union uuid;
 v_min numeric; v_max numeric; v_status text; v_custody uuid; v_journal uuid;
 v_locked bigint; v_days integer; v_left bigint; v_take bigint; v_lot record; v_receipt jsonb;
BEGIN
 IF p_user_id IS NULL OR p_target_id IS NULL OR p_request_id IS NULL
    OR p_purpose IS NULL OR p_purpose NOT IN ('cash_seat','tournament_entry')
    OR p_entry_key IS NULL OR length(p_entry_key) NOT BETWEEN 1 AND 160
    OR p_amount IS NULL OR p_amount <= 0 OR p_amount > 2147483647 OR p_amount <> trunc(p_amount) THEN
   RAISE EXCEPTION 'invalid_diamond_reservation' USING ERRCODE = '22023';
 END IF;
 v_request := jsonb_build_object('user_id',p_user_id,'purpose',p_purpose,'target_id',p_target_id,
   'entry_key',p_entry_key,'amount',p_amount,'action','reserve');
 -- All operations for one wallet serialize on that profile, including shop spend/refunds.
 SELECT diamonds INTO v_wallet FROM public.profiles WHERE id=p_user_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'profile_not_found'; END IF;
 SELECT * INTO v_previous FROM public.poker_diamond_movements WHERE request_id=p_request_id;
 IF FOUND THEN
   IF v_previous.request <> v_request THEN RAISE EXCEPTION 'idempotency_payload_mismatch'; END IF;
   RETURN v_previous.receipt;
 END IF;
 IF p_purpose='cash_seat' THEN
   SELECT t.club_id,t.min_buy_in,t.max_buy_in,t.status INTO v_arena,v_min,v_max,v_status
   FROM public.tables t WHERE t.id=p_target_id FOR SHARE;
   IF NOT FOUND OR v_min IS NULL OR v_max IS NULL OR p_amount<v_min OR p_amount>v_max THEN
     RAISE EXCEPTION 'invalid_diamond_table_buy_in';
   END IF;
 ELSE
   SELECT t.club_id,t.buy_in_amount+COALESCE(t.buy_in_fee,0),t.status
   INTO v_arena,v_min,v_status FROM public.tournaments t
     JOIN public.clubs c ON c.id=t.club_id
     JOIN public.ca_arena_settings a ON a.id=1 AND a.club_id=c.id
   WHERE t.id=p_target_id AND c.asset='diamonds' AND c.is_platform IS TRUE
     AND c.union_id IS NULL AND t.union_id IS NULL AND a.tournaments_enabled
   FOR SHARE OF t;
   IF NOT FOUND THEN
     RAISE EXCEPTION 'diamond_tournaments_not_open' USING ERRCODE='55000';
   END IF;
   IF v_min IS NULL OR p_amount<>v_min THEN RAISE EXCEPTION 'invalid_diamond_entry_price'; END IF; END IF;
 SELECT asset,is_platform,union_id INTO v_asset,v_platform,v_union FROM public.clubs WHERE id=v_arena FOR SHARE;
 IF v_asset IS DISTINCT FROM 'diamonds' OR v_platform IS DISTINCT FROM true OR v_union IS NOT NULL THEN
   RAISE EXCEPTION 'diamond_asset_required';
 END IF;
 IF v_status IS NULL OR v_status IN ('completed','cancelled','closed','archived') THEN
   RAISE EXCEPTION 'diamond_target_closed';
 END IF;
 SELECT settlement_window_days INTO v_days FROM public.ca_arena_settings WHERE id=1 AND club_id=v_arena;
 IF v_days IS NULL THEN RAISE EXCEPTION 'diamond_arena_policy_missing'; END IF;
 IF EXISTS(SELECT 1 FROM public.diamond_debts WHERE user_id=p_user_id AND settled_at IS NULL AND amount>0) THEN
   RAISE EXCEPTION 'diamond_debt_requires_settlement';
 END IF;
 -- Lock lots before evaluating age/freeze, so a concurrent dispute cannot slip through.
 PERFORM id FROM public.diamond_purchase_lots WHERE user_id=p_user_id ORDER BY created_at,id FOR UPDATE;
 SELECT COALESCE(sum(GREATEST(issued-consumed-refunded-arena_reserved,0)),0) INTO v_locked
 FROM public.diamond_purchase_lots WHERE user_id=p_user_id
 AND (frozen_at IS NOT NULL OR created_at>now()-make_interval(days=>v_days));
 IF v_wallet IS NULL OR v_wallet-v_locked<p_amount THEN
   -- RULING 14 / DR16. A lot frozen or younger than the settlement window is not depositable,
   -- and this door has refused it by this name since Phase 3. The rule mode is READ here so
   -- DR16 has a consumer and a flip means something (the DR15 shape, 20260908041432). The
   -- refusal stands in both modes: the lot reservation below draws only on settled lots, so
   -- an unsettled lot admitted here would sit in custody with nothing for a chargeback to
   -- find. Armed, the same refusal is raised under the rule's own code with the numbers in
   -- its DETAIL; a raise cannot file an incident that survives it (20260906102549), so the
   -- evidence rides in the error, where the Postgres log counts it. The leading token is
   -- what the engine and the client match on and does not change.
   IF v_locked>0 AND v_wallet IS NOT NULL AND v_wallet>=p_amount
      AND public.fn_ca_diamond_rule_mode('DR16:deposit_inside_settlement_window')='refuse' THEN
     RAISE EXCEPTION 'insufficient_settled_diamonds' USING ERRCODE='P0416',
       DETAIL=format('DR16:deposit_inside_settlement_window refused %s: %s purchased diamond(s) frozen or inside the %s-day settlement window; %s settled',
                     p_amount, v_locked, v_days, v_wallet-v_locked);
   END IF;
   RAISE EXCEPTION 'insufficient_settled_diamonds';
 END IF;
 INSERT INTO public.poker_diamond_custody(user_id,arena_id,purpose,target_id,entry_key,balance)
 VALUES(p_user_id,v_arena,p_purpose,p_target_id,p_entry_key,p_amount) RETURNING id INTO v_custody;
 v_left:=p_amount;
 FOR v_lot IN SELECT id,GREATEST(issued-consumed-refunded-arena_reserved,0) available
 FROM public.diamond_purchase_lots WHERE user_id=p_user_id AND frozen_at IS NULL
 AND created_at<=now()-make_interval(days=>v_days) ORDER BY created_at,id LOOP
   EXIT WHEN v_left=0;
   v_take:=LEAST(v_left,v_lot.available);
   IF v_take>0 THEN
     UPDATE public.diamond_purchase_lots SET arena_reserved=arena_reserved+v_take WHERE id=v_lot.id;
     INSERT INTO public.poker_diamond_lot_reservations(custody_id,lot_id,amount) VALUES(v_custody,v_lot.id,v_take);
     v_left:=v_left-v_take;
   END IF;
 END LOOP;
 -- Journal the transfer before the balance update so the existing DR6 audit
 -- sees its evidence inside this same atomic transaction.
 INSERT INTO public.diamond_transactions(user_id,type,transaction_type,amount,balance_after,reference_id,
 description,source,issuance_class,counterparty,metadata)
 VALUES(p_user_id,'arena_deposit','arena_deposit',-p_amount::integer,v_wallet-p_amount,
 'poker-reserve:'||p_request_id,'Reserved diamonds for Poker Arena','poker_arena','arena',
 'arena_custody:'||v_custody,jsonb_build_object('custody_id',v_custody,'request_id',p_request_id,
 'purpose',p_purpose,'target_id',p_target_id,'purchased_reserved',p_amount-v_left)) RETURNING id INTO v_journal;
 UPDATE public.profiles SET diamonds=diamonds-p_amount::integer,updated_at=now() WHERE id=p_user_id;
 v_receipt:=jsonb_build_object('success',true,'custody_id',v_custody,'request_id',p_request_id,
 'amount',p_amount,'available_balance',v_wallet-p_amount,'custody_balance',p_amount,'journal_id',v_journal);
 INSERT INTO public.poker_diamond_movements(request_id,custody_id,user_id,action,amount,source_account,
 destination_account,wallet_journal_id,request,receipt)
 VALUES(p_request_id,v_custody,p_user_id,'reserve',p_amount,'player:'||p_user_id,
 'arena_custody:'||v_custody,v_journal,v_request,v_receipt);
 RETURN v_receipt;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_release(p_custody_id uuid, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_owner uuid;
  v_c public.poker_diamond_custody%ROWTYPE;
  v_prev public.poker_diamond_movements%ROWTYPE;
  v_request jsonb;
  v_credit jsonb;
  v_receipt jsonb;
  v_lot record;
  v_debt_journal uuid;
BEGIN
  IF p_custody_id IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'invalid_diamond_release' USING ERRCODE = '22023';
  END IF;

  SELECT user_id INTO v_owner
    FROM public.poker_diamond_custody
   WHERE id = p_custody_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'diamond_custody_not_found';
  END IF;

  -- The wallet always locks before its custody, exactly as reserve does.
  PERFORM id FROM public.profiles WHERE id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_not_found';
  END IF;
  SELECT * INTO v_c
    FROM public.poker_diamond_custody
   WHERE id = p_custody_id
   FOR UPDATE;

  v_request := jsonb_build_object(
    'action', 'release',
    'custody_id', p_custody_id,
    'user_id', v_owner
  );

  SELECT * INTO v_prev
    FROM public.poker_diamond_movements
   WHERE request_id = p_request_id;
  IF FOUND THEN
    IF v_prev.request <> v_request THEN
      RAISE EXCEPTION 'idempotency_payload_mismatch';
    END IF;
    RETURN v_prev.receipt;
  END IF;

  IF v_c.state = 'released' THEN
    RAISE EXCEPTION 'diamond_custody_already_released';
  END IF;
  -- A DIAMOND TOURNAMENT ENTRY GOES HOME ONLY THROUGH ITS REFUND AUTHORITY
  -- (Phase 8). fn_poker_diamond_tournament_refund names this row in a
  -- transaction-local setting for the one call it makes; any other caller,
  -- service role included, is refused. An entry in play is never releasable.
  IF v_c.purpose = 'tournament_entry'
     AND current_setting('app.poker_diamond_tournament_release', true) IS DISTINCT FROM p_custody_id::text THEN
    RAISE EXCEPTION 'diamond_tournament_entry_requires_refund_authority' USING ERRCODE = '42501';
  END IF;
  -- An ACTIVE tournament entry (activated by the entry door, as the seat
  -- guards P0810-P0812 require) is released whole by its refund authority;
  -- the settlement test below is the cash seat's and stays the cash seat's.
  IF v_c.state <> 'reserved' AND v_c.purpose <> 'tournament_entry' THEN
    IF v_c.state <> 'active' OR v_c.purpose <> 'cash_seat'
       OR v_c.occupancy_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM public.table_seats s
          WHERE s.id=v_c.seat_id AND s.joined_at=v_c.seat_joined_at
            AND s.occupancy_id=v_c.occupancy_id AND s.user_id=v_c.user_id
            AND s.table_id=v_c.target_id AND s.left_at IS NOT NULL
            AND s.stack=v_c.balance) THEN
      RAISE EXCEPTION 'diamond_custody_requires_settlement';
    END IF;
  END IF;

  FOR v_lot IN
    SELECT l.id, r.amount-r.consumed AS amount
      FROM public.poker_diamond_lot_reservations r
      JOIN public.diamond_purchase_lots l ON l.id = r.lot_id
     WHERE r.custody_id = p_custody_id
       AND r.released_at IS NULL
     ORDER BY l.created_at, l.id
     FOR UPDATE OF l
  LOOP
    UPDATE public.diamond_purchase_lots
       SET arena_reserved = arena_reserved - v_lot.amount
     WHERE id = v_lot.id;
  END LOOP;

  UPDATE public.poker_diamond_lot_reservations
     SET released_at = now()
   WHERE custody_id = p_custody_id
     AND released_at IS NULL;

  IF v_c.balance > 0 THEN
  v_credit := public.add_diamonds_to_balance(
    v_owner,
    v_c.balance::integer,
    'arena_withdraw',
    'Released Poker Arena reservation',
    'poker-release:' || p_custody_id || ':' || p_request_id
  );
  IF (v_credit->>'success')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'diamond_release_credit_failed:%', v_credit->>'error';
  END IF;

  ELSE
    SELECT jsonb_build_object('success',true,'new_balance',diamonds,
      'debt_settled',0,'transaction_id',NULL) INTO v_credit
      FROM public.profiles WHERE id=v_owner;
  END IF;

  IF COALESCE((v_credit->>'debt_settled')::bigint, 0) > 0 THEN
    SELECT id INTO v_debt_journal
      FROM public.diamond_transactions
     WHERE user_id = v_owner
       AND reference_id = 'debt-settlement:' || (v_credit->>'transaction_id')
       AND type = 'debt_settlement'
       AND amount = -(v_credit->>'debt_settled')::bigint;
    IF v_debt_journal IS NULL THEN
      RAISE EXCEPTION 'diamond_debt_journal_missing';
    END IF;

    PERFORM public.fn_ca_register_diamond_journal_row(v_debt_journal);
    IF NOT EXISTS (
      SELECT 1
        FROM public.ca_mint_ledger
       WHERE diamond_tx_id = v_debt_journal
         AND action = 'burn'
         AND asset = 'diamonds'
         AND holder_type = 'player'
         AND holder_id = v_owner
         AND amount = (v_credit->>'debt_settled')::bigint
    ) THEN
      RAISE EXCEPTION 'diamond_debt_retirement_missing';
    END IF;
  END IF;

  UPDATE public.poker_diamond_custody
     SET balance = 0,
         state = 'released',
         released_at = now()
   WHERE id = p_custody_id;

  v_receipt := jsonb_build_object(
    'success', true,
    'custody_id', p_custody_id,
    'request_id', p_request_id,
    'amount', v_c.balance,
    'available_balance', (v_credit->>'new_balance')::bigint,
    'custody_balance', 0,
    'debt_settled', (v_credit->>'debt_settled')::bigint,
    'journal_id', v_credit->>'transaction_id'
  );

  INSERT INTO public.poker_diamond_movements(
    request_id, custody_id, user_id, action, amount,
    source_account, destination_account, wallet_journal_id, request, receipt
  ) VALUES (
    p_request_id, p_custody_id, v_owner, 'release', v_c.balance,
    'arena_custody:' || p_custody_id, 'player:' || v_owner,
    (v_credit->>'transaction_id')::uuid, v_request, v_receipt
  );

  RETURN v_receipt;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_seat_keeps_custody()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_ids uuid[];
BEGIN
 IF TG_OP='INSERT' THEN v_ids:=ARRAY[NEW.id];
 ELSIF TG_OP='DELETE' THEN v_ids:=ARRAY[OLD.id];
 ELSE v_ids:=ARRAY[OLD.id,NEW.id]; END IF;
 IF EXISTS (
   SELECT 1 FROM public.poker_diamond_custody c
   WHERE c.seat_id=ANY(v_ids) AND c.state='active' AND c.purpose='cash_seat'
     AND NOT EXISTS(SELECT 1 FROM public.table_seats s
       WHERE s.id=c.seat_id AND s.joined_at=c.seat_joined_at
         AND s.occupancy_id=c.occupancy_id AND s.user_id=c.user_id
         AND s.table_id=c.target_id AND s.club_id=c.arena_id
         AND s.left_at IS NULL AND s.stack=c.balance)
 ) OR EXISTS(
   SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
     JOIN public.clubs a ON a.id=t.club_id
   WHERE s.id=ANY(v_ids) AND a.asset='diamonds' AND s.left_at IS NULL
     AND t.tournament_id IS NULL
     AND NOT EXISTS(SELECT 1 FROM public.poker_diamond_custody c
       WHERE c.seat_id=s.id AND c.seat_joined_at=s.joined_at AND c.occupancy_id=s.occupancy_id
         AND c.user_id=s.user_id AND c.target_id=s.table_id AND c.arena_id=s.club_id
         AND c.purpose='cash_seat' AND c.state='active' AND c.balance=s.stack)
 ) THEN
   RAISE EXCEPTION 'diamond_seat_and_custody_must_commit_together' USING ERRCODE='23514';
 END IF;
 /* A DIAMOND TOURNAMENT SEAT HOLDS AN ENTRY, NOT A BALANCE. The stack is a
    nonredeemable play unit and bears no relation to custody, so nothing in
    this arm compares it to anything. What must be true at every commit is that
    the seat is covered by a live funded entry for THIS event, held against the
    tournament and not against the seat. */
 IF EXISTS(
   SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
     JOIN public.clubs a ON a.id=t.club_id
   WHERE s.id=ANY(v_ids) AND a.asset='diamonds' AND s.left_at IS NULL
     AND t.tournament_id IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM public.poker_diamond_custody c
       WHERE c.user_id=s.user_id AND c.target_id=t.tournament_id AND c.arena_id=s.club_id
         AND c.purpose='tournament_entry' AND c.state='active' AND c.seat_id IS NULL)
 ) THEN
   RAISE EXCEPTION 'A Diamond Tournament Seat Must Hold Its Funded Entry' USING ERRCODE='P0812';
 END IF;
 RETURN NULL;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_ca_share_settlement_lane_for_table(p_table_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
BEGIN
  -- Acquire G before B and T; source custody guards also need G.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  -- B shared: yields to terminal authorities, concurrent with every other
  -- hand and with rolling authorities of OTHER tournaments.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:hand-settlement-barrier:v1', 0));

  IF p_table_id IS NULL THEN
    RETURN;
  END IF;

  SELECT tb.tournament_id INTO v_tournament_id
  FROM public.tables tb
  WHERE tb.id = p_table_id;

  IF v_tournament_id IS NOT NULL THEN
    -- T(id) shared: yields to this tournament's own rolling authorities.
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended('ca:tournament-terminal-settlement:v1:' || v_tournament_id::text, 0));
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_plain_cash_table(p_t tables)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT NOT (
    NOT public.fn_poker_diamond_cash_variant(p_t.game_variant)
    OR p_t.tournament_id IS NOT NULL
    OR p_t.cluster_id IS NOT NULL
    OR coalesce(p_t.is_template,false)
    OR p_t.status NOT IN ('waiting','running','playing','active')
    OR p_t.rake_percent IS DISTINCT FROM 0 OR p_t.rake_cap_bb IS DISTINCT FROM 0
    OR p_t.bbj_percent IS DISTINCT FROM 0
    OR coalesce(p_t.insurance_enabled,false)
    OR p_t.run_it_twice IS NULL OR p_t.allow_run_it_twice IS NULL
    OR coalesce(p_t.seven_deuce_enabled,false) OR coalesce(p_t.nit_game,false)
    OR coalesce(p_t.all_in_or_fold,false) OR coalesce(p_t.pineapple_holdem,false)
    OR coalesce(p_t.cap_enabled,false)
  );
$function$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_top_up(p_user_id uuid, p_table_id uuid, p_amount numeric, p_expected_stack numeric, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
 IF NOT public.fn_poker_diamond_plain_cash_table(v_t) THEN
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
END $function$;
