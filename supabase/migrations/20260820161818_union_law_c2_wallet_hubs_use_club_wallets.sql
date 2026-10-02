-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820161818 "union_law_c2_wallet_hubs_use_club_wallets"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3f23c9fbf26123c3221178a617274a71 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- C2 — THE SHARED WALLET HUBS USE CLUB WALLETS (2026-08-20)
--
-- The global wallet was still being written every few seconds. Tracing the live
-- ledger found the traffic was NOT coming from the paths converted earlier but
-- from two shared helpers underneath them:
--
--   atomic_credit_wallet_and_log   tournament prizes, bounties, cash-outs
--   atomic_deduct_wallet_and_log   tournament buy-ins
--
-- Callers include fn_register_for_tournament, fn_register_horse_for_tournament
-- and fn_finalize_bounty_pool. Converting the two hubs fixes every one of them
-- at once instead of chasing each caller.
--
-- Both also carried HARDCODED club fallbacks — the credit hub fell back to the
-- Midway union id and the debit hub to SHARK CLUB — so unresolved money was
-- being attributed to a club at random. That is removed: the club is resolved
-- properly, or the operation fails rather than guessing.
--
-- Rule applied: a player with any club membership is Club Arena money and must
-- use a club wallet. A user with no membership anywhere is a smarter.poker
-- user, where the global wallet is legitimate.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.atomic_credit_wallet_and_log(p_user_id uuid, p_amount numeric, p_category text DEFAULT 'credit'::text, p_description text DEFAULT ''::text, p_table_id uuid DEFAULT NULL::uuid, p_hand_id uuid DEFAULT NULL::uuid, p_related_entity_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_club_id uuid;
  v_inserted integer;
  v_new_balance numeric;
  v_has_club boolean;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO wallet_credit_idempotency (key, user_id, amount)
    VALUES (p_idempotency_key, p_user_id, p_amount)
    ON CONFLICT (key) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted = 0 THEN RETURN true; END IF;
  END IF;

  -- Resolve the club whose wallet this belongs to: the seat's club first
  -- (real provenance), then the player's home club.
  IF p_table_id IS NOT NULL THEN
    SELECT ts.club_id INTO v_club_id
      FROM table_seats ts
     WHERE ts.table_id = p_table_id AND ts.user_id = p_user_id
     ORDER BY ts.joined_at DESC LIMIT 1;
  END IF;
  IF v_club_id IS NULL THEN
    v_club_id := public.fn_player_home_club(p_user_id, NULL);
  END IF;

  IF v_club_id IS NOT NULL THEN
    -- CLUB ARENA: the club's own standalone wallet.
    PERFORM public.fn_ensure_club_wallet(p_user_id, v_club_id);
    UPDATE club_members
       SET chip_balance = COALESCE(chip_balance,0) + p_amount, updated_at = now()
     WHERE user_id = p_user_id AND club_id = v_club_id
     RETURNING chip_balance INTO v_new_balance;
  ELSE
    SELECT EXISTS (SELECT 1 FROM club_members m WHERE m.user_id = p_user_id) INTO v_has_club;
    IF v_has_club THEN
      RAISE EXCEPTION 'No club wallet resolves for Club Arena credit to player %', p_user_id;
    END IF;
    -- smarter.poker user: no club anywhere, global wallet is their only wallet.
    UPDATE wallets SET balance = COALESCE(balance,0) + p_amount, updated_at = now()
     WHERE user_id = p_user_id AND wallet_type = 'PLAYER'
     RETURNING balance INTO v_new_balance;
    IF NOT FOUND THEN
      INSERT INTO wallets (user_id, wallet_type, balance, locked_balance)
      VALUES (p_user_id, 'PLAYER', p_amount, 0)
      ON CONFLICT (user_id, wallet_type) DO UPDATE
        SET balance = wallets.balance + p_amount, updated_at = now()
      RETURNING balance INTO v_new_balance;
    END IF;
  END IF;

  IF p_category = 'cashout' THEN
    INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category,
                                     description, table_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'credit', p_amount, 'cashout',
            COALESCE(NULLIF(p_description, ''), 'Cash-out to club wallet'),
            p_table_id, v_new_balance);
  END IF;

  IF v_club_id IS NOT NULL THEN
    INSERT INTO chip_transactions (club_id, to_user_id, amount, transaction_type,
                                   notes, table_id, metadata)
    VALUES (v_club_id, p_user_id, p_amount, p_category,
            COALESCE(NULLIF(p_description, ''), 'Wallet credit'), p_table_id,
            CASE WHEN p_category = 'cashout'
                 THEN jsonb_build_object('mirrored_to_wallet', true)
                 ELSE '{}'::jsonb END);
  END IF;

  RETURN true;
END; $function$;

CREATE OR REPLACE FUNCTION public.atomic_deduct_wallet_and_log(p_user_id uuid, p_amount numeric, p_category text DEFAULT 'debit'::text, p_description text DEFAULT ''::text, p_table_id uuid DEFAULT NULL::uuid, p_hand_id uuid DEFAULT NULL::uuid, p_related_entity_id uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_balance numeric; v_club_id uuid; v_has_club boolean;
BEGIN
  IF p_table_id IS NOT NULL THEN
    SELECT ts.club_id INTO v_club_id
      FROM table_seats ts
     WHERE ts.table_id = p_table_id AND ts.user_id = p_user_id
     ORDER BY ts.joined_at DESC LIMIT 1;
  END IF;
  IF v_club_id IS NULL THEN
    v_club_id := public.fn_player_home_club(p_user_id, NULL);
  END IF;

  IF v_club_id IS NOT NULL THEN
    PERFORM public.fn_ensure_club_wallet(p_user_id, v_club_id);
    SELECT chip_balance INTO v_balance FROM club_members
     WHERE user_id = p_user_id AND club_id = v_club_id FOR UPDATE;
    IF v_balance IS NULL OR v_balance < p_amount THEN RETURN false; END IF;
    UPDATE club_members SET chip_balance = chip_balance - p_amount, updated_at = now()
     WHERE user_id = p_user_id AND club_id = v_club_id;

    INSERT INTO chip_transactions (club_id, from_user_id, amount, transaction_type, notes)
    VALUES (v_club_id, p_user_id, p_amount, p_category,
            COALESCE(NULLIF(p_description, ''), 'Wallet debit'));
    RETURN true;
  END IF;

  SELECT EXISTS (SELECT 1 FROM club_members m WHERE m.user_id = p_user_id) INTO v_has_club;
  IF v_has_club THEN
    RAISE EXCEPTION 'No club wallet resolves for Club Arena debit from player %', p_user_id;
  END IF;

  -- smarter.poker user only.
  SELECT balance INTO v_balance FROM wallets
   WHERE user_id = p_user_id AND wallet_type = 'PLAYER' FOR UPDATE;
  IF v_balance IS NULL OR v_balance < p_amount THEN RETURN false; END IF;
  UPDATE wallets SET balance = balance - p_amount, updated_at = now()
   WHERE user_id = p_user_id AND wallet_type = 'PLAYER';
  RETURN true;
END; $function$;

