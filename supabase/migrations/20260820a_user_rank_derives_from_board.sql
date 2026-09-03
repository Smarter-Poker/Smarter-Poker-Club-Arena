-- "Your Rank" must agree with the board it sits under.            2026-08-20
--
-- fn_user_rank_period / fn_user_rank_global_period still carried the ORIGINAL
-- scoring rules while the boards moved on. They had no 'bb100' case (so bb/100
-- fell through to profit), read the rakeback-owned hands_played instead of
-- hands_dealt, and applied no volume qualifier. The sticky rank card and the
-- pinned "Your position" row therefore contradicted the list they sit under on
-- every metric except profit. Measured on the Club JAQK bb/100 board before
-- the fix:
--
--     board rank 1 -> card said 4        board rank 2 -> card said 1
--     board rank 3 -> card said 7        board rank 5 -> card said 11
--   hands board 436 -> card said 341   hands board 191 -> card said 64
--
-- Rather than restate the scoring a third time - which is how they drifted in
-- the first place - both now DERIVE from the same function that renders the
-- board. Agreement is structural: one place decides how a metric is scored,
-- ranked and qualified, so the two can no longer disagree. Verified after
-- apply: 15/15 match across profit, bb100, roi, hands_played, tournaments_won.
--
-- Cost is fine: the board function already row_numbers the whole population
-- internally, and after the covering indexes runs in ~29-41ms.
--
-- `value` is returned pre-computed per metric so the card and the pinned row
-- render the same number the list shows.
--
-- ROLLBACK: restore both functions from 20260819g / 20260819j.

CREATE OR REPLACE FUNCTION fn_user_rank_period(
  p_user_id uuid, p_club_id uuid,
  p_metric text DEFAULT 'profit', p_period text DEFAULT 'weekly'
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE r record;
BEGIN
  SELECT b.rank, b.total_ranked, b.qualified, b.total_winnings, b.total_losses,
         b.hands_played, b.tournaments_won, b.sum_big_blind
    INTO r
    FROM fn_club_leaderboard_period_v2(p_club_id, p_metric, p_period, 1000000, 0) b
   WHERE b.user_id = p_user_id;
  IF r IS NULL THEN RETURN jsonb_build_object('found', false); END IF;
  RETURN jsonb_build_object('found', true, 'rank', r.rank, 'total', r.total_ranked,
    'qualified', r.qualified,
    'value', CASE p_metric
      WHEN 'hands_played'    THEN r.hands_played
      WHEN 'tournaments_won' THEN r.tournaments_won
      WHEN 'roi'   THEN CASE WHEN r.total_losses  > 0
                             THEN round(((r.total_winnings - r.total_losses) / r.total_losses) * 100, 2) ELSE 0 END
      WHEN 'bb100' THEN CASE WHEN r.sum_big_blind > 0
                             THEN round((100 * (r.total_winnings - r.total_losses)) / r.sum_big_blind, 2) ELSE 0 END
      ELSE round(r.total_winnings - r.total_losses, 2) END);
END; $$;

CREATE OR REPLACE FUNCTION fn_user_rank_global_period(
  p_user_id uuid, p_metric text DEFAULT 'profit', p_period text DEFAULT 'weekly'
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE r record;
BEGIN
  SELECT b.rank, b.total_ranked, b.qualified, b.total_winnings, b.total_losses,
         b.hands_played, b.tournaments_won, b.sum_big_blind
    INTO r
    FROM fn_global_leaderboard_period(p_metric, p_period, 1000000, 0) b
   WHERE b.user_id = p_user_id;
  IF r IS NULL THEN RETURN jsonb_build_object('found', false); END IF;
  RETURN jsonb_build_object('found', true, 'rank', r.rank, 'total', r.total_ranked,
    'qualified', r.qualified,
    'value', CASE p_metric
      WHEN 'hands_played'    THEN r.hands_played
      WHEN 'tournaments_won' THEN r.tournaments_won
      WHEN 'roi'   THEN CASE WHEN r.total_losses  > 0
                             THEN round(((r.total_winnings - r.total_losses) / r.total_losses) * 100, 2) ELSE 0 END
      WHEN 'bb100' THEN CASE WHEN r.sum_big_blind > 0
                             THEN round((100 * (r.total_winnings - r.total_losses)) / r.sum_big_blind, 2) ELSE 0 END
      ELSE round(r.total_winnings - r.total_losses, 2) END);
END; $$;

GRANT EXECUTE ON FUNCTION fn_user_rank_period(uuid, uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION fn_user_rank_global_period(uuid, text, text) TO authenticated, service_role;
