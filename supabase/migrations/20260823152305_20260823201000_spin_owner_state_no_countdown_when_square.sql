-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260823152305 "20260823201000_spin_owner_state_no_countdown_when_square"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1a4e73b9d33568802dfd8a60ed36e8a4 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- seed_repayable_in is "how much further the balance must climb before the next
-- instalment is due". With nothing owed there is no next instalment, so counting
-- down toward one is a countdown to an event that will never happen -- the owner
-- menu would show "180 to go" forever on a pool that is already square.
--
-- Found by a probe assertion that was itself wrong: it expected repay_floor to
-- fall to 0 once the seed was retired. It does not, and should not -- the floor
-- is a property of the BOARD (what it must always be able to pay), not of the
-- loan. The underlying required_seed_at_activation column IS cleared; the state
-- function correctly falls back to the live floor for display.
CREATE OR REPLACE FUNCTION public.fn_spin_owner_state(p_club_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE v_owner uuid; v_r public.spin_bonus_pools%ROWTYPE; v_required numeric; v_floor numeric;
BEGIN
  v_owner := public.fn_spin_reserve_owner(p_club_id);
  SELECT * INTO v_r FROM public.spin_bonus_pools WHERE club_id = v_owner;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'owner_id', v_owner,
      'owner_kind', public.fn_spin_owner_kind(v_owner),
      'is_active', false, 'balance', 0, 'offered_max_stake', 0,
      'required_seed', 0, 'seeded_amount', 0, 'seed_returned_amount', 0,
      'seed_repayable_in', 0, 'collected_from_play', 0, 'total_drawn', 0,
      'spin_count', 0, 'bonus_count', 0, 'seed_is_repayable', true,
      'repay_floor', 0, 'repay_trigger_at', 0, 'next_instalment', 0);
  END IF;

  v_required := CASE
    WHEN v_r.seeded_amount > 0 AND v_r.required_seed_at_activation > 0
      THEN v_r.required_seed_at_activation
    ELSE public.fn_spin_required_seed(v_r.offered_max_stake)
  END;
  -- The floor is the board's, not the loan's: it is what the pool must always
  -- hold to pay its biggest advertised prize, whether or not anything is owed.
  v_floor := COALESCE(NULLIF(v_r.required_seed_at_activation, 0), v_required);

  RETURN jsonb_build_object(
    'ok', true, 'owner_id', v_owner, 'owner_kind', v_r.owner_kind,
    'is_active', v_r.is_active AND v_r.activated_at IS NOT NULL,
    'activated_at', v_r.activated_at, 'balance', v_r.balance,
    'offered_max_stake', v_r.offered_max_stake, 'required_seed', v_required,
    'seeded_amount', v_r.seeded_amount, 'seed_source_wallet', v_r.seed_source_wallet,
    'seed_returned_amount', v_r.seed_returned_amount,
    'seed_returned_at', v_r.seed_returned_at,
    'seed_repayable_in', CASE WHEN v_r.seeded_amount > 0
                              THEN GREATEST(round(v_floor * 1.25, 2) - v_r.balance, 0)
                              ELSE 0 END,
    'seed_is_repayable', (v_r.seeded_amount = 0 OR v_r.seed_source_wallet IS NOT NULL),
    'repay_floor', v_floor,
    'repay_trigger_at', round(v_floor * 1.25, 2),
    'next_instalment', public.fn_spin_seed_instalment(v_r.balance, v_r.seeded_amount, v_floor),
    'collected_from_play', v_r.total_deposited, 'total_drawn', v_r.total_drawn,
    'spin_count', v_r.spin_count, 'bonus_count', v_r.bonus_count);
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.fn_spin_owner_state(uuid) TO authenticated;

DO $assert$
BEGIN
  IF NOT (SELECT pg_get_functiondef(oid) ILIKE '%CASE WHEN v_r.seeded_amount > 0%'
            FROM pg_proc WHERE proname='fn_spin_owner_state') THEN
    RAISE EXCEPTION 'owner state still counts down with nothing owed';
  END IF;
END $assert$;
