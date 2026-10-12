-- 20261003132118_stats_preserve_authorized_club_scope.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Per-club statistics deliberately use ca_hand_facts. That table already
-- records the authoritative club at settlement and exact player net. The
-- historical rollup drops club identity, so attributing those older rows to a
-- club would be invented data. All Clubs keeps its established rollup RPC.
CREATE OR REPLACE FUNCTION public.ca_assert_player_stats_club(
  p_user uuid,
  p_club_id uuid,
  p_asset text DEFAULT 'chips'
) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.ca_assert_self(p_user);
  IF p_club_id IS NULL THEN
    RAISE EXCEPTION 'club is required' USING ERRCODE = '22023';
  END IF;
  IF p_asset IS NULL OR p_asset NOT IN ('chips', 'diamonds') THEN
    RAISE EXCEPTION 'unknown stats asset: %', p_asset USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.club_members m
    JOIN public.clubs c ON c.id = m.club_id
    WHERE m.club_id = p_club_id
      AND m.user_id = p_user
      AND m.status IN ('active', 'approved')
      AND coalesce(c.lifecycle_status, 'active') <> 'retired'
      AND coalesce(c.asset, 'chips') = p_asset
  ) THEN
    RAISE EXCEPTION 'not authorized for stats club' USING ERRCODE = '42501';
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.ca_assert_player_stats_club(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_assert_player_stats_club(uuid, uuid, text)
  TO service_role;

-- A single calendar-boundary primitive keeps every stats surface aligned.
-- p_now exists only so the native fixture can prove the spring/fall DST
-- boundaries without depending on the wall clock.
CREATE OR REPLACE FUNCTION public.ca_stats_calendar_bounds(
  p_days integer DEFAULT NULL,
  p_tz text DEFAULT 'UTC',
  p_now timestamptz DEFAULT now()
) RETURNS TABLE(range_days integer, range_tz text, from_at timestamptz, to_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path TO 'public'
AS $function$
DECLARE
  v_days integer := CASE WHEN p_days IS NULL THEN NULL ELSE least(greatest(p_days,1),3650) END;
  v_tz text := CASE WHEN EXISTS (SELECT 1 FROM pg_timezone_names WHERE name=p_tz) THEN p_tz ELSE 'UTC' END;
BEGIN
  RETURN QUERY SELECT v_days, v_tz,
    CASE WHEN v_days IS NULL THEN NULL ELSE
      (((p_now AT TIME ZONE v_tz)::date-(v_days-1))::timestamp AT TIME ZONE v_tz) END,
    CASE WHEN v_days IS NULL THEN NULL ELSE
      ((((p_now AT TIME ZONE v_tz)::date+1)::timestamp) AT TIME ZONE v_tz) END;
END;
$function$;
REVOKE ALL ON FUNCTION public.ca_stats_calendar_bounds(integer,text,timestamptz)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ca_stats_calendar_bounds(integer,text,timestamptz)
  TO service_role;

CREATE OR REPLACE FUNCTION public.ca_player_stats_overview_v2_by_club(
  p_user uuid,
  p_days integer DEFAULT NULL,
  p_tz text DEFAULT 'UTC',
  p_asset text DEFAULT 'chips',
  p_club_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  c_analysis_cap constant integer := 750;
  v_days integer := CASE WHEN p_days IS NULL THEN NULL ELSE least(greatest(p_days, 1), 3650) END;
  v_tz text := CASE WHEN EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_tz) THEN p_tz ELSE 'UTC' END;
  v_from timestamptz := CASE WHEN v_days IS NULL THEN NULL ELSE
    (((now() AT TIME ZONE v_tz)::date - (v_days - 1))::timestamp AT TIME ZONE v_tz) END;
  v_to timestamptz := CASE WHEN v_days IS NULL THEN NULL ELSE
    ((((now() AT TIME ZONE v_tz)::date + 1)::timestamp) AT TIME ZONE v_tz) END;
  v_first timestamptz;
  v_last timestamptz;
  v_lifetime integer;
BEGIN
  PERFORM public.ca_assert_player_stats_club(p_user, p_club_id, p_asset);

  SELECT count(*)::integer, min(f.played_at), max(f.played_at)
    INTO v_lifetime, v_first, v_last
    FROM public.ca_hand_facts f
   WHERE f.user_id = p_user AND f.club_id = p_club_id;

  RETURN (
    WITH filtered AS MATERIALIZED (
      SELECT f.*
      FROM public.ca_hand_facts f
      WHERE f.user_id = p_user
        AND f.club_id = p_club_id
        AND (v_from IS NULL OR f.played_at >= v_from)
        AND (v_to IS NULL OR f.played_at < v_to)
    ), scored AS MATERIALIZED (
      SELECT * FROM filtered ORDER BY played_at DESC LIMIT c_analysis_cap
    ), totals AS (
      SELECT count(*)::integer hands,
        count(*) FILTER (WHERE tournament_id IS NULL)::integer cash_hands,
        count(*) FILTER (WHERE tournament_id IS NOT NULL)::integer tourney_hands,
        count(DISTINCT tournament_id) FILTER (WHERE tournament_id IS NOT NULL)::integer tournaments_with_hands,
        count(*) FILTER (WHERE net > 0)::integer hands_won,
        count(*) FILTER (WHERE vpip)::integer vpip_hands,
        count(*) FILTER (WHERE pfr)::integer pfr_hands,
        count(*) FILTER (WHERE three_bet)::integer three_bet_hands,
        count(*) FILTER (WHERE faced_three_bet)::integer faced_three_bet_hands,
        count(*) FILTER (WHERE folded_to_three_bet)::integer folded_to_three_bet_hands,
        count(*) FILTER (WHERE had_cbet_flop_opp)::integer cbet_opps,
        count(*) FILTER (WHERE cbet_flop)::integer cbet_hands,
        coalesce(sum(aggressive_actions), 0)::integer aggro,
        coalesce(sum(passive_actions), 0)::integer passive,
        count(*) FILTER (WHERE saw_flop)::integer saw_flop_hands,
        count(*) FILTER (WHERE went_to_showdown)::integer showdowns,
        count(*) FILTER (WHERE won_at_showdown)::integer showdowns_won,
        coalesce(sum(net) FILTER (WHERE tournament_id IS NULL), 0) cash_profit,
        coalesce(sum(returned) FILTER (WHERE tournament_id IS NULL), 0) cash_won,
        coalesce(sum(invested) FILTER (WHERE tournament_id IS NULL), 0) cash_invested,
        coalesce(max(returned) FILTER (WHERE tournament_id IS NULL), 0) biggest_pot,
        coalesce(min(net) FILTER (WHERE tournament_id IS NULL), 0) biggest_loss,
        coalesce(sum(net_bb) FILTER (WHERE tournament_id IS NULL), 0) cash_net_bb,
        min(played_at) first_hand_at, max(played_at) last_hand_at
      FROM filtered
    ), analysis_sample AS (
      SELECT count(*)::integer hands FROM scored
    ), daily AS (
      SELECT date(played_at AT TIME ZONE v_tz) d, count(*)::integer hands,
             round(sum(net), 2) profit
      FROM filtered WHERE tournament_id IS NULL GROUP BY 1 ORDER BY 1
    ), positions AS (
      SELECT position, count(*)::integer hands_played,
        count(*) FILTER (WHERE vpip)::integer vpip_count,
        count(*) FILTER (WHERE pfr)::integer pfr_count,
        count(*) FILTER (WHERE three_bet)::integer three_bet_count,
        count(*) FILTER (WHERE net > 0)::integer hands_won,
        round(coalesce(sum(net) FILTER (WHERE tournament_id IS NULL), 0), 2) total_profit,
        round(coalesce(sum(net_bb) FILTER (WHERE tournament_id IS NULL), 0)
          / nullif(count(*) FILTER (WHERE tournament_id IS NULL), 0) * 100, 2) bb100
      FROM scored GROUP BY position
    ), variants AS (
      SELECT game_variant, count(*)::integer hands,
        count(*) FILTER (WHERE net > 0)::integer hands_won,
        round(coalesce(sum(net) FILTER (WHERE tournament_id IS NULL), 0), 2) profit,
        round(coalesce(sum(net_bb) FILTER (WHERE tournament_id IS NULL), 0)
          / nullif(count(*) FILTER (WHERE tournament_id IS NULL), 0) * 100, 2) bb100
      FROM scored GROUP BY game_variant
    ), stakes AS (
      SELECT big_blind, count(*)::integer hands,
        count(*) FILTER (WHERE net > 0)::integer hands_won,
        round(sum(net), 2) profit,
        round(sum(net_bb) / nullif(count(*), 0) * 100, 2) bb100
      FROM scored WHERE tournament_id IS NULL AND big_blind > 0 GROUP BY big_blind
    ), tournament_rows AS (
      SELECT tp.*, t.name, t.start_time, t.ended_at, t.variant, t.buy_in_amount, t.buy_in_fee,
             t.rebuy_cost, t.addon_cost, t.is_mystery_bounty
      FROM public.tournament_players tp
      JOIN public.tournaments t ON t.id = tp.tournament_id
      WHERE tp.user_id = p_user AND t.club_id = p_club_id
        AND upper(coalesce(t.status, '')) = 'COMPLETED'
        AND t.ended_at IS NOT NULL
        AND (v_from IS NULL OR t.ended_at >= v_from)
        AND (v_to IS NULL OR t.ended_at < v_to)
    ), tournament_totals AS (
      SELECT count(*)::integer entries,
        count(*) FILTER (WHERE coalesce(prize, 0) > 0)::integer cashes,
        count(*) FILTER (WHERE position = 1 OR status = 'winner')::integer wins,
        min(position) FILTER (WHERE position IS NOT NULL) best_finish,
        coalesce(sum(coalesce(buy_in_amount, 0) + coalesce(buy_in_fee, 0)
          + coalesce(rebuys, 0) * coalesce(rebuy_cost, 0)
          + CASE WHEN add_on THEN coalesce(addon_cost, 0) ELSE 0 END), 0) total_buyins,
        coalesce(sum(coalesce(prize, 0)), 0) total_prizes,
        coalesce(sum(coalesce(bounty_winnings, 0)), 0) total_bounty_winnings,
        coalesce(sum(coalesce(bounties_collected, 0)), 0)::integer total_bounties
      FROM tournament_rows
    )
    SELECT jsonb_build_object(
      'contract_version', 2, 'generated_at', now(), 'window_days', v_days, 'window_tz', v_tz,
      'scope', jsonb_build_object('target_user_id', p_user, 'club_id', p_club_id,
        'asset', p_asset, 'range_days', v_days, 'range_tz', v_tz, 'visibility', 'owner'),
      'quality', jsonb_build_object('cash_money_source', 'exact_settlement',
        'cash_money_exact', true, 'exact_cash_hands', (SELECT cash_hands FROM totals),
        'advanced_facts_source', 'ca_hand_facts',
        'historical_club_breakdown_available', false,
        'club_breakdown_available', true, 'club_breakdown_source', 'ca_hand_facts',
        'club_breakdown_starts_at', v_first, 'live_tail_included', true,
        'section_availability', jsonb_build_object(
          'sessions', false,
          'sessions_reason', 'not_captured_in_ca_hand_facts'
        ),
        'metric_availability', (SELECT jsonb_build_object(
          'three_bet_percent', false,
          'three_bet_numerator', three_bet_hands,
          'three_bet_opportunities', NULL,
          'fold_to_three_bet', faced_three_bet_hands > 0,
          'fold_to_three_bet_opportunities', faced_three_bet_hands,
          'cbet_flop', cbet_opps > 0,
          'cbet_flop_opportunities', cbet_opps,
          'aggression_factor', passive > 0,
          'aggression_factor_denominator', passive,
          'wtsd', saw_flop_hands > 0,
          'wtsd_opportunities', saw_flop_hands,
          'hours_played', false
        ) FROM totals)),
      'coverage', jsonb_build_object('analysis_hand_cap', c_analysis_cap,
        'analysis_sample_hands', (SELECT hands FROM analysis_sample),
        'analysis_hands_capped', (SELECT hands FROM totals) > c_analysis_cap,
        'lifetime_index_complete', true, 'first_hand_at', v_first, 'last_hand_at', v_last,
        'rollup_covered_through', v_last, 'rollup_updated_at', now()),
      'lifetime', jsonb_build_object('hands', v_lifetime, 'first_hand_at', v_first,
        'last_hand_at', v_last, 'indexed_complete', true),
      'overall', (SELECT jsonb_build_object(
        'total_hands', hands, 'cash_hands', cash_hands, 'exact_cash_hands', cash_hands,
        'tourney_hands', tourney_hands, 'tournaments_with_hands', tournaments_with_hands,
        'hands_won', hands_won, 'hands_lost', hands - hands_won,
        'vpip', coalesce(round(vpip_hands::numeric / nullif(hands, 0), 4), 0),
        'pfr', coalesce(round(pfr_hands::numeric / nullif(hands, 0), 4), 0),
        -- ca_hand_facts does not retain the three-bet-opportunity flag. A
        -- per-hand denominator would manufacture a tracker statistic, so the
        -- compatible numeric field is zero and quality.metric_availability
        -- says it was not measured.
        'three_bet_percent', 0,
        'fold_to_three_bet', coalesce(round(folded_to_three_bet_hands::numeric / nullif(faced_three_bet_hands, 0), 4), 0),
        'cbet_flop', coalesce(round(cbet_hands::numeric / nullif(cbet_opps, 0), 4), 0),
        -- An action count is not a ratio. Zero passive actions means AF is
        -- unmeasured/infinite; keep the legacy numeric shape at zero and make
        -- availability explicit in quality.metric_availability.
        'aggression_factor', coalesce(round(aggro::numeric / nullif(passive, 0), 2), 0),
        'showdowns_total', showdowns, 'showdowns_won', showdowns_won,
        'wtsd', coalesce(round(showdowns::numeric / nullif(saw_flop_hands, 0), 4), 0),
        'total_profit', round(cash_profit, 2), 'total_winnings', round(cash_won, 2),
        'total_invested', round(cash_invested, 2), 'biggest_pot_won', round(biggest_pot, 2),
        'biggest_hand_loss', round(biggest_loss, 2),
        'bb_per_100', coalesce(round(cash_net_bb / nullif(cash_hands, 0) * 100, 2), 0),
        'hours_played', 0, 'hand_cap', c_analysis_cap, 'hands_capped', false,
        'first_hand_at', first_hand_at, 'last_hand_at', last_hand_at) FROM totals),
      'daily', coalesce((SELECT jsonb_agg(jsonb_build_object('date', d, 'hands', hands, 'profit', profit) ORDER BY d) FROM daily), '[]'::jsonb),
      'sessions', '[]'::jsonb,
      'positions', coalesce((SELECT jsonb_agg(jsonb_build_object('position', position,
        'hands_played', hands_played, 'vpip_count', vpip_count, 'pfr_count', pfr_count,
        'three_bet_count', three_bet_count, 'hands_won', hands_won,
        'total_profit', total_profit, 'bb100', coalesce(bb100, 0))) FROM positions), '[]'::jsonb),
      'variants', coalesce((SELECT jsonb_agg(jsonb_build_object('variant', game_variant,
        'hands', hands, 'hands_won', hands_won, 'profit', profit, 'bb100', coalesce(bb100, 0))) FROM variants), '[]'::jsonb),
      'stakes', coalesce((SELECT jsonb_agg(jsonb_build_object('big_blind', big_blind,
        'hands', hands, 'hands_won', hands_won, 'profit', profit, 'bb100', bb100)) FROM stakes), '[]'::jsonb),
      'tournaments', (SELECT jsonb_build_object('entries', entries, 'cashes', cashes,
        'wins', wins, 'best_finish', best_finish,
        'itm_percent', coalesce(round(cashes::numeric / nullif(entries, 0), 4), 0),
        'total_buyins', round(total_buyins, 2),
        'total_winnings', round(total_prizes + total_bounty_winnings, 2),
        'total_prizes', round(total_prizes, 2),
        'total_bounty_winnings', round(total_bounty_winnings, 2),
        'total_bounties', total_bounties,
        'net_profit', round(total_prizes + total_bounty_winnings - total_buyins, 2),
        'roi', coalesce(round((total_prizes + total_bounty_winnings - total_buyins) / nullif(total_buyins, 0), 4), 0)) FROM tournament_totals),
      'recent_tournaments', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'tournament_id', tournament_id, 'name', name, 'start_time', start_time,
        'ended_at', ended_at,
        'variant', variant, 'is_mystery_bounty', coalesce(is_mystery_bounty, false),
        'finish_rank', position, 'status', status, 'prize', coalesce(prize, 0),
        'bounty_winnings', coalesce(bounty_winnings, 0),
        'bounties', coalesce(bounties_collected, 0),
        'total_won', coalesce(prize, 0) + coalesce(bounty_winnings, 0),
        'buyin', coalesce(buy_in_amount, 0) + coalesce(buy_in_fee, 0)
          + coalesce(rebuys, 0) * coalesce(rebuy_cost, 0)
          + CASE WHEN add_on THEN coalesce(addon_cost, 0) ELSE 0 END)
        ORDER BY ended_at DESC) FROM (SELECT * FROM tournament_rows ORDER BY ended_at DESC LIMIT 25) recent), '[]'::jsonb)
    )
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.ca_player_stats_overview_v2_by_club(uuid, integer, text, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_overview_v2_by_club(uuid, integer, text, text, uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.ca_player_stats_overview_v2_by_club(uuid, integer, text, text, uuid) IS
  'Self-only per-club Stats payload from exact ca_hand_facts plus the selected club tournament ledger. It never attributes pre-fact rollup rows to a club; quality.club_breakdown_starts_at states the honest coverage boundary.';

CREATE OR REPLACE FUNCTION public.ca_player_ev_curve_by_club(
  p_user uuid, p_days integer DEFAULT NULL, p_limit integer DEFAULT 5000,
  p_asset text DEFAULT 'chips', p_club_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_cap integer := least(greatest(coalesce(p_limit, 5000), 100), 20000);
BEGIN
  PERFORM public.ca_assert_player_stats_club(p_user, p_club_id, p_asset);
  RETURN (WITH picked AS MATERIALIZED (
    SELECT f.played_at, f.net_bb, f.ev_net_bb, f.was_all_in
    FROM public.ca_hand_facts f WHERE f.user_id=p_user AND f.club_id=p_club_id
      AND f.went_to_showdown AND f.game_variant NOT IN ('mtt','sit_and_go')
      AND (p_days IS NULL OR f.played_at >= now()-make_interval(days=>least(greatest(p_days,1),3650)))
    ORDER BY f.played_at DESC LIMIT v_cap
  ), a AS (
    SELECT row_number() OVER w i, played_at at, net_bb, ev_net_bb,
      sum(net_bb) OVER w cum_net_bb, sum(ev_net_bb) OVER w cum_ev_net_bb,
      was_all_in FROM picked WINDOW w AS (ORDER BY played_at)
  ), s AS (
    SELECT count(*) hands, count(*) FILTER (WHERE was_all_in) all_in_hands,
      coalesce(sum(net_bb),0) net_bb, coalesce(sum(ev_net_bb),0) ev_net_bb,
      coalesce(sum(net_bb-ev_net_bb),0) luck_bb,
      coalesce(max(net_bb-ev_net_bb),0) biggest_suckout,
      coalesce(min(net_bb-ev_net_bb),0) biggest_beat FROM a
  ) SELECT jsonb_build_object('contract_version',2,
    'scope',jsonb_build_object('target_user_id',p_user,'club_id',p_club_id,'asset',p_asset,
      'range_days',CASE WHEN p_days IS NULL THEN NULL ELSE least(greatest(p_days,1),3650) END,'visibility','owner'),
    'points',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'i',i,'at',at,'net_bb',net_bb,'ev_net_bb',ev_net_bb,
      'cum_net_bb',cum_net_bb,'cum_ev_net_bb',cum_ev_net_bb) ORDER BY i) FROM a),'[]'::jsonb),
    'summary',(SELECT jsonb_build_object('hands',hands,'all_in_hands',all_in_hands,
      'net_bb',round(net_bb,2),'ev_net_bb',round(ev_net_bb,2),'luck_bb',round(luck_bb,2),
      'luck_bb_per_100',CASE WHEN hands>0 THEN round(luck_bb/hands*100,2) ELSE 0 END,
      'biggest_suckout',round(biggest_suckout,2),'biggest_beat',round(biggest_beat,2),
      'capped',hands=v_cap) FROM s),'generated_at',now()));
END;$function$;

CREATE OR REPLACE FUNCTION public.ca_player_hand_grid_by_club(
  p_user uuid, p_position text DEFAULT NULL, p_variant text DEFAULT NULL,
  p_days integer DEFAULT NULL, p_asset text DEFAULT 'chips', p_club_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.ca_assert_player_stats_club(p_user,p_club_id,p_asset);
  RETURN (WITH g AS (
    SELECT f.hand_class, count(*) hands, count(*) FILTER(WHERE f.vpip) hands_vpip,
      count(*) FILTER(WHERE f.net>0) hands_won,
      count(*) FILTER(WHERE f.vpip)::numeric/nullif(count(*),0) vpip_pct,
      round(sum(f.net_bb),2) net_bb, round(sum(f.ev_net_bb),2) ev_net_bb,
      round(sum(f.net_bb)/nullif(count(*),0)*100,2) bb100
    FROM public.ca_hand_facts f WHERE f.user_id=p_user AND f.club_id=p_club_id
      AND f.hand_class IS NOT NULL AND (p_position IS NULL OR f.position=p_position)
      AND (p_variant IS NULL OR f.game_variant=p_variant)
      AND (p_days IS NULL OR f.played_at>=now()-make_interval(days=>least(greatest(p_days,1),3650)))
    GROUP BY f.hand_class
  ) SELECT jsonb_build_object('contract_version',2,
    'scope',jsonb_build_object('target_user_id',p_user,'club_id',p_club_id,'asset',p_asset,
      'range_days',CASE WHEN p_days IS NULL THEN NULL ELSE least(greatest(p_days,1),3650) END,'visibility','owner'),
    'cells',coalesce((SELECT jsonb_agg(g) FROM g),'[]'::jsonb),
    'totals',jsonb_build_object('hands',coalesce((SELECT sum(hands) FROM g),0),
      'classes_seen',(SELECT count(*) FROM g)),
    'filters',jsonb_build_object('position',p_position,'variant',p_variant,
      'days',CASE WHEN p_days IS NULL THEN NULL ELSE least(greatest(p_days,1),3650) END),
    'generated_at',now()));
END;$function$;

CREATE OR REPLACE FUNCTION public.ca_player_class_hands_by_club(
  p_user uuid, p_hand_class text, p_position text DEFAULT NULL, p_variant text DEFAULT NULL,
  p_days integer DEFAULT NULL, p_limit integer DEFAULT 20,
  p_asset text DEFAULT 'chips', p_club_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_cap integer:=least(greatest(coalesce(p_limit,20),1),100);
BEGIN
  PERFORM public.ca_assert_player_stats_club(p_user,p_club_id,p_asset);
  IF p_hand_class IS NULL OR btrim(p_hand_class)='' THEN
    RETURN jsonb_build_object('contract_version',2,
      'scope',jsonb_build_object('target_user_id',p_user,'club_id',p_club_id,'asset',p_asset,
        'range_days',CASE WHEN p_days IS NULL THEN NULL ELSE least(greatest(p_days,1),3650) END,'visibility','owner'),
      'hands','[]'::jsonb,'hand_class',NULL,'generated_at',now());
  END IF;
  RETURN jsonb_build_object('contract_version',2,
    'scope',jsonb_build_object('target_user_id',p_user,'club_id',p_club_id,'asset',p_asset,
      'range_days',CASE WHEN p_days IS NULL THEN NULL ELSE least(greatest(p_days,1),3650) END,'visibility','owner'),
    'hand_class',p_hand_class,'hands',coalesce((SELECT jsonb_agg(h ORDER BY played_at DESC)
    FROM (SELECT f.played_at,jsonb_build_object('hand_id',f.hand_id,'played_at',f.played_at,
      'position',f.position,'net',round(f.net,2),'net_bb',round(f.net_bb,2),
      'big_blind',f.big_blind,'variant',f.game_variant,'was_all_in',f.was_all_in,
      'showdown',f.went_to_showdown,'won',f.net>0,'hole_cards',f.hole_cards) h
      FROM public.ca_hand_facts f WHERE f.user_id=p_user AND f.club_id=p_club_id
        AND f.hand_class=p_hand_class AND (p_position IS NULL OR f.position=p_position)
        AND (p_variant IS NULL OR f.game_variant=p_variant)
        AND (p_days IS NULL OR f.played_at>=now()-make_interval(days=>least(greatest(p_days,1),3650)))
      ORDER BY f.played_at DESC LIMIT v_cap) q),'[]'::jsonb),'generated_at',now());
END;$function$;

CREATE OR REPLACE FUNCTION public.ca_player_rake_stats_by_club(
  p_user uuid DEFAULT NULL, p_days integer DEFAULT NULL,
  p_asset text DEFAULT 'chips', p_club_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid:=coalesce(p_user,auth.uid()); v_hands bigint; v_raked bigint;
  v_rake numeric; v_bb numeric; v_first timestamptz; v_last timestamptz;
BEGIN
  PERFORM public.ca_assert_player_stats_club(v_uid,p_club_id,p_asset);
  SELECT count(*),count(*) FILTER(WHERE coalesce(rake_paid,0)>0),coalesce(sum(rake_paid),0),
    coalesce(sum(CASE WHEN big_blind>0 THEN rake_paid/big_blind ELSE 0 END),0),
    min(played_at),max(played_at) INTO v_hands,v_raked,v_rake,v_bb,v_first,v_last
  FROM public.ca_hand_facts WHERE user_id=v_uid AND club_id=p_club_id AND tournament_id IS NULL
    AND (p_days IS NULL OR played_at>=now()-make_interval(days=>least(greatest(p_days,1),3650)));
  RETURN jsonb_build_object('contract_version',2,
    'scope',jsonb_build_object('target_user_id',v_uid,'club_id',p_club_id,'asset',p_asset,
      'range_days',CASE WHEN p_days IS NULL THEN NULL ELSE least(greatest(p_days,1),3650) END,'visibility','owner'),
    'hands',v_hands,'raked_hands',v_raked,'rake_paid',round(v_rake,2),
    'rake_per_100',CASE WHEN v_hands>0 THEN round(v_rake*100/v_hands,2) ELSE 0 END,
    'rake_in_bb',round(v_bb,2),'bb_per_100',CASE WHEN v_hands>0 THEN round(v_bb*100/v_hands,2) ELSE 0 END,
    'avg_rake_per_raked_hand',CASE WHEN v_raked>0 THEN round(v_rake/v_raked,4) ELSE 0 END,
    'first_hand_at',v_first,'last_hand_at',v_last,'days',
      CASE WHEN p_days IS NULL THEN NULL ELSE least(greatest(p_days,1),3650) END);
END;$function$;

CREATE OR REPLACE FUNCTION public.ca_player_stats_pulse_by_club(
  p_user uuid, p_asset text DEFAULT 'chips', p_club_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_hand timestamptz; v_tourn text;
BEGIN
  PERFORM public.ca_assert_player_stats_club(p_user,p_club_id,p_asset);
  SELECT max(played_at) INTO v_hand FROM public.ca_hand_facts
    WHERE user_id=p_user AND club_id=p_club_id;
  SELECT md5(coalesce(string_agg(tp.id::text||':'||coalesce(tp.status,'')||':'||
    coalesce(tp.position::text,'')||':'||coalesce(tp.prize::text,'')||':'||
    coalesce(tp.bounty_winnings::text,''),'|' ORDER BY tp.id),'')) INTO v_tourn
  FROM public.tournament_players tp JOIN public.tournaments t ON t.id=tp.tournament_id
  WHERE tp.user_id=p_user AND t.club_id=p_club_id;
  RETURN jsonb_build_object('contract_version',2,
    'scope',jsonb_build_object('target_user_id',p_user,'club_id',p_club_id,'asset',p_asset,'visibility','owner'),
    'newest_hand_at',v_hand,'tournaments',v_tourn,
    'pulse',coalesce(v_hand::text,'')||'#'||coalesce(v_tourn,''));
END;$function$;

CREATE OR REPLACE FUNCTION public.ca_player_nemesis_by_club(
  p_user uuid, p_days integer DEFAULT NULL, p_min_hands integer DEFAULT 25,
  p_limit integer DEFAULT 10, p_asset text DEFAULT 'chips', p_club_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.ca_assert_player_stats_club(p_user,p_club_id,p_asset);
  RETURN (WITH flows AS (
    SELECT loser_id opponent_id,amount delta FROM public.ca_hand_transfers
      WHERE winner_id=p_user AND club_id=p_club_id AND (p_days IS NULL OR played_at>=now()-make_interval(days=>least(greatest(p_days,1),3650)))
    UNION ALL SELECT winner_id,-amount FROM public.ca_hand_transfers
      WHERE loser_id=p_user AND club_id=p_club_id AND (p_days IS NULL OR played_at>=now()-make_interval(days=>least(greatest(p_days,1),3650)))
  ), netted AS (SELECT opponent_id,sum(delta) net_chips FROM flows GROUP BY opponent_id),
  shared AS (SELECT o.opponent_id,count(*) hands_together,max(f.played_at) last_played_at
    FROM public.ca_hand_facts f CROSS JOIN LATERAL unnest(coalesce(f.opponent_ids,'{}'::uuid[])) o(opponent_id)
    WHERE f.user_id=p_user AND f.club_id=p_club_id
      AND (p_days IS NULL OR f.played_at>=now()-make_interval(days=>least(greatest(p_days,1),3650))) GROUP BY o.opponent_id),
  j AS (SELECT n.opponent_id,n.net_chips,s.hands_together,s.last_played_at,p.username,p.avatar_url
    FROM netted n JOIN shared s USING(opponent_id) LEFT JOIN public.profiles p ON p.id=n.opponent_id
    WHERE s.hands_together>=p_min_hands)
  SELECT jsonb_build_object('contract_version',2,
    'scope',jsonb_build_object('target_user_id',p_user,'club_id',p_club_id,'asset',p_asset,
      'range_days',CASE WHEN p_days IS NULL THEN NULL ELSE least(greatest(p_days,1),3650) END,'visibility','owner'),
    'nemesis',(SELECT to_jsonb(x) FROM (SELECT * FROM j WHERE net_chips<0 ORDER BY net_chips LIMIT 1)x),
    'target',(SELECT to_jsonb(x) FROM (SELECT * FROM j WHERE net_chips>0 ORDER BY net_chips DESC LIMIT 1)x),
    'worst',coalesce((SELECT jsonb_agg(x) FROM (SELECT * FROM j WHERE net_chips<0 ORDER BY net_chips LIMIT p_limit)x),'[]'::jsonb),
    'best',coalesce((SELECT jsonb_agg(x) FROM (SELECT * FROM j WHERE net_chips>0 ORDER BY net_chips DESC LIMIT p_limit)x),'[]'::jsonb),
    'min_hands',p_min_hands,'opponents_qualified',(SELECT count(*) FROM j),'generated_at',now()));
END;$function$;

CREATE OR REPLACE FUNCTION public.ca_player_hands_v2_by_club(
  p_user uuid,
  p_mode text DEFAULT 'recent',
  p_limit integer DEFAULT 25,
  p_asset text DEFAULT 'chips',
  p_club_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  c_window constant integer := 750;
  v_limit integer := least(greatest(coalesce(p_limit,25),1),100);
  v_mode text := lower(coalesce(p_mode,'recent'));
BEGIN
  PERFORM public.ca_assert_player_stats_club(p_user,p_club_id,p_asset);
  IF v_mode NOT IN ('recent','biggest_won','biggest_lost') THEN
    v_mode := 'recent';
  END IF;
  RETURN (WITH mine AS MATERIALIZED (
    SELECT f.hand_id id, f.played_at, f.game_variant variant, f.big_blind,
      f.tournament_id IS NOT NULL is_tournament, nullif(f.position,'UNK') position,
      round(coalesce(h.pot_size,0)::numeric,2) pot_size,
      round(f.returned,2) won, round(f.net,2) profit, f.net>0 is_winner,
      f.players_dealt players, coalesce(h.board,to_jsonb(h.community_cards)) board,
      f.hole_cards
    FROM public.ca_hand_facts f
    LEFT JOIN public.hand_history h ON h.id=f.hand_id
    WHERE f.user_id=p_user AND f.club_id=p_club_id
      AND (v_mode='recent' OR f.tournament_id IS NULL)
    ORDER BY f.played_at DESC
    LIMIT CASE WHEN v_mode='recent' THEN v_limit ELSE c_window END
  ), ranked AS (
    SELECT * FROM mine
    ORDER BY CASE WHEN v_mode='biggest_won' THEN profit END DESC NULLS LAST,
      CASE WHEN v_mode='biggest_lost' THEN profit END ASC NULLS LAST,
      CASE WHEN v_mode='recent' THEN played_at END DESC NULLS LAST
    LIMIT v_limit
  ) SELECT jsonb_build_object('contract_version',2,
    'scope',jsonb_build_object('target_user_id',p_user,'club_id',p_club_id,'asset',p_asset,'visibility','owner'),
    'hands',coalesce(jsonb_agg(to_jsonb(r)
    ORDER BY CASE WHEN v_mode='biggest_won' THEN profit END DESC NULLS LAST,
      CASE WHEN v_mode='biggest_lost' THEN profit END ASC NULLS LAST,
      CASE WHEN v_mode='recent' THEN played_at END DESC NULLS LAST), '[]'::jsonb),
    'generated_at',now())
    FROM ranked r);
END;$function$;

-- One bounded self-only payload for the multi-club comparison table. Every
-- additive cash value comes from exact settlement facts and rates are rebuilt
-- from their numerators/denominators. Hours and a true 3-bet opportunity rate
-- are intentionally unavailable because ca_hand_facts does not retain those
-- denominators. Existing All Clubs includes pre-fact rollup history, so this
-- endpoint does not pretend the two coverage populations conserve.
CREATE OR REPLACE FUNCTION public.ca_player_stats_club_comparison(
  p_user uuid,
  p_days integer DEFAULT NULL,
  p_asset text DEFAULT 'chips',
  p_tz text DEFAULT 'UTC'
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_days integer := CASE WHEN p_days IS NULL THEN NULL ELSE least(greatest(p_days,1),3650) END;
  v_tz text := CASE WHEN EXISTS (SELECT 1 FROM pg_timezone_names WHERE name=p_tz) THEN p_tz ELSE 'UTC' END;
  v_from timestamptz := CASE WHEN v_days IS NULL THEN NULL ELSE
    (((now() AT TIME ZONE v_tz)::date-(v_days-1))::timestamp AT TIME ZONE v_tz) END;
  v_to timestamptz := CASE WHEN v_days IS NULL THEN NULL ELSE
    ((((now() AT TIME ZONE v_tz)::date+1)::timestamp) AT TIME ZONE v_tz) END;
BEGIN
  PERFORM public.ca_assert_self(p_user);
  IF p_asset IS NULL OR p_asset NOT IN ('chips','diamonds') THEN
    RAISE EXCEPTION 'unknown stats asset: %', p_asset USING ERRCODE='22023';
  END IF;
  RETURN (WITH memberships AS MATERIALIZED (
    SELECT DISTINCT c.id club_id, c.name club_name
    FROM public.club_members m JOIN public.clubs c ON c.id=m.club_id
    WHERE m.user_id=p_user AND m.status IN ('active','approved')
      AND coalesce(c.lifecycle_status,'active')<>'retired'
      AND coalesce(c.asset,'chips')=p_asset
  ), cash AS (
    SELECT f.club_id, count(*)::integer total_hands,
      count(*) FILTER (WHERE f.tournament_id IS NULL)::integer cash_hands,
      coalesce(sum(f.net) FILTER (WHERE f.tournament_id IS NULL),0) profit,
      coalesce(sum(f.net_bb) FILTER (WHERE f.tournament_id IS NULL),0) net_bb,
      count(*) FILTER (WHERE f.vpip)::integer vpip_hands,
      count(*) FILTER (WHERE f.pfr)::integer pfr_hands,
      coalesce(sum(f.rake_paid) FILTER (WHERE f.tournament_id IS NULL),0) rake_paid,
      max(f.played_at) last_played_at, min(f.played_at) first_played_at
    FROM public.ca_hand_facts f JOIN memberships m ON m.club_id=f.club_id
    WHERE f.user_id=p_user
      AND (v_from IS NULL OR f.played_at>=v_from)
      AND (v_to IS NULL OR f.played_at<v_to)
    GROUP BY f.club_id
  ), tourn AS (
    SELECT t.club_id, count(*)::integer tournament_entries,
      count(*) FILTER (WHERE coalesce(tp.prize,0)>0)::integer tournament_cashes,
      count(*) FILTER (WHERE tp.position=1 OR tp.status='winner')::integer tournament_wins,
      coalesce(sum(coalesce(tp.prize,0)+coalesce(tp.bounty_winnings,0)),0) tournament_winnings,
      max(t.ended_at) tournament_last_played_at
    FROM public.tournament_players tp JOIN public.tournaments t ON t.id=tp.tournament_id
    JOIN memberships m ON m.club_id=t.club_id
    WHERE tp.user_id=p_user
      AND upper(coalesce(t.status,''))='COMPLETED'
      AND t.ended_at IS NOT NULL
      AND (v_from IS NULL OR t.ended_at>=v_from)
      AND (v_to IS NULL OR t.ended_at<v_to)
    GROUP BY t.club_id
  ), rows AS (
    SELECT m.club_id,m.club_name,coalesce(c.total_hands,0) hands,
      coalesce(c.cash_hands,0) cash_hands,
      round(coalesce(c.profit,0),2) profit,
      coalesce(round(c.net_bb/nullif(c.cash_hands,0)*100,2),0) bb_per_100,
      coalesce(round(c.vpip_hands::numeric/nullif(c.total_hands,0),4),0) vpip,
      coalesce(round(c.pfr_hands::numeric/nullif(c.total_hands,0),4),0) pfr,
      NULL::numeric hours,
      round(coalesce(c.rake_paid,0),2) rake,
      coalesce(t.tournament_entries,0) tournament_entries,
      coalesce(t.tournament_cashes,0) tournament_cashes,
      coalesce(t.tournament_wins,0) tournament_wins,
      round(coalesce(t.tournament_winnings,0),2) tournament_winnings,
      greatest(c.last_played_at,t.tournament_last_played_at) last_played_at,
      c.first_played_at,
      coalesce(c.vpip_hands,0) vpip_numerator,
      coalesce(c.pfr_hands,0) pfr_numerator,
      coalesce(c.total_hands,0) dealt_denominator,
      coalesce(c.net_bb,0) net_bb_numerator
    FROM memberships m LEFT JOIN cash c USING(club_id) LEFT JOIN tourn t USING(club_id)
  ), totals AS (
    SELECT coalesce(sum(hands),0) hands,coalesce(sum(cash_hands),0) cash_hands,
      round(coalesce(sum(profit),0),2) profit,
      round(coalesce(sum(rake),0),2) rake,coalesce(sum(tournament_entries),0) tournament_entries,
      coalesce(sum(tournament_cashes),0) tournament_cashes,
      coalesce(sum(tournament_wins),0) tournament_wins,
      round(coalesce(sum(tournament_winnings),0),2) tournament_winnings,
      coalesce(sum(vpip_numerator),0) vpip_numerator,
      coalesce(sum(pfr_numerator),0) pfr_numerator,
      coalesce(sum(dealt_denominator),0) dealt_denominator,
      coalesce(sum(net_bb_numerator),0) net_bb_numerator,max(last_played_at) last_played_at
    FROM rows
  ) SELECT jsonb_build_object('contract_version',2,
    'scope',jsonb_build_object('target_user_id',p_user,'asset',p_asset,'range_days',v_days,
      'range_tz',v_tz,'visibility','owner'),
    'quality',jsonb_build_object('cash_money_source','exact_settlement','cash_money_exact',true,
      'historical_club_breakdown_available',false,'club_breakdown_source','ca_hand_facts',
      'hours_available',false,'three_bet_percent_available',false,
      'tournament_money_exact',false,
      'all_clubs_contract_conservation_comparable',false,
      'all_clubs_contract_conservation_reason','existing All Clubs includes pre-fact rollup history without club identity'),
    'rows',coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY club_name,club_id) FROM rows r),'[]'::jsonb),
    'totals',(SELECT to_jsonb(t)||jsonb_build_object(
      'bb_per_100',coalesce(round(net_bb_numerator/nullif(cash_hands,0)*100,2),0),
      'vpip',coalesce(round(vpip_numerator::numeric/nullif(dealt_denominator,0),4),0),
      'pfr',coalesce(round(pfr_numerator::numeric/nullif(dealt_denominator,0),4),0),
      'hours',NULL) FROM totals t),
    'generated_at',now()));
END;$function$;

-- Evidence is filtered in PostgreSQL before its bounded keyset page. The RPC
-- returns only the caller's own durable fact row and the hand id used by the
-- existing independently-authorized replay door. It never returns another
-- player's cards or private note text.
CREATE OR REPLACE FUNCTION public.ca_player_stats_hand_evidence(
  p_user uuid,
  p_club_id uuid DEFAULT NULL,
  p_asset text DEFAULT 'chips',
  p_variant text DEFAULT NULL,
  p_position text DEFAULT NULL,
  p_big_blind numeric DEFAULT NULL,
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_outcome text DEFAULT NULL,
  p_showdown boolean DEFAULT NULL,
  p_all_in boolean DEFAULT NULL,
  p_big_pots boolean DEFAULT NULL,
  p_noted boolean DEFAULT NULL,
  p_hand_class text DEFAULT NULL,
  p_tournament boolean DEFAULT NULL,
  p_cursor_played_at timestamptz DEFAULT NULL,
  p_cursor_hand_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 25
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit,25),1),100);
  v_variant text := lower(nullif(btrim(p_variant),''));
  v_position text := upper(nullif(btrim(p_position),''));
  v_outcome text := lower(nullif(btrim(p_outcome),''));
BEGIN
  PERFORM public.ca_assert_self(p_user);
  IF p_asset IS NULL OR p_asset NOT IN ('chips','diamonds') THEN
    RAISE EXCEPTION 'unknown stats asset: %',p_asset USING ERRCODE='22023';
  END IF;
  IF p_club_id IS NOT NULL THEN
    PERFORM public.ca_assert_player_stats_club(p_user,p_club_id,p_asset);
  END IF;
  IF v_outcome IS NOT NULL AND v_outcome NOT IN ('won','lost') THEN
    RAISE EXCEPTION 'unknown evidence outcome: %',p_outcome USING ERRCODE='22023';
  END IF;
  IF (p_cursor_played_at IS NULL) <> (p_cursor_hand_id IS NULL) THEN
    RAISE EXCEPTION 'evidence cursor requires played_at and hand_id together' USING ERRCODE='22023';
  END IF;
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from >= p_to THEN
    RAISE EXCEPTION 'evidence range must be increasing' USING ERRCODE='22023';
  END IF;

  RETURN (WITH filtered AS MATERIALIZED (
    SELECT f.hand_id,f.played_at,f.club_id,f.table_id,f.tournament_id,
      f.game_variant,f.big_blind,f.position,f.players_dealt,f.hand_class,
      f.invested,f.returned,f.net,f.net_bb,f.rake_paid,f.vpip,f.pfr,
      f.three_bet,f.faced_three_bet,f.folded_to_three_bet,
      f.had_cbet_flop_opp,f.cbet_flop,f.saw_flop,f.went_to_showdown,
      f.won_at_showdown,f.aggressive_actions,f.passive_actions,f.was_all_in,
      f.ev_net_bb,f.hole_cards own_hole_cards,
      h.pot_size,n.hand_id IS NOT NULL noted
    FROM public.ca_hand_facts f
    JOIN public.clubs c ON c.id=f.club_id
    LEFT JOIN public.hand_history h ON h.id=f.hand_id
    LEFT JOIN public.ca_hand_notes n ON n.user_id=p_user AND n.hand_id=f.hand_id
    WHERE f.user_id=p_user
      AND coalesce(c.asset,'chips')=p_asset
      AND (p_club_id IS NULL OR f.club_id=p_club_id)
      AND (v_variant IS NULL OR lower(f.game_variant)=CASE
        WHEN v_variant IN ('holdem','texasholdem') THEN 'nlh'
        WHEN v_variant IN ('omaha','plo') THEN 'plo4'
        ELSE v_variant END)
      AND (v_position IS NULL OR upper(f.position)=v_position)
      AND (p_big_blind IS NULL OR f.big_blind=p_big_blind)
      AND (p_from IS NULL OR f.played_at>=p_from)
      AND (p_to IS NULL OR f.played_at<p_to)
      AND (v_outcome IS NULL OR (v_outcome='won' AND f.net>0) OR (v_outcome='lost' AND f.net<0))
      AND (p_showdown IS NULL OR f.went_to_showdown=p_showdown)
      AND (p_all_in IS NULL OR f.was_all_in=p_all_in)
      AND (p_big_pots IS NULL OR NOT p_big_pots OR
        (h.pot_size IS NOT NULL AND f.big_blind>0 AND h.pot_size>=f.big_blind*100))
      AND (p_noted IS NULL OR NOT p_noted OR n.hand_id IS NOT NULL)
      AND (p_hand_class IS NULL OR f.hand_class=p_hand_class)
      AND (p_tournament IS NULL OR (f.tournament_id IS NOT NULL)=p_tournament)
      AND (p_cursor_played_at IS NULL OR (f.played_at,f.hand_id)<(p_cursor_played_at,p_cursor_hand_id))
    ORDER BY f.played_at DESC,f.hand_id DESC
    LIMIT v_limit+1
  ), numbered AS (
    SELECT filtered.*,row_number() OVER (ORDER BY played_at DESC,hand_id DESC) rn
    FROM filtered
  ), page AS (
    SELECT * FROM numbered WHERE rn<=v_limit
  ), last_row AS (
    SELECT played_at,hand_id FROM page ORDER BY played_at,hand_id LIMIT 1
  ) SELECT jsonb_build_object(
    'contract_version',2,
    'hands',coalesce((SELECT jsonb_agg(to_jsonb(p)-'rn' ORDER BY played_at DESC,hand_id DESC) FROM page p),'[]'::jsonb),
    'has_more',(SELECT count(*)>v_limit FROM filtered),
    'next_cursor',CASE WHEN (SELECT count(*)>v_limit FROM filtered) THEN
      (SELECT jsonb_build_object('played_at',played_at,'hand_id',hand_id) FROM last_row)
      ELSE NULL END,
    'scope',jsonb_build_object('target_user_id',p_user,'club_id',p_club_id,'asset',p_asset,
      'from_inclusive',p_from,'to_exclusive',p_to),
    'generated_at',now()));
END;$function$;

-- Repair the installed All-Clubs facade without changing its public signature.
-- ca_player_stats_full remains the bounded source for analysis-only charts and
-- sessions; headline cash totals and daily results are overlaid from every
-- matching-asset settlement fact in the exact calendar window.
DO $drift$
BEGIN
  IF to_regprocedure('public.ca_player_stats_full(uuid,integer,text,text)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='ca_hand_player_stat' AND column_name='asset')
  THEN
    RAISE EXCEPTION 'Stats Phase 3 source contract drifted; refusing unsafe replacement'
      USING ERRCODE='P0404';
  END IF;
END;
$drift$;
CREATE OR REPLACE FUNCTION public.ca_player_stats_overview_v2(
  p_user uuid, p_days integer DEFAULT NULL, p_tz text DEFAULT 'UTC',
  p_asset text DEFAULT 'chips'
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_days integer; v_tz text; v_from timestamptz; v_to timestamptz;
  v_base jsonb; v_overall jsonb; v_daily jsonb; v_tournaments jsonb; v_recent jsonb;
  v_analysis jsonb;
  v_total integer; v_cash integer; v_tourney integer; v_won integer;
  v_vpip integer; v_pfr integer; v_profit numeric; v_returned numeric;
  v_invested numeric; v_net_bb numeric; v_biggest numeric; v_loss numeric;
  v_first timestamptz; v_last timestamptz; v_exact_cash integer;
BEGIN
  PERFORM public.ca_assert_self(p_user);
  IF p_asset IS NULL OR p_asset NOT IN ('chips','diamonds') THEN
    RAISE EXCEPTION 'unknown stats asset: %',p_asset USING ERRCODE='22023';
  END IF;
  SELECT b.range_days,b.range_tz,b.from_at,b.to_at
    INTO v_days,v_tz,v_from,v_to FROM public.ca_stats_calendar_bounds(p_days,p_tz) b;
  v_base := public.ca_player_stats_full(p_user,v_days,v_tz,p_asset);

  WITH source_rows AS MATERIALIZED (
    SELECT s.hand_id,s.created_at,s.is_cash,s.tournament_id,s.is_winner,s.vpip,s.pfr,
      coalesce(f.net,s.profit) net,coalesce(f.returned,s.won_amt) returned,
      coalesce(f.invested,s.invested_actions+s.my_blind) invested,
      coalesce(f.net_bb,s.profit/nullif(s.big_blind,0)) net_bb,(f.hand_id IS NOT NULL) exact
    FROM public.ca_hand_player_stat s
    LEFT JOIN public.ca_hand_facts f ON f.hand_id=s.hand_id AND f.user_id=s.user_id
    WHERE s.user_id=p_user AND s.asset=p_asset
      AND (v_from IS NULL OR s.created_at>=v_from) AND (v_to IS NULL OR s.created_at<v_to)
    UNION ALL
    SELECT f.hand_id,f.played_at,(f.tournament_id IS NULL),f.tournament_id,(f.net>0),f.vpip,f.pfr,
      f.net,f.returned,f.invested,f.net_bb,true
    FROM public.ca_hand_facts f JOIN public.clubs c ON c.id=f.club_id
    WHERE f.user_id=p_user AND coalesce(c.asset,'chips')=p_asset
      AND (v_from IS NULL OR f.played_at>=v_from) AND (v_to IS NULL OR f.played_at<v_to)
      AND NOT EXISTS (SELECT 1 FROM public.ca_hand_player_stat s WHERE s.user_id=f.user_id AND s.hand_id=f.hand_id)
  )
  SELECT count(*)::integer,count(*) FILTER(WHERE is_cash)::integer,
    count(*) FILTER(WHERE NOT is_cash)::integer,count(*) FILTER(WHERE is_winner)::integer,
    count(*) FILTER(WHERE vpip)::integer,count(*) FILTER(WHERE pfr)::integer,
    coalesce(sum(net) FILTER(WHERE is_cash),0),coalesce(sum(returned) FILTER(WHERE is_cash),0),
    coalesce(sum(invested) FILTER(WHERE is_cash),0),coalesce(sum(net_bb) FILTER(WHERE is_cash),0),
    coalesce(max(returned) FILTER(WHERE is_cash),0),coalesce(min(net) FILTER(WHERE is_cash),0),
    min(created_at),max(created_at),count(*) FILTER(WHERE is_cash AND exact)::integer
  INTO v_total,v_cash,v_tourney,v_won,v_vpip,v_pfr,v_profit,v_returned,
    v_invested,v_net_bb,v_biggest,v_loss,v_first,v_last,v_exact_cash FROM source_rows;

  v_overall := coalesce(v_base->'overall','{}'::jsonb)||jsonb_build_object(
    'total_hands',v_total,'cash_hands',v_cash,'exact_cash_hands',v_exact_cash,
    'tourney_hands',v_tourney,'hands_won',v_won,'hands_lost',v_total-v_won,
    'vpip',coalesce(round(v_vpip::numeric/nullif(v_total,0),4),0),
    'pfr',coalesce(round(v_pfr::numeric/nullif(v_total,0),4),0),
    'total_profit',round(v_profit,2),'total_winnings',round(v_returned,2),
    'total_invested',round(v_invested,2),'biggest_pot_won',round(v_biggest,2),
    'biggest_hand_loss',round(v_loss,2),
    'bb_per_100',coalesce(round(v_net_bb/nullif(v_cash,0)*100,2),0),
    'hands_capped',false,'first_hand_at',v_first,'last_hand_at',v_last);
  SELECT coalesce(jsonb_agg(jsonb_build_object('date',d,'hands',hands,'profit',profit) ORDER BY d),'[]'::jsonb)
  INTO v_daily FROM (WITH source_rows AS (
    SELECT s.hand_id,s.created_at,coalesce(f.net,s.profit) net
    FROM public.ca_hand_player_stat s
    LEFT JOIN public.ca_hand_facts f ON f.hand_id=s.hand_id AND f.user_id=s.user_id
    WHERE s.user_id=p_user AND s.is_cash AND s.asset=p_asset
      AND (v_from IS NULL OR s.created_at>=v_from) AND (v_to IS NULL OR s.created_at<v_to)
    UNION ALL
    SELECT f.hand_id,f.played_at,f.net FROM public.ca_hand_facts f JOIN public.clubs c ON c.id=f.club_id
    WHERE f.user_id=p_user AND f.tournament_id IS NULL AND coalesce(c.asset,'chips')=p_asset
      AND (v_from IS NULL OR f.played_at>=v_from) AND (v_to IS NULL OR f.played_at<v_to)
      AND NOT EXISTS (SELECT 1 FROM public.ca_hand_player_stat s WHERE s.user_id=f.user_id AND s.hand_id=f.hand_id)
  ) SELECT date(created_at AT TIME ZONE v_tz) d,count(*)::integer hands,round(sum(net),2) profit
    FROM source_rows GROUP BY 1) x;
  WITH tr AS MATERIALIZED (
    SELECT tp.*,t.name,t.start_time,t.ended_at,t.variant,t.buy_in_amount,t.buy_in_fee,
      t.rebuy_cost,t.addon_cost,t.is_mystery_bounty
    FROM public.tournament_players tp JOIN public.tournaments t ON t.id=tp.tournament_id
    JOIN public.clubs c ON c.id=t.club_id
    WHERE tp.user_id=p_user AND coalesce(c.asset,'chips')=p_asset
      AND upper(coalesce(t.status,''))='COMPLETED' AND t.ended_at IS NOT NULL
      AND (v_from IS NULL OR t.ended_at>=v_from) AND (v_to IS NULL OR t.ended_at<v_to)
  ), totals AS (
    SELECT count(*)::integer entries,count(*) FILTER(WHERE coalesce(prize,0)>0)::integer cashes,
      count(*) FILTER(WHERE position=1 OR status='winner')::integer wins,
      min(position) FILTER(WHERE position IS NOT NULL) best_finish,
      coalesce(sum(coalesce(buy_in_amount,0)+coalesce(buy_in_fee,0)+coalesce(rebuys,0)*coalesce(rebuy_cost,0)+CASE WHEN add_on THEN coalesce(addon_cost,0) ELSE 0 END),0) buyins,
      coalesce(sum(coalesce(prize,0)),0) prizes,coalesce(sum(coalesce(bounty_winnings,0)),0) bounties
    FROM tr
  ) SELECT jsonb_build_object('entries',entries,'cashes',cashes,'wins',wins,'best_finish',best_finish,
      'itm_percent',coalesce(round(cashes::numeric/nullif(entries,0),4),0),'total_buyins',round(buyins,2),
      'total_winnings',round(prizes+bounties,2),'total_prizes',round(prizes,2),
      'total_bounty_winnings',round(bounties,2),'net_profit',round(prizes+bounties-buyins,2),
      'roi',coalesce(round((prizes+bounties-buyins)/nullif(buyins,0),4),0))
    INTO v_tournaments FROM totals;
  WITH tr AS (
    SELECT tp.tournament_id,t.name,t.start_time,t.ended_at,t.variant,tp.position,tp.status,
      coalesce(tp.prize,0) prize,coalesce(tp.bounty_winnings,0) bounty_winnings
    FROM public.tournament_players tp JOIN public.tournaments t ON t.id=tp.tournament_id
    JOIN public.clubs c ON c.id=t.club_id
    WHERE tp.user_id=p_user AND coalesce(c.asset,'chips')=p_asset
      AND upper(coalesce(t.status,''))='COMPLETED' AND t.ended_at IS NOT NULL
      AND (v_from IS NULL OR t.ended_at>=v_from) AND (v_to IS NULL OR t.ended_at<v_to)
    ORDER BY t.ended_at DESC LIMIT 25
  ) SELECT coalesce(jsonb_agg(to_jsonb(tr) ORDER BY ended_at DESC),'[]'::jsonb) INTO v_recent FROM tr;
  -- The legacy full RPC uses a rolling clock cutoff. Rebuild every capped
  -- analysis section from the same validated calendar population as the
  -- headline so one range label never describes two different windows.
  WITH source_rows AS MATERIALIZED (
    SELECT s.hand_id,s.created_at,s.is_cash,s.game_variant,s.big_blind,s.seat_position position,
      s.is_winner,s.vpip,s.pfr,coalesce(f.net,s.profit) net,
      coalesce(f.invested,s.invested_actions+s.my_blind) invested,
      coalesce(f.net_bb,s.profit/nullif(s.big_blind,0)) net_bb
    FROM public.ca_hand_player_stat s LEFT JOIN public.ca_hand_facts f ON f.hand_id=s.hand_id AND f.user_id=s.user_id
    WHERE s.user_id=p_user AND s.asset=p_asset
      AND (v_from IS NULL OR s.created_at>=v_from) AND (v_to IS NULL OR s.created_at<v_to)
    UNION ALL
    SELECT f.hand_id,f.played_at,(f.tournament_id IS NULL),f.game_variant,f.big_blind,f.position,
      (f.net>0),f.vpip,f.pfr,f.net,f.invested,f.net_bb
    FROM public.ca_hand_facts f JOIN public.clubs c ON c.id=f.club_id
    WHERE f.user_id=p_user AND coalesce(c.asset,'chips')=p_asset
      AND (v_from IS NULL OR f.played_at>=v_from) AND (v_to IS NULL OR f.played_at<v_to)
      AND NOT EXISTS (SELECT 1 FROM public.ca_hand_player_stat s WHERE s.user_id=f.user_id AND s.hand_id=f.hand_id)
  ), scored AS MATERIALIZED (SELECT * FROM source_rows ORDER BY created_at DESC LIMIT 750),
  positions AS (SELECT position,count(*)::integer hands_played,count(*) FILTER(WHERE vpip)::integer vpip_count,
    count(*) FILTER(WHERE pfr)::integer pfr_count,count(*) FILTER(WHERE is_winner)::integer hands_won,
    round(coalesce(sum(net) FILTER(WHERE is_cash),0),2) total_profit,
    coalesce(round(sum(net_bb) FILTER(WHERE is_cash)/nullif(count(*) FILTER(WHERE is_cash),0)*100,2),0) bb100
    FROM scored GROUP BY position),
  variants AS (SELECT game_variant variant,count(*)::integer hands,count(*) FILTER(WHERE is_winner)::integer hands_won,
    round(coalesce(sum(net) FILTER(WHERE is_cash),0),2) profit,
    coalesce(round(sum(net_bb) FILTER(WHERE is_cash)/nullif(count(*) FILTER(WHERE is_cash),0)*100,2),0) bb100
    FROM scored GROUP BY game_variant),
  stakes AS (SELECT big_blind,count(*)::integer hands,count(*) FILTER(WHERE is_winner)::integer hands_won,
    round(sum(net),2) profit,coalesce(round(sum(net_bb)/nullif(count(*),0)*100,2),0) bb100
    FROM scored WHERE is_cash AND big_blind>0 GROUP BY big_blind),
  marked AS (SELECT *,CASE WHEN created_at-lag(created_at) OVER(ORDER BY created_at)>interval '45 minutes'
    OR lag(created_at) OVER(ORDER BY created_at) IS NULL THEN 1 ELSE 0 END new_session FROM scored WHERE is_cash),
  grouped AS (SELECT *,sum(new_session) OVER(ORDER BY created_at) session_no FROM marked),
  sessions AS (SELECT session_no,min(created_at) started,max(created_at) ended,count(*)::integer hands,
    round(sum(net),2) profit,round(sum(invested),2) invested FROM grouped GROUP BY session_no ORDER BY session_no DESC LIMIT 50)
  SELECT jsonb_build_object(
    'positions',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY position) FROM positions p),'[]'::jsonb),
    'variants',coalesce((SELECT jsonb_agg(to_jsonb(v) ORDER BY hands DESC) FROM variants v),'[]'::jsonb),
    'stakes',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY big_blind DESC) FROM stakes s),'[]'::jsonb),
    'sessions',coalesce((SELECT jsonb_agg(jsonb_build_object('id',session_no,'date',started,'ended',ended,
      'duration_minutes',greatest(1,round(extract(epoch FROM (ended-started))/60)::integer),
      'hands_played',hands,'buy_in',invested,'cash_out',round(invested+profit,2),'profit_loss',profit)
      ORDER BY session_no DESC) FROM sessions),'[]'::jsonb)) INTO v_analysis;
  RETURN v_base||jsonb_build_object('contract_version',2,'generated_at',now(),'window_days',v_days,
    'window_tz',v_tz,'scope',jsonb_build_object('target_user_id',p_user,'club_id',NULL,
      'asset',p_asset,'range_days',v_days,'range_tz',v_tz,'visibility','owner'),
    'overall',v_overall,'daily',v_daily,'positions',v_analysis->'positions',
    'variants',v_analysis->'variants','stakes',v_analysis->'stakes','sessions',v_analysis->'sessions',
    'tournaments',v_tournaments,'recent_tournaments',v_recent,
    'coverage',coalesce(v_base->'coverage','{}'::jsonb)||jsonb_build_object(
      'analysis_hand_cap',750,'analysis_sample_hands',least(v_total,750),
      'analysis_hands_capped',v_total>750),
    'quality',coalesce(v_base->'quality','{}'::jsonb)||jsonb_build_object(
      'cash_money_source',CASE WHEN v_cash=0 OR v_exact_cash=v_cash THEN 'exact_settlement'
        WHEN v_exact_cash=0 THEN 'reconstructed_actions' ELSE 'mixed' END,
      'cash_money_exact',(v_cash=0 OR v_exact_cash=v_cash),'exact_cash_hands',v_exact_cash,
      'advanced_facts_source','ca_hand_player_stat'));
END;$function$;

-- A peer can discover only exact clubs both players currently share for the
-- requested asset. No unrestricted/all-clubs peer scope exists.
CREATE OR REPLACE FUNCTION public.ca_player_stats_shared_clubs(
  p_target_user uuid,p_asset text DEFAULT 'chips'
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_viewer uuid:=auth.uid();
BEGIN
  IF v_viewer IS NULL OR p_target_user IS NULL OR v_viewer=p_target_user THEN
    RAISE EXCEPTION 'shared player stats require a distinct signed-in viewer' USING ERRCODE='42501';
  END IF;
  IF p_asset NOT IN ('chips','diamonds') THEN RAISE EXCEPTION 'unknown stats asset' USING ERRCODE='22023'; END IF;
  RETURN (WITH eligible AS (
    SELECT DISTINCT c.id,c.name FROM public.clubs c
    JOIN public.club_members vm ON vm.club_id=c.id AND vm.user_id=v_viewer AND vm.status IN ('active','approved')
    JOIN public.club_members tm ON tm.club_id=c.id AND tm.user_id=p_target_user AND tm.status IN ('active','approved')
    WHERE coalesce(c.lifecycle_status,'active')<>'retired' AND coalesce(c.asset,'chips')=p_asset
  ) SELECT jsonb_build_object('contract_version',2,'scope',jsonb_build_object(
    'viewer_user_id',v_viewer,'target_user_id',p_target_user,'club_id',NULL,'asset',p_asset,
    'visibility','shared_club'),'clubs',coalesce(jsonb_agg(to_jsonb(eligible) ORDER BY name,id),'[]'::jsonb),
    'generated_at',now()) FROM eligible);
END;$function$;

CREATE OR REPLACE FUNCTION public.ca_player_stats_shared_overview_v1(
  p_target_user uuid,p_club_id uuid,p_days integer DEFAULT NULL,
  p_tz text DEFAULT 'UTC',p_asset text DEFAULT 'chips'
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_viewer uuid:=auth.uid(); v_days integer; v_tz text; v_from timestamptz; v_to timestamptz;
BEGIN
  IF v_viewer IS NULL OR p_target_user IS NULL OR v_viewer=p_target_user OR p_club_id IS NULL THEN
    RAISE EXCEPTION 'shared player stats require viewer, target and club' USING ERRCODE='42501';
  END IF;
  IF p_asset NOT IN ('chips','diamonds') THEN RAISE EXCEPTION 'unknown stats asset' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.clubs c
    JOIN public.club_members vm ON vm.club_id=c.id AND vm.user_id=v_viewer AND vm.status IN ('active','approved')
    JOIN public.club_members tm ON tm.club_id=c.id AND tm.user_id=p_target_user AND tm.status IN ('active','approved')
    WHERE c.id=p_club_id AND coalesce(c.lifecycle_status,'active')<>'retired' AND coalesce(c.asset,'chips')=p_asset)
  THEN RAISE EXCEPTION 'not authorized for shared player stats club' USING ERRCODE='42501'; END IF;
  SELECT b.range_days,b.range_tz,b.from_at,b.to_at INTO v_days,v_tz,v_from,v_to
    FROM public.ca_stats_calendar_bounds(p_days,p_tz) b;
  RETURN (WITH facts AS (
    SELECT * FROM public.ca_hand_facts f WHERE f.user_id=p_target_user AND f.club_id=p_club_id
      AND (v_from IS NULL OR f.played_at>=v_from) AND (v_to IS NULL OR f.played_at<v_to)
  ), a AS (SELECT count(*)::integer hands,count(*) FILTER(WHERE tournament_id IS NULL)::integer cash_hands,
      count(*) FILTER(WHERE tournament_id IS NOT NULL)::integer tournament_hands,
      count(*) FILTER(WHERE net>0)::integer hands_won,count(*) FILTER(WHERE vpip)::integer vpip_hands,
      count(*) FILTER(WHERE pfr)::integer pfr_hands,coalesce(sum(net_bb) FILTER(WHERE tournament_id IS NULL),0) net_bb,
      max(played_at) last_played_at FROM facts), tr AS (
    SELECT count(*)::integer entries,count(*) FILTER(WHERE coalesce(tp.prize,0)>0)::integer cashes,
      count(*) FILTER(WHERE tp.position=1 OR tp.status='winner')::integer wins
    FROM public.tournament_players tp JOIN public.tournaments t ON t.id=tp.tournament_id
    WHERE tp.user_id=p_target_user AND t.club_id=p_club_id AND upper(coalesce(t.status,''))='COMPLETED'
      AND t.ended_at IS NOT NULL AND (v_from IS NULL OR t.ended_at>=v_from) AND (v_to IS NULL OR t.ended_at<v_to)
  ) SELECT jsonb_build_object('contract_version',2,'scope',jsonb_build_object('viewer_user_id',v_viewer,
      'target_user_id',p_target_user,'club_id',p_club_id,'asset',p_asset,'range_days',v_days,
      'range_tz',v_tz,'visibility','shared_club'),
    'overview',(SELECT jsonb_build_object('hands',hands,'cash_hands',cash_hands,'tournament_hands',tournament_hands,
      'hands_won',hands_won,'vpip',coalesce(round(vpip_hands::numeric/nullif(hands,0),4),0),
      'pfr',coalesce(round(pfr_hands::numeric/nullif(hands,0),4),0),
      'bb_per_100',coalesce(round(net_bb/nullif(cash_hands,0)*100,2),0),'last_played_at',last_played_at) FROM a),
    'tournaments',(SELECT to_jsonb(tr) FROM tr),'generated_at',now()));
END;$function$;

REVOKE ALL ON FUNCTION public.ca_player_ev_curve_by_club(uuid,integer,integer,text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.ca_player_hand_grid_by_club(uuid,text,text,integer,text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.ca_player_class_hands_by_club(uuid,text,text,text,integer,integer,text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.ca_player_rake_stats_by_club(uuid,integer,text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.ca_player_stats_pulse_by_club(uuid,text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.ca_player_nemesis_by_club(uuid,integer,integer,integer,text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.ca_player_hands_v2_by_club(uuid,text,integer,text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.ca_player_stats_club_comparison(uuid,integer,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.ca_player_stats_hand_evidence(uuid,uuid,text,text,text,numeric,timestamptz,timestamptz,text,boolean,boolean,boolean,boolean,text,boolean,timestamptz,uuid,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.ca_player_stats_overview_v2(uuid,integer,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ca_player_ev_curve_by_club(uuid,integer,integer,text,uuid) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ca_player_hand_grid_by_club(uuid,text,text,integer,text,uuid) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ca_player_class_hands_by_club(uuid,text,text,text,integer,integer,text,uuid) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ca_player_rake_stats_by_club(uuid,integer,text,uuid) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_pulse_by_club(uuid,text,uuid) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ca_player_nemesis_by_club(uuid,integer,integer,integer,text,uuid) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ca_player_hands_v2_by_club(uuid,text,integer,text,uuid) TO authenticated,service_role;
REVOKE ALL ON FUNCTION public.ca_player_stats_shared_clubs(uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.ca_player_stats_shared_overview_v1(uuid,uuid,integer,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_club_comparison(uuid,integer,text,text) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_hand_evidence(uuid,uuid,text,text,text,numeric,timestamptz,timestamptz,text,boolean,boolean,boolean,boolean,text,boolean,timestamptz,uuid,integer) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_overview_v2(uuid,integer,text,text) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_shared_clubs(uuid,text) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_shared_overview_v1(uuid,uuid,integer,text,text) TO authenticated,service_role;

COMMIT;
