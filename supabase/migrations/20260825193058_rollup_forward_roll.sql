-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825193058; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- The backfill walks backwards and stops. Hands played AFTER it started are
-- newer than rolled_ceil and belong to nobody until this runs. It is called
-- from pages/api/cron/club-stats-maintenance.js in the World Hub every 15
-- minutes, beside the ca_hand_player_idx refresh that exists for the same
-- reason - CLAUDE.md 11.3/11.5 fail CI on net-new cron files, so sharing that
-- already-scheduled route is the sanctioned move rather than a shortcut.
--
-- The cadence is not cosmetic. ca_player_stats_full covers whatever this has
-- not reached by computing it live, so the tail length IS a term in the page's
-- response time: 15 minutes is about 1,500 hands, well inside budget, while a
-- day of silence would be 142,000 and would put the page back where it started.
CREATE OR REPLACE FUNCTION public.ca_roll_hand_stats_forward()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
SET statement_timeout = '4min'
AS $function$
DECLARE
  v_ceil  timestamptz;
  v_now   timestamptz := now();
  v_hands int;
BEGIN
  SELECT rolled_ceil INTO v_ceil FROM ca_hand_player_stat_state WHERE id;
  IF v_ceil IS NULL OR v_ceil >= v_now THEN RETURN 0; END IF;

  SELECT count(*) INTO v_hands FROM hand_history
   WHERE created_at >= v_ceil AND created_at < v_now;

  IF v_hands = 0 THEN
    UPDATE ca_hand_player_stat_state SET rolled_ceil = v_now, updated_at = now() WHERE id;
    RETURN 0;
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
  FROM ca_hand_player_facts(v_ceil, v_now) f
  ON CONFLICT (user_id, hand_id) DO NOTHING;

  -- Advanced only after the insert commits with it, so a failure leaves the
  -- window to be retried rather than skipped.
  UPDATE ca_hand_player_stat_state SET rolled_ceil = v_now, updated_at = now() WHERE id;
  RETURN v_hands;
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_roll_hand_stats_forward() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ca_roll_hand_stats_forward() FROM anon;
REVOKE ALL ON FUNCTION public.ca_roll_hand_stats_forward() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ca_roll_hand_stats_forward() TO service_role;
