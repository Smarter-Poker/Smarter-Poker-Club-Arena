-- =====================================================================
-- THE NEGATIVE CLUB TREASURY WAS MISBANKED GUARANTEE OVERLAYS
-- =====================================================================
-- Applied to production 2026-08-30 20:46 UTC via Supabase apply_migration.
--
-- Club "Midway Union" held chip_treasury = -7,161.10, and the nightly
-- reconciler logged it growing: 1,202.80 (Aug 27) -> 4,846.10 (Aug 28) ->
-- 7,161.10 (Aug 29).
--
-- CAUSE. `fn_apply_prize_guarantee` funds the overlay on an advertised
-- guarantee from the UNION wallet when the club belongs to a union, falling
-- back to the club treasury only when the union has no wallet row. For three
-- days it wrote overlays with `bank_type` NULL and debited the club instead:
--
--   bank_type   Aug 27   Aug 28   Aug 29   Aug 30
--   (null)      27 rows  12 rows   1 row    0 rows     total 7,161.10
--   union       13 rows   0 rows  30 rows  53 rows     healthy
--
-- The NULL-bank total is EXACTLY the negative balance, and exactly one club is
-- affected. Since Aug 30 every overlay banks to the union, so the writer is
-- already fixed - this is residual damage, not a live leak.
--
-- NO TREASURY FLOOR IS ADDED, deliberately. Funding an advertised guarantee
-- into the negative is intended behaviour: the function raises a
-- `financial_alerts` critical rather than refusing, because a room does not
-- welch on a posted guarantee. Its own note says the dip should reverse at the
-- weekly close - which is currently frozen (see the GLOBAL_SETTLEMENT_FREEZE
-- set 2026-08-26 for the profit-drift investigation), and that freeze is left
-- untouched.
--
-- REPAIR. Move 7,161.10 from the union wallet to the club treasury, where these
-- overlays should have been banked. Chip-neutral: the sum of the two balances
-- is unchanged, asserted before and after. Both sides get an audit row, and the
-- 40 overlay rows are stamped bank_type='union' so the repair is idempotent.
--
-- ROLLBACK:
--   UPDATE clubs SET chip_treasury = chip_treasury - 7161.10
--    WHERE id = 'fade0000-0000-0000-0000-000000000001';
--   UPDATE union_wallets SET chip_balance = chip_balance + 7161.10
--    WHERE union_id = 'fade0000-0000-0000-0000-000000000001';
-- =====================================================================

DO $$
DECLARE
    v_club uuid; v_union uuid; v_amount numeric; v_rows int; v_clubs int;
    v_treasury numeric; v_uw numeric; v_before_sum numeric; v_after_sum numeric;
    v_bal_after numeric;
BEGIN
    SELECT count(*), count(DISTINCT club_id), round(sum(amount), 2)
      INTO v_rows, v_clubs, v_amount
      FROM public.tournament_guarantee_overlays WHERE bank_type IS NULL;

    IF v_rows = 0 THEN
        RAISE NOTICE 'Nothing to repair: no misbanked overlays remain.';
        RETURN;
    END IF;
    IF v_clubs <> 1 THEN
        RAISE EXCEPTION 'Refusing: % clubs affected, this repair is written for exactly one.', v_clubs;
    END IF;

    SELECT DISTINCT club_id INTO v_club
      FROM public.tournament_guarantee_overlays WHERE bank_type IS NULL;
    SELECT union_id INTO v_union FROM public.clubs WHERE id = v_club;
    IF v_union IS NULL THEN
        RAISE EXCEPTION 'Refusing: club % has no union to reclaim from.', v_club;
    END IF;

    SELECT chip_treasury INTO v_treasury FROM public.clubs WHERE id = v_club FOR UPDATE;
    SELECT chip_balance  INTO v_uw FROM public.union_wallets WHERE union_id = v_union FOR UPDATE;

    IF round(coalesce(v_treasury,0), 2) <> round(-v_amount, 2) THEN
        RAISE EXCEPTION 'Refusing: treasury % does not equal the misbanked total %.', v_treasury, -v_amount;
    END IF;
    IF coalesce(v_uw,0) < v_amount THEN
        RAISE EXCEPTION 'Refusing: union wallet % cannot cover %.', v_uw, v_amount;
    END IF;

    v_before_sum := round(coalesce(v_treasury,0) + coalesce(v_uw,0), 2);

    UPDATE public.clubs
       SET chip_treasury = coalesce(chip_treasury,0) + v_amount, updated_at = now()
     WHERE id = v_club;

    UPDATE public.union_wallets
       SET chip_balance = chip_balance - v_amount, updated_at = now()
     WHERE union_id = v_union
     RETURNING chip_balance INTO v_bal_after;

    INSERT INTO public.union_wallet_transactions
        (union_id, wallet, direction, amount, balance_after, tx_type, club_id, notes)
    VALUES (v_union, 'chip_balance', 'debit', v_amount, v_bal_after,
            'guarantee_overlay', v_club,
            'Rebanking ' || v_rows || ' guarantee overlay(s) written 2026-08-27..29 with bank_type NULL, '
            || 'which debited the club treasury instead of this wallet. Club restored to zero.');

    INSERT INTO public.chip_transactions (club_id, amount, transaction_type, notes, metadata)
    VALUES (v_club, v_amount, 'overlay_rebank',
            'Guarantee overlays rebanked to the union, per fn_apply_prize_guarantee''s union-first rule',
            jsonb_build_object('union_id', v_union, 'overlay_rows', v_rows, 'amount', v_amount,
                               'treasury_before', v_treasury,
                               'migration', '20260830_return_misbanked_guarantee_overlays_to_the_club'));

    UPDATE public.tournament_guarantee_overlays
       SET bank_type = 'union', bank_entity_id = v_union, union_id = v_union
     WHERE bank_type IS NULL;

    SELECT chip_treasury INTO v_treasury FROM public.clubs WHERE id = v_club;
    SELECT chip_balance  INTO v_uw FROM public.union_wallets WHERE union_id = v_union;
    v_after_sum := round(coalesce(v_treasury,0) + coalesce(v_uw,0), 2);

    IF v_after_sum <> v_before_sum THEN
        RAISE EXCEPTION 'Post-apply: chips were created or destroyed (% -> %).', v_before_sum, v_after_sum;
    END IF;
    IF round(coalesce(v_treasury,0),2) <> 0 THEN
        RAISE EXCEPTION 'Post-apply: club treasury is %, expected 0.', v_treasury;
    END IF;
    IF EXISTS (SELECT 1 FROM public.tournament_guarantee_overlays WHERE bank_type IS NULL) THEN
        RAISE EXCEPTION 'Post-apply: misbanked overlays remain.';
    END IF;

    RAISE NOTICE 'Rebanked % overlay(s), % chips. Club treasury 0.00, union wallet %. Total unchanged at %.',
        v_rows, v_amount, v_uw, v_after_sum;
END $$;
