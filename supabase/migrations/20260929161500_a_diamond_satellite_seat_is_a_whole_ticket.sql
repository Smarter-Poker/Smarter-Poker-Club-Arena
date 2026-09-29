-- ============================================================================
-- A DIAMOND SATELLITE SEAT IS A WHOLE TICKET
-- ============================================================================
--
-- Phase 9 of the Diamond Arena programme, third piece: Diamond-to-Diamond
-- satellites. A satellite pays its prize bank in seats - whole tickets into
-- its target, each the target's buy-in plus its fee - and whatever the bank
-- holds beyond a whole number of tickets as money to the single bubble. The
-- chip estate has two settlement authorities for that (the single-winner
-- fn_settle_satellite_tournament_pre_money_path_gate and the multi-qualifier
-- fn_ca_settle_satellite_cohort), one receipt reader each, a capture trigger
-- on every seat award and a creation guard every satellite row passes
-- through. All of it is reused whole. What it lacked for Diamonds:
--
--   1. THE SEAT. A chip seat moves the ticket from the satellite's prize
--      liability to the target's with a chip_ledger leg and a rake_records
--      fee row. A Diamond seat is custody: the qualifier's target entry is a
--      new poker_diamond_custody row (purpose tournament_entry, target the
--      target, entry_key 'entry:<registration>', ACTIVE), funded by a
--      custody-to-custody movement out of the satellite's prize bank. The
--      drain releases the satellite's entry rows oldest first (a release
--      movement on each, destination the new entry row), exactly as a paid
--      place drains them; the new row takes one reserve movement of the
--      ticket; the Diamond ledger records a 'prize' row out of the satellite
--      and an 'entry' row into the target carrying the target's own prize and
--      fee parts, on the registration. NO WALLET MOVES. A custody movement
--      must carry a journal row (poker_diamond_movements_amount_check), so the
--      qualifier's journal gets one row of amount 0 at the unchanged balance
--      (tournament_satellite_seat, register-neutral: the register follows no
--      zero), whose metadata names the Diamonds that moved between the two
--      custody accounts. Players, house and register do not move; custody
--      only changes hands. That is fn_poker_diamond_tournament_seat_transfer,
--      a new owner-only door, which both authorities call in place of the
--      chip legs, after the target roster row is written.
--   2. WHERE THE UNIT DIVIDES: NOWHERE. A Diamond ledger part is a whole
--      number of Diamonds, so the prize bank is whole; the ticket is the
--      target's whole buy-in plus its whole fee (the creation door floors the
--      fee to the unit and the contract freezes at the first funded entry);
--      so seats x ticket is whole and the remainder is whole. Its flooring
--      residue - the remainder less its floor at the unit - is identically
--      zero and lands nowhere: both authorities assert it by name
--      (diamond_satellite_does_not_divide_into_whole_diamonds) before any
--      Diamond moves. The remainder itself is paid to the bubble in whole
--      Diamonds through the pay door the chip path already reaches
--      (fn_credit_and_log -> fn_poker_diamond_tournament_pay).
--   3. DUPLICATE QUALIFICATION is the chip rule, unchanged: a qualifier who
--      already holds a registration in the target (bought, or seated by
--      another satellite), or whose target has closed, takes the ticket's
--      value as money - here whole Diamonds through the same pay door. A
--      Diamond qualifier at the four-game cap is refused by name
--      (diamond_satellite_winner_at_the_table_cap): the chip estate holds
--      such a seat in a noncash chip entry ticket, and there is no Diamond
--      ticket to hold it in, so nothing moves and the engine retries.
--   4. ASSETS NEVER CROSS, BY NAME. The creation guard every satellite row
--      passes through refuses a chip satellite pointed at a Diamond event
--      (SATELLITE_CHIP_SOURCE_CANNOT_FEED_A_DIAMOND_TARGET) and a Diamond
--      satellite pointed at a chip event
--      (SATELLITE_DIAMOND_SOURCE_CANNOT_FEED_A_CHIP_TARGET); the Diamond
--      creation door refuses a chip target itself
--      (diamond_satellite_target_must_be_a_diamond_tournament); both
--      settlement authorities refuse either crossing before any money
--      (fn_ca_assert_satellite_asset: diamond_satellite_cannot_seat_a_chip_target,
--      chip_satellite_cannot_seat_a_diamond_target); the seat door refuses a
--      pair that is not two Diamond events; and the two chip-rail seat doors
--      (fn_award_satellite_seat and the entitlement finish) refuse any Diamond
--      satellite or target (diamond_satellite_is_never_settled_on_chip_rails).
--   5. THE SHADOWS AND THE RECEIPTS. A Diamond satellite's escrow shadow
--      opens from its own ledger (fn_poker_diamond_tournament_open_shadow)
--      before the authority's source lock; the seat payout row moves it as it
--      moves a chip one. A Diamond target's shadow is not opened by a
--      satellite: its money is proved on its own banks and custody before and
--      after the seats. The receipt readers prove a Diamond seat by its
--      Diamond ledger rows and custody row, and a Diamond satellite's fee by
--      its fee bank; the award capture trigger captures no chip refund
--      entitlement for a Diamond seat, whose refund path is its custody row
--      through the Diamond refund authority.
--   6. A DIAMOND SATELLITE PROMISES NO SEAT. The readiness contract every
--      start passes through (fn_tournament_management_readiness_for_row)
--      asks a satellite to advertise at least one seat, and an advertised
--      seat is a guarantee: its value counts against the club's treasury
--      until the pool covers it. A Diamond guarantee is funded only from an
--      authorised Diamond house budget, which is not built (Phase 9's
--      guarantee line) and whose size is the owner's; the creation door
--      refuses a promised seat count by name. The contract learns that a
--      Diamond satellite into a Diamond target is complete with none
--      promised: its prize bank alone buys the seats at settlement.
--
-- Every chip edit is an asserted substitution: the live md5 pinned, each
-- clause occurring exactly once, the reverse substitution proved to give the
-- pinned text back. The Diamond creation door is pinned and redefined with
-- the same signature. The new door is registered before it exists, revoked
-- from every client role and watched. tournaments_enabled stays false.
-- Nothing is priced: the ticket is the target's price, the seat count is the
-- bank's, and a promised seat count (a guarantee) is refused at the door.
-- Applied once to kuklfnapbkmacvwxktbh by the lead. Never reapply.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)):
--   fn_poker_diamond_create_tournament                  6d82bede82370a9cc15d71b5ce1699f5
--   fn_ca_guard_new_satellite_target                    69247df72bfb68c7148c1a7f9ea4cfd7
--   fn_settle_satellite_tournament_pre_money_path_gate  9c5dd58bbae1d4ad4c1f5c808948da4d
--   fn_ca_settle_satellite_cohort                       6e9822dd8367827cf2ba31f2c41b4771
--   fn_ca_satellite_settlement_receipt                  5288fd960eac2c85d955b8c8150f9f93
--   fn_ca_satellite_cohort_receipt                      3207bb2d0d632688e10889bb7ef8ed08
--   fn_ca_capture_satellite_seat_entitlement            43bd57fdb0a21738e5b1e5d833c94a57
--   fn_award_satellite_seat                             92ab8b6d14cecd75bb945bbe2e6bc12b
--   fn_settle_satellite_finish_atomic_before_maintenance_gate  399bdb8716ec24166880d3df7e017280
--   fn_ca_guard_watchlist                               92ee208d0887728444bda396d0b4d442
--   fn_tournament_management_readiness_for_row          0b9fecc5c10bdcf459510bbb19a3268a
-- ============================================================================

DO $m$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled) THEN
    RAISE EXCEPTION 'tournaments_enabled is already on somewhere; this migration expects it closed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace
              AND proname IN ('fn_poker_diamond_tournament_seat_transfer','fn_ca_assert_satellite_asset',
                              'fn_ca_diamond_satellite_target_accepts_new_feeder')) THEN
    RAISE EXCEPTION 'a Diamond satellite function already exists; this migration expects none';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournaments t JOIN public.clubs c ON c.id=t.club_id
              WHERE c.asset='diamonds' AND COALESCE(t.satellite_target_id,t.satellite_target) IS NOT NULL) THEN
    RAISE EXCEPTION 'a Diamond satellite already exists; this migration expects none';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 1. THE SEAT DOOR IS REGISTERED BEFORE IT EXISTS
-- ---------------------------------------------------------------------------
INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_poker_diamond_tournament_seat_transfer', 'approved',
   'Diamond Phase 9. Delivers one satellite seat as the qualifier''s funded entry in a Diamond target: the whole ticket leaves the satellite''s prize bank through fn_poker_diamond_tournament_drain (a release movement on each drained entry row, destination the new entry row) and becomes a new ACTIVE tournament_entry custody row for the qualifier on the target (entry_key entry:<registration>) with one reserve movement; a prize ledger row out of the satellite and an entry ledger row into the target carry the target''s own prize and fee parts. No wallet moves: the one journal row the movements carry is amount 0 at the unchanged balance, register-neutral. Owner-only; the two satellite settlement authorities are its only callers.')
ON CONFLICT (proname) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. ASSETS NEVER CROSS: THE RULE AND THE DIAMOND FEEDER PREDICATE
-- ---------------------------------------------------------------------------
-- The settlement-side rule, one function both authorities call before any
-- money, roster or escrow row moves. It answers whether the pair is Diamond
-- and refuses a crossing by name in either direction.
CREATE FUNCTION public.fn_ca_assert_satellite_asset(p_satellite_id uuid, p_target_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_source boolean; v_target boolean;
BEGIN
  IF p_satellite_id IS NULL OR p_target_id IS NULL THEN
    RAISE EXCEPTION 'a satellite asset check requires the satellite and its target' USING ERRCODE='22004';
  END IF;
  v_source := public.fn_poker_diamond_tournament(p_satellite_id);
  v_target := public.fn_poker_diamond_tournament(p_target_id);
  IF v_source AND NOT v_target THEN
    RAISE EXCEPTION 'diamond_satellite_cannot_seat_a_chip_target: satellite % target %',
      p_satellite_id, p_target_id USING ERRCODE='22023';
  ELSIF v_target AND NOT v_source THEN
    RAISE EXCEPTION 'chip_satellite_cannot_seat_a_diamond_target: satellite % target %',
      p_satellite_id, p_target_id USING ERRCODE='22023';
  END IF;
  RETURN v_source;
END $function$;

REVOKE ALL ON FUNCTION public.fn_ca_assert_satellite_asset(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- fn_ca_satellite_target_accepts_new_feeder with its asset test turned round:
-- an ordinary recorded MTT with no bounty, PKO, mystery, Spin or satellite
-- contract of its own, in the Diamond arena, may be fed by a Diamond
-- satellite. The chip predicate keeps refusing every Diamond target, so every
-- chip creation path keeps refusing one.
CREATE FUNCTION public.fn_ca_diamond_satellite_target_accepts_new_feeder(p_target_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT COALESCE((SELECT t.format_contract IN ('mtt-v1','mtt-v2')
   AND t.is_bounty IS FALSE AND t.is_pko IS FALSE AND t.is_mystery_bounty IS FALSE
   AND t.is_premium_spin IS FALSE
   AND lower(btrim(COALESCE(t.variant,''))) NOT IN
     ('satellite','spin','bounty','progressive','progressive_bounty','pko','mystery','mystery_bounty')
   AND lower(btrim(COALESCE(t.tournament_type,''))) NOT IN
     ('satellite','spin','bounty','progressive','progressive_bounty','pko','mystery','mystery_bounty')
   AND t.satellite_target_id IS NULL AND t.satellite_target IS NULL
   AND public.fn_poker_diamond_tournament(t.id) IS TRUE
   FROM public.tournaments t WHERE t.id=p_target_id),false);
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_diamond_satellite_target_accepts_new_feeder(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. THE SEAT DOOR: A QUALIFIER'S TARGET ENTRY IS FUNDED CUSTODY TO CUSTODY
-- ---------------------------------------------------------------------------
-- Called by a satellite settlement authority once per seat, after the
-- target roster row is written (the Diamond registration core writes the
-- roster row's id into the entry key the same way). The ticket must be
-- exactly the target's own entry - its buy-in to the prize bank, its fee to
-- the fee bank, nothing to a bounty bank - in whole Diamonds.
CREATE FUNCTION public.fn_poker_diamond_tournament_seat_transfer(
  p_satellite_id uuid, p_target_id uuid, p_user_id uuid, p_registration_id uuid,
  p_ticket numeric, p_prize numeric, p_fee numeric, p_seat_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_sat record; v_target record; v_reg public.tournament_players%ROWTYPE;
  v_existing public.poker_diamond_tournament_ledger%ROWTYPE; v_e record;
  v_out_key text; v_in_key text; v_wallet bigint; v_journal uuid; v_custody uuid;
  v_request uuid; v_drained jsonb; v_out_ledger bigint; v_in_ledger bigint; v_receipt jsonb;
BEGIN
  IF p_satellite_id IS NULL OR p_target_id IS NULL OR p_user_id IS NULL OR p_registration_id IS NULL
     OR p_seat_key IS NULL OR length(btrim(p_seat_key)) = 0 OR length(p_seat_key) > 300
     OR p_ticket IS NULL OR p_prize IS NULL OR p_fee IS NULL
     OR p_ticket < 1 OR p_ticket > 2147483647 OR p_prize < 0 OR p_fee < 0
     OR p_ticket <> trunc(p_ticket) OR p_prize <> trunc(p_prize) OR p_fee <> trunc(p_fee)
     OR p_prize + p_fee <> p_ticket THEN
    RAISE EXCEPTION 'diamond_satellite_seat_requires_whole_parts' USING ERRCODE='22023';
  END IF;
  -- ASSETS NEVER CROSS: both ends of a Diamond seat are Diamond events.
  IF NOT public.fn_poker_diamond_tournament(p_satellite_id)
     OR NOT public.fn_poker_diamond_tournament(p_target_id) THEN
    RAISE EXCEPTION 'diamond_satellite_seat_requires_two_diamond_events: satellite % target %',
      p_satellite_id, p_target_id USING ERRCODE='23514';
  END IF;
  SELECT t.id, t.club_id, t.name, t.satellite_target_id, t.satellite_target
    INTO v_sat FROM public.tournaments t WHERE t.id=p_satellite_id;
  SELECT t.id, t.club_id, t.name, t.buy_in_amount, t.buy_in_fee, t.bounty_amount,
         t.is_bounty, t.is_pko, t.is_mystery_bounty
    INTO v_target FROM public.tournaments t WHERE t.id=p_target_id;
  IF COALESCE(v_sat.satellite_target_id, v_sat.satellite_target) IS DISTINCT FROM p_target_id THEN
    RAISE EXCEPTION 'diamond_satellite_seat_names_another_target' USING ERRCODE='23514';
  END IF;
  IF v_target.buy_in_amount IS DISTINCT FROM p_prize OR COALESCE(v_target.buy_in_fee,0) IS DISTINCT FROM p_fee
     OR COALESCE(v_target.bounty_amount,0) <> 0 OR v_target.is_bounty IS DISTINCT FROM false
     OR v_target.is_pko IS DISTINCT FROM false OR v_target.is_mystery_bounty IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'diamond_satellite_seat_is_not_the_target_entry' USING ERRCODE='23514';
  END IF;
  v_out_key := 'poker-tournament-seat-out:' || p_seat_key;
  v_in_key := 'poker-tournament-seat-in:' || p_seat_key;

  -- The same seat twice is the same seat: return what it wrote.
  SELECT * INTO v_existing FROM public.poker_diamond_tournament_ledger WHERE idempotency_key=v_in_key;
  IF FOUND THEN
    IF v_existing.user_id IS DISTINCT FROM p_user_id OR v_existing.tournament_id IS DISTINCT FROM p_target_id
       OR v_existing.amount IS DISTINCT FROM p_ticket::bigint
       OR v_existing.registration_id IS DISTINCT FROM p_registration_id THEN
      RAISE EXCEPTION 'idempotency_payload_mismatch';
    END IF;
    RETURN jsonb_build_object('success',true,'idempotent',true,'custody_id',v_existing.custody_id,
      'target_ledger_id',v_existing.id,'journal_id',v_existing.wallet_journal_id,'amount',v_existing.amount);
  END IF;

  -- The registration the seat funds is the satellite's own qualifier row.
  SELECT * INTO v_reg FROM public.tournament_players tp WHERE tp.id=p_registration_id FOR UPDATE;
  IF NOT FOUND OR v_reg.tournament_id IS DISTINCT FROM p_target_id OR v_reg.user_id IS DISTINCT FROM p_user_id
     OR COALESCE(v_reg.is_satellite_qualifier,false) IS NOT TRUE
     OR v_reg.source_satellite_id IS DISTINCT FROM p_satellite_id THEN
    RAISE EXCEPTION 'diamond_satellite_seat_has_no_qualifier_registration' USING ERRCODE='23514';
  END IF;
  -- One funded entry per player per event, as the entry door holds it.
  IF EXISTS (SELECT 1 FROM public.poker_diamond_custody c
              WHERE c.user_id=p_user_id AND c.purpose='tournament_entry'
                AND c.target_id=p_target_id AND c.state<>'released') THEN
    RAISE EXCEPTION 'diamond_tournament_entry_already_held' USING ERRCODE='23505';
  END IF;
  SELECT * INTO v_e FROM public.fn_poker_diamond_tournament_escrow(p_satellite_id);
  IF v_e.prize_balance < p_ticket THEN
    RAISE EXCEPTION 'diamond_tournament_bank_short' USING ERRCODE='P0404';
  END IF;

  -- THE JOURNAL ROW THE MOVEMENTS CARRY. A custody movement names a journal
  -- row. This one moves no wallet: amount 0 at the unchanged balance, so the
  -- register (which follows no zero) does not move; its metadata names the
  -- Diamonds that moved between the two custody accounts, so the qualifier's
  -- own journal shows the seat.
  v_custody := gen_random_uuid();
  SELECT COALESCE(p.diamonds,0) INTO v_wallet FROM public.profiles p WHERE p.id=p_user_id FOR UPDATE;
  INSERT INTO public.diamond_transactions(user_id,type,transaction_type,amount,balance_after,
    reference_id,description,source,issuance_class,counterparty,metadata)
  VALUES (p_user_id,'tournament_satellite_seat','tournament_satellite_seat',0,v_wallet,
    'poker-tournament-satellite-seat:'||p_seat_key,
    'Satellite seat: '||p_ticket::bigint::text||' Diamonds moved from the prize bank of '
      ||COALESCE(v_sat.name,'the satellite')||' into your entry in '||COALESCE(v_target.name,'its target')
      ||' (your wallet did not move)',
    'poker_arena','arena','arena_custody:'||v_custody::text,
    jsonb_build_object('satellite_id',p_satellite_id,'target_id',p_target_id,'registration_id',p_registration_id,
      'custody_id',v_custody,'amount',p_ticket,'prize_part',p_prize,'fee_part',p_fee,'wallet_moved',0,
      'seat_key',p_seat_key))
  RETURNING id INTO v_journal;

  -- OUT: the whole ticket leaves the satellite's prize bank, oldest entry rows
  -- first, each drained row releasing its part to the new entry row.
  v_drained := public.fn_poker_diamond_tournament_drain(
    p_satellite_id, 'prize', p_ticket::bigint, v_out_key, 'arena_custody:'||v_custody::text, v_journal);
  INSERT INTO public.poker_diamond_tournament_ledger(
    tournament_id,arena_id,user_id,custody_id,kind,amount,prize_part,bounty_part,fee_part,
    idempotency_key,wallet_journal_id,registration_id,request)
  VALUES (p_satellite_id,v_sat.club_id,p_user_id,NULL,'prize',p_ticket::bigint,p_ticket::bigint,0,0,
    v_out_key,v_journal,NULL,
    jsonb_build_object('kind','prize','delivery','satellite_seat','seat_key',p_seat_key,'target_id',p_target_id,
      'registration_id',p_registration_id,'target_custody_id',v_custody,'drained',v_drained))
  RETURNING id INTO v_out_ledger;

  -- IN: the same Diamonds become the qualifier's funded entry in the target,
  -- ACTIVE from the moment it exists (the seat guards admit a Diamond seat
  -- only against an active entry) and never bound to a seat.
  INSERT INTO public.poker_diamond_custody(id,user_id,arena_id,purpose,target_id,entry_key,balance,state)
  VALUES (v_custody,p_user_id,v_target.club_id,'tournament_entry',p_target_id,
    'entry:'||p_registration_id::text,p_ticket::bigint,'active');
  v_request := uuid_in(md5(v_in_key)::cstring);
  v_receipt := jsonb_build_object('success',true,'custody_id',v_custody,'request_id',v_request,
    'amount',p_ticket,'custody_balance',p_ticket,'journal_id',v_journal,
    'source','tournament_prize_bank:'||p_satellite_id::text);
  INSERT INTO public.poker_diamond_movements(request_id,custody_id,user_id,action,amount,
    source_account,destination_account,wallet_journal_id,request,receipt)
  VALUES (v_request,v_custody,p_user_id,'reserve',p_ticket::bigint,
    'tournament_prize_bank:'||p_satellite_id::text,'arena_custody:'||v_custody::text,v_journal,
    jsonb_build_object('action','satellite_seat','satellite_id',p_satellite_id,'target_id',p_target_id,
      'user_id',p_user_id,'registration_id',p_registration_id,'amount',p_ticket,'seat_key',p_seat_key),
    v_receipt);
  INSERT INTO public.poker_diamond_tournament_ledger(
    tournament_id,arena_id,user_id,custody_id,kind,amount,prize_part,bounty_part,fee_part,
    idempotency_key,wallet_journal_id,registration_id,request)
  VALUES (p_target_id,v_target.club_id,p_user_id,v_custody,'entry',p_ticket::bigint,p_prize::bigint,0,p_fee::bigint,
    v_in_key,v_journal,p_registration_id,
    jsonb_build_object('kind','entry','source','satellite_seat','satellite_id',p_satellite_id,'gross',p_ticket,
      'prize',p_prize,'bounty',0,'fee',p_fee,'request_id',v_request,'seat_key',p_seat_key))
  RETURNING id INTO v_in_ledger;

  -- The first funded entry locks the target's entry contract, as the entry
  -- door locks it; an open target shadow follows the entry, as it follows one.
  UPDATE public.tournaments t SET entry_contract_locked=true
   WHERE t.id=p_target_id AND NOT t.entry_contract_locked;
  IF EXISTS (SELECT 1 FROM public.tournament_escrow x WHERE x.tournament_id=p_target_id) THEN
    PERFORM public.fn_ca_escrow_apply(p_target_id,'diamond satellite seat',
      p_gross_in => p_ticket, p_fee_entries_in => p_fee);
  END IF;

  -- Both events' banks agree with their custody after the move.
  IF (SELECT prize_balance+bounty_balance+fee_balance FROM public.fn_poker_diamond_tournament_escrow(p_satellite_id))
       IS DISTINCT FROM public.fn_poker_diamond_tournament_custody(p_satellite_id)::numeric
     OR (SELECT prize_balance+bounty_balance+fee_balance FROM public.fn_poker_diamond_tournament_escrow(p_target_id))
       IS DISTINCT FROM public.fn_poker_diamond_tournament_custody(p_target_id)::numeric THEN
    RAISE EXCEPTION 'diamond_tournament_escrow_disagrees_with_custody' USING ERRCODE='P0404';
  END IF;
  RETURN jsonb_build_object('success',true,'custody_id',v_custody,'registration_id',p_registration_id,
    'amount',p_ticket,'prize',p_prize,'fee',p_fee,'journal_id',v_journal,'request_id',v_request,
    'satellite_ledger_id',v_out_ledger,'target_ledger_id',v_in_ledger,'drained',v_drained);
END $function$;

REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_seat_transfer(uuid,uuid,uuid,uuid,numeric,numeric,numeric,text)
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. THE CREATION GUARD EVERY SATELLITE ROW PASSES THROUGH: ASSETS NEVER CROSS
-- ---------------------------------------------------------------------------
DO $do$
DECLARE v_def text; v_clause text; v_n integer;
v_old1 constant text := $o$ v_target_row public.tournaments%ROWTYPE; v_supported boolean;
BEGIN
$o$;
v_new1 constant text := $n$ v_target_row public.tournaments%ROWTYPE; v_supported boolean;
 v_source_diamond boolean;  -- DIAMOND PHASE 9
BEGIN
$n$;
v_old2 constant text := $o$ IF v_abi='legacy-capacity-v1' THEN RETURN NEW;END IF;
$o$;
v_new2 constant text := $n$ -- DIAMOND PHASE 9: ASSETS NEVER CROSS, under every admission contract. A
 -- satellite and its target are the same asset or the row is refused by name.
 v_source_diamond:=EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=NEW.club_id AND c.asset='diamonds');
 IF v_target IS NOT NULL AND EXISTS(SELECT 1 FROM public.tournaments x WHERE x.id=v_target) THEN
  IF v_source_diamond AND NOT public.fn_poker_diamond_tournament(v_target) THEN
   RAISE EXCEPTION 'SATELLITE_DIAMOND_SOURCE_CANNOT_FEED_A_CHIP_TARGET' USING ERRCODE='22023';
  ELSIF NOT v_source_diamond AND public.fn_poker_diamond_tournament(v_target) THEN
   RAISE EXCEPTION 'SATELLITE_CHIP_SOURCE_CANNOT_FEED_A_DIAMOND_TARGET' USING ERRCODE='22023';
  END IF;
 END IF;
 IF v_abi='legacy-capacity-v1' THEN RETURN NEW;END IF;
$n$;
v_old3 constant text := $o$    ('spin','bounty','progressive','progressive_bounty','pko','mystery','mystery_bounty')
   AND NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=NEW.club_id AND c.asset='diamonds');
$o$;
v_new3 constant text := $n$    ('spin','bounty','progressive','progressive_bounty','pko','mystery','mystery_bounty');
 -- DIAMOND PHASE 9: a Diamond row is supported like a chip row; the asset rule
 -- above decides which targets it may feed, and a target fed by a live
 -- satellite may not change its asset.
$n$;
v_old4 constant text := $o$ IF TG_OP='UPDATE' AND (NOT v_supported OR v_target IS NOT NULL
$o$;
v_new4 constant text := $n$ IF TG_OP='UPDATE' AND (NOT v_supported OR v_target IS NOT NULL
      OR v_source_diamond IS DISTINCT FROM
         EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=OLD.club_id AND c.asset='diamonds')
$n$;
v_old5 constant text := $o$  IF NOT FOUND OR NOT public.fn_ca_satellite_target_accepts_new_feeder(v_target)
$o$;
v_new5 constant text := $n$  IF NOT FOUND OR NOT (CASE WHEN v_source_diamond  -- DIAMOND PHASE 9
       THEN public.fn_ca_diamond_satellite_target_accepts_new_feeder(v_target)
       ELSE public.fn_ca_satellite_target_accepts_new_feeder(v_target) END)
$n$;
BEGIN
  v_def := pg_get_functiondef('public.fn_ca_guard_new_satellite_target()'::regprocedure);
  IF md5(v_def) <> '69247df72bfb68c7148c1a7f9ea4cfd7' THEN
    RAISE EXCEPTION 'fn_ca_guard_new_satellite_target is not the pinned text (md5 %)', md5(v_def);
  END IF;
  FOREACH v_clause IN ARRAY ARRAY[v_old1, v_old2, v_old3, v_old4, v_old5] LOOP
    v_n := (length(v_def) - length(replace(v_def, v_clause, ''))) / length(v_clause);
    IF v_n <> 1 THEN RAISE EXCEPTION 'the creation guard: a clause occurs % times, expected once: %', v_n, left(v_clause, 80); END IF;
  END LOOP;
  EXECUTE replace(replace(replace(replace(replace(v_def, v_old1, v_new1), v_old2, v_new2), v_old3, v_new3), v_old4, v_new4), v_old5, v_new5);
  v_def := pg_get_functiondef('public.fn_ca_guard_new_satellite_target()'::regprocedure);
  IF md5(replace(replace(replace(replace(replace(v_def, v_new1, v_old1), v_new2, v_old2), v_new3, v_old3), v_new4, v_old4), v_new5, v_old5)) <> '69247df72bfb68c7148c1a7f9ea4cfd7' THEN
    RAISE EXCEPTION 'the creation guard is NOT the pinned chip text plus the documented insertions';
  END IF;
END $do$;


-- ---------------------------------------------------------------------------
-- 5. THE DIAMOND CREATION DOOR ADMITS A SATELLITE INTO A DIAMOND TARGET
-- ---------------------------------------------------------------------------
-- 'satellite' is admitted with its target and on nothing else. The target
-- must be a Diamond event (a chip target is refused here by name; the chip
-- creation paths meet the mirror rule in the guard above) that accepts a
-- feeder under the settlement authority's own admission rule, still taking
-- entries. The satellite is the chip scheduled satellite's shape: a
-- freezeout with no late registration that plays before its target; a
-- promised seat count is a guarantee and is refused. Everything else - the
-- whole buy-in, the fee rule, the structures - is the door as it was.
DO $m$
DECLARE v_md5 text;
BEGIN
  SELECT md5(pg_get_functiondef('public.fn_poker_diamond_create_tournament(jsonb)'::regprocedure)) INTO v_md5;
  IF v_md5 <> '6d82bede82370a9cc15d71b5ce1699f5' THEN
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
  v_mystery boolean; v_mb_activation text; v_mb_profile text; v_mb_value numeric; v_mb_top numeric;
  v_mb_pool numeric; v_mb_regular numeric; v_mb_min_mult numeric; v_mb_max_mult numeric;
  v_unlimited boolean;
  v_satellite boolean; v_target_text text; v_target_id uuid; v_target public.tournaments%ROWTYPE;
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
  IF v_type NOT IN ('mtt','sng','bounty','progressive_bounty','mystery_bounty','satellite') THEN
    -- spin: a later Phase 9 piece.
    RAISE EXCEPTION 'diamond_tournament_format_not_open' USING ERRCODE='55000';
  END IF;
  IF COALESCE((p_config->>'guarantee')::numeric,0)<>0
     OR COALESCE((p_config->>'freeBuy')::boolean,false) THEN
    RAISE EXCEPTION 'diamond_tournament_format_not_open' USING ERRCODE='55000';
  END IF;
  -- A satellite is a format, not a flag: its target rides on a 'satellite'
  -- event and on nothing else, and a satellite has exactly one target.
  v_satellite := v_type = 'satellite';
  v_target_text := NULLIF(btrim(COALESCE(p_config->>'satelliteTargetId','')),'');
  IF v_target_text IS NOT NULL AND NOT v_satellite THEN
    RAISE EXCEPTION 'diamond_tournament_target_requires_a_satellite_format' USING ERRCODE='22023';
  END IF;
  IF v_satellite THEN
    IF v_target_text IS NULL
       OR v_target_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'diamond_satellite_requires_a_target' USING ERRCODE='22023';
    END IF;
    v_target_id := v_target_text::uuid;
    -- ASSETS NEVER CROSS: a Diamond satellite seats a Diamond target only.
    IF NOT public.fn_poker_diamond_tournament(v_target_id) THEN
      RAISE EXCEPTION 'diamond_satellite_target_must_be_a_diamond_tournament' USING ERRCODE='22023';
    END IF;
    IF NOT public.fn_ca_diamond_satellite_target_accepts_new_feeder(v_target_id) THEN
      RAISE EXCEPTION 'diamond_satellite_target_cannot_take_a_satellite' USING ERRCODE='22023';
    END IF;
    SELECT * INTO v_target FROM public.tournaments t WHERE t.id=v_target_id;
    IF upper(COALESCE(v_target.status,'')) NOT IN ('ANNOUNCED','REGISTERING')
       OR COALESCE(v_target.prize_pool_finalized,false) THEN
      RAISE EXCEPTION 'diamond_satellite_target_is_not_open' USING ERRCODE='55000';
    END IF;
    -- A seat count promised in advance is a guarantee: reserved to the owner.
    IF COALESCE(NULLIF(p_config->>'satelliteSeats','')::numeric,0)<>0 THEN
      RAISE EXCEPTION 'diamond_satellite_seat_guarantee_not_open' USING ERRCODE='55000';
    END IF;
    -- The chip scheduled satellite is a freezeout; so is this one.
    IF COALESCE((p_config->>'rebuy')::boolean,false) OR COALESCE((p_config->>'reentry')::boolean,false)
       OR COALESCE((p_config->>'addOn')::boolean,false) THEN
      RAISE EXCEPTION 'diamond_satellite_is_a_freezeout' USING ERRCODE='22023';
    END IF;
  END IF;
  -- A knockout bounty is a format, not a flag: the flat bounty rides on a
  -- 'bounty', 'progressive_bounty' or 'mystery_bounty' event and on nothing else.
  v_is_bounty := v_type IN ('bounty','progressive_bounty','mystery_bounty');
  v_mystery := v_type = 'mystery_bounty';
  v_bounty_num := COALESCE((p_config->>'bountyAmount')::numeric,0);
  IF NOT v_is_bounty AND (v_bounty_num<>0 OR COALESCE((p_config->>'isBounty')::boolean,false)) THEN
    RAISE EXCEPTION 'diamond_tournament_bounty_requires_a_bounty_format' USING ERRCODE='22023';
  END IF;
  IF NOT v_mystery AND (p_config ? 'mysteryBountyMin' OR p_config ? 'mysteryBountyMax' OR p_config ? 'mysteryBounty') THEN
    RAISE EXCEPTION 'diamond_tournament_mystery_requires_a_mystery_format' USING ERRCODE='22023';
  END IF;
  v_game := upper(btrim(COALESCE(p_config->>'gameVariant','NLH')));
  IF v_game NOT IN ('NLH','PLO4','PLO5','PLO6','PLO8','SHORT_DECK','FLH','FLO8') THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_supported_game' USING ERRCODE='22023';
  END IF;

  v_total := COALESCE((p_config->>'buyIn')::numeric,0);
  IF (p_config->>'buyIn')::numeric IS DISTINCT FROM v_total::numeric OR v_total<1 OR v_total>2147483647 THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_whole_positive_buy_in' USING ERRCODE='22023';
  END IF;
  v_unlimited:=public.fn_ca_new_tournament_is_unlimited(jsonb_build_object('tournament_type',
    CASE WHEN v_type='sng' THEN 'SNG' WHEN v_satellite THEN 'SATELLITE' ELSE 'MTT' END));
  v_max := CASE WHEN v_unlimited THEN NULL ELSE COALESCE((p_config->>'maxPlayers')::int,0) END;
  IF NOT v_unlimited AND (v_max<2 OR v_max>10000) THEN RAISE EXCEPTION 'diamond_tournament_requires_a_real_field' USING ERRCODE='22023'; END IF;
  v_min := GREATEST(COALESCE((p_config->>'minPlayers')::int,3),CASE WHEN v_unlimited THEN 3 ELSE 2 END);
  IF NOT v_unlimited AND v_min>v_max THEN v_min := v_max; END IF;
  -- The fee rule the recovery fee already states, at this entry's own unit.
  v_ratio := CASE WHEN NOT v_unlimited AND v_max<=2 THEN 0.05 ELSE 0.10 END;
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
  -- The mystery rules are the chip configuration door's rules
  -- (fn_apply_mystery_bounty_config), stamped here because that door consults
  -- a club owner the arena does not have. The lobby's advertised range is the
  -- chip door's multipliers on the flat bounty, in whole Diamonds.
  IF v_mystery THEN
    v_mb_activation := COALESCE(p_config->'mysteryBounty'->>'activation', 'at_the_money');
    IF v_mb_activation NOT IN ('at_the_money','percent_field','player_count') THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_bad_activation_mode' USING ERRCODE='22023';
    END IF;
    v_mb_profile := COALESCE(p_config->'mysteryBounty'->>'profile', 'classic');
    IF v_mb_profile NOT IN ('balanced','classic','jackpot') THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_bad_profile' USING ERRCODE='22023';
    END IF;
    v_mb_value := (p_config->'mysteryBounty'->>'activationValue')::numeric;
    IF v_mb_activation = 'percent_field' AND (COALESCE(v_mb_value,0) <= 0 OR v_mb_value > 100) THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_activation_percent_out_of_range' USING ERRCODE='22023';
    END IF;
    IF v_mb_activation = 'player_count' AND COALESCE(v_mb_value,0) < 2 THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_activation_count_too_small' USING ERRCODE='22023';
    END IF;
    v_mb_top := COALESCE((p_config->'mysteryBounty'->>'topPercent')::numeric, 20);
    IF v_mb_top <= 0 OR v_mb_top > 100 THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_top_percent_out_of_range' USING ERRCODE='22023';
    END IF;
    v_mb_pool := COALESCE((p_config->'mysteryBounty'->>'poolPercent')::numeric, 50);
    v_mb_regular := COALESCE((p_config->'mysteryBounty'->>'regularPoolPercent')::numeric, 100 - v_mb_pool);
    IF v_mb_pool < 0 OR v_mb_regular < 0 OR v_mb_pool + v_mb_regular <= 0 THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_pool_split_invalid' USING ERRCODE='22023';
    END IF;
    v_mb_min_mult := COALESCE(NULLIF(p_config->>'mysteryBountyMin','')::numeric, 0.5);
    v_mb_max_mult := COALESCE(NULLIF(p_config->>'mysteryBountyMax','')::numeric, 13);
    IF v_mb_min_mult <= 0 OR v_mb_max_mult < v_mb_min_mult THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_range_invalid' USING ERRCODE='22023';
    END IF;
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
  IF NOT v_unlimited AND jsonb_array_length(v_payouts)>v_max THEN RAISE EXCEPTION 'more_paid_places_than_players' USING ERRCODE='22023'; END IF;
  v_start := COALESCE((p_config->>'startTime')::timestamptz, now()+interval '1 minute');
  -- A satellite plays before its target, as the chip scheduled satellite does.
  IF v_satellite AND (v_target.start_time IS NULL OR v_start >= v_target.start_time) THEN
    RAISE EXCEPTION 'diamond_satellite_must_start_before_its_target' USING ERRCODE='22023';
  END IF;
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
                           WHEN 'progressive_bounty' THEN 'progressive_bounty'
                           WHEN 'mystery_bounty' THEN 'mystery_bounty'
                           WHEN 'satellite' THEN 'satellite' ELSE 'freezeout' END;

  INSERT INTO public.tournaments (
    club_id, union_id, name, game_type, variant, tournament_type,
    buy_in_amount, buy_in_fee, guaranteed_prize, starting_chips, max_players, table_size, min_players,
    current_players, status, blind_structure, payout_structure, start_time,
    late_reg_levels, late_reg_mins, is_bounty, is_pko, is_mystery_bounty, bounty_amount,
    mystery_bounty_min, mystery_bounty_max,
    mystery_bounty_activation, mystery_bounty_activation_value, mystery_bounty_profile,
    mystery_bounty_top_percent, mystery_bounty_pool_percent, mystery_bounty_regular_pool_percent,
    is_rebuy, is_reentry, rebuy_cost, rebuy_chips, rebuy_levels, max_rebuys, max_reentries,
    add_on_available, addon_cost, addon_chips, addon_levels,
    payout_percent, free_buy, is_private, action_time_seconds,
    satellite_target_id, satellite_seats)
  VALUES (
    v_arena, NULL, v_name, v_game, v_variant,
    CASE WHEN v_type='sng' THEN 'SNG' WHEN v_satellite THEN 'SATELLITE' ELSE 'MTT' END,
    v_buy_in, v_fee, 0, v_chips, v_max, CASE WHEN v_unlimited THEN LEAST(9,GREATEST(2,COALESCE((p_config->>'tableSize')::int,9))) ELSE LEAST(9,GREATEST(2,v_max)) END, v_min,
    0, 'REGISTERING', v_blinds::text, v_payouts::text, v_start,
    CASE WHEN v_satellite THEN 0 ELSE COALESCE((p_config->>'lateRegLevels')::int, CASE WHEN v_type='sng' THEN 0 ELSE 8 END) END,
    CASE WHEN v_satellite THEN 0 ELSE 8 END,
    v_is_bounty, v_type='progressive_bounty', v_mystery, v_bounty,
    CASE WHEN v_mystery THEN trunc(v_bounty * v_mb_min_mult) ELSE 0 END,
    CASE WHEN v_mystery THEN trunc(v_bounty * v_mb_max_mult) ELSE 0 END,
    CASE WHEN v_mystery THEN v_mb_activation ELSE 'at_the_money' END, CASE WHEN v_mystery THEN v_mb_value END,
    CASE WHEN v_mystery THEN v_mb_profile ELSE 'classic' END,
    CASE WHEN v_mystery THEN v_mb_top ELSE 20 END, CASE WHEN v_mystery THEN v_mb_pool ELSE 50 END,
    CASE WHEN v_mystery THEN v_mb_regular ELSE 50 END,
    v_rebuy, v_reentry, CASE WHEN v_rebuy OR v_reentry THEN v_rebuy_cost ELSE 0 END,
    CASE WHEN v_rebuy OR v_reentry THEN v_chips ELSE 0 END, CASE WHEN v_rebuy OR v_reentry THEN 6 ELSE 4 END,
    CASE WHEN v_rebuy THEN COALESCE((p_config->>'maxRebuys')::int,2) ELSE 0 END,
    CASE WHEN v_reentry THEN COALESCE((p_config->>'maxReentries')::int,1) ELSE 0 END,
    v_addon, CASE WHEN v_addon THEN v_addon_cost ELSE 0 END, CASE WHEN v_addon THEN v_chips ELSE 0 END, 1,
    CASE WHEN (p_config->>'payoutPercent')::int IN (10,15,20) THEN (p_config->>'payoutPercent')::smallint ELSE 10 END,
    false, false, 15,
    CASE WHEN v_satellite THEN v_target_id END, CASE WHEN v_satellite THEN 0 END)
  RETURNING id INTO v_id;

  -- The row this door wrote must be one the money path will price: whole
  -- Diamonds everywhere, and the unit rule must recognise it.
  IF public.fn_ca_tournament_unit_cents(v_id) <> 100 OR NOT public.fn_poker_diamond_tournament(v_id) THEN
    RAISE EXCEPTION 'diamond_tournament_would_not_be_recognised' USING ERRCODE='23514';
  END IF;
  RETURN jsonb_build_object('success',true,'tournamentId',v_id,'id',v_id,'buy_in_amount',v_buy_in,'buy_in_fee',v_fee,
    'total',v_total,'bounty_amount',v_bounty,'is_mystery_bounty',v_mystery,'asset','diamonds',
    'satellite_target_id',v_target_id,'satellite_ticket',
    CASE WHEN v_satellite THEN v_target.buy_in_amount + COALESCE(v_target.buy_in_fee,0) END);
END $function$;

REVOKE ALL ON FUNCTION public.fn_poker_diamond_create_tournament(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_create_tournament(jsonb) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5b. A DIAMOND SATELLITE PROMISES NO SEAT, AND ITS CONTRACT IS COMPLETE
-- ---------------------------------------------------------------------------
DO $do$
DECLARE v_def text; v_clause text; v_n integer;
v_old1 constant text := $o$    AND (
      NOT v_is_satellite
      OR (v_satellite_seats > 0 AND v_target IS NOT NULL AND v_target_found)
    );
$o$;
v_new1 constant text := $n$    AND (
      NOT v_is_satellite
      OR (v_satellite_seats > 0 AND v_target IS NOT NULL AND v_target_found)
      -- DIAMOND PHASE 9: a Diamond satellite promises no seat. A seat count
      -- promised in advance is a guarantee; a Diamond guarantee is funded only
      -- from an authorised Diamond house budget, which is not built and whose
      -- size is the owner's, and the creation door refuses one by name. The
      -- satellite's own prize bank buys whole seats in its Diamond target at
      -- settlement, so its contract is complete with none promised. The test
      -- is fn_poker_diamond_tournament's, read from the row.
      OR (v_satellite_seats = 0 AND v_target IS NOT NULL AND v_row_union IS NULL
          AND EXISTS (SELECT 1 FROM public.clubs c
                       WHERE c.id = v_club AND c.asset = 'diamonds'
                         AND c.is_platform IS TRUE AND c.union_id IS NULL)
          AND public.fn_poker_diamond_tournament(v_target))
    );
$n$;
BEGIN
  v_def := pg_get_functiondef('public.fn_tournament_management_readiness_for_row(jsonb)'::regprocedure);
  IF md5(v_def) <> '0b9fecc5c10bdcf459510bbb19a3268a' THEN
    RAISE EXCEPTION 'fn_tournament_management_readiness_for_row is not the pinned text (md5 %)', md5(v_def);
  END IF;
  FOREACH v_clause IN ARRAY ARRAY[v_old1] LOOP
    v_n := (length(v_def) - length(replace(v_def, v_clause, ''))) / length(v_clause);
    IF v_n <> 1 THEN RAISE EXCEPTION 'the readiness contract: a clause occurs % times, expected once: %', v_n, left(v_clause, 80); END IF;
  END LOOP;
  EXECUTE replace(v_def, v_old1, v_new1);
  v_def := pg_get_functiondef('public.fn_tournament_management_readiness_for_row(jsonb)'::regprocedure);
  IF md5(replace(v_def, v_new1, v_old1)) <> '0b9fecc5c10bdcf459510bbb19a3268a' THEN
    RAISE EXCEPTION 'the readiness contract is NOT the pinned chip text plus the documented insertions';
  END IF;
END $do$;

-- ---------------------------------------------------------------------------
-- 6. THE SINGLE-WINNER AUTHORITY DELIVERS A DIAMOND SEAT
-- ---------------------------------------------------------------------------
DO $do$
DECLARE v_def text; v_clause text; v_n integer;
v_old1 constant text := $o$  v_source_escrow_close_note text :=
    'atomic satellite terminal receipt: exact zero';
BEGIN
$o$;
v_new1 constant text := $n$  v_source_escrow_close_note text :=
    'atomic satellite terminal receipt: exact zero';
  v_diamond boolean := false;              -- DIAMOND PHASE 9
  v_diamond_seat jsonb;                    -- DIAMOND PHASE 9
  v_target_prize_before numeric;           -- DIAMOND PHASE 9
  v_target_fee_before numeric;             -- DIAMOND PHASE 9
  v_target_bounty_before numeric;          -- DIAMOND PHASE 9
  v_target_custody_before numeric;         -- DIAMOND PHASE 9
  v_unit_cents integer;                    -- DIAMOND PHASE 9
BEGIN
$n$;
v_old2 constant text := $o$  v_target_buy_in := v_target.buy_in_amount;
  v_target_fee := COALESCE(v_target.buy_in_fee, 0);
$o$;
v_new2 constant text := $n$  -- DIAMOND PHASE 9: ASSETS NEVER CROSS. A Diamond satellite seats only a
  -- Diamond target and a chip satellite only a chip target; either crossing
  -- is refused by name here, before any money, roster or escrow row moves.
  v_diamond := public.fn_ca_assert_satellite_asset(p_tournament_id, v_target_id);
  v_target_buy_in := v_target.buy_in_amount;
  v_target_fee := COALESCE(v_target.buy_in_fee, 0);
$n$;
v_old3 constant text := $o$  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id, 'atomic satellite settlement source lock');
$o$;
v_new3 constant text := $n$  -- DIAMOND PHASE 9: a Diamond satellite's escrow shadow opens from its own
  -- ledger with its exact parts, as the Diamond terminal writer opens one.
  IF v_diamond THEN
    PERFORM public.fn_poker_diamond_tournament_open_shadow(p_tournament_id);
  END IF;
  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id, 'atomic satellite settlement source lock');
$n$;
v_old4 constant text := $o$  v_remainder := round(v_pool - v_ticket_award_count * v_ticket_cost, 2);
$o$;
v_new4 constant text := $n$  v_remainder := round(v_pool - v_ticket_award_count * v_ticket_cost, 2);
  -- DIAMOND PHASE 9: WHERE THE UNIT DIVIDES - NOWHERE. The prize bank is a
  -- sum of whole ledger parts and the ticket is the target's whole buy-in
  -- plus its whole fee, so seats times ticket and the remainder are whole
  -- Diamonds and the flooring residue (the remainder less its floor at the
  -- unit) is exactly zero. It lands nowhere: a pool, ticket or remainder
  -- that is not its own floor at the unit is refused by name, before any
  -- Diamond moves.
  IF v_diamond THEN
    v_unit_cents := public.fn_ca_tournament_unit_cents(p_tournament_id);
    IF public.fn_ca_unit_floor_cents(round(v_pool * 100)::bigint, v_unit_cents)
         <> round(v_pool * 100)::bigint
       OR public.fn_ca_unit_floor_cents(round(v_ticket_cost * 100)::bigint, v_unit_cents)
         <> round(v_ticket_cost * 100)::bigint
       OR public.fn_ca_unit_floor_cents(round(v_remainder * 100)::bigint, v_unit_cents)
         <> round(v_remainder * 100)::bigint THEN
      RAISE EXCEPTION
        'diamond_satellite_does_not_divide_into_whole_diamonds: satellite % pool % ticket % remainder %',
        p_tournament_id, v_pool, v_ticket_cost, v_remainder USING ERRCODE = '23514';
    END IF;
  END IF;
$n$;
v_old5 constant text := $o$        IF v_cap_load>=4 THEN
          -- The cap remains absolute. The winner receives the funded entry as
$o$;
v_new5 constant text := $n$        IF v_cap_load>=4 THEN
          -- DIAMOND PHASE 9: the chip estate holds a capped winner's funded
          -- entry in a noncash chip entry ticket. No Diamond entry ticket
          -- exists, so a Diamond settlement is refused by name - nothing has
          -- moved - and is retried once the winner is below the cap.
          IF v_diamond THEN
            RAISE EXCEPTION
              'diamond_satellite_winner_at_the_table_cap: satellite % award % user %',
              p_tournament_id, v_place, v_finisher.user_id USING ERRCODE = '55000';
          END IF;
          -- The cap remains absolute. The winner receives the funded entry as
$n$;
v_old6 constant text := $o$  IF v_seat_count > 0 THEN
    -- Zero-delta reconstruction is a write when the escrow already exists, so
$o$;
v_new6 constant text := $n$  -- DIAMOND PHASE 9: a Diamond target's money is its Diamond ledger and its
  -- custody, not a chip escrow. A satellite does not open its shadow (its own
  -- terminal does); the aggregates it publishes must be exactly its banks
  -- before a seat is added, and its banks exactly its custody.
  IF v_seat_count > 0 AND v_diamond THEN
    SELECT e.prize_balance, e.fee_balance, e.bounty_balance
      INTO v_target_prize_before, v_target_fee_before, v_target_bounty_before
      FROM public.fn_poker_diamond_tournament_escrow(v_target_id) e;
    v_target_custody_before := public.fn_poker_diamond_tournament_custody(v_target_id)::numeric;
    IF v_target.current_players IS DISTINCT FROM v_target_counter_before
       OR v_target.prize_pool IS DISTINCT FROM v_target_prize_before
       OR v_target.total_rake IS DISTINCT FROM v_target_fee_before
       OR v_target_bounty_before IS DISTINCT FROM 0::numeric
       OR v_target_prize_before + v_target_fee_before IS DISTINCT FROM v_target_custody_before THEN
      RAISE EXCEPTION
        'satellite % cannot deliver a Diamond target seat against malformed aggregate or bank state',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;
  IF v_seat_count > 0 AND NOT v_diamond THEN
    -- Zero-delta reconstruction is a write when the escrow already exists, so
$n$;
v_old7 constant text := $o$  IF v_seat_count > 0 AND (
       v_target.current_players IS NULL
$o$;
v_new7 constant text := $n$  IF v_seat_count > 0 AND NOT v_diamond AND (
       v_target.current_players IS NULL
$n$;
v_old8 constant text := $o$      IF v_registration_id IS NULL THEN
        RAISE EXCEPTION 'satellite % seat % returned no registration receipt',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;
$o$;
v_new8 constant text := $n$      IF v_registration_id IS NULL THEN
        RAISE EXCEPTION 'satellite % seat % returned no registration receipt',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;
      IF v_diamond THEN
        -- DIAMOND PHASE 9: THE SEAT IS A CUSTODY-TO-CUSTODY MOVEMENT. The
        -- whole ticket leaves the satellite's prize bank (a release movement
        -- on each drained entry row) and becomes the winner's funded entry
        -- in the target (a new tournament_entry custody row, its reserve
        -- movement, and the entry ledger row carrying the target's own prize
        -- and fee parts). No wallet moves and the register does not move;
        -- the chip transfer leg and the chip fee row are not written. It is
        -- written before any chair is taken: a Diamond tournament chair is
        -- admitted only against an active funded entry (P0810).
        v_diamond_seat := public.fn_poker_diamond_tournament_seat_transfer(
          p_tournament_id, v_target_id, v_finisher.user_id, v_registration_id,
          v_ticket_cost, v_target_buy_in, v_target_fee,
          'tourney:' || p_tournament_id::text || ':seat:' || v_finisher.user_id::text);
        IF COALESCE((v_diamond_seat->>'success')::boolean, false) IS NOT TRUE
           OR COALESCE((v_diamond_seat->>'idempotent')::boolean, false) THEN
          RAISE EXCEPTION 'satellite % Diamond seat % was not delivered exactly once',
            p_tournament_id, v_place USING ERRCODE = 'P0404';
        END IF;
      END IF;
$n$;
v_old9 constant text := $o$      v_pool_before := round(v_pool - (v_place - 1) * v_ticket_cost, 2);
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, tournament_id, idempotency_key,
         settlement_id, actor_service, description, metadata,
         pre_from_balance, post_from_balance)
$o$;
v_new9 constant text := $n$      IF NOT v_diamond THEN  -- DIAMOND PHASE 9: the chip transfer and fee legs
      v_pool_before := round(v_pool - (v_place - 1) * v_ticket_cost, 2);
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, tournament_id, idempotency_key,
         settlement_id, actor_service, description, metadata,
         pre_from_balance, post_from_balance)
$n$;
v_old10 constant text := $o$      END IF;

      v_payout_key := 'tourney:' || p_tournament_id::text
                      || ':seat:' || v_finisher.user_id::text;
$o$;
v_new10 constant text := $n$      END IF;
      END IF;  -- DIAMOND PHASE 9: the chip transfer and fee legs

      v_payout_key := 'tourney:' || p_tournament_id::text
                      || ':seat:' || v_finisher.user_id::text;
$n$;
v_old11 constant text := $o$       OR v_target_escrow_after.tournament_id IS DISTINCT FROM v_target_id
$o$;
v_new11 constant text := $n$       OR (NOT v_diamond AND (v_target_escrow_after.tournament_id IS DISTINCT FROM v_target_id
$n$;
v_old12 constant text := $o$       OR v_target_escrow_after.close_note IS DISTINCT FROM v_target_escrow.close_note THEN
$o$;
v_new12 constant text := $n$       OR v_target_escrow_after.close_note IS DISTINCT FROM v_target_escrow.close_note))
       -- DIAMOND PHASE 9: a Diamond target proves the delta on its own banks:
       -- each seat added exactly its buy-in to the prize bank, its fee to the
       -- fee bank and its ticket to custody, and the aggregates follow them.
       OR (v_diamond AND (
            (SELECT e.prize_balance FROM public.fn_poker_diamond_tournament_escrow(v_target_id) e)
              IS DISTINCT FROM v_target_prize_before + v_seat_count * v_target_buy_in
         OR (SELECT e.fee_balance FROM public.fn_poker_diamond_tournament_escrow(v_target_id) e)
              IS DISTINCT FROM v_target_fee_before + v_seat_count * v_target_fee
         OR (SELECT e.bounty_balance FROM public.fn_poker_diamond_tournament_escrow(v_target_id) e)
              IS DISTINCT FROM 0::numeric
         OR public.fn_poker_diamond_tournament_custody(v_target_id)::numeric
              IS DISTINCT FROM v_target_custody_before + v_seat_count * v_ticket_cost
         OR v_target_after.prize_pool IS DISTINCT FROM
              (SELECT e.prize_balance FROM public.fn_poker_diamond_tournament_escrow(v_target_id) e)
         OR v_target_after.total_rake IS DISTINCT FROM
              (SELECT e.fee_balance FROM public.fn_poker_diamond_tournament_escrow(v_target_id) e))) THEN
$n$;
BEGIN
  v_def := pg_get_functiondef('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)'::regprocedure);
  IF md5(v_def) <> '9c5dd58bbae1d4ad4c1f5c808948da4d' THEN
    RAISE EXCEPTION 'fn_settle_satellite_tournament_pre_money_path_gate is not the pinned text (md5 %)', md5(v_def);
  END IF;
  FOREACH v_clause IN ARRAY ARRAY[v_old1, v_old2, v_old3, v_old4, v_old5, v_old6, v_old7, v_old8, v_old9, v_old10, v_old11, v_old12] LOOP
    v_n := (length(v_def) - length(replace(v_def, v_clause, ''))) / length(v_clause);
    IF v_n <> 1 THEN RAISE EXCEPTION 'the single-winner authority: a clause occurs % times, expected once: %', v_n, left(v_clause, 80); END IF;
  END LOOP;
  EXECUTE replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(v_def, v_old1, v_new1), v_old2, v_new2), v_old3, v_new3), v_old4, v_new4), v_old5, v_new5), v_old6, v_new6), v_old7, v_new7), v_old8, v_new8), v_old9, v_new9), v_old10, v_new10), v_old11, v_new11), v_old12, v_new12);
  v_def := pg_get_functiondef('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)'::regprocedure);
  IF md5(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(v_def, v_new1, v_old1), v_new2, v_old2), v_new3, v_old3), v_new4, v_old4), v_new5, v_old5), v_new6, v_old6), v_new7, v_old7), v_new8, v_old8), v_new9, v_old9), v_new10, v_old10), v_new11, v_old11), v_new12, v_old12)) <> '9c5dd58bbae1d4ad4c1f5c808948da4d' THEN
    RAISE EXCEPTION 'the single-winner authority is NOT the pinned chip text plus the documented insertions';
  END IF;
END $do$;

-- ---------------------------------------------------------------------------
-- 7. THE COHORT AUTHORITY DELIVERS A DIAMOND SEAT
-- ---------------------------------------------------------------------------
DO $do$
DECLARE v_def text; v_clause text; v_n integer;
v_old1 constant text := $o$  v_source_escrow_close_note text :=
    'atomic satellite terminal receipt: exact zero';
BEGIN
$o$;
v_new1 constant text := $n$  v_source_escrow_close_note text :=
    'atomic satellite terminal receipt: exact zero';
  v_diamond boolean := false;              -- DIAMOND PHASE 9
  v_diamond_seat jsonb;                    -- DIAMOND PHASE 9
  v_target_prize_before numeric;           -- DIAMOND PHASE 9
  v_target_fee_before numeric;             -- DIAMOND PHASE 9
  v_target_bounty_before numeric;          -- DIAMOND PHASE 9
  v_target_custody_before numeric;         -- DIAMOND PHASE 9
  v_unit_cents integer;                    -- DIAMOND PHASE 9
BEGIN
$n$;
v_old2 constant text := $o$  v_target_buy_in := v_target.buy_in_amount;
  v_target_fee := COALESCE(v_target.buy_in_fee, 0);
$o$;
v_new2 constant text := $n$  -- DIAMOND PHASE 9: ASSETS NEVER CROSS. A Diamond satellite seats only a
  -- Diamond target and a chip satellite only a chip target; either crossing
  -- is refused by name here, before any money, roster or escrow row moves.
  v_diamond := public.fn_ca_assert_satellite_asset(p_tournament_id, v_target_id);
  v_target_buy_in := v_target.buy_in_amount;
  v_target_fee := COALESCE(v_target.buy_in_fee, 0);
$n$;
v_old3 constant text := $o$  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id, 'atomic satellite settlement source lock');
$o$;
v_new3 constant text := $n$  -- DIAMOND PHASE 9: a Diamond satellite's escrow shadow opens from its own
  -- ledger with its exact parts, as the Diamond terminal writer opens one.
  IF v_diamond THEN
    PERFORM public.fn_poker_diamond_tournament_open_shadow(p_tournament_id);
  END IF;
  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id, 'atomic satellite settlement source lock');
$n$;
v_old4 constant text := $o$  v_remainder := round(v_pool - v_ticket_award_count * v_ticket_cost, 2);
$o$;
v_new4 constant text := $n$  v_remainder := round(v_pool - v_ticket_award_count * v_ticket_cost, 2);
  -- DIAMOND PHASE 9: WHERE THE UNIT DIVIDES - NOWHERE. The prize bank is a
  -- sum of whole ledger parts and the ticket is the target's whole buy-in
  -- plus its whole fee, so seats times ticket and the remainder are whole
  -- Diamonds and the flooring residue (the remainder less its floor at the
  -- unit) is exactly zero. It lands nowhere: a pool, ticket or remainder
  -- that is not its own floor at the unit is refused by name, before any
  -- Diamond moves.
  IF v_diamond THEN
    v_unit_cents := public.fn_ca_tournament_unit_cents(p_tournament_id);
    IF public.fn_ca_unit_floor_cents(round(v_pool * 100)::bigint, v_unit_cents)
         <> round(v_pool * 100)::bigint
       OR public.fn_ca_unit_floor_cents(round(v_ticket_cost * 100)::bigint, v_unit_cents)
         <> round(v_ticket_cost * 100)::bigint
       OR public.fn_ca_unit_floor_cents(round(v_remainder * 100)::bigint, v_unit_cents)
         <> round(v_remainder * 100)::bigint THEN
      RAISE EXCEPTION
        'diamond_satellite_does_not_divide_into_whole_diamonds: satellite % pool % ticket % remainder %',
        p_tournament_id, v_pool, v_ticket_cost, v_remainder USING ERRCODE = '23514';
    END IF;
  END IF;
$n$;
v_old5 constant text := $o$        IF v_cap_load>=4 THEN
          -- The cap remains absolute. The winner receives the funded entry as
$o$;
v_new5 constant text := $n$        IF v_cap_load>=4 THEN
          -- DIAMOND PHASE 9: the chip estate holds a capped winner's funded
          -- entry in a noncash chip entry ticket. No Diamond entry ticket
          -- exists, so a Diamond settlement is refused by name - nothing has
          -- moved - and is retried once the winner is below the cap.
          IF v_diamond THEN
            RAISE EXCEPTION
              'diamond_satellite_winner_at_the_table_cap: satellite % award % user %',
              p_tournament_id, v_place, v_finisher.user_id USING ERRCODE = '55000';
          END IF;
          -- The cap remains absolute. The winner receives the funded entry as
$n$;
v_old6 constant text := $o$  IF v_seat_count > 0 THEN
    -- Zero-delta reconstruction is a write when the escrow already exists, so
$o$;
v_new6 constant text := $n$  -- DIAMOND PHASE 9: a Diamond target's money is its Diamond ledger and its
  -- custody, not a chip escrow. A satellite does not open its shadow (its own
  -- terminal does); the aggregates it publishes must be exactly its banks
  -- before a seat is added, and its banks exactly its custody.
  IF v_seat_count > 0 AND v_diamond THEN
    SELECT e.prize_balance, e.fee_balance, e.bounty_balance
      INTO v_target_prize_before, v_target_fee_before, v_target_bounty_before
      FROM public.fn_poker_diamond_tournament_escrow(v_target_id) e;
    v_target_custody_before := public.fn_poker_diamond_tournament_custody(v_target_id)::numeric;
    IF v_target.current_players IS DISTINCT FROM v_target_counter_before
       OR v_target.prize_pool IS DISTINCT FROM v_target_prize_before
       OR v_target.total_rake IS DISTINCT FROM v_target_fee_before
       OR v_target_bounty_before IS DISTINCT FROM 0::numeric
       OR v_target_prize_before + v_target_fee_before IS DISTINCT FROM v_target_custody_before THEN
      RAISE EXCEPTION
        'satellite % cannot deliver a Diamond target seat against malformed aggregate or bank state',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;
  IF v_seat_count > 0 AND NOT v_diamond THEN
    -- Zero-delta reconstruction is a write when the escrow already exists, so
$n$;
v_old7 constant text := $o$  IF v_seat_count > 0 AND (
       v_target.current_players IS NULL
$o$;
v_new7 constant text := $n$  IF v_seat_count > 0 AND NOT v_diamond AND (
       v_target.current_players IS NULL
$n$;
v_old8 constant text := $o$      IF v_registration_id IS NULL THEN
        RAISE EXCEPTION 'satellite % seat % returned no registration receipt',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;
$o$;
v_new8 constant text := $n$      IF v_registration_id IS NULL THEN
        RAISE EXCEPTION 'satellite % seat % returned no registration receipt',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;
      IF v_diamond THEN
        -- DIAMOND PHASE 9: THE SEAT IS A CUSTODY-TO-CUSTODY MOVEMENT. The
        -- whole ticket leaves the satellite's prize bank (a release movement
        -- on each drained entry row) and becomes the winner's funded entry
        -- in the target (a new tournament_entry custody row, its reserve
        -- movement, and the entry ledger row carrying the target's own prize
        -- and fee parts). No wallet moves and the register does not move;
        -- the chip transfer leg and the chip fee row are not written. It is
        -- written before any chair is taken: a Diamond tournament chair is
        -- admitted only against an active funded entry (P0810).
        v_diamond_seat := public.fn_poker_diamond_tournament_seat_transfer(
          p_tournament_id, v_target_id, v_finisher.user_id, v_registration_id,
          v_ticket_cost, v_target_buy_in, v_target_fee,
          'tourney:' || p_tournament_id::text || ':seat:' || v_finisher.user_id::text);
        IF COALESCE((v_diamond_seat->>'success')::boolean, false) IS NOT TRUE
           OR COALESCE((v_diamond_seat->>'idempotent')::boolean, false) THEN
          RAISE EXCEPTION 'satellite % Diamond seat % was not delivered exactly once',
            p_tournament_id, v_place USING ERRCODE = 'P0404';
        END IF;
      END IF;
$n$;
v_old9 constant text := $o$      v_pool_before := round(v_pool - (v_place - 1) * v_ticket_cost, 2);
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, tournament_id, idempotency_key,
         settlement_id, actor_service, description, metadata,
         pre_from_balance, post_from_balance)
$o$;
v_new9 constant text := $n$      IF NOT v_diamond THEN  -- DIAMOND PHASE 9: the chip transfer and fee legs
      v_pool_before := round(v_pool - (v_place - 1) * v_ticket_cost, 2);
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, tournament_id, idempotency_key,
         settlement_id, actor_service, description, metadata,
         pre_from_balance, post_from_balance)
$n$;
v_old10 constant text := $o$      END IF;

      v_payout_key := 'tourney:' || p_tournament_id::text
                      || ':seat:' || v_finisher.user_id::text;
$o$;
v_new10 constant text := $n$      END IF;
      END IF;  -- DIAMOND PHASE 9: the chip transfer and fee legs

      v_payout_key := 'tourney:' || p_tournament_id::text
                      || ':seat:' || v_finisher.user_id::text;
$n$;
v_old11 constant text := $o$       OR v_target_escrow_after.tournament_id IS DISTINCT FROM v_target_id
$o$;
v_new11 constant text := $n$       OR (NOT v_diamond AND (v_target_escrow_after.tournament_id IS DISTINCT FROM v_target_id
$n$;
v_old12 constant text := $o$       OR v_target_escrow_after.close_note IS DISTINCT FROM v_target_escrow.close_note THEN
$o$;
v_new12 constant text := $n$       OR v_target_escrow_after.close_note IS DISTINCT FROM v_target_escrow.close_note))
       -- DIAMOND PHASE 9: a Diamond target proves the delta on its own banks:
       -- each seat added exactly its buy-in to the prize bank, its fee to the
       -- fee bank and its ticket to custody, and the aggregates follow them.
       OR (v_diamond AND (
            (SELECT e.prize_balance FROM public.fn_poker_diamond_tournament_escrow(v_target_id) e)
              IS DISTINCT FROM v_target_prize_before + v_seat_count * v_target_buy_in
         OR (SELECT e.fee_balance FROM public.fn_poker_diamond_tournament_escrow(v_target_id) e)
              IS DISTINCT FROM v_target_fee_before + v_seat_count * v_target_fee
         OR (SELECT e.bounty_balance FROM public.fn_poker_diamond_tournament_escrow(v_target_id) e)
              IS DISTINCT FROM 0::numeric
         OR public.fn_poker_diamond_tournament_custody(v_target_id)::numeric
              IS DISTINCT FROM v_target_custody_before + v_seat_count * v_ticket_cost
         OR v_target_after.prize_pool IS DISTINCT FROM
              (SELECT e.prize_balance FROM public.fn_poker_diamond_tournament_escrow(v_target_id) e)
         OR v_target_after.total_rake IS DISTINCT FROM
              (SELECT e.fee_balance FROM public.fn_poker_diamond_tournament_escrow(v_target_id) e))) THEN
$n$;
BEGIN
  v_def := pg_get_functiondef('public.fn_ca_settle_satellite_cohort(uuid,uuid[])'::regprocedure);
  IF md5(v_def) <> '6e9822dd8367827cf2ba31f2c41b4771' THEN
    RAISE EXCEPTION 'fn_ca_settle_satellite_cohort is not the pinned text (md5 %)', md5(v_def);
  END IF;
  FOREACH v_clause IN ARRAY ARRAY[v_old1, v_old2, v_old3, v_old4, v_old5, v_old6, v_old7, v_old8, v_old9, v_old10, v_old11, v_old12] LOOP
    v_n := (length(v_def) - length(replace(v_def, v_clause, ''))) / length(v_clause);
    IF v_n <> 1 THEN RAISE EXCEPTION 'the cohort authority: a clause occurs % times, expected once: %', v_n, left(v_clause, 80); END IF;
  END LOOP;
  EXECUTE replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(v_def, v_old1, v_new1), v_old2, v_new2), v_old3, v_new3), v_old4, v_new4), v_old5, v_new5), v_old6, v_new6), v_old7, v_new7), v_old8, v_new8), v_old9, v_new9), v_old10, v_new10), v_old11, v_new11), v_old12, v_new12);
  v_def := pg_get_functiondef('public.fn_ca_settle_satellite_cohort(uuid,uuid[])'::regprocedure);
  IF md5(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(v_def, v_new1, v_old1), v_new2, v_old2), v_new3, v_old3), v_new4, v_old4), v_new5, v_old5), v_new6, v_old6), v_new7, v_old7), v_new8, v_old8), v_new9, v_old9), v_new10, v_old10), v_new11, v_old11), v_new12, v_old12)) <> '6e9822dd8367827cf2ba31f2c41b4771' THEN
    RAISE EXCEPTION 'the cohort authority is NOT the pinned chip text plus the documented insertions';
  END IF;
END $do$;

-- ---------------------------------------------------------------------------
-- 8a. THE SINGLE-WINNER RECEIPT READS THE DIAMOND EVIDENCE
-- ---------------------------------------------------------------------------
DO $do$
DECLARE v_def text; v_clause text; v_n integer;
v_old1 constant text := $o$  v_durable_released_count integer;
BEGIN
$o$;
v_new1 constant text := $n$  v_durable_released_count integer;
  v_diamond boolean := false;              -- DIAMOND PHASE 9
BEGIN
$n$;
v_old2 constant text := $o$  -- Target lifecycle state is intentionally absent from replay. A target may
$o$;
v_new2 constant text := $n$  v_diamond := public.fn_poker_diamond_tournament(p_tournament_id);  -- DIAMOND PHASE 9
  -- Target lifecycle state is intentionally absent from replay. A target may
$n$;
v_old3 constant text := $o$  IF v_h.seat_count > 0 AND v_target.id IS NULL THEN
    RAISE EXCEPTION 'satellite % delivered seats into a missing target',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF EXISTS (
$o$;
v_new3 constant text := $n$  IF v_h.seat_count > 0 AND v_target.id IS NULL THEN
    RAISE EXCEPTION 'satellite % delivered seats into a missing target',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  -- DIAMOND PHASE 9: a Diamond seat is proved by its Diamond evidence - the
  -- satellite's prize-bank row out, the target's funded entry row in with
  -- the target's own parts, and the entry custody row named for the
  -- registration - never by a chip transfer leg or a chip fee row, which a
  -- Diamond seat does not write.
  IF v_diamond AND (EXISTS (
    SELECT 1
      FROM public.tournament_satellite_awards a
      LEFT JOIN public.tournament_players target_player
        ON target_player.id = a.registration_id
      LEFT JOIN public.poker_diamond_tournament_ledger lo
        ON lo.idempotency_key = 'poker-tournament-seat-out:' || a.idempotency_key
      LEFT JOIN public.poker_diamond_tournament_ledger li
        ON li.idempotency_key = 'poker-tournament-seat-in:' || a.idempotency_key
      LEFT JOIN public.poker_diamond_custody c
        ON c.id = li.custody_id
     WHERE a.tournament_id = p_tournament_id
       AND a.delivery_kind = 'seat'
       AND (target_player.id IS NULL
         OR target_player.tournament_id IS DISTINCT FROM v_h.target_id
         OR target_player.user_id IS DISTINCT FROM a.user_id
         OR COALESCE(target_player.is_satellite_qualifier, false) IS NOT TRUE
         OR target_player.source_satellite_id IS DISTINCT FROM p_tournament_id
         OR lo.id IS NULL
         OR lo.tournament_id IS DISTINCT FROM p_tournament_id
         OR lo.kind IS DISTINCT FROM 'prize'
         OR lo.user_id IS DISTINCT FROM a.user_id
         OR lo.amount IS DISTINCT FROM v_h.ticket_cost
         OR li.id IS NULL
         OR li.tournament_id IS DISTINCT FROM v_h.target_id
         OR li.kind IS DISTINCT FROM 'entry'
         OR li.user_id IS DISTINCT FROM a.user_id
         OR li.amount IS DISTINCT FROM v_h.ticket_cost
         OR li.prize_part IS DISTINCT FROM v_h.target_buy_in
         OR li.bounty_part IS DISTINCT FROM 0
         OR li.fee_part IS DISTINCT FROM v_h.target_fee
         OR li.registration_id IS DISTINCT FROM a.registration_id
         OR li.wallet_journal_id IS DISTINCT FROM lo.wallet_journal_id
         OR c.id IS NULL
         OR c.user_id IS DISTINCT FROM a.user_id
         OR c.purpose IS DISTINCT FROM 'tournament_entry'
         OR c.target_id IS DISTINCT FROM v_h.target_id
         OR c.entry_key IS DISTINCT FROM 'entry:' || a.registration_id::text)
  ) OR EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = v_h.target_id
       AND tp.source_satellite_id = p_tournament_id
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id
            AND a.delivery_kind = 'seat' AND a.registration_id = tp.id)
  ) OR (SELECT count(*) FROM public.poker_diamond_tournament_ledger lo
         WHERE lo.tournament_id = p_tournament_id
           AND lo.kind = 'prize'
           AND lo.idempotency_key LIKE 'poker-tournament-seat-out:tourney:'
                                       || p_tournament_id::text || ':seat:%')
       <> v_h.seat_count) THEN
    RAISE EXCEPTION 'satellite % has malformed or extra Diamond seat evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF NOT v_diamond AND (EXISTS (
$n$;
v_old4 constant text := $o$       <> v_h.seat_count THEN
    RAISE EXCEPTION 'satellite % has malformed or extra actual-seat evidence',
$o$;
v_new4 constant text := $n$       <> v_h.seat_count) THEN
    RAISE EXCEPTION 'satellite % has malformed or extra actual-seat evidence',
$n$;
v_old5 constant text := $o$  IF v_rows <> (CASE WHEN v_h.target_fee > 0 THEN v_h.seat_count ELSE 0 END)
$o$;
v_new5 constant text := $n$  IF NOT v_diamond AND (v_rows <> (CASE WHEN v_h.target_fee > 0 THEN v_h.seat_count ELSE 0 END)
$n$;
v_old6 constant text := $o$     ) THEN
    RAISE EXCEPTION 'satellite % has malformed target-entry evidence',
$o$;
v_new6 constant text := $n$     )) THEN
    RAISE EXCEPTION 'satellite % has malformed target-entry evidence',
$n$;
v_old7 constant text := $o$  SELECT round(COALESCE(sum(r.rake_amount), 0), 2) INTO v_rake
    FROM public.rake_records r
   WHERE r.tournament_id = p_tournament_id AND r.is_tournament;
$o$;
v_new7 constant text := $n$  SELECT round(COALESCE(sum(r.rake_amount), 0), 2) INTO v_rake
    FROM public.rake_records r
   WHERE r.tournament_id = p_tournament_id AND r.is_tournament;
  IF v_diamond THEN
    -- DIAMOND PHASE 9: a Diamond satellite's fee is its fee bank, settled to
    -- the house, not a rake_records sum.
    SELECT e.fee_balance + e.fee_out INTO v_rake
      FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;
  END IF;
$n$;
BEGIN
  v_def := pg_get_functiondef('public.fn_ca_satellite_settlement_receipt(uuid,uuid)'::regprocedure);
  IF md5(v_def) <> '5288fd960eac2c85d955b8c8150f9f93' THEN
    RAISE EXCEPTION 'fn_ca_satellite_settlement_receipt is not the pinned text (md5 %)', md5(v_def);
  END IF;
  FOREACH v_clause IN ARRAY ARRAY[v_old1, v_old2, v_old3, v_old4, v_old5, v_old6, v_old7] LOOP
    v_n := (length(v_def) - length(replace(v_def, v_clause, ''))) / length(v_clause);
    IF v_n <> 1 THEN RAISE EXCEPTION 'the single-winner receipt: a clause occurs % times, expected once: %', v_n, left(v_clause, 80); END IF;
  END LOOP;
  EXECUTE replace(replace(replace(replace(replace(replace(replace(v_def, v_old1, v_new1), v_old2, v_new2), v_old3, v_new3), v_old4, v_new4), v_old5, v_new5), v_old6, v_new6), v_old7, v_new7);
  v_def := pg_get_functiondef('public.fn_ca_satellite_settlement_receipt(uuid,uuid)'::regprocedure);
  IF md5(replace(replace(replace(replace(replace(replace(replace(v_def, v_new1, v_old1), v_new2, v_old2), v_new3, v_old3), v_new4, v_old4), v_new5, v_old5), v_new6, v_old6), v_new7, v_old7)) <> '5288fd960eac2c85d955b8c8150f9f93' THEN
    RAISE EXCEPTION 'the single-winner receipt is NOT the pinned chip text plus the documented insertions';
  END IF;
END $do$;

-- ---------------------------------------------------------------------------
-- 8b. THE COHORT RECEIPT READS THE DIAMOND EVIDENCE
-- ---------------------------------------------------------------------------
DO $do$
DECLARE v_def text; v_clause text; v_n integer;
v_old1 constant text := $o$  v_durable_released_count integer;
BEGIN
$o$;
v_new1 constant text := $n$  v_durable_released_count integer;
  v_diamond boolean := false;              -- DIAMOND PHASE 9
BEGIN
$n$;
v_old2 constant text := $o$  -- Target lifecycle state is intentionally absent from replay. A target may
$o$;
v_new2 constant text := $n$  v_diamond := public.fn_poker_diamond_tournament(p_tournament_id);  -- DIAMOND PHASE 9
  -- Target lifecycle state is intentionally absent from replay. A target may
$n$;
v_old3 constant text := $o$  IF v_h.seat_count > 0 AND v_target.id IS NULL THEN
    RAISE EXCEPTION 'satellite % delivered seats into a missing target',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF EXISTS (
$o$;
v_new3 constant text := $n$  IF v_h.seat_count > 0 AND v_target.id IS NULL THEN
    RAISE EXCEPTION 'satellite % delivered seats into a missing target',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  -- DIAMOND PHASE 9: a Diamond seat is proved by its Diamond evidence - the
  -- satellite's prize-bank row out, the target's funded entry row in with
  -- the target's own parts, and the entry custody row named for the
  -- registration - never by a chip transfer leg or a chip fee row, which a
  -- Diamond seat does not write.
  IF v_diamond AND (EXISTS (
    SELECT 1
      FROM public.tournament_satellite_awards a
      LEFT JOIN public.tournament_players target_player
        ON target_player.id = a.registration_id
      LEFT JOIN public.poker_diamond_tournament_ledger lo
        ON lo.idempotency_key = 'poker-tournament-seat-out:' || a.idempotency_key
      LEFT JOIN public.poker_diamond_tournament_ledger li
        ON li.idempotency_key = 'poker-tournament-seat-in:' || a.idempotency_key
      LEFT JOIN public.poker_diamond_custody c
        ON c.id = li.custody_id
     WHERE a.tournament_id = p_tournament_id
       AND a.delivery_kind = 'seat'
       AND (target_player.id IS NULL
         OR target_player.tournament_id IS DISTINCT FROM v_h.target_id
         OR target_player.user_id IS DISTINCT FROM a.user_id
         OR COALESCE(target_player.is_satellite_qualifier, false) IS NOT TRUE
         OR target_player.source_satellite_id IS DISTINCT FROM p_tournament_id
         OR lo.id IS NULL
         OR lo.tournament_id IS DISTINCT FROM p_tournament_id
         OR lo.kind IS DISTINCT FROM 'prize'
         OR lo.user_id IS DISTINCT FROM a.user_id
         OR lo.amount IS DISTINCT FROM v_h.ticket_cost
         OR li.id IS NULL
         OR li.tournament_id IS DISTINCT FROM v_h.target_id
         OR li.kind IS DISTINCT FROM 'entry'
         OR li.user_id IS DISTINCT FROM a.user_id
         OR li.amount IS DISTINCT FROM v_h.ticket_cost
         OR li.prize_part IS DISTINCT FROM v_h.target_buy_in
         OR li.bounty_part IS DISTINCT FROM 0
         OR li.fee_part IS DISTINCT FROM v_h.target_fee
         OR li.registration_id IS DISTINCT FROM a.registration_id
         OR li.wallet_journal_id IS DISTINCT FROM lo.wallet_journal_id
         OR c.id IS NULL
         OR c.user_id IS DISTINCT FROM a.user_id
         OR c.purpose IS DISTINCT FROM 'tournament_entry'
         OR c.target_id IS DISTINCT FROM v_h.target_id
         OR c.entry_key IS DISTINCT FROM 'entry:' || a.registration_id::text)
  ) OR EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = v_h.target_id
       AND tp.source_satellite_id = p_tournament_id
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id
            AND a.delivery_kind = 'seat' AND a.registration_id = tp.id)
  ) OR (SELECT count(*) FROM public.poker_diamond_tournament_ledger lo
         WHERE lo.tournament_id = p_tournament_id
           AND lo.kind = 'prize'
           AND lo.idempotency_key LIKE 'poker-tournament-seat-out:tourney:'
                                       || p_tournament_id::text || ':seat:%')
       <> v_h.seat_count) THEN
    RAISE EXCEPTION 'satellite % has malformed or extra Diamond seat evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF NOT v_diamond AND (EXISTS (
$n$;
v_old4 constant text := $o$       <> v_h.seat_count THEN
    RAISE EXCEPTION 'satellite % has malformed or extra actual-seat evidence',
$o$;
v_new4 constant text := $n$       <> v_h.seat_count) THEN
    RAISE EXCEPTION 'satellite % has malformed or extra actual-seat evidence',
$n$;
v_old5 constant text := $o$  IF v_rows <> (CASE WHEN v_h.target_fee > 0 THEN v_h.seat_count ELSE 0 END)
$o$;
v_new5 constant text := $n$  IF NOT v_diamond AND (v_rows <> (CASE WHEN v_h.target_fee > 0 THEN v_h.seat_count ELSE 0 END)
$n$;
v_old6 constant text := $o$     ) THEN
    RAISE EXCEPTION 'satellite % has malformed target-entry evidence',
$o$;
v_new6 constant text := $n$     )) THEN
    RAISE EXCEPTION 'satellite % has malformed target-entry evidence',
$n$;
v_old7 constant text := $o$  SELECT round(COALESCE(sum(r.rake_amount), 0), 2) INTO v_rake
    FROM public.rake_records r
   WHERE r.tournament_id = p_tournament_id AND r.is_tournament;
$o$;
v_new7 constant text := $n$  SELECT round(COALESCE(sum(r.rake_amount), 0), 2) INTO v_rake
    FROM public.rake_records r
   WHERE r.tournament_id = p_tournament_id AND r.is_tournament;
  IF v_diamond THEN
    -- DIAMOND PHASE 9: a Diamond satellite's fee is its fee bank, settled to
    -- the house, not a rake_records sum.
    SELECT e.fee_balance + e.fee_out INTO v_rake
      FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;
  END IF;
$n$;
BEGIN
  v_def := pg_get_functiondef('public.fn_ca_satellite_cohort_receipt(uuid,uuid[])'::regprocedure);
  IF md5(v_def) <> '3207bb2d0d632688e10889bb7ef8ed08' THEN
    RAISE EXCEPTION 'fn_ca_satellite_cohort_receipt is not the pinned text (md5 %)', md5(v_def);
  END IF;
  FOREACH v_clause IN ARRAY ARRAY[v_old1, v_old2, v_old3, v_old4, v_old5, v_old6, v_old7] LOOP
    v_n := (length(v_def) - length(replace(v_def, v_clause, ''))) / length(v_clause);
    IF v_n <> 1 THEN RAISE EXCEPTION 'the cohort receipt: a clause occurs % times, expected once: %', v_n, left(v_clause, 80); END IF;
  END LOOP;
  EXECUTE replace(replace(replace(replace(replace(replace(replace(v_def, v_old1, v_new1), v_old2, v_new2), v_old3, v_new3), v_old4, v_new4), v_old5, v_new5), v_old6, v_new6), v_old7, v_new7);
  v_def := pg_get_functiondef('public.fn_ca_satellite_cohort_receipt(uuid,uuid[])'::regprocedure);
  IF md5(replace(replace(replace(replace(replace(replace(replace(v_def, v_new1, v_old1), v_new2, v_old2), v_new3, v_old3), v_new4, v_old4), v_new5, v_old5), v_new6, v_old6), v_new7, v_old7)) <> '3207bb2d0d632688e10889bb7ef8ed08' THEN
    RAISE EXCEPTION 'the cohort receipt is NOT the pinned chip text plus the documented insertions';
  END IF;
END $do$;

-- ---------------------------------------------------------------------------
-- 9. A DIAMOND SEAT'S REFUND ENTITLEMENT IS ITS CUSTODY ROW
-- ---------------------------------------------------------------------------
DO $do$
DECLARE v_def text; v_clause text; v_n integer;
v_old1 constant text := $o$  IF NEW.delivery_kind IS DISTINCT FROM 'seat' THEN
    RETURN NULL;
  END IF;
$o$;
v_new1 constant text := $n$  IF NEW.delivery_kind IS DISTINCT FROM 'seat' THEN
    RETURN NULL;
  END IF;
  -- DIAMOND PHASE 9: a Diamond seat's refund entitlement is its target entry
  -- custody row - the Diamond refund authority returns it whole, as it
  -- returns a paid entry - so no chip entitlement is captured for it. The
  -- seat must carry its exact custody-to-custody evidence instead.
  IF public.fn_poker_diamond_tournament(NEW.tournament_id) THEN
    IF NEW.registration_id IS NULL OR NOT EXISTS (
         SELECT 1
           FROM public.poker_diamond_tournament_ledger li
           JOIN public.poker_diamond_custody c ON c.id = li.custody_id
          WHERE li.idempotency_key = 'poker-tournament-seat-in:' || NEW.idempotency_key
            AND li.kind = 'entry' AND li.user_id = NEW.user_id
            AND li.amount = NEW.amount AND li.registration_id = NEW.registration_id
            AND c.purpose = 'tournament_entry' AND c.user_id = NEW.user_id
            AND c.entry_key = 'entry:' || NEW.registration_id::text)
       OR NOT EXISTS (
         SELECT 1
           FROM public.poker_diamond_tournament_ledger lo
          WHERE lo.idempotency_key = 'poker-tournament-seat-out:' || NEW.idempotency_key
            AND lo.tournament_id = NEW.tournament_id AND lo.kind = 'prize'
            AND lo.user_id = NEW.user_id AND lo.amount = NEW.amount) THEN
      RAISE EXCEPTION
        'Diamond satellite seat award has no exact custody-to-custody evidence'
        USING ERRCODE = 'P0404';
    END IF;
    RETURN NULL;
  END IF;
$n$;
BEGIN
  v_def := pg_get_functiondef('public.fn_ca_capture_satellite_seat_entitlement()'::regprocedure);
  IF md5(v_def) <> '43bd57fdb0a21738e5b1e5d833c94a57' THEN
    RAISE EXCEPTION 'fn_ca_capture_satellite_seat_entitlement is not the pinned text (md5 %)', md5(v_def);
  END IF;
  FOREACH v_clause IN ARRAY ARRAY[v_old1] LOOP
    v_n := (length(v_def) - length(replace(v_def, v_clause, ''))) / length(v_clause);
    IF v_n <> 1 THEN RAISE EXCEPTION 'the award capture trigger: a clause occurs % times, expected once: %', v_n, left(v_clause, 80); END IF;
  END LOOP;
  EXECUTE replace(v_def, v_old1, v_new1);
  v_def := pg_get_functiondef('public.fn_ca_capture_satellite_seat_entitlement()'::regprocedure);
  IF md5(replace(v_def, v_new1, v_old1)) <> '43bd57fdb0a21738e5b1e5d833c94a57' THEN
    RAISE EXCEPTION 'the award capture trigger is NOT the pinned chip text plus the documented insertions';
  END IF;
END $do$;

-- ---------------------------------------------------------------------------
-- 10a. THE CHIP-RAIL SEAT DOOR REFUSES A DIAMOND SATELLITE
-- ---------------------------------------------------------------------------
DO $do$
DECLARE v_def text; v_clause text; v_n integer;
v_old1 constant text := $o$BEGIN
  PERFORM public.fn_ca_lock_mtt_admission_contract();
  PERFORM public.fn_ca_lock_settlement_lane_global();
  SELECT id, name, club_id, status, buy_in_amount, buy_in_fee,
$o$;
v_new1 constant text := $n$BEGIN
  -- DIAMOND PHASE 9: this door seats on chip rails (a chip_ledger transfer
  -- and a chip fee row). A Diamond satellite or target is never seated here.
  IF public.fn_poker_diamond_tournament(p_satellite_id)
     OR public.fn_poker_diamond_tournament(p_target_id) THEN
    RAISE EXCEPTION 'diamond_satellite_is_never_settled_on_chip_rails: satellite % target %',
      p_satellite_id, p_target_id USING ERRCODE = '55000';
  END IF;
  PERFORM public.fn_ca_lock_mtt_admission_contract();
  PERFORM public.fn_ca_lock_settlement_lane_global();
  SELECT id, name, club_id, status, buy_in_amount, buy_in_fee,
$n$;
BEGIN
  v_def := pg_get_functiondef('public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)'::regprocedure);
  IF md5(v_def) <> '92ab8b6d14cecd75bb945bbe2e6bc12b' THEN
    RAISE EXCEPTION 'fn_award_satellite_seat is not the pinned text (md5 %)', md5(v_def);
  END IF;
  FOREACH v_clause IN ARRAY ARRAY[v_old1] LOOP
    v_n := (length(v_def) - length(replace(v_def, v_clause, ''))) / length(v_clause);
    IF v_n <> 1 THEN RAISE EXCEPTION 'the chip-rail seat door: a clause occurs % times, expected once: %', v_n, left(v_clause, 80); END IF;
  END LOOP;
  EXECUTE replace(v_def, v_old1, v_new1);
  v_def := pg_get_functiondef('public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)'::regprocedure);
  IF md5(replace(v_def, v_new1, v_old1)) <> '92ab8b6d14cecd75bb945bbe2e6bc12b' THEN
    RAISE EXCEPTION 'the chip-rail seat door is NOT the pinned chip text plus the documented insertions';
  END IF;
END $do$;

-- ---------------------------------------------------------------------------
-- 10b. THE CHIP-RAIL ENTITLEMENT FINISH REFUSES A DIAMOND SATELLITE
-- ---------------------------------------------------------------------------
DO $do$
DECLARE v_def text; v_clause text; v_n integer;
v_old1 constant text := $o$BEGIN
  v_plan:=public.fn_materialize_satellite_entitlements_locked(p_tournament_id);
$o$;
v_new1 constant text := $n$BEGIN
  -- DIAMOND PHASE 9: this finish delivers tickets on chip rails. A Diamond
  -- satellite, or a satellite into a Diamond target, settles only through
  -- its atomic authority (fn_settle_satellite_tournament or
  -- fn_settle_satellite_qualifiers).
  IF public.fn_poker_diamond_tournament(p_tournament_id)
     OR public.fn_poker_diamond_tournament((SELECT COALESCE(t.satellite_target_id, t.satellite_target)
                                              FROM public.tournaments t WHERE t.id = p_tournament_id)) THEN
    RAISE EXCEPTION 'diamond_satellite_is_never_settled_on_chip_rails: satellite %',
      p_tournament_id USING ERRCODE = '55000';
  END IF;
  v_plan:=public.fn_materialize_satellite_entitlements_locked(p_tournament_id);
$n$;
BEGIN
  v_def := pg_get_functiondef('public.fn_settle_satellite_finish_atomic_before_maintenance_gate(uuid,text)'::regprocedure);
  IF md5(v_def) <> '399bdb8716ec24166880d3df7e017280' THEN
    RAISE EXCEPTION 'fn_settle_satellite_finish_atomic_before_maintenance_gate is not the pinned text (md5 %)', md5(v_def);
  END IF;
  FOREACH v_clause IN ARRAY ARRAY[v_old1] LOOP
    v_n := (length(v_def) - length(replace(v_def, v_clause, ''))) / length(v_clause);
    IF v_n <> 1 THEN RAISE EXCEPTION 'the entitlement finish: a clause occurs % times, expected once: %', v_n, left(v_clause, 80); END IF;
  END LOOP;
  EXECUTE replace(v_def, v_old1, v_new1);
  v_def := pg_get_functiondef('public.fn_settle_satellite_finish_atomic_before_maintenance_gate(uuid,text)'::regprocedure);
  IF md5(replace(v_def, v_new1, v_old1)) <> '399bdb8716ec24166880d3df7e017280' THEN
    RAISE EXCEPTION 'the entitlement finish is NOT the pinned chip text plus the documented insertions';
  END IF;
END $do$;

-- ---------------------------------------------------------------------------
-- 11. THE SEAT DOOR IS WATCHED, AND DECLARED
-- ---------------------------------------------------------------------------
DO $do$
DECLARE v_def text; v_clause text; v_n integer;
v_old1 constant text := $o$      -- And the list itself.
      'fn_ca_guard_watchlist'
$o$;
v_new1 constant text := $n$      -- The Diamond satellite seat door (Phase 9, 2026-09-21): a satellite
      -- seat moved custody to custody, out of one prize bank into an entry.
      'fn_poker_diamond_tournament_seat_transfer',
      -- And the list itself.
      'fn_ca_guard_watchlist'
$n$;
BEGIN
  v_def := pg_get_functiondef('public.fn_ca_guard_watchlist()'::regprocedure);
  IF md5(v_def) <> '92ee208d0887728444bda396d0b4d442' THEN
    RAISE EXCEPTION 'fn_ca_guard_watchlist is not the pinned text (md5 %)', md5(v_def);
  END IF;
  FOREACH v_clause IN ARRAY ARRAY[v_old1] LOOP
    v_n := (length(v_def) - length(replace(v_def, v_clause, ''))) / length(v_clause);
    IF v_n <> 1 THEN RAISE EXCEPTION 'the guard watchlist: a clause occurs % times, expected once: %', v_n, left(v_clause, 80); END IF;
  END LOOP;
  EXECUTE replace(v_def, v_old1, v_new1);
  v_def := pg_get_functiondef('public.fn_ca_guard_watchlist()'::regprocedure);
  IF md5(replace(v_def, v_new1, v_old1)) <> '92ee208d0887728444bda396d0b4d442' THEN
    RAISE EXCEPTION 'the guard watchlist is NOT the pinned chip text plus the documented insertions';
  END IF;
END $do$;

DO $m$
BEGIN
  -- The asserted substitution above proved the list gained exactly this name.
  IF NOT ('fn_poker_diamond_tournament_seat_transfer' = ANY (public.fn_ca_guard_watchlist())) THEN
    RAISE EXCEPTION 'the seat door is not on the guard watchlist';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_guard_defs WHERE proname = 'fn_poker_diamond_tournament_seat_transfer') THEN
    RAISE EXCEPTION 'the seat door already has a baseline; this migration records its first';
  END IF;
  PERFORM public.fn_ca_declare_guard_redefinition('fn_poker_diamond_tournament_seat_transfer',
    'migration a_diamond_satellite_seat_is_a_whole_ticket');
  PERFORM public.fn_ca_declare_guard_redefinition('fn_ca_guard_watchlist',
    'migration a_diamond_satellite_seat_is_a_whole_ticket');
END $m$;

-- ---------------------------------------------------------------------------
-- 12. THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE r record; v_bad text; v_txt text; v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)',
                                'fn_ca_settle_satellite_cohort(uuid,uuid[])'] LOOP
    v_txt := pg_get_functiondef(('public.'||v_name)::regprocedure);
    IF position('v_diamond := public.fn_ca_assert_satellite_asset(p_tournament_id, v_target_id);' IN v_txt) = 0
       OR position('PERFORM public.fn_poker_diamond_tournament_open_shadow(p_tournament_id);' IN v_txt) = 0
       OR position('diamond_satellite_does_not_divide_into_whole_diamonds' IN v_txt) = 0
       OR position('diamond_satellite_winner_at_the_table_cap' IN v_txt) = 0
       OR position('v_diamond_seat := public.fn_poker_diamond_tournament_seat_transfer(' IN v_txt) = 0
       OR position('IF v_seat_count > 0 AND NOT v_diamond AND (' IN v_txt) = 0
       OR position('INSERT INTO public.chip_ledger' IN v_txt) = 0
       OR position('''fn_award_satellite_seat''' IN v_txt) = 0 THEN
      RAISE EXCEPTION '% does not deliver a Diamond seat beside its chip seat as this migration states', v_name;
    END IF;
  END LOOP;
  FOREACH v_name IN ARRAY ARRAY['fn_ca_satellite_settlement_receipt(uuid,uuid)',
                                'fn_ca_satellite_cohort_receipt(uuid,uuid[])'] LOOP
    v_txt := pg_get_functiondef(('public.'||v_name)::regprocedure);
    IF position('''poker-tournament-seat-out:'' || a.idempotency_key' IN v_txt) = 0
       OR position('''poker-tournament-seat-in:'' || a.idempotency_key' IN v_txt) = 0
       OR position('FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;' IN v_txt) = 0
       OR position('IF NOT v_diamond AND (EXISTS (' IN v_txt) = 0 THEN
      RAISE EXCEPTION '% does not read the Diamond seat evidence as this migration states', v_name;
    END IF;
  END LOOP;
  v_txt := pg_get_functiondef('public.fn_ca_capture_satellite_seat_entitlement()'::regprocedure);
  IF position('''poker-tournament-seat-in:'' || NEW.idempotency_key' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the award capture trigger does not know a Diamond seat';
  END IF;
  v_txt := pg_get_functiondef('public.fn_ca_guard_new_satellite_target()'::regprocedure);
  IF position('SATELLITE_DIAMOND_SOURCE_CANNOT_FEED_A_CHIP_TARGET' IN v_txt) = 0
     OR position('SATELLITE_CHIP_SOURCE_CANNOT_FEED_A_DIAMOND_TARGET' IN v_txt) = 0
     OR position('public.fn_ca_diamond_satellite_target_accepts_new_feeder(v_target)' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the creation guard does not keep the assets apart';
  END IF;
  v_txt := pg_get_functiondef('public.fn_poker_diamond_create_tournament(jsonb)'::regprocedure);
  IF position('IF v_type NOT IN (''mtt'',''sng'',''bounty'',''progressive_bounty'',''mystery_bounty'',''satellite'') THEN' IN v_txt) = 0
     OR position('diamond_satellite_target_must_be_a_diamond_tournament' IN v_txt) = 0
     OR position('diamond_satellite_seat_guarantee_not_open' IN v_txt) = 0
     OR position('diamond_tournament_format_not_open' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the creation door does not admit a Diamond satellite as this migration states';
  END IF;
  v_txt := pg_get_functiondef('public.fn_tournament_management_readiness_for_row(jsonb)'::regprocedure);
  IF position('OR (v_satellite_seats = 0 AND v_target IS NOT NULL AND v_row_union IS NULL' IN v_txt) = 0
     OR position('OR (v_satellite_seats > 0 AND v_target IS NOT NULL AND v_target_found)' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the readiness contract does not take a Diamond satellite promising no seat';
  END IF;
  FOREACH v_name IN ARRAY ARRAY['fn_award_satellite_seat(uuid,uuid,uuid,text,integer)',
                                'fn_settle_satellite_finish_atomic_before_maintenance_gate(uuid,text)'] LOOP
    IF position('diamond_satellite_is_never_settled_on_chip_rails'
                IN pg_get_functiondef(('public.'||v_name)::regprocedure)) = 0 THEN
      RAISE EXCEPTION '% does not refuse a Diamond satellite', v_name;
    END IF;
  END LOOP;
  -- The new functions are internal steps: no client role reaches them.
  FOR r IN SELECT p.oid, p.proname FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
            AND p.proname IN ('fn_poker_diamond_tournament_seat_transfer','fn_ca_assert_satellite_asset',
                              'fn_ca_diamond_satellite_target_accepts_new_feeder')
  LOOP
    IF has_function_privilege('anon', r.oid, 'EXECUTE') OR has_function_privilege('authenticated', r.oid, 'EXECUTE')
       OR has_function_privilege('service_role', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is callable by a client role; it is an internal step', r.proname;
    END IF;
  END LOOP;
  FOR r IN SELECT p.oid, p.proname FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
            AND p.proname IN ('fn_poker_diamond_create_tournament','fn_ca_guard_new_satellite_target',
                              'fn_settle_satellite_tournament_pre_money_path_gate','fn_ca_settle_satellite_cohort',
                              'fn_ca_satellite_settlement_receipt','fn_ca_satellite_cohort_receipt',
                              'fn_ca_capture_satellite_seat_entitlement','fn_award_satellite_seat',
                              'fn_settle_satellite_finish_atomic_before_maintenance_gate',
                              'fn_tournament_management_readiness_for_row')
  LOOP
    IF has_function_privilege('anon', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is reachable without an account', r.proname;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM public.ca_money_rpc_registry
                  WHERE proname='fn_poker_diamond_tournament_seat_transfer' AND status='approved') THEN
    RAISE EXCEPTION 'the seat door is not registered';
  END IF;
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
  RAISE NOTICE 'a Diamond satellite seat is a whole ticket: the seat moves custody to custody, the remainder is whole, the assets never cross, nothing opened';
END $m$;
