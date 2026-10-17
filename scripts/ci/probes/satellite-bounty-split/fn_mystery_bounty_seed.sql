CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_seed(p_tournament_id uuid, p_players_remaining integer, p_chests jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t record;
  v_pool_cents bigint;
  v_bounty_cents bigint;
  v_m numeric; v_r numeric;
  v_sum bigint; v_count int;
  v_unrecorded_cents bigint := 0;
BEGIN
  /* A BUST BELONGS TO THE PHASE ITS HAND WAS PLAYED IN (2026-09-11). The
     tournament lane first: every hand commit takes it SHARED before writing,
     so no hand of this event commits while the inventory is sealed, and the
     activated_at stamped below orders every bust hand exactly. */
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  SELECT id, is_mystery_bounty, prize_pool_finalized, bounty_pool,
         bounty_pool_paid, mystery_bounty_stage,
         mystery_bounty_pool_percent, mystery_bounty_regular_pool_percent,
         mystery_bounty_pool_cents
    INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;

  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;
  IF NOT COALESCE(v_t.is_mystery_bounty, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_mystery_bounty');
  END IF;

  -- IDEMPOTENT. The engine's activation check runs on a five-second sweep and
  -- a restart re-runs it; seeding twice would double the inventory and the
  -- event could never reconcile.
  IF v_t.mystery_bounty_stage <> 'pending' THEN
    SELECT count(*), COALESCE(sum(amount_cents), 0) INTO v_count, v_sum
      FROM public.tournament_bounty_chests WHERE tournament_id = p_tournament_id;
    RETURN jsonb_build_object('ok', true, 'already_seeded', true,
      'stage', v_t.mystery_bounty_stage, 'chests', v_count,
      'pool_cents', COALESCE(v_t.mystery_bounty_pool_cents, v_sum));
  END IF;

  -- ENTRY MUST BE CLOSED. bounty_pool still grows with every late entry,
  -- rebuy and add-on; an inventory built before the close is built from a pool
  -- smaller than the one the event ends up holding.
  IF NOT COALESCE(v_t.prize_pool_finalized, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'entry_still_open');
  END IF;

  IF p_chests IS NULL OR jsonb_typeof(p_chests) <> 'array' OR jsonb_array_length(p_chests) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'chests_required');
  END IF;
  IF jsonb_array_length(p_chests) <> GREATEST(p_players_remaining - 1, 0) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'chest_count_mismatch',
      'chests', jsonb_array_length(p_chests), 'players_remaining', p_players_remaining);
  END IF;

  v_bounty_cents := round(COALESCE(v_t.bounty_pool, 0) * 100)::bigint;
  v_m := GREATEST(0, COALESCE(v_t.mystery_bounty_pool_percent, 50));
  v_r := GREATEST(0, COALESCE(v_t.mystery_bounty_regular_pool_percent, 50));
  IF v_m + v_r <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pool_split_misconfigured');
  END IF;
  v_pool_cents := floor(v_bounty_cents * v_m / (v_m + v_r))::bigint;

  IF v_pool_cents > v_bounty_cents - round(COALESCE(v_t.bounty_pool_paid, 0) * 100)::bigint THEN
    v_pool_cents := GREATEST(0, v_bounty_cents - round(COALESCE(v_t.bounty_pool_paid, 0) * 100)::bigint);
  END IF;

  -- A head earned before this moment but not yet recorded is owed from the
  -- regular half. Keep it out of the sealed chests or it is paid twice.
  v_unrecorded_cents := public.fn_mystery_bounty_unrecorded_head_cents(p_tournament_id);
  IF v_pool_cents > v_bounty_cents - round(COALESCE(v_t.bounty_pool_paid, 0) * 100)::bigint
                    - v_unrecorded_cents THEN
    v_pool_cents := GREATEST(0, v_bounty_cents
                    - round(COALESCE(v_t.bounty_pool_paid, 0) * 100)::bigint
                    - v_unrecorded_cents);
  END IF;

  -- DIAMOND PHASE 9: the mystery half is floored to the event's unit (a
  -- cent for a chip event, so unchanged; a whole Diamond for a Diamond
  -- event), exactly as the engine floors the inventory it builds.
  v_pool_cents := public.fn_ca_unit_floor_cents(v_pool_cents, public.fn_ca_tournament_unit_cents(p_tournament_id));
  IF v_pool_cents <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'empty_pool');
  END IF;

  SELECT COALESCE(sum((c->>'amount_cents')::bigint), 0) INTO v_sum
    FROM jsonb_array_elements(p_chests) c;

  IF v_sum <> v_pool_cents THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'inventory_mismatch',
      'inventory_cents', v_sum, 'pool_cents', v_pool_cents,
      'unrecorded_head_cents', v_unrecorded_cents);
  END IF;

  -- DIAMOND PHASE 9: every chest is a whole number of the event's units.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_chests) c
              WHERE (c->>'amount_cents')::bigint % public.fn_ca_tournament_unit_cents(p_tournament_id) <> 0) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'chest_not_on_unit',
      'unit_cents', public.fn_ca_tournament_unit_cents(p_tournament_id));
  END IF;
  INSERT INTO public.tournament_bounty_chests (tournament_id, seq, tier, amount_cents)
  SELECT p_tournament_id,
         COALESCE((c->>'seq')::int, ord::int),
         c->>'tier',
         (c->>'amount_cents')::bigint
    FROM jsonb_array_elements(p_chests) WITH ORDINALITY AS t(c, ord)
  ON CONFLICT (tournament_id, seq) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> jsonb_array_length(p_chests) THEN
    RAISE EXCEPTION 'mystery bounty seed inserted % of % chests', v_count, jsonb_array_length(p_chests);
  END IF;

  UPDATE public.tournaments
     SET mystery_bounty_stage = 'active',
         mystery_bounty_activated_at = clock_timestamp(),
         mystery_bounty_activated_players = p_players_remaining,
         mystery_bounty_pool_cents = v_pool_cents
   WHERE id = p_tournament_id;

  RETURN jsonb_build_object('ok', true, 'already_seeded', false,
    'pool_cents', v_pool_cents, 'chests', v_count, 'stage', 'active');
END;
$function$
