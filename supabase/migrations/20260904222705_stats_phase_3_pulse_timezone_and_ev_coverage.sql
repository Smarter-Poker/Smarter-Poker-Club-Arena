-- 20260904222705_stats_phase_3_pulse_timezone_and_ev_coverage.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- STATS PAGE PROGRAMME, PHASE 3: LIVE WITHOUT A BROADCAST, DAYS IN THE
-- PLAYER'S ZONE, AND THE EV COVERAGE TRIPWIRE
-- (docs/STATS-PAGE-PROGRAMME-2026-09-03.md items 1.4, 1.5, 1.6, 1.15)
--
-- WHAT THIS CHANGES, AND WHY:
--
-- 1. THE PULSE. The stats page's "live from any tab" subscription (2026-09-03)
--    listened for INSERTs on ca_hand_player_idx over Realtime. On 2026-09-04
--    another migration (20260904101140) took that table OUT of the realtime
--    publication, correctly: it was 4.5M decoded change records a day, the
--    replication slot was 136 MB behind, and the audience was one page that
--    is rarely open. Its comment said nobody subscribed; the page did, and
--    from that moment its subscription could never fire. Both were right
--    about what mattered - broadcasting every hand on the platform to reach a
--    handful of open stats pages is the wrong shape.
--
--    ca_player_stats_pulse(p_user) is the right shape: two index lookups
--    (the newest hand in the player's index, a fingerprint of the player's
--    tournament rows), owner-asserted, called by the open page every few
--    seconds while it is visible. Cost scales with open pages, not with
--    hands dealt. It also covers tournament finishes (1.5), which the hand
--    index never could: a finish is a tournament_players row changing, not a
--    hand.
--
-- 2. DAYS IN THE PLAYER'S ZONE (1.15). The daily series used date(created_at)
--    - UTC days - so a Chicago player's evening session split across two
--    "days" and the brief said "Aug 29 To Sep 4" in a zone the player does
--    not live in. ca_player_stats_full and ca_player_stats_overview_v2 take
--    p_tz (an IANA name; anything Postgres does not know falls back to UTC)
--    and bucket by date(created_at AT TIME ZONE p_tz). The analysis window
--    itself was always rolling (now() minus p_days) and needed no zone. The
--    two-argument signatures are DROPPED, not overloaded: PostgREST cannot
--    choose between an exact-arity overload and a defaulted one.
--
-- 3. THE SESSION RULE, WRITTEN DOWN (1.6). Sessions have been derived in the
--    RPC since 2026-09-03: a cash hand starts a new session when more than 45
--    minutes passed since the player's previous cash hand, and a session's
--    profit is the sum of its hands' settlements (the same `profit` column
--    every other number on the page reads). Nothing here changes it; the
--    COMMENT on the function now says so and the test pins it.
--
-- 4. EV COVERAGE (1.4). Measured over the 14 days to 2026-09-04: 1,202 all-in
--    showdowns in ca_hand_facts, 454 without all_in_equity - and 443 of those
--    were river all-ins, where every card is out and the result is not luck,
--    so no equity is the right answer. The true gap is 11 of 759 pre-river
--    all-in showdowns (98.6% covered). The witness audit now counts both
--    figures over a 7-day trailing window and ca_stats_health() reports the
--    ratio, so a regression in the engine's equity capture is seen within
--    fifteen minutes rather than on the luck chart months later.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. THE PULSE
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ca_player_stats_pulse(p_user uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_newest_hand timestamptz;
  v_tourn text;
BEGIN
  PERFORM public.ca_assert_self(p_user);

  -- idx_ca_hand_player_idx_user_time (user_id, created_at DESC): one probe.
  SELECT max(created_at) INTO v_newest_hand
  FROM public.ca_hand_player_idx WHERE user_id = p_user;

  -- idx_tourn_players_user: a player's rows number in the hundreds at most.
  -- Any finish, prize, bounty or new entry changes the fingerprint.
  SELECT md5(coalesce(string_agg(
           id::text || ':' || coalesce(status, '') || ':' || coalesce(position::text, '')
             || ':' || coalesce(prize::text, '') || ':' || coalesce(bounty_winnings::text, '')
             || ':' || coalesce(eliminated_at::text, ''),
           '|' ORDER BY id), ''))
    INTO v_tourn
  FROM public.tournament_players WHERE user_id = p_user;

  RETURN jsonb_build_object(
    'newest_hand_at', v_newest_hand,
    'tournaments', v_tourn,
    'pulse', coalesce(v_newest_hand::text, '') || '#' || coalesce(v_tourn, '')
  );
END;
$function$;

COMMENT ON FUNCTION public.ca_player_stats_pulse(uuid) IS
  'The stats page''s heartbeat: the newest hand in the player''s own index and a fingerprint of their tournament rows, as one string. The page polls it while visible and refetches when it changes. Owner only (ca_assert_self). Replaces the Realtime subscription on ca_hand_player_idx, which left the publication on 2026-09-04.';

REVOKE ALL ON FUNCTION public.ca_player_stats_pulse(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_pulse(uuid) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. DAYS IN THE PLAYER'S ZONE
-- ────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.ca_player_stats_overview_v2(uuid, integer);
DROP FUNCTION IF EXISTS public.ca_player_stats_full(uuid, integer);

CREATE FUNCTION public.ca_player_stats_full(p_user uuid, p_days integer DEFAULT NULL::integer, p_tz text DEFAULT 'UTC')
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  c_cap constant int := 750;
  v_since timestamptz := CASE WHEN p_days IS NULL OR p_days <= 0
                              THEN NULL ELSE now() - make_interval(days => p_days) END;
  v_life_hands int := 0;
  v_life_first timestamptz;
  v_life_last  timestamptz;
  -- The player's zone for DAY buckets (phase 3). The analysis window itself
  -- is rolling (now() minus p_days), so it never needed a zone; the daily
  -- series and the "which days" wording did, and were UTC days for everyone.
  v_tz text := 'UTC';
BEGIN
  -- An unknown zone name falls back to UTC rather than failing the page.
  BEGIN
    IF p_tz IS NOT NULL AND length(p_tz) BETWEEN 1 AND 64 THEN
      PERFORM now() AT TIME ZONE p_tz;
      v_tz := p_tz;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_tz := 'UTC';
  END;
  SELECT count(*)::int, min(created_at), max(created_at)
  INTO v_life_hands, v_life_first, v_life_last
  FROM ca_hand_player_idx WHERE user_id = p_user;

RETURN (
WITH scored AS MATERIALIZED (
  -- The most recent c_cap rows for this player, whoever wrote them (the
  -- hand_history trigger, live, or the forward roll behind it). Where the
  -- engine wrote an exact settlement row (ca_hand_facts) the money columns
  -- come from it; the reconstruction is the fallback, and `exact` says which.
  SELECT s.created_at, s.is_cash, s.tournament_id, s.game_variant, s.big_blind,
         s.seat_position AS position,
         coalesce(x.returned, s.won_amt) AS won_amt,
         s.is_winner,
         coalesce(x.invested, s.invested_actions + s.my_blind) AS invested,
         s.aggro_cnt, s.call_cnt, s.vpip, s.pfr, s.three_bet,
         s.three_bet_opp, s.faced_three_bet, s.folded_to_three_bet, s.cbet_opp,
         s.cbet_made, s.showdown, s.hand_secs,
         coalesce(x.net, s.profit) AS profit,
         (x.hand_id IS NOT NULL) AS exact
  FROM ca_hand_player_stat s
  LEFT JOIN ca_hand_facts x ON x.hand_id = s.hand_id AND x.user_id = s.user_id
  WHERE s.user_id = p_user
    AND (v_since IS NULL OR s.created_at >= v_since)
  ORDER BY s.created_at DESC
  LIMIT c_cap
),
totals AS (
  SELECT
    count(*)::int AS hands,
    count(*) FILTER (WHERE is_cash)::int AS cash_hands,
    count(*) FILTER (WHERE is_cash AND exact)::int AS exact_cash_hands,
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
    coalesce(sum(invested) FILTER (WHERE is_cash), 0) AS cash_invested,
    coalesce(max(won_amt) FILTER (WHERE is_cash), 0) AS biggest_pot_won,
    coalesce(min(profit) FILTER (WHERE is_cash), 0) AS biggest_hand_loss,
    coalesce(sum(profit / NULLIF(big_blind, 0)) FILTER (WHERE is_cash), 0) AS cash_bb_profit,
    coalesce(sum(hand_secs), 0) AS total_secs,
    min(created_at) AS first_hand_at,
    max(created_at) AS last_hand_at
  FROM scored
),
daily AS (
  SELECT date(created_at AT TIME ZONE v_tz) AS d, count(*)::int AS hands,
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
         round(coalesce(sum(invested), 0), 2) AS invested
  FROM sess_grouped GROUP BY sess_no ORDER BY sess_no DESC LIMIT 50
),
positions AS (
  SELECT position, count(*)::int AS hands_played,
         count(*) FILTER (WHERE vpip)::int AS vpip_count,
         count(*) FILTER (WHERE pfr)::int AS pfr_count,
         count(*) FILTER (WHERE three_bet)::int AS three_bet_count,
         count(*) FILTER (WHERE three_bet_opp)::int AS three_bet_opps,
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
-- The tournament block honours the analysis window like everything else on
-- the page. It used to be lifetime under a "7 Days" label.
tourn_rows AS (
  SELECT tp.*, t.buy_in_amount, t.buy_in_fee, t.rebuy_cost, t.addon_cost,
         t.name, t.start_time, t.variant, t.is_mystery_bounty
  FROM tournament_players tp
  LEFT JOIN tournaments t ON t.id = tp.tournament_id
  WHERE tp.user_id = p_user
    AND (v_since IS NULL OR coalesce(t.start_time, tp.registered_at, now()) >= v_since)
),
tourn AS (
  SELECT count(*)::int AS entries,
         count(*) FILTER (WHERE coalesce(tp.prize, 0) > 0)::int AS cashes,
         count(*) FILTER (WHERE tp.position = 1 OR tp.status = 'winner')::int AS wins,
         min(tp.position) FILTER (WHERE tp.position IS NOT NULL) AS best_finish,
         coalesce(sum(coalesce(tp.buy_in_amount, 0) + coalesce(tp.buy_in_fee, 0)
           + coalesce(tp.rebuys, 0) * coalesce(tp.rebuy_cost, 0)
           + CASE WHEN tp.add_on THEN coalesce(tp.addon_cost, 0) ELSE 0 END), 0) AS total_buyins,
         coalesce(sum(coalesce(tp.prize, 0) + coalesce(tp.bounty_winnings, 0)), 0) AS total_winnings,
         coalesce(sum(coalesce(tp.prize, 0)), 0) AS total_prizes,
         coalesce(sum(coalesce(tp.bounty_winnings, 0)), 0) AS total_bounty_winnings,
         coalesce(sum(coalesce(tp.bounties_collected, 0)), 0)::int AS total_bounties
  FROM tourn_rows tp
),
tourn_recent AS (
  SELECT tp.tournament_id, tp.name, tp.start_time, tp.variant,
         coalesce(tp.is_mystery_bounty, false) AS is_mystery_bounty,
         tp.position AS finish_rank, tp.status,
         coalesce(tp.prize, 0) AS prize,
         coalesce(tp.bounty_winnings, 0) AS bounty_winnings,
         coalesce(tp.bounties_collected, 0)::int AS bounties,
         coalesce(tp.prize, 0) + coalesce(tp.bounty_winnings, 0) AS total_won,
         coalesce(tp.buy_in_amount, 0) + coalesce(tp.buy_in_fee, 0)
           + coalesce(tp.rebuys, 0) * coalesce(tp.rebuy_cost, 0)
           + CASE WHEN tp.add_on THEN coalesce(tp.addon_cost, 0) ELSE 0 END AS buyin
  FROM tourn_rows tp
  WHERE tp.tournament_id IS NOT NULL
  ORDER BY tp.start_time DESC NULLS LAST LIMIT 25
)
SELECT jsonb_build_object(
  'generated_at', now(),
  'window_days', p_days,
  'window_tz', v_tz,
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
    'exact_cash_hands', exact_cash_hands,
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
      'three_bet_opps', three_bet_opps,
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
      'total_prizes', round(total_prizes, 2),
      'total_bounty_winnings', round(total_bounty_winnings, 2),
      'total_bounties', total_bounties,
      'net_profit', round(total_winnings - total_buyins, 2),
      'roi', CASE WHEN total_buyins > 0
          THEN round((total_winnings - total_buyins) / total_buyins, 4) ELSE 0 END
  ) FROM tourn),
  'recent_tournaments', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'tournament_id', tournament_id,
      'name', name, 'start_time', start_time, 'variant', variant,
      'is_mystery_bounty', is_mystery_bounty,
      'finish_rank', finish_rank, 'status', status,
      'prize', prize,
      'bounty_winnings', bounty_winnings,
      'bounties', bounties,
      'total_won', total_won,
      'buyin', buyin) ORDER BY start_time DESC NULLS LAST) FROM tourn_recent), '[]'::jsonb)
)
);
END;
$function$;


COMMENT ON FUNCTION public.ca_player_stats_full(uuid, integer, text) IS
  'The stats payload for one player: the most recent 750 stat rows (exact settlement overlaid), lifetime index counts, daily series in p_tz (IANA; unknown names fall back to UTC), cash sessions (a new session starts after a 45-minute gap between the player''s cash hands; session profit is the sum of its hands'' settlements), positions, stakes, variants, tournaments in the rolling window. Service role only; the browser reaches it through ca_player_stats_overview_v2.';

REVOKE ALL ON FUNCTION public.ca_player_stats_full(uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_full(uuid, integer, text) TO service_role;

CREATE FUNCTION public.ca_player_stats_overview_v2(p_user uuid, p_days integer DEFAULT NULL::integer, p_tz text DEFAULT 'UTC')
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_result jsonb;
  v_rollup_ceil timestamptz;
  v_rollup_updated_at timestamptz;
  v_cash int;
  v_exact int;
  v_source text;
  v_days integer := CASE
    WHEN p_days IS NULL THEN NULL
    ELSE least(greatest(p_days, 1), 3650)
  END;
BEGIN
  PERFORM public.ca_assert_self(p_user);

  SELECT rolled_ceil, updated_at
    INTO v_rollup_ceil, v_rollup_updated_at
  FROM public.ca_hand_player_stat_state
  WHERE id;

  v_result := public.ca_player_stats_full(p_user, v_days, p_tz);
  v_cash  := coalesce((v_result #>> '{overall,cash_hands}')::int, 0);
  v_exact := coalesce((v_result #>> '{overall,exact_cash_hands}')::int, 0);
  -- The money source is a MEASUREMENT of this payload, not a constant.
  v_source := CASE
    WHEN v_cash = 0 OR v_exact = v_cash THEN 'exact_settlement'
    WHEN v_exact = 0 THEN 'reconstructed_actions'
    ELSE 'mixed'
  END;

  RETURN coalesce(v_result, '{}'::jsonb) || jsonb_build_object(
    'contract_version', 2,
    'scope', jsonb_build_object(
      'target_user_id', p_user,
      'club_id', NULL,
      'range_days', v_days,
      'range_tz', coalesce(v_result ->> 'window_tz', 'UTC'),
      'visibility', 'owner'
    ),
    'quality', jsonb_build_object(
      'cash_money_source', v_source,
      'cash_money_exact', (v_source = 'exact_settlement'),
      'exact_cash_hands', v_exact,
      'advanced_facts_source', 'ca_hand_player_stat',
      'historical_club_breakdown_available', false,
      -- The hand_history trigger writes the stat row in the same transaction
      -- as the hand, so the payload includes every recorded hand.
      'live_tail_included', true
    ),
    'coverage', jsonb_build_object(
      'analysis_hand_cap', coalesce((v_result #>> '{overall,hand_cap}')::integer, 750),
      'analysis_hands_capped', coalesce((v_result #>> '{overall,hands_capped}')::boolean, false),
      'lifetime_index_complete', coalesce((v_result #>> '{lifetime,indexed_complete}')::boolean, false),
      'first_hand_at', v_result #> '{lifetime,first_hand_at}',
      'last_hand_at', v_result #> '{lifetime,last_hand_at}',
      'rollup_covered_through', to_jsonb(v_rollup_ceil),
      'rollup_updated_at', to_jsonb(v_rollup_updated_at)
    )
  );
END;
$function$;


COMMENT ON FUNCTION public.ca_player_stats_overview_v2(uuid, integer, text) IS
  'The browser''s door to the stats payload: asserts auth.uid() = p_user, wraps ca_player_stats_full(p_user, p_days, p_tz) and stamps the contract (scope, quality, coverage). p_tz is the player''s IANA zone for day buckets.';

REVOKE ALL ON FUNCTION public.ca_player_stats_overview_v2(uuid, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_overview_v2(uuid, integer, text) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. EV COVERAGE IN THE WITNESS AUDIT AND THE HEALTH READOUT
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.ca_stats_witness_audit_log
  ADD COLUMN IF NOT EXISTS allin_showdown_7d integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS allin_showdown_without_equity_7d integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.ca_stats_witness_audit(
  p_minutes       integer DEFAULT 10,
  p_grace_seconds integer DEFAULT 90
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  t0                  timestamptz := clock_timestamp();
  v_to                timestamptz;
  v_from              timestamptz;
  v_hands             integer := 0;
  v_player_hands      integer := 0;
  v_with_posts        integer := 0;
  v_button_disagree   integer := 0;
  v_showdown_disagree integer := 0;
  v_without_stat      integer := 0;
  v_without_idx       integer := 0;
  v_human_hands       integer := 0;
  v_human_no_facts    integer := 0;
  v_allin_sd          integer := 0;
  v_allin_sd_no_eq    integer := 0;
  v_idx_lag           numeric;
  v_repair_done       boolean;
  v_row               public.ca_stats_witness_audit_log;
BEGIN
  -- The grace keeps the trigger's own write and the settlement writer's
  -- (asynchronous, seconds behind the hand) out of the window, so a hand
  -- that is simply still being written is not counted as a gap.
  v_to   := now() - make_interval(secs => greatest(p_grace_seconds, 0));
  v_from := v_to  - make_interval(mins => greatest(p_minutes, 1));

  -- 2a. The button against the blind posts. The seat that posted the small
  -- blind sits directly after the button in seat order (heads-up the small
  -- blind IS the button). A hand without post rows cannot be judged and is
  -- counted only in `hands`.
  WITH h AS (
    SELECT id, button_seat::int AS stored, players, coalesce(actions, '[]'::jsonb) AS actions
    FROM hand_history
    WHERE created_at >= v_from AND created_at < v_to
  ),
  seats AS (
    SELECT h.id AS hand_id, pl->>'userId' AS puid, (pl->>'seat')::int AS seat
    FROM h CROSS JOIN LATERAL jsonb_array_elements(h.players) pl
  ),
  sm AS (
    SELECT hand_id, array_agg(seat ORDER BY seat) AS seats, count(*)::int AS n
    FROM seats GROUP BY hand_id
  ),
  posts AS (
    SELECT a.hand_id, min(s.seat) AS sb_seat
    FROM (
      SELECT h.id AS hand_id, x.act->>'userId' AS auid, lower(x.act->>'action') AS action
      FROM h CROSS JOIN LATERAL jsonb_array_elements(h.actions) x(act)
    ) a
    JOIN seats s ON s.hand_id = a.hand_id AND s.puid = a.auid
    WHERE a.action IN ('sb', 'post_sb', 'small_blind')
    GROUP BY a.hand_id
  ),
  judged AS (
    SELECT h.id, h.stored, sm.n, (p.sb_seat IS NOT NULL) AS has_posts,
      CASE
        WHEN p.sb_seat IS NULL OR array_position(sm.seats, p.sb_seat) IS NULL THEN NULL
        WHEN sm.n = 2 THEN p.sb_seat
        ELSE sm.seats[((array_position(sm.seats, p.sb_seat) - 2 + sm.n) % sm.n) + 1]
      END AS derived
    FROM h
    JOIN sm ON sm.hand_id = h.id
    LEFT JOIN posts p ON p.hand_id = h.id
  )
  SELECT count(*)::int,
         coalesce(sum(n), 0)::int,
         count(*) FILTER (WHERE has_posts)::int,
         count(*) FILTER (WHERE has_posts AND derived IS DISTINCT FROM stored)::int
    INTO v_hands, v_player_hands, v_with_posts, v_button_disagree
  FROM judged;

  -- 2b. The derived showdown flag against the engine's showdown roster.
  SELECT count(*)::int INTO v_showdown_disagree
  FROM public.ca_hand_player_facts_range(v_from, v_to, NULL) f
  JOIN hand_history h ON h.id = f.hand_id
  WHERE f.showdown IS DISTINCT FROM EXISTS (
    SELECT 1 FROM jsonb_array_elements(coalesce(h.showdown, '[]'::jsonb)) sd
    WHERE sd->>'user_id' = f.user_id::text
  );

  -- 2c. Hands with no stat row at all (uses idx_ca_hand_player_stat_hand_id).
  SELECT count(*)::int INTO v_without_stat
  FROM hand_history h
  WHERE h.created_at >= v_from AND h.created_at < v_to
    AND NOT EXISTS (SELECT 1 FROM public.ca_hand_player_stat s WHERE s.hand_id = h.id);

  -- 2d. Seats with no index row. Every uuid-shaped seat, horse or human,
  -- must have one (uses idx_ca_hand_player_idx_hand_id).
  SELECT count(*)::int INTO v_without_idx
  FROM (
    SELECT h.id AS hand_id, (pl->>'userId')::uuid AS uid
    FROM hand_history h
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(h.players, '[]'::jsonb)) pl
    WHERE h.created_at >= v_from AND h.created_at < v_to
      AND (pl->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ) seat
  WHERE NOT EXISTS (
    SELECT 1 FROM public.ca_hand_player_idx i WHERE i.hand_id = seat.hand_id AND i.user_id = seat.uid
  );

  -- 2e. Human player-hands with no settlement row. ca_hand_facts is written
  -- for human seats (and horses at NIT tables) by the engine's handFacts
  -- writer; a human seat without one means the page fell back to
  -- reconstruction for that hand.
  SELECT count(*)::int,
         count(*) FILTER (WHERE NOT EXISTS (
           SELECT 1 FROM public.ca_hand_facts x
           WHERE x.hand_id = hp.hand_id AND x.user_id = hp.uid
         ))::int
    INTO v_human_hands, v_human_no_facts
  FROM (
    SELECT h.id AS hand_id, (pl->>'userId')::uuid AS uid
    FROM hand_history h
    CROSS JOIN LATERAL jsonb_array_elements(h.players) pl
    WHERE h.created_at >= v_from AND h.created_at < v_to
      AND h.has_human IS TRUE
      AND (pl->>'userId') ~ '^[0-9a-fA-F-]{36}$'
  ) hp
  JOIN public.profiles pr ON pr.id = hp.uid AND NOT coalesce(pr.is_horse, false);

  -- 2f. EV coverage, trailing seven days (phase 3). A pre-river all-in that
  -- reached showdown was an all-in runout, and the engine prices every one
  -- of those; a river all-in has no cards to come and no equity to price, so
  -- it is not counted. Uses idx_ca_hand_facts_allin (partial, was_all_in).
  SELECT count(*)::int,
         count(*) FILTER (WHERE all_in_equity IS NULL)::int
    INTO v_allin_sd, v_allin_sd_no_eq
  FROM public.ca_hand_facts
  WHERE was_all_in = true
    AND went_to_showdown
    AND coalesce(all_in_street, '') <> 'river'
    AND played_at >= now() - interval '7 days';

  SELECT extract(epoch FROM (now() - idx_ceil))::numeric(12,1) INTO v_idx_lag
  FROM public.ca_hand_player_idx_state WHERE id;
  SELECT done INTO v_repair_done FROM public.ca_hand_player_stat_repair_state WHERE id;

  INSERT INTO public.ca_stats_witness_audit_log (
    window_from, window_to, hands, player_hands, hands_with_posts,
    button_disagree, showdown_disagree, hands_without_stat, player_hands_without_idx,
    human_player_hands, human_without_facts, allin_showdown_7d, allin_showdown_without_equity_7d,
    idx_lag_seconds, repair_done, duration_ms
  ) VALUES (
    v_from, v_to, v_hands, v_player_hands, v_with_posts,
    v_button_disagree, v_showdown_disagree, v_without_stat, v_without_idx,
    v_human_hands, v_human_no_facts, v_allin_sd, v_allin_sd_no_eq,
    v_idx_lag, v_repair_done,
    (extract(epoch FROM (clock_timestamp() - t0)) * 1000)::int
  )
  RETURNING * INTO v_row;

  -- Thirty days of history is plenty; the row is 100 bytes and it runs 96
  -- times a day.
  DELETE FROM public.ca_stats_witness_audit_log WHERE ran_at < now() - interval '30 days';

  RETURN to_jsonb(v_row);
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_stats_witness_audit(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_stats_witness_audit(integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.ca_stats_health()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  WITH idx AS (
    SELECT idx_ceil, backfill_complete, rows_indexed, updated_at
    FROM public.ca_hand_player_idx_state WHERE id
  ),
  -- The last three minutes of hands, less a 90 s grace for the write itself:
  -- every one must already carry a stat row, because the trigger writes it in
  -- the same transaction as the hand.
  recent AS (
    SELECT count(*)::int AS hands,
           count(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM public.ca_hand_player_stat s WHERE s.hand_id = h.id
           ))::int AS without_stat
    FROM hand_history h
    WHERE h.created_at >= now() - interval '3 minutes 30 seconds'
      AND h.created_at <  now() - interval '90 seconds'
  ),
  repair AS (
    SELECT done, cursor_at, ceiling_at, hands_seen, rows_changed, updated_at
    FROM public.ca_hand_player_stat_repair_state WHERE id
  ),
  seatfill AS (
    SELECT done, cursor_at, rows_added FROM public.ca_idx_every_seat_state WHERE id
  ),
  audit AS (
    SELECT ran_at, hands, button_disagree, showdown_disagree, hands_without_stat,
           player_hands_without_idx, human_player_hands, human_without_facts,
           allin_showdown_7d, allin_showdown_without_equity_7d, duration_ms
    FROM public.ca_stats_witness_audit_log
    ORDER BY ran_at DESC LIMIT 1
  )
  SELECT jsonb_build_object(
    'checkedAt',            now(),
    'indexCeil',            (SELECT idx_ceil FROM idx),
    'indexLagSeconds',      (SELECT extract(epoch FROM (now() - idx_ceil))::numeric(12,1) FROM idx),
    'indexBackfillComplete',(SELECT backfill_complete FROM idx),
    'indexRows',            (SELECT rows_indexed FROM idx),
    'recentHands',          (SELECT hands FROM recent),
    'recentHandsWithoutStat', (SELECT without_stat FROM recent),
    'repair', (SELECT jsonb_build_object(
                 'done', done, 'cursorAt', cursor_at, 'ceilingAt', ceiling_at,
                 'handsSeen', hands_seen, 'rowsChanged', rows_changed, 'updatedAt', updated_at)
               FROM repair),
    'seatBackfill', (SELECT jsonb_build_object('done', done, 'cursorAt', cursor_at, 'rowsAdded', rows_added)
                     FROM seatfill),
    'evCoverage7d', (SELECT jsonb_build_object(
                       'allInShowdowns', allin_showdown_7d,
                       'withoutEquity', allin_showdown_without_equity_7d,
                       'ratio', CASE WHEN allin_showdown_7d > 0
                                     THEN round((allin_showdown_7d - allin_showdown_without_equity_7d)::numeric
                                                / allin_showdown_7d, 4)
                                     ELSE NULL END)
                     FROM audit),
    'lastAudit', (SELECT jsonb_build_object(
                    'ranAt', ran_at, 'hands', hands,
                    'buttonDisagree', button_disagree,
                    'showdownDisagree', showdown_disagree,
                    'handsWithoutStat', hands_without_stat,
                    'playerHandsWithoutIdx', player_hands_without_idx,
                    'humanPlayerHands', human_player_hands,
                    'humanWithoutFacts', human_without_facts,
                    'durationMs', duration_ms)
                  FROM audit)
  );
$function$;

REVOKE ALL ON FUNCTION public.ca_stats_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_stats_health() TO service_role;

COMMIT;
