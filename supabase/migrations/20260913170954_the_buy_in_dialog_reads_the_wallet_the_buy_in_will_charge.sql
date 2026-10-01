-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260913170954 "the_buy_in_dialog_reads_the_wallet_the_buy_in_will_charge"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 5693b630b1cde84f6ca24c8e15ac6a30 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

BEGIN;

DROP FUNCTION IF EXISTS public.fn_player_spendable_balance(uuid, uuid, uuid);

CREATE FUNCTION public.fn_player_spendable_balance(
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
    -- is charged by atomic_deduct_wallet_and_log to
    -- fn_tournament_club_for_user(user, tournament, preferred club): the
    -- tournament's own club for a club event, and for a union-hosted event
    -- the member club the player enters through (oldest membership when no
    -- preferred club is a member). Reading tournaments.club_id here instead
    -- returned the union's house-club wallet, which is not the wallet the
    -- buy-in leaves. Same function, same preferred club, same answer.
    v_club := public.fn_tournament_club_for_user(p_user_id, p_tournament_id, p_club_id);
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

REVOKE ALL ON FUNCTION public.fn_player_spendable_balance(uuid, uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_player_spendable_balance(uuid, uuid, uuid, uuid) TO postgres, authenticated, service_role;

COMMENT ON FUNCTION public.fn_player_spendable_balance(uuid, uuid, uuid, uuid) IS
  'The balance of the wallet a spend WILL charge. p_table_id: the seat''s club. p_tournament_id: fn_tournament_club_for_user, the same resolver atomic_deduct_wallet_and_log uses for the entry. p_club_id alone: that club. Returns balance, source, club_id, club_name.';

COMMIT;
