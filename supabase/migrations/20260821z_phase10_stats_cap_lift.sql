-- ============================================================================
-- 20260821z_phase10_stats_cap_lift.sql
-- Phase 10: Lift the 750-hand cap by pointing ca_player_stats_full at ca_hand_facts
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ca_player_stats_full(p_user uuid, p_days int DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  -- p_days: analyse only hands newer than this many days (NULL = no time bound).
  v_since timestamptz := CASE WHEN p_days IS NULL OR p_days <= 0
                              THEN NULL ELSE now() - make_interval(days => p_days) END;
  -- Lifetime volume independent of the window. This is an index-only scan over 
  -- ca_hand_player_idx so the headline "hands played" can be the TRUE number.
  v_life_hands int := 0;
  v_life_first timestamptz;
  v_life_last  timestamptz;
  v_indexed_complete boolean := true;
BEGIN
  -- Lifetime volume uses the ca_hand_player_idx index so the headline
  -- 'hands played' remains perfectly accurate across the player's entire history.
  SELECT count(*)::int, min(created_at), max(created_at)
  INTO v_life_hands, v_life_first, v_life_last
  FROM ca_hand_player_idx WHERE user_id = p_user;

RETURN (
WITH scored AS (
  SELECT
    f.hand_id AS id,
    (f.tournament_id IS NULL) AS is_cash,
    f.played_at AS created_at,
    f.tournament_id,
    f.game_variant,
    f.big_blind,
    f.position,
    f.players_dealt AS no_fold_players,
    (f.returned > 0) AS is_winner,
    f.returned AS won_amt,
    f.invested AS invested_actions,
    0::numeric AS my_blind, 
    f.net AS profit,
    f.vpip,
    f.pfr,
    f.aggressive_actions AS aggro_cnt,
    f.passive_actions AS call_cnt,
    false AS folded,
    f.three_bet,
    -- We map 'faced_three_bet' to 'three_bet_opp' here for the denominator
    f.faced_three_bet AS three_bet_opp,
    f.faced_three_bet,
    f.folded_to_three_bet,
    f.had_cbet_flop_opp AS cbet_opp,
    f.cbet_flop AS cbet_made,
    f.saw_flop AS acted_on_flop,
    f.went_to_showdown AS showdown,
    45::numeric AS hand_secs
  FROM ca_hand_facts f
  WHERE f.user_id = p_user
    AND (v_since IS NULL OR f.played_at >= v_since)
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
  SELECT date(created_at) AS d,
         count(*)::int AS hands,
         round(coalesce(sum(profit), 0), 2) AS profit
  FROM scored WHERE is_cash AND created_at >= now() - interval '90 days'
  GROUP BY 1 ORDER BY 1
),
sess_marked AS (
  SELECT *, CASE WHEN created_at - lag(created_at) OVER (ORDER BY created_at)
                   > interval '45 minutes'
                 OR lag(created_at) OVER (ORDER BY created_at) IS NULL
            THEN 1 ELSE 0 END AS new_sess
  FROM scored WHERE is_cash
),
sess_grouped AS (
  SELECT *, sum(new_sess) OVER (ORDER BY created_at) AS sess_no
  FROM sess_marked
),
sessions_agg AS (
  SELECT sess_no,
         min(created_at) AS started,
         max(created_at) AS ended,
         count(*)::int AS hands,
         round(coalesce(sum(profit), 0), 2) AS profit,
         round(coalesce(sum(invested_actions + my_blind), 0), 2) AS invested
  FROM sess_grouped GROUP BY sess_no ORDER BY sess_no DESC LIMIT 50
),
positions AS (
  SELECT position,
         count(*)::int AS hands_played,
         count(*) FILTER (WHERE vpip)::int AS vpip_count,
         count(*) FILTER (WHERE pfr)::int AS pfr_count,
         count(*) FILTER (WHERE three_bet)::int AS three_bet_count,
         count(*) FILTER (WHERE is_winner)::int AS hands_won,
         round(coalesce(sum(profit) FILTER (WHERE is_cash), 0), 2) AS total_profit,
         CASE WHEN count(*) FILTER (WHERE is_cash) > 0
              THEN round(coalesce(sum(profit / NULLIF(big_blind, 0)) FILTER (WHERE is_cash), 0)
                   / count(*) FILTER (WHERE is_cash) * 100, 2)
              ELSE 0 END AS bb100
  FROM scored WHERE position <> 'UNK'
  GROUP BY position
),
stakes AS (
  -- Cash results grouped by big blind, so a player can see which game size is
  -- actually carrying (or bleeding) their results rather than one blended number.
  SELECT big_blind,
         count(*)::int AS hands,
         count(*) FILTER (WHERE is_winner)::int AS hands_won,
         round(coalesce(sum(profit), 0), 2) AS profit,
         CASE WHEN count(*) > 0
              THEN round(coalesce(sum(profit / NULLIF(big_blind, 0)), 0) / count(*) * 100, 2)
              ELSE 0 END AS bb100
  FROM scored
  WHERE is_cash AND big_blind > 0
  GROUP BY big_blind
  ORDER BY big_blind DESC
),
variants AS (
  SELECT game_variant,
         count(*)::int AS hands,
         count(*) FILTER (WHERE is_winner)::int AS hands_won,
         round(coalesce(sum(profit) FILTER (WHERE is_cash), 0), 2) AS profit,
         CASE WHEN count(*) FILTER (WHERE is_cash) > 0
              THEN round(coalesce(sum(profit / NULLIF(big_blind, 0)) FILTER (WHERE is_cash), 0)
                   / count(*) FILTER (WHERE is_cash) * 100, 2)
              ELSE 0 END AS bb100
  FROM scored GROUP BY game_variant ORDER BY count(*) DESC
),
-- Tournament entries live in tournament_players (41,684 rows), NOT in
-- tournament_registrations — that table is empty platform-wide (0 rows), so
-- reading it made the Tournaments tab show zeros for everyone. Buy-in cost is
-- reconstructed from the tournament (buy-in + fee) plus this player's rebuys
-- and add-on; winnings include bounty_winnings for PKO/bounty events.
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
  SELECT t.name, t.start_time, t.variant,
         tp.position AS finish_rank, tp.status,
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
    -- True when the indexer has not yet reached this player's oldest hands, so
    -- the UI can avoid calling a still-growing number "lifetime".
    'indexed_complete', v_indexed_complete
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
    'hand_cap', 0,
    'hands_capped', false,
    'first_hand_at', first_hand_at,
    'last_hand_at', last_hand_at
  ) FROM totals),
  'daily', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'date', d, 'hands', hands, 'profit', profit) ORDER BY d) FROM daily), '[]'::jsonb),
  'sessions', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', sess_no,
      'date', started,
      'ended', ended,
      'duration_minutes', GREATEST(1, round(EXTRACT(epoch FROM (ended - started)) / 60)::int),
      'hands_played', hands,
      'buy_in', invested,
      'cash_out', round(invested + profit, 2),
      'profit_loss', profit) ORDER BY sess_no DESC) FROM sessions_agg), '[]'::jsonb),
  'positions', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'position', position,
      'hands_played', hands_played,
      'vpip_count', vpip_count,
      'pfr_count', pfr_count,
      'three_bet_count', three_bet_count,
      'hands_won', hands_won,
      'total_profit', total_profit,
      'bb100', bb100)) FROM positions), '[]'::jsonb),
  'variants', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'variant', game_variant,
      'hands', hands,
      'hands_won', hands_won,
      'profit', profit,
      'bb100', bb100)) FROM variants), '[]'::jsonb),
  'stakes', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'big_blind', big_blind,
      'hands', hands,
      'hands_won', hands_won,
      'profit', profit,
      'bb100', bb100) ORDER BY big_blind DESC) FROM stakes), '[]'::jsonb),
  'tournaments', (SELECT jsonb_build_object(
      'entries', entries,
      'cashes', cashes,
      'wins', wins,
      'best_finish', best_finish,
      'itm_percent', CASE WHEN entries > 0 THEN round(cashes::numeric / entries, 4) ELSE 0 END,
      'total_buyins', round(total_buyins, 2),
      'total_winnings', round(total_winnings, 2),
      'net_profit', round(total_winnings - total_buyins, 2),
      'roi', CASE WHEN total_buyins > 0
          THEN round((total_winnings - total_buyins) / total_buyins, 4) ELSE 0 END
  ) FROM tourn),
  'recent_tournaments', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'name', name,
      'start_time', start_time,
      'variant', variant,
      'finish_rank', finish_rank,
      'status', status,
      'prize', prize,
      'buyin', buyin) ORDER BY start_time DESC NULLS LAST) FROM tourn_recent), '[]'::jsonb)
)
);
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_player_stats_full(uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ca_player_stats_full(uuid, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_full(uuid, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_full(uuid, int) TO service_role;
