-- ============================================================================
-- A DIAMOND BOUNTY IS PAID FROM ITS OWN BANK
-- ============================================================================
--
-- Phase 9 of the Diamond Arena programme, first piece: knockout bounties and
-- progressive (PKO) bounties in Diamonds. Phase 8 left the bounty bank in the
-- ledger - every entry's bounty part is decomposed and summed by
-- fn_poker_diamond_tournament_escrow - but refused it at three doors by
-- name: the charge would not carry a bounty part, the drain knew only the
-- prize and fee banks, and the payer refused the bounty category. The chip
-- estate's knockout machinery (the engine's claim, fn_collect_bounty, the
-- PKO half rule, fn_finalize_bounty_pool at the terminal) is unit-aware
-- already and is reused whole; what it lacked was a Diamond reading of "how
-- much of the bounty pool has been paid", which it took from
-- wallet_transactions rows a Diamond payment never writes.
--
-- What changes:
--
--   1. fn_poker_diamond_tournament_drain learns the bounty bank: per custody
--      row, held = the row's bounty parts minus what the bounty bank already
--      drained from it, exactly as the prize and fee banks are held.
--   2. fn_poker_diamond_tournament_pay pays category 'bounty' from that bank
--      (a knockout's cash half, the champion's own head, the residual) into
--      the collector's wallet, writes a 'bounty' ledger row and applies
--      bounty_out to the escrow shadow, which it opens first from the
--      ledger's exact parts (a knockout is paid mid-event, before the
--      terminal would have opened it). A Diamond bounty is whole Diamonds.
--   3. fn_poker_diamond_tournament_charge carries a bounty part, and once
--      the shadow is open it applies every later inflow to it.
--   4. fn_poker_diamond_create_tournament admits 'bounty' and
--      'progressive_bounty' events with a whole bounty no larger than the
--      buy-in after the fee, exactly the chip door's rule; mystery bounties,
--      satellites, spins, guarantees and free entries stay refused by name.
--   5. The registration core's Diamond roster row carries the head
--      (current_bounty) as the chip row does, so the roster trigger does not
--      seed it a second time and raise an alert.
--   6. Six chip readers of "bounty paid" learn the Diamond ledger, in place:
--      fn_collect_bounty (the pool's availability), fn_finalize_bounty_pool
--      (the residual), the terminal writer (its two bounty evidence checks),
--      fn_payout_guarantee_check (the board's bounty shortfall watch) and
--      the terminal receipt reader (the pool closed exactly).
--
-- Every chip edit is an asserted substitution (live md5 pinned, clause occurs
-- once, reverse substitution proved). Every Diamond door is pinned first,
-- redefined with the same signature, and declared to the guard watch.
-- tournaments_enabled stays false; this migration expects it closed. Nothing
-- here prices anything: the bounty is what staff enter at creation, the
-- split is the chip estate's rule (PKO: half to the wallet, half to the
-- head, floored to the unit), the fee is the rule the recovery fee states.
-- Applied once to kuklfnapbkmacvwxktbh.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)):
--   fn_poker_diamond_tournament_drain                              f8331db31f22a439aceac81b6d221354
--   fn_poker_diamond_tournament_pay                                4abbd98ae4d70aab511834f3c9bfd8e8
--   fn_poker_diamond_tournament_charge                             086afbf5418dec38e69cc6d9f6321443
--   fn_poker_diamond_create_tournament                             23246b204df4183f77ff097b07839d92
--   fn_register_for_tournament_before_atomic_capacity_20260907     1be2832d585daf91ee2bd7473b0f56e5
--   fn_collect_bounty                                              4546cd9cc782941527b9061dd68061d6
--   fn_finalize_bounty_pool                                        1bfe7e44e13f02b482c752884024893a
--   fn_complete_tournament_terminal_pre_seat_guard                 03cf1ababf460e38ffda77bdce247640
--   fn_payout_guarantee_check                                      60c5ab70c7a51d9de9d9177a760eef74
--   fn_ca_tournament_terminal_receipt                              ae1de9113a9e90a869c0a7eaf87d64ba
-- ============================================================================

DO $m$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled) THEN
    RAISE EXCEPTION 'tournaments_enabled is already on somewhere; this migration expects it closed';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 1. THE DRAIN LEARNS THE BOUNTY BANK
-- ---------------------------------------------------------------------------
DO $m$
DECLARE v_md5 text;
BEGIN
  SELECT md5(pg_get_functiondef('public.fn_poker_diamond_tournament_drain(uuid, text, bigint, text, text, uuid)'::regprocedure)) INTO v_md5;
  IF v_md5 <> 'f8331db31f22a439aceac81b6d221354' THEN
    RAISE EXCEPTION 'fn_poker_diamond_tournament_drain is not the pinned text (md5 %)', v_md5;
  END IF;
END $m$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_drain(p_tournament_id uuid, p_bank text, p_amount bigint, p_reason text, p_destination_account text, p_journal_for uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_left bigint := p_amount; v_take bigint; v_c record; v_lot record; v_loss bigint;
  v_drained jsonb := '[]'::jsonb; v_req uuid; v_journal uuid; v_wallet bigint; v_name text;
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
    -- prize or a bounty; for a fee, this player's own spend, which the
    -- register retires.
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

REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_drain(uuid, text, bigint, text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
SELECT public.fn_ca_declare_guard_redefinition('fn_poker_diamond_tournament_drain', 'migration a_diamond_bounty_is_paid_from_its_own_bank');

-- ---------------------------------------------------------------------------
-- 2. THE PAYER PAYS A BOUNTY FROM THE BOUNTY BANK
-- ---------------------------------------------------------------------------
DO $m$
DECLARE v_md5 text;
BEGIN
  SELECT md5(pg_get_functiondef('public.fn_poker_diamond_tournament_pay(uuid, numeric, text, text, uuid, text)'::regprocedure)) INTO v_md5;
  IF v_md5 <> '4abbd98ae4d70aab511834f3c9bfd8e8' THEN
    RAISE EXCEPTION 'fn_poker_diamond_tournament_pay is not the pinned text (md5 %)', v_md5;
  END IF;
END $m$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_pay(p_user_id uuid, p_amount numeric, p_idempotency_key text, p_category text, p_tournament_id uuid, p_description text)
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

  -- The key is claimed before any Diamond moves, as the chip credit claims it.
  INSERT INTO public.wallet_credit_idempotency(key,user_id,amount)
  VALUES (p_idempotency_key,p_user_id,p_amount) ON CONFLICT (key) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN RETURN false; END IF;

  -- The bank this payment draws on: a place from the prize bank, a knockout
  -- (its cash half, the champion's own head, the residual) from the bounty
  -- bank. Each is the sum of the entries' parts less what it already paid.
  SELECT * INTO v_e FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id);
  v_bank := CASE WHEN v_kind='bounty' THEN v_e.bounty_balance ELSE v_e.prize_balance END;
  IF v_bank < p_amount THEN
    RAISE EXCEPTION 'diamond_tournament_bank_short' USING ERRCODE='P0404';
  END IF;
  -- A knockout is paid while the event runs, before the terminal opens the
  -- escrow shadow; the shadow is opened here from the Diamond ledger's exact
  -- parts (idempotent, asserted) so the chip shadow never opens itself from a
  -- proportional split at the first bounty.
  PERFORM public.fn_poker_diamond_tournament_open_shadow(p_tournament_id);

  -- The recipient's wallet first (its journal row is what every drained
  -- row's movement carries), then the custody rows, oldest first.
  v_credit := public.add_diamonds_to_balance(
    p_user_id, p_amount::integer, 'arena_withdraw',
    COALESCE(NULLIF(btrim(p_description),''), CASE WHEN v_kind='bounty' THEN 'Tournament bounty' ELSE 'Tournament prize' END),
    'poker-tournament-pay:'||p_idempotency_key);
  IF COALESCE((v_credit->>'success')::boolean,false) IS NOT TRUE OR NULLIF(v_credit->>'transaction_id','') IS NULL THEN
    RAISE EXCEPTION 'diamond_tournament_pay_credit_failed:%', v_credit->>'error' USING ERRCODE='P0404';
  END IF;
  v_drained := public.fn_poker_diamond_tournament_drain(
    p_tournament_id, v_kind, p_amount::bigint, 'poker-tournament-pay:'||p_idempotency_key, 'player:'||p_user_id::text,
    (v_credit->>'transaction_id')::uuid);

  INSERT INTO public.poker_diamond_tournament_ledger(
    tournament_id,arena_id,user_id,custody_id,kind,amount,prize_part,bounty_part,fee_part,
    idempotency_key,wallet_journal_id,request)
  VALUES (p_tournament_id,v_arena,p_user_id,NULL,v_kind,p_amount::bigint,
    CASE WHEN v_kind='prize' THEN p_amount::bigint ELSE 0 END,
    CASE WHEN v_kind='bounty' THEN p_amount::bigint ELSE 0 END,0,
    'poker-tournament-pay:'||p_idempotency_key,(v_credit->>'transaction_id')::uuid,
    jsonb_build_object('kind',v_kind,'credit_key',p_idempotency_key,'drained',v_drained,'description',p_description));

  -- The escrow shadow follows, as a chip payment's wallet row makes it follow.
  IF v_kind='bounty' THEN
    PERFORM public.fn_ca_escrow_apply(p_tournament_id,'diamond bounty',p_bounty_out => p_amount);
  ELSE
    PERFORM public.fn_ca_escrow_apply(p_tournament_id,'diamond prize',p_prize_out => p_amount);
  END IF;

  IF (SELECT prize_balance+bounty_balance+fee_balance FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id))
     IS DISTINCT FROM public.fn_poker_diamond_tournament_custody(p_tournament_id)::numeric THEN
    RAISE EXCEPTION 'diamond_tournament_escrow_disagrees_with_custody' USING ERRCODE='P0404';
  END IF;
  RETURN true;
END $function$;

REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_pay(uuid, numeric, text, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
SELECT public.fn_ca_declare_guard_redefinition('fn_poker_diamond_tournament_pay', 'migration a_diamond_bounty_is_paid_from_its_own_bank');

-- ---------------------------------------------------------------------------
-- 3. THE CHARGE CARRIES A BOUNTY PART
-- ---------------------------------------------------------------------------
DO $m$
DECLARE v_md5 text;
BEGIN
  SELECT md5(pg_get_functiondef('public.fn_poker_diamond_tournament_charge(uuid, uuid, text, numeric, numeric, numeric, numeric, uuid, text)'::regprocedure)) INTO v_md5;
  IF v_md5 <> '086afbf5418dec38e69cc6d9f6321443' THEN
    RAISE EXCEPTION 'fn_poker_diamond_tournament_charge is not the pinned text (md5 %)', v_md5;
  END IF;
END $m$;

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
END $function$;

REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_charge(uuid, uuid, text, numeric, numeric, numeric, numeric, uuid, text) FROM PUBLIC, anon, authenticated;
SELECT public.fn_ca_declare_guard_redefinition('fn_poker_diamond_tournament_charge', 'migration a_diamond_bounty_is_paid_from_its_own_bank');

-- ---------------------------------------------------------------------------
-- 4. THE CREATION DOOR ADMITS A KNOCKOUT BOUNTY EVENT
-- ---------------------------------------------------------------------------
DO $m$
DECLARE v_md5 text;
BEGIN
  SELECT md5(pg_get_functiondef('public.fn_poker_diamond_create_tournament(jsonb)'::regprocedure)) INTO v_md5;
  IF v_md5 <> '23246b204df4183f77ff097b07839d92' THEN
    RAISE EXCEPTION 'fn_poker_diamond_create_tournament is not the pinned text (md5 %)', v_md5;
  END IF;
END $m$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_create_tournament(p_config jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid(); v_arena uuid; v_id uuid;
  v_total bigint; v_fee bigint; v_buy_in bigint; v_ratio numeric;
  v_max integer; v_min integer; v_type text; v_variant text; v_game text;
  v_start timestamptz; v_payouts jsonb; v_blinds jsonb; v_pct numeric; v_chips integer;
  v_rebuy boolean; v_reentry boolean; v_addon boolean; v_rebuy_cost bigint; v_addon_cost bigint;
  v_rebuy_num numeric; v_addon_num numeric; v_name text;
  v_is_bounty boolean; v_bounty_num numeric; v_bounty bigint;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='28000'; END IF;
  IF NOT public.fn_is_platform_admin() THEN
    RAISE EXCEPTION 'diamond_tournament_staff_only' USING ERRCODE='42501';
  END IF;
  SELECT c.id INTO v_arena FROM public.clubs c
   WHERE c.asset='diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL LIMIT 1;
  IF v_arena IS NULL THEN RAISE EXCEPTION 'diamond_arena_not_found' USING ERRCODE='P0002'; END IF;
  IF p_config IS NULL OR jsonb_typeof(p_config)<>'object' THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_configuration' USING ERRCODE='22023';
  END IF;

  v_type := lower(COALESCE(p_config->>'type','mtt'));
  IF v_type NOT IN ('mtt','sng','bounty','progressive_bounty') THEN
    -- mystery_bounty, satellite, spin: later Phase 9 pieces.
    RAISE EXCEPTION 'diamond_tournament_format_not_open' USING ERRCODE='55000';
  END IF;
  IF COALESCE((p_config->>'guarantee')::numeric,0)<>0 OR COALESCE((p_config->>'satelliteTargetId')::text,'')<>''
     OR COALESCE((p_config->>'freeBuy')::boolean,false) THEN
    RAISE EXCEPTION 'diamond_tournament_format_not_open' USING ERRCODE='55000';
  END IF;
  -- A knockout bounty is a format, not a flag: the flat bounty rides on a
  -- 'bounty' or 'progressive_bounty' event and on nothing else.
  v_is_bounty := v_type IN ('bounty','progressive_bounty');
  v_bounty_num := COALESCE((p_config->>'bountyAmount')::numeric,0);
  IF NOT v_is_bounty AND (v_bounty_num<>0 OR COALESCE((p_config->>'isBounty')::boolean,false)) THEN
    RAISE EXCEPTION 'diamond_tournament_bounty_requires_a_bounty_format' USING ERRCODE='22023';
  END IF;
  v_game := upper(btrim(COALESCE(p_config->>'gameVariant','NLH')));
  IF v_game NOT IN ('NLH','PLO4','PLO5','PLO6','PLO8','SHORT_DECK','FLH','FLO8') THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_supported_game' USING ERRCODE='22023';
  END IF;

  v_total := COALESCE((p_config->>'buyIn')::numeric,0);
  IF (p_config->>'buyIn')::numeric IS DISTINCT FROM v_total::numeric OR v_total<1 OR v_total>2147483647 THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_whole_positive_buy_in' USING ERRCODE='22023';
  END IF;
  v_max := COALESCE((p_config->>'maxPlayers')::int,0);
  IF v_max<2 OR v_max>10000 THEN RAISE EXCEPTION 'diamond_tournament_requires_a_real_field' USING ERRCODE='22023'; END IF;
  v_min := GREATEST(COALESCE((p_config->>'minPlayers')::int,3),2);
  IF v_min>v_max THEN v_min := v_max; END IF;
  -- The fee rule the recovery fee already states, at this entry's own unit.
  v_ratio := CASE WHEN v_max<=2 THEN 0.05 ELSE 0.10 END;
  v_fee := public.fn_ca_unit_floor_cents(round(v_total*100*v_ratio)::bigint, 100)/100;
  v_buy_in := v_total - v_fee;
  IF v_buy_in<1 THEN RAISE EXCEPTION 'diamond_tournament_buy_in_below_one_diamond' USING ERRCODE='22023'; END IF;
  -- The chip door's bounty rule at the Diamond unit: a whole bounty of at
  -- least one Diamond, no larger than the buy-in after the fee (the prize
  -- part is what remains; it may be zero, as the chip split allows).
  IF v_is_bounty THEN
    IF v_bounty_num<>trunc(v_bounty_num) OR v_bounty_num<1 OR v_bounty_num>v_buy_in THEN
      RAISE EXCEPTION 'diamond_tournament_requires_a_whole_bounty_within_the_buy_in' USING ERRCODE='22023';
    END IF;
    v_bounty := v_bounty_num;
  ELSE
    v_bounty := 0;
  END IF;

  v_chips := COALESCE((p_config->>'startingStack')::int, 10000);
  IF v_chips<1 THEN RAISE EXCEPTION 'diamond_tournament_requires_a_starting_stack' USING ERRCODE='22023'; END IF;
  v_blinds := COALESCE(p_config->'blindStructure','[]'::jsonb);
  v_payouts := COALESCE(p_config->'payoutStructure','[]'::jsonb);
  IF jsonb_typeof(v_blinds)<>'array' OR jsonb_array_length(v_blinds)=0 THEN
    RAISE EXCEPTION 'blind_structure_required' USING ERRCODE='22023';
  END IF;
  IF jsonb_typeof(v_payouts)<>'array' OR jsonb_array_length(v_payouts)=0 THEN
    RAISE EXCEPTION 'payout_structure_required' USING ERRCODE='22023';
  END IF;
  SELECT COALESCE(sum((e->>'percentage')::numeric),0) INTO v_pct FROM jsonb_array_elements(v_payouts) e;
  IF abs(v_pct-100)>1 THEN RAISE EXCEPTION 'payouts_must_total_100' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(v_payouts)>v_max THEN RAISE EXCEPTION 'more_paid_places_than_players' USING ERRCODE='22023'; END IF;
  v_start := COALESCE((p_config->>'startTime')::timestamptz, now()+interval '1 minute');
  v_rebuy := COALESCE((p_config->>'rebuy')::boolean,false);
  v_reentry := COALESCE((p_config->>'reentry')::boolean,v_rebuy);
  v_addon := COALESCE((p_config->>'addOn')::boolean,false);
  v_rebuy_num := COALESCE((p_config->>'rebuyCost')::numeric, v_total);
  v_addon_num := COALESCE((p_config->>'addonCost')::numeric, v_total);
  IF (v_rebuy OR v_reentry) AND (v_rebuy_num <> trunc(v_rebuy_num) OR v_rebuy_num < 1 OR v_rebuy_num > 2147483647) THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_whole_rebuy_cost' USING ERRCODE='22023';
  END IF;
  IF v_addon AND (v_addon_num <> trunc(v_addon_num) OR v_addon_num < 1 OR v_addon_num > 2147483647) THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_whole_addon_cost' USING ERRCODE='22023';
  END IF;
  v_rebuy_cost := v_rebuy_num; v_addon_cost := v_addon_num;
  v_name := COALESCE(NULLIF(btrim(p_config->>'name'),''),'Diamond Tournament');
  v_variant := CASE v_type WHEN 'sng' THEN 'sng' WHEN 'bounty' THEN 'bounty'
                           WHEN 'progressive_bounty' THEN 'progressive_bounty' ELSE 'freezeout' END;

  INSERT INTO public.tournaments (
    club_id, union_id, name, game_type, variant, tournament_type,
    buy_in_amount, buy_in_fee, guaranteed_prize, starting_chips, max_players, table_size, min_players,
    current_players, status, blind_structure, payout_structure, start_time,
    late_reg_levels, late_reg_mins, is_bounty, is_pko, is_mystery_bounty, bounty_amount,
    mystery_bounty_min, mystery_bounty_max,
    is_rebuy, is_reentry, rebuy_cost, rebuy_chips, rebuy_levels, max_rebuys, max_reentries,
    add_on_available, addon_cost, addon_chips, addon_levels,
    payout_percent, free_buy, is_private, action_time_seconds)
  VALUES (
    v_arena, NULL, v_name, v_game, v_variant, CASE WHEN v_type='sng' THEN 'SNG' ELSE 'MTT' END,
    v_buy_in, v_fee, 0, v_chips, v_max, LEAST(9, GREATEST(2, v_max)), v_min,
    0, 'REGISTERING', v_blinds::text, v_payouts::text, v_start,
    COALESCE((p_config->>'lateRegLevels')::int, CASE WHEN v_type='sng' THEN 0 ELSE 8 END), 8,
    v_is_bounty, v_type='progressive_bounty', false, v_bounty,
    0, 0,
    v_rebuy, v_reentry, CASE WHEN v_rebuy OR v_reentry THEN v_rebuy_cost ELSE 0 END,
    CASE WHEN v_rebuy OR v_reentry THEN v_chips ELSE 0 END, CASE WHEN v_rebuy OR v_reentry THEN 6 ELSE 4 END,
    CASE WHEN v_rebuy THEN COALESCE((p_config->>'maxRebuys')::int,2) ELSE 0 END,
    CASE WHEN v_reentry THEN COALESCE((p_config->>'maxReentries')::int,1) ELSE 0 END,
    v_addon, CASE WHEN v_addon THEN v_addon_cost ELSE 0 END, CASE WHEN v_addon THEN v_chips ELSE 0 END, 1,
    CASE WHEN (p_config->>'payoutPercent')::int IN (10,15,20) THEN (p_config->>'payoutPercent')::smallint ELSE 10 END,
    false, false, 15)
  RETURNING id INTO v_id;

  -- The row this door wrote must be one the money path will price: whole
  -- Diamonds everywhere, and the unit rule must recognise it.
  IF public.fn_ca_tournament_unit_cents(v_id) <> 100 OR NOT public.fn_poker_diamond_tournament(v_id) THEN
    RAISE EXCEPTION 'diamond_tournament_would_not_be_recognised' USING ERRCODE='23514';
  END IF;
  RETURN jsonb_build_object('success',true,'tournamentId',v_id,'id',v_id,'buy_in_amount',v_buy_in,'buy_in_fee',v_fee,
    'total',v_total,'bounty_amount',v_bounty,'asset','diamonds');
END $function$;

REVOKE ALL ON FUNCTION public.fn_poker_diamond_create_tournament(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_create_tournament(jsonb) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. THE REGISTRATION CORE'S DIAMOND ROSTER ROW CARRIES THE HEAD
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid; v_def text; v_old text; v_new text; v_n integer;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_register_for_tournament_before_atomic_capacity_20260907';
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '1be2832d585daf91ee2bd7473b0f56e5' THEN
    RAISE EXCEPTION 'the registration core is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := E'      INSERT INTO public.tournament_players (id, tournament_id, user_id, username, chips, status)\n'
        || E'      VALUES (v_player_id, p_tournament_id, v_uid, COALESCE(v_username,''Player''), v_start_chips, ''registered'')\n'
        || E'      RETURNING id INTO v_player_id;';
  v_new := E'      -- DIAMOND PHASE 9: the head rides on the roster row as it does for a\n'
        || E'      -- chip entry, so the roster trigger does not seed it a second time.\n'
        || E'      INSERT INTO public.tournament_players\n'
        || E'        (id, tournament_id, user_id, username, chips, status, current_bounty, mystery_bounty_value, bounties_collected, bounty_winnings)\n'
        || E'      VALUES (v_player_id, p_tournament_id, v_uid, COALESCE(v_username,''Player''), v_start_chips, ''registered'',\n'
        || E'              v_head, 0, 0, 0)\n'
        || E'      RETURNING id INTO v_player_id;';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'the Diamond roster insert occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(v_def, v_old, v_new);
  IF md5(replace(pg_get_functiondef(v_oid), v_new, v_old)) <> '1be2832d585daf91ee2bd7473b0f56e5' THEN
    RAISE EXCEPTION 'the registration core: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 6. SIX READERS OF "BOUNTY PAID" LEARN THE DIAMOND LEDGER
-- ---------------------------------------------------------------------------
-- 6a. fn_collect_bounty: what the pool still holds.
DO $m$
DECLARE
  v_oid oid; v_def text; v_old text; v_new text; v_n integer;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_collect_bounty';
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '4546cd9cc782941527b9061dd68061d6' THEN
    RAISE EXCEPTION 'fn_collect_bounty is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := E'      INTO v_available\n'
        || E'      FROM wallet_transactions wt\n'
        || E'     WHERE wt.related_entity_id = p_tournament_id\n'
        || E'       AND wt.category = ''bounty'';';
  v_new := v_old
        || E'\n    -- DIAMOND PHASE 9: a Diamond bounty is a ledger row, not a wallet row;\n'
        || E'    -- the bank is what the entries put in less what it already paid.\n'
        || E'    IF public.fn_poker_diamond_tournament(p_tournament_id) THEN\n'
        || E'      SELECT e.bounty_balance INTO v_available\n'
        || E'        FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;\n'
        || E'    END IF;';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'fn_collect_bounty: the availability clause occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(v_def, v_old, v_new);
  IF md5(replace(pg_get_functiondef(v_oid), v_new, v_old)) <> '4546cd9cc782941527b9061dd68061d6' THEN
    RAISE EXCEPTION 'fn_collect_bounty: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

-- 6b. fn_finalize_bounty_pool: what was paid, so the residual is exact.
DO $m$
DECLARE
  v_oid oid; v_def text; v_old text; v_new text; v_n integer;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_finalize_bounty_pool';
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '1bfe7e44e13f02b482c752884024893a' THEN
    RAISE EXCEPTION 'fn_finalize_bounty_pool is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := E'      INTO v_paid\n'
        || E'      FROM wallet_transactions wt\n'
        || E'     WHERE wt.related_entity_id = p_tournament_id\n'
        || E'       AND wt.category = ''bounty'';';
  v_new := v_old
        || E'\n    -- DIAMOND PHASE 9: a Diamond bounty is a ledger row, not a wallet row.\n'
        || E'    IF public.fn_poker_diamond_tournament(p_tournament_id) THEN\n'
        || E'      SELECT e.bounty_out INTO v_paid\n'
        || E'        FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;\n'
        || E'    END IF;';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'fn_finalize_bounty_pool: the paid clause occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(v_def, v_old, v_new);
  IF md5(replace(pg_get_functiondef(v_oid), v_new, v_old)) <> '1bfe7e44e13f02b482c752884024893a' THEN
    RAISE EXCEPTION 'fn_finalize_bounty_pool: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

-- 6c. The terminal writer: its bounty evidence, before and after the close.
DO $m$
DECLARE
  v_oid oid; v_def text; v_old1 text; v_new1 text; v_old2 text; v_new2 text; v_n integer;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_complete_tournament_terminal_pre_seat_guard';
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '03cf1ababf460e38ffda77bdce247640' THEN
    RAISE EXCEPTION 'the terminal writer is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old1 := E'  SELECT round(COALESCE(sum(w.amount),0),2) INTO v_bounty_before\n'
         || E'    FROM public.wallet_transactions w\n'
         || E'   WHERE w.related_entity_id = p_tournament_id\n'
         || E'     AND lower(w.category) = ''bounty'';';
  v_new1 := v_old1
         || E'\n  -- DIAMOND PHASE 9: a Diamond bounty is a ledger row, not a wallet row.\n'
         || E'  IF v_diamond THEN\n'
         || E'    SELECT e.bounty_out INTO v_bounty_before\n'
         || E'      FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;\n'
         || E'  END IF;';
  v_old2 := E'  SELECT round(COALESCE(sum(w.amount),0),2) INTO v_bounty_total\n'
         || E'    FROM public.wallet_transactions w\n'
         || E'   WHERE w.related_entity_id = p_tournament_id\n'
         || E'     AND lower(w.category) = ''bounty'';';
  v_new2 := v_old2
         || E'\n  -- DIAMOND PHASE 9: the same reading after the close.\n'
         || E'  IF v_diamond THEN\n'
         || E'    SELECT e.bounty_out INTO v_bounty_total\n'
         || E'      FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;\n'
         || E'  END IF;';
  v_n := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'terminal: the bounty-before clause occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2);
  IF v_n <> 1 THEN RAISE EXCEPTION 'terminal: the bounty-total clause occurs % times, expected 1', v_n; END IF;
  IF position('v_diamond' IN v_def) = 0 THEN
    RAISE EXCEPTION 'terminal: the Diamond flag Phase 8 declared is missing';
  END IF;
  EXECUTE replace(replace(v_def, v_old1, v_new1), v_old2, v_new2);
  IF md5(replace(replace(pg_get_functiondef(v_oid), v_new1, v_old1), v_new2, v_old2)) <> '03cf1ababf460e38ffda77bdce247640' THEN
    RAISE EXCEPTION 'terminal: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

-- 6d. fn_payout_guarantee_check: the board's bounty shortfall watch.
DO $m$
DECLARE
  v_oid oid; v_def text; v_old text; v_new text; v_n integer;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_payout_guarantee_check';
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '60c5ab70c7a51d9de9d9177a760eef74' THEN
    RAISE EXCEPTION 'fn_payout_guarantee_check is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := E'           COALESCE((SELECT round(sum(w.amount), 2) FROM public.wallet_transactions w\n'
        || E'                      WHERE w.related_entity_id = t.id AND w.type = ''credit''\n'
        || E'                        AND w.category = ''bounty''), 0) AS paid';
  v_new := E'           COALESCE((SELECT round(sum(w.amount), 2) FROM public.wallet_transactions w\n'
        || E'                      WHERE w.related_entity_id = t.id AND w.type = ''credit''\n'
        || E'                        AND w.category = ''bounty''), 0)\n'
        || E'           -- DIAMOND PHASE 9: a Diamond bounty is a ledger row, not a wallet row.\n'
        || E'           + COALESCE((SELECT sum(l.amount) FROM public.poker_diamond_tournament_ledger l\n'
        || E'                        WHERE l.tournament_id = t.id AND l.kind = ''bounty''), 0) AS paid';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'fn_payout_guarantee_check: the paid clause occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(v_def, v_old, v_new);
  IF md5(replace(pg_get_functiondef(v_oid), v_new, v_old)) <> '60c5ab70c7a51d9de9d9177a760eef74' THEN
    RAISE EXCEPTION 'fn_payout_guarantee_check: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

-- 6e. The terminal receipt reader: the bounty pool closed exactly.
DO $m$
DECLARE
  v_oid oid; v_def text; v_old text; v_new text; v_n integer;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_ca_tournament_terminal_receipt';
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> 'ae1de9113a9e90a869c0a7eaf87d64ba' THEN
    RAISE EXCEPTION 'fn_ca_tournament_terminal_receipt is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := E'  SELECT round(COALESCE(sum(w.amount),0),2)\n'
        || E'    INTO v_bounty_total\n'
        || E'    FROM public.wallet_transactions w\n'
        || E'   WHERE w.related_entity_id = p_tournament_id AND lower(w.category) = ''bounty'';';
  v_new := v_old
        || E'\n  -- DIAMOND PHASE 9: a Diamond bounty is a ledger row, not a wallet row.\n'
        || E'  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN\n'
        || E'    SELECT e.bounty_out INTO v_bounty_total\n'
        || E'      FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;\n'
        || E'  END IF;';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'terminal receipt: the bounty-total clause occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(v_def, v_old, v_new);
  IF md5(replace(pg_get_functiondef(v_oid), v_new, v_old)) <> 'ae1de9113a9e90a869c0a7eaf87d64ba' THEN
    RAISE EXCEPTION 'terminal receipt: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 7. THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE r record; v_bad text; v_txt text;
BEGIN
  -- the three doors no longer refuse by name
  FOR r IN SELECT p.proname, pg_get_functiondef(p.oid) AS def FROM pg_proc p
            WHERE p.pronamespace='public'::regnamespace
              AND p.proname IN ('fn_poker_diamond_tournament_charge','fn_poker_diamond_tournament_pay','fn_poker_diamond_tournament_drain')
  LOOP
    IF position('diamond_tournament_bounties_not_open' IN r.def) > 0 THEN
      RAISE EXCEPTION '% still refuses the bounty bank by name', r.proname;
    END IF;
  END LOOP;
  v_txt := pg_get_functiondef('public.fn_poker_diamond_tournament_drain(uuid, text, bigint, text, text, uuid)'::regprocedure);
  IF position('p_bank NOT IN (''prize'',''fee'',''bounty'')' IN v_txt) = 0 OR position('WHEN p_bank=''bounty'' THEN l.bounty_part' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the drain does not hold the bounty bank';
  END IF;
  v_txt := pg_get_functiondef('public.fn_poker_diamond_tournament_charge(uuid, uuid, text, numeric, numeric, numeric, numeric, uuid, text)'::regprocedure);
  IF position('p_gross_in => p_gross, p_fee_entries_in => p_fee, p_bounty_in => p_bounty' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the charge does not follow an open shadow';
  END IF;
  v_txt := pg_get_functiondef('public.fn_poker_diamond_tournament_pay(uuid, numeric, text, text, uuid, text)'::regprocedure);
  IF position('WHEN v_kind=''bounty'' THEN v_e.bounty_balance' IN v_txt) = 0 OR position('p_bounty_out => p_amount' IN v_txt) = 0
     OR position('PERFORM public.fn_poker_diamond_tournament_open_shadow(p_tournament_id);' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the payer does not pay from the bounty bank';
  END IF;
  -- the creation door admits the two knockout formats and still refuses the rest
  v_txt := pg_get_functiondef('public.fn_poker_diamond_create_tournament(jsonb)'::regprocedure);
  IF position('IF v_type NOT IN (''mtt'',''sng'',''bounty'',''progressive_bounty'') THEN' IN v_txt) = 0
     OR position('diamond_tournament_format_not_open' IN v_txt) = 0
     OR position('diamond_tournament_requires_a_whole_bounty_within_the_buy_in' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the creation door does not admit a knockout bounty event as this migration states';
  END IF;
  -- the six readers
  FOR r IN SELECT p.proname, pg_get_functiondef(p.oid) AS def FROM pg_proc p
            WHERE p.pronamespace='public'::regnamespace
              AND p.proname IN ('fn_collect_bounty','fn_finalize_bounty_pool','fn_complete_tournament_terminal_pre_seat_guard','fn_payout_guarantee_check','fn_ca_tournament_terminal_receipt')
  LOOP
    IF position('poker_diamond_tournament_' IN r.def) = 0 THEN
      RAISE EXCEPTION '% does not read the Diamond ledger', r.proname;
    END IF;
    IF position('wallet_transactions' IN r.def) = 0 THEN
      RAISE EXCEPTION '% lost its chip reading', r.proname;
    END IF;
  END LOOP;
  -- the roster row
  IF position('current_bounty, mystery_bounty_value, bounties_collected, bounty_winnings)' IN
       (SELECT pg_get_functiondef(p.oid) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_register_for_tournament_before_atomic_capacity_20260907')) = 0 THEN
    RAISE EXCEPTION 'the Diamond roster row does not carry the head';
  END IF;
  -- grants: the doors are not browser doors; the creation door is a staff door behind an account
  FOR r IN SELECT p.oid, p.proname FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
            AND p.proname IN ('fn_poker_diamond_tournament_drain','fn_poker_diamond_tournament_pay','fn_poker_diamond_tournament_charge','fn_poker_diamond_create_tournament')
  LOOP
    IF has_function_privilege('anon', r.oid, 'EXECUTE') THEN RAISE EXCEPTION '% is reachable without an account', r.proname; END IF;
    IF r.proname <> 'fn_poker_diamond_create_tournament' AND has_function_privilege('authenticated', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is a browser door', r.proname;
    END IF;
    IF r.proname IN ('fn_poker_diamond_tournament_drain','fn_poker_diamond_tournament_pay') AND has_function_privilege('service_role', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is reachable by the engine; it is owner-only', r.proname;
    END IF;
  END LOOP;
  -- the switch stays off, the identity is whole, every watched guard is on its baseline
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled) THEN
    RAISE EXCEPTION 'this migration must not open the tournament door';
  END IF;
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole';
  END IF;
  SELECT string_agg(w.fn, ', ') INTO v_bad
    FROM unnest(public.fn_ca_guard_watchlist()) AS w(fn)
    LEFT JOIN public.ca_guard_defs d ON d.proname = w.fn
    LEFT JOIN (
      SELECT p.proname, md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)) AS h
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY (public.fn_ca_guard_watchlist())
       GROUP BY p.proname) live ON live.proname = w.fn
   WHERE d.def_hash IS DISTINCT FROM live.h;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'watched guards off their baseline: %', v_bad;
  END IF;
  RAISE NOTICE 'a Diamond bounty is paid from its own bank: three doors opened to the bank, one door admits the format, six readers read the ledger, nothing opened to players';
END $m$;
