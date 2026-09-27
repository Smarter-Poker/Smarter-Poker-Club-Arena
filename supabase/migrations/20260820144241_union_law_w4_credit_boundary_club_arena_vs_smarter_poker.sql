-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820144241 "union_law_w4_credit_boundary_club_arena_vs_smarter_poker"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 9c88e641a472f78491ab51c3fb023314 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- W4 — DRAW THE BOUNDARY CORRECTLY: CLUB ARENA vs SMARTER.POKER (2026-08-20)
--
-- REGRESSION I INTRODUCED IN W1c: credit_player_wallet was made to hard-fail
-- when no club resolves. But it is also called by claim_daily_bonus and
-- fn_purchase_chips, and 431 real users hold NO club membership at all — they
-- are pure smarter.poker users. Those two features would have thrown for every
-- one of them.
--
-- The owner's rule is precise: "There is NEVER a global wallet EXCEPT for
-- inside smarter.poker." So the boundary is membership, not the function:
--
--   * CLUB ARENA money — anything tournament-keyed, or any credit for a player
--     who HAS a club — must land in that club's standalone wallet. Never
--     global, never pooled. A tournament credit that cannot resolve a club is
--     a hard error and raises an alert, because that IS Club Arena money.
--
--   * SMARTER.POKER money — a credit for a user with no club membership
--     anywhere. There is no Club Arena wallet to use, and the global wallet is
--     exactly what the rule permits here.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.credit_player_wallet(p_user_id uuid, p_amount numeric, p_idempotency_key text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_inserted integer; v_tourn uuid; v_club uuid; v_balance numeric;
  v_is_tournament boolean := false; v_has_any_club boolean;
BEGIN
    IF p_idempotency_key IS NOT NULL THEN
        INSERT INTO wallet_credit_idempotency (key, user_id, amount)
        VALUES (p_idempotency_key, p_user_id, p_amount)
        ON CONFLICT (key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        IF v_inserted = 0 THEN RETURN; END IF;
    END IF;

    IF p_idempotency_key IS NOT NULL AND p_idempotency_key LIKE 'tourney:%' THEN
      v_is_tournament := true;
      BEGIN
        v_tourn := (split_part(p_idempotency_key, ':', 2))::uuid;
      EXCEPTION WHEN OTHERS THEN v_tourn := NULL;
      END;
      IF v_tourn IS NOT NULL THEN
        SELECT tp.club_id INTO v_club FROM tournament_players tp
         WHERE tp.tournament_id = v_tourn AND tp.user_id = p_user_id LIMIT 1;
        IF v_club IS NULL THEN
          SELECT t.club_id INTO v_club FROM tournaments t WHERE t.id = v_tourn;
          -- a union tournament is hosted by the house club; prefer the player's
          -- own club in that union
          v_club := COALESCE(public.fn_player_home_club(p_user_id, NULL), v_club);
        END IF;
      END IF;
    END IF;

    IF v_club IS NULL THEN
      v_club := public.fn_player_home_club(p_user_id, NULL);
    END IF;

    IF v_club IS NOT NULL THEN
      -- CLUB ARENA: standalone club wallet, always.
      PERFORM public.fn_ensure_club_wallet(p_user_id, v_club);
      UPDATE club_members
         SET chip_balance = COALESCE(chip_balance, 0) + p_amount, updated_at = NOW()
       WHERE user_id = p_user_id AND club_id = v_club
       RETURNING chip_balance INTO v_balance;
      IF v_balance IS NOT NULL THEN RETURN; END IF;
    END IF;

    -- Reaching here means no club wallet could be used.
    SELECT EXISTS (SELECT 1 FROM club_members m WHERE m.user_id = p_user_id)
      INTO v_has_any_club;

    IF v_is_tournament OR v_has_any_club THEN
      -- This IS Club Arena money. It must never be pooled into a global wallet.
      INSERT INTO financial_alerts (severity, source, message, context)
      VALUES ('critical','credit_player_wallet',
              'Club Arena credit could not resolve a club wallet — payment refused rather than pooled',
              jsonb_build_object('user_id',p_user_id,'amount',p_amount,
                                 'idempotency_key',p_idempotency_key,'tournament_id',v_tourn));
      RAISE EXCEPTION 'No club wallet resolves for Club Arena credit to player %', p_user_id;
    END IF;

    -- SMARTER.POKER: user belongs to no club at all. The global wallet is the
    -- only wallet they have, and the rule permits it here.
    UPDATE wallets SET balance = balance + p_amount, updated_at = NOW()
      WHERE user_id = p_user_id AND wallet_type = 'PLAYER';
    IF NOT FOUND THEN
        INSERT INTO wallets (user_id, wallet_type, balance, locked_balance, created_at, updated_at)
        VALUES (p_user_id, 'PLAYER', p_amount, 0, NOW(), NOW());
    END IF;
END;
$function$;

-- The guard must accept this one deliberate, documented smarter.poker branch,
-- while still rejecting a global-wallet path in any CLUB ARENA function.
CREATE OR REPLACE FUNCTION public.fn_club_arena_global_wallet_check()
 RETURNS TABLE(fn text, detail text)
 LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p.proname::text,
         'Club Arena money path references the global wallets table — every club '
         || 'must be its own standalone wallet, never joined or pooled'
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN (
       'atomic_table_buyin','atomic_table_cashout','atomic_table_rebuy','atomic_table_addon',
       'atomic_tournament_register','atomic_tournament_unregister','process_tournament_rebuy',
       'atomic_cancel_tournament','fn_pay_player_chips',
       'atomic_pay_player_rakeback','credit_player_rakeback','atomic_pay_agent_settlement',
       'transfer_chips_agent_to_player')
     AND p.prosrc ~* '(update|insert into|from)\s+(public\.)?wallets\M';
$function$;

