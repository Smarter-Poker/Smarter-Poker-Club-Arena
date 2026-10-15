-- Root fix plus the Lightning pilot top-up, in one transaction. Supersedes the
-- unapplied 20261015053941, which the ledger guard refused on apply.
--
-- DEFECT, MEASURED (2026-10-15 09:31 UTC). Applying 20261015053941 (top every
-- Lightning pilot horse up to 200 chips) was refused by
-- fn_ca_balance_has_its_ledger_row: treasury delta -11716.40, ledger net
-- -11717.40. fn_seed_horses_to_floor reads the shortfall to debit from the
-- treasury in one statement and writes each horse's leg from a later statement,
-- with no lock between them. The pilot's horses were playing club Spins, so a
-- wallet moved between the two reads and the two halves disagreed by 1.00.
-- The guard did its job and nothing moved.
--
-- FIX. The function now locks the club row and every horse wallet it reads, in
-- a stable order, before its first read, so both halves come from one
-- snapshot. Nothing else in the body changes: same floor rule, same
-- all-or-nothing refusal, same declared horse_funding leg per horse, same
-- conservation assertions, owner, definer, search path and service-only grant.
--
-- THEN, within Dan's 2026-10-14/15 approvals ("top up the 72 pilot horses to 200
-- chips each from the pilot treasury, about 11,534 chips"), the top-up runs
-- through the fixed function and the apply asserts conservation, every pilot
-- horse at or above 200, exactly 72 horses, no other human, a bound on the
-- amount, and no Lightning state change.
-- @live-proof: position('FOR UPDATE OF cm' in pg_get_functiondef('public.fn_seed_horses_to_floor(uuid,numeric)'::regprocedure)) > 0 AND EXISTS (SELECT 1 FROM public.chip_transactions WHERE club_id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d' AND transaction_type = 'horse_treasury_funding' AND balance_after = 200)

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '90s';

DO $guard$
BEGIN
  IF md5(pg_get_functiondef('public.fn_seed_horses_to_floor(uuid,numeric)'::regprocedure))
     IS DISTINCT FROM 'ff30b2db690ab947eb94928a3b935d63' THEN
    RAISE EXCEPTION 'fn_seed_horses_to_floor is not the installed preimage; refusing';
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.fn_seed_horses_to_floor(p_club_id uuid, p_floor numeric)
 RETURNS TABLE(horses_funded integer, chips_moved numeric, treasury_after numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_needed  numeric;
    v_count   integer;
    v_before  numeric;
    v_after   numeric;
    v_saved   jsonb;
BEGIN
    IF p_floor IS NULL OR p_floor <= 0 THEN
        RAISE EXCEPTION 'floor must be positive, got %', p_floor;
    END IF;

    -- ONE SNAPSHOT (2026-10-15). Lock the club, then every horse wallet this
    -- call reads, before the first read. Without these the treasury debit
    -- (summed from one read) and the per-horse legs (written from later reads)
    -- can disagree whenever a wallet moves in between - a Spin buy-in, a
    -- payout - and the ledger guard refuses the whole transaction
    -- (balance_moved_without_its_ledger_row, measured on the Lightning pilot:
    -- treasury delta -11716.40, ledger net -11717.40).
    PERFORM 1 FROM public.clubs WHERE id = p_club_id FOR UPDATE;
    PERFORM 1 FROM public.club_members cm JOIN public.profiles p ON p.id = cm.user_id
     WHERE cm.club_id = p_club_id AND p.is_horse
     ORDER BY cm.user_id
       FOR UPDATE OF cm;

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
        RAISE EXCEPTION 'treasury % cannot cover % for % horses (floor %) - mint first',
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

    /* THE TREASURY FUNDS THE HORSE, BY NAME (2026-10-02, 20261002140203).
       Each horse's leg is club treasury -> its wallet, exactly the leg a
       human funded from the same treasury gets; the treasury debit below is
       the other side of those legs, so its own journal stands down. */
    v_saved := public.fn_ca_ledger_declaration_save(ARRAY['clubs']);
    PERFORM public.fn_ca_declare_ledger('horse_funding', 'club_treasury', p_club_id,
                                        NULL, NULL, ARRAY['clubs']);

    UPDATE public.club_members cm
       SET chip_balance = p_floor
      FROM public.profiles p
     WHERE p.id = cm.user_id
       AND cm.club_id = p_club_id AND p.is_horse AND cm.chip_balance < p_floor;

    UPDATE public.clubs SET chip_treasury = chip_treasury - v_needed WHERE id = p_club_id
    RETURNING chip_treasury INTO v_after;

    PERFORM public.fn_ca_ledger_declaration_restore(v_saved);

    IF v_after < 0 THEN
        RAISE EXCEPTION 'post-apply failed: treasury went negative (%)', v_after;
    END IF;
    IF (v_before - v_after) <> v_needed THEN
        RAISE EXCEPTION 'post-apply failed: conservation broken - treasury moved %, credited %',
              (v_before - v_after), v_needed;
    END IF;

    RETURN QUERY SELECT v_count, v_needed, v_after;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_seed_horses_to_floor(uuid, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_seed_horses_to_floor(uuid, numeric) TO service_role;

DO $fund$
DECLARE r record; v_before numeric; v_after numeric; v_short int; v_others int;
BEGIN
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_seed_horses_to_floor(uuid,numeric)'::regprocedure)
     IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'fn_seed_horses_to_floor grant changed';
  END IF;
  SELECT count(*) INTO v_others
    FROM public.club_members m LEFT JOIN public.profiles p ON p.id = m.user_id
   WHERE m.club_id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d'
     AND NOT COALESCE(p.is_horse, false)
     AND m.user_id <> '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
  IF v_others <> 0 THEN
    RAISE EXCEPTION 'the pilot holds % non-owner humans; refusing to fund', v_others;
  END IF;

  SELECT chip_treasury INTO v_before FROM public.clubs WHERE id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d' FOR UPDATE;
  SELECT * INTO r FROM public.fn_seed_horses_to_floor('e14bc9f7-736d-425f-8f2c-e78305ebac1d', 200);
  SELECT chip_treasury INTO v_after FROM public.clubs WHERE id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d';

  IF r.horses_funded > 72 OR r.chips_moved > 72 * 200 OR r.chips_moved <= 0 THEN
    RAISE EXCEPTION 'pilot top-up out of bounds: % horses, % chips', r.horses_funded, r.chips_moved;
  END IF;
  IF v_before - v_after <> r.chips_moved OR r.treasury_after <> v_after THEN
    RAISE EXCEPTION 'conservation broken: treasury % -> %, moved %', v_before, v_after, r.chips_moved;
  END IF;
  SELECT count(*) INTO v_short
    FROM public.club_members m JOIN public.profiles p ON p.id = m.user_id
   WHERE m.club_id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d' AND p.is_horse AND m.chip_balance < 200;
  IF v_short <> 0 THEN
    RAISE EXCEPTION '% pilot horses remain under the 200 floor', v_short;
  END IF;
  IF (SELECT count(*) FROM public.club_members m JOIN public.profiles p ON p.id = m.user_id
       WHERE m.club_id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d' AND p.is_horse) <> 72 THEN
    RAISE EXCEPTION 'the pilot no longer holds exactly 72 horses';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cash_games
              WHERE club_id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d'
                AND name LIKE 'Lightning Pilot%'
                AND (lightning_enabled OR cluster_mode <> 'must_move')) THEN
    RAISE EXCEPTION 'a pilot game changed Lightning state; this migration must not activate anything';
  END IF;
  IF position('FOR UPDATE OF cm' in pg_get_functiondef('public.fn_seed_horses_to_floor(uuid,numeric)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'fn_seed_horses_to_floor did not take its wallet lock';
  END IF;
END $fund$;

COMMIT;
