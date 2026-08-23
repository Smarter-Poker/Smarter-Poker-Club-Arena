-- ============================================================================
-- 20260823110000_refund_the_phantom_fourth_entrant.sql
-- TIER: 3  |  MONEY. One player, one refund, one row removed.
--
-- Dan registered for "10 Chip Spin PLO4" (d2d77d52) at 04:15:12 on 2026-08-23,
-- was charged 10 chips, and was eliminated 15 seconds later in position 4 - of
-- a 3-max event. The game is running without him; three horses hold the seats.
--
-- He was admitted because the three horses had been put on the registration
-- list without ever taking seats, which left tournaments.current_players stale
-- and the capacity check reading it. The cause is fixed in
-- 20260823070000_spin_seat_first_integrity.sql; this is the person.
--
-- The entry row is DELETED rather than marked cancelled: this table only ever
-- holds registered / playing / eliminated / winner, so a fifth value would put
-- something in front of UI that has never seen it. The money trail survives as
-- a debit and a matching credit in chip_transactions, and the tournament reads
-- as the 3-handed event it actually was.
--
-- ROLLBACK: none. He was owed the refund.
-- ============================================================================

DO $$
DECLARE
  v_user uuid := '47965354-0e56-43ef-931c-ddaab82af765';
  v_tourn uuid := 'd2d77d52-e6c6-461e-b0a1-f0c1c8753498';
  v_buyin numeric; v_pos int; v_rows int; v_club uuid;
  v_before numeric; v_after numeric; v_paid boolean;
BEGIN
  SELECT position INTO v_pos FROM public.tournament_players
   WHERE tournament_id = v_tourn AND user_id = v_user;
  IF v_pos IS NULL THEN
    RAISE NOTICE 'phantom entry already cleared - nothing to do';
    RETURN;
  END IF;

  SELECT buy_in_amount INTO v_buyin FROM public.tournaments WHERE id = v_tourn;

  -- Chips live per club in club_members.chip_balance, not on profiles.
  v_club := public.fn_player_home_club(v_user, NULL);
  SELECT chip_balance INTO v_before FROM public.club_members
   WHERE user_id = v_user AND club_id = v_club;

  -- fn_credit_player_wallet_once RETURNS boolean; the public wrapper
  -- credit_player_wallet returns void and would swallow the answer.
  v_paid := public.fn_credit_player_wallet_once(
    v_user, v_buyin,
    'phantom_entrant_refund:' || v_tourn::text || ':' || v_user::text);
  IF NOT COALESCE(v_paid, false) THEN
    RAISE EXCEPTION 'refund was refused or already made for % on %', v_user, v_tourn;
  END IF;

  SELECT chip_balance INTO v_after FROM public.club_members
   WHERE user_id = v_user AND club_id = v_club;
  IF v_after IS DISTINCT FROM v_before + v_buyin THEN
    RAISE EXCEPTION 'refund did not land: % -> %, expected +%', v_before, v_after, v_buyin;
  END IF;

  DELETE FROM public.tournament_players
   WHERE tournament_id = v_tourn AND user_id = v_user;

  SELECT count(*) INTO v_rows FROM public.tournament_players WHERE tournament_id = v_tourn;
  IF v_rows <> 3 THEN
    RAISE EXCEPTION 'expected 3 entrants after the repair, found %', v_rows;
  END IF;

  UPDATE public.tournaments SET current_players = v_rows WHERE id = v_tourn;
  RAISE NOTICE 'refunded % (% -> %), removed the phantom 4th entry (was position %)',
    v_buyin, v_before, v_after, v_pos;
END $$;

DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad
    FROM public.tournament_players tp JOIN public.tournaments t ON t.id = tp.tournament_id
   WHERE t.max_players IS NOT NULL AND t.max_players > 0
     AND tp.position IS NOT NULL AND tp.position > t.max_players;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '% player(s) still hold a finishing place beyond the field size', v_bad;
  END IF;
END $$;

-- ============================================================================
-- APPLY HISTORY
-- Applied to production 2026-08-23 as `refund_the_phantom_fourth_entrant`.
-- Balance 250,390.69 -> 250,400.69; entrants 4 -> 3; counter 4 -> 3; players
-- anywhere holding a place beyond the field size: 0.
-- ============================================================================
