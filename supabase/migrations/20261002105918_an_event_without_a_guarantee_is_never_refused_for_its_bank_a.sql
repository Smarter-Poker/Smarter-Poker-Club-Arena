-- 20261002105918_an_event_without_a_guarantee_is_never_refused_for_its_bank_a.sql
-- ===========================================================================
--  AN EVENT WITHOUT A GUARANTEE IS NEVER REFUSED FOR ITS BANK, AND A
--  GUARANTEE IS CHECKED FOR ITS OWN OVERLAY
-- ===========================================================================
--
-- Incident 2026-10-02 from ~09:40 UTC (engine 0815118d). Engine log, 15 min:
-- 11,073 Tournament.launch_completion_unproven "Tournament cannot start
-- because its guarantee is short by 32725.00 chips" (also 32475.00, 32825.00),
-- 222 seat_first_fully_paid_never_started, 150 spin_atomic_creation_failed
-- "cannot be published because its guarantee is short by ...", and
-- createSatelliteHeadsUp_error. Fully paid Spins and heads-up Sit & Gos of
-- Deep Stack Society (2a1132b9, standalone, treasury 8,200.00 after the week
-- of 2026-09-14 rakeback was paid from it at 09:4x) could not start or be
-- published.
--
-- Cause: fn_tournament_management_readiness_for_row computed
--   short_by = floor + (every OTHER live event's uncovered guarantee)
--              + this event's overlay - bank
-- and both trg_tournaments_start_readiness and trg_tournaments_publish_
-- readiness refuse on short_by > 0. A Spin needs no overlay (v_required = 0),
-- yet was refused for 38,768.50 of other events' promised guarantees.
--
-- Now short_by is this event's own uncovered overlay: 0 when the event needs
-- none, otherwise floor + its overlay - bank. fn_ca_fund_overlay_on_lock
-- debits only that overlay at start, so this is exactly what a start must
-- prove. The bank-wide figure is still returned as portfolio_short_by (and
-- other_live_exposure) for owners' warnings; it refuses nothing. The rest of
-- the body is byte-identical to the live one read at 10:59 UTC.
--
-- One transaction; pre-image guard on md5(prosrc), owner, ACL, proconfig,
-- prosecdef and provolatile of the live body; post-image asserts the new body
-- and the unchanged owner, grants and settings.
-- ===========================================================================
-- @live-proof: md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_tournament_management_readiness_for_row(jsonb)'::regprocedure)) = '73717dc98451e17a28037b740f787ccd'

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_tournament_management_readiness_for_row(jsonb)'::regprocedure
       AND md5(p.prosrc) = 'ab3e5f80468318f9e7933790fc8dc353'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{"search_path=public, pg_temp"}'
       AND p.prosecdef
       AND p.provolatile = 's')
  THEN
    RAISE EXCEPTION 'preimage: fn_tournament_management_readiness_for_row(jsonb) is not the live body read at 10:59 UTC on 2026-10-02 (expected md5 ab3e5f80468318f9e7933790fc8dc353); re-read it';
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.fn_tournament_management_readiness_for_row(p_row jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid := NULLIF(p_row ->> 'id', '')::uuid;
  v_club uuid := NULLIF(p_row ->> 'club_id', '')::uuid;
  v_row_union uuid := NULLIF(p_row ->> 'union_id', '')::uuid;
  v_union uuid;
  v_private boolean := COALESCE((p_row ->> 'is_private')::boolean, false);
  v_enforce boolean;
  v_floor numeric;
  v_bank numeric;
  v_bank_type text;
  v_exposure numeric;
  v_guaranteed numeric := COALESCE(NULLIF(p_row ->> 'guaranteed_prize', '')::numeric, 0);
  v_pool numeric := COALESCE(NULLIF(p_row ->> 'prize_pool', '')::numeric, 0);
  v_effective_guarantee numeric;
  v_seat_guarantee numeric := 0;
  v_required numeric;
  v_short numeric;
  v_portfolio_short numeric;
  v_locked boolean;
  v_complete boolean;
  v_status text := upper(COALESCE(p_row ->> 'status', ''));
  v_variant text := lower(COALESCE(p_row ->> 'variant', ''));
  v_tournament_type text := upper(COALESCE(p_row ->> 'tournament_type', ''));
  v_target uuid := COALESCE(
    NULLIF(p_row ->> 'satellite_target_id', ''),
    NULLIF(p_row ->> 'satellite_target', '')
  )::uuid;
  v_satellite_seats integer := COALESCE(
    NULLIF(p_row ->> 'satellite_seats', '')::integer,
    0
  );
  v_is_satellite boolean := v_variant = 'satellite'
    OR v_tournament_type = 'SATELLITE'
    OR v_target IS NOT NULL;
  v_target_found boolean := false;
  v_blinds jsonb;
  v_payouts jsonb;
BEGIN
  IF v_id IS NULL OR v_club IS NULL THEN
    RETURN jsonb_build_object('state', 'missing', 'can_start', false);
  END IF;

  SELECT COALESCE(c.guarantee_enforcement_enabled, true),
         COALESCE(c.guarantee_treasury_floor, 0)
    INTO v_enforce, v_floor
    FROM public.clubs c
   WHERE c.id = v_club;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'missing', 'can_start', false);
  END IF;

  v_union := CASE WHEN v_private THEN NULL ELSE v_row_union END;

  IF v_is_satellite AND v_satellite_seats > 0 AND v_target IS NOT NULL THEN
    SELECT round(
             (COALESCE(t.buy_in_amount, 0) + COALESCE(t.buy_in_fee, 0))
             * v_satellite_seats,
             2
           )
      INTO v_seat_guarantee
      FROM public.tournaments t
     WHERE t.id = v_target;
    v_target_found := FOUND;
    v_seat_guarantee := COALESCE(v_seat_guarantee, 0);
  END IF;

  v_effective_guarantee := greatest(v_guaranteed, v_seat_guarantee);

  IF v_union IS NOT NULL THEN
    v_bank_type := 'union';
    v_floor := 0;
    SELECT COALESCE(uw.chip_balance, 0)
      INTO v_bank
      FROM public.union_wallets uw
     WHERE uw.union_id = v_union;
    v_bank := COALESCE(v_bank, 0);

    SELECT COALESCE(sum(greatest(
             greatest(
               COALESCE(t.guaranteed_prize, 0),
               CASE
                 WHEN COALESCE(t.satellite_seats, 0) > 0
                      AND (
                        lower(COALESCE(t.variant, '')) = 'satellite'
                        OR upper(COALESCE(t.tournament_type, '')) = 'SATELLITE'
                        OR COALESCE(t.satellite_target_id, t.satellite_target) IS NOT NULL
                      )
                 THEN COALESCE(
                   (COALESCE(target.buy_in_amount, 0) + COALESCE(target.buy_in_fee, 0))
                   * t.satellite_seats,
                   0
                 )
                 ELSE 0
               END
             ) - COALESCE(t.prize_pool, 0),
             0
           )), 0)
      INTO v_exposure
      FROM public.tournaments t
      LEFT JOIN public.tournaments target
        ON target.id = COALESCE(t.satellite_target_id, t.satellite_target)
     WHERE t.union_id = v_union
       AND NOT COALESCE(t.is_private, false)
       AND t.id <> v_id
       AND NOT COALESCE(t.prize_pool_finalized, false)
       AND upper(t.status::text) IN ('ANNOUNCED', 'REGISTERING', 'RUNNING');
  ELSE
    v_bank_type := 'club';
    SELECT COALESCE(c.chip_treasury, 0)
      INTO v_bank
      FROM public.clubs c
     WHERE c.id = v_club;
    v_bank := COALESCE(v_bank, 0);

    SELECT COALESCE(sum(greatest(
             greatest(
               COALESCE(t.guaranteed_prize, 0),
               CASE
                 WHEN COALESCE(t.satellite_seats, 0) > 0
                      AND (
                        lower(COALESCE(t.variant, '')) = 'satellite'
                        OR upper(COALESCE(t.tournament_type, '')) = 'SATELLITE'
                        OR COALESCE(t.satellite_target_id, t.satellite_target) IS NOT NULL
                      )
                 THEN COALESCE(
                   (COALESCE(target.buy_in_amount, 0) + COALESCE(target.buy_in_fee, 0))
                   * t.satellite_seats,
                   0
                 )
                 ELSE 0
               END
             ) - COALESCE(t.prize_pool, 0),
             0
           )), 0)
      INTO v_exposure
      FROM public.tournaments t
      LEFT JOIN public.tournaments target
        ON target.id = COALESCE(t.satellite_target_id, t.satellite_target)
     WHERE t.club_id = v_club
       AND (COALESCE(t.is_private, false) OR t.union_id IS NULL)
       AND t.id <> v_id
       AND NOT COALESCE(t.prize_pool_finalized, false)
       AND upper(t.status::text) IN ('ANNOUNCED', 'REGISTERING', 'RUNNING');
  END IF;

  v_required := greatest(v_effective_guarantee - v_pool, 0);
  -- AN EVENT IS REFUSED ONLY FOR ITS OWN UNCOVERED OVERLAY (2026-10-02).
  -- The bank's coverage of OTHER events' guarantees is not this event's
  -- promise: a Spin, a Sit & Go, a heads-up satellite or a freezeout with no
  -- guarantee needs no overlay and is never refused for the bank, and an
  -- event with a guarantee is refused only when the bank (above the club's
  -- floor) cannot pay its own overlay. The bank-wide position is still
  -- reported, as portfolio_short_by, for the owners' bank warnings.
  v_portfolio_short := greatest(
    COALESCE(v_floor, 0) + COALESCE(v_exposure, 0) + v_required - v_bank,
    0
  );
  v_short := CASE
    WHEN v_required > 0 THEN greatest(COALESCE(v_floor, 0) + v_required - v_bank, 0)
    ELSE 0
  END;
  v_locked := EXISTS (
    SELECT 1
      FROM public.tournament_players tp
     WHERE tp.tournament_id = v_id
  );

  v_blinds := CASE
    WHEN jsonb_typeof(p_row -> 'blind_structure') = 'array'
      THEN p_row -> 'blind_structure'
    ELSE public.fn_safe_jsonb_array(p_row ->> 'blind_structure')
  END;
  v_payouts := CASE
    WHEN jsonb_typeof(p_row -> 'payout_structure') = 'array'
      THEN p_row -> 'payout_structure'
    ELSE public.fn_safe_jsonb_array(p_row ->> 'payout_structure')
  END;

  v_complete := NULLIF(trim(COALESCE(p_row ->> 'name', '')), '') IS NOT NULL
    AND (
      NULLIF(p_row ->> 'start_time', '') IS NOT NULL
      OR v_tournament_type IN ('SNG', 'SPIN')
      OR v_variant IN ('sng', 'spin')
    )
    AND COALESCE(NULLIF(p_row ->> 'starting_chips', '')::numeric, 0) > 0
    AND ((p_row->>'format_contract' IS NOT DISTINCT FROM 'mtt-v2' AND p_row->>'max_players' IS NULL
          AND COALESCE(NULLIF(p_row->>'min_players','')::integer,0)>=3)
      OR COALESCE(NULLIF(p_row ->> 'max_players', '')::integer, 0) >= 2)
    AND COALESCE(NULLIF(p_row ->> 'buy_in_amount', '')::numeric, 0) >= 0
    AND jsonb_array_length(v_blinds) > 0
    AND (
      jsonb_array_length(v_payouts) > 0
      OR v_tournament_type = 'SPIN'
      OR v_variant = 'spin'
    )
    AND (
      NOT v_is_satellite
      OR (v_satellite_seats > 0 AND v_target IS NOT NULL AND v_target_found)
      -- DIAMOND PHASE 9: a Diamond satellite promises no seat. A seat count
      -- promised in advance is a guarantee; a Diamond guarantee is funded only
      -- from an authorised Diamond house budget, which is not built and whose
      -- size is the owner's, and the creation door refuses one by name. The
      -- satellite's own prize bank buys whole seats in its Diamond target at
      -- settlement, so its contract is complete with none promised. The test
      -- is fn_poker_diamond_tournament's, read from the row.
      OR (v_satellite_seats = 0 AND v_target IS NOT NULL AND v_row_union IS NULL
          AND EXISTS (SELECT 1 FROM public.clubs c
                       WHERE c.id = v_club AND c.asset = 'diamonds'
                         AND c.is_platform IS TRUE AND c.union_id IS NULL)
          AND public.fn_poker_diamond_tournament(v_target))
    );

  RETURN jsonb_build_object(
    'state', CASE
      WHEN v_status IN ('COMPLETED', 'CANCELLED', 'CANCELED') THEN 'closed'
      WHEN NOT v_complete THEN 'incomplete'
      WHEN v_enforce AND v_short > 0 THEN 'funding_blocked'
      ELSE 'ready'
    END,
    'can_start', v_status NOT IN ('COMPLETED', 'CANCELLED', 'CANCELED')
      AND v_complete
      AND (NOT v_enforce OR v_short = 0),
    'contract_locked', v_locked,
    'guarantee_enforced', v_enforce,
    'guaranteed_prize', v_guaranteed,
    'satellite_seat_guarantee', v_seat_guarantee,
    'effective_guarantee', v_effective_guarantee,
    'current_prize_pool', v_pool,
    'overlay_required', v_required,
    'bank_type', v_bank_type,
    'bank_balance', v_bank,
    'bank_floor', COALESCE(v_floor, 0),
    'other_live_exposure', COALESCE(v_exposure, 0),
    'short_by', v_short,
    'portfolio_short_by', v_portfolio_short
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_tournament_management_readiness_for_row(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_management_readiness_for_row(jsonb) TO service_role;

DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_tournament_management_readiness_for_row(jsonb)'::regprocedure
       AND md5(p.prosrc) = '73717dc98451e17a28037b740f787ccd'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{"search_path=public, pg_temp"}'
       AND p.prosecdef
       AND p.provolatile = 's')
  THEN
    RAISE EXCEPTION 'postimage: fn_tournament_management_readiness_for_row(jsonb) is not the intended body or lost its owner, ACL or settings';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_tournaments_start_readiness'
                   AND tgrelid = 'public.tournaments'::regclass AND tgenabled = 'O')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_tournaments_publish_readiness'
                   AND tgrelid = 'public.tournaments'::regclass AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'postimage: the start and publish readiness triggers are not bound and enabled';
  END IF;
END $post$;

COMMIT;
