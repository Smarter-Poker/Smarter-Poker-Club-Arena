-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825192744; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- The builder returned the INSERT's row count, so a window whose rows were all
-- already present returned 0 and a caller looping "until it returns 0" stopped
-- believing the backfill was finished. It was not: 0 rows inserted and 0 hands
-- left are different facts and the caller cannot tell them apart. It now returns
-- HANDS CONSUMED, which is 0 only when there is genuinely nothing older left.
CREATE OR REPLACE FUNCTION public.ca_roll_hand_stats(p_limit int DEFAULT 20000)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
SET statement_timeout = '10min'
AS $function$
DECLARE
  v_floor timestamptz;
  v_next  timestamptz;
  v_hands int;
BEGIN
  SELECT rolled_floor INTO v_floor FROM ca_hand_player_stat_state WHERE id;
  IF v_floor IS NULL THEN
    SELECT max(created_at) + interval '1 second' INTO v_floor FROM hand_history;
    IF v_floor IS NULL THEN RETURN 0; END IF;
  END IF;

  SELECT min(created_at), count(*) INTO v_next, v_hands
  FROM (SELECT created_at FROM hand_history
         WHERE created_at < v_floor
         ORDER BY created_at DESC LIMIT p_limit) q;

  IF v_next IS NULL OR v_hands = 0 THEN
    UPDATE ca_hand_player_stat_state SET complete = true, updated_at = now() WHERE id;
    RETURN 0;
  END IF;

  IF v_next >= v_floor THEN
    v_next := v_floor - interval '1 microsecond';
  END IF;

  INSERT INTO ca_hand_player_stat (
    user_id, hand_id, created_at, is_cash, tournament_id, game_variant,
    big_blind, small_blind, n_players, seat_position, my_blind, won_amt, is_winner,
    invested_actions, aggro_cnt, call_cnt, vpip, pfr, folded, three_bet,
    three_bet_opp, faced_three_bet, folded_to_three_bet, cbet_opp, cbet_made,
    showdown, hand_secs, profit)
  SELECT
    f.user_id, f.hand_id, f.created_at, f.is_cash, f.tournament_id, f.game_variant,
    f.big_blind, f.small_blind, f.n_players, f.seat_position, f.my_blind, f.won_amt, f.is_winner,
    f.invested_actions, f.aggro_cnt, f.call_cnt, f.vpip, f.pfr, f.folded, f.three_bet,
    f.three_bet_opp, f.faced_three_bet, f.folded_to_three_bet, f.cbet_opp, f.cbet_made,
    f.showdown, f.hand_secs, f.profit
  FROM ca_hand_player_facts(v_next, v_floor) f
  ON CONFLICT (user_id, hand_id) DO NOTHING;

  UPDATE ca_hand_player_stat_state
     SET rolled_floor = v_next,
         rolled_ceil  = coalesce(rolled_ceil, (SELECT max(created_at) FROM hand_history)),
         updated_at   = now()
   WHERE id;

  RETURN v_hands;
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_roll_hand_stats(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ca_roll_hand_stats(int) FROM anon;
REVOKE ALL ON FUNCTION public.ca_roll_hand_stats(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ca_roll_hand_stats(int) TO service_role;
