-- ca_player_stats_full no longer opens hand_history for the window it analyses.
--
-- EVERYTHING BELOW `scored` IS UNCHANGED - same aggregates, same JSON shape,
-- same keys, same rounding, same 750-hand cap and the same hand_cap /
-- hands_capped fields that drive the "Based on your most recent N hands" line.
-- The only thing that changed is where those 750 rows come from:
--
--   before: 750 hand ids -> 750 random fetches of 6.4 KB rows -> 3,730 pages
--   after : 750 rows of ~120 bytes from ca_hand_player_stat  -> ~20 pages
--
-- See 20260825400000_stats_hand_rollup.sql for the measurements and for why the
-- old shape was being cancelled by the 8s statement_timeout rather than merely
-- running slowly.
--
-- The UNION's second branch is the tail the builder has not reached, computed
-- live from the same facts function, so a player's newest hands are never
-- missing while the rollup catches up. It passes p_user so the facts function
-- produces one player rather than every player in the window and then throwing
-- the rest away - a 15-minute tail is ~2,100 hands, which was ~27,000
-- (player, hand) rows computed so that ~30 survived. The redundant
-- `WHERE f.user_id = p_user` is kept deliberately: it costs nothing now that the
-- set is already narrow, and it means a future change to the argument list
-- cannot silently widen what this branch contributes to a player's stats.
--
-- Both branches are parenthesised because the first carries ORDER BY and LIMIT,
-- which Postgres will not accept bare inside a set operation.
--
-- LIFETIME IS STILL THE TRUE NUMBER. It is counted from ca_hand_player_idx, not
-- from the analysis window, so "hands played" does not silently become 750.

CREATE OR REPLACE FUNCTION public.ca_player_stats_full(p_user uuid, p_days integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  c_cap constant int := 750;
  v_since timestamptz := CASE WHEN p_days IS NULL OR p_days <= 0
                              THEN NULL ELSE now() - make_interval(days => p_days) END;
  v_ceil  timestamptz;
  v_life_hands int := 0;
  v_life_first timestamptz;
  v_life_last  timestamptz;
BEGIN
  SELECT count(*)::int, min(created_at), max(created_at)
  INTO v_life_hands, v_life_first, v_life_last
  FROM ca_hand_player_idx WHERE user_id = p_user;

  SELECT rolled_ceil INTO v_ceil FROM ca_hand_player_stat_state WHERE id;

RETURN (
WITH scored AS MATERIALIZED (
  SELECT * FROM (
    (
      SELECT s.created_at, s.is_cash, s.tournament_id, s.game_variant, s.big_blind,
             s.seat_position AS position, s.won_amt, s.is_winner, s.invested_actions,
             s.my_blind, s.aggro_cnt, s.call_cnt, s.vpip, s.pfr, s.three_bet,
             s.three_bet_opp, s.faced_three_bet, s.folded_to_three_bet, s.cbet_opp,
             s.cbet_made, s.showdown, s.hand_secs, s.profit
      FROM ca_hand_player_stat s
      WHERE s.user_id = p_user
        AND (v_since IS NULL OR s.created_at >= v_since)
        AND (v_ceil  IS NULL OR s.created_at <  v_ceil)
      ORDER BY s.created_at DESC
      LIMIT c_cap
    )
    UNION ALL
    (
      SELECT f.created_at, f.is_cash, f.tournament_id, f.game_variant, f.big_blind,
             f.seat_position, f.won_amt, f.is_winner, f.invested_actions,
             f.my_blind, f.aggro_cnt, f.call_cnt, f.vpip, f.pfr, f.three_bet,
             f.three_bet_opp, f.faced_three_bet, f.folded_to_three_bet, f.cbet_opp,
             f.cbet_made, f.showdown, f.hand_secs, f.profit
      FROM ca_hand_player_facts(coalesce(v_ceil, now()), now(), p_user) f
      WHERE f.user_id = p_user
        AND (v_since IS NULL OR f.created_at >= v_since)
    )
  ) u
  ORDER BY created_at DESC
  LIMIT c_cap
),
totals AS (
  SELECT
    count(*)::int AS hands,
    count(*) FILTER (WHERE is_cash)::int AS cash_hands,
    count(*) FILTER (WHERE NOT is_cash)::int AS tourney_hands,
    count(DISTINCT tournament_id) FILTER (WHERE NOT is_cash)::int AS tournaments_with_hands,
    count(*) FILTER (WHERE is_winner)::int AS hands_won,
    count(*) FILTER (WHERE vpip)::int AS vpip_hands,
    count(*) FILTER (WHERE pfr)::int AS pfr_hands,
    count(*) FILTER (WHERE three_bet)::int AS three_bet_hands,
    count(*) FILTER (WHERE three_bet_opp)::int AS three_bet_opps,
    count(*) FILTER (WHERE faced_three_bet)::int AS faced_three_bet_hands,
    count(*) FILTER (WHERE folded_to_three_bet)::int AS folded_to_three_bet_hands,
    count(*) FILTER (WHERE cbet_opp)::int AS cbet_opps,
    count(*) FILTER (WHERE cbet_made)::int AS cbet_made_hands,
    coalesce(sum(aggro_cnt), 0)::int AS aggro_actions,
    coalesce(sum(call_cnt), 0)::int AS call_actions,
    count(*) FILTER (WHERE showdown)::int AS showdowns,
    count(*) FILTER (WHERE showdown AND is_winner)::int AS showdowns_won,
    coalesce(sum(profit) FILTER (WHERE is_cash), 0) AS cash_profit,
    coalesce(sum(won_amt) FILTER (WHERE is_cash), 0) AS cash_won,
    coalesce(sum(invested_actions + my_blind) FILTER (WHERE is_cash), 0) AS cash_invested,
    coalesce(max(won_amt) FILTER (WHERE is_cash), 0) AS biggest_pot_won,
    coalesce(min(profit) FILTER (WHERE is_cash), 0) AS biggest_hand_loss,
    coalesce(sum(profit / NULLIF(big_blind, 0)) FILTER (WHERE is_cash), 0) AS cash_bb_profit,
    coalesce(sum(hand_secs), 0) AS total_secs,
    min(created_at) AS first_hand_at,
    max(created_at) AS last_hand_at
  FROM scored
),
daily AS (
  SELECT date(created_at) AS d, count(*)::int AS hands,
         round(coalesce(sum(profit), 0), 2) AS profit
  FROM scored WHERE is_cash AND created_at >= now() - interval '90 days'
  GROUP BY 1 ORDER BY 1
),
sess_marked AS (
  SELECT *, CASE WHEN created_at - lag(created_at) OVER (ORDER BY created_at) > interval '45 minutes'
                 OR lag(created_at) OVER (ORDER BY created_at) IS NULL
            THEN 1 ELSE 0 END AS new_sess
  FROM scored WHERE is_cash
),
sess_grouped AS (
  SELECT *, sum(new_sess) OVER (ORDER BY created_at) AS sess_no FROM sess_marked
),
sessions_agg AS (
  SELECT sess_no, min(created_at) AS started, max(created_at) AS ended,
         count(*)::int AS hands,
         round(coalesce(sum(profit), 0), 2) AS profit,
         round(coalesce(sum(invested_actions + my_blind), 0), 2) AS invested
  FROM sess_grouped GROUP BY sess_no ORDER BY sess_no DESC LIMIT 50
),
positions AS (
  SELECT position, count(*)::int AS hands_played,
         count(*) FILTER (WHERE vpip)::int AS vpip_count,
         count(*) FILTER (WHERE pfr)::int AS pfr_count,
         count(*) FILTER (WHERE three_bet)::int AS three_bet_count,
         count(*) FILTER (WHERE is_winner)::int AS hands_won,
         round(coalesce(sum(profit) FILTER (WHERE is_cash), 0), 2) AS total_profit,
         CASE WHEN count(*) FILTER (WHERE is_cash) > 0
              THEN round(coalesce(sum(profit / NULLIF(big_blind, 0)) FILTER (WHERE is_cash), 0)
                   / count(*) FILTER (WHERE is_cash) * 100, 2)
              ELSE 0 END AS bb100
  FROM scored WHERE position <> 'UNK' GROUP BY position
),
stakes AS (
  SELECT big_blind, count(*)::int AS hands,
         count(*) FILTER (WHERE is_winner)::int AS hands_won,
         round(coalesce(sum(profit), 0), 2) AS profit,
         CASE WHEN count(*) > 0
              THEN round(coalesce(sum(profit / NULLIF(big_blind, 0)), 0) / count(*) * 100, 2)
              ELSE 0 END AS bb100
  FROM scored WHERE is_cash AND big_blind > 0
  GROUP BY big_blind ORDER BY big_blind DESC
),
variants AS (
  SELECT game_variant, count(*)::int AS hands,
         count(*) FILTER (WHERE is_winner)::int AS hands_won,
         round(coalesce(sum(profit) FILTER (WHERE is_cash), 0), 2) AS profit,
         CASE WHEN count(*) FILTER (WHERE is_cash) > 0
              THEN round(coalesce(sum(profit / NULLIF(big_blind, 0)) FILTER (WHERE is_cash), 0)
                   / count(*) FILTER (WHERE is_cash) * 100, 2)
              ELSE 0 END AS bb100
  FROM scored GROUP BY game_variant ORDER BY count(*) DESC
),
-- Tournament entries live in tournament_players, NOT in tournament_registrations
-- - that table is empty platform-wide, so reading it made the Tournaments tab
-- show zeros for everyone. Unchanged by this migration; kept here because the
-- reason is not obvious from the code.
tourn AS (
  SELECT count(*)::int AS entries,
         count(*) FILTER (WHERE coalesce(tp.prize, 0) > 0)::int AS cashes,
         count(*) FILTER (WHERE tp.position = 1 OR tp.status = 'winner')::int AS wins,
         min(tp.position) FILTER (WHERE tp.position IS NOT NULL) AS best_finish,
         coalesce(sum(coalesce(t.buy_in_amount, 0) + coalesce(t.buy_in_fee, 0)
           + coalesce(tp.rebuys, 0) * coalesce(t.rebuy_cost, 0)
           + CASE WHEN tp.add_on THEN coalesce(t.addon_cost, 0) ELSE 0 END), 0) AS total_buyins,
         coalesce(sum(coalesce(tp.prize, 0) + coalesce(tp.bounty_winnings, 0)), 0) AS total_winnings
  FROM tournament_players tp
  LEFT JOIN tournaments t ON t.id = tp.tournament_id
  WHERE tp.user_id = p_user
),
tourn_recent AS (
  SELECT t.name, t.start_time, t.variant, tp.position AS finish_rank, tp.status,
         coalesce(tp.prize, 0) + coalesce(tp.bounty_winnings, 0) AS prize,
         coalesce(t.buy_in_amount, 0) + coalesce(t.buy_in_fee, 0)
           + coalesce(tp.rebuys, 0) * coalesce(t.rebuy_cost, 0)
           + CASE WHEN tp.add_on THEN coalesce(t.addon_cost, 0) ELSE 0 END AS buyin
  FROM tournament_players tp
  JOIN tournaments t ON t.id = tp.tournament_id
  WHERE tp.user_id = p_user
  ORDER BY t.start_time DESC NULLS LAST LIMIT 25
)
SELECT jsonb_build_object(
  'generated_at', now(),
  'window_days', p_days,
  'lifetime', jsonb_build_object(
    'hands', v_life_hands,
    'first_hand_at', v_life_first,
    'last_hand_at', v_life_last,
    'indexed_complete', (SELECT backfill_complete FROM ca_hand_player_idx_state WHERE id)
  ),
  'user_id', p_user,
  'overall', (SELECT jsonb_build_object(
    'total_hands', hands,
    'cash_hands', cash_hands,
    'tourney_hands', tourney_hands,
    'tournaments_with_hands', tournaments_with_hands,
    'hands_won', hands_won,
    'hands_lost', hands - hands_won,
    'vpip', CASE WHEN hands > 0 THEN round(vpip_hands::numeric / hands, 4) ELSE 0 END,
    'pfr', CASE WHEN hands > 0 THEN round(pfr_hands::numeric / hands, 4) ELSE 0 END,
    'three_bet_percent', CASE WHEN three_bet_opps > 0
        THEN round(three_bet_hands::numeric / three_bet_opps, 4) ELSE 0 END,
    'fold_to_three_bet', CASE WHEN faced_three_bet_hands > 0
        THEN round(folded_to_three_bet_hands::numeric / faced_three_bet_hands, 4) ELSE 0 END,
    'cbet_flop', CASE WHEN cbet_opps > 0
        THEN round(cbet_made_hands::numeric / cbet_opps, 4) ELSE 0 END,
    'aggression_factor', CASE WHEN call_actions > 0
        THEN round(aggro_actions::numeric / call_actions, 2) ELSE aggro_actions END,
    'showdowns_total', showdowns,
    'showdowns_won', showdowns_won,
    'wtsd', CASE WHEN hands > 0 THEN round(showdowns::numeric / hands, 4) ELSE 0 END,
    'total_profit', round(cash_profit, 2),
    'total_winnings', round(cash_won, 2),
    'total_invested', round(cash_invested, 2),
    'biggest_pot_won', round(biggest_pot_won, 2),
    'biggest_hand_loss', round(biggest_hand_loss, 2),
    'bb_per_100', CASE WHEN cash_hands > 0
        THEN round(cash_bb_profit / cash_hands * 100, 2) ELSE 0 END,
    'hours_played', round(total_secs / 3600.0, 2),
    'hand_cap', c_cap,
    'hands_capped', (hands >= c_cap),
    'first_hand_at', first_hand_at,
    'last_hand_at', last_hand_at
  ) FROM totals),
  'daily', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'date', d, 'hands', hands, 'profit', profit) ORDER BY d) FROM daily), '[]'::jsonb),
  'sessions', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', sess_no, 'date', started, 'ended', ended,
      'duration_minutes', GREATEST(1, round(EXTRACT(epoch FROM (ended - started)) / 60)::int),
      'hands_played', hands, 'buy_in', invested,
      'cash_out', round(invested + profit, 2),
      'profit_loss', profit) ORDER BY sess_no DESC) FROM sessions_agg), '[]'::jsonb),
  'positions', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'position', position, 'hands_played', hands_played, 'vpip_count', vpip_count,
      'pfr_count', pfr_count, 'three_bet_count', three_bet_count,
      'hands_won', hands_won, 'total_profit', total_profit,
      'bb100', bb100)) FROM positions), '[]'::jsonb),
  'variants', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'variant', game_variant, 'hands', hands, 'hands_won', hands_won,
      'profit', profit, 'bb100', bb100)) FROM variants), '[]'::jsonb),
  'stakes', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'big_blind', big_blind, 'hands', hands, 'hands_won', hands_won,
      'profit', profit, 'bb100', bb100) ORDER BY big_blind DESC) FROM stakes), '[]'::jsonb),
  'tournaments', (SELECT jsonb_build_object(
      'entries', entries, 'cashes', cashes, 'wins', wins, 'best_finish', best_finish,
      'itm_percent', CASE WHEN entries > 0 THEN round(cashes::numeric / entries, 4) ELSE 0 END,
      'total_buyins', round(total_buyins, 2),
      'total_winnings', round(total_winnings, 2),
      'net_profit', round(total_winnings - total_buyins, 2),
      'roi', CASE WHEN total_buyins > 0
          THEN round((total_winnings - total_buyins) / total_buyins, 4) ELSE 0 END
  ) FROM tourn),
  'recent_tournaments', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'name', name, 'start_time', start_time, 'variant', variant,
      'finish_rank', finish_rank, 'status', status, 'prize', prize,
      'buyin', buyin) ORDER BY start_time DESC NULLS LAST) FROM tourn_recent), '[]'::jsonb)
)
);
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_player_stats_full(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ca_player_stats_full(uuid, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_full(uuid, integer) TO authenticated, service_role;
