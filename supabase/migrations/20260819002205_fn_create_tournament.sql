-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819002205 "fn_create_tournament"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3bad77014b376501704ab20336a65e89 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- CREATE A TOURNAMENT FROM THE BROWSER. Owner ruling 2026-08-19.
--
-- Until now this was impossible. public.tournaments has RLS enabled with only
-- two policies — public SELECT and service_role ALL — and no INSERT policy for
-- authenticated. Every browser insert failed with 42501, so the Create
-- Tournament modal has never worked and all 9,481 existing tournaments were
-- created server-side by TournamentRecurringService.
--
-- A SECURITY DEFINER function rather than a plain INSERT policy, because three
-- things must not be client-trusted:
--   * WHO may create — fn_can_create_games enforces the ruling: a standalone
--     club's owner/admin, or the union's owner/admin for a club in a union.
--   * the 10% entry fee — the house rule. TournamentService already overrides
--     whatever the caller typed, but that is client code and can be bypassed by
--     calling the API directly.
--   * the starting state — status, current_players, prize/bounty pools.
--
-- Everything else is passed through from the caller's config after validation.
-- Note the deliberate NOT-NULL-with-no-default columns: name, game_type,
-- buy_in_amount, buy_in_fee, start_time, max_players, status.
CREATE OR REPLACE FUNCTION public.fn_create_tournament(p_club_id uuid, p_config jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid          uuid := auth.uid();
  v_id           uuid;
  v_buy_in       numeric;
  v_fee          numeric;
  v_max_players  int;
  v_min_players  int;
  v_type         text;
  v_variant      text;
  v_start        timestamptz;
  v_payouts      jsonb;
  v_blinds       jsonb;
  v_pct_total    numeric;
  v_is_bounty    boolean;
  v_bounty       numeric;
  v_union_id     uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  IF NOT public.fn_can_create_games(p_club_id, v_uid) THEN
    -- Deliberately one message for every refusal: a caller must not be able to
    -- probe which clubs exist or who administers them.
    RETURN jsonb_build_object('success', false, 'error', 'not_authorised');
  END IF;

  v_buy_in := COALESCE((p_config->>'buyIn')::numeric, 0);
  IF v_buy_in < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'buy_in_must_not_be_negative');
  END IF;

  -- HOUSE RULE: the fee is 10% of the buy-in on any and all tournaments.
  v_fee := round(v_buy_in * 0.1, 2);

  v_max_players := COALESCE((p_config->>'maxPlayers')::int, 0);
  IF v_max_players <= 0 THEN
    -- 0 is not "unlimited": fn_register_for_tournament refuses entry when
    -- current_players >= max_players, so 0 means nobody can ever register.
    RETURN jsonb_build_object('success', false, 'error', 'max_players_must_be_positive');
  END IF;
  v_min_players := GREATEST(COALESCE((p_config->>'minPlayers')::int, 3), 2);
  IF v_min_players > v_max_players THEN
    v_min_players := v_max_players;
  END IF;

  v_type := COALESCE(p_config->>'type', 'mtt');
  v_variant := CASE v_type
                 WHEN 'sng' THEN 'sng'
                 WHEN 'spin' THEN 'spin'
                 WHEN 'bounty' THEN 'bounty'
                 WHEN 'progressive_bounty' THEN 'progressive_bounty'
                 WHEN 'mystery_bounty' THEN 'mystery_bounty'
                 WHEN 'satellite' THEN 'satellite'
                 ELSE 'freezeout'
               END;

  v_blinds  := COALESCE(p_config->'blindStructure', '[]'::jsonb);
  v_payouts := COALESCE(p_config->'payoutStructure', '[]'::jsonb);

  IF jsonb_array_length(v_blinds) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'blind_structure_required');
  END IF;
  IF jsonb_array_length(v_payouts) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'payout_structure_required');
  END IF;

  -- Payouts must sum to 100%. The engine normalises at start, but a structure
  -- that is wildly wrong here is a configuration mistake, not a rounding one.
  SELECT COALESCE(SUM((e->>'percentage')::numeric), 0) INTO v_pct_total
    FROM jsonb_array_elements(v_payouts) e;
  IF abs(v_pct_total - 100) > 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'payouts_must_total_100',
                              'detail', v_pct_total);
  END IF;

  -- More paid places than players can ever register would put more entrants in
  -- the money than entered, and the hand-for-hand bubble could never trigger.
  IF jsonb_array_length(v_payouts) >= v_max_players THEN
    RETURN jsonb_build_object('success', false, 'error', 'more_paid_places_than_players');
  END IF;

  v_start := COALESCE((p_config->>'startTime')::timestamptz, now() + interval '1 minute');

  v_is_bounty := v_type IN ('bounty', 'progressive_bounty', 'mystery_bounty');
  v_bounty := COALESCE((p_config->>'bountyAmount')::numeric, 0);
  IF v_is_bounty THEN
    IF v_bounty <= 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'bounty_amount_required');
    END IF;
    -- fn_tournament_entry_split takes the bounty out of the buy-in, not on top:
    -- prize = buy_in - rake - bounty. If that is negative every registration is
    -- refused with misconfigured_bounty, so reject it at creation instead.
    IF v_buy_in - v_fee - v_bounty < 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'bounty_exceeds_buy_in');
    END IF;
  END IF;

  SELECT u.id INTO v_union_id FROM unions u
   WHERE u.id = (SELECT COALESCE(c.union_id,
                        (SELECT uc.union_id FROM union_clubs uc WHERE uc.club_id = c.id LIMIT 1))
                   FROM clubs c WHERE c.id = p_club_id);

  INSERT INTO tournaments (
    club_id, name, game_type, variant, tournament_type,
    buy_in_amount, buy_in_fee, starting_chips,
    max_players, min_players, current_players, status,
    blind_structure, payout_structure, guaranteed_prize,
    late_reg_levels, late_reg_mins, rebuy_levels,
    start_time,
    is_rebuy, is_reentry, rebuy_cost, rebuy_chips,
    add_on_available, addon_cost, addon_chips, addon_levels,
    is_bounty, bounty_amount, is_pko, is_mystery_bounty,
    spin_type, satellite_target_id, is_xmtt, union_id
  ) VALUES (
    p_club_id,
    COALESCE(NULLIF(trim(p_config->>'name'), ''), 'Tournament'),
    COALESCE(p_config->>'gameVariant', 'NLH'),
    v_variant,
    CASE WHEN v_type = 'sng' THEN 'SNG' WHEN v_type = 'spin' THEN 'SPIN' ELSE 'MTT' END,
    v_buy_in, v_fee,
    COALESCE((p_config->>'startingStack')::int, 10000),
    v_max_players, v_min_players, 0, 'REGISTERING',
    v_blinds::text, v_payouts::text,
    COALESCE((p_config->>'guaranteedPrize')::numeric, 0),
    COALESCE((p_config->>'lateRegistrationLevels')::int, 0),
    COALESCE((p_config->>'lateRegistrationLevels')::int, 0),
    COALESCE((p_config->>'lateRegistrationLevels')::int, 0),
    v_start,
    COALESCE((p_config->>'isRebuy')::boolean, false),
    COALESCE((p_config->>'isReentry')::boolean, false),
    COALESCE((p_config->>'rebuyCost')::numeric, 0),
    COALESCE((p_config->>'rebuyChips')::int, 0),
    COALESCE((p_config->>'addOnAvailable')::boolean, false),
    COALESCE((p_config->>'addOnCost')::numeric, 0),
    COALESCE((p_config->>'addOnChips')::int, 0),
    COALESCE((p_config->>'addOnLevels')::int, 1),
    v_is_bounty, v_bounty,
    v_type = 'progressive_bounty',
    v_type = 'mystery_bounty',
    CASE WHEN v_type = 'spin' THEN COALESCE(p_config->>'spinType', 'standard') ELSE NULL END,
    NULLIF(p_config->>'satelliteTargetId', '')::uuid,
    COALESCE((p_config->>'isXmtt')::boolean, false),
    v_union_id
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('success', true, 'tournament_id', v_id,
                            'buy_in_fee', v_fee, 'status', 'REGISTERING');
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_create_tournament(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_create_tournament(uuid, jsonb) TO authenticated, service_role;
