-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825220049; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- THE FORWARD ROLL ADDED ROWS AND NOTHING TOOK ANY AWAY.
--
-- ca_prune_hand_player_stat existed and was called by the one-off backfill
-- runner, and by nothing else. The 15-minute cron only rolled forward. Measured
-- 25 minutes after the backfill finished: 584,887 rows had already become
-- 721,397. At roughly 142,000 hands a day and ~13 seated players a hand that is
-- about 1.85m rows a day, so the table would have passed the 14,180,471 rows
-- this whole design exists to avoid inside a week, and the "~20 pages instead of
-- 3,730" claim would have quietly stopped being true.
--
-- Pruning INSIDE the forward roll, scoped to the players it just touched, is
-- what makes the retention self-enforcing rather than dependent on a second
-- scheduled job somebody has to remember. A full-table sweep is a window
-- function over every row and took 24-40s during the backfill; this one is
-- bounded by the players who actually played in the last cron interval, which
-- is a few hundred at most.
--
-- It is two statements, not one data-modifying CTE, deliberately. A DELETE in
-- the same statement as the INSERT cannot see the rows that INSERT is adding -
-- they are not in its snapshot - so the row_number() ranking would be computed
-- without the newest hands and would delete the wrong ones.
--
-- ca_prune_hand_player_stat stays for full sweeps and for repairing drift.

CREATE OR REPLACE FUNCTION public.ca_roll_hand_stats_forward()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
SET statement_timeout = '4min'
AS $function$
DECLARE
  v_ceil  timestamptz;
  v_now   timestamptz := now();
  v_hands int;
  v_users uuid[];
BEGIN
  SELECT rolled_ceil INTO v_ceil FROM ca_hand_player_stat_state WHERE id;
  IF v_ceil IS NULL OR v_ceil >= v_now THEN RETURN 0; END IF;

  SELECT count(*) INTO v_hands FROM hand_history
   WHERE created_at >= v_ceil AND created_at < v_now;

  IF v_hands = 0 THEN
    UPDATE ca_hand_player_stat_state SET rolled_ceil = v_now, updated_at = now() WHERE id;
    RETURN 0;
  END IF;

  WITH ins AS (
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
    ON CONFLICT (user_id, hand_id) DO NOTHING
    RETURNING user_id
  )
  SELECT array_agg(DISTINCT user_id) INTO v_users FROM ins;

  -- Separate statement, so the ranking below sees the rows just committed above.
  IF v_users IS NOT NULL THEN
    DELETE FROM ca_hand_player_stat s
    USING (
      SELECT user_id, hand_id,
             row_number() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn
      FROM ca_hand_player_stat
      WHERE user_id = ANY(v_users)
    ) r
    WHERE r.rn > 1000 AND s.user_id = r.user_id AND s.hand_id = r.hand_id;
  END IF;

  -- Advanced only in the transaction that committed the insert, so a failure
  -- leaves the window to be retried rather than skipped.
  UPDATE ca_hand_player_stat_state SET rolled_ceil = v_now, updated_at = now() WHERE id;
  RETURN v_hands;
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_roll_hand_stats_forward() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ca_roll_hand_stats_forward() FROM anon;
REVOKE ALL ON FUNCTION public.ca_roll_hand_stats_forward() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ca_roll_hand_stats_forward() TO service_role;
