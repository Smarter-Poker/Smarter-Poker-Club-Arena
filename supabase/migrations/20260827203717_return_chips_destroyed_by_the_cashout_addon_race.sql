-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827203717; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- The 205.68 chips the cash-out/add-on race destroyed. Debited from real club
-- wallets, landed nowhere. The description format is the one
-- fn_unaccounted_seat_exits already excludes ('Correction: seat exit <id>%'),
-- so a returned exit stops being reported -- that mechanism was built for this.
DO $$
DECLARE r record; v_club uuid; v_bal numeric; v_n integer := 0;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      (21541, '032b7ef6-ef40-4eb7-9a44-21605be733c8'::uuid, 137.10::numeric),
      (15448, 'e7925474-ad31-4cfb-826b-010039bcff3d'::uuid,  42.68::numeric),
      ( 7458, 'a916c222-1eb9-4e73-89ee-a92e289b80eb'::uuid,  25.90::numeric)
    ) AS t(exit_id, user_id, amount)
  LOOP
    IF EXISTS (SELECT 1 FROM wallet_transactions
                WHERE user_id = r.user_id
                  AND description LIKE 'Correction: seat exit ' || r.exit_id || '%')
    THEN CONTINUE; END IF;

    SELECT club_id INTO v_club FROM ca_seat_stack_exits WHERE id = r.exit_id;
    IF v_club IS NULL THEN
      v_club := public.fn_player_home_club(r.user_id, NULL);
    END IF;
    IF v_club IS NULL THEN CONTINUE; END IF;

    PERFORM public.fn_ensure_club_wallet(r.user_id, v_club);
    UPDATE club_members
       SET chip_balance = COALESCE(chip_balance,0) + r.amount, updated_at = now()
     WHERE user_id = r.user_id AND club_id = v_club
     RETURNING chip_balance INTO v_bal;

    INSERT INTO wallet_transactions
      (user_id, wallet_type, type, amount, category, description, balance_after)
    VALUES (r.user_id, 'PLAYER', 'credit', r.amount, 'cashout',
            'Correction: seat exit ' || r.exit_id || ' add-on lost to the cash-out race',
            v_bal);
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE 'restitution: % exits corrected', v_n;
END $$;

-- Assertion: all three are now accounted for.
DO $$
DECLARE v_missing integer;
BEGIN
  SELECT count(*) INTO v_missing FROM (VALUES (21541),(15448),(7458)) AS t(id)
   WHERE NOT EXISTS (
     SELECT 1 FROM wallet_transactions
      WHERE description LIKE 'Correction: seat exit ' || t.id || '%');
  IF v_missing > 0 THEN
    RAISE EXCEPTION '% of 3 destroyed exits were not returned', v_missing;
  END IF;
END $$;
