-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827213458; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Seat exit 21812: 58.58 chips, 2026-08-27 21:02:59Z, cash table, no cash-out
-- credit of any size near it. It occurred at 21:02:59, and the engine restart
-- with the cash-out lock fix landed at 21:06 (visible as a hand-rate dip from
-- ~75/min to 24 in hand_history). So this is a casualty of the OLD code, and
-- NOT the add-on race: there is no add-on debit near it, so the amount was not
-- split - the whole stack went uncredited. That is the failure mode the old
-- three-transaction path had whenever it threw between reading the stack and
-- crediting it.
--
-- Since the restart there have been zero uncredited cash exits, which is what
-- the fix was for. This returns the last of the money the old path owed.
DO $$
DECLARE v_club uuid; v_bal numeric;
  c_exit  constant bigint := 21812;
  c_user  constant uuid   := '3fe15f75-ba2d-4d29-9869-4ea6f2bff168';
  c_amt   constant numeric:= 58.58;
BEGIN
  IF EXISTS (SELECT 1 FROM wallet_transactions
              WHERE user_id = c_user
                AND description LIKE 'Correction: seat exit ' || c_exit || '%') THEN
    RAISE NOTICE 'exit % already corrected - nothing to do', c_exit;
    RETURN;
  END IF;

  SELECT club_id INTO v_club FROM ca_seat_stack_exits WHERE id = c_exit;
  IF v_club IS NULL THEN v_club := public.fn_player_home_club(c_user, NULL); END IF;
  IF v_club IS NULL THEN
    RAISE EXCEPTION 'no club wallet resolves for player % - not paying blind', c_user;
  END IF;

  PERFORM public.fn_ensure_club_wallet(c_user, v_club);
  UPDATE club_members
     SET chip_balance = COALESCE(chip_balance,0) + c_amt, updated_at = now()
   WHERE user_id = c_user AND club_id = v_club
   RETURNING chip_balance INTO v_bal;

  INSERT INTO wallet_transactions
    (user_id, wallet_type, type, amount, category, description, balance_after)
  VALUES (c_user, 'PLAYER', 'credit', c_amt, 'cashout',
          'Correction: seat exit ' || c_exit || ' uncredited stack (pre-lock-fix engine)',
          v_bal);
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM wallet_transactions
                  WHERE description LIKE 'Correction: seat exit 21812%') THEN
    RAISE EXCEPTION 'exit 21812 was not returned';
  END IF;
  IF (SELECT count(*) FROM fn_unaccounted_seat_exits()) <> 0 THEN
    RAISE EXCEPTION 'unaccounted seat exits remain after restitution';
  END IF;
END $$;
