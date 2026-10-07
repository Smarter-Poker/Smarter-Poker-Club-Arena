-- 20261007132503_the_diamond_tournament_lane_leaves_custody_without_a_wallet_.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- Issue #6411. The same defect class as the Diamond cash rake (#6410,
-- 20261007112751), in the Diamond tournament lane.
--
-- ============================================================================
-- THE DEFECT, READ FROM ROWS ON 2026-10-07 (13:21 UTC)
-- ============================================================================
--
-- A diamond_transactions row is the record of a movement of profiles.diamonds.
-- Five writes in the Diamond tournament lane put a row there for Diamonds that
-- moved between an entry's arena custody and the house, and never touched a
-- wallet. Named to the line of the live definitions (pg_get_functiondef):
--
--   1. fn_poker_diamond_tournament_drain, line 66, the p_journal_for IS NULL arm:
--        INSERT INTO public.diamond_transactions(user_id,type,transaction_type,amount,balance_after, ...
--        VALUES (v_c.user_id, ... 'tournament_fee' | 'arena_spin_surplus' |
--                'arena_guarantee_overlay_return', -v_take::integer, v_wallet, ...)
--      for every custody row it drains to the house. It is reached with NULL
--      from three callers, so it is three of the five writers:
--        - the tournament fee   (fn_poker_diamond_tournament_settle_fee, line 30),
--        - the Spin surplus     (fn_poker_diamond_spin_draw, line 251),
--        - the overlay return   (fn_poker_diamond_tournament_settle_overlay, line 118).
--   4. fn_poker_diamond_tournament_settle_overlay, line 74: a positive
--      'arena_guarantee_overlay' row per custody share the house pays in.
--   5. fn_poker_diamond_spin_draw, line 207: a positive 'arena_spin_underwrite'
--      row per custody share the house underwrites.
--
-- Each one's own comment says the wallet does not move (balance_after is the
-- wallet as it stands). The Diamonds of an entry left the wallet ONCE, in the
-- entry's arena_deposit row; a fee or surplus row writes that departure a
-- second time, and a credit row writes an arrival that never happened.
--
-- Measured: the fee path wrote first, at 13:03:21 UTC (the Diamond
-- Progressive Bounty 2000 completed and settled its 800 Diamond fee). Journal
-- drift (profiles.diamonds vs SUM(diamond_transactions.amount)) went from 0 to
-- 4 wallets, 800 Diamonds, and every Diamond of it is those four -200
-- 'tournament_fee' rows. The other four kinds had written nothing. Lifetime VIP
-- lot allocations from these rows: 0. The register and the supply identity
-- were whole (register_drifts 0, difference 0): the register burns these rows
-- drove are CORRECT, because the register counts custody Diamonds as the
-- player's.
--
-- ============================================================================
-- THE FIX (the #6410 design applied to the lane)
-- ============================================================================
--
-- The register row stays, written directly; the wallet journal row goes.
--   - The drain's house-bound arm writes a player-holder 'burn' into
--     ca_mint_ledger itself, op_id '<reason>:<custody>' (the reference the
--     journal row used to carry), balance_before = balance_after = the
--     untouched wallet, and returns that op_id as register_op_id. The movement
--     it writes carries no wallet_journal_id. A prize or bounty drain
--     (p_journal_for given: the recipient's wallet credit) is unchanged.
--   - settle_fee, spin_draw's surplus arm and settle_overlay's return arm
--     assert the players' retirement by those op_ids, not through journal ids.
--   - settle_overlay's pay arm and spin_draw's underwrite arm write a
--     player-holder 'mint' per custody share directly (op_id
--     '<key>:<custody>'), and their movement and tournament-ledger rows carry
--     no wallet_journal_id. Their assertions read the register by op_id.
--   - poker_diamond_movements_amount_check required a wallet_journal_id on
--     every non-zero movement. It now admits a NULL one ONLY on the two house
--     legs (custody -> 'house' by tournament_drain; 'house:' -> custody by
--     spin_underwrite or guarantee_overlay). Every movement with a wallet on
--     either side still requires its journal row.
--   - poker_diamond_tournament_ledger_outflow required a wallet_journal_id on
--     spin_underwrite / spin_surplus / overlay / overlay_return rows. Those are
--     house legs and never had a wallet side; the requirement is removed for
--     them only. entry / rebuy / reentry / addon still require theirs
--     (poker_diamond_tournament_ledger_inflow, untouched).
--   - fn_diamond_arena_reconciliation compares only wallet legs to the journal;
--     a house leg has no wallet side, so the four fee legs already written no
--     longer read as release_amount_mismatch.
--
-- Rejected: keeping the journal rows and teaching every reader to ignore them.
-- That is a detector, not a fix (CLAUDE.md 10.11); the journal must explain
-- the balance by itself.
--
-- WATCHED GUARDS. fn_poker_diamond_tournament_drain and
-- fn_poker_diamond_tournament_settle_fee are on the guard watchlist; both are
-- declared through fn_ca_declare_guard_redefinition in this transaction. No
-- guard is disabled. spin_draw, settle_overlay and the reconciliation are not
-- on the watchlist.
--
-- PRE-IMAGES. Each function is replaced only if its live definition is the one
-- this file was written against (md5 of pg_get_functiondef, read 2026-10-07);
-- otherwise the transaction refuses, so a concurrent redefinition is never
-- silently overwritten.
--
-- THE DAMAGE ALREADY WRITTEN is settled by its own migration, after this one
-- has stopped it growing, with the numbers read then (CLAUDE.md 10.9 rule 4).
--
-- One transaction (production DDL policy rule 1). Never inside :50-:03 UTC.
--
-- @live-proof: (SELECT position('INSERT INTO public.diamond_transactions' IN pg_get_functiondef('public.fn_poker_diamond_tournament_drain(uuid,text,bigint,text,text,uuid)'::regprocedure)) = 0)
-- @live-proof: (SELECT position('INSERT INTO public.diamond_transactions' IN pg_get_functiondef('public.fn_poker_diamond_spin_draw(uuid,uuid,uuid)'::regprocedure)) = 0)
-- @live-proof: (SELECT position('INSERT INTO public.diamond_transactions' IN pg_get_functiondef('public.fn_poker_diamond_tournament_settle_overlay(uuid,text,numeric)'::regprocedure)) = 0)

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. THE PRE-IMAGES THIS FILE WAS WRITTEN AGAINST.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.fn_poker_diamond_tournament_drain(uuid,text,bigint,text,text,uuid)', 'bca03ffca292f2972760e59decae3fd6'),
    ('public.fn_poker_diamond_tournament_settle_fee(uuid,text)',                  '4e947c948d953098fb63c26d14decde8'),
    ('public.fn_poker_diamond_tournament_settle_overlay(uuid,text,numeric)',      '8626287aaff075f6a696ae48489d7afe'),
    ('public.fn_poker_diamond_spin_draw(uuid,uuid,uuid)',                         'd5dd637ae71afa08b5c27c042f9eb1c2'),
    ('public.fn_diamond_arena_reconciliation(uuid)',                              '24c8d47da86fe9e5a0f3e20e78389c50')
  ) AS v(sig, pin) LOOP
    IF md5(pg_get_functiondef(r.sig::regprocedure)) IS DISTINCT FROM r.pin THEN
      RAISE EXCEPTION '% is not the definition this migration was written against (md5 %, expected %). Re-read it and rebase the change.',
        r.sig, md5(pg_get_functiondef(r.sig::regprocedure)), r.pin;
    END IF;
  END LOOP;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. A HOUSE LEG CARRIES NO WALLET JOURNAL ROW. A WALLET LEG STILL MUST.
-- ---------------------------------------------------------------------------
ALTER TABLE public.poker_diamond_movements DROP CONSTRAINT poker_diamond_movements_amount_check;
ALTER TABLE public.poker_diamond_movements ADD CONSTRAINT poker_diamond_movements_amount_check CHECK (
  ((amount >= 1 AND amount <= 2147483647) AND wallet_journal_id IS NOT NULL)
  OR (action = 'release' AND amount = 0 AND wallet_journal_id IS NULL)
  OR ((amount >= 1 AND amount <= 2147483647) AND wallet_journal_id IS NULL
      AND ((action = 'release' AND source_account LIKE 'arena_custody:%' AND destination_account = 'house'
            AND request->>'action' = 'tournament_drain')
        OR (action = 'reserve' AND source_account LIKE 'house:%' AND destination_account LIKE 'arena_custody:%'
            AND request->>'action' IN ('spin_underwrite', 'guarantee_overlay'))))
);
COMMENT ON CONSTRAINT poker_diamond_movements_amount_check ON public.poker_diamond_movements IS
  'A non-zero movement with a wallet on either side carries its wallet journal row. Only the two house legs (custody to the house by a tournament drain; the house into custody by a Spin underwrite or a guarantee overlay) carry none: no wallet moves (20261007132503).';

ALTER TABLE public.poker_diamond_tournament_ledger DROP CONSTRAINT poker_diamond_tournament_ledger_outflow;
ALTER TABLE public.poker_diamond_tournament_ledger ADD CONSTRAINT poker_diamond_tournament_ledger_outflow CHECK (
  ((kind IN ('prize', 'bounty', 'refund')) AND user_id IS NOT NULL)
  OR (kind = 'fee' AND user_id IS NULL AND prize_part = 0 AND bounty_part = 0)
  OR (kind IN ('entry', 'rebuy', 'reentry', 'addon'))
  OR (kind IN ('spin_underwrite', 'spin_surplus', 'overlay', 'overlay_return')
      AND user_id IS NOT NULL AND custody_id IS NOT NULL
      AND prize_part = amount AND bounty_part = 0 AND fee_part = 0)
);
COMMENT ON CONSTRAINT poker_diamond_tournament_ledger_outflow ON public.poker_diamond_tournament_ledger IS
  'Outflow shapes. A Spin underwrite or surplus and a guarantee overlay or its return are house legs of one entry custody: they name the player and the custody and sit wholly in the prize bank, and carry no wallet journal row (20261007132503).';

-- ---------------------------------------------------------------------------
-- 2. THE DRAIN: A HOUSE-BOUND DRAIN RETIRES IN THE REGISTER, NOT THE JOURNAL.
-- ---------------------------------------------------------------------------
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
END $function$;

-- ---------------------------------------------------------------------------
-- 3. THE FEE: ASSERTED BY THE REGISTER OP IDS THE DRAIN WROTE.
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

  -- Out of the fee parts of the custody rows: each player's own fee, retired
  -- from that player in the register by the drain itself. No wallet journal
  -- row: the fee left the wallet inside the entry's arena_deposit, and a
  -- second row is the double count of 2026-10-07 (20261007132503).
  v_drained := public.fn_poker_diamond_tournament_drain(p_tournament_id, 'fee', v_fee, v_key, 'house', NULL);
  SELECT COALESCE(sum(m.amount),0) INTO v_burned FROM public.ca_mint_ledger m
   WHERE m.asset='diamonds' AND m.action='burn' AND m.holder_type='player'
     AND m.op_id IN (SELECT d->>'register_op_id' FROM jsonb_array_elements(v_drained) d);
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

-- ---------------------------------------------------------------------------
-- 4. THE GUARANTEE OVERLAY: A SHARE PAID INTO CUSTODY IS REGISTERED, NOT
--    JOURNALLED; A RETURN IS ASSERTED BY THE DRAIN'S REGISTER OP IDS.
-- ---------------------------------------------------------------------------
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
END $function$;

-- ---------------------------------------------------------------------------
-- 5. THE SPIN DRAW: THE UNDERWRITE IS REGISTERED, NOT JOURNALLED; THE SURPLUS
--    IS ASSERTED BY THE DRAIN'S REGISTER OP IDS. Everything else byte for byte.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_spin_draw(p_tournament_id uuid, p_launch_id uuid, p_lease_generation uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  c_house constant uuid := '00000000-0000-0000-0000-00000000d1a0';
  v_t public.tournaments%ROWTYPE;
  v_k public.poker_diamond_spin_contracts%ROWTYPE;
  v_source public.poker_diamond_spin_reserve_source%ROWTYPE;
  v_saved public.spin_draw_receipts%ROWTYPE;
  v_c public.poker_diamond_custody%ROWTYPE;
  v_p record; v_e record; v_x record; v_d jsonb; v_tier jsonb;
  v_entrants jsonb; v_count bigint; v_distinct bigint; v_rows_held bigint;
  v_b bigint; v_collected bigint; v_worst bigint; v_cover bigint;
  v_total numeric := 0; v_roll numeric; v_acc numeric := 0; v_pick numeric; v_tiers integer;
  v_cents numeric; v_prize bigint; v_residue numeric; v_underwrite bigint := 0; v_surplus bigint := 0;
  v_held_before numeric; v_held_after numeric; v_supply numeric;
  v_share bigint; v_rest bigint; v_take bigint; v_i integer := 0; v_wallet bigint; v_req uuid;
  v_label text; v_register text; v_registers text[] := ARRAY[]::text[]; v_running numeric;
  v_registered numeric; v_legs jsonb := '[]'::jsonb; v_drained jsonb;
  v_blinds jsonb; v_payouts jsonb; v_manifest jsonb; v_hash text; v_receipt jsonb; v_stamped integer;
  v_played_recovery boolean := false; v_recovery jsonb;
BEGIN
  IF p_tournament_id IS NULL OR p_launch_id IS NULL OR p_lease_generation IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_launch_request');
  END IF;
  -- fn_spin_draw_and_settle_atomic proved the lease, the incomplete launch
  -- receipt of this launch and the maintenance freeze, and holds the receipt
  -- and the parent; this arm is reached from there and from nowhere else.
  SELECT * INTO v_t FROM public.tournaments t WHERE t.id = p_tournament_id FOR UPDATE;
  IF NOT FOUND OR NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE='23514';
  END IF;
  IF v_t.variant IS DISTINCT FROM 'spin' OR upper(COALESCE(v_t.tournament_type,'')) <> 'SPIN'
     OR v_t.max_players IS DISTINCT FROM 3 OR v_t.format_contract IS DISTINCT FROM 'spin-v1'
     OR COALESCE(v_t.buy_in_amount, 0) < 1 OR v_t.buy_in_amount <> trunc(v_t.buy_in_amount)
     OR COALESCE(v_t.buy_in_fee, 0) <> 0 OR COALESCE(v_t.bounty_amount, 0) <> 0
     OR v_t.status IS DISTINCT FROM 'REGISTERING' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_spin_contract');
  END IF;
  v_b := v_t.buy_in_amount::bigint;
  v_collected := 3 * v_b;
  SELECT * INTO v_k FROM public.poker_diamond_spin_contracts k WHERE k.tournament_id = p_tournament_id;
  IF NOT FOUND OR v_k.buy_in IS DISTINCT FROM v_b OR v_k.starting_chips IS DISTINCT FROM v_t.starting_chips
     OR v_k.rule_sha256 IS DISTINCT FROM encode(extensions.digest(v_k.rule_manifest::text, 'sha256'), 'hex') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamond_spin_contract_missing');
  END IF;

  -- The field: three distinct identities, read in the chip authority's order.
  SELECT count(*), count(DISTINCT p.user_id),
         jsonb_agg(jsonb_build_object('registration_id', p.id, 'user_id', p.user_id) ORDER BY p.user_id, p.id)
    INTO v_count, v_distinct, v_entrants
    FROM public.tournament_players p
   WHERE p.tournament_id = p_tournament_id AND p.status IN ('registered', 'playing');
  -- A DEALT SPIN MAY HAVE ONE PROVEN BUSTED AND VACATED ORIGINAL SEAT, as the
  -- chip authority rules. fn_prove_played_spin_launch_recovery (its Diamond
  -- arm: the three entries in custody, the committed draw and its banks) must
  -- prove the original three paid identities, a persisted hand, two exact
  -- live seats and all three bought stacks conserved; then the field is the
  -- original three, the bust included, and the committed receipt below
  -- replays. A fresh two-player field proves nothing and is refused.
  IF v_count = 2 THEN
    v_recovery := public.fn_prove_played_spin_launch_recovery(p_tournament_id);
    IF COALESCE((v_recovery->>'ok')::boolean, false) THEN
      v_played_recovery := true;
      SELECT count(*), count(DISTINCT p.user_id),
             jsonb_agg(jsonb_build_object('registration_id', p.id, 'user_id', p.user_id) ORDER BY p.user_id, p.id)
        INTO v_count, v_distinct, v_entrants
        FROM public.tournament_players p
       WHERE p.tournament_id = p_tournament_id AND p.status IN ('playing', 'eliminated');
    END IF;
  END IF;
  IF v_count <> 3 OR v_distinct <> 3 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'spin_field_unproven');
  END IF;

  -- A committed result is the answer: a new owner or a newer binary cannot
  -- reroll it or rewrite it, and nothing moves twice.
  SELECT * INTO v_saved FROM public.spin_draw_receipts r WHERE r.tournament_id = p_tournament_id;
  IF FOUND THEN
    IF v_saved.launch_id IS DISTINCT FROM p_launch_id OR v_saved.entrants IS DISTINCT FROM v_entrants THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'spin_receipt_roster_mismatch');
    END IF;
    RETURN v_saved.receipt || jsonb_build_object('replay', true);
  END IF;

  -- Each of the three holds exactly one whole entry of the buy-in, active, in
  -- its own custody, and the event has moved nothing but entries and refunds.
  IF EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger l
              WHERE l.tournament_id = p_tournament_id AND l.kind NOT IN ('entry', 'refund')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'spin_paid_entry_unproven');
  END IF;
  FOR v_p IN SELECT p.id, p.user_id FROM public.tournament_players p
              WHERE p.tournament_id = p_tournament_id
                AND (p.status IN ('registered', 'playing')
                     OR (v_played_recovery AND p.status = 'eliminated'))
              ORDER BY p.user_id, p.id LOOP
    SELECT count(*) INTO v_rows_held FROM public.poker_diamond_custody c
     WHERE c.user_id = v_p.user_id AND c.purpose = 'tournament_entry'
       AND c.target_id = p_tournament_id AND c.state <> 'released';
    IF v_rows_held <> 1 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'spin_paid_entry_unproven');
    END IF;
    SELECT c.* INTO v_c FROM public.poker_diamond_custody c
     WHERE c.user_id = v_p.user_id AND c.purpose = 'tournament_entry'
       AND c.target_id = p_tournament_id AND c.state <> 'released'
     FOR UPDATE;
    IF v_c.state IS DISTINCT FROM 'active' OR v_c.balance IS DISTINCT FROM v_b
       OR v_c.entry_key IS DISTINCT FROM 'entry:' || v_p.id::text
       OR (SELECT count(*) FROM public.poker_diamond_tournament_ledger l WHERE l.custody_id = v_c.id) <> 1
       OR NOT EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger l
                       WHERE l.custody_id = v_c.id AND l.kind = 'entry' AND l.user_id = v_p.user_id
                         AND l.registration_id = v_p.id AND l.amount = v_b AND l.prize_part = v_b
                         AND l.bounty_part = 0 AND l.fee_part = 0) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'spin_paid_entry_unproven');
    END IF;
  END LOOP;
  SELECT * INTO v_e FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id);
  IF v_e.prize_balance IS DISTINCT FROM v_collected::numeric OR v_e.bounty_balance <> 0 OR v_e.fee_balance <> 0
     OR public.fn_poker_diamond_tournament_custody(p_tournament_id) IS DISTINCT FROM v_collected THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'spin_entry_escrow_unproven');
  END IF;

  -- The reserve: the authorized source, the cap it was authorized with, and a
  -- balance that covers the whole pinned table. All or nothing: a Diamond Spin
  -- never draws from a table with tiers locked out, so what was advertised is
  -- what is drawn from. Nothing has moved yet, so each refusal is an answer.
  SELECT * INTO v_source FROM public.poker_diamond_spin_reserve_source WHERE id = 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamond_spin_reserve_source_not_authorized');
  END IF;
  v_worst := v_k.worst_excess;
  v_cover := v_k.required_cover;
  IF v_worst > v_source.max_underwrite_per_spin THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamond_spin_reserve_over_its_authorized_cap',
      'worst_excess', v_worst, 'max_underwrite_per_spin', v_source.max_underwrite_per_spin);
  END IF;
  INSERT INTO public.ca_diamond_house (id, balance) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
  SELECT COALESCE(h.balance, 0) INTO v_held_before FROM public.ca_diamond_house h WHERE h.id = 1 FOR UPDATE;
  IF COALESCE(v_held_before, 0) < v_cover THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamond_spin_reserve_cannot_cover_the_table',
      'required_cover', v_cover, 'source_balance', COALESCE(v_held_before, 0));
  END IF;

  -- THE DRAW: one roll of the database's own cryptographic generator over the
  -- pinned table, the arithmetic fn_spin_draw_multiplier rolls with. The
  -- engine's compiled manifest is not an input.
  SELECT COALESCE(sum((t.value->>'freq')::numeric), 0), count(*)
    INTO v_total, v_tiers FROM jsonb_array_elements(v_k.rule_manifest->'tiers') t;
  v_roll := (('x' || encode(extensions.gen_random_bytes(6), 'hex'))::bit(48)::bigint)::numeric
            / 281474976710656::numeric * v_total;
  FOR v_x IN SELECT t.value, t.ordinality FROM jsonb_array_elements(v_k.rule_manifest->'tiers') WITH ORDINALITY t
              ORDER BY t.ordinality LOOP
    v_acc := v_acc + (v_x.value->>'freq')::numeric;
    IF v_roll < v_acc THEN v_pick := (v_x.value->>'multiplier')::numeric; v_tier := v_x.value; EXIT; END IF;
  END LOOP;
  IF v_pick IS NULL THEN
    v_tier := v_k.rule_manifest->'tiers'->(jsonb_array_length(v_k.rule_manifest->'tiers') - 1);
    v_pick := (v_tier->>'multiplier')::numeric;
  END IF;

  -- THE POOL AT THE UNIT: the multiplier times the buy-in floored to a whole
  -- Diamond, and every leg below is computed from that floored pool, so a
  -- residue could only ever stay with the source. The contract admitted only
  -- tables with none; it is proved here before anything moves.
  v_cents := v_pick * v_b * 100;
  v_prize := public.fn_ca_unit_floor_cents(trunc(v_cents)::bigint, 100) / 100;
  v_residue := v_cents - v_prize * 100;
  IF v_residue <> 0 OR v_prize < 1 THEN
    RAISE EXCEPTION 'diamond_spin_prize_not_whole_at_the_unit: %x at % Diamonds leaves % cents', v_pick, v_b, v_residue
      USING ERRCODE='P0404';
  END IF;

  IF v_prize > v_collected THEN
    -- THE SOURCE UNDERWRITES the pool above the three entries, into the
    -- event's custody before it may launch: a house burn on the register, and
    -- a player-side register mint for each custody share it lands in, split
    -- as evenly as whole Diamonds allow (the remainder to the earliest entries).
    v_underwrite := v_prize - v_collected;
    UPDATE public.ca_diamond_house SET balance = balance - v_underwrite, updated_at = now()
     WHERE id = 1 RETURNING balance INTO v_held_after;
    SELECT COALESCE(SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END), 0) INTO v_supply
      FROM public.ca_mint_ledger m WHERE m.asset = 'diamonds';
    INSERT INTO public.ca_mint_ledger
      (op_id, action, asset, holder_type, holder_id, holder_label, amount, balance_before, balance_after, supply_after, reason)
    VALUES
      ('poker-spin-underwrite:' || p_tournament_id::text, 'burn', 'diamonds', 'house', c_house, 'the house',
       v_underwrite, v_held_before, v_held_after, v_supply - v_underwrite,
       'Diamond Spin prize pool underwritten from the house into the event custody ('
       || COALESCE(v_t.name, 'spin') || ', ' || v_pick || 'x), DR14 (poker_spin_underwrite)');
    SET CONSTRAINTS public.zzz_diamond_entry_custody_is_the_entry IMMEDIATE;
    v_running := v_supply - v_underwrite;
    v_share := v_underwrite / 3;
    v_rest := v_underwrite % 3;
    FOR v_c IN SELECT c.* FROM public.poker_diamond_custody c
                WHERE c.purpose = 'tournament_entry' AND c.target_id = p_tournament_id AND c.state = 'active'
                ORDER BY c.created_at, c.id FOR UPDATE LOOP
      v_i := v_i + 1;
      v_take := v_share + CASE WHEN v_i <= v_rest THEN 1 ELSE 0 END;
      CONTINUE WHEN v_take = 0;
      -- The wallet does not move: the share lands in custody and is paid out
      -- only as a prize. SO IT WRITES NO WALLET JOURNAL ROW (20261007132503);
      -- the register counts custody Diamonds as the player's, so the share is
      -- minted to the player there, directly, with the wallet unchanged on
      -- both sides. Not the earn ledger either (a prize pool is not a reward
      -- any daily cap may shorten).
      SELECT COALESCE(pr.diamonds, 0), COALESCE(NULLIF(btrim(pr.username), ''), pr.full_name, pr.id::text)
        INTO v_wallet, v_label FROM public.profiles pr WHERE pr.id = v_c.user_id;
      v_register := 'poker-spin-underwrite:' || p_tournament_id::text || ':' || v_c.id::text;
      v_running := v_running + v_take;
      INSERT INTO public.ca_mint_ledger
        (op_id, action, asset, holder_type, holder_id, holder_label, amount, balance_before, balance_after, supply_after, reason)
      VALUES (v_register, 'mint', 'diamonds', 'player', v_c.user_id, COALESCE(v_label, v_c.user_id::text), v_take,
        v_wallet, v_wallet, v_running,
        'Diamond Spin prize pool underwritten by the house into this player''s entry custody: ' || COALESCE(v_t.name, 'spin')
          || ' drew ' || v_pick || 'x. Paid out only as prizes; the wallet does not move.');
      v_registers := v_registers || v_register;
      v_req := uuid_in(md5('poker-spin-underwrite:' || p_tournament_id::text || ':' || v_c.id::text)::cstring);
      -- The movement first, then the balance (P0814 is checked at the update).
      INSERT INTO public.poker_diamond_movements(request_id, custody_id, user_id, action, amount,
        source_account, destination_account, wallet_journal_id, request, receipt)
      VALUES (v_req, v_c.id, v_c.user_id, 'reserve', v_take, 'house:' || c_house::text, 'arena_custody:' || v_c.id::text,
        NULL,
        jsonb_build_object('action', 'spin_underwrite', 'bank', 'prize', 'tournament_id', p_tournament_id,
                           'custody_id', v_c.id, 'amount', v_take),
        jsonb_build_object('success', true, 'custody_id', v_c.id, 'amount', v_take,
                           'custody_balance', v_c.balance + v_take, 'journal_id', NULL, 'register_op_id', v_register));
      UPDATE public.poker_diamond_custody SET balance = balance + v_take WHERE id = v_c.id;
      INSERT INTO public.poker_diamond_tournament_ledger(tournament_id, arena_id, user_id, custody_id, kind, amount,
        prize_part, bounty_part, fee_part, idempotency_key, wallet_journal_id, request)
      VALUES (p_tournament_id, v_t.club_id, v_c.user_id, v_c.id, 'spin_underwrite', v_take, v_take, 0, 0,
        'poker-spin-underwrite:' || p_tournament_id::text || ':' || v_c.id::text, NULL,
        jsonb_build_object('kind', 'spin_underwrite', 'multiplier', v_pick, 'source', 'house', 'request_id', v_req,
                           'register_op_id', v_register));
      v_legs := v_legs || jsonb_build_array(jsonb_build_object('custody_id', v_c.id, 'user_id', v_c.user_id,
                  'amount', v_take, 'journal_id', NULL, 'register_op_id', v_register, 'leg', 'spin_underwrite'));
    END LOOP;
    SET CONSTRAINTS public.zzz_diamond_entry_custody_is_the_entry DEFERRED;
    SELECT COALESCE(sum(m.amount), 0) INTO v_registered FROM public.ca_mint_ledger m
     WHERE m.asset = 'diamonds' AND m.action = 'mint' AND m.holder_type = 'player'
       AND m.op_id = ANY (v_registers);
    IF v_registered IS DISTINCT FROM v_underwrite::numeric THEN
      RAISE EXCEPTION 'diamond_spin_underwrite_not_registered_to_players (% of %)', v_registered, v_underwrite
        USING ERRCODE='P0404';
    END IF;
  ELSIF v_prize < v_collected THEN
    -- THE SURPLUS RETURNS to the source: the entries above the pool leave the
    -- prize bank through the drain (each player's share retired from that
    -- player in the register by the drain itself, with no wallet journal row:
    -- the wallet paid it once, at the entry; 20261007132503) and the house is
    -- minted exactly that, as the Phase 8 fee settlement banks a fee.
    v_surplus := v_collected - v_prize;
    v_drained := public.fn_poker_diamond_tournament_drain(p_tournament_id, 'prize', v_surplus,
                   'poker-spin-surplus:' || p_tournament_id::text, 'house', NULL);
    SELECT COALESCE(sum(m.amount), 0) INTO v_registered FROM public.ca_mint_ledger m
     WHERE m.asset = 'diamonds' AND m.action = 'burn' AND m.holder_type = 'player'
       AND m.op_id IN (SELECT d->>'register_op_id' FROM jsonb_array_elements(v_drained) d);
    IF v_registered IS DISTINCT FROM v_surplus::numeric THEN
      RAISE EXCEPTION 'diamond_spin_surplus_not_retired_from_players (% of %)', v_registered, v_surplus
        USING ERRCODE='P0404';
    END IF;
    UPDATE public.ca_diamond_house SET balance = balance + v_surplus, updated_at = now()
     WHERE id = 1 RETURNING balance INTO v_held_after;
    SELECT COALESCE(SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END), 0) INTO v_supply
      FROM public.ca_mint_ledger m WHERE m.asset = 'diamonds';
    INSERT INTO public.ca_mint_ledger
      (op_id, action, asset, holder_type, holder_id, holder_label, amount, balance_before, balance_after, supply_after, reason)
    VALUES
      ('poker-spin-surplus:' || p_tournament_id::text, 'mint', 'diamonds', 'house', c_house, 'the house',
       v_surplus, v_held_before, v_held_after, v_supply + v_surplus,
       'Diamond Spin entries above the drawn prize pool returned from the event custody to the house ('
       || COALESCE(v_t.name, 'spin') || ', ' || v_pick || 'x), DR14 (poker_spin_surplus)');
    FOR v_d IN SELECT d.value FROM jsonb_array_elements(v_drained) d LOOP
      INSERT INTO public.poker_diamond_tournament_ledger(tournament_id, arena_id, user_id, custody_id, kind, amount,
        prize_part, bounty_part, fee_part, idempotency_key, wallet_journal_id, request)
      VALUES (p_tournament_id, v_t.club_id, (v_d->>'user_id')::uuid, (v_d->>'custody_id')::uuid, 'spin_surplus',
        (v_d->>'amount')::bigint, (v_d->>'amount')::bigint, 0, 0,
        'poker-spin-surplus:' || p_tournament_id::text || ':' || (v_d->>'custody_id'), NULL,
        jsonb_build_object('kind', 'spin_surplus', 'multiplier', v_pick, 'destination', 'house',
                           'request_id', v_d->>'request_id', 'register_op_id', v_d->>'register_op_id'));
      v_legs := v_legs || jsonb_build_array(v_d || jsonb_build_object('leg', 'spin_surplus'));
    END LOOP;
  ELSE
    v_held_after := v_held_before;
  END IF;

  -- The banks and the custody agree, at the drawn pool, whole.
  SELECT * INTO v_e FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id);
  IF v_e.prize_balance IS DISTINCT FROM v_prize::numeric OR v_e.bounty_balance <> 0 OR v_e.fee_balance <> 0
     OR public.fn_poker_diamond_tournament_custody(p_tournament_id) IS DISTINCT FROM v_prize THEN
    RAISE EXCEPTION 'diamond_tournament_escrow_disagrees_with_custody' USING ERRCODE='P0404';
  END IF;
  -- An escrow shadow already open follows the legs, as a chip draw's does.
  IF EXISTS (SELECT 1 FROM public.tournament_escrow x WHERE x.tournament_id = p_tournament_id) THEN
    PERFORM public.fn_ca_escrow_apply(p_tournament_id, 'diamond spin reserve',
      p_reserve_out => v_surplus, p_reserve_in => v_underwrite);
  END IF;

  -- THE RECEIPT, in the chip receipt's shape (the engine reads both with one
  -- reader, readFundedSpinDraw), frozen with the code that drew it.
  v_blinds := v_tier->'blind_structure';
  v_payouts := v_tier->'payout_structure';
  v_manifest := v_k.rule_manifest || jsonb_build_object(
    'contract_sha256', v_k.rule_sha256,
    'draw_function_md5', md5(pg_get_functiondef('public.fn_poker_diamond_spin_draw(uuid,uuid,uuid)'::regprocedure)));
  v_hash := encode(extensions.digest(v_manifest::text, 'sha256'), 'hex');
  v_receipt := jsonb_build_object(
    'ok', true, 'replay', false, 'asset', 'diamonds', 'unit_cents', 100,
    'money_path', 'fn_poker_diamond_spin_draw',
    'tournament_id', p_tournament_id, 'launch_id', p_launch_id,
    'multiplier', v_pick, 'prize_pool', v_prize, 'buy_in', v_b, 'starting_chips', v_t.starting_chips,
    'blind_structure', v_blinds, 'payout_structure', v_payouts, 'locked', '[]'::jsonb, 'entrants', v_entrants,
    'rule_manifest', v_manifest, 'rule_sha256', v_hash, 'rule_provenance', 'at_draw',
    'collected', v_collected, 'house_rake', 0, 'underwrite', v_underwrite, 'surplus', v_surplus, 'residue', 0,
    'pool_covered', v_prize, 'operator_shortfall', 0, 'custody_legs', v_legs,
    'reserve_source', v_source.source_account,
    'source_balance_before', v_held_before, 'source_balance_after', v_held_after,
    'draw_inputs', jsonb_build_object('roll', v_roll, 'total_freq', v_total, 'eligible_count', v_tiers,
      'required_cover', v_cover, 'worst_excess', v_worst,
      'max_underwrite_per_spin', v_source.max_underwrite_per_spin, 'reserve_ruling', v_source.ruling));
  INSERT INTO public.spin_draw_receipts(tournament_id, launch_id, lease_generation,
    rule_manifest, rule_sha256, entrants, receipt)
  VALUES (p_tournament_id, p_launch_id, p_lease_generation, v_manifest, v_hash, v_entrants, v_receipt);

  -- The tournament row is the contract the engine, the ladder trigger and the
  -- launch proof read back, stamped in this transaction and read back exactly.
  UPDATE public.tournaments
     SET spin_multiplier   = v_pick,
         prize_pool        = v_prize,
         spin_locked_tiers = '[]'::jsonb,
         blind_structure   = v_blinds::text,
         payout_structure  = v_payouts::text
   WHERE id = p_tournament_id;
  GET DIAGNOSTICS v_stamped = ROW_COUNT;
  IF v_stamped <> 1 OR NOT EXISTS (
       SELECT 1 FROM public.tournaments t
        WHERE t.id = p_tournament_id
          AND t.spin_multiplier IS NOT DISTINCT FROM v_pick
          AND t.prize_pool IS NOT DISTINCT FROM v_prize::numeric
          AND t.spin_locked_tiers IS NOT DISTINCT FROM '[]'::jsonb) THEN
    RAISE EXCEPTION 'Spin % tournament contract did not read back exactly', p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  RETURN v_receipt;
END $function$;

-- ---------------------------------------------------------------------------
-- 6. GRANTS, EXACTLY AS LIVE: the four money steps are owner-only.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_drain(uuid, text, bigint, text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_settle_fee(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_settle_overlay(uuid, text, numeric) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_spin_draw(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Watched guards moved on purpose, in this transaction.
SELECT public.fn_ca_declare_guard_redefinition(n, '20261007132503_the_diamond_tournament_lane_leaves_custody_without_a_wallet_')
  FROM unnest(ARRAY['fn_poker_diamond_tournament_drain', 'fn_poker_diamond_tournament_settle_fee']) AS n;

-- ---------------------------------------------------------------------------
-- 7. PROOF, IN THIS TRANSACTION.
-- ---------------------------------------------------------------------------
DO $proof$
DECLARE v_sig text; v_diff numeric;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.fn_poker_diamond_tournament_drain(uuid,text,bigint,text,text,uuid)',
    'public.fn_poker_diamond_tournament_settle_overlay(uuid,text,numeric)',
    'public.fn_poker_diamond_spin_draw(uuid,uuid,uuid)'] LOOP
    IF position('INSERT INTO public.diamond_transactions' IN pg_get_functiondef(v_sig::regprocedure)) > 0 THEN
      RAISE EXCEPTION '% still writes a wallet journal row for a movement that is not in the wallet', v_sig;
    END IF;
  END LOOP;
  FOREACH v_sig IN ARRAY ARRAY[
    'public.fn_poker_diamond_tournament_settle_fee(uuid,text)',
    'public.fn_poker_diamond_tournament_settle_overlay(uuid,text,numeric)',
    'public.fn_poker_diamond_spin_draw(uuid,uuid,uuid)'] LOOP
    IF position('diamond_tx_id' IN pg_get_functiondef(v_sig::regprocedure)) > 0 THEN
      RAISE EXCEPTION '% still asserts its register rows through journal ids', v_sig;
    END IF;
  END LOOP;
  IF (SELECT def_hash FROM public.ca_guard_defs WHERE proname = 'fn_poker_diamond_tournament_drain')
     IS DISTINCT FROM (SELECT md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)) FROM pg_proc p
                        JOIN pg_namespace n ON n.oid = p.pronamespace
                       WHERE n.nspname = 'public' AND p.proname = 'fn_poker_diamond_tournament_drain') THEN
    RAISE EXCEPTION 'the drain guard baseline was not moved to this definition';
  END IF;
  SELECT difference INTO v_diff FROM public.fn_ca_diamond_register_vs_supply();
  IF v_diff IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole (difference %)', v_diff;
  END IF;
  RAISE NOTICE 'the tournament lane writes no wallet journal row for a house leg; guards declared; identity 0';
END
$proof$;

-- ---------------------------------------------------------------------------
-- 8. THE RECONCILIATION COMPARES WALLET LEGS TO THE JOURNAL, NOT HOUSE LEGS.
--    Last in this file, because tests/the-route-and-the-client-agree.law.test.ts
--    reads the keys it emits from its definition to the end of the file.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_diamond_arena_reconciliation(p_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
    v_user      uuid := COALESCE(p_user_id, auth.uid());
    v_role      text := COALESCE(auth.jwt() ->> 'role', current_user);
    v_sessions  integer := 0;
    v_open      integer := 0;
    v_buy_ins   bigint  := 0;
    v_cash_outs bigint  := 0;
    v_in_play   bigint  := 0;
    v_settled   bigint  := 0;
    v_unmatched jsonb   := '[]'::jsonb;
BEGIN
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501';
    END IF;
    IF v_role <> 'service_role' AND v_user IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'arena_reconciliation_is_own_only' USING ERRCODE = '42501';
    END IF;

    SELECT COUNT(*)::integer,
           COUNT(*) FILTER (WHERE state <> 'released')::integer,
           COALESCE(SUM(balance) FILTER (WHERE state <> 'released'), 0)::bigint
      INTO v_sessions, v_open, v_in_play
      FROM public.poker_diamond_custody
     WHERE user_id = v_user;

    SELECT COALESCE(SUM(amount) FILTER (WHERE action = 'reserve'), 0)::bigint,
           COALESCE(SUM(amount) FILTER (WHERE action = 'release'), 0)::bigint
      INTO v_buy_ins, v_cash_outs
      FROM public.poker_diamond_movements
     WHERE user_id = v_user;

    SELECT COALESCE(SUM(CASE WHEN m.action = 'release' THEN m.amount ELSE -m.amount END), 0)::bigint
      INTO v_settled
      FROM public.poker_diamond_movements m
      JOIN public.poker_diamond_custody c ON c.id = m.custody_id
     WHERE m.user_id = v_user AND c.state = 'released';

    -- A WALLET LEG IS MATCHED TO ITS WALLET JOURNAL ROW; A HOUSE LEG HAS NONE
    -- (20261007132503). A movement between custody and the house (a tournament
    -- fee, a Spin surplus or underwrite, a guarantee overlay or its return)
    -- never touches a wallet, so from that version on it carries no journal
    -- row, and the house legs written before it point at journal rows that
    -- recorded a wallet movement that never happened (settled by correcting
    -- rows). Comparing a house leg to a journal row reported a fee as a
    -- mismatch it never was.
    SELECT COALESCE(v_unmatched || jsonb_agg(jsonb_build_object(
               'custody_id', m.custody_id,
               'request_id', m.request_id,
               'reason', CASE
                   WHEN j.id IS NULL THEN 'journal_missing'
                   WHEN m.action = 'reserve' AND j.amount <> -m.amount THEN 'reserve_amount_mismatch'
                   WHEN m.action = 'release' AND j.amount <> m.amount THEN 'release_amount_mismatch'
               END)), v_unmatched)
      INTO v_unmatched
      FROM public.poker_diamond_movements m
      LEFT JOIN public.diamond_transactions j ON j.id = m.wallet_journal_id
     WHERE m.user_id = v_user
       AND m.wallet_journal_id IS NOT NULL
       AND m.destination_account <> 'house'
       AND m.source_account NOT LIKE 'house:%'
       AND (j.id IS NULL
            OR (m.action = 'reserve' AND j.amount <> -m.amount)
            OR (m.action = 'release' AND j.amount <> m.amount));

    SELECT COALESCE(v_unmatched || jsonb_agg(jsonb_build_object(
               'custody_id', c.id, 'request_id', NULL, 'reason', 'release_movement_missing')), v_unmatched)
      INTO v_unmatched
      FROM public.poker_diamond_custody c
     WHERE c.user_id = v_user AND c.state = 'released'
       AND NOT EXISTS (SELECT 1 FROM public.poker_diamond_movements m
                        WHERE m.custody_id = c.id AND m.action = 'release');

    SELECT COALESCE(v_unmatched || jsonb_agg(jsonb_build_object(
               'custody_id', c.id, 'request_id', NULL, 'reason', 'seat_stack_drift')), v_unmatched)
      INTO v_unmatched
      FROM public.poker_diamond_custody c
      JOIN public.table_seats s ON s.id = c.seat_id
     WHERE c.user_id = v_user AND c.state = 'active' AND c.purpose = 'cash_seat'
       AND s.left_at IS NULL AND s.stack IS DISTINCT FROM c.balance;

    RETURN jsonb_build_object(
        'user_id',            v_user,
        'sessions',           v_sessions,
        'open_sessions',      v_open,
        'buy_ins',            v_buy_ins,
        'cash_outs',          v_cash_outs,
        'in_play',            v_in_play,
        'net_result_settled', v_settled,
        'unmatched',          v_unmatched,
        'balanced',           jsonb_array_length(v_unmatched) = 0,
        'read_at',            now()
    );
END;
$function$;

-- The player's own read and the service role's, exactly as live.
REVOKE ALL ON FUNCTION public.fn_diamond_arena_reconciliation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_arena_reconciliation(uuid) TO authenticated, service_role;

COMMIT;
