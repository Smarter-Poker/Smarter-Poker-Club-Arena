-- BACKFILLED from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260901195313; recorded so the repo matches the
-- migration list. Do NOT re-apply; it is already live.
-- STATS ROLLER CHUNKS INSTEAD OF CHOKING (2026-09-01)
--
-- THE OUTAGE THIS FIXES. ca_hand_player_facts is superlinear in batch size:
-- measured live, 2 minutes of hands (1,294 fact rows) takes 0.9s, 2,500 hands
-- (6,719 rows) takes 10.8s, and the roller's full 15,000-hand batch blows
-- straight through 110s and then its own 4-minute statement_timeout. From
-- 14:36 UTC (when the hand backlog first exceeded one batch) EVERY
-- ca_roll_hand_stats_forward call timed out and rolled back: rolled_ceil
-- froze at 14:36:43, the backlog grew past 53,000 hands, and each cron tick
-- burned ~4 minutes of DB CPU re-grinding the same doomed batch. Timed-out
-- statements never reach pg_stat_statements, which is why the damage was
-- invisible there. The sustained CPU + occupied PostgREST workers pushed
-- single-row indexed reads to 1.3-2.8s and WebSocket table handshakes to
-- 9-10s - the "Connecting To The Table" banner on every table Dan opened.
--
-- THE FIX: process the backlog in 2,000-hand chunks inside a wall-clock
-- budget (120s), advancing the ceiling after each chunk. One transaction
-- still commits the whole call, but no single statement scales past the size
-- ca_hand_player_facts handles comfortably, so the 4-minute ceiling is never
-- approached. Catch-up throughput: ~10 chunks/call instead of one doomed
-- batch. The advisory lock, the FOR UPDATE on the state row, the tied-hand
-- microsecond boundary, and the per-user 1000-row retention DELETE are all
-- preserved per chunk.

BEGIN;

CREATE OR REPLACE FUNCTION public.ca_roll_hand_stats_forward()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
SET statement_timeout = '4min'
AS $function$
DECLARE
  v_ceil timestamptz;
  v_now timestamptz := now();
  v_deadline timestamptz := clock_timestamp() + interval '120 seconds';
  v_last_hand_at timestamptz;
  v_end timestamptz;
  v_hands int;
  v_total int := 0;
  v_users uuid[];
  v_chunk constant int := 2000;
  v_max_chunks constant int := 12;
  v_i int := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('ca_roll_hand_stats_forward')) THEN
    RETURN 0;
  END IF;

  SELECT rolled_ceil INTO v_ceil
  FROM public.ca_hand_player_stat_state
  WHERE id
  FOR UPDATE;

  IF v_ceil IS NULL OR v_ceil >= v_now THEN RETURN 0; END IF;

  WHILE v_i < v_max_chunks AND clock_timestamp() < v_deadline AND v_ceil < v_now LOOP
    v_i := v_i + 1;

    SELECT max(created_at) INTO v_last_hand_at
    FROM (
      SELECT created_at
      FROM public.hand_history
      WHERE created_at >= v_ceil AND created_at < v_now
      ORDER BY created_at, id
      LIMIT v_chunk
    ) bounded;

    IF v_last_hand_at IS NULL THEN
      -- Caught up: everything before v_now is rolled.
      v_ceil := v_now;
      EXIT;
    END IF;

    -- Include every hand sharing the boundary timestamp. The next chunk
    -- starts at this exclusive end, so no tied hand can fall between chunks.
    v_end := least(v_now, v_last_hand_at + interval '1 microsecond');

    SELECT count(*) INTO v_hands
    FROM public.hand_history
    WHERE created_at >= v_ceil AND created_at < v_end;

    WITH ins AS (
      INSERT INTO public.ca_hand_player_stat (
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
      FROM public.ca_hand_player_facts(v_ceil, v_end) f
      ON CONFLICT (user_id, hand_id) DO NOTHING
      RETURNING user_id
    )
    SELECT array_agg(DISTINCT user_id) INTO v_users FROM ins;

    IF v_users IS NOT NULL THEN
      DELETE FROM public.ca_hand_player_stat s
      USING (
        SELECT user_id, hand_id,
               row_number() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn
        FROM public.ca_hand_player_stat
        WHERE user_id = ANY(v_users)
      ) r
      WHERE r.rn > 1000 AND s.user_id = r.user_id AND s.hand_id = r.hand_id;
    END IF;

    v_total := v_total + coalesce(v_hands, 0);
    v_ceil := v_end;
  END LOOP;

  UPDATE public.ca_hand_player_stat_state
  SET rolled_ceil = greatest(coalesce(rolled_ceil, v_ceil), v_ceil), updated_at = now()
  WHERE id;

  RETURN v_total;
END;
$function$;

-- Assert the shape this migration exists for.
DO $$
DECLARE v_def text;
BEGIN
  v_def := pg_get_functiondef('public.ca_roll_hand_stats_forward()'::regprocedure);
  IF v_def NOT LIKE '%v_chunk constant int := 2000%' THEN
    RAISE EXCEPTION 'chunk size missing';
  END IF;
  IF v_def NOT LIKE '%v_deadline%' THEN
    RAISE EXCEPTION 'wall-clock budget missing';
  END IF;
  IF v_def LIKE '%v_max_hands%' THEN
    RAISE EXCEPTION 'old single-batch shape still present';
  END IF;
END $$;

COMMIT;
