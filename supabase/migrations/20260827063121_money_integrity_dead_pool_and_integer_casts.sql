-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827063121; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- MONEY INTEGRITY 2026-08-27 — three confirmed defects, verified against the
-- live function bodies before this migration was written.
--
-- 1. atomic_table_withdraw credited the DEAD pool. `public.wallets` has been
--    frozen since 2026-08-21 and nothing reads it, so a partial cash-out from
--    the table cashier took chips OFF the felt and put them nowhere, while the
--    UI cheerfully added them to the displayed balance. No chips have been
--    destroyed yet (zero wallet_transactions rows with this description) —
--    the next use would have been the first. It now credits through
--    atomic_credit_wallet_and_log, the audited path that resolves the seat's
--    club (then the player's home club) and writes club_members.chip_balance,
--    falling back to the global wallet only for a player with no club at all.
--
-- 2/3. fn_transfer_chips and distribute_chips cast money to ::integer when
--    writing club_members.chip_balance — a numeric(_,2) column. A 10.50
--    transfer passed a `balance >= amount` check and then debited 11, pushing
--    the sender negative, and the ledger row recorded 10.50 for a movement of
--    11. distribute_chips debited the treasury exactly and credited the member
--    rounded, so it minted or destroyed up to 0.50 per distribution and
--    returned a member_after that disagreed with the row it had just written.
--    Both are currently latent only because every caller floors upstream. The
--    sibling transfer_chips_agent_to_player already carries the comment "no
--    ::integer cast — that truncation lost fractions"; the fix never reached
--    these two.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.atomic_table_withdraw(p_user_id uuid, p_table_id uuid, p_amount numeric, p_apply_to_seat boolean DEFAULT true)
 RETURNS numeric
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_new_balance numeric;
  v_stack numeric;
  v_club_id uuid;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Withdraw amount must be positive';
  END IF;

  SELECT stack INTO v_stack FROM table_seats
   WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Player not seated at this table';
  END IF;

  -- Reject over-withdraw: cannot cash out more than the seated stack.
  IF p_amount > v_stack THEN
    RAISE EXCEPTION 'Withdraw exceeds seated stack';
  END IF;

  IF p_apply_to_seat THEN
    UPDATE table_seats
       SET stack = stack - p_amount
     WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL;
  END IF;

  -- DEAD POOL FIX 2026-08-27: credit the LIVE pool through the audited path.
  -- It writes wallet_transactions itself for category 'cashout', so the
  -- ledger line this function always produced is preserved.
  PERFORM public.atomic_credit_wallet_and_log(
    p_user_id, p_amount, 'cashout',
    'Table withdraw (partial cash-out)', p_table_id, NULL, NULL, NULL);

  -- Report the balance the credit actually landed in, resolved the same way.
  SELECT ts.club_id INTO v_club_id
    FROM table_seats ts
   WHERE ts.table_id = p_table_id AND ts.user_id = p_user_id
   ORDER BY ts.joined_at DESC LIMIT 1;
  IF v_club_id IS NULL THEN
    v_club_id := public.fn_player_home_club(p_user_id, NULL);
  END IF;

  IF v_club_id IS NOT NULL THEN
    SELECT COALESCE(chip_balance, 0) INTO v_new_balance
      FROM club_members WHERE user_id = p_user_id AND club_id = v_club_id;
  ELSE
    SELECT COALESCE(balance, 0) INTO v_new_balance
      FROM wallets WHERE user_id = p_user_id AND wallet_type = 'PLAYER';
  END IF;

  RETURN COALESCE(v_new_balance, 0);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_transfer_chips(p_club_id uuid, p_from_user_id uuid, p_to_user_id uuid, p_amount numeric, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_from_before numeric;
  v_to_before numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  SELECT COALESCE(chip_balance, 0) INTO v_from_before
  FROM club_members
  WHERE club_id = p_club_id AND user_id = p_from_user_id FOR UPDATE;

  IF v_from_before IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'sender is not a member of this club');
  END IF;

  IF v_from_before < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient chips', 'balance', v_from_before);
  END IF;

  -- PRECISION FIX 2026-08-27: no ::integer cast. chip_balance is numeric(_,2)
  -- and the sufficiency check above is made in numeric — rounding the write
  -- debited more than was checked and could push the sender negative.
  UPDATE club_members
  SET chip_balance = chip_balance - p_amount, updated_at = NOW()
  WHERE club_id = p_club_id AND user_id = p_from_user_id;

  SELECT COALESCE(chip_balance, 0) INTO v_to_before
  FROM club_members
  WHERE club_id = p_club_id AND user_id = p_to_user_id FOR UPDATE;

  IF v_to_before IS NULL THEN
    INSERT INTO club_members (club_id, user_id, role, chip_balance, joined_at, created_at, updated_at, status, is_active)
    VALUES (p_club_id, p_to_user_id, 'player', p_amount, NOW(), NOW(), NOW(), 'active', true)
    ON CONFLICT (club_id, user_id) DO UPDATE
      SET chip_balance = COALESCE(club_members.chip_balance, 0) + EXCLUDED.chip_balance,
          updated_at = NOW();
  ELSE
    UPDATE club_members
    SET chip_balance = COALESCE(chip_balance, 0) + p_amount, updated_at = NOW()
    WHERE club_id = p_club_id AND user_id = p_to_user_id;
  END IF;

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, p_from_user_id, p_to_user_id, p_amount,
    'peer_transfer', COALESCE(p_reason, 'Peer chip transfer'),
    COALESCE(v_to_before, 0) + p_amount, NOW()
  );

  RETURN jsonb_build_object('success', true, 'amount', p_amount);
END;
$function$;

CREATE OR REPLACE FUNCTION public.distribute_chips(p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_distributed_by uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_treasury_before numeric;
  v_treasury_after numeric;
  v_member_before numeric;
  v_member_after numeric;
  v_is_member boolean;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM club_members
    WHERE club_id = p_club_id
      AND user_id = p_distributed_by
      AND role IN ('agent', 'super_agent', 'owner', 'co_owner', 'admin')
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized to distribute');
  END IF;

  SELECT COALESCE(chip_pool, 0) INTO v_treasury_before
  FROM clubs WHERE id = p_club_id FOR UPDATE;

  IF v_treasury_before IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'club not found');
  END IF;

  IF v_treasury_before < p_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'insufficient club treasury',
      'treasury', v_treasury_before,
      'requested', p_amount
    );
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM club_members
    WHERE club_id = p_club_id AND user_id = p_to_user_id
  ) INTO v_is_member;

  IF NOT v_is_member THEN
    RETURN jsonb_build_object('success', false, 'error', 'recipient is not a member of this club');
  END IF;

  UPDATE clubs
  SET chip_pool = chip_pool - p_amount,
      updated_at = NOW()
  WHERE id = p_club_id;
  v_treasury_after := v_treasury_before - p_amount;

  SELECT COALESCE(chip_balance, 0) INTO v_member_before
  FROM club_members
  WHERE club_id = p_club_id AND user_id = p_to_user_id FOR UPDATE;

  -- PRECISION FIX 2026-08-27: the treasury was debited in exact numeric and
  -- the member credited with ::integer, so any fractional distribution minted
  -- or destroyed up to 0.50. v_member_after now comes from RETURNING rather
  -- than being recomputed, so the audit log cannot disagree with the row.
  UPDATE club_members
  SET chip_balance = COALESCE(chip_balance, 0) + p_amount,
      updated_at = NOW()
  WHERE club_id = p_club_id AND user_id = p_to_user_id
  RETURNING chip_balance INTO v_member_after;

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, p_distributed_by, p_to_user_id, p_amount,
    'agent_distribution', 'Treasury distribution', v_treasury_after, NOW()
  );

  RETURN jsonb_build_object(
    'success', true,
    'amount', p_amount,
    'treasury_before', v_treasury_before,
    'treasury_after', v_treasury_after,
    'member_before', v_member_before,
    'member_after', v_member_after
  );
END;
$function$;
