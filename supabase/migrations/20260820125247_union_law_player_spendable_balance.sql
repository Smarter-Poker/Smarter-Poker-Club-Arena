-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820125247 "union_law_player_spendable_balance"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 4057d635e730db09dc49b8e2465d8cdb of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- UNION LAW — AUTHORITATIVE SPENDABLE BALANCE (2026-08-20, pass 5)
--
-- BUG FOUND: with club-scoped chips enabled, a player's spendable chips for a
-- union game are club_members.chip_balance for the club they entered under —
-- but every UI surface still reads wallets.balance (9 call sites via
-- WalletService.getPlayerBalance). The number shown therefore no longer
-- matches the number the buy-in will actually spend: a player can see 0 while
-- holding millions in club chips, or see a healthy balance and be refused with
-- "Insufficient club chips".
--
-- This exposes ONE function that answers "what can this player actually spend
-- here", using exactly the same resolution the buy-in uses, so the display and
-- the transaction can never disagree.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_player_spendable_balance(p_user_id uuid, p_club_id uuid DEFAULT NULL, p_table_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_scoped boolean := public.fn_club_scoped_chips_enabled();
  v_club uuid := NULL;
  v_balance numeric := 0;
  v_source text := 'global_wallet';
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('balance', 0, 'source', 'none', 'club_id', NULL);
  END IF;

  IF v_scoped THEN
    IF p_table_id IS NOT NULL THEN
      -- Seated or sitting down: the seat's own club wins, so the displayed
      -- number is the wallet the rebuy/add-on will actually debit.
      SELECT ts.club_id INTO v_club
        FROM table_seats ts
       WHERE ts.table_id = p_table_id AND ts.user_id = p_user_id AND ts.left_at IS NULL
       LIMIT 1;
      IF v_club IS NULL THEN
        v_club := public.fn_seat_club_for_user(p_user_id, p_table_id, p_club_id);
      END IF;
    ELSIF p_club_id IS NOT NULL THEN
      SELECT m.club_id INTO v_club
        FROM club_members m
       WHERE m.user_id = p_user_id AND m.club_id = p_club_id
         AND m.status IN ('active','approved')
       LIMIT 1;
    END IF;
  END IF;

  IF v_club IS NOT NULL THEN
    SELECT COALESCE(chip_balance, 0) INTO v_balance
      FROM club_members WHERE user_id = p_user_id AND club_id = v_club;
    v_source := 'club_chips';
  ELSE
    SELECT COALESCE(balance, 0) INTO v_balance
      FROM wallets WHERE user_id = p_user_id AND wallet_type = 'PLAYER';
  END IF;

  RETURN jsonb_build_object(
    'balance', COALESCE(v_balance, 0),
    'source', v_source,
    'club_id', v_club,
    'club_scoped', v_scoped
  );
END $function$;

GRANT EXECUTE ON FUNCTION public.fn_player_spendable_balance(uuid, uuid, uuid) TO authenticated;

