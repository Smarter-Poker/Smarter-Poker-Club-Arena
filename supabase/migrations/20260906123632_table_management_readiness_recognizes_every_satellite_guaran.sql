-- 20260906123632_table_management_readiness_recognizes_every_satellite_guaran.sql
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

-- Phase 2's final readiness rewrite recognized a satellite only when its
-- variant literally read "satellite". The overlay writer already recognizes
-- the platform's three canonical forms: variant, tournament_type, or a target
-- id. Heads-up satellite SNGs use variant=sng, so readiness understated 1,121
-- production contracts by 127,030 chips. Keep readiness byte-for-byte aligned
-- with the writer's semantic predicate and make every field that can change
-- that promise re-run the publication guard.
CREATE OR REPLACE FUNCTION public.fn_tournament_management_readiness_for_row(
  p_row jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
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
  v_short := greatest(
    COALESCE(v_floor, 0) + COALESCE(v_exposure, 0) + v_required - v_bank,
    0
  );
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
    AND COALESCE(NULLIF(p_row ->> 'max_players', '')::integer, 0) >= 2
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
    'short_by', v_short
  );
END;
$function$;

-- The 2026-09-05 cluster migration replaced this function after the original
-- Phase 2 migration and added ON CONFLICT ON CONSTRAINT for the repeated-hash
-- unique key. Phase 2 recertification later dropped that key but did not
-- replace this final function body, leaving every changed contract pointed at
-- a constraint that no longer exists. Serialize version allocation per game
-- and record every non-consecutive publication, including A -> B -> A.
CREATE OR REPLACE FUNCTION public.fn_capture_managed_game_contract()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_kind text := CASE TG_TABLE_NAME WHEN 'tables' THEN 'table' ELSE 'tournament' END;
  v_contract jsonb;
  v_hash text;
  v_last_hash text;
  v_version integer;
BEGIN
  IF v_kind = 'table' AND to_jsonb(NEW) -> 'tournament_id' <> 'null'::jsonb THEN
    RETURN NEW;
  END IF;

  v_contract := public.fn_managed_game_contract_document(v_kind, to_jsonb(NEW));
  v_hash := public.fn_managed_game_contract_hash(v_contract);

  -- Updates of one physical row normally serialize already. This lock also
  -- protects repair/import paths that can publish the same logical game from
  -- separate statements before either has allocated its next version.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_kind || ':' || NEW.id::text, 0));

  SELECT contract_hash, version
    INTO v_last_hash, v_version
    FROM public.managed_game_contract_versions
   WHERE game_kind = v_kind AND game_id = NEW.id
   ORDER BY version DESC
   LIMIT 1;

  IF v_last_hash IS NOT DISTINCT FROM v_hash THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.managed_game_contract_versions (
    game_kind, game_id, club_id, union_id, version, contract,
    contract_hash, published_by, change_reason
  ) VALUES (
    v_kind, NEW.id, NEW.club_id, NEW.union_id, COALESCE(v_version, 0) + 1,
    v_contract, v_hash, auth.uid(),
    CASE
      WHEN TG_OP = 'INSERT' THEN 'created'
      WHEN auth.uid() IS NULL THEN 'system_revision'
      ELSE 'operator_revision'
    END
  );

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_tournaments_publish_readiness ON public.tournaments;
CREATE TRIGGER trg_tournaments_publish_readiness
AFTER INSERT OR UPDATE OF
  guaranteed_prize,
  club_id,
  union_id,
  is_private,
  variant,
  tournament_type,
  satellite_target_id,
  satellite_target,
  satellite_seats
ON public.tournaments
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_tournament_publish_readiness();

REVOKE ALL ON FUNCTION public.fn_tournament_management_readiness_for_row(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_management_readiness_for_row(jsonb)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_capture_managed_game_contract()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_capture_managed_game_contract()
  TO service_role;

DO $assert_all_satellite_forms$
DECLARE
  v_source text;
  v_capture_source text;
  v_trigger text;
BEGIN
  SELECT p.prosrc
    INTO v_source
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'fn_tournament_management_readiness_for_row';
  SELECT pg_get_triggerdef(t.oid)
    INTO v_trigger
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.tournaments'::regclass
     AND t.tgname = 'trg_tournaments_publish_readiness'
     AND NOT t.tgisinternal;
  SELECT p.prosrc
    INTO v_capture_source
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'fn_capture_managed_game_contract';

  IF position('v_tournament_type = ''SATELLITE''' in v_source) = 0
     OR position('v_target IS NOT NULL' in v_source) = 0
     OR position('COALESCE(t.satellite_target_id, t.satellite_target) IS NOT NULL' in v_source) = 0 THEN
    RAISE EXCEPTION 'readiness does not recognize every satellite form';
  END IF;
  IF position('satellite_seats' in v_trigger) = 0
     OR position('satellite_target_id' in v_trigger) = 0
     OR position('tournament_type' in v_trigger) = 0
     OR position('is_private' in v_trigger) = 0 THEN
    RAISE EXCEPTION 'the publication guard does not cover every guarantee or funding field';
  END IF;
  IF position('pg_advisory_xact_lock' in v_capture_source) = 0
     OR position('ON CONFLICT ON CONSTRAINT' in v_capture_source) > 0 THEN
    RAISE EXCEPTION 'contract capture still names the dropped hash constraint or lacks serialization';
  END IF;
END;
$assert_all_satellite_forms$;

COMMIT;
