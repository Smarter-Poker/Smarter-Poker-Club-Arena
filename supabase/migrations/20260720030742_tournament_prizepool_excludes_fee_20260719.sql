-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260720030742 "tournament_prizepool_excludes_fee_20260719"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8c1a134632cd0bdc243651b48c0894e2 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- FIX-B5 2026-07-19 — prize pool NEVER includes rake/house fee (Dan's rule).
-- Player pays buy_in_amount + buy_in_fee; prize_pool gets buy_in_amount only;
-- fee accrues to tournaments.total_rake. Also persist per-entry buy-in/fee so
-- refunds (previously reading a NON-EXISTENT reg.buy_in_amount → refund 0 / 500)
-- return the exact charged total on cancellation.

-- 1. Per-entry accounting columns + backfill from the tournament config.
ALTER TABLE public.tournament_registrations
  ADD COLUMN IF NOT EXISTS buy_in_amount numeric,
  ADD COLUMN IF NOT EXISTS buy_in_fee    numeric;

UPDATE public.tournament_registrations r
   SET buy_in_amount = COALESCE(r.buy_in_amount, t.buy_in_amount),
       buy_in_fee    = COALESCE(r.buy_in_fee, t.buy_in_fee)
  FROM public.tournaments t
 WHERE r.tournament_id = t.id
   AND (r.buy_in_amount IS NULL OR r.buy_in_fee IS NULL);

-- 2. Atomic register: pool excludes fee; fee -> total_rake; store per-entry.
CREATE OR REPLACE FUNCTION public.fn_tournament_atomic_register(
  p_user_id uuid, p_club_id uuid, p_tournament_id uuid, p_buy_in numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_tourn        record;
  v_balance      numeric;
  v_existing     uuid;
  v_display_name text;
  v_reg_id       uuid;
  v_count        integer;
  v_buy_in       numeric;
  v_fee          numeric;
  v_total        numeric;
BEGIN
  SELECT * INTO v_tourn FROM tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF v_tourn.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Tournament not found');
  END IF;

  IF v_tourn.status NOT IN ('scheduled', 'registering', 'running') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Registration not open');
  END IF;

  IF v_tourn.max_players IS NOT NULL AND COALESCE(v_tourn.current_players, 0) >= v_tourn.max_players THEN
    RETURN jsonb_build_object('success', false, 'error', 'Tournament full');
  END IF;

  SELECT id INTO v_existing FROM tournament_registrations
    WHERE tournament_id = p_tournament_id AND user_id = p_user_id AND status = 'registered';
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Already registered');
  END IF;

  -- Authoritative buy-in / fee come from the LOCKED tournament config, not the
  -- client-passed p_buy_in (defense in depth). Prize pool NEVER includes fee.
  v_buy_in := COALESCE(v_tourn.buy_in_amount, p_buy_in, 0);
  v_fee    := COALESCE(v_tourn.buy_in_fee, 0);
  v_total  := v_buy_in + v_fee;

  SELECT COALESCE(chip_balance, 0) INTO v_balance
    FROM club_memberships WHERE club_id = p_club_id AND user_id = p_user_id FOR UPDATE;
  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not a member of this club');
  END IF;

  IF v_balance < v_total THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient chips',
                              'balance', v_balance, 'required', v_total);
  END IF;

  -- Debit the FULL charge (buy-in + fee).
  UPDATE club_memberships
     SET chip_balance = chip_balance - v_total::integer, updated_at = NOW()
   WHERE club_id = p_club_id AND user_id = p_user_id;

  SELECT COALESCE(display_name, username, 'Player') INTO v_display_name
    FROM profiles WHERE id = p_user_id;

  INSERT INTO tournament_registrations (
    id, tournament_id, user_id, status, registered_at, display_name,
    buy_in_amount, buy_in_fee
  ) VALUES (
    gen_random_uuid(), p_tournament_id, p_user_id, 'registered', NOW(),
    COALESCE(v_display_name, 'Player'), v_buy_in, v_fee
  ) RETURNING id INTO v_reg_id;

  -- Prize pool gets the buy-in ONLY (excludes fee); fee accrues to total_rake.
  UPDATE tournaments
     SET current_players = COALESCE(current_players, 0) + 1,
         prize_pool      = COALESCE(prize_pool, 0) + v_buy_in,
         total_rake      = COALESCE(total_rake, 0) + v_fee,
         updated_at      = NOW()
   WHERE id = p_tournament_id
   RETURNING COALESCE(current_players, 0) INTO v_count;

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, p_user_id, NULL, v_total,
    'tournament_buyin',
    'Tournament buy-in: ' || p_tournament_id::text || ' (buyin ' || v_buy_in || ' + fee ' || v_fee || ')',
    v_balance - v_total, NOW()
  );

  RETURN jsonb_build_object(
    'success', true, 'registration_id', v_reg_id, 'registered_count', v_count,
    'buy_in', v_buy_in, 'fee', v_fee, 'total_charged', v_total,
    'balance_after', v_balance - v_total
  );
END;
$function$;
