
CREATE OR REPLACE FUNCTION public.ca_player_stats_full(p_user uuid, p_days int DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_since timestamptz := CASE WHEN p_days IS NULL OR p_days <= 0
                              THEN NULL ELSE now() - make_interval(days => p_days) END;
  v_life_hands int := 0;
  v_life_first timestamptz;
  v_life_last  timestamptz;
BEGIN
  -- Lifetime volume uses the index, so headline stats are true even if behavioural stats reset
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
    false AS folded, -- Not strictly tracked in ca_hand_facts yet
    f.three_bet,
    false AS three_bet_opp, -- Legacy, just leave false
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
    count(*) FILTER (WHERE faced_three_bet)::int AS three_bet_opps, -- We use faced as opps here to avoid div0
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
)
SELECT 'SUCCESS' as res
);
END;
$fn$;
