-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820135326 "union_law_p7_tournament_blacklist_and_overload_guard"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 71de2278f8deb0a2a45e14642b7d6bb0 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- P7 — BLACKLIST ON TOURNAMENT ENTRY + PERMANENT OVERLOAD GUARD (2026-08-20)
--
-- TWO findings:
--
-- 1. SECURITY HOLE: atomic_table_buyin enforces the union/club blacklist, but
--    NO tournament path did. A player banned from the union could not sit in a
--    cash game yet could still enter every tournament in the union.
--
-- 2. THE OVERLOAD TRAP, THIRD OCCURRENCE. Adding p_club_id created a second
--    atomic_tournament_register instead of replacing the first, so real
--    callers (seven arguments) kept hitting the OLD function and the
--    club-scoped tournament entry shipped earlier was never actually reached.
--    The same trap previously hit atomic_table_buyin and
--    calculate_cascading_commission.
--
--    A guard is added so this can never hide again: fn_union_overload_check
--    reports any money-path function that has more than one signature, and it
--    is wired into the daily law self-test as a hard breach.
-- ============================================================================

DROP FUNCTION IF EXISTS public.atomic_tournament_register(uuid, uuid, text, numeric, numeric, numeric, boolean);

CREATE OR REPLACE FUNCTION public.atomic_tournament_register(p_tournament_id uuid, p_user_id uuid, p_username text, p_total_cost numeric, p_current_bounty numeric, p_mystery_bounty_value numeric, p_is_bounty_tournament boolean, p_club_id uuid DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_wallet_balance NUMERIC;
  v_player_id UUID;
  v_club uuid := NULL;
  v_t_club uuid;
  v_t_union uuid;
  v_ban uuid;
BEGIN
  SELECT t.club_id, t.union_id INTO v_t_club, v_t_union
    FROM tournaments t WHERE t.id = p_tournament_id;

  -- UNION LAW: a player barred by the club OR the union cannot enter. The cash
  -- path always enforced this; tournaments did not.
  IF v_t_club IS NOT NULL OR v_t_union IS NOT NULL THEN
    SELECT id INTO v_ban FROM blacklists
     WHERE user_id = p_user_id
       AND (expires_at IS NULL OR expires_at > now())
       AND (club_id = v_t_club OR (v_t_union IS NOT NULL AND union_id = v_t_union))
     LIMIT 1;
    IF v_ban IS NOT NULL THEN
      RAISE EXCEPTION 'Banned from this club';
    END IF;
  END IF;

  IF public.fn_club_scoped_chips_enabled() THEN
    v_club := public.fn_tournament_club_for_user(p_user_id, p_tournament_id, p_club_id);
  END IF;

  IF v_club IS NOT NULL THEN
    SELECT chip_balance INTO v_wallet_balance FROM club_members
     WHERE user_id = p_user_id AND club_id = v_club FOR UPDATE;
    IF NOT FOUND OR v_wallet_balance < p_total_cost THEN
      RAISE EXCEPTION 'Insufficient club chips for tournament entry.';
    END IF;
    UPDATE club_members SET chip_balance = chip_balance - p_total_cost, updated_at = NOW()
     WHERE user_id = p_user_id AND club_id = v_club;
  ELSE
    SELECT balance INTO v_wallet_balance FROM wallets
     WHERE user_id = p_user_id AND wallet_type = 'PLAYER' FOR UPDATE;
    IF NOT FOUND OR v_wallet_balance < p_total_cost THEN
      RAISE EXCEPTION 'Insufficient chips in Player Wallet.';
    END IF;
    UPDATE wallets SET balance = balance - p_total_cost, updated_at = NOW()
     WHERE user_id = p_user_id AND wallet_type = 'PLAYER';
  END IF;

  IF p_is_bounty_tournament THEN
    INSERT INTO tournament_players (
      tournament_id, user_id, username, chips, status,
      current_bounty, mystery_bounty_value, bounties_collected, bounty_winnings, club_id
    ) VALUES (
      p_tournament_id, p_user_id, p_username, 0, 'registered',
      p_current_bounty, p_mystery_bounty_value, 0, 0, v_club
    ) RETURNING id INTO v_player_id;
  ELSE
    INSERT INTO tournament_players (
      tournament_id, user_id, username, chips, status, club_id
    ) VALUES (
      p_tournament_id, p_user_id, p_username, 0, 'registered', v_club
    ) RETURNING id INTO v_player_id;
  END IF;

  RETURN v_player_id;
END;
$function$;

-- Permanent guard against the overload trap ---------------------------------
CREATE OR REPLACE FUNCTION public.fn_union_overload_check()
 RETURNS TABLE(fn text, signatures bigint, detail text)
 LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p.proname::text, count(*),
         'money-path function has multiple signatures — callers may silently hit '
         || 'the stale one (this has already happened three times: buy-in, '
         || 'cascading commission, tournament register)'
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN (
       'atomic_table_buyin','atomic_table_cashout','atomic_table_rebuy','atomic_table_addon',
       'atomic_tournament_register','atomic_tournament_unregister','process_tournament_rebuy',
       'calculate_cascading_commission','credit_agent_commission_from_rake',
       'atomic_distribute_rake','record_tournament_buyin_rake','transfer_chips_agent_to_player',
       'atomic_pay_agent_settlement','fn_pay_player_chips'
     )
   GROUP BY p.proname
  HAVING count(*) > 1;
$function$;

