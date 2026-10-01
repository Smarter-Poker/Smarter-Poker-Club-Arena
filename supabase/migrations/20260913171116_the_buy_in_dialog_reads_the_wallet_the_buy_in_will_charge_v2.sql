-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260913171116 "the_buy_in_dialog_reads_the_wallet_the_buy_in_will_charge_v2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1465e165e6e0e18ee4a511fa32cf909e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_player_spendable_balance(
  p_user_id uuid,
  p_club_id uuid DEFAULT NULL::uuid,
  p_table_id uuid DEFAULT NULL::uuid,
  p_tournament_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_club uuid := NULL;
  v_club_name text := NULL;
  v_balance numeric := 0;
  v_source text := 'club_chips';
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( p_user_id IS DISTINCT FROM auth.uid() AND NOT EXISTS (SELECT 1 FROM club_members cm                   WHERE cm.user_id = p_user_id                     AND cm.agent_id = auth.uid()) AND NOT EXISTS (SELECT 1 FROM club_members cm2                   JOIN union_clubs uc ON uc.club_id = cm2.club_id                   WHERE cm2.user_id = p_user_id                     AND public.fn_is_union_overseer(uc.union_id, auth.uid())))) THEN RAISE EXCEPTION 'not_authorised'; END IF;
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('balance', 0, 'source', 'none', 'club_id', NULL, 'club_name', NULL);
  END IF;

  IF p_table_id IS NOT NULL THEN
    -- Seated or sitting down: the seat's own club is the wallet that will be
    -- debited by a rebuy or add-on.
    SELECT ts.club_id INTO v_club
      FROM table_seats ts
     WHERE ts.table_id = p_table_id AND ts.user_id = p_user_id AND ts.left_at IS NULL
     LIMIT 1;
    IF v_club IS NULL THEN
      v_club := public.fn_seat_club_for_user(p_user_id, p_table_id, p_club_id);
    END IF;
  ELSIF p_tournament_id IS NOT NULL THEN
    -- THE DISPLAY READS THE DEBIT'S RESOLVER (2026-09-13). A tournament entry
    -- is stamped (fn_stamp_entry_club) and charged (atomic_deduct_wallet_and_log
    -- from fn_register_for_tournament, which declares no app.ledger_club_id) by
    -- fn_tournament_club_for_user(user, tournament, NULL): the tournament's own
    -- club for a club event, and for a union-hosted event the player's OLDEST
    -- member club in the union. The preferred club is NULL here for the same
    -- reason it is NULL there - the registration path passes none - so the
    -- wallet this returns is the wallet the entry leaves. Passing p_club_id
    -- (tournaments.club_id, the union's house club) instead resolved to the
    -- house-club wallet, which is not the one charged. Verified against Dan's
    -- own Lunch Rush entry: stamped and debited Club JAQK, shown 'Midway Union'.
    v_club := public.fn_tournament_club_for_user(p_user_id, p_tournament_id, NULL);
  ELSIF p_club_id IS NOT NULL THEN
    SELECT m.club_id INTO v_club
      FROM club_members m
     WHERE m.user_id = p_user_id AND m.club_id = p_club_id
     LIMIT 1;
  END IF;

  IF v_club IS NULL THEN
    v_club := public.fn_player_home_club(p_user_id, p_club_hint => NULL);
  END IF;

  IF v_club IS NOT NULL THEN
    SELECT COALESCE(chip_balance, 0) INTO v_balance
      FROM club_members WHERE user_id = p_user_id AND club_id = v_club;
    SELECT c.name INTO v_club_name FROM clubs c WHERE c.id = v_club;
  ELSE
    -- No club anywhere: a pure smarter.poker user, whose only wallet is global.
    SELECT COALESCE(balance, 0) INTO v_balance
      FROM wallets WHERE user_id = p_user_id AND wallet_type = 'PLAYER';
    v_source := 'smarter_poker_wallet';
  END IF;

  RETURN jsonb_build_object(
    'balance', COALESCE(v_balance, 0),
    'source', v_source,
    'club_id', v_club,
    'club_name', v_club_name,
    'club_scoped', true
  );
END $function$;

COMMIT;
