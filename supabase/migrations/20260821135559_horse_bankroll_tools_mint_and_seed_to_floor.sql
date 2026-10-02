-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821135559 "horse_bankroll_tools_mint_and_seed_to_floor"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 edba24f0efe0571a5e92cadb689aeab1 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Dan 2026-08-21: "FUND ALL HORSES, ADD MORE CHIPS, THIS IS ALL BETA TESTING
-- ANYWAYS."
--
-- Two reusable functions rather than another one-off UPDATE, because horses
-- keep being seeded unfunded and this is the third time in one night that a
-- roster has needed topping up. Beta or not, chips get a provenance row: the
-- moment this platform is not beta, an untraceable balance is a liability, and
-- a mint that was never recorded cannot be unwound.
--
--   fn_mint_club_chips(club, amount, reason)
--       Adds chips to a club treasury and writes a treasury_mint ledger row.
--       This is the ONLY place in the codebase that creates chips from nothing.
--
--   fn_seed_horses_to_floor(club, floor)
--       Tops every horse in the club UP TO the floor. Never reduces a horse
--       that is already above it. Debits the treasury by exactly the sum
--       credited, writes a horse_treasury_funding row per horse, and refuses to
--       run at all if the treasury cannot cover the whole batch — a partial
--       seeding that silently funds the first 200 horses is worse than none.

CREATE OR REPLACE FUNCTION public.fn_mint_club_chips(
    p_club_id uuid,
    p_amount  numeric,
    p_reason  text DEFAULT 'beta top-up'
) RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_after numeric;
BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'mint amount must be positive, got %', p_amount;
    END IF;

    UPDATE public.clubs
       SET chip_treasury = coalesce(chip_treasury, 0) + p_amount
     WHERE id = p_club_id
    RETURNING chip_treasury INTO v_after;

    IF v_after IS NULL THEN
        RAISE EXCEPTION 'mint failed: club % not found', p_club_id;
    END IF;

    INSERT INTO public.chip_transactions
        (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after)
    VALUES (p_club_id, NULL, NULL, p_amount, 'treasury_mint', p_reason, v_after);

    RETURN v_after;
END;
$function$;

COMMENT ON FUNCTION public.fn_mint_club_chips(uuid, numeric, text) IS
    'Creates chips into a club treasury and records a treasury_mint row. The only sanctioned mint path.';

CREATE OR REPLACE FUNCTION public.fn_seed_horses_to_floor(
    p_club_id uuid,
    p_floor   numeric
) RETURNS TABLE(horses_funded integer, chips_moved numeric, treasury_after numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_needed  numeric;
    v_count   integer;
    v_before  numeric;
    v_after   numeric;
BEGIN
    IF p_floor IS NULL OR p_floor <= 0 THEN
        RAISE EXCEPTION 'floor must be positive, got %', p_floor;
    END IF;

    SELECT coalesce(chip_treasury, 0) INTO v_before FROM public.clubs WHERE id = p_club_id;
    IF v_before IS NULL THEN
        RAISE EXCEPTION 'club % not found', p_club_id;
    END IF;

    SELECT count(*), coalesce(sum(p_floor - cm.chip_balance), 0)
      INTO v_count, v_needed
      FROM public.club_members cm
      JOIN public.profiles p ON p.id = cm.user_id
     WHERE cm.club_id = p_club_id AND p.is_horse AND cm.chip_balance < p_floor;

    IF v_count = 0 THEN
        RETURN QUERY SELECT 0, 0::numeric, v_before;
        RETURN;
    END IF;

    -- All or nothing. A half-seeded roster is harder to reason about than an
    -- unseeded one, and the caller can always mint first and retry.
    IF v_before < v_needed THEN
        RAISE EXCEPTION 'treasury % cannot cover % for % horses (floor %) — mint first',
              v_before, v_needed, v_count, p_floor;
    END IF;

    INSERT INTO public.chip_transactions
        (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after)
    SELECT p_club_id, NULL, cm.user_id, p_floor - cm.chip_balance, 'horse_treasury_funding',
           'Topped up to the club bankroll floor so the horse can buy into any table',
           p_floor
      FROM public.club_members cm
      JOIN public.profiles p ON p.id = cm.user_id
     WHERE cm.club_id = p_club_id AND p.is_horse AND cm.chip_balance < p_floor;

    UPDATE public.club_members cm
       SET chip_balance = p_floor
      FROM public.profiles p
     WHERE p.id = cm.user_id
       AND cm.club_id = p_club_id AND p.is_horse AND cm.chip_balance < p_floor;

    UPDATE public.clubs SET chip_treasury = chip_treasury - v_needed WHERE id = p_club_id
    RETURNING chip_treasury INTO v_after;

    IF v_after < 0 THEN
        RAISE EXCEPTION 'post-apply failed: treasury went negative (%)', v_after;
    END IF;
    IF (v_before - v_after) <> v_needed THEN
        RAISE EXCEPTION 'post-apply failed: conservation broken — treasury moved %, credited %',
              (v_before - v_after), v_needed;
    END IF;

    RETURN QUERY SELECT v_count, v_needed, v_after;
END;
$function$;

COMMENT ON FUNCTION public.fn_seed_horses_to_floor(uuid, numeric) IS
    'Tops every horse in a club up to a bankroll floor, moving chips from the club treasury. Never reduces a horse already above the floor. Refuses to run if the treasury cannot cover the whole batch.';
