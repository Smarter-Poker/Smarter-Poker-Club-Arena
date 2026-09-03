-- Stats completion program, phase 1 production certification.
--
-- The v2 browser RPC was owner-only, but it still delegated to the legacy
-- ca_player_stats_full body. That body appended an unbounded live-history tail
-- by calling ca_hand_player_facts(rolled_ceil, now(), p_user). When forward
-- maintenance fell behind, three normal authenticated page loads were enough
-- to make PostgREST lose its schema-cache connection (PGRST002); the request
-- that did reach Postgres was cancelled at the statement timeout (57014).
--
-- Page views now read only ca_hand_player_stat, whose (user_id, created_at DESC)
-- index and 1,000-row/player retention make the 750-row analysis budget real.
-- ca_roll_hand_stats_forward remains the single service-only owner of freshness.
-- The v2 contract exposes the rollup ceiling so the UI and later phases never
-- confuse a bounded, available snapshot with an unbounded live scan.

BEGIN;

DO $patch$
DECLARE
  v_source text;
  v_tail text := $tail$
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
    )$tail$;
BEGIN
  SELECT pg_get_functiondef('public.ca_player_stats_full(uuid,integer)'::regprocedure)
    INTO v_source;

  IF position(v_tail IN v_source) = 0 THEN
    RAISE EXCEPTION
      'ca_player_stats_full live-tail shape changed; refusing an unverified performance patch';
  END IF;

  v_source := replace(v_source, v_tail, '');

  IF position('ca_hand_player_facts(coalesce(v_ceil, now()), now(), p_user)' IN v_source) > 0 THEN
    RAISE EXCEPTION 'ca_player_stats_full still contains the unbounded live-tail call';
  END IF;

  EXECUTE v_source;
END;
$patch$;

CREATE OR REPLACE FUNCTION public.ca_player_stats_overview_v2(
  p_user uuid,
  p_days integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_result jsonb;
  v_rollup_ceil timestamptz;
  v_rollup_updated_at timestamptz;
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

  v_result := public.ca_player_stats_full(p_user, v_days);

  RETURN coalesce(v_result, '{}'::jsonb) || jsonb_build_object(
    'contract_version', 2,
    'scope', jsonb_build_object(
      'target_user_id', p_user,
      'club_id', NULL,
      'range_days', v_days,
      'visibility', 'owner'
    ),
    'quality', jsonb_build_object(
      'cash_money_source', 'reconstructed_actions',
      'cash_money_exact', false,
      'advanced_facts_source', 'ca_hand_player_stat',
      'historical_club_breakdown_available', false,
      'live_tail_included', false
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

REVOKE ALL ON FUNCTION public.ca_player_stats_overview_v2(uuid, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_overview_v2(uuid, integer)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.ca_player_stats_overview_v2(uuid, integer) IS
  'Owner-only Stats v2 overview. Reads the bounded per-player rollup only and reports its coverage ceiling; no page view scans live hand_history.';

DO $assert$
DECLARE
  v_full_definition text;
BEGIN
  SELECT pg_get_functiondef('public.ca_player_stats_full(uuid,integer)'::regprocedure)
    INTO v_full_definition;

  IF position('ca_hand_player_facts(coalesce(v_ceil, now()), now(), p_user)'
              IN v_full_definition) > 0 THEN
    RAISE EXCEPTION 'Stats page path can still open live hand history';
  END IF;

  IF NOT has_function_privilege(
    'authenticated',
    'public.ca_player_stats_overview_v2(uuid,integer)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated cannot execute the bounded Stats v2 contract';
  END IF;

  IF has_function_privilege(
    'authenticated',
    'public.ca_player_stats_full(uuid,integer)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'legacy Stats function became browser-callable again';
  END IF;
END;
$assert$;

COMMIT;
