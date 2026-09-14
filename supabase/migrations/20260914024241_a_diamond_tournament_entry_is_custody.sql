-- ============================================================================
-- A DIAMOND TOURNAMENT ENTRY IS CUSTODY
-- ============================================================================
--
-- Phase 8 of the Diamond Arena programme: tournament, SNG and heads-up funding.
-- Until this migration a Diamond tournament could not take an entry at all:
-- the registration core debits club_members.chip_balance, which the arena
-- structure guard holds at zero, the rebuy core debits the same wallet, and
-- fn_poker_diamond_reserve knew how to price a tournament_entry custody row
-- that nothing had ever written.
--
-- THE SHAPE. A Diamond entry is a custody row, exactly as a Diamond cash seat
-- is: fn_poker_diamond_reserve moves settled Diamonds out of the wallet into
-- poker_diamond_custody (purpose 'tournament_entry', one open row per player
-- per event, ACTIVE from the moment it is paid, as the seat guards require), a rebuy, re-entry or add-on adds to that same row through the
-- same lot and journal mechanics fn_poker_diamond_top_up uses for a seat, and
-- a refund releases it back through fn_poker_diamond_release. The custody rows
-- ARE the event's escrow: the sum of them is what the event holds, and the
-- Diamond trial balance already counts every custody row once, so nothing new
-- has to be taught to the supply meter. What is new is the LEDGER that says
-- how that custody decomposes - prize, bounty and fee parts per charge, and
-- every prize, fee and refund that leaves - so the banks the chip estate keeps
-- in tournament_escrow can be answered for a Diamond event in the same shape
-- (fn_poker_diamond_tournament_escrow), the payer can be capped by the bank
-- (fn_ca_escrow_can_pay) and a refund can prove its parts.
--
-- WHAT DOES NOT CHANGE. The roster, the seats, the blind clock, the balancing,
-- the obligations and the terminal receipt are the chip estate's, untouched.
-- Tournament playing stacks are nonredeemable units in tournament_players.chips
-- and table_seats.stack and never meet custody; a Diamond entry in play cannot
-- be released to a wallet by anyone, because fn_poker_diamond_release now
-- refuses a tournament_entry row unless the refund authority in this migration
-- has opened it for that one row in that one transaction, and the refund
-- authority only opens it for a roster row that is being unregistered before
-- the event starts or for an event that is being cancelled.
--
-- THE CHIP PATH IS PROVED UNCHANGED, not asserted. Every chip function edited
-- here is edited in place: its live text is read, its md5 pinned, exactly one
-- clause replaced, and the result re-created. The clause added is behind
-- fn_ca_tournament_unit_cents(tournament) = 100, which is 1 for every chip
-- event, so the chip branch is byte-for-byte the text that was there.
--
-- WHAT IS DELIBERATELY NOT HERE. Prize, fee and bounty settlement out of the
-- custody rows is the next migration (the payer). Bounties, PKO, mystery
-- bounties, satellites, spins, guarantees and house-funded horse entries are
-- Phase 9 and the creation door refuses them. The door ships with
-- ca_arena_settings.tournaments_enabled still false; this migration opens
-- nothing, and its final assertion says so.
--
-- Applied once to kuklfnapbkmacvwxktbh. Never reapply.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Nothing this migration touches exists yet in the running estate.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE v_arena uuid; v_n integer;
BEGIN
  SELECT c.id INTO v_arena FROM public.clubs c
   WHERE c.asset='diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL;
  IF v_arena IS NULL THEN
    RAISE EXCEPTION 'there is no Diamond arena club to build tournaments for';
  END IF;
  SELECT count(*) INTO v_n FROM public.tournaments WHERE club_id=v_arena;
  IF v_n<>0 THEN RAISE EXCEPTION 'the Diamond arena already has % tournament(s); this migration expects none', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.poker_diamond_custody WHERE purpose='tournament_entry';
  IF v_n<>0 THEN RAISE EXCEPTION 'custody already holds % tournament_entry row(s); this migration expects none', v_n; END IF;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled) THEN
    RAISE EXCEPTION 'tournaments_enabled is already on somewhere; this migration expects it closed';
  END IF;
END $do$;

-- A function that can move money is registered before it exists (the event
-- trigger fn_ca_money_rpc_registry_guard refuses it otherwise).
INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_poker_diamond_tournament_custody_add', 'approved',
   'Diamond Phase 8. Reserves more settled Diamonds into an existing tournament_entry custody row for a rebuy, re-entry or add-on: lots held, arena_deposit journaled, profiles.diamonds debited, custody raised, movement recorded. Owner-only; called by fn_poker_diamond_tournament_charge.'),
  ('fn_poker_diamond_tournament_charge', 'approved',
   'Diamond Phase 8. The Diamond branch of the registration and rebuy cores: reserves the entry into custody through fn_poker_diamond_reserve or adds to it, and writes the poker_diamond_tournament_ledger row that names the prize, bounty and fee parts. Owner-only.'),
  ('fn_poker_diamond_tournament_refund', 'approved',
   'Diamond Phase 8. Returns an entry from custody to the wallet through fn_poker_diamond_release, which it alone may open for a tournament_entry row, and records the refund by bank. Owner-only; called by the Diamond unregistration and cancellation authorities.'),
  ('fn_poker_diamond_tournament_unregister', 'approved',
   'Diamond Phase 8. Withdraws a registration before the event starts: refunds through fn_poker_diamond_tournament_refund and removes the roster row exactly as fn_ca_unregister_tournament_player_exact does. Owner-only; routed to by fn_unregister_from_tournament.'),
  ('fn_poker_diamond_tournament_cancel', 'approved',
   'Diamond Phase 8. Cancels a Diamond event: every entry goes home from its own custody row, then the roster, seats, tables and tournament close as atomic_cancel_tournament closes them. Owner-only; routed to by atomic_cancel_tournament.'),
  ('fn_poker_diamond_create_tournament', 'system',
   'Diamond Phase 8. Platform-staff door that writes a Diamond arena tournament row in whole Diamonds. Moves no money.'),
  ('fn_poker_diamond_tournament_escrow', 'system', 'Diamond Phase 8. Reads the prize, bounty and fee banks of a Diamond event from its ledger. Moves no money.'),
  ('fn_poker_diamond_tournament_custody', 'system', 'Diamond Phase 8. Reads what a Diamond event holds in custody. Moves no money.'),
  ('fn_poker_diamond_tournament', 'system', 'Diamond Phase 8. Answers whether a tournament belongs to the Diamond arena. Moves no money.'),
  ('fn_poker_diamond_play_state_columns', 'system', 'Diamond Phase 8. Names the play-state columns a signed-in player may move on a Diamond game row through the estate''s doors. Moves no money.'),
  ('fn_poker_diamond_tournament_cancellation_receipt', 'system', 'Diamond Phase 8. Proves a Diamond event''s stored cancellation receipt against custody, the Diamond ledger and the wallet journal. Reads only.'),
  ('fn_ca_tournament_escrow_chips', 'system', 'Diamond Phase 8. The chip body of fn_ca_tournament_escrow under its own name; the old name routes by asset. Reads only.')
ON CONFLICT (proname) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 1. EVERY PLATFORM USER IS ALREADY A DIAMOND ARENA MEMBER (approved product
--    contract). The roster gate on tournament_players asks club_members, and
--    the arena structure guard refuses every club_members INSERT for a
--    Diamond club, so the two together refused every Diamond entry forever.
--    The scope test now answers the arena the way fn_poker_arena_context
--    already does: membership is the entitlement, not a row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_entry_scope_ok(p_user_id uuid, p_tournament_club uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_union boolean; v_club_union uuid;
BEGIN
  IF p_user_id IS NULL OR p_tournament_club IS NULL THEN
    RETURN false;
  END IF;
  -- The Diamond arena has no membership rows by design: every account with a
  -- profile is a member. A retired or missing profile is not.
  IF EXISTS (SELECT 1 FROM public.clubs c
              WHERE c.id = p_tournament_club AND c.asset = 'diamonds'
                AND c.is_platform IS TRUE AND c.union_id IS NULL) THEN
    RETURN EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_user_id);
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.unions u WHERE u.id = p_tournament_club) INTO v_is_union;
  IF v_is_union THEN
    -- Union-scoped tournament: member of any club in that union.
    RETURN EXISTS (
      SELECT 1 FROM public.club_members cm JOIN public.clubs c ON c.id = cm.club_id
       WHERE cm.user_id = p_user_id
         AND (c.union_id = p_tournament_club
              OR EXISTS (SELECT 1 FROM public.union_clubs uc
                          WHERE uc.club_id = c.id AND uc.union_id = p_tournament_club)));
  END IF;
  SELECT c.union_id INTO v_club_union FROM public.clubs c WHERE c.id = p_tournament_club;
  IF v_club_union IS NOT NULL THEN
    -- Club in a union: member of the club itself or any sibling club in the union.
    RETURN EXISTS (
      SELECT 1 FROM public.club_members cm JOIN public.clubs c ON c.id = cm.club_id
       WHERE cm.user_id = p_user_id
         AND (c.id = p_tournament_club
              OR c.union_id = v_club_union
              OR EXISTS (SELECT 1 FROM public.union_clubs uc
                          WHERE uc.club_id = c.id AND uc.union_id = v_club_union)));
  END IF;
  -- Standalone club: members only.
  RETURN EXISTS (SELECT 1 FROM public.club_members cm
                  WHERE cm.user_id = p_user_id AND cm.club_id = p_tournament_club);
END $function$;

-- ---------------------------------------------------------------------------
-- 2. THE LEDGER. One row per Diamond that enters or leaves an event's custody,
--    with the part of the charge it belongs to. Append-only.
-- ---------------------------------------------------------------------------
CREATE TABLE public.poker_diamond_tournament_ledger (
  id              bigserial PRIMARY KEY,
  tournament_id   uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  arena_id        uuid NOT NULL REFERENCES public.clubs(id) ON DELETE RESTRICT,
  user_id         uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  custody_id      uuid REFERENCES public.poker_diamond_custody(id) ON DELETE RESTRICT,
  kind            text NOT NULL CHECK (kind IN ('entry','rebuy','reentry','addon','prize','bounty','fee','refund')),
  amount          bigint NOT NULL CHECK (amount >= 1 AND amount <= 2147483647),
  prize_part      bigint NOT NULL DEFAULT 0 CHECK (prize_part >= 0),
  bounty_part     bigint NOT NULL DEFAULT 0 CHECK (bounty_part >= 0),
  fee_part        bigint NOT NULL DEFAULT 0 CHECK (fee_part >= 0),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 400),
  wallet_journal_id uuid,
  obligation_id   uuid,
  registration_id uuid,
  request         jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- The three parts are the whole of every row: what came in decomposes, and
  -- what goes out names the bank it left.
  CONSTRAINT poker_diamond_tournament_ledger_parts CHECK (prize_part + bounty_part + fee_part = amount),
  -- Money that enters names the player and the custody row it entered.
  CONSTRAINT poker_diamond_tournament_ledger_inflow CHECK (
    kind NOT IN ('entry','rebuy','reentry','addon') OR (user_id IS NOT NULL AND custody_id IS NOT NULL AND wallet_journal_id IS NOT NULL)),
  -- A prize, bounty or refund reaches a player; a fee reaches the house.
  CONSTRAINT poker_diamond_tournament_ledger_outflow CHECK (
    (kind IN ('prize','bounty','refund') AND user_id IS NOT NULL)
    OR (kind = 'fee' AND user_id IS NULL AND prize_part = 0 AND bounty_part = 0)
    OR kind IN ('entry','rebuy','reentry','addon')),
  CONSTRAINT poker_diamond_tournament_ledger_prize_bank CHECK (kind <> 'prize' OR (bounty_part = 0 AND fee_part = 0)),
  CONSTRAINT poker_diamond_tournament_ledger_bounty_bank CHECK (kind <> 'bounty' OR (prize_part = 0 AND fee_part = 0))
);
CREATE INDEX poker_diamond_tournament_ledger_tournament_idx ON public.poker_diamond_tournament_ledger (tournament_id, kind);
CREATE INDEX poker_diamond_tournament_ledger_user_idx ON public.poker_diamond_tournament_ledger (user_id, tournament_id);
CREATE INDEX poker_diamond_tournament_ledger_custody_idx ON public.poker_diamond_tournament_ledger (custody_id);
CREATE TRIGGER poker_diamond_tournament_ledger_append_only
  BEFORE UPDATE OR DELETE ON public.poker_diamond_tournament_ledger
  FOR EACH ROW EXECUTE FUNCTION public.fn_poker_diamond_append_only();
ALTER TABLE public.poker_diamond_tournament_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.poker_diamond_tournament_ledger FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.poker_diamond_tournament_ledger TO service_role;

-- ---------------------------------------------------------------------------
-- 3. THE BANKS, in the shape fn_ca_tournament_escrow answers for a chip event.
--    A Diamond event has no overlay and no satellite inflow in Phase 8; both
--    columns are kept at zero so a reader of either function reads one shape.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_escrow(p_tournament_id uuid)
 RETURNS TABLE(prize_in numeric, bounty_in numeric, fee_in numeric, overlay_in numeric, satellite_in numeric,
               prize_out numeric, bounty_out numeric, fee_out numeric, refund_out numeric,
               prize_balance numeric, bounty_balance numeric, fee_balance numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH l AS (
    SELECT
      COALESCE(sum(prize_part)  FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS prize_in,
      COALESCE(sum(bounty_part) FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS bounty_in,
      COALESCE(sum(fee_part)    FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS fee_in,
      COALESCE(sum(amount)      FILTER (WHERE kind = 'prize'),0)  AS prize_out,
      COALESCE(sum(amount)      FILTER (WHERE kind = 'bounty'),0) AS bounty_out,
      COALESCE(sum(amount)      FILTER (WHERE kind = 'fee'),0)    AS fee_out,
      COALESCE(sum(amount)      FILTER (WHERE kind = 'refund'),0) AS refund_out,
      COALESCE(sum(prize_part)  FILTER (WHERE kind = 'refund'),0) AS refund_prize,
      COALESCE(sum(bounty_part) FILTER (WHERE kind = 'refund'),0) AS refund_bounty,
      COALESCE(sum(fee_part)    FILTER (WHERE kind = 'refund'),0) AS refund_fee
    FROM public.poker_diamond_tournament_ledger WHERE tournament_id = p_tournament_id)
  SELECT prize_in::numeric, bounty_in::numeric, fee_in::numeric, 0::numeric, 0::numeric,
         prize_out::numeric, bounty_out::numeric, fee_out::numeric, refund_out::numeric,
         (prize_in - prize_out - refund_prize)::numeric,
         (bounty_in - bounty_out - refund_bounty)::numeric,
         (fee_in - fee_out - refund_fee)::numeric
  FROM l;
$function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_escrow(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_tournament_escrow(uuid) TO service_role;

-- What the event's custody rows hold, which the three banks must always sum to.
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_custody(p_tournament_id uuid)
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(sum(balance),0)::bigint FROM public.poker_diamond_custody
   WHERE purpose = 'tournament_entry' AND target_id = p_tournament_id AND state <> 'released';
$function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_custody(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_tournament_custody(uuid) TO service_role;

-- Is this a Diamond arena event? One answer, used by every branch below.
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament(p_tournament_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.tournaments t JOIN public.clubs c ON c.id = t.club_id
     WHERE t.id = p_tournament_id AND c.asset = 'diamonds' AND c.is_platform IS TRUE
       AND c.union_id IS NULL AND t.union_id IS NULL);
$function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_tournament(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. ADDING TO AN ENTRY'S CUSTODY. A rebuy, re-entry or add-on reserves more
--    settled Diamonds into the row the entry already holds - the same lot and
--    journal mechanics as fn_poker_diamond_top_up, minus the seat, because a
--    tournament stack is not custody.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_custody_add(p_custody_id uuid, p_amount numeric, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
 v_c public.poker_diamond_custody%ROWTYPE;
 v_prev public.poker_diamond_movements%ROWTYPE;
 v_request jsonb; v_receipt jsonb;
 v_wallet bigint; v_locked bigint; v_days integer;
 v_left bigint; v_take bigint; v_lot record; v_journal uuid;
BEGIN
 IF p_custody_id IS NULL OR p_request_id IS NULL
    OR p_amount IS NULL OR p_amount NOT BETWEEN 1 AND 2147483647 OR p_amount<>trunc(p_amount) THEN
  RAISE EXCEPTION 'invalid_diamond_tournament_add' USING ERRCODE='22023';
 END IF;
 SELECT user_id INTO v_c.user_id FROM public.poker_diamond_custody WHERE id=p_custody_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'diamond_custody_not_found'; END IF;
 -- Wallet first, exactly as the reserve and the top-up take it.
 SELECT diamonds INTO v_wallet FROM public.profiles WHERE id=v_c.user_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'profile_not_found'; END IF;
 SELECT * INTO v_c FROM public.poker_diamond_custody WHERE id=p_custody_id FOR UPDATE;
 v_request:=jsonb_build_object('user_id',v_c.user_id,'custody_id',p_custody_id,
  'amount',p_amount,'action','tournament_add');
 SELECT * INTO v_prev FROM public.poker_diamond_movements WHERE request_id=p_request_id;
 IF FOUND THEN
  IF v_prev.request IS DISTINCT FROM v_request THEN RAISE EXCEPTION 'idempotency_payload_mismatch'; END IF;
  RETURN v_prev.receipt;
 END IF;
 IF v_c.purpose<>'tournament_entry' OR v_c.state<>'active' THEN
  RAISE EXCEPTION 'diamond_tournament_custody_not_open' USING ERRCODE='55000';
 END IF;
 IF v_c.balance+p_amount>2147483647 THEN
  RAISE EXCEPTION 'diamond_amount_out_of_range' USING ERRCODE='22003';
 END IF;
 SELECT settlement_window_days INTO v_days FROM public.ca_arena_settings WHERE id=1 AND club_id=v_c.arena_id;
 IF v_days IS NULL THEN RAISE EXCEPTION 'diamond_arena_policy_missing'; END IF;
 IF EXISTS(SELECT 1 FROM public.diamond_debts WHERE user_id=v_c.user_id AND settled_at IS NULL AND amount>0) THEN
  RAISE EXCEPTION 'diamond_debt_requires_settlement';
 END IF;
 PERFORM id FROM public.diamond_purchase_lots WHERE user_id=v_c.user_id ORDER BY created_at,id FOR UPDATE;
 SELECT COALESCE(sum(GREATEST(issued-consumed-refunded-arena_reserved,0)),0) INTO v_locked
  FROM public.diamond_purchase_lots WHERE user_id=v_c.user_id
   AND (frozen_at IS NOT NULL OR created_at>now()-make_interval(days=>v_days));
 IF v_wallet IS NULL OR v_wallet-v_locked<p_amount THEN
  RAISE EXCEPTION 'insufficient_settled_diamonds';
 END IF;
 v_left:=p_amount;
 FOR v_lot IN SELECT id,GREATEST(issued-consumed-refunded-arena_reserved,0) available
  FROM public.diamond_purchase_lots WHERE user_id=v_c.user_id AND frozen_at IS NULL
   AND created_at<=now()-make_interval(days=>v_days) ORDER BY created_at,id LOOP
  EXIT WHEN v_left=0;
  v_take:=LEAST(v_left,v_lot.available);
  IF v_take>0 THEN
   UPDATE public.diamond_purchase_lots SET arena_reserved=arena_reserved+v_take WHERE id=v_lot.id;
   UPDATE public.poker_diamond_lot_reservations SET amount=amount+v_take
     WHERE custody_id=v_c.id AND lot_id=v_lot.id AND released_at IS NULL;
   IF NOT FOUND THEN
    BEGIN
     INSERT INTO public.poker_diamond_lot_reservations(custody_id,lot_id,amount) VALUES(v_c.id,v_lot.id,v_take);
    EXCEPTION WHEN unique_violation THEN
     RAISE EXCEPTION 'diamond_tournament_lot_already_released' USING ERRCODE='23514';
    END;
   END IF;
   v_left:=v_left-v_take;
  END IF;
 END LOOP;
 INSERT INTO public.diamond_transactions(user_id,type,transaction_type,amount,balance_after,
  reference_id,description,source,issuance_class,counterparty,metadata)
 VALUES(v_c.user_id,'arena_deposit','arena_deposit',-p_amount::integer,v_wallet-p_amount,
  'poker-tournament-add:'||p_request_id,'Added diamonds to a Poker Arena tournament entry','poker_arena','arena',
  'arena_custody:'||v_c.id,jsonb_build_object('custody_id',v_c.id,'request_id',p_request_id,
   'purpose','tournament_entry','target_id',v_c.target_id,'purchased_reserved',p_amount-v_left)) RETURNING id INTO v_journal;
 UPDATE public.profiles SET diamonds=diamonds-p_amount::integer,updated_at=now() WHERE id=v_c.user_id;
 UPDATE public.poker_diamond_custody SET balance=balance+p_amount WHERE id=v_c.id;
 v_receipt:=jsonb_build_object('success',true,'custody_id',v_c.id,'request_id',p_request_id,
  'amount',p_amount,'custody_balance',v_c.balance+p_amount,
  'available_balance',v_wallet-p_amount,'journal_id',v_journal);
 INSERT INTO public.poker_diamond_movements(request_id,custody_id,user_id,action,amount,
  source_account,destination_account,wallet_journal_id,request,receipt)
 VALUES(p_request_id,v_c.id,v_c.user_id,'reserve',p_amount,'player:'||v_c.user_id,
  'arena_custody:'||v_c.id,v_journal,v_request,v_receipt);
 RETURN v_receipt;
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_custody_add(uuid,numeric,uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. THE CHARGE. Called by the registration core and the rebuy core in place
--    of the club-wallet debit. Owner-only: it is a step inside those
--    authorities, never a door.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_charge(
  p_user_id uuid, p_tournament_id uuid, p_kind text, p_gross numeric,
  p_prize numeric, p_bounty numeric, p_fee numeric, p_registration_id uuid, p_idempotency_key text)
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
  -- Phase 9 owns the bounty pools. Until they are wired, a Diamond charge
  -- carries no bounty part and the creation door writes no bounty event.
  IF p_bounty <> 0 THEN
    RAISE EXCEPTION 'diamond_tournament_bounties_not_open' USING ERRCODE='55000';
  END IF;
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

  -- The banks and the custody must agree after every charge.
  IF (SELECT prize_balance+bounty_balance+fee_balance FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id))
     IS DISTINCT FROM public.fn_poker_diamond_tournament_custody(p_tournament_id)::numeric THEN
    RAISE EXCEPTION 'diamond_tournament_escrow_disagrees_with_custody' USING ERRCODE='P0404';
  END IF;
  RETURN jsonb_build_object('success',true,'custody_id',v_c.id,'ledger_id',v_ledger,
    'journal_id',v_receipt->>'journal_id','amount',p_gross,'request_id',v_request);
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_charge(uuid,uuid,text,numeric,numeric,numeric,numeric,uuid,text) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. THE REFUND. Releases an entry's custody back to the wallet, whole, and
--    records which bank each Diamond came out of. Only an unregistration
--    before the event has started or a cancellation may call it, and it is
--    the only thing that can open fn_poker_diamond_release for an entry.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_refund(
  p_tournament_id uuid, p_user_id uuid, p_kind text, p_source text, p_request_id uuid)
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
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_refund(uuid,uuid,text,text,uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. fn_poker_diamond_release: a tournament entry releases only through the
--    refund authority above. Edited in place; the cash-seat text is untouched.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE v_def text; v_new text; v_old constant text :=
$old$  IF v_c.state = 'released' THEN
    RAISE EXCEPTION 'diamond_custody_already_released';
  END IF;
  IF v_c.state <> 'reserved' THEN
    IF v_c.state <> 'active' OR v_c.purpose <> 'cash_seat'$old$;
v_add constant text :=
$new$  IF v_c.state = 'released' THEN
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
    IF v_c.state <> 'active' OR v_c.purpose <> 'cash_seat'$new$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_poker_diamond_release';
  IF md5(v_def) <> 'e82f01c4813cb20df8cbe6fbd0ac1026' THEN
    RAISE EXCEPTION 'fn_poker_diamond_release is not the text this migration was written against (md5 %)', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'the release clause to guard is not unique in fn_poker_diamond_release';
  END IF;
  v_new := replace(v_def, v_old, v_add);
  EXECUTE v_new;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_poker_diamond_release';
  IF md5(replace(v_def, v_add, v_old)) <> 'e82f01c4813cb20df8cbe6fbd0ac1026' THEN
    RAISE EXCEPTION 'fn_poker_diamond_release is NOT the pinned text plus the one documented guard';
  END IF;
  PERFORM public.fn_ca_declare_guard_redefinition('fn_poker_diamond_release', 'migration a_diamond_tournament_entry_is_custody');
END $do$;

-- ---------------------------------------------------------------------------
-- 7a. THE WALLET GUARD LEARNS THE TWO TOURNAMENT AUTHORITIES. profiles.diamonds
--     is server-managed: fn_guard_profile_privileged_columns admits a change
--     only in a service context or from a named door on its stack. Every
--     Diamond cash move so far ran from the engine (service role); a tournament
--     entry, add-on, withdrawal and staff cancellation are client doors, exactly
--     as the arena deposit and withdraw doors are, and are admitted the same
--     way: by the name of the one internal step that moves the wallet. The
--     two steps are owner-only, reachable only through the registration, rebuy,
--     unregistration and cancellation authorities. The cash rails are untouched.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE v_def text; v_n integer;
v_old constant text := $o$     OR v_stack ~ 'function (public[.])?fn_arena_withdraw[(]'
  THEN$o$;
v_add constant text := $n$     OR v_stack ~ 'function (public[.])?fn_arena_withdraw[(]'
     -- DIAMOND PHASE 8: a tournament entry is custody; its charge and refund
     -- move the wallet from client doors.
     OR v_stack ~ 'function (public[.])?fn_poker_diamond_tournament_charge[(]'
     OR v_stack ~ 'function (public[.])?fn_poker_diamond_tournament_refund[(]'
  THEN$n$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_guard_profile_privileged_columns';
  IF md5(v_def) <> 'ba78b4f92bb51490b46ef6a6657d9c00' THEN
    RAISE EXCEPTION 'fn_guard_profile_privileged_columns is not the text this migration was written against (md5 %)', md5(v_def);
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'the arena-withdraw clause is not unique in the wallet guard (% matches)', v_n; END IF;
  EXECUTE replace(v_def, v_old, v_add);
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_guard_profile_privileged_columns';
  IF md5(replace(v_def, v_add, v_old)) <> 'ba78b4f92bb51490b46ef6a6657d9c00' THEN
    RAISE EXCEPTION 'the wallet guard is NOT the pinned text plus the two documented doors';
  END IF;
  IF 'fn_guard_profile_privileged_columns' = ANY(public.fn_ca_guard_watchlist()) THEN
    PERFORM public.fn_ca_declare_guard_redefinition('fn_guard_profile_privileged_columns', 'migration a_diamond_tournament_entry_is_custody');
  END IF;
END $do$;

-- ---------------------------------------------------------------------------
-- 7a2. THE ARENA STRUCTURE GUARD ADMITS PLAY-STATE COUNTERS. Phase 1 made every
--      write to a Diamond game row platform-operations-only, which is right
--      for the structure (who creates and configures a Diamond game) and wrong
--      for the counters a signed-in player moves through the estate's own
--      doors: an entry raises current_players, prize_pool and total_rake and
--      locks the entry contract; a withdrawal lowers them; an add-on raises
--      the pools; a re-entry raises a table's head count. Those columns, and
--      only those, may change under a player's own session. Everything else
--      on the row - the buy-in, the ladder, the payouts, the format, the
--      status, the club - is still staff-only, byte for byte as before.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_play_state_columns(p_table text)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE p_table
    WHEN 'tournaments' THEN ARRAY['current_players','prize_pool','bounty_pool','total_rake','entry_contract_locked','updated_at']
    WHEN 'tables' THEN ARRAY['current_players','updated_at']
    ELSE ARRAY[]::text[] END;
$function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_play_state_columns(text) FROM PUBLIC, anon, authenticated;

DO $do$
DECLARE v_def text; v_n integer;
v_old constant text := $o$    ELSIF auth.uid() IS NOT NULL AND coalesce(auth.jwt()->>'role','') <> 'service_role'
       AND NOT coalesce(public.fn_is_platform_admin(),false) THEN
      RAISE EXCEPTION 'Diamond Games Require Platform Operations' USING ERRCODE='42501';$o$;
v_add constant text := $n$    ELSIF auth.uid() IS NOT NULL AND coalesce(auth.jwt()->>'role','') <> 'service_role'
       AND NOT coalesce(public.fn_is_platform_admin(),false)
       -- DIAMOND PHASE 8: a player's entry, add-on and withdrawal move the
       -- play-state counters through the estate's doors; the structure is
       -- still platform operations only.
       AND NOT (TG_OP='UPDATE' AND TG_TABLE_NAME IN ('tournaments','tables')
                AND (to_jsonb(NEW) - public.fn_poker_diamond_play_state_columns(TG_TABLE_NAME))
                  = (to_jsonb(OLD) - public.fn_poker_diamond_play_state_columns(TG_TABLE_NAME))) THEN
      RAISE EXCEPTION 'Diamond Games Require Platform Operations' USING ERRCODE='42501';$n$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_poker_guard_arena_structure';
  IF md5(v_def) <> '3f7340188c01e84f8c0a21597bd6fc03' THEN
    RAISE EXCEPTION 'fn_poker_guard_arena_structure is not the text this migration was written against (md5 %)', md5(v_def);
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'the platform-operations clause is not unique in the arena structure guard (% matches)', v_n; END IF;
  EXECUTE replace(v_def, v_old, v_add);
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_poker_guard_arena_structure';
  IF md5(replace(v_def, v_add, v_old)) <> '3f7340188c01e84f8c0a21597bd6fc03' THEN
    RAISE EXCEPTION 'the arena structure guard is NOT the pinned text plus the one documented clause';
  END IF;
  IF 'fn_poker_guard_arena_structure' = ANY(public.fn_ca_guard_watchlist()) THEN
    PERFORM public.fn_ca_declare_guard_redefinition('fn_poker_guard_arena_structure', 'migration a_diamond_tournament_entry_is_custody');
  END IF;
END $do$;

-- ---------------------------------------------------------------------------
-- 7b. THE THREE SEAT GUARDS already know a tournament seat (migration
--     the_diamond_seat_guards_know_a_tournament_seat, P0810-P0815): a Diamond
--     tournament seat is admitted by an ACTIVE tournament_entry custody row for
--     its player and event, never by its stack. The entry door below honours
--     that contract by activating the entry the moment it is paid. What is
--     still cash-scoped by the club asset alone is the hand settler's routing
--     and the accepted-hand commit's Diamond test, patched next.
-- ---------------------------------------------------------------------------

DO $do$
DECLARE v_def text; v_new text; v_n integer;
v_old constant text := $o$  IF EXISTS (SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
             WHERE t.id=p_table_id AND c.asset='diamonds') THEN
    RETURN public.fn_poker_diamond_settle_cash_hand($o$;
v_add constant text := $n$  IF EXISTS (SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
             WHERE t.id=p_table_id AND c.asset='diamonds' AND t.tournament_id IS NULL) THEN
    -- DIAMOND PHASE 8: a Diamond TOURNAMENT hand moves play units on the
    -- roster and the seat, exactly as a chip tournament hand does below.
    RETURN public.fn_poker_diamond_settle_cash_hand($n$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_ca_settle_hand_stacks_absolute';
  IF md5(v_def) <> 'a7f5dbcd26c3a19f16ecc2ebe010b1d1' THEN
    RAISE EXCEPTION 'fn_ca_settle_hand_stacks_absolute is not the text this migration was written against (md5 %)', md5(v_def);
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'the Diamond routing clause is not unique in the stack settler (% matches)', v_n; END IF;
  EXECUTE replace(v_def, v_old, v_add);
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_ca_settle_hand_stacks_absolute';
  IF md5(replace(v_def, v_add, v_old)) <> 'a7f5dbcd26c3a19f16ecc2ebe010b1d1' THEN
    RAISE EXCEPTION 'the stack settler is NOT the pinned chip text plus the one documented clause';
  END IF;
END $do$;

DO $do$
DECLARE v_def text; v_n integer;
v_old constant text := $o$  SELECT EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
    WHERE t.id=p_table_id AND c.asset='diamonds') INTO v_diamond;$o$;
v_add constant text := $n$  -- DIAMOND PHASE 8: the Diamond cash rules below are cash rules; a Diamond
  -- tournament hand carries a tournament rake scope and no add-on lane, and
  -- is judged by the tournament rules exactly as a chip tournament hand is.
  SELECT EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
    WHERE t.id=p_table_id AND c.asset='diamonds' AND t.tournament_id IS NULL) INTO v_diamond;$n$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_ca_commit_hand_settlement';
  IF md5(v_def) <> '2b502cf7a7da40d4045a7f7834fc7167' THEN
    RAISE EXCEPTION 'fn_ca_commit_hand_settlement is not the text this migration was written against (md5 %)', md5(v_def);
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'the Diamond test is not unique in the accepted-hand commit (% matches)', v_n; END IF;
  EXECUTE replace(v_def, v_old, v_add);
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_ca_commit_hand_settlement';
  IF md5(replace(v_def, v_add, v_old)) <> '2b502cf7a7da40d4045a7f7834fc7167' THEN
    RAISE EXCEPTION 'the accepted-hand commit is NOT the pinned chip text plus the one documented clause';
  END IF;
END $do$;

-- ---------------------------------------------------------------------------
-- 8. THE REGISTRATION CORE takes a Diamond entry into custody instead of a
--    club wallet. Edited in place with the md5 pinned; the chip debit is the
--    ELSE of a branch that is false for every chip event.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE v_def text; v_new text; v_n integer;
v_old1 constant text := $o$DECLARE
  v_uid uuid := auth.uid();
  v_t record; v_username text;$o$;
v_new1 constant text := $n$DECLARE
  v_uid uuid := auth.uid();
  v_unit integer := public.fn_ca_tournament_unit_cents(p_tournament_id);  -- DIAMOND PHASE 8
  v_dia jsonb;                                                              -- DIAMOND PHASE 8
  v_t record; v_username text;$n$;
v_old2 constant text := $o$  IF v_split.charge > 0 THEN
    -- CHIP STANDARD 1.2 (2026-09-02): THE REGISTRATION DEBIT NAMES ITS COUNTERPARTY.$o$;
v_new2 constant text := $n$  IF v_split.charge > 0 AND v_unit = 100 THEN
    -- DIAMOND PHASE 8: a Diamond entry is custody, not a club-wallet debit. The
    -- roster row is written first so the custody row can name it; the whole
    -- transaction still rolls back together.
    IF v_split.charge <> trunc(v_split.charge) OR v_split.prize <> trunc(v_split.prize)
       OR v_split.rake <> trunc(v_split.rake) OR v_split.bounty <> trunc(v_split.bounty) THEN
      RAISE EXCEPTION 'diamond_tournament_requires_whole_amounts' USING ERRCODE = '23514';
    END IF;
    v_player_id := gen_random_uuid();
    v_dia := public.fn_poker_diamond_tournament_charge(
      v_uid, p_tournament_id, 'entry', v_split.charge, v_split.prize, v_split.bounty, v_split.rake,
      v_player_id, 'poker-tournament-entry:' || p_tournament_id::text || ':' || v_uid::text || ':' || v_player_id::text);
  ELSIF v_split.charge > 0 THEN
    -- CHIP STANDARD 1.2 (2026-09-02): THE REGISTRATION DEBIT NAMES ITS COUNTERPARTY.$n$;
v_old3 constant text := $o$  BEGIN
    IF v_is_bounty THEN
      INSERT INTO public.tournament_players
        (tournament_id, user_id, username, chips, status, current_bounty, mystery_bounty_value, bounties_collected, bounty_winnings)
      VALUES (p_tournament_id, v_uid, COALESCE(v_username,'Player'), v_start_chips, 'registered', v_head, 0, 0, 0)
      RETURNING id INTO v_player_id;
    ELSE
      INSERT INTO public.tournament_players (tournament_id, user_id, username, chips, status)
      VALUES (p_tournament_id, v_uid, COALESCE(v_username,'Player'), v_start_chips, 'registered')
      RETURNING id INTO v_player_id;
    END IF;$o$;
v_new3 constant text := $n$  BEGIN
    IF v_dia IS NOT NULL THEN
      -- DIAMOND PHASE 8: the roster row carries the id the custody row was named with.
      INSERT INTO public.tournament_players (id, tournament_id, user_id, username, chips, status)
      VALUES (v_player_id, p_tournament_id, v_uid, COALESCE(v_username,'Player'), v_start_chips, 'registered')
      RETURNING id INTO v_player_id;
    ELSIF v_is_bounty THEN
      INSERT INTO public.tournament_players
        (tournament_id, user_id, username, chips, status, current_bounty, mystery_bounty_value, bounties_collected, bounty_winnings)
      VALUES (p_tournament_id, v_uid, COALESCE(v_username,'Player'), v_start_chips, 'registered', v_head, 0, 0, 0)
      RETURNING id INTO v_player_id;
    ELSE
      INSERT INTO public.tournament_players (tournament_id, user_id, username, chips, status)
      VALUES (p_tournament_id, v_uid, COALESCE(v_username,'Player'), v_start_chips, 'registered')
      RETURNING id INTO v_player_id;
    END IF;$n$;
v_old4 constant text := $o$  IF v_split.rake > 0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO public.rake_records$o$;
v_new4 constant text := $n$  IF v_split.rake > 0 AND v_t.club_id IS NOT NULL AND v_unit = 1 THEN
    -- DIAMOND PHASE 8: a Diamond fee stays in custody until the event settles;
    -- rake_records is the chip estate's fee rail.
    INSERT INTO public.rake_records$n$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_register_for_tournament_before_atomic_capacity_20260907';
  IF md5(v_def) <> 'dbf4fba244c6f2ce700d3cb887c6ece6' THEN
    RAISE EXCEPTION 'the registration core is not the text this migration was written against (md5 %)', md5(v_def);
  END IF;
  FOREACH v_new IN ARRAY ARRAY[v_old1, v_old2, v_old3, v_old4] LOOP
    v_n := (length(v_def) - length(replace(v_def, v_new, ''))) / length(v_new);
    IF v_n <> 1 THEN RAISE EXCEPTION 'a registration-core clause is not unique (% matches): %', v_n, left(v_new, 60); END IF;
  END LOOP;
  v_new := replace(replace(replace(replace(v_def, v_old1, v_new1), v_old2, v_new2), v_old3, v_new3), v_old4, v_new4);
  EXECUTE v_new;
  -- THE CHIP TEXT IS STILL THERE, BYTE FOR BYTE: undoing the four insertions
  -- on the live definition gives back exactly the text that was pinned.
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_register_for_tournament_before_atomic_capacity_20260907';
  IF md5(replace(replace(replace(replace(v_def, v_new1, v_old1), v_new2, v_old2), v_new3, v_old3), v_new4, v_old4)) <> 'dbf4fba244c6f2ce700d3cb887c6ece6' THEN
    RAISE EXCEPTION 'the registration core is NOT the pinned chip text plus the four documented insertions';
  END IF;
END $do$;

-- ---------------------------------------------------------------------------
-- 9. THE REBUY CORE adds a Diamond rebuy, re-entry or add-on to the entry's
--    custody instead of debiting a club wallet, and books no chip fee rail.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE v_def text; v_new text; v_n integer;
v_old1 constant text := $o$DECLARE
  v_t record;
  v_p record;
  v_balance numeric;$o$;
v_new1 constant text := $n$DECLARE
  v_t record;
  v_p record;
  v_unit integer := public.fn_ca_tournament_unit_cents(p_tournament_id);  -- DIAMOND PHASE 8
  v_dia jsonb;                                                              -- DIAMOND PHASE 8
  v_balance numeric;$n$;
v_old2 constant text := $o$  PERFORM public.fn_ensure_club_wallet(p_user_id,v_club);
  SELECT chip_balance INTO v_balance
    FROM public.club_members
   WHERE user_id=p_user_id AND club_id=v_club
   FOR UPDATE;
  IF v_balance IS NULL OR v_balance<v_total THEN
    RAISE EXCEPTION 'Insufficient club chips: need %, have %',
      v_total,COALESCE(v_balance,0);
  END IF;
$o$;
v_new2 constant text := $n$  IF v_unit = 100 THEN
    -- DIAMOND PHASE 8: the purchase reserves settled Diamonds into the entry's
    -- custody row. The chip-wallet debit below is the chip estate's.
    v_dia := public.fn_poker_diamond_tournament_charge(
      p_user_id, p_tournament_id, p_rebuy_type, v_total, v_base, v_bounty_head, v_fee, v_p.id, v_key);
    v_balance := 0;
  ELSE
  PERFORM public.fn_ensure_club_wallet(p_user_id,v_club);
  SELECT chip_balance INTO v_balance
    FROM public.club_members
   WHERE user_id=p_user_id AND club_id=v_club
   FOR UPDATE;
  IF v_balance IS NULL OR v_balance<v_total THEN
    RAISE EXCEPTION 'Insufficient club chips: need %, have %',
      v_total,COALESCE(v_balance,0);
  END IF;
$n$;
v_old3 constant text := $o$  UPDATE public.club_members
     SET chip_balance=chip_balance-v_total,updated_at=now()
   WHERE user_id=p_user_id AND club_id=v_club;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'Exact tournament funding wallet changed during debit'
      USING ERRCODE='40001';
  END IF;$o$;
v_new3 constant text := $n$  UPDATE public.club_members
     SET chip_balance=chip_balance-v_total,updated_at=now()
   WHERE user_id=p_user_id AND club_id=v_club;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'Exact tournament funding wallet changed during debit'
      USING ERRCODE='40001';
  END IF;
  END IF; -- DIAMOND PHASE 8: end of the chip-wallet branch$n$;
v_old4 constant text := $o$  IF v_fee>0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO public.rake_records($o$;
v_new4 constant text := $n$  IF v_fee>0 AND v_t.club_id IS NOT NULL AND v_unit = 100 THEN
    -- DIAMOND PHASE 8: the fee stays in custody until the event settles.
    UPDATE public.tournaments
       SET total_rake=COALESCE(total_rake,0)+v_fee
     WHERE id=p_tournament_id;
  ELSIF v_fee>0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO public.rake_records($n$;
v_old5 constant text := $o$  INSERT INTO public.wallet_transactions(
    user_id,wallet_type,type,amount,category,description,
    related_entity_id,balance_after)
  VALUES(
    p_user_id,'PLAYER','debit',v_total,v_cat,$o$;
v_new5 constant text := $n$  IF v_unit = 1 THEN -- DIAMOND PHASE 8: wallet_transactions is the chip receipt
  INSERT INTO public.wallet_transactions(
    user_id,wallet_type,type,amount,category,description,
    related_entity_id,balance_after)
  VALUES(
    p_user_id,'PLAYER','debit',v_total,v_cat,$n$;
v_old6 constant text := $o$    p_tournament_id,v_balance-v_total);

  RETURN jsonb_build_object($o$;
v_new6 constant text := $n$    p_tournament_id,v_balance-v_total);
  END IF; -- DIAMOND PHASE 8

  RETURN jsonb_build_object($n$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_ca_process_tournament_chip_purchase_money_v1';
  IF md5(v_def) <> '6a828f7ce6051fdad88a94f23b2fe75d' THEN
    RAISE EXCEPTION 'the rebuy core is not the text this migration was written against (md5 %)', md5(v_def);
  END IF;
  FOREACH v_new IN ARRAY ARRAY[v_old1, v_old2, v_old3, v_old4, v_old5, v_old6] LOOP
    v_n := (length(v_def) - length(replace(v_def, v_new, ''))) / length(v_new);
    IF v_n <> 1 THEN RAISE EXCEPTION 'a rebuy-core clause is not unique (% matches): %', v_n, left(v_new, 60); END IF;
  END LOOP;
  v_new := replace(replace(replace(replace(replace(replace(v_def, v_old1, v_new1), v_old2, v_new2), v_old3, v_new3), v_old4, v_new4), v_old5, v_new5), v_old6, v_new6);
  EXECUTE v_new;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_ca_process_tournament_chip_purchase_money_v1';
  IF md5(replace(replace(replace(replace(replace(replace(v_def, v_new1, v_old1), v_new2, v_old2), v_new3, v_old3), v_new4, v_old4), v_new5, v_old5), v_new6, v_old6)) <> '6a828f7ce6051fdad88a94f23b2fe75d' THEN
    RAISE EXCEPTION 'the rebuy core is NOT the pinned chip text plus the six documented insertions';
  END IF;
END $do$;

-- ---------------------------------------------------------------------------
-- 10. THE BANK ANSWERS FOR A DIAMOND EVENT. fn_ca_escrow_can_pay reads
--     tournament_escrow, which a Diamond event never opens; the payer would
--     have fallen back to the counter cap. It now answers from the Diamond
--     banks, enforced, so a Diamond prize is capped by what the event holds.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_can_pay(p_tournament_id uuid, p_kind text, p_amount numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v public.tournament_escrow%ROWTYPE; v_have numeric; d record;
BEGIN
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    SELECT * INTO d FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id);
    v_have := CASE WHEN p_kind IN ('bounty', 'mystery_bounty', 'bounty_residual') THEN d.bounty_balance
                   WHEN p_kind = 'refund' THEN d.prize_balance + d.bounty_balance + d.fee_balance
                   ELSE d.prize_balance END;
    RETURN jsonb_build_object('known', true, 'enforced', true, 'available', v_have,
                              'ok', p_amount <= v_have, 'asset', 'diamonds',
                              'prize_balance', d.prize_balance, 'bounty_balance', d.bounty_balance, 'fee_balance', d.fee_balance);
  END IF;
  SELECT * INTO v FROM public.tournament_escrow WHERE tournament_id = p_tournament_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('known', false);
  END IF;
  v_have := CASE WHEN p_kind IN ('bounty', 'mystery_bounty', 'bounty_residual') THEN v.bounty_balance
                 WHEN p_kind = 'refund' THEN v.prize_balance + v.bounty_balance + v.fee_balance
                 ELSE v.prize_balance END;
  RETURN jsonb_build_object('known', true, 'enforced', v.enforced, 'available', v_have,
                            'ok', (NOT v.enforced) OR p_amount <= v_have + 0.005,
                            'prize_balance', v.prize_balance, 'bounty_balance', v.bounty_balance, 'fee_balance', v.fee_balance);
END;
$function$;

-- fn_ca_tournament_escrow, the shadow the receipts and the reconciler read,
-- routes a Diamond event to the Diamond banks. The chip body keeps its text
-- under a new name; the router takes the old name and the old grants.
ALTER FUNCTION public.fn_ca_tournament_escrow(uuid) RENAME TO fn_ca_tournament_escrow_chips;
CREATE FUNCTION public.fn_ca_tournament_escrow(p_tournament_id uuid)
 RETURNS TABLE(prize_in numeric, bounty_in numeric, fee_in numeric, overlay_in numeric, satellite_in numeric,
               prize_out numeric, bounty_out numeric, fee_out numeric, refund_out numeric,
               prize_balance numeric, bounty_balance numeric, fee_balance numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT * FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id)
   WHERE public.fn_poker_diamond_tournament(p_tournament_id)
  UNION ALL
  SELECT * FROM public.fn_ca_tournament_escrow_chips(p_tournament_id)
   WHERE NOT public.fn_poker_diamond_tournament(p_tournament_id);
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_escrow(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_escrow(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 11. UNREGISTRATION. The chip authority proves its refund against chip_ledger
--     rails a Diamond entry never wrote, so a Diamond withdrawal has its own
--     authority with the same roster effects, and the public door routes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_unregister(p_tournament_id uuid, p_user_id uuid, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE; v_reg public.tournament_players%ROWTYPE;
  v_refund jsonb; v_players_before integer; v_rows integer;
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'tournament, player and request ids are required' USING ERRCODE='22004';
  END IF;
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  SELECT * INTO v_t FROM public.tournaments t WHERE t.id=p_tournament_id FOR UPDATE;
  IF v_t.id IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','tournament_not_found'); END IF;
  IF NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE='23514';
  END IF;
  -- A withdrawal that already happened answers with what it did.
  IF EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger l
              WHERE l.tournament_id=p_tournament_id AND l.user_id=p_user_id AND l.kind='refund'
                AND l.request->>'request_id'=p_request_id::text) THEN
    RETURN jsonb_build_object('ok',true,'idempotent',true,'fully_settled',true);
  END IF;
  IF upper(COALESCE(v_t.status,'')) NOT IN ('ANNOUNCED','REGISTERING') OR v_t.started_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_started');
  END IF;
  SELECT * INTO v_reg FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id FOR UPDATE;
  IF v_reg.id IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','not_registered'); END IF;
  IF v_reg.status::text NOT IN ('registered','playing') THEN
    RETURN jsonb_build_object('ok',false,'reason','not_registered');
  END IF;
  SELECT count(*)::integer INTO v_players_before FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.status::text IN ('registered','playing');

  -- Money first: the release is the part that can refuse.
  v_refund := public.fn_poker_diamond_tournament_refund(
    p_tournament_id, p_user_id, 'unregister', 'fn_unregister_from_tournament', p_request_id);

  -- The same roster effects the chip authority produces, in the same order.
  UPDATE public.table_seats s
     SET left_at=transaction_timestamp(),status='left',leave_pending=false,
         is_sitting_out=false,is_away=false,sit_out_at=NULL,scheduled_leave_hands=NULL
   WHERE s.user_id=p_user_id AND s.left_at IS NULL
     AND EXISTS(SELECT 1 FROM public.tables tb WHERE tb.id=s.table_id AND tb.tournament_id=p_tournament_id);
  UPDATE public.tables tb
     SET current_players=(SELECT count(*) FROM public.table_seats s WHERE s.table_id=tb.id AND s.left_at IS NULL),
         updated_at=now()
   WHERE tb.tournament_id=p_tournament_id;
  DELETE FROM public.tournament_players tp WHERE tp.id=v_reg.id;
  UPDATE public.tournaments
     SET current_players=v_players_before-1,
         prize_pool=round(COALESCE(prize_pool,0)-(v_refund->>'refund_prize')::numeric,2),
         bounty_pool=round(COALESCE(bounty_pool,0)-(v_refund->>'refund_bounty')::numeric,2),
         total_rake=round(COALESCE(total_rake,0)-(v_refund->>'refund_fee')::numeric,2),
         updated_at=now()
   WHERE id=p_tournament_id;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN RAISE EXCEPTION 'tournament vanished during unregistration' USING ERRCODE='40001'; END IF;
  RETURN jsonb_build_object('ok',true,'fully_settled',true,'remaining',0,'request_id',p_request_id,
    'refunded_diamonds',(v_refund->>'paid')::numeric,'refund_prize',(v_refund->>'refund_prize')::numeric,
    'refund_bounty',(v_refund->>'refund_bounty')::numeric,'refund_fee',(v_refund->>'refund_fee')::numeric,
    'registration_id',v_reg.id,'custody_id',v_refund->>'custody_id','obligation_id',v_refund->>'obligation_id');
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_unregister(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_unregister_from_tournament(p_tournament_id uuid, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid:=auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_unregister_from_tournament requires an authenticated caller'
      USING ERRCODE='28000';
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'fn_unregister_from_tournament requires a live session'
      USING ERRCODE='28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'fn_unregister_from_tournament requires a request id'
      USING ERRCODE='22004';
  END IF;
  -- DIAMOND PHASE 8: a Diamond entry goes home through its own authority.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RETURN public.fn_poker_diamond_tournament_unregister(p_tournament_id,v_uid,p_request_id);
  END IF;
  RETURN public.fn_ca_unregister_tournament_player_exact(
    p_tournament_id,v_uid,NULL,'Tournament unregistration refund',p_request_id);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 12. CANCELLATION. The chip rule is kept whole: an event that has started is
--     resumed or settled, never voided. Before the start, every entry goes
--     home whole from its own custody row, the roster and the tables close
--     exactly as atomic_cancel_tournament closes them, and the same immutable
--     cancellation receipt is written - so the receipt guards the chip estate
--     already keeps (the parent, the seats, the evidence rows and the deferred
--     "CANCELLED needs its exact receipt" constraint) hold for a Diamond event
--     without being taught anything. The receipt reader routes a Diamond
--     receipt to a Diamond verifier that proves it against the Diamond ledger,
--     the custody rows and the wallet journal instead of the chip rails.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_cancellation_receipt(p_tournament_id uuid, p_observed_actor_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_h public.tournament_cancellation_receipts%ROWTYPE;
  v_t public.tournaments%ROWTYPE;
  v_e record; v_ids uuid[];
BEGIN
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'cancellation receipt requires a tournament id' USING ERRCODE='22004';
  END IF;
  IF NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE='23514';
  END IF;
  SELECT * INTO v_h FROM public.tournament_cancellation_receipts h WHERE h.tournament_id=p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % has no immutable cancellation receipt', p_tournament_id USING ERRCODE='P0404';
  END IF;
  -- A Diamond receipt names its asset; the receipts table is not altered
  -- (it is read under the settlement lane by every hand settlement).
  IF v_h.receipt->>'asset' IS DISTINCT FROM 'diamonds' THEN
    RAISE EXCEPTION 'tournament % carries a chip cancellation receipt on a Diamond event', p_tournament_id USING ERRCODE='P0404';
  END IF;
  IF p_observed_actor_id IS NOT NULL AND v_h.actor_id IS DISTINCT FROM p_observed_actor_id THEN
    RAISE EXCEPTION 'cancellation actor disagrees with stored receipt' USING ERRCODE='40001';
  END IF;
  SELECT * INTO v_t FROM public.tournaments t WHERE t.id=p_tournament_id;
  SELECT * INTO v_e FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id);
  IF v_t.id IS NULL
     OR upper(COALESCE(v_t.status::text,'')) NOT IN ('CANCELLED','CANCELED')
     OR v_t.ended_at IS DISTINCT FROM v_h.settled_at
     OR v_t.current_players IS DISTINCT FROM 0
     OR v_t.prize_pool IS DISTINCT FROM 0::numeric
     OR v_t.bounty_pool IS DISTINCT FROM 0::numeric
     OR v_t.total_rake IS DISTINCT FROM v_h.total_rake_after
     OR v_h.total_rake_after IS DISTINCT FROM 0::numeric
     OR v_t.on_break IS DISTINCT FROM false
     OR v_t.break_started_at IS NOT NULL OR v_t.break_ends_at IS NOT NULL
     OR v_e.prize_balance IS DISTINCT FROM 0::numeric
     OR v_e.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_e.fee_balance IS DISTINCT FROM 0::numeric
     OR public.fn_poker_diamond_tournament_custody(p_tournament_id) <> 0
     OR EXISTS (SELECT 1 FROM public.poker_diamond_custody c
                 WHERE c.purpose='tournament_entry' AND c.target_id=p_tournament_id AND c.state<>'released')
     OR EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger l
                 WHERE l.tournament_id=p_tournament_id AND l.kind IN ('prize','bounty','fee'))
     OR EXISTS (SELECT 1 FROM public.tournament_escrow e WHERE e.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.rake_records r WHERE r.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.wallet_transactions w WHERE w.related_entity_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.chip_ledger l WHERE l.tournament_id=p_tournament_id) THEN
    RAISE EXCEPTION 'cancellation receipt lost its terminal parent or custody state' USING ERRCODE='P0404';
  END IF;

  SELECT COALESCE(array_agg(tp.id ORDER BY tp.id),ARRAY[]::uuid[]) INTO v_ids
    FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id;
  IF v_ids IS DISTINCT FROM v_h.source_player_ids OR EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id
       AND (tp.status::text IS DISTINCT FROM 'eliminated'
         OR tp.eliminated_at IS DISTINCT FROM v_h.settled_at
         OR COALESCE(tp.chips,0)<>0 OR COALESCE(tp.current_bounty,0)<>0)) THEN
    RAISE EXCEPTION 'cancellation receipt lost its frozen roster' USING ERRCODE='P0404';
  END IF;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id),ARRAY[]::uuid[]) INTO v_ids
    FROM public.tables tb WHERE tb.tournament_id=p_tournament_id;
  IF v_ids IS DISTINCT FROM v_h.closed_table_ids OR EXISTS (
    SELECT 1 FROM public.tables tb WHERE tb.tournament_id=p_tournament_id
      AND (lower(COALESCE(tb.status::text,''))<>'closed'
        OR lower(COALESCE(tb.lifecycle,''))<>'closed'
        OR tb.current_players IS DISTINCT FROM 0
        OR tb.terminal_closed_at IS DISTINCT FROM v_h.settled_at)) THEN
    RAISE EXCEPTION 'cancellation receipt lost its frozen tables' USING ERRCODE='P0404';
  END IF;
  SELECT COALESCE(array_agg(s.id ORDER BY s.table_id,s.id),ARRAY[]::uuid[]) INTO v_ids
    FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id;
  IF v_ids IS DISTINCT FROM v_h.source_seat_ids OR EXISTS (
    SELECT 1 FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id
       AND (s.left_at IS NULL OR s.status IS DISTINCT FROM 'left'
         OR s.leave_pending IS DISTINCT FROM false
         OR s.is_sitting_out IS DISTINCT FROM false
         OR s.is_away IS DISTINCT FROM false OR s.sit_out_at IS NOT NULL
         OR s.scheduled_leave_hands IS NOT NULL)) THEN
    RAISE EXCEPTION 'cancellation receipt lost its frozen seats' USING ERRCODE='P0404';
  END IF;
  SELECT COALESCE(array_agg(s.id ORDER BY s.id),ARRAY[]::uuid[]) INTO v_ids
    FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id AND s.left_at IS NOT DISTINCT FROM v_h.settled_at;
  IF v_ids IS DISTINCT FROM v_h.released_seat_ids THEN
    RAISE EXCEPTION 'cancellation receipt lost its released-seat identity' USING ERRCODE='P0404';
  END IF;

  -- Disposition roster: every registration is either refunded or a zero line.
  SELECT COALESCE(array_agg(x.registration_id ORDER BY x.registration_id),ARRAY[]::uuid[]) INTO v_ids
    FROM (SELECT DISTINCT (line->>'registration_id')::uuid AS registration_id
            FROM jsonb_array_elements(v_h.receipt->'refunds') line) x;
  IF v_ids IS DISTINCT FROM v_h.refunded_registration_ids THEN
    RAISE EXCEPTION 'cancellation receipt lost its disposition roster' USING ERRCODE='P0404';
  END IF;
  SELECT COALESCE(array_agg(x.id ORDER BY x.id),ARRAY[]::uuid[]) INTO v_ids
    FROM (SELECT unnest(v_h.source_player_ids) AS id EXCEPT SELECT unnest(v_h.refunded_registration_ids)) x;
  IF v_ids IS DISTINCT FROM v_h.zero_refund_registration_ids THEN
    RAISE EXCEPTION 'cancellation receipt lost its zero-disposition roster' USING ERRCODE='P0404';
  END IF;
  IF v_h.ticket_return_count<>0 OR v_h.total_ticket_returned<>0 OR cardinality(v_h.ticket_return_ids)<>0
     OR cardinality(v_h.fee_reversal_ids)<>0 OR v_h.spin_unwind_tournament_id IS NOT NULL THEN
    RAISE EXCEPTION 'cancellation receipt carries chip evidence on a Diamond event' USING ERRCODE='P0404';
  END IF;

  -- Exact refund evidence: each receipt line is one ledger refund row, one
  -- released custody row, one wallet journal row and one settled obligation.
  IF (SELECT count(*) FROM public.poker_diamond_tournament_ledger l
       WHERE l.tournament_id=p_tournament_id AND l.kind='refund'
         AND l.request->>'source'='atomic_cancel_tournament')
       IS DISTINCT FROM v_h.refund_line_count
     OR (SELECT COALESCE(sum(l.amount),0)::numeric FROM public.poker_diamond_tournament_ledger l
          WHERE l.tournament_id=p_tournament_id AND l.kind='refund'
            AND l.request->>'source'='atomic_cancel_tournament')
       IS DISTINCT FROM v_h.total_refunded
     OR (SELECT COALESCE(sum(l.fee_part),0)::numeric FROM public.poker_diamond_tournament_ledger l
          WHERE l.tournament_id=p_tournament_id AND l.kind='refund'
            AND l.request->>'source'='atomic_cancel_tournament')
       IS DISTINCT FROM v_h.fees_reversed
     OR (SELECT count(DISTINCT l.user_id) FROM public.poker_diamond_tournament_ledger l
          WHERE l.tournament_id=p_tournament_id AND l.kind='refund'
            AND l.request->>'source'='atomic_cancel_tournament')
       IS DISTINCT FROM v_h.refunded_count
     OR EXISTS (
       SELECT 1
         FROM jsonb_to_recordset(v_h.receipt->'refunds') AS line(
           registration_id uuid,user_id uuid,custody_id uuid,ledger_id bigint,
           amount numeric,refund_prize numeric,refund_bounty numeric,refund_fee numeric,
           obligation_id uuid,journal_id uuid,request_id uuid)
         LEFT JOIN public.tournament_players tp ON tp.id=line.registration_id
         LEFT JOIN public.poker_diamond_tournament_ledger l ON l.id=line.ledger_id
         LEFT JOIN public.poker_diamond_custody c ON c.id=line.custody_id
         LEFT JOIN public.tournament_obligations o ON o.id=line.obligation_id
         LEFT JOIN public.diamond_transactions j ON j.id=line.journal_id
         LEFT JOIN public.poker_diamond_movements m ON m.request_id=line.request_id
        WHERE tp.id IS NULL OR tp.tournament_id IS DISTINCT FROM p_tournament_id
           OR tp.user_id IS DISTINCT FROM line.user_id
           OR l.id IS NULL OR l.tournament_id IS DISTINCT FROM p_tournament_id
           OR l.kind IS DISTINCT FROM 'refund' OR l.user_id IS DISTINCT FROM line.user_id
           OR l.custody_id IS DISTINCT FROM line.custody_id
           OR l.amount::numeric IS DISTINCT FROM line.amount
           OR l.prize_part::numeric IS DISTINCT FROM line.refund_prize
           OR l.bounty_part::numeric IS DISTINCT FROM line.refund_bounty
           OR l.fee_part::numeric IS DISTINCT FROM line.refund_fee
           OR line.amount IS DISTINCT FROM line.refund_prize+line.refund_bounty+line.refund_fee
           OR l.obligation_id IS DISTINCT FROM line.obligation_id
           OR l.wallet_journal_id IS DISTINCT FROM line.journal_id
           OR l.request->>'source' IS DISTINCT FROM 'atomic_cancel_tournament'
           OR l.request->>'request_id' IS DISTINCT FROM line.request_id::text
           OR c.id IS NULL OR c.user_id IS DISTINCT FROM line.user_id
           OR c.purpose IS DISTINCT FROM 'tournament_entry'
           OR c.target_id IS DISTINCT FROM p_tournament_id
           OR c.state IS DISTINCT FROM 'released' OR c.balance IS DISTINCT FROM 0
           OR o.id IS NULL OR o.tournament_id IS DISTINCT FROM p_tournament_id
           OR o.kind IS DISTINCT FROM 'refund' OR o.place IS NOT NULL
           OR o.user_id IS DISTINCT FROM line.user_id OR o.settled_at IS NULL
           OR o.amount_paid IS DISTINCT FROM o.amount_owed
           OR o.amount_paid IS DISTINCT FROM (
             SELECT COALESCE(sum(x.amount),0)::numeric FROM public.poker_diamond_tournament_ledger x
              WHERE x.obligation_id=o.id AND x.kind='refund')
           OR j.id IS NULL OR j.user_id IS DISTINCT FROM line.user_id
           OR j.type IS DISTINCT FROM 'arena_withdraw'
           OR m.request_id IS NULL OR m.custody_id IS DISTINCT FROM line.custody_id
           OR m.action IS DISTINCT FROM 'release' OR m.amount IS DISTINCT FROM line.amount)
     OR EXISTS (
       SELECT 1 FROM public.poker_diamond_tournament_ledger l
        WHERE l.tournament_id=p_tournament_id AND l.kind='refund'
          AND l.request->>'source'='atomic_cancel_tournament'
          AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(v_h.receipt->'refunds') AS line(ledger_id bigint)
                           WHERE line.ledger_id=l.id)) THEN
    RAISE EXCEPTION 'cancellation receipt lost exact refund evidence' USING ERRCODE='P0404';
  END IF;
  RETURN v_h.receipt;
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_cancellation_receipt(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_tournament_cancellation_receipt(uuid,uuid) TO service_role;

-- The receipt reader (which the deferred CANCELLED constraint and the chip
-- cancellation replay both call) hands a Diamond event to its own verifier.
DO $do$
DECLARE v_def text; v_new text; v_n integer;
v_old constant text := $o$  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % has no immutable cancellation receipt',
      p_tournament_id USING ERRCODE='P0404';
  END IF;$o$;
v_add constant text := $n$  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % has no immutable cancellation receipt',
      p_tournament_id USING ERRCODE='P0404';
  END IF;
  -- DIAMOND PHASE 8: a Diamond event's receipt is proved against custody,
  -- the Diamond ledger and the wallet journal, never against chip rails.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RETURN public.fn_poker_diamond_tournament_cancellation_receipt(p_tournament_id,p_observed_actor_id);
  END IF;$n$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_ca_tournament_cancellation_receipt';
  IF md5(v_def) <> 'bf4a7dfd3cfb89194c139f897c0dd0e7' THEN
    RAISE EXCEPTION 'fn_ca_tournament_cancellation_receipt is not the text this migration was written against (md5 %)', md5(v_def);
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'the receipt-missing clause is not unique in the cancellation receipt reader (% matches)', v_n; END IF;
  v_new := replace(v_def, v_old, v_add);
  EXECUTE v_new;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_ca_tournament_cancellation_receipt';
  IF md5(replace(v_def, v_add, v_old)) <> 'bf4a7dfd3cfb89194c139f897c0dd0e7' THEN
    RAISE EXCEPTION 'the cancellation receipt reader is NOT the pinned chip text plus the one documented route';
  END IF;
END $do$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_cancel(p_tournament_id uuid, p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_actor uuid := COALESCE(auth.uid(), p_actor_id, '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);
  v_t public.tournaments%ROWTYPE; v_player record; v_refund jsonb;
  v_cancelled_at timestamptz := transaction_timestamp();
  v_refunds jsonb := '[]'::jsonb; v_receipt jsonb;
  v_source_player_ids uuid[]; v_refunded_registration_ids uuid[] := ARRAY[]::uuid[];
  v_zero_refund_registration_ids uuid[] := ARRAY[]::uuid[]; v_closed_table_ids uuid[];
  v_source_seat_ids uuid[]; v_released_seat_ids uuid[];
  v_total bigint := 0; v_fees bigint := 0; v_count integer := 0; v_lines integer := 0;
  v_rake_before numeric; v_rows integer; v_request uuid;
BEGIN
  IF p_tournament_id IS NULL THEN RAISE EXCEPTION 'Tournament id is required' USING ERRCODE='22004'; END IF;
  -- The global settlement lane is already held when atomic_cancel_tournament
  -- routes here; taken again for a direct owner call, it is re-entrant.
  PERFORM public.fn_ca_lock_settlement_lane_global();
  SELECT * INTO v_t FROM public.tournaments t WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tournament not found' USING ERRCODE='P0002'; END IF;
  IF NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE='23514';
  END IF;
  -- The arena has no club operators; platform staff cancel a Diamond event,
  -- the same authority that creates one. A service-role call carries no uid.
  IF v_uid IS NOT NULL AND NOT public.fn_is_platform_admin() THEN
    RAISE EXCEPTION 'Only platform staff may cancel a Diamond tournament' USING ERRCODE='42501';
  END IF;
  -- A stored receipt is the answer, replayed exactly.
  IF EXISTS (SELECT 1 FROM public.tournament_cancellation_receipts h WHERE h.tournament_id=p_tournament_id) THEN
    RETURN public.fn_ca_tournament_cancellation_receipt(p_tournament_id,NULL);
  END IF;
  IF upper(COALESCE(v_t.status::text,'')) IN ('COMPLETED','CANCELLED','CANCELED','COMPLETING') THEN
    RAISE EXCEPTION 'Tournament is already %',v_t.status USING ERRCODE='55000';
  END IF;
  -- THE CHIP RULE, UNCHANGED: a started event is resumed or settled, never voided.
  IF v_t.started_at IS NOT NULL
     OR upper(COALESCE(v_t.status::text,'')) IN ('RUNNING','BREAK')
     OR EXISTS (SELECT 1 FROM public.tournament_launch_receipts r
                 WHERE r.tournament_id=p_tournament_id AND r.completed_at IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.hand_history hh WHERE hh.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tables tb JOIN public.hand_history hh ON hh.table_id=tb.id
                 WHERE tb.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id=p_tournament_id AND o.kind<>'refund' AND o.amount_paid>0)
     OR EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger l
                 WHERE l.tournament_id=p_tournament_id AND l.kind IN ('prize','bounty','fee')) THEN
    RAISE EXCEPTION 'Tournament has started or committed awards; resume or settle it instead of cancelling'
      USING ERRCODE='55000';
  END IF;

  -- Freeze every identity before any refund runs.
  PERFORM 1 FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id ORDER BY tp.user_id,tp.id FOR UPDATE;
  PERFORM 1 FROM public.tables tb WHERE tb.tournament_id=p_tournament_id ORDER BY tb.id FOR UPDATE;
  PERFORM 1 FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
    WHERE tb.tournament_id=p_tournament_id ORDER BY s.table_id,s.id FOR UPDATE OF s;
  SELECT COALESCE(array_agg(tp.id ORDER BY tp.id),ARRAY[]::uuid[]) INTO v_source_player_ids
    FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id),ARRAY[]::uuid[]) INTO v_closed_table_ids
    FROM public.tables tb WHERE tb.tournament_id=p_tournament_id;
  SELECT COALESCE(array_agg(s.id ORDER BY s.table_id,s.id),ARRAY[]::uuid[]) INTO v_source_seat_ids
    FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id WHERE tb.tournament_id=p_tournament_id;
  v_rake_before := COALESCE(v_t.total_rake,0);
  -- The caches must equal the custody banks before anything moves.
  IF (SELECT prize_balance FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id)) IS DISTINCT FROM COALESCE(v_t.prize_pool,0)
     OR (SELECT bounty_balance FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id)) IS DISTINCT FROM COALESCE(v_t.bounty_pool,0)
     OR (SELECT fee_balance FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id)) IS DISTINCT FROM v_rake_before THEN
    RAISE EXCEPTION 'tournament % caches do not equal exact custody before cancellation', p_tournament_id USING ERRCODE='P0404';
  END IF;

  -- Whoever paid in gets it back, entry by entry, from their own custody row.
  FOR v_player IN
    SELECT tp.id, tp.user_id FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id ORDER BY tp.user_id, tp.id
  LOOP
    IF v_player.user_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM public.poker_diamond_custody c
          WHERE c.user_id=v_player.user_id AND c.purpose='tournament_entry'
            AND c.target_id=p_tournament_id AND c.state<>'released') THEN
      v_request := uuid_in(md5('poker-tournament-cancel:'||p_tournament_id::text||':'||v_player.user_id::text)::cstring);
      v_refund := public.fn_poker_diamond_tournament_refund(
        p_tournament_id, v_player.user_id, 'cancel', 'atomic_cancel_tournament', v_request);
      IF COALESCE((v_refund->>'idempotent')::boolean,false) THEN
        RAISE EXCEPTION 'tournament % refund for % was already recorded before this cancellation', p_tournament_id, v_player.user_id USING ERRCODE='P0404';
      END IF;
      v_total := v_total + (v_refund->>'paid')::bigint;
      v_fees := v_fees + (v_refund->>'refund_fee')::bigint;
      v_count := v_count + 1; v_lines := v_lines + 1;
      v_refunded_registration_ids := array_append(v_refunded_registration_ids, v_player.id);
      v_refunds := v_refunds || jsonb_build_object(
        'registration_id',v_player.id,'user_id',v_player.user_id,
        'custody_id',(v_refund->>'custody_id')::uuid,'ledger_id',(v_refund->>'ledger_id')::bigint,
        'amount',(v_refund->>'paid')::numeric,'refund_prize',(v_refund->>'refund_prize')::numeric,
        'refund_bounty',(v_refund->>'refund_bounty')::numeric,'refund_fee',(v_refund->>'refund_fee')::numeric,
        'obligation_id',(v_refund->>'obligation_id')::uuid,'journal_id',NULLIF(v_refund->>'journal_id','')::uuid,
        'request_id',v_request);
    ELSE
      v_zero_refund_registration_ids := array_append(v_zero_refund_registration_ids, v_player.id);
    END IF;
  END LOOP;
  IF public.fn_poker_diamond_tournament_custody(p_tournament_id) <> 0
     OR EXISTS (SELECT 1 FROM public.poker_diamond_custody c
                 WHERE c.purpose='tournament_entry' AND c.target_id=p_tournament_id AND c.state<>'released') THEN
    RAISE EXCEPTION 'diamond_tournament_custody_not_empty_after_cancel' USING ERRCODE='P0404';
  END IF;
  IF (SELECT prize_balance+bounty_balance+fee_balance FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id)) <> 0 THEN
    RAISE EXCEPTION 'tournament % cancellation did not close all custody banks', p_tournament_id USING ERRCODE='P0404';
  END IF;

  UPDATE public.tournament_players
     SET status='eliminated',eliminated_at=v_cancelled_at,chips=0,current_bounty=0
   WHERE tournament_id=p_tournament_id;
  WITH released AS (
    UPDATE public.table_seats s
       SET left_at=v_cancelled_at,status='left',leave_pending=false,
           is_sitting_out=false,is_away=false,sit_out_at=NULL,scheduled_leave_hands=NULL
      FROM public.tables tb
     WHERE tb.id=s.table_id AND tb.tournament_id=p_tournament_id AND s.left_at IS NULL
     RETURNING s.id)
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[]) INTO v_released_seat_ids FROM released;
  UPDATE public.table_seats s
     SET status='left',leave_pending=false,is_sitting_out=false,is_away=false,sit_out_at=NULL,scheduled_leave_hands=NULL
   WHERE s.id=ANY(v_source_seat_ids) AND s.left_at IS NOT NULL;
  UPDATE public.tournaments
     SET status='CANCELLED',ended_at=v_cancelled_at,updated_at=now(),
         prize_pool=0,bounty_pool=0,total_rake=0,current_players=0,
         on_break=false,break_started_at=NULL,break_ends_at=NULL
   WHERE id=p_tournament_id
     AND upper(COALESCE(status::text,'')) NOT IN ('COMPLETED','CANCELLED','CANCELED','COMPLETING');
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN RAISE EXCEPTION 'tournament % lost its cancellation lifecycle claim', p_tournament_id USING ERRCODE='40001'; END IF;
  UPDATE public.tables
     SET status='closed',lifecycle='closed',current_players=0,terminal_closed_at=v_cancelled_at,updated_at=now()
   WHERE tournament_id=p_tournament_id;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>cardinality(v_closed_table_ids) THEN
    RAISE EXCEPTION 'tournament % did not close every table', p_tournament_id USING ERRCODE='40001';
  END IF;

  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[]) INTO v_refunded_registration_ids FROM unnest(v_refunded_registration_ids) ids(id);
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[]) INTO v_zero_refund_registration_ids FROM unnest(v_zero_refund_registration_ids) ids(id);
  v_receipt := jsonb_build_object(
    'ok',true,'success',true,'fully_settled',true,'receipt_version',2,'asset','diamonds',
    'tournament_id',p_tournament_id,'actor_id',v_actor,'status','CANCELLED',
    'source_player_count',cardinality(v_source_player_ids),
    'refunded_count',v_count,'refund_line_count',v_lines,
    'ticket_return_count',0,'total_ticket_returned',0,
    'total_refunded',v_total,'fees_reversed',v_fees,
    'closed_table_count',cardinality(v_closed_table_ids),
    'source_seat_count',cardinality(v_source_seat_ids),
    'released_seat_count',cardinality(v_released_seat_ids),
    'refunds',v_refunds,'ticket_returns','[]'::jsonb,
    'settled_at',v_cancelled_at);
  INSERT INTO public.tournament_cancellation_receipts(
    tournament_id,actor_id,receipt_version,
    source_player_count,source_player_ids,
    refunded_count,refunded_registration_ids,refund_line_count,
    ticket_return_count,ticket_return_ids,total_ticket_returned,
    zero_refund_count,zero_refund_registration_ids,
    total_refunded,fees_reversed,total_rake_before,total_rake_after,
    closed_table_count,closed_table_ids,source_seat_count,source_seat_ids,
    released_seat_count,released_seat_ids,fee_reversal_ids,
    escrow_closed_at,escrow_close_note,spin_unwind_tournament_id,
    receipt,settled_at)
  VALUES(
    p_tournament_id,v_actor,2,
    cardinality(v_source_player_ids),v_source_player_ids,
    v_count,v_refunded_registration_ids,v_lines,
    0,ARRAY[]::uuid[],0,
    cardinality(v_zero_refund_registration_ids),v_zero_refund_registration_ids,
    v_total,v_fees,v_rake_before,0,
    cardinality(v_closed_table_ids),v_closed_table_ids,cardinality(v_source_seat_ids),v_source_seat_ids,
    cardinality(v_released_seat_ids),v_released_seat_ids,ARRAY[]::uuid[],
    v_cancelled_at,'diamond custody returned: exact zero',NULL,v_receipt,v_cancelled_at);
  RETURN public.fn_ca_tournament_cancellation_receipt(p_tournament_id,v_actor);
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_cancel(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;

DO $do$
DECLARE v_def text; v_new text; v_n integer;
v_old constant text := $o$  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament not found' USING ERRCODE = 'P0002';
  END IF;$o$;
v_add constant text := $n$  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament not found' USING ERRCODE = 'P0002';
  END IF;
  -- DIAMOND PHASE 8: a Diamond event is cancelled by its own authority, which
  -- returns every entry from custody and writes the same immutable receipt;
  -- the chip rails below never saw a Diamond entry.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RETURN public.fn_poker_diamond_tournament_cancel(p_tournament_id, p_admin_id);
  END IF;$n$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='atomic_cancel_tournament';
  IF md5(v_def) <> '455f7f1934d136e27c13310eab07e3c6' THEN
    RAISE EXCEPTION 'atomic_cancel_tournament is not the text this migration was written against (md5 %)', md5(v_def);
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'the cancellation lock clause is not unique (% matches)', v_n; END IF;
  v_new := replace(v_def, v_old, v_add);
  EXECUTE v_new;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='atomic_cancel_tournament';
  IF md5(replace(v_def, v_add, v_old)) <> '455f7f1934d136e27c13310eab07e3c6' THEN
    RAISE EXCEPTION 'atomic_cancel_tournament is NOT the pinned chip text plus the one documented route';
  END IF;
END $do$;
-- ---------------------------------------------------------------------------
-- 13. HORSES ARE PHASE 9. A horse's bankroll is a club chip wallet, and the
--     house funding that would give one Diamonds is not built. Refuse at the
--     door rather than inside a debit that would have found nothing to take.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_register_horse_for_tournament(p_tournament_id uuid, p_user_id uuid, p_allow_wallet_charge boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_gate jsonb;
BEGIN
  -- DIAMOND PHASE 8: house-funded horse entries are Phase 9.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','diamond_horse_funding_not_open');
  END IF;
  v_gate:=public.fn_ca_lock_tournament_seat_acquisition(
    p_tournament_id,NULL,p_user_id);
  IF COALESCE((v_gate->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN v_gate;
  END IF;
  RETURN public.fn_register_horse_for_tournament_before_terminal_gate(
    p_tournament_id,p_user_id,p_allow_wallet_charge);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 14. THE CREATION DOOR. Platform staff only, the same authority as
--     fn_poker_diamond_open_cash_table. Whole Diamonds throughout; the fee is
--     ten percent of the total truncated to a whole Diamond (five for heads
--     up), which is the recovery-fee rule with the entry's own unit. Anything
--     Phase 9 owns is refused by name.
-- ---------------------------------------------------------------------------
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
  IF v_type NOT IN ('mtt','sng') THEN
    -- bounty, progressive_bounty, mystery_bounty, satellite, spin: Phase 9.
    RAISE EXCEPTION 'diamond_tournament_format_not_open' USING ERRCODE='55000';
  END IF;
  IF COALESCE((p_config->>'guarantee')::numeric,0)<>0 OR COALESCE((p_config->>'bountyAmount')::numeric,0)<>0
     OR COALESCE((p_config->>'isBounty')::boolean,false) OR COALESCE((p_config->>'satelliteTargetId')::text,'')<>''
     OR COALESCE((p_config->>'freeBuy')::boolean,false) THEN
    RAISE EXCEPTION 'diamond_tournament_format_not_open' USING ERRCODE='55000';
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
  v_variant := CASE WHEN v_type='sng' THEN 'sng' ELSE 'freezeout' END;

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
    COALESCE((p_config->>'lateRegLevels')::int, CASE WHEN v_type='sng' THEN 0 ELSE 8 END), 8, false, false, false, 0,
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
    'total',v_total,'asset','diamonds');
END $function$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_create_tournament(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_create_tournament(jsonb) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 15. THE ESTATE IS AS IT WAS, AND THE DOORS ARE WHERE THEY SHOULD BE.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE v_acl text; v_n integer; r record;
BEGIN
  -- Nothing opened.
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled) THEN
    RAISE EXCEPTION 'this migration must not open the tournament door';
  END IF;
  SELECT count(*) INTO v_n FROM public.poker_diamond_custody WHERE purpose='tournament_entry';
  IF v_n<>0 THEN RAISE EXCEPTION 'custody gained tournament rows during apply'; END IF;
  SELECT count(*) INTO v_n FROM public.poker_diamond_tournament_ledger;
  IF v_n<>0 THEN RAISE EXCEPTION 'the ledger is not empty after apply'; END IF;

  -- Internal steps are owner-only; doors carry exactly the grants their
  -- chip counterparts carry.
  FOR r IN SELECT p.oid, p.proname FROM pg_proc p
            WHERE p.pronamespace='public'::regnamespace AND p.proname IN (
              'fn_poker_diamond_tournament_charge','fn_poker_diamond_tournament_refund',
              'fn_poker_diamond_tournament_custody_add','fn_poker_diamond_tournament_unregister',
              'fn_poker_diamond_tournament_cancel')
  LOOP
    IF has_function_privilege('anon', r.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', r.oid, 'EXECUTE')
       OR has_function_privilege('service_role', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is callable by a client role; it is an internal step', r.proname;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN (
        'fn_poker_diamond_tournament_charge','fn_poker_diamond_tournament_refund',
        'fn_poker_diamond_tournament_custody_add','fn_poker_diamond_tournament_unregister',
        'fn_poker_diamond_tournament_cancel')) <> 5 THEN
    RAISE EXCEPTION 'an internal Diamond tournament step is missing';
  END IF;
  IF has_function_privilege('anon','public.fn_poker_diamond_create_tournament(jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'the creation door is callable without an account';
  END IF;
  IF NOT has_function_privilege('authenticated','public.fn_poker_diamond_create_tournament(jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'the creation door must be reachable by a signed-in platform admin';
  END IF;
  SELECT coalesce(proacl::text,'default') INTO v_acl FROM pg_proc WHERE proname='fn_ca_tournament_escrow' AND pronamespace='public'::regnamespace;
  IF v_acl <> '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'fn_ca_tournament_escrow router grants differ from the body it replaced: %', v_acl;
  END IF;
  SELECT coalesce(proacl::text,'default') INTO v_acl FROM pg_proc WHERE proname='fn_ca_tournament_escrow_chips' AND pronamespace='public'::regnamespace;
  IF v_acl <> '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'the renamed chip escrow body lost its grants: %', v_acl;
  END IF;
  IF has_function_privilege('anon','public.fn_poker_diamond_tournament_escrow(uuid)','EXECUTE')
     OR has_function_privilege('authenticated','public.fn_poker_diamond_tournament_escrow(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'the Diamond escrow reader is callable by a client role';
  END IF;

  -- The edited chip functions still carry their exact chip text.
  FOR r IN SELECT p.proname, pg_get_functiondef(p.oid) AS def FROM pg_proc p
            WHERE p.pronamespace='public'::regnamespace AND p.proname IN (
              'fn_register_for_tournament_before_atomic_capacity_20260907',
              'fn_ca_process_tournament_chip_purchase_money_v1','atomic_cancel_tournament','fn_poker_diamond_release',
              'fn_guard_profile_privileged_columns','fn_poker_guard_arena_structure')
  LOOP
    IF r.proname='fn_register_for_tournament_before_atomic_capacity_20260907' AND (
         position('v_ok := public.atomic_deduct_wallet_and_log(' in r.def)=0
      OR position($c$ELSIF v_split.charge > 0 THEN$c$ in r.def)=0
      OR position($c$AND v_unit = 1 THEN$c$ in r.def)=0) THEN
      RAISE EXCEPTION 'the registration core lost its chip debit or its Diamond branch';
    END IF;
    IF r.proname='fn_ca_process_tournament_chip_purchase_money_v1' AND (
         position('SET chip_balance=chip_balance-v_total' in r.def)=0
      OR position('fn_poker_diamond_tournament_charge(' in r.def)=0
      OR position($c$INSERT INTO public.rake_records($c$ in r.def)=0) THEN
      RAISE EXCEPTION 'the rebuy core lost its chip debit, its fee rail or its Diamond branch';
    END IF;
    IF r.proname='atomic_cancel_tournament' AND (
         position('fn_poker_diamond_tournament_cancel(' in r.def)=0
      OR position('fn_settle_tournament_refund_exact(' in r.def)=0) THEN
      RAISE EXCEPTION 'the cancellation authority lost its chip body or its Diamond route';
    END IF;
    IF r.proname='fn_guard_profile_privileged_columns' AND (
         position('fn_poker_diamond_tournament_charge[(]' in r.def)=0
      OR position('fn_poker_diamond_tournament_refund[(]' in r.def)=0
      OR position('fn_arena_withdraw[(]' in r.def)=0) THEN
      RAISE EXCEPTION 'the wallet guard lost a door';
    END IF;
    IF r.proname='fn_poker_guard_arena_structure' AND (
         position('Diamond Games Require Platform Operations' in r.def)=0
      OR position('fn_poker_diamond_play_state_columns(TG_TABLE_NAME)' in r.def)=0) THEN
      RAISE EXCEPTION 'the arena structure guard lost its refusal or its play-state clause';
    END IF;
    IF r.proname='fn_poker_diamond_release' AND (
         position('diamond_tournament_entry_requires_refund_authority' in r.def)=0
      OR position('diamond_custody_requires_settlement' in r.def)=0) THEN
      RAISE EXCEPTION 'the release lost its seat guard or its entry guard';
    END IF;
  END LOOP;

  -- The arena is a member of itself for every profile, and no chip club changed.
  IF NOT public.fn_ca_entry_scope_ok((SELECT id FROM public.profiles ORDER BY created_at LIMIT 1),
                                     (SELECT id FROM public.clubs WHERE asset='diamonds' AND is_platform IS TRUE LIMIT 1)) THEN
    RAISE EXCEPTION 'a profile is not admitted to the Diamond arena roster';
  END IF;
  RAISE NOTICE 'a Diamond tournament entry is custody: doors installed, nothing opened';
END $do$;
