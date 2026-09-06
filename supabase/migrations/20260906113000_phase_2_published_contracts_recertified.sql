-- Table Management Phase 2: Published Contracts Re-certified
--
-- A published contract is an append-only promise, not a set of distinct JSON
-- documents. A -> B -> A is three publications and must produce version 3.
-- Tournament readiness must evaluate the exact row entering play, parse the
-- estate's text-backed JSON safely, use the bank the funding trigger uses,
-- include satellite seat value, and serialize starts against that bank.

BEGIN;

SET LOCAL lock_timeout = '30s';

-- The original uniqueness rule made a legitimate revert fail with 23505.
-- Keep hashes indexable, but make version the identity of a publication.
DO $drop_repeated_hash_constraint$
DECLARE
  v_constraint name;
BEGIN
  SELECT c.conname
    INTO v_constraint
    FROM pg_constraint c
   WHERE c.conrelid = 'public.managed_game_contract_versions'::regclass
     AND c.contype = 'u'
     AND (
       SELECT array_agg(a.attname::text ORDER BY k.ordinality)
         FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ordinality)
         JOIN pg_attribute a
           ON a.attrelid = c.conrelid
          AND a.attnum = k.attnum
     ) = ARRAY['game_kind', 'game_id', 'contract_hash']::text[]
   LIMIT 1;

  IF v_constraint IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE public.managed_game_contract_versions DROP CONSTRAINT %I',
      v_constraint
    );
  END IF;
END;
$drop_repeated_hash_constraint$;

CREATE INDEX IF NOT EXISTS idx_managed_game_contract_versions_hash
  ON public.managed_game_contract_versions (game_kind, game_id, contract_hash);

CREATE OR REPLACE FUNCTION public.fn_guard_managed_game_contract_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Published game contract versions cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  RAISE EXCEPTION 'Published game contract versions are immutable'
    USING ERRCODE = '55000';
END;
$function$;

DROP TRIGGER IF EXISTS trg_managed_game_contract_version_immutable
  ON public.managed_game_contract_versions;
CREATE TRIGGER trg_managed_game_contract_version_immutable
BEFORE UPDATE OR DELETE ON public.managed_game_contract_versions
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_managed_game_contract_version();

-- This private helper accepts a row snapshot so BEFORE triggers can validate
-- NEW. The public UUID wrapper below remains the only stored-row entry point.
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

  -- Match fn_ca_fund_overlay_on_lock exactly: private or union-less rows use
  -- the club treasury; only a non-private row stamped with union_id uses the
  -- union bank. Club affiliation alone is not a funding transaction.
  v_union := CASE WHEN v_private THEN NULL ELSE v_row_union END;

  IF v_variant = 'satellite' AND v_satellite_seats > 0 AND v_target IS NOT NULL THEN
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
                 WHEN lower(COALESCE(t.variant, '')) = 'satellite'
                      AND COALESCE(t.satellite_seats, 0) > 0
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
                 WHEN lower(COALESCE(t.variant, '')) = 'satellite'
                      AND COALESCE(t.satellite_seats, 0) > 0
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
      v_variant <> 'satellite'
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

CREATE OR REPLACE FUNCTION public.fn_tournament_management_readiness(
  p_tournament_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row jsonb;
BEGIN
  SELECT to_jsonb(t)
    INTO v_row
    FROM public.tournaments t
   WHERE t.id = p_tournament_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'missing', 'can_start', false);
  END IF;

  RETURN public.fn_tournament_management_readiness_for_row(v_row);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_guard_tournament_start_readiness()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_readiness jsonb;
  v_enforce boolean;
BEGIN
  IF upper(COALESCE(OLD.status::text, '')) IN ('ANNOUNCED', 'REGISTERING')
     AND upper(COALESCE(NEW.status::text, '')) IN ('RUNNING', 'COMPLETING', 'COMPLETED') THEN
    SELECT COALESCE(c.guarantee_enforcement_enabled, true)
      INTO v_enforce
      FROM public.clubs c
     WHERE c.id = NEW.club_id;

    -- Serialize every enforced commitment against the exact account the
    -- overlay trigger will debit. After this lock is acquired, a competing
    -- start has either fully committed or rolled back before readiness reads.
    IF COALESCE(v_enforce, true) THEN
      IF COALESCE(NEW.is_private, false) OR NEW.union_id IS NULL THEN
        PERFORM 1 FROM public.clubs c WHERE c.id = NEW.club_id FOR UPDATE;
      ELSE
        PERFORM 1 FROM public.union_wallets uw WHERE uw.union_id = NEW.union_id FOR UPDATE;
      END IF;
    END IF;

    v_readiness := public.fn_tournament_management_readiness_for_row(to_jsonb(NEW));

    IF NOT COALESCE((v_readiness ->> 'can_start')::boolean, false) THEN
      IF v_readiness ->> 'state' = 'funding_blocked' THEN
        RAISE EXCEPTION 'Tournament cannot start because its guarantee is short by % chips',
          v_readiness ->> 'short_by' USING ERRCODE = '55000';
      END IF;
      RAISE EXCEPTION 'Tournament cannot start because its published contract is incomplete'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_guard_tournament_publish_readiness()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_readiness jsonb := public.fn_tournament_management_readiness_for_row(to_jsonb(NEW));
BEGIN
  IF v_readiness ->> 'state' = 'funding_blocked' THEN
    RAISE EXCEPTION 'Tournament cannot be published because its guarantee is short by % chips',
      v_readiness ->> 'short_by' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_guard_managed_game_contract_version()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_tournament_management_readiness_for_row(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_tournament_management_readiness(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_guard_tournament_start_readiness()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_guard_tournament_publish_readiness()
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fn_guard_managed_game_contract_version() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_tournament_management_readiness_for_row(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_tournament_management_readiness(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_guard_tournament_start_readiness() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_guard_tournament_publish_readiness() TO service_role;

DO $assert_phase_2$
DECLARE
  v_hash_uniques integer;
  v_start_source text;
  v_readiness_source text;
BEGIN
  SELECT count(*)
    INTO v_hash_uniques
    FROM pg_constraint c
   WHERE c.conrelid = 'public.managed_game_contract_versions'::regclass
     AND c.contype = 'u'
     AND (
       SELECT array_agg(a.attname::text ORDER BY k.ordinality)
         FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ordinality)
         JOIN pg_attribute a
           ON a.attrelid = c.conrelid
          AND a.attnum = k.attnum
     ) = ARRAY['game_kind', 'game_id', 'contract_hash']::text[];

  IF v_hash_uniques <> 0 THEN
    RAISE EXCEPTION 'contract hashes are still unique across revisions';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgrelid = 'public.managed_game_contract_versions'::regclass
       AND tgname = 'trg_managed_game_contract_version_immutable'
       AND NOT tgisinternal
       AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'contract history immutability trigger is missing or disabled';
  END IF;

  SELECT p.prosrc INTO v_start_source
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'fn_guard_tournament_start_readiness';
  SELECT p.prosrc INTO v_readiness_source
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'fn_tournament_management_readiness_for_row';

  IF position('to_jsonb(NEW)' in v_start_source) = 0
     OR position('FOR UPDATE' in v_start_source) = 0 THEN
    RAISE EXCEPTION 'start readiness is not validating NEW under a funding-bank lock';
  END IF;
  IF position('fn_safe_jsonb_array' in v_readiness_source) = 0
     OR position('satellite_seat_guarantee' in v_readiness_source) = 0 THEN
    RAISE EXCEPTION 'readiness lost safe JSON parsing or satellite guarantee value';
  END IF;

  IF has_function_privilege(
       'authenticated',
       'public.fn_tournament_management_readiness_for_row(jsonb)',
       'EXECUTE'
     ) OR has_function_privilege(
       'anon',
       'public.fn_tournament_management_readiness_for_row(jsonb)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'the private row-readiness helper is browser-callable';
  END IF;
END;
$assert_phase_2$;

COMMIT;
