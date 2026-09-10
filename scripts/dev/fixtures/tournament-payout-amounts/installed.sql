-- Captured installed authority; body is intentionally unchanged.
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_place_amounts(p_tournament_id uuid)
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
         t.bubble_protection
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
    SELECT e FROM jsonb_array_elements(v_trimmed) e
     ORDER BY (e->>'place')::integer
  LOOP
    v_index := v_index + 1;
    v_place := (v_entry->>'place')::integer;
    v_bp := (v_entry->>'bp')::bigint;
    IF v_index = v_count THEN
      v_share := v_remaining;
    ELSE
      v_share := LEAST(v_remaining,
        round((v_pool_cents::numeric * v_bp::numeric) / v_total_bp::numeric)::bigint);
    END IF;
    v_share := GREATEST(v_share,0);
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
$function$;
