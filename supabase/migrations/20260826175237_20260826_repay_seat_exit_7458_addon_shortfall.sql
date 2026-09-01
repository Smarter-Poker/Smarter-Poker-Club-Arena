-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826175237; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

DO $$
DECLARE
  v_user  uuid := 'a916c222-1eb9-4e73-89ee-a92e289b80eb';
  v_club  uuid := 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
  v_table uuid := '06a161fe-caa0-4c22-999a-44c0cae13fc9';
  v_amt   numeric := 25.90;
  v_desc  text := 'Correction: seat exit 7458 add-on shortfall (25.90)';
  v_before numeric;
  v_after  numeric;
BEGIN
  IF EXISTS (SELECT 1 FROM public.wallet_transactions WHERE description = v_desc) THEN
    RAISE NOTICE 'seat exit 7458 already repaid; nothing to do';
    RETURN;
  END IF;

  SELECT chip_balance INTO v_before
    FROM public.club_members WHERE user_id = v_user AND club_id = v_club;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'no club_members row for user % in club % -- refusing to guess a destination', v_user, v_club;
  END IF;

  PERFORM public.fn_add_chips(v_user, v_club, v_amt);

  PERFORM public.log_wallet_transaction(
    v_user, 'PLAYER', v_amt, 'credit', 'refund', v_desc, v_table, NULL, NULL);

  SELECT chip_balance INTO v_after
    FROM public.club_members WHERE user_id = v_user AND club_id = v_club;

  IF v_after - v_before <> v_amt THEN
    RAISE EXCEPTION 'balance moved by %, expected % -- rolling back', v_after - v_before, v_amt;
  END IF;

  RAISE NOTICE 'repaid % to user % (% -> %)', v_amt, v_user, v_before, v_after;
END $$;

DO $$
DECLARE v_left int;
BEGIN
  SELECT count(*) INTO v_left FROM public.fn_unaccounted_seat_exits('7 days','10 minutes');
  IF v_left <> 0 THEN
    RAISE WARNING 'fn_unaccounted_seat_exits still reports % unaccounted exit(s) -- investigate', v_left;
  ELSE
    RAISE NOTICE 'fn_unaccounted_seat_exits is clean';
  END IF;
END $$;
