-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260914003624 as "tournament_prize_rounding_contract_v2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
-- Reserved by scripts/reserve-migration-version.sh at 2026-09-13 20:42:49 UTC.
-- Support rollout: creators stay on v1 until both engine and client adoption are verified.
-- Whole-unit residuals could invert prizes: a 4-unit 34/33/33 ladder was 1/1/2.
-- Existing contracts retain version 1. New engine/client creators explicitly
-- choose version 2 in a subsequent activation. No existing funded row is repriced.
BEGIN;
SET LOCAL lock_timeout='5s';

ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS payout_math_version smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS payout_unit_cents integer NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION public.fn_ca_prize_ladder_v2(
  p_pool_cents bigint,p_entries jsonb,p_unit_cents integer
) RETURNS TABLE(place integer,cents bigint)
LANGUAGE plpgsql IMMUTABLE
SET search_path TO public,pg_temp
AS $function$
DECLARE
  v_entry jsonb;
  v_place numeric;
  v_bp numeric;
  v_total numeric;
  v_units bigint;
BEGIN
  IF p_pool_cents IS NULL OR p_pool_cents<0
     OR p_unit_cents IS NULL OR p_unit_cents<1 THEN
    RAISE EXCEPTION 'Prize pool must contain whole payout units' USING ERRCODE='22023';
  END IF;
  IF p_pool_cents%p_unit_cents<>0 THEN
    RAISE EXCEPTION 'Prize pool must contain whole payout units' USING ERRCODE='22023';
  END IF;
  IF p_entries IS NULL OR jsonb_typeof(p_entries)<>'array'
     OR jsonb_array_length(p_entries)=0 THEN
    RAISE EXCEPTION 'Version 2 requires a canonical payout ladder' USING ERRCODE='22023';
  END IF;
  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_entries) LOOP
    IF jsonb_typeof(v_entry)<>'object'
       OR jsonb_typeof(v_entry->'place') IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_entry->'bp') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'Canonical payout entries must contain numeric places and basis points'
        USING ERRCODE='22023';
    END IF;
    v_place:=(v_entry->>'place')::numeric;
    v_bp:=(v_entry->>'bp')::numeric;
    IF v_place<1 OR v_place>2147483647 OR v_place<>trunc(v_place)
       OR v_bp<=0 OR v_bp>10000 OR v_bp<>trunc(v_bp) THEN
      RAISE EXCEPTION 'Invalid canonical payout place or basis points' USING ERRCODE='22023';
    END IF;
  END LOOP;
  IF EXISTS (
    WITH entries AS (
      SELECT (e->>'place')::integer AS finish,(e->>'bp')::bigint AS bp
      FROM jsonb_array_elements(p_entries) e
    ), ranked AS (
      SELECT i.*,row_number() OVER(ORDER BY i.finish) AS ordinal,
        lag(i.bp) OVER(ORDER BY i.finish) AS prior_bp FROM entries i
    ) SELECT 1 FROM ranked r WHERE r.finish<>r.ordinal OR r.bp>r.prior_bp
  ) THEN
    RAISE EXCEPTION 'Version 2 requires contiguous places and nonincreasing percentages'
      USING ERRCODE='22023';
  END IF;
  IF p_pool_cents=0 THEN RETURN; END IF;
  SELECT sum((e->>'bp')::numeric) INTO v_total FROM jsonb_array_elements(p_entries) e;
  v_units:=p_pool_cents/p_unit_cents;
  RETURN QUERY
    WITH quotas AS (
      SELECT (e->>'place')::integer AS finish,
        floor(v_units::numeric*(e->>'bp')::numeric/v_total) AS units,
        mod(v_units::numeric*(e->>'bp')::numeric,v_total) AS remainder
      FROM jsonb_array_elements(p_entries) e
    ), ordered AS (
      SELECT q.*,row_number() OVER(ORDER BY q.remainder DESC,q.finish) AS priority
      FROM quotas q
    ), residual AS (SELECT v_units-sum(q.units) AS units FROM quotas q)
    SELECT q.finish,((q.units+CASE WHEN q.priority<=r.units THEN 1 ELSE 0 END)*p_unit_cents)::bigint
    FROM ordered q CROSS JOIN residual r ORDER BY q.finish;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_prize_ladder_v2(bigint,jsonb,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_prize_ladder_v2(bigint,jsonb,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_prize_ladder_versioned(
  p_pool_cents bigint,p_entries jsonb,p_unit_cents integer,p_version integer
) RETURNS TABLE(place integer,cents bigint)
LANGUAGE plpgsql IMMUTABLE
SET search_path TO public,pg_temp
AS $function$
BEGIN
  IF p_version=1 THEN
    RETURN QUERY SELECT l.place,l.cents FROM public.fn_ca_prize_ladder(p_pool_cents,p_entries,p_unit_cents) l;
  ELSIF p_version=2 THEN
    RETURN QUERY SELECT l.place,l.cents FROM public.fn_ca_prize_ladder_v2(p_pool_cents,p_entries,p_unit_cents) l;
  ELSE
    RAISE EXCEPTION 'Unsupported tournament payout math version' USING ERRCODE='22023';
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_prize_ladder_versioned(bigint,jsonb,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_prize_ladder_versioned(bigint,jsonb,integer,integer) TO service_role;

-- Version 1 rows keep their historical document and economics. Only future
-- field MTTs may select v2; seat-first and ticket contracts remain unchanged.
ALTER TABLE public.tournaments ADD CONSTRAINT tournament_prize_math_contract_valid CHECK (
  (payout_math_version=1 AND payout_unit_cents=1) OR
  (payout_math_version=2 AND payout_unit_cents IN(1,100)
   AND upper(COALESCE(tournament_type,''))='MTT' AND COALESCE(max_players,0)>2
   AND lower(COALESCE(variant,'')) NOT IN('spin','sng','satellite')
   AND NOT COALESCE(is_premium_spin,false)
   AND satellite_target_id IS NULL AND satellite_target IS NULL)
);

CREATE OR REPLACE FUNCTION public.fn_guard_tournament_prize_math_contract()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public,pg_temp
AS $function$
DECLARE v_unit integer;
BEGIN
  IF TG_OP='UPDATE' THEN
    -- Legacy club routing remains governed by its existing contract guards.
    -- This trigger freezes denomination only for an explicitly versioned ladder.
    IF OLD.payout_math_version=1 AND NEW.payout_math_version=1
       AND OLD.payout_unit_cents=1 AND NEW.payout_unit_cents=1 THEN RETURN NEW; END IF;
    IF ROW(NEW.payout_math_version,NEW.payout_unit_cents,NEW.club_id) IS NOT DISTINCT FROM
       ROW(OLD.payout_math_version,OLD.payout_unit_cents,OLD.club_id) THEN RETURN NEW; END IF;
    IF COALESCE(OLD.entry_contract_locked,false) OR COALESCE(OLD.prize_pool_finalized,false)
       OR OLD.started_at IS NOT NULL
       OR upper(COALESCE(OLD.status,'')) NOT IN('ANNOUNCED','REGISTERING','SCHEDULED')
       OR upper(COALESCE(NEW.status,'')) NOT IN('ANNOUNCED','REGISTERING','SCHEDULED')
       OR EXISTS(SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id=OLD.id)
       OR EXISTS(SELECT 1 FROM public.tournament_payouts tp WHERE tp.tournament_id=OLD.id)
       OR EXISTS(SELECT 1 FROM public.tournament_launch_receipts lr WHERE lr.tournament_id=OLD.id) THEN
      RAISE EXCEPTION 'Tournament prize arithmetic is frozen after entry or launch'
        USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.payout_math_version=2 THEN
    SELECT CASE WHEN c.asset='diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL
                THEN 100 ELSE 1 END INTO v_unit FROM public.clubs c WHERE c.id=NEW.club_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Prize contract requires an existing club' USING ERRCODE='23503'; END IF;
    -- The club determines denomination; a caller cannot request fractional Diamonds.
    NEW.payout_unit_cents:=v_unit;
  ELSE
    NEW.payout_unit_cents:=1;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_guard_tournament_prize_math_contract() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_guard_tournament_prize_math_contract() TO service_role;
CREATE TRIGGER tournament_prize_math_contract BEFORE INSERT OR UPDATE OF payout_math_version,payout_unit_cents,club_id
ON public.tournaments FOR EACH ROW EXECUTE FUNCTION public.fn_guard_tournament_prize_math_contract();

DO $patch$
DECLARE v_oid regprocedure := 'public.fn_ca_tournament_place_amounts(uuid)'::regprocedure;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=v_oid)='b42f1423bb5a4c0e8b054bb18a180ae8' THEN RETURN; END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=v_oid) IS DISTINCT FROM '552b5a93163b625b5b69ff1503a3f3ee' THEN
    RAISE EXCEPTION 'Prize version repair refuses unreviewed public.fn_ca_tournament_place_amounts(uuid)';
  END IF;
  EXECUTE $candidate$CREATE OR REPLACE FUNCTION public.fn_ca_tournament_place_amounts(p_tournament_id uuid)
 RETURNS TABLE(place integer, amount numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_t record;
  v_pool numeric;
  v_ladder_pool numeric;
  v_bubble_amount numeric := 0;
  v_expected_pool numeric;
  v_pool_cents bigint;
  v_remaining bigint;
  v_share bigint;
  v_total_bp bigint := 0;
  v_bp bigint;
  v_field integer;
  v_struct jsonb;
  v_work jsonb := '[]'::jsonb;
  v_trimmed jsonb := '[]'::jsonb;
  v_entry jsonb;
  v_place_numeric numeric;
  v_pct numeric;
  v_place integer;
  v_valid boolean := true;
  v_is_spin boolean;
  v_known_spin boolean := false;
  v_count integer;
  v_max_place integer;
  v_index integer := 0;
BEGIN
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'place amount derivation requires a tournament id'
      USING ERRCODE = '22004';
  END IF;

  SELECT t.id, t.prize_pool, t.payout_structure, t.variant,
         t.tournament_type, t.is_premium_spin, t.spin_multiplier,
         t.buy_in_amount, t.satellite_target_id, t.satellite_target,
         t.bubble_protection,t.payout_math_version,t.payout_unit_cents
    INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  IF lower(COALESCE(v_t.variant, '')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type, '')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL
     OR v_t.satellite_target IS NOT NULL THEN
    RAISE EXCEPTION 'tournament % is a satellite, not a cash ladder',
      p_tournament_id USING ERRCODE = '22023';
  END IF;

  IF v_t.payout_math_version=2 AND v_t.payout_unit_cents IS DISTINCT FROM public.fn_ca_tournament_unit_cents(p_tournament_id) THEN
    RAISE EXCEPTION 'Tournament denomination differs from its prize contract' USING ERRCODE='23514';
  END IF;
  v_pool := v_t.prize_pool;
  IF v_pool IS NULL
     OR v_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_pool < 0
     OR v_pool IS DISTINCT FROM round(v_pool, 2) THEN
    RAISE EXCEPTION 'tournament % has invalid whole-cent prize pool %',
      p_tournament_id, v_pool USING ERRCODE = '22003';
  END IF;
  SELECT count(*) INTO v_field FROM public.tournament_players
   WHERE tournament_id = p_tournament_id;
  IF v_field < 1 THEN
    RAISE EXCEPTION 'tournament % has no roster', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;

  v_is_spin := lower(COALESCE(v_t.variant, '')) = 'spin'
               OR COALESCE(v_t.is_premium_spin, false)
               OR upper(COALESCE(v_t.tournament_type, '')) = 'SPIN';
  IF v_is_spin THEN
    IF v_t.spin_multiplier IS NULL
       OR v_t.spin_multiplier::text IN ('NaN','Infinity','-Infinity')
       OR v_t.spin_multiplier <= 0
       OR v_t.buy_in_amount IS NULL
       OR v_t.buy_in_amount::text IN ('NaN','Infinity','-Infinity')
       OR v_t.buy_in_amount < 0
       OR v_t.buy_in_amount IS DISTINCT FROM round(v_t.buy_in_amount, 2) THEN
      RAISE EXCEPTION 'Spin % has invalid locked buy-in/multiplier evidence',
        p_tournament_id USING ERRCODE = '22003';
    END IF;
    v_expected_pool := round(v_t.buy_in_amount * v_t.spin_multiplier, 2);
    IF v_expected_pool::text IN ('NaN','Infinity','-Infinity')
       OR v_pool IS DISTINCT FROM v_expected_pool THEN
      RAISE EXCEPTION
        'Spin % pool % does not equal buy-in % x multiplier % (= %)',
        p_tournament_id, v_pool, v_t.buy_in_amount, v_t.spin_multiplier,
        v_expected_pool USING ERRCODE = '23514';
    END IF;

    IF v_t.spin_multiplier IN (2,3,4,5) THEN
      v_struct := '[{"place":1,"percentage":100}]'::jsonb;
      v_known_spin := true;
    ELSIF v_t.spin_multiplier = 10 THEN
      v_struct := '[{"place":1,"percentage":80},{"place":2,"percentage":20}]'::jsonb;
      v_known_spin := true;
    ELSIF v_t.spin_multiplier IN (25,50,100) THEN
      v_struct := '[{"place":1,"percentage":80},{"place":2,"percentage":12},{"place":3,"percentage":8}]'::jsonb;
      v_known_spin := true;
    END IF;
  END IF;

  -- Unknown/retired Spin multipliers and non-Spins read the stored structure.
  IF NOT v_known_spin THEN
    BEGIN
      v_struct := NULLIF(btrim(COALESCE(v_t.payout_structure::text, '')), '')::jsonb;
    EXCEPTION WHEN invalid_text_representation THEN
      v_struct := NULL;
    END;
  END IF;
  IF v_struct IS NULL OR jsonb_typeof(v_struct) <> 'array'
     OR jsonb_array_length(v_struct) = 0 THEN
    v_valid := false;
  END IF;

  -- Fractional places and non-finite/non-positive shares fail this candidate.
  -- As in computePlacePrize, the first entry for a duplicate place wins.
  IF v_valid THEN
    FOR v_entry IN SELECT value FROM jsonb_array_elements(v_struct) LOOP
      IF jsonb_typeof(v_entry) <> 'object'
         OR v_entry->>'place' IS NULL
         OR v_entry->>'percentage' IS NULL THEN
        v_valid := false; EXIT;
      END IF;
      BEGIN
        v_place_numeric := (v_entry->>'place')::numeric;
        v_pct := (v_entry->>'percentage')::numeric;
      EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        v_valid := false; EXIT;
      END;
      IF v_place_numeric::text IN ('NaN','Infinity','-Infinity')
         OR v_pct::text IN ('NaN','Infinity','-Infinity')
         OR v_place_numeric < 1 OR v_place_numeric <> trunc(v_place_numeric)
         OR v_place_numeric > 2147483647 OR v_pct <= 0 THEN
        v_valid := false; EXIT;
      END IF;
      IF v_t.payout_math_version=2 AND
         (v_pct>100 OR v_pct<>round(v_pct,2) OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(v_work) e WHERE (e->>'place')::numeric=v_place_numeric
         )) THEN
        RAISE EXCEPTION 'Version 2 requires unique whole-hundredth payout shares' USING ERRCODE='22023';
      END IF;
      v_place := v_place_numeric::integer;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_work) e
                  WHERE (e->>'place')::integer = v_place) THEN
        CONTINUE;
      END IF;
      BEGIN
        v_bp := round(v_pct * 100)::bigint;
      EXCEPTION WHEN numeric_value_out_of_range THEN
        v_valid := false; EXIT;
      END;
      IF v_bp <= 0 THEN
        v_valid := false; EXIT;
      END IF;
      v_work := v_work || jsonb_build_object('place',v_place,'bp',v_bp);
    END LOOP;
  END IF;
  IF v_valid AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_work) e
     WHERE (e->>'place')::integer = 1
  ) THEN
    v_valid := false;
  END IF;

  IF NOT v_valid THEN
    RAISE EXCEPTION
      'tournament % has no usable canonical payout ladder',
      p_tournament_id USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(jsonb_agg(e ORDER BY (e->>'place')::integer),'[]'::jsonb)
    INTO v_trimmed FROM jsonb_array_elements(v_work) e
   WHERE (e->>'place')::integer <= v_field;
  IF jsonb_array_length(v_trimmed) = 0 THEN
    RAISE EXCEPTION 'tournament % ladder has no place in final field %',
      p_tournament_id, v_field USING ERRCODE = '22023';
  END IF;
  SELECT count(*), COALESCE(sum((e->>'bp')::bigint),0)
    INTO v_count, v_total_bp FROM jsonb_array_elements(v_trimmed) e;
  IF v_total_bp <= 0 THEN
    RAISE EXCEPTION 'tournament % ladder has no positive percentage',
      p_tournament_id USING ERRCODE = '22023';
  END IF;

  SELECT max((e->>'place')::integer)
    INTO v_max_place
    FROM jsonb_array_elements(v_trimmed) e;

  -- Bubble protection is part of the tournament pool, not a house overlay.
  -- When the final field contains a stone bubble, reserve exactly one base
  -- buy-in before pricing the percentage ladder. The bubble and all places
  -- therefore spend the locked prize_pool exactly once between them.
  IF COALESCE(v_t.bubble_protection, false) AND v_field > v_max_place THEN
    IF v_t.buy_in_amount IS NULL
       OR v_t.buy_in_amount::text IN ('NaN','Infinity','-Infinity')
       OR v_t.buy_in_amount <= 0
       OR v_t.buy_in_amount IS DISTINCT FROM round(v_t.buy_in_amount, 2) THEN
      RAISE EXCEPTION
        'tournament % has bubble protection but invalid whole-cent buy-in %',
        p_tournament_id, v_t.buy_in_amount USING ERRCODE = '22003';
    END IF;
    v_bubble_amount := round(v_t.buy_in_amount, 2);
    IF v_bubble_amount > v_pool THEN
      RAISE EXCEPTION
        'tournament % bubble amount % exceeds locked prize pool %',
        p_tournament_id, v_bubble_amount, v_pool USING ERRCODE = '23514';
    END IF;
  END IF;

  v_ladder_pool := round(v_pool - v_bubble_amount, 2);
  v_pool_cents := round(v_ladder_pool * 100)::bigint;

  -- Mirror computePlacePrize: normalize to surviving basis points, spend down
  -- in place order, and give the exact remaining cents to the last place.
  v_remaining := v_pool_cents;
  FOR v_entry IN
    SELECT jsonb_build_object('place', l.place, 'cents', l.cents)
      FROM public.fn_ca_prize_ladder_versioned(
             v_pool_cents,
             v_trimmed,
             public.fn_ca_tournament_unit_cents(p_tournament_id),v_t.payout_math_version) l
     ORDER BY l.place
  LOOP
    v_index := v_index + 1;
    v_place := (v_entry->>'place')::integer;
    v_share := (v_entry->>'cents')::bigint;
    v_remaining := v_remaining - v_share;
    place := v_place;
    amount := (v_share::numeric / 100)::numeric(15,2);
    IF amount::text IN ('NaN','Infinity','-Infinity')
       OR amount < 0 OR amount IS DISTINCT FROM round(amount,2) THEN
      RAISE EXCEPTION 'derived invalid amount % for tournament %, place %',
        amount, p_tournament_id, place USING ERRCODE = '22003';
    END IF;
    RETURN NEXT;
  END LOOP;
  IF v_remaining <> 0 THEN
    RAISE EXCEPTION 'tournament % ladder left % cents undistributed',
      p_tournament_id, v_remaining USING ERRCODE = '23514';
  END IF;
END;
$function$
$candidate$;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=v_oid) IS DISTINCT FROM 'b42f1423bb5a4c0e8b054bb18a180ae8' THEN RAISE EXCEPTION 'Prize version source verification failed'; END IF;
END;
$patch$;

DO $patch$
DECLARE v_oid regprocedure := 'public.fn_managed_game_contract_document(text,jsonb)'::regprocedure;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=v_oid)='e691ed61c33d5b6b91045a6575245b70' THEN RETURN; END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=v_oid) IS DISTINCT FROM 'b2c5092671ec7aaec54050f62e2be7d0' THEN
    RAISE EXCEPTION 'Prize version repair refuses unreviewed public.fn_managed_game_contract_document(text,jsonb)';
  END IF;
  EXECUTE $candidate$CREATE OR REPLACE FUNCTION public.fn_managed_game_contract_document(p_kind text, p_row jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE p_kind
    WHEN 'table' THEN p_row - ARRAY[
      'current_players', 'status', 'created_at', 'updated_at', 'deleted_at',
      'lifecycle', 'role', 'main_index', 'opened_at', 'live_at',
      'break_started_at', 'break_eligible_since', 'promote_pending',
      'deleted_by', 'is_deleted', 'current_hand_id', 'hand_number',
      'last_activity_at', 'tournament_id', 'engine_instance_id',
      'first_button_seat', 'bomb_pot_manual_pending', 'bomb_pot_sched_state',
      'bomb_pot_next_due_at', 'engine_lease_owner', 'engine_lease_expires_at', 'seat_game_scope', 'seat_admission_key'
    ]::text[]
    WHEN 'tournament' THEN jsonb_strip_nulls(
      jsonb_build_object(
        'id', p_row -> 'id', 'club_id', p_row -> 'club_id',
        'union_id', p_row -> 'union_id', 'name', p_row -> 'name',
        'description', p_row -> 'description',
        'short_description', p_row -> 'short_description',
        'game_type', p_row -> 'game_type', 'variant', p_row -> 'variant',
        'tournament_type', p_row -> 'tournament_type',
        'buy_in_amount', p_row -> 'buy_in_amount',
        'buy_in_fee', p_row -> 'buy_in_fee',
        'starting_chips', p_row -> 'starting_chips',
        'max_players', p_row -> 'max_players',
        'min_players', p_row -> 'min_players',
        'blind_structure', p_row -> 'blind_structure',
        'payout_structure', p_row -> 'payout_structure',
        'payout_percent', p_row -> 'payout_percent',
        'payout_math_version', CASE WHEN p_row->>'payout_math_version'='2' THEN p_row->'payout_math_version' END,
        'payout_unit_cents', CASE WHEN p_row->>'payout_math_version'='2' THEN p_row->'payout_unit_cents' END,
        'guaranteed_prize', p_row -> 'guaranteed_prize'
      ) || jsonb_build_object(
        'late_reg_levels', p_row -> 'late_reg_levels',
        'late_reg_mins', p_row -> 'late_reg_mins',
        'rebuy_levels', p_row -> 'rebuy_levels',
        'start_time', p_row -> 'start_time',
        'is_rebuy', p_row -> 'is_rebuy',
        'is_reentry', p_row -> 'is_reentry',
        'rebuy_cost', p_row -> 'rebuy_cost',
        'rebuy_chips', p_row -> 'rebuy_chips',
        'max_rebuys', p_row -> 'max_rebuys',
        'max_reentries', p_row -> 'max_reentries',
        'free_buy', p_row -> 'free_buy',
        'add_on_available', p_row -> 'add_on_available',
        'addon_from_start', p_row -> 'addon_from_start',
        'addon_cost', p_row -> 'addon_cost',
        'addon_chips', p_row -> 'addon_chips',
        'addon_levels', p_row -> 'addon_levels',
        'addon_break_minutes', p_row -> 'addon_break_minutes'
      ) || jsonb_build_object(
        'is_bounty', p_row -> 'is_bounty',
        'bounty_amount', p_row -> 'bounty_amount',
        'is_pko', p_row -> 'is_pko',
        'is_mystery_bounty', p_row -> 'is_mystery_bounty',
        'mystery_bounty_min', p_row -> 'mystery_bounty_min',
        'mystery_bounty_max', p_row -> 'mystery_bounty_max',
        'mystery_bounty_profile', p_row -> 'mystery_bounty_profile',
        'mystery_bounty_activation', p_row -> 'mystery_bounty_activation',
        'mystery_bounty_activation_value', p_row -> 'mystery_bounty_activation_value',
        'mystery_bounty_pool_percent', p_row -> 'mystery_bounty_pool_percent',
        'mystery_bounty_regular_pool_percent', p_row -> 'mystery_bounty_regular_pool_percent',
        'mystery_bounty_top_percent', p_row -> 'mystery_bounty_top_percent',
        'spin_type', p_row -> 'spin_type',
        'satellite_target_id', p_row -> 'satellite_target_id',
        'satellite_target', p_row -> 'satellite_target',
        'satellite_seats', p_row -> 'satellite_seats'
      ) || jsonb_build_object(
        'is_xmtt', p_row -> 'is_xmtt',
        'is_private', p_row -> 'is_private',
        'is_vip_only', p_row -> 'is_vip_only',
        'ban_chat', p_row -> 'ban_chat',
        'all_in_or_fold', p_row -> 'all_in_or_fold',
        'label_as_new', p_row -> 'label_as_new',
        'hide_club_name', p_row -> 'hide_club_name',
        'action_time_seconds', p_row -> 'action_time_seconds',
        'table_size', p_row -> 'table_size',
        'accelerated_mtt', p_row -> 'accelerated_mtt',
        'big_blind_ante', p_row -> 'big_blind_ante',
        'authorized_to_register', p_row -> 'authorized_to_register',
        'early_bird_enabled', p_row -> 'early_bird_enabled',
        'early_bird_chips', p_row -> 'early_bird_chips',
        'bubble_protection', p_row -> 'bubble_protection',
        'final_table_deal_enabled', p_row -> 'final_table_deal_enabled',
        'restart_every_minutes', p_row -> 'restart_every_minutes',
        'synchronized_breaks', p_row -> 'synchronized_breaks'
      ) || jsonb_build_object(
        'is_multi_day', p_row -> 'is_multi_day',
        'total_days', p_row -> 'total_days',
        'is_pinned', p_row -> 'is_pinned',
        'schedule_id', p_row -> 'schedule_id'
      )
    )
    ELSE '{}'::jsonb
  END
$function$
$candidate$;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=v_oid) IS DISTINCT FROM 'e691ed61c33d5b6b91045a6575245b70' THEN RAISE EXCEPTION 'Prize version source verification failed'; END IF;
END;
$patch$;

DO $patch$
DECLARE v_oid regprocedure := 'public.fn_tournament_payout_reconcile(uuid,boolean)'::regprocedure;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=v_oid)='9a7211f658faf3c108451d2caca1d561' THEN RETURN; END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=v_oid) IS DISTINCT FROM '7c8cadc7bbd886ee370dae32adcffeb7' THEN
    RAISE EXCEPTION 'Prize version repair refuses unreviewed public.fn_tournament_payout_reconcile(uuid,boolean)';
  END IF;
  EXECUTE $candidate$CREATE OR REPLACE FUNCTION public.fn_tournament_payout_reconcile(p_tournament_id uuid, p_apply boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  t                record;
  v_struct         jsonb;
  v_trimmed        jsonb;
  v_field          int;
  v_pool           numeric;
  v_last_place     int;
  v_total_bp       numeric;
  v_pool_cents     numeric;
  v_remaining      numeric;
  v_cents          numeric;
  v_expected       numeric;
  v_paid           numeric;
  v_paid_place     numeric;
  v_paid_eff       numeric;
  v_place_others   uuid[];
  v_delta          numeric;
  v_holder         uuid;
  v_holders        int;
  v_credited       boolean;
  v_settle         jsonb;
  v_settle_paid    numeric;
  v_actions        jsonb := '[]'::jsonb;
  v_issues         jsonb := '[]'::jsonb;
  v_total_expected numeric := 0;
  v_total_paid     numeric := 0;
  v_total_topup    numeric := 0;
  v_total_settled  numeric := 0;
  v_only_accepted  boolean;
  v_was_accepted   boolean;
  v_has_record     boolean;
  v_all_paid       numeric := 0;
  v_unranked_paid  numeric := 0;
  v_deal_settled   boolean := false;
  r                record;
BEGIN
  SELECT id, prize_pool, payout_structure, status, variant, tournament_type, name
    INTO t
    FROM tournaments WHERE id = p_tournament_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;

  IF COALESCE(t.variant, '') = 'satellite'
     OR upper(COALESCE(t.tournament_type, '')) = 'SATELLITE' THEN
    RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                              'skipped', 'satellite_awards_seats');
  END IF;

  IF COALESCE(t.status, '') <> 'COMPLETED' THEN
    RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                              'skipped', 'not_completed', 'status', t.status);
  END IF;

  v_pool := round(COALESCE(t.prize_pool, 0), 2);

  BEGIN
    v_struct := CASE WHEN jsonb_typeof(t.payout_structure::jsonb) = 'array'
                     THEN t.payout_structure::jsonb ELSE '[]'::jsonb END;
  EXCEPTION WHEN OTHERS THEN
    v_struct := '[]'::jsonb;
  END;

  IF v_pool <= 0 OR jsonb_array_length(v_struct) = 0 THEN
    RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                              'skipped', 'no_pool_or_structure',
                              'prize_pool', v_pool);
  END IF;

  /* Is there an authoritative record for this event at all? */
  SELECT EXISTS (SELECT 1 FROM public.tournament_payouts tpo
                  WHERE tpo.tournament_id = p_tournament_id)
    INTO v_has_record;

  /* PAYMENTS OUTSIDE THE RANKED STRUCTURE ARE STILL PAYMENTS (2026-09-09). */
  SELECT COALESCE(sum(tpo.amount), 0),
         COALESCE(sum(tpo.amount) FILTER (WHERE tpo."position" IS NULL), 0),
         COALESCE(bool_or(tpo.source = 'final_table_deal'), false)
    INTO v_all_paid, v_unranked_paid, v_deal_settled
    FROM public.tournament_payouts tpo
   WHERE tpo.tournament_id = p_tournament_id;

  IF v_deal_settled THEN
    RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
      'name', t.name, 'skipped', 'settled_by_final_table_deal',
      'prize_pool', v_pool, 'paid', round(v_all_paid, 2),
      'detail', 'the finalists agreed the split and it was paid; the ranked '
             || 'structure does not describe this event and must not be '
             || 'reconciled against it');
  END IF;

  IF round(v_all_paid, 2) >= round(v_pool, 2) - 0.005 THEN
    RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
      'name', t.name, 'skipped', 'pool_fully_discharged',
      'prize_pool', v_pool, 'paid', round(v_all_paid, 2),
      'unranked_paid', round(v_unranked_paid, 2),
      'over_promised', round(GREATEST(v_all_paid - v_pool, 0), 2),
      'detail', 'every chip of this pool has been paid out. A remaining '
             || 'per-place gap is an over-promise to be funded by the house, '
             || 'not an unpaid pool; topping it up from here would pay the '
             || 'same pool twice');
  END IF;


  SELECT count(*) INTO v_field
    FROM tournament_players tp WHERE tp.tournament_id = p_tournament_id;

  IF COALESCE(v_field, 0) >= 1 THEN
    SELECT COALESCE(jsonb_agg(e ORDER BY (e->>'place')::int), '[]'::jsonb)
      INTO v_trimmed
      FROM jsonb_array_elements(v_struct) e
     WHERE (e->>'place')::int <= v_field;

    IF jsonb_array_length(v_trimmed) > 0
       AND jsonb_array_length(v_trimmed) < jsonb_array_length(v_struct) THEN
      v_struct := v_trimmed;
    END IF;
  END IF;

  SELECT max((e->>'place')::int) INTO v_last_place
    FROM jsonb_array_elements(v_struct) e;

  SELECT COALESCE(SUM(round((e->>'percentage')::numeric * 100)), 0)
    INTO v_total_bp
    FROM jsonb_array_elements(v_struct) e;

  IF v_total_bp <= 0 THEN
    RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                              'skipped', 'structure_has_no_percentages');
  END IF;

  v_pool_cents := round(v_pool * 100);
  v_remaining  := v_pool_cents;

  -- The settlement authority owns Bubble reserves, denomination, final-field
  -- trimming and version selection. Reconciliation must propose its exact cents.
  FOR r IN
    SELECT l.place,round(l.amount*100)::bigint AS cents
      FROM public.fn_ca_tournament_place_amounts(p_tournament_id) l ORDER BY l.place
  LOOP
    v_cents := r.cents;
    v_remaining := v_remaining - v_cents;

    v_expected := v_cents / 100.0;
    v_total_expected := v_total_expected + v_expected;

    SELECT count(*), (array_agg(tp.user_id ORDER BY tp.user_id))[1]
      INTO v_holders, v_holder
      FROM tournament_players tp
     WHERE tp.tournament_id = p_tournament_id AND tp.position = r.place;

    v_paid_place   := 0;
    v_place_others := ARRAY[]::uuid[];

    IF v_holders = 1 THEN
      IF v_has_record THEN
        /* THE AUTHORITATIVE ANSWER. One row per movement of money, keyed
           uniquely, written only after the credit returned true. Bounty and
           mystery-bounty money is excluded: it is funded from the bounty pool,
           not from prize_pool, and counting it here used to make a player look
           square when the structure still owed them.
           2026-09-02: 'overlay_backpay' added. A guarantee overlay top-up IS
           prize_pool money. While it was missing from this list the reconciler
           could not see 1,703.00 chips of back-payment and paid 1,007.80 of it
           a second time.
           2026-09-02 (Lane A3): a row written by fn_settle_tournament_obligation
           (idempotency_key 'obl:%') is prize-pool money whatever source label
           the caller passed - the engine settles under 'engine.*' names. */
        SELECT round(COALESCE(SUM(tpo.amount), 0), 2) INTO v_paid
          FROM public.tournament_payouts tpo
         WHERE tpo.tournament_id = p_tournament_id
           AND tpo.user_id = v_holder
           AND (tpo.source IN ('structure', 'reconcile', 'hu_shortfall',
                               'late_reg_adjustment', 'clawback',
                               'final_table_deal', 'spin_backpay',
                               'overlay_backpay')
                OR tpo.idempotency_key LIKE 'tourney:%:obl:%');

        /* A PLACE IS PAID ONCE, NO MATTER WHO HOLDS IT (2026-09-02).
           What this place has already cost, to ANYBODY. The obligation is per
           place; reading only the current holder let a place that changed hands
           after settlement be paid in full a second time -- 81 places, 49
           events, 21,206.93 chips. */
        SELECT round(COALESCE(SUM(tpo.amount), 0), 2),
               COALESCE(array_agg(DISTINCT tpo.user_id)
                        FILTER (WHERE tpo.user_id <> v_holder), ARRAY[]::uuid[])
          INTO v_paid_place, v_place_others
          FROM public.tournament_payouts tpo
         WHERE tpo.tournament_id = p_tournament_id
           AND tpo.position = r.place
           AND (tpo.source IN ('structure', 'reconcile', 'hu_shortfall',
                               'late_reg_adjustment', 'clawback',
                               'final_table_deal', 'spin_backpay',
                               'overlay_backpay')
                OR tpo.idempotency_key LIKE 'tourney:%:obl:%');
      ELSE
        /* No record for this event. Fall back to the ledger exactly as before
           rather than reading "no record" as "nothing was paid". */
        SELECT round(COALESCE(SUM(
                 CASE WHEN lower(wt.type) = 'debit' THEN -abs(wt.amount)
                      ELSE wt.amount END
               ), 0), 2) INTO v_paid
          FROM wallet_transactions wt
         WHERE wt.related_entity_id = p_tournament_id
           AND wt.category = 'prize'
           AND wt.user_id = v_holder;
      END IF;
    ELSE
      v_paid := NULL;
    END IF;

    IF v_holders = 0 THEN
      v_issues := v_issues || jsonb_build_object(
        'place', r.place, 'issue', 'no_finisher_recorded',
        'expected', v_expected,
        'detail', 'prize is owed to nobody identifiable; needs a human decision');
      CONTINUE;
    END IF;

    IF v_holders > 1 THEN
      v_issues := v_issues || jsonb_build_object(
        'place', r.place, 'issue', 'duplicate_finishers',
        'holders', v_holders, 'expected', v_expected,
        'detail', 'more than one player recorded in this place (double-pay defect)');
      CONTINUE;
    END IF;

    /* The cap. A top-up settles what the PLACE still owes, not what this
       particular player has yet to receive from it. */
    v_paid_eff := GREATEST(COALESCE(v_paid, 0), COALESCE(v_paid_place, 0));

    IF COALESCE(v_paid_place, 0) > COALESCE(v_paid, 0) + 0.005 THEN
      v_issues := v_issues || jsonb_build_object(
        'place', r.place, 'issue', 'place_paid_to_a_different_player',
        'user_id', v_holder,
        'paid_to_current_holder', COALESCE(v_paid, 0),
        'paid_at_this_place', v_paid_place,
        'other_recipients', to_jsonb(v_place_others),
        'expected', v_expected,
        'detail', 'this place was settled before the finishing order changed. '
               || 'No automatic top-up: the place is already paid. Paying the '
               || 'current holder as well is a deliberate decision (CLAUDE.md 10.9), '
               || 'made with the earlier payment in view.');
    END IF;

    v_total_paid := v_total_paid + v_paid_eff;
    v_delta := round(v_expected - v_paid_eff, 2);
    v_credited := NULL;
    v_settle := NULL;
    v_settle_paid := 0;

    IF v_delta > 0.005 THEN
      v_total_topup := v_total_topup + v_delta;

      IF p_apply THEN
        IF NOT v_has_record AND COALESCE(v_paid, 0) > 0.005 THEN
          /* THE OBLIGATION LEDGER SEEDS FROM tournament_payouts. This event
             has no payout record at all, yet the holder's wallet shows prize
             credits. Settling from the entitlement would pay the wallet a
             second time - the exact defect this lane exists to end. Report;
             a human writes the record. */
          v_credited := false;
          v_issues := v_issues || jsonb_build_object(
            'place', r.place, 'issue', 'paid_without_payout_record',
            'user_id', v_holder, 'expected', v_expected,
            'wallet_prizes', COALESCE(v_paid, 0), 'wanted', v_delta,
            'detail', 'the wallet was credited but no tournament_payouts row records it; '
                   || 'the obligation ledger cannot see that payment, so nothing was settled. '
                   || 'Backfill the payout record, then re-run.');
        ELSE
          /* ONE SETTLE PATH (Lane A3, 2026-09-02). The place is settled with its
             FULL entitlement; fn_settle_tournament_obligation pays the difference
             against what it already holds as paid, refuses a replay, a second
             user on a paid place, and a payment the prize pool cannot cover
             (escrow_short raises its own critical alert; nothing else may pay). */
          v_settle := public.fn_settle_tournament_obligation(
            p_tournament_id, 'place', r.place, v_holder, v_expected, 'reconcile',
            'Tournament payout reconciliation place ' || r.place::text
              || ' (' || COALESCE(t.name, 'tournament') || ')');
          v_credited    := COALESCE((v_settle->>'ok')::boolean, false);
          v_settle_paid := round(COALESCE((v_settle->>'paid')::numeric, 0), 2);
          v_total_settled := v_total_settled + v_settle_paid;

          IF NOT v_credited THEN
            v_issues := v_issues || jsonb_build_object(
              'place', r.place, 'issue', 'top_up_refused_by_obligation',
              'user_id', v_holder, 'expected', v_expected,
              'already_paid', v_paid_eff, 'wanted', v_delta,
              'refused_reason', v_settle->>'refused_reason',
              'obligation_id', v_settle->>'obligation_id',
              'detail', 'fn_settle_tournament_obligation refused this top-up; '
                     || 'the remaining shortfall needs a human decision');
          END IF;
        END IF;
      END IF;

      v_actions := v_actions || jsonb_build_object(
        'place', r.place, 'user_id', v_holder,
        'expected', v_expected, 'already_paid', v_paid_eff, 'top_up', v_delta,
        'applied', p_apply,
        'settled', CASE WHEN p_apply THEN v_settle_paid ELSE NULL END,
        'obligation_id', v_settle->>'obligation_id');

    ELSIF v_delta < -0.005 THEN
      v_issues := v_issues || jsonb_build_object(
        'place', r.place, 'issue', 'overpaid', 'user_id', v_holder,
        'expected', v_expected, 'already_paid', v_paid_eff, 'excess', -v_delta,
        'detail', 'reported only; automatic clawback is deliberately not done');
    END IF;

    IF p_apply AND v_expected > 0
       AND COALESCE(v_credited, true)
       AND (v_paid_eff + v_settle_paid)
           >= v_expected - 0.005 THEN
      UPDATE tournament_players tp
         SET prize = v_expected
       WHERE tp.tournament_id = p_tournament_id
         AND tp.user_id = v_holder
         AND tp.position = r.place
         AND COALESCE(tp.prize, 0) = 0;
    END IF;
  END LOOP;

  IF jsonb_array_length(v_issues) > 0 THEN
    v_only_accepted := NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_issues) i
       WHERE i->>'issue' NOT IN ('overpaid', 'no_finisher_recorded',
                                 'place_paid_to_a_different_player')
    );
    v_was_accepted := EXISTS (
      SELECT 1 FROM financial_alerts
       WHERE source = 'fn_tournament_payout_reconcile'
         AND resolved IS TRUE
         AND context->>'tournament_id' = p_tournament_id::text
         AND context ? 'resolution'
    );

    INSERT INTO financial_alerts (severity, source, message, context)
    SELECT 'critical', 'fn_tournament_payout_reconcile',
           'Tournament payout could not be fully reconciled: '
             || COALESCE(t.name, p_tournament_id::text),
           jsonb_build_object('tournament_id', p_tournament_id,
                              'prize_pool', v_pool, 'issues', v_issues)
     WHERE NOT EXISTS (
       SELECT 1 FROM financial_alerts
        WHERE source = 'fn_tournament_payout_reconcile'
          AND resolved IS NOT TRUE
          AND context->>'tournament_id' = p_tournament_id::text)
       AND NOT (round(v_total_topup, 2) = 0 AND v_only_accepted AND v_was_accepted);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'tournament_id', p_tournament_id,
    'name', t.name,
    'prize_pool', v_pool,
    'field_size', v_field,
    'paid_places', jsonb_array_length(v_struct),
    'total_expected', round(v_total_expected, 2),
    'total_paid_to_known_holders', round(v_total_paid, 2),
    'total_top_up', round(v_total_topup, 2),
    'total_settled', round(v_total_settled, 2),
    'applied', p_apply,
    'paid_from', CASE WHEN v_has_record THEN 'payout_record' ELSE 'ledger_fallback' END,
    'money_path', 'fn_settle_tournament_obligation',
    'actions', v_actions,
    'issues', v_issues,
    'clean', (jsonb_array_length(v_actions) = 0 AND jsonb_array_length(v_issues) = 0));
END;
$function$
$candidate$;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=v_oid) IS DISTINCT FROM '9a7211f658faf3c108451d2caca1d561' THEN RAISE EXCEPTION 'Prize version source verification failed'; END IF;
END;
$patch$;

COMMIT;

