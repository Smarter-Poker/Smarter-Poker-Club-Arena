-- ===========================================================================
-- fn_create_tournament - FEATURE PARITY SUPERSET (2026-08-22)
--
-- Strict superset of the 2026-08-20 whole-number-buy-in definition
-- (20260820_whole_number_tournament_buyins_rpc.sql). Everything that function
-- did is preserved verbatim: same signature, same authorization (private-game
-- club-admin carve-out + fn_can_create_games), same whole-number buy-in /
-- bounty rules and error codes, same 10% fee-cut-out-of-total split, same
-- spin no-fee rule, same payout/blind validations. A buy-in of 0 remains
-- valid (freerolls): 0 = round(0).
--
-- ADDED: reads the PokerBros-parity p_config keys and writes the columns from
-- 20260822100000_tournament_feature_parity_columns.sql:
--   shortDescription, isVipOnly, banChat, allInOrFold, labelAsNew,
--   hideClubName, actionTimeSeconds (clamp 5-60), tableSize (clamp 2-10),
--   acceleratedMtt, addonBreakMinutes (clamp 1-10), bigBlindAnte,
--   authorizedToRegister, earlyBirdEnabled, earlyBirdChips (>=0),
--   bubbleProtection, finalTableDealEnabled, restartEveryMinutes (null or
--   5-1440), synchronizedBreaks (default true), maxRebuys, maxReentries,
--   isMultiDay -> is_multi_day, totalDays -> total_days (2-7 when multi-day),
--   mysteryBountyMin/Max -> mystery_bounty_min/max, isFeatured -> is_pinned,
--   satelliteSeats -> satellite_seats (>=1, only with satelliteTargetId).
--
-- MYSTERY BOUNTY RANGE ENCODING: mysteryBountyMin/Max in p_config are
-- MULTIPLIERS of the bounty head (e.g. 0.5 and 13). The columns store MONEY
-- (round(bounty * multiplier, 2)) because that is how the 2026-08-21
-- advertised-range migration wrote existing rows and how the lobby renders
-- them. The draw in fn_register_for_tournament divides back by the head to
-- recover the multipliers, so old and new rows share one code path.
--
-- TIER 3 (replaces a SECURITY DEFINER function; signature unchanged).
-- ROLLBACK: re-apply supabase/migrations/20260820_whole_number_tournament_buyins_rpc.sql
-- ===========================================================================

BEGIN;

-- Pre-flight: signature we are replacing + the parity columns must exist.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'fn_create_tournament'
       AND pg_get_function_identity_arguments(p.oid) = 'p_club_id uuid, p_config jsonb'
  ) THEN
    RAISE EXCEPTION 'fn_create_tournament(uuid, jsonb) not found - schema drift, aborting';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'tournaments'
       AND column_name = 'final_table_deal_enabled'
  ) THEN
    RAISE EXCEPTION 'parity columns missing - apply 20260822100000_tournament_feature_parity_columns.sql first';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fn_create_tournament(p_club_id uuid, p_config jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid          uuid := auth.uid();
  v_id           uuid;
  v_total        numeric;
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
  v_is_private   boolean;
  -- Parity additions (2026-08-22)
  v_action_time    int;
  v_table_size     int;
  v_addon_break    int;
  v_early_chips    int;
  v_restart_every  int;
  v_sync_breaks    boolean;
  v_max_rebuys     int;
  v_max_reentries  int;
  v_is_multi_day   boolean;
  v_total_days     int;
  v_mb_min_mult    numeric;
  v_mb_max_mult    numeric;
  v_mb_min_money   numeric := 0;
  v_mb_max_money   numeric := 0;
  v_sat_target     uuid;
  v_sat_seats      int;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  -- UNION GOVERNANCE (2026-08-19): private club games are creatable by the
  -- club's own owner/admin even when the club is in a union; union-visible
  -- games keep the fn_can_create_games ruling (union people only for union
  -- member clubs).
  v_is_private := COALESCE((p_config->>'isPrivate')::boolean, false);
  IF v_is_private THEN
    IF NOT (is_club_admin(p_club_id, v_uid) OR public.fn_can_create_games(p_club_id, v_uid)) THEN
      RETURN jsonb_build_object('success', false, 'error', 'not_authorised');
    END IF;
  ELSIF NOT public.fn_can_create_games(p_club_id, v_uid) THEN
    -- Deliberately one message for every refusal: a caller must not be able to
    -- probe which clubs exist or who administers them.
    RETURN jsonb_build_object('success', false, 'error', 'not_authorised');
  END IF;

  -- THE BUY-IN (Dan 2026-08-20): `buyIn` is the TOTAL the player pays, and it
  -- must be a whole number. Rake is a cut OF that total, never a surcharge ON
  -- TOP of it. Zero stays valid: freerolls.
  v_total := COALESCE((p_config->>'buyIn')::numeric, 0);
  IF v_total < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'buy_in_must_not_be_negative');
  END IF;
  IF v_total <> round(v_total) THEN
    -- Refuse, do not round: an owner must never be handed a price they did not
    -- type. The creation forms block decimal entry; this is the backstop.
    RETURN jsonb_build_object('success', false, 'error', 'buy_in_must_be_whole');
  END IF;

  -- HOUSE RULE: the fee is 10% of the buy-in on any and all tournaments,
  -- rounded to a WHOLE number of chips. The prize half is the remainder, so
  -- prize + fee is exactly the advertised total and neither column can hold a
  -- decimal. Identical to splitBuyIn() in src/utils/buyIn.ts and
  -- server/src/config/buyIn.ts.
  v_fee    := LEAST(v_total, GREATEST(0, round(v_total * 0.1)));
  v_buy_in := v_total - v_fee;

  v_max_players := COALESCE((p_config->>'maxPlayers')::int, 0);
  IF v_max_players <= 0 THEN
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

  -- A SPIN CARRIES NO FEE. Dan 2026-08-20: "THEY ARE STRAIGHT JUST 10 BUY IN
  -- ... NO ADDITIONAL RAKE IS ADDED" - the edge is engineered into the
  -- multiplier distribution instead (see src/config/spinSpec.ts), so charging a
  -- fee here as well would roughly double the true house edge. The whole total
  -- goes to buy_in_amount, which is also what TournamentRecurringService writes.
  IF v_type = 'spin' THEN
    v_fee    := 0;
    v_buy_in := v_total;
  END IF;

  v_blinds  := COALESCE(p_config->'blindStructure', '[]'::jsonb);
  v_payouts := COALESCE(p_config->'payoutStructure', '[]'::jsonb);

  IF jsonb_array_length(v_blinds) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'blind_structure_required');
  END IF;
  IF jsonb_array_length(v_payouts) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'payout_structure_required');
  END IF;

  SELECT COALESCE(SUM((e->>'percentage')::numeric), 0) INTO v_pct_total
    FROM jsonb_array_elements(v_payouts) e;
  IF abs(v_pct_total - 100) > 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'payouts_must_total_100',
                              'detail', v_pct_total);
  END IF;

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
    IF v_bounty <> round(v_bounty) THEN
      RETURN jsonb_build_object('success', false, 'error', 'bounty_must_be_whole');
    END IF;
    -- The bounty is FUNDED out of the buy-in, so it cannot exceed the prize
    -- half of the split or the prize pool would go negative and registration
    -- would refuse every entrant with 'misconfigured_bounty'.
    IF v_buy_in - v_bounty < 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'bounty_exceeds_buy_in');
    END IF;
  END IF;

  -- ── PARITY KEYS (2026-08-22) ────────────────────────────────────────────
  -- Clamped keys clamp silently (they are UI sliders); range keys that carry
  -- money or structure REFUSE out-of-range values, matching the house
  -- refuse-do-not-round rule.
  v_action_time := LEAST(60, GREATEST(5,  COALESCE((p_config->>'actionTimeSeconds')::int, 15)));
  v_table_size  := LEAST(10, GREATEST(2,  COALESCE((p_config->>'tableSize')::int, 9)));
  v_addon_break := LEAST(10, GREATEST(1,  COALESCE((p_config->>'addonBreakMinutes')::int, 1)));
  v_sync_breaks := COALESCE((p_config->>'synchronizedBreaks')::boolean, true);

  v_early_chips := COALESCE((p_config->>'earlyBirdChips')::int, 0);
  IF v_early_chips < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'early_bird_chips_must_not_be_negative');
  END IF;

  v_restart_every := NULLIF(p_config->>'restartEveryMinutes', '')::int;
  IF v_restart_every IS NOT NULL AND (v_restart_every < 5 OR v_restart_every > 1440) THEN
    RETURN jsonb_build_object('success', false, 'error', 'restart_every_minutes_out_of_range');
  END IF;

  v_max_rebuys    := NULLIF(p_config->>'maxRebuys', '')::int;
  v_max_reentries := NULLIF(p_config->>'maxReentries', '')::int;

  v_is_multi_day := COALESCE((p_config->>'isMultiDay')::boolean, false);
  v_total_days   := NULLIF(p_config->>'totalDays', '')::int;
  IF v_is_multi_day THEN
    IF v_total_days IS NULL OR v_total_days < 2 OR v_total_days > 7 THEN
      RETURN jsonb_build_object('success', false, 'error', 'total_days_out_of_range');
    END IF;
  ELSE
    v_total_days := 1;
  END IF;

  -- Mystery bounty advertised range. Config carries MULTIPLIERS; the columns
  -- store MONEY (multiplier * bounty head), matching the 2026-08-21
  -- advertised-range convention the lobby renders.
  v_mb_min_mult := NULLIF(p_config->>'mysteryBountyMin', '')::numeric;
  v_mb_max_mult := NULLIF(p_config->>'mysteryBountyMax', '')::numeric;
  IF (v_mb_min_mult IS NOT NULL OR v_mb_max_mult IS NOT NULL)
     AND v_type <> 'mystery_bounty' THEN
    RETURN jsonb_build_object('success', false, 'error', 'mystery_range_requires_mystery_bounty');
  END IF;
  IF v_type = 'mystery_bounty' THEN
    v_mb_min_mult := COALESCE(v_mb_min_mult, 0.5);
    v_mb_max_mult := COALESCE(v_mb_max_mult, 13);
    IF v_mb_min_mult <= 0 OR v_mb_max_mult < v_mb_min_mult THEN
      RETURN jsonb_build_object('success', false, 'error', 'mystery_bounty_range_invalid');
    END IF;
    v_mb_min_money := round(v_bounty * v_mb_min_mult, 2);
    v_mb_max_money := round(v_bounty * v_mb_max_mult, 2);
  END IF;

  v_sat_target := NULLIF(p_config->>'satelliteTargetId', '')::uuid;
  v_sat_seats  := NULLIF(p_config->>'satelliteSeats', '')::int;
  IF v_sat_seats IS NOT NULL THEN
    IF v_sat_seats < 1 THEN
      RETURN jsonb_build_object('success', false, 'error', 'satellite_seats_invalid');
    END IF;
    IF v_sat_target IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'satellite_seats_requires_target');
    END IF;
  END IF;

  SELECT u.id INTO v_union_id FROM unions u
   WHERE u.id = (
     SELECT CASE 
              WHEN c.is_union THEN c.id
              ELSE COALESCE(c.union_id, (SELECT uc.union_id FROM union_clubs uc WHERE uc.club_id = c.id LIMIT 1))
            END
     FROM clubs c WHERE c.id = p_club_id
   );

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
    spin_type, satellite_target_id, is_xmtt, union_id, is_private,
    -- Parity columns (2026-08-22)
    short_description, is_vip_only, ban_chat, all_in_or_fold, label_as_new,
    hide_club_name, action_time_seconds, table_size, accelerated_mtt,
    addon_break_minutes, big_blind_ante, authorized_to_register,
    early_bird_enabled, early_bird_chips, bubble_protection,
    final_table_deal_enabled, restart_every_minutes, synchronized_breaks,
    max_rebuys, max_reentries, is_multi_day, total_days,
    mystery_bounty_min, mystery_bounty_max, is_pinned, satellite_seats
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
    -- Whole chips on every money column, not just the buy-in.
    GREATEST(0, round(COALESCE((p_config->>'guaranteedPrize')::numeric, 0))),
    COALESCE((p_config->>'lateRegistrationLevels')::int, 0),
    COALESCE((p_config->>'lateRegistrationLevels')::int, 0),
    COALESCE((p_config->>'lateRegistrationLevels')::int, 0),
    v_start,
    COALESCE((p_config->>'isRebuy')::boolean, false),
    COALESCE((p_config->>'isReentry')::boolean, false),
    GREATEST(0, round(COALESCE((p_config->>'rebuyCost')::numeric, 0))),
    COALESCE((p_config->>'rebuyChips')::int, 0),
    COALESCE((p_config->>'addOnAvailable')::boolean, false),
    GREATEST(0, round(COALESCE((p_config->>'addOnCost')::numeric, 0))),
    COALESCE((p_config->>'addOnChips')::int, 0),
    COALESCE((p_config->>'addOnLevels')::int, 1),
    v_is_bounty, v_bounty,
    v_type = 'progressive_bounty',
    v_type = 'mystery_bounty',
    CASE WHEN v_type = 'spin' THEN COALESCE(p_config->>'spinType', 'standard') ELSE NULL END,
    v_sat_target,
    COALESCE((p_config->>'isXmtt')::boolean, false),
    CASE WHEN v_is_private THEN NULL ELSE v_union_id END,
    v_is_private,
    -- Parity columns (2026-08-22)
    NULLIF(trim(COALESCE(p_config->>'shortDescription', '')), ''),
    COALESCE((p_config->>'isVipOnly')::boolean, false),
    COALESCE((p_config->>'banChat')::boolean, false),
    COALESCE((p_config->>'allInOrFold')::boolean, false),
    COALESCE((p_config->>'labelAsNew')::boolean, false),
    COALESCE((p_config->>'hideClubName')::boolean, false),
    v_action_time, v_table_size,
    COALESCE((p_config->>'acceleratedMtt')::boolean, false),
    v_addon_break,
    COALESCE((p_config->>'bigBlindAnte')::boolean, false),
    COALESCE((p_config->>'authorizedToRegister')::boolean, false),
    COALESCE((p_config->>'earlyBirdEnabled')::boolean, false),
    v_early_chips,
    COALESCE((p_config->>'bubbleProtection')::boolean, false),
    COALESCE((p_config->>'finalTableDealEnabled')::boolean, false),
    v_restart_every, v_sync_breaks,
    v_max_rebuys, v_max_reentries,
    v_is_multi_day, v_total_days,
    v_mb_min_money, v_mb_max_money,
    COALESCE((p_config->>'isFeatured')::boolean, false),
    v_sat_seats
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('success', true, 'tournament_id', v_id,
                            'buy_in', v_total, 'buy_in_fee', v_fee,
                            'status', 'REGISTERING');
END;
$function$;

COMMENT ON FUNCTION public.fn_create_tournament(uuid, jsonb) IS
  'Dan 2026-08-20: p_config->>''buyIn'' is the whole-number TOTAL the player '
  'pays. The 10% fee is rounded whole and cut OUT of it; buy_in_amount is the '
  'remainder. A non-integer buyIn is refused with buy_in_must_be_whole rather '
  'than rounded. Mirrors splitBuyIn() in src/utils/buyIn.ts and '
  'server/src/config/buyIn.ts - change one, change all three. '
  '2026-08-22: PokerBros parity keys added (shortDescription, isVipOnly, '
  'banChat, allInOrFold, labelAsNew, hideClubName, actionTimeSeconds, '
  'tableSize, acceleratedMtt, addonBreakMinutes, bigBlindAnte, '
  'authorizedToRegister, earlyBirdEnabled, earlyBirdChips, bubbleProtection, '
  'finalTableDealEnabled, restartEveryMinutes, synchronizedBreaks, maxRebuys, '
  'maxReentries, isMultiDay, totalDays, mysteryBountyMin/Max (multipliers, '
  'stored as money), isFeatured, satelliteSeats).';

-- ── Post-apply assertions ──────────────────────────────────────────────────
DO $$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_create_tournament';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_create_tournament disappeared after replace';
  END IF;
  IF position('buy_in_must_be_whole' in v_src) = 0 THEN
    RAISE EXCEPTION 'new fn_create_tournament body lost the whole-number guard';
  END IF;
  IF position('actionTimeSeconds' in v_src) = 0 THEN
    RAISE EXCEPTION 'new fn_create_tournament body is missing the parity keys';
  END IF;
  IF position('round(v_buy_in * 0.1, 2)' in v_src) > 0 THEN
    RAISE EXCEPTION 'old fee-on-top formula reappeared in fn_create_tournament';
  END IF;
END $$;

COMMIT;
