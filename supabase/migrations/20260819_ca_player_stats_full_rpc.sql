-- ============================================================================
-- 20260819_ca_player_stats_full_rpc.sql
-- Club Arena Player Stats rebuild (Tier 2 migration — additive only)
--
-- WHY: /hub/club-arena/stats showed "No Stats Yet" for everyone.
--   Root causes:
--   1. player_stats has ONE ROW PER CLUB per user; the page called
--      .maybeSingle() which errors on >1 row -> data=null -> empty state.
--   2. player_sessions is essentially unpopulated (3 rows total) while the
--      real source of truth (hand_history, 2.2M rows) was never queried.
--
-- WHAT THIS ADDS (no destructive changes, no data rewrites):
--   1. GIN index on hand_history.players (jsonb_path_ops) for @> lookups.
--      (Built CONCURRENTLY out-of-band on 2026-08-19; IF NOT EXISTS keeps
--      this migration idempotent.)
--   2. ca_player_stats_full(p_user uuid) RETURNS jsonb — SECURITY DEFINER
--      RPC that computes lifetime cash + tournament statistics directly
--      from hand_history + tournament_registrations:
--      totals, VPIP/PFR/3-bet/fold-to-3-bet/c-bet/AF/WTSD/WSD, profit,
--      bb/100, per-position stats, per-variant stats, daily series,
--      gap-clustered session history, tournament results (entries, ITM,
--      wins, ROI) and recent tournaments.
--
-- SECURITY: definer bypasses hand_history RLS but only returns aggregates
--   (never hole cards). EXECUTE granted to authenticated + service_role
--   only. Stats are club-visible by design (same as player_stats RLS).
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.ca_player_stats_full(uuid);
--   DROP INDEX IF EXISTS public.idx_hand_history_players_gin;
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_hand_history_players_gin
  ON public.hand_history USING gin (players jsonb_path_ops);

CREATE OR REPLACE FUNCTION public.ca_player_stats_full(p_user uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
WITH my_hands AS (
  SELECT h.id, h.tournament_id,
         lower(coalesce(h.game_variant, 'nlh')) AS game_variant,
         coalesce(h.big_blind, 0)::numeric   AS big_blind,
         coalesce(h.small_blind, 0)::numeric AS small_blind,
         h.button_seat, h.created_at, h.started_at, h.ended_at,
         h.players,
         coalesce(h.actions, '[]'::jsonb) AS actions,
         coalesce(h.winners, '[]'::jsonb) AS winners
  FROM hand_history h
  WHERE h.players @> jsonb_build_array(jsonb_build_object('userId', p_user::text))
  ORDER BY h.created_at DESC
  -- Cap: authenticated role has statement_timeout=8s. Measured cost is
  -- ~1.5ms/hand, so 3k hands ~= 4.5s worst case. Only horses ever hit the
  -- cap; human players are in the hundreds of hands.
  LIMIT 3000
),
per_hand AS (
  SELECT
    mh.id,
    (mh.tournament_id IS NULL) AS is_cash,
    mh.tournament_id, mh.game_variant, mh.big_blind, mh.created_at,
    s.my_seat, s.seats, mh.button_seat,
    w.won_amt, w.is_winner,
    a.no_fold_players,
    a.invested_actions, a.vpip, a.pfr, a.aggro_cnt, a.call_cnt, a.folded,
    a.three_bet, a.three_bet_opp, a.faced_three_bet, a.folded_to_three_bet,
    a.cbet_opp, a.cbet_made,
    mh.small_blind,
    CASE
      WHEN mh.button_seat IS NULL OR s.seats IS NULL
        OR s.my_seat IS NULL OR array_length(s.seats, 1) < 2
        OR array_position(s.seats, mh.button_seat::int) IS NULL THEN NULL
      ELSE (array_position(s.seats, s.my_seat)
            - array_position(s.seats, mh.button_seat::int)
            + array_length(s.seats, 1)) % array_length(s.seats, 1)
    END AS pos_offset,
    array_length(s.seats, 1) AS n_players,
    CASE
      WHEN mh.started_at IS NOT NULL AND mh.ended_at IS NOT NULL
      THEN GREATEST(0, LEAST(1800, EXTRACT(epoch FROM (mh.ended_at - mh.started_at))))::numeric
      ELSE 45
    END AS hand_secs
  FROM my_hands mh
  CROSS JOIN LATERAL (
    SELECT
      (SELECT (pl->>'seat')::int FROM jsonb_array_elements(mh.players) pl
        WHERE pl->>'userId' = p_user::text LIMIT 1) AS my_seat,
      (SELECT array_agg((pl->>'seat')::int ORDER BY (pl->>'seat')::int)
         FROM jsonb_array_elements(mh.players) pl) AS seats
  ) s
  CROSS JOIN LATERAL (
    SELECT
      coalesce(sum((w1->>'amount')::numeric)
        FILTER (WHERE w1->>'userId' = p_user::text), 0) AS won_amt,
      count(*) FILTER (WHERE w1->>'userId' = p_user::text) > 0 AS is_winner
    FROM jsonb_array_elements(mh.winners) w1
  ) w
  CROSS JOIN LATERAL (
    -- Single expansion of the actions array + cheap follow-up passes over the
    -- tiny materialized act list (perf: authenticated statement_timeout=8s).
    WITH acts AS (
      SELECT x.ord,
             x.act->>'userId' AS auid,
             x.act->>'stage'  AS stage,
             x.act->>'action' AS action,
             coalesce((x.act->>'amount')::numeric, 0) AS amount
      FROM jsonb_array_elements(mh.actions) WITH ORDINALITY x(act, ord)
    ),
    base AS (
      SELECT
        coalesce(sum(amount) FILTER (WHERE auid = p_user::text
          AND action IN ('bet','call','raise','all_in')), 0) AS invested_actions,
        coalesce(bool_or(auid = p_user::text AND stage = 'preflop'
          AND action IN ('call','bet','raise','all_in')), false) AS vpip,
        coalesce(bool_or(auid = p_user::text AND stage = 'preflop'
          AND action IN ('raise','all_in')), false) AS pfr,
        count(*) FILTER (WHERE auid = p_user::text
          AND action IN ('bet','raise','all_in')) AS aggro_cnt,
        count(*) FILTER (WHERE auid = p_user::text AND action = 'call') AS call_cnt,
        coalesce(bool_or(auid = p_user::text AND action = 'fold'), false) AS folded,
        min(ord) FILTER (WHERE auid <> p_user::text AND stage = 'preflop'
          AND action IN ('raise','all_in')) AS first_other_pf_raise,
        min(ord) FILTER (WHERE auid = p_user::text AND stage = 'preflop'
          AND action IN ('raise','all_in')) AS my_first_pf_raise,
        (array_agg(auid ORDER BY ord DESC) FILTER (WHERE stage = 'preflop'
          AND action IN ('raise','all_in')))[1] AS last_pf_raiser,
        (array_agg(auid ORDER BY ord) FILTER (WHERE stage = 'flop'
          AND action IN ('bet','all_in')))[1] AS first_flop_bettor,
        coalesce(bool_or(auid = p_user::text AND stage = 'flop'), false) AS acted_on_flop
      FROM acts
    ),
    derived AS (
      SELECT b.*,
        EXISTS (SELECT 1 FROM acts
          WHERE auid = p_user::text AND stage = 'preflop'
            AND action IN ('raise','all_in') AND ord > b.first_other_pf_raise) AS three_bet_x,
        EXISTS (SELECT 1 FROM acts
          WHERE auid = p_user::text AND stage = 'preflop'
            AND ord > b.first_other_pf_raise) AS three_bet_opp_x,
        (SELECT min(ord) FROM acts
          WHERE auid <> p_user::text AND stage = 'preflop'
            AND action IN ('raise','all_in') AND ord > b.my_first_pf_raise) AS reraise_after_me
      FROM base b
    )
    SELECT d.invested_actions, d.vpip, d.pfr, d.aggro_cnt, d.call_cnt, d.folded,
      coalesce(d.three_bet_x, false) AS three_bet,
      coalesce(d.three_bet_opp_x, false) AS three_bet_opp,
      (d.reraise_after_me IS NOT NULL) AS faced_three_bet,
      coalesce(d.reraise_after_me IS NOT NULL AND EXISTS (
        SELECT 1 FROM acts
        WHERE auid = p_user::text AND stage = 'preflop'
          AND action = 'fold' AND ord > d.reraise_after_me), false) AS folded_to_three_bet,
      coalesce(d.last_pf_raiser = p_user::text AND d.acted_on_flop, false) AS cbet_opp,
      coalesce(d.last_pf_raiser = p_user::text
        AND d.first_flop_bettor = p_user::text, false) AS cbet_made,
      (SELECT count(*) FROM jsonb_array_elements(mh.players) pl
        WHERE pl->>'userId' NOT IN (
          SELECT auid FROM acts
          WHERE action = 'fold' AND auid IS NOT NULL)) AS no_fold_players
    FROM derived d
  ) a
),
enriched AS (
  SELECT ph.*,
    CASE
      WHEN ph.pos_offset IS NULL THEN 0
      WHEN ph.n_players = 2 THEN
        CASE WHEN ph.pos_offset = 0 THEN ph.small_blind ELSE ph.big_blind END
      WHEN ph.pos_offset = 1 THEN ph.small_blind
      WHEN ph.pos_offset = 2 THEN ph.big_blind
      ELSE 0
    END AS my_blind,
    CASE
      WHEN ph.pos_offset IS NULL THEN 'UNK'
      WHEN ph.n_players = 2 THEN CASE WHEN ph.pos_offset = 0 THEN 'BTN' ELSE 'BB' END
      WHEN ph.pos_offset = 0 THEN 'BTN'
      WHEN ph.pos_offset = 1 THEN 'SB'
      WHEN ph.pos_offset = 2 THEN 'BB'
      WHEN ph.pos_offset = ph.n_players - 1 THEN 'CO'
      WHEN ph.pos_offset = 3 THEN 'UTG'
      WHEN ph.pos_offset = 4 AND ph.n_players >= 8 THEN 'UTG+1'
      ELSE 'MP'
    END AS position
  FROM per_hand ph
),
scored AS (
  SELECT e.*,
    (e.won_amt - e.invested_actions - e.my_blind) AS profit,
    (NOT e.folded AND e.no_fold_players >= 2) AS showdown
  FROM enriched e
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
tourn AS (
  SELECT count(*)::int AS entries,
         count(*) FILTER (WHERE coalesce(prize_amount, 0) > 0)::int AS cashes,
         count(*) FILTER (WHERE finish_rank = 1)::int AS wins,
         min(finish_rank) FILTER (WHERE finish_rank IS NOT NULL) AS best_finish,
         coalesce(sum(coalesce(buy_in_amount, 0) + coalesce(buy_in_fee, 0)), 0) AS total_buyins,
         coalesce(sum(coalesce(prize_amount, 0)), 0) AS total_winnings
  FROM tournament_registrations WHERE user_id = p_user
),
tourn_recent AS (
  SELECT t.name, t.start_time, t.variant, r.finish_rank, r.status,
         coalesce(r.prize_amount, 0) AS prize,
         coalesce(r.buy_in_amount, 0) + coalesce(r.buy_in_fee, 0) AS buyin
  FROM tournament_registrations r
  JOIN tournaments t ON t.id = r.tournament_id
  WHERE r.user_id = p_user
  ORDER BY t.start_time DESC NULLS LAST LIMIT 25
)
SELECT jsonb_build_object(
  'generated_at', now(),
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
);
$fn$;

REVOKE ALL ON FUNCTION public.ca_player_stats_full(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ca_player_stats_full(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_full(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_full(uuid) TO service_role;
