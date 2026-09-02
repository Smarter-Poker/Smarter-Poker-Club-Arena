-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830213636; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Give back the chips that closing a cash table destroyed.
-- (v1 aborted atomically on a column name: the function returns exit_id, not id.)
--
-- fn_on_table_status_change released a cash table's seats without cashing
-- anyone out, so every stack still on the felt stopped existing. Fixed earlier
-- today (20260830_wire_cashout_into_table_close_paths). This is the restitution
-- for what it already took: 1,036 exits, 319 players, 432,100.90 chips, all on
-- 2026-08-30 between 09:22 and 19:00.
--
-- EVERY PLAYER, NOT EVERY HUMAN. Exactly one of the 1,036 exits belongs to a
-- human; the other 1,035 are horses. Paying the human and not the horses would
-- be the `is_horse` branch the HORSES ARE PLAYERS law exists to forbid — a
-- horse "IS PAID everything a human is paid ... refunds, shortfall back-pay".
-- So this pays all of them, and there is no is_horse anywhere below.
--
-- IDEMPOTENT BY THE DETECTOR'S OWN RULE. fn_unaccounted_seat_exits already
-- treats a credit described 'Correction: seat exit {exit_id}%' as settling that
-- exit. Using that exact format means re-running pays nobody twice — the second
-- pass no longer sees those exits — and the leak report returns to zero on its
-- own rather than needing a suppression list.
--
-- Chips return to the club the SEAT belonged to, the same rule as
-- atomic_table_cashout and the new close-time cash-out.

DO $$
DECLARE
  v_exit    record;
  v_club    uuid;
  v_bal     numeric;
  v_count   int := 0;
  v_total   numeric := 0;
  v_expect  int;
  v_expectc numeric;
  v_left    int;
BEGIN
  SELECT count(*), coalesce(sum(stack),0) INTO v_expect, v_expectc
    FROM public.fn_unaccounted_seat_exits(interval '30 days', interval '2 minutes');

  IF v_expect = 0 THEN
    RAISE NOTICE 'Nothing unaccounted — already repaid.';
    RETURN;
  END IF;

  IF v_expect > 2000 THEN
    RAISE EXCEPTION 'Expected ~1036 unaccounted exits, found % — refusing to bulk-pay an unexpected set', v_expect;
  END IF;

  FOR v_exit IN
    SELECT exit_id, user_id, table_id, club_id, stack, occurred_at
      FROM public.fn_unaccounted_seat_exits(interval '30 days', interval '2 minutes')
  LOOP
    v_club := v_exit.club_id;
    IF v_club IS NULL THEN
      v_club := public.fn_player_home_club(v_exit.user_id, NULL);
    END IF;
    IF v_club IS NULL THEN
      RAISE EXCEPTION 'No club wallet resolves for player % (exit %) — refusing to strand the repayment',
        v_exit.user_id, v_exit.exit_id;
    END IF;

    PERFORM public.fn_ensure_club_wallet(v_exit.user_id, v_club);

    /* Name it so chip_ledger records a cashout rather than an anonymous
       adjustment (see 20260830_label_prize_credits_v2). */
    PERFORM set_config('app.ledger_category', 'cashout', true);

    UPDATE public.club_members
       SET chip_balance = COALESCE(chip_balance, 0) + v_exit.stack,
           updated_at   = NOW()
     WHERE user_id = v_exit.user_id AND club_id = v_club
     RETURNING chip_balance INTO v_bal;

    PERFORM set_config('app.ledger_category', '', true);

    IF v_bal IS NULL THEN
      RAISE EXCEPTION 'Wallet row missing for player % in club % after ensure', v_exit.user_id, v_club;
    END IF;

    INSERT INTO public.wallet_transactions
      (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
    VALUES (v_exit.user_id, 'PLAYER', 'credit', v_exit.stack, 'cashout',
            'Correction: seat exit ' || v_exit.exit_id
              || ' — stack lost when the table closed without a cash-out',
            v_exit.table_id, v_bal);

    v_count := v_count + 1;
    v_total := v_total + v_exit.stack;
  END LOOP;

  IF v_count <> v_expect THEN
    RAISE EXCEPTION 'Paid % of % exits', v_count, v_expect;
  END IF;
  IF round(v_total,2) <> round(v_expectc,2) THEN
    RAISE EXCEPTION 'Paid % but owed %', v_total, v_expectc;
  END IF;

  IF EXISTS (SELECT 1 FROM public.club_members WHERE chip_balance < 0) THEN
    RAISE EXCEPTION 'A wallet is negative after repayment';
  END IF;

  SELECT count(*) INTO v_left
    FROM public.fn_unaccounted_seat_exits(interval '30 days', interval '2 minutes');
  IF v_left <> 0 THEN
    RAISE EXCEPTION '% exits still unaccounted after repayment', v_left;
  END IF;

  RAISE NOTICE 'Repaid % exits totalling % chips to their club wallets.', v_count, v_total;
END $$;
