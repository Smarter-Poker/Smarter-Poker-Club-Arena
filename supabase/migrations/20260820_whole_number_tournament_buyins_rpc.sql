-- ═══════════════════════════════════════════════════════════════════════════════
-- WHOLE-NUMBER TOURNAMENT / SNG BUY-INS — the creation RPC
-- Dan 2026-08-20 (binding): "Sit and Go and any tournament buy-ins must never
-- be decimal buy-ins, whole numbers only."
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- WHAT WAS WRONG
-- `20260820_whole_dollar_tournament_buyins.sql` added the constraint
--   buy_in_amount + buy_in_fee = round(buy_in_amount + buy_in_fee)
-- and fixed the two SERVER generators (server/src/config/buyIn.ts and
-- src/utils/buyIn.ts) to derive the split from a whole total. It did not touch
-- fn_create_tournament, which is the ONLY path a club owner's browser can
-- create a tournament through. That function still did:
--
--     v_buy_in := (p_config->>'buyIn')::numeric;   -- treated as the PRIZE half
--     v_fee    := round(v_buy_in * 0.1, 2);        -- fee ADDED ON TOP
--
-- so the player paid v_buy_in * 1.1. Two consequences, both live:
--
--   1. A 15 / 5 / 25 / 75 buy-in produced a 16.50 / 5.50 / 27.50 / 82.50 total,
--      which is NOT whole, so the CHECK constraint rejected the INSERT. Creating
--      a tournament at those prices failed outright with a constraint violation.
--   2. Where it did succeed (10 -> 11, 20 -> 22) the fee could still be a
--      decimal (15 -> 1.50), which the lobby card, the details page and the
--      register button all printed verbatim.
--
-- THE FIX
-- `buyIn` is now read as the whole-number TOTAL the player pays, exactly like
-- buyInFor() in both TypeScript mirrors. The 10% fee is a cut OUT of it and is
-- itself rounded to a whole number; the prize half is the remainder. All three
-- numbers are integers and prize + fee is exactly the advertised price.
--
--     total = 20  ->  fee 2,  buy_in_amount 18
--     total = 15  ->  fee 2,  buy_in_amount 13
--     total =  5  ->  fee 1,  buy_in_amount  4
--     total =  3  ->  fee 0,  buy_in_amount  3   (no fractional cut on a micro)
--
-- A non-integer buyIn is REFUSED with 'buy_in_must_be_whole' rather than
-- silently rounded, so an owner can never be given a price they did not ask
-- for. The same rule applies to the bounty, and rebuy / add-on / guarantee are
-- snapped to whole chips.
--
-- WHAT THIS DELIBERATELY DOES **NOT** DO
-- It does not rewrite historical rows. Those are the record of what real
-- players were charged; the earlier migration explains why that matters.
--
-- TIER 3 (replaces a SECURITY DEFINER function; signature unchanged).
-- ROLLBACK: re-apply the previous definition from
--   supabase/migrations/20260819_union_private_club_games.sql
-- which is the last migration that defined fn_create_tournament.

BEGIN;

-- ── Pre-flight: the function must exist with the signature we are replacing ──
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
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tournaments_whole_dollar_buyin'
       AND conrelid = 'public.tournaments'::regclass
  ) THEN
    RAISE EXCEPTION 'tournaments_whole_dollar_buyin constraint missing - apply 20260820_whole_dollar_tournament_buyins.sql first';
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

  -- ── THE BUY-IN (Dan 2026-08-20) ─────────────────────────────────────────
  -- `buyIn` is the TOTAL the player pays, and it must be a whole number.
  -- Rake is a cut OF that total, never a surcharge ON TOP of it.
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
    spin_type, satellite_target_id, is_xmtt, union_id, is_private
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
    NULLIF(p_config->>'satelliteTargetId', '')::uuid,
    COALESCE((p_config->>'isXmtt')::boolean, false),
    CASE WHEN v_is_private THEN NULL ELSE v_union_id END,
    v_is_private
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
  'server/src/config/buyIn.ts - change one, change all three.';

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
    RAISE EXCEPTION 'new fn_create_tournament body is missing the whole-number guard';
  END IF;
  IF position('round(v_buy_in * 0.1, 2)' in v_src) > 0 THEN
    RAISE EXCEPTION 'old fee-on-top formula is still present in fn_create_tournament';
  END IF;
END $$;

COMMIT;
