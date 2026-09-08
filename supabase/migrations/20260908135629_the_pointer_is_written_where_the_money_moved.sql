DO $mig$
DECLARE
  v_bad int; v_rounded int; v_backfilled int; v_orphan int; v_left int; v_resolved int;
  v_src text; v_new text;
  v_anchor_credit text :=
    '  PERFORM public.atomic_credit_wallet_and_log(' || E'\n' ||
    '    v_period.user_id, v_payout, ''rakeback'',' || E'\n' ||
    '    ''Rakeback payout '' || v_period.period_start::text || '' to '' || v_period.period_end::text,' || E'\n' ||
    '    NULL, NULL, v_payout_id, ''rakeback:'' || p_period_id::text' || E'\n' ||
    '  );';
  v_replace_credit text :=
    '  PERFORM public.atomic_credit_wallet_and_log(' || E'\n' ||
    '    v_period.user_id, v_payout, ''rakeback'',' || E'\n' ||
    '    ''Rakeback payout '' || v_period.period_start::text || '' to '' || v_period.period_end::text,' || E'\n' ||
    '    NULL, NULL, v_payout_id, ''rakeback:'' || p_period_id::text' || E'\n' ||
    '  );' || E'\n' ||
    '  /* THE POINTER IS WRITTEN WHERE THE MONEY MOVED (2026-09-08). The credit' || E'\n' ||
    '     above already stamps related_entity_id = this payout, so the link has' || E'\n' ||
    '     always existed in ONE direction. rakeback_period_payouts.wallet_' || E'\n' ||
    '     transaction_id was never written back, on any of 2,704 rows since the' || E'\n' ||
    '     table was created, and fn_ca_settlement_correctness_check reads that' || E'\n' ||
    '     direction - so every paid rakeback looked like money with no evidence.' || E'\n' ||
    '     PERFORM discards what the credit returns and the function returns only' || E'\n' ||
    '     a boolean, so the id is read back from the row it just stamped. */' || E'\n' ||
    '  PERFORM set_config(''app.ledger_maintenance'',' || E'\n' ||
    '                     ''rakeback payout evidence pointer'', true);' || E'\n' ||
    '  UPDATE public.rakeback_period_payouts p' || E'\n' ||
    '     SET wallet_transaction_id = w.id' || E'\n' ||
    '    FROM public.wallet_transactions w' || E'\n' ||
    '   WHERE p.id = v_payout_id AND w.related_entity_id = v_payout_id' || E'\n' ||
    '     AND p.wallet_transaction_id IS NULL;' || E'\n' ||
    '  PERFORM set_config(''app.ledger_maintenance'', '''', true);';
BEGIN
  IF NOT (current_user IN ('postgres', 'service_role')) THEN
    RAISE EXCEPTION 'operator-only';
  END IF;

  SELECT count(*) INTO v_bad FROM public.rakeback_period_payouts p
   WHERE p.payout_amount <> round(p.payout_amount,2)
     AND NOT EXISTS (SELECT 1 FROM public.wallet_transactions w
                      WHERE w.related_entity_id = p.id
                        AND round(w.amount,2) = round(p.payout_amount,2));
  IF v_bad <> 0 THEN
    RAISE EXCEPTION
      'ABORT: % sub-cent payout(s) whose wallet does not match the rounded amount. Rounding those would change what a player was paid. Nothing written.', v_bad;
  END IF;

  PERFORM set_config('app.ledger_maintenance',
    'rakeback_chain incidents: round payout_amount to the chip unit and write the evidence pointer', true);

  UPDATE public.rakeback_period_payouts
     SET payout_amount = round(payout_amount,2)
   WHERE payout_amount <> round(payout_amount,2);
  GET DIAGNOSTICS v_rounded = ROW_COUNT;

  ALTER TABLE public.rakeback_period_payouts
    VALIDATE CONSTRAINT chk_payout_amount_is_two_decimal_places;

  UPDATE public.rakeback_period_payouts p
     SET wallet_transaction_id = w.id
    FROM public.wallet_transactions w
   WHERE p.wallet_transaction_id IS NULL
     AND w.related_entity_id = p.id
     AND (SELECT count(*) FROM public.wallet_transactions x
           WHERE x.related_entity_id = p.id) = 1;
  GET DIAGNOSTICS v_backfilled = ROW_COUNT;

  UPDATE public.rakeback_period_payouts
     SET status = 'failed',
         failure_reason = 'nothing moved on either side: no treasury debit, no wallet credit, no ledger leg, and this user has never held a membership or transacted'
   WHERE id = '1107bc5e-d5ff-4daa-ab65-230a621359b9'
     AND status = 'paid';
  GET DIAGNOSTICS v_orphan = ROW_COUNT;

  PERFORM set_config('app.ledger_maintenance', '', true);

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_close_settlement_period';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_close_settlement_period not found';
  END IF;

  IF position('THE POINTER IS WRITTEN WHERE THE MONEY MOVED' in v_src) > 0 THEN
    RAISE NOTICE 'payer already writes its pointer; skipping';
  ELSE
    IF (length(v_src) - length(replace(v_src, v_anchor_credit, ''))) / length(v_anchor_credit) <> 1 THEN
      RAISE EXCEPTION 'the rakeback credit call site does not appear exactly once - fn_close_settlement_period has changed and this edit must be re-read against it';
    END IF;
    IF (length(v_src) - length(replace(v_src, 'ROUND(v_rate * 100, 2), v_payout, ''paid'', NOW())', '')))
         / length('ROUND(v_rate * 100, 2), v_payout, ''paid'', NOW())') <> 1 THEN
      RAISE EXCEPTION 'the payout VALUES row does not appear exactly once - fn_close_settlement_period has changed and this edit must be re-read against it';
    END IF;

    v_new := replace(v_src, v_anchor_credit, v_replace_credit);
    v_new := replace(v_new,
      'ROUND(v_rate * 100, 2), v_payout, ''paid'', NOW())',
      'ROUND(v_rate * 100, 2), round(v_payout, 2), ''paid'', NOW())');
    IF v_new = v_src THEN
      RAISE EXCEPTION 'substitution produced no change';
    END IF;
    EXECUTE v_new;
  END IF;

  SELECT count(*) INTO v_left FROM public.rakeback_period_payouts
   WHERE status = 'paid' AND wallet_transaction_id IS NULL;
  IF v_left <> 0 THEN
    RAISE EXCEPTION
      'post-condition failed: % payout(s) still say paid with no linked transaction. Nothing written.', v_left;
  END IF;

  UPDATE public.ca_drift_incidents i
     SET status = 'resolved',
         resolved_at = now(),
         correction_ref = 'migration the_pointer_is_written_where_the_money_moved',
         root_cause = 'fn_close_settlement_period pays rakeback through atomic_credit_wallet_and_log, which stamps wallet_transactions.related_entity_id with the payout id - but the call is a PERFORM and the function returns only a boolean, so rakeback_period_payouts.wallet_transaction_id was never written back. The link existed in one direction and fn_ca_settlement_correctness_check reads the other, so every paid rakeback in the table looked like money with no evidence pointer. Not 20 rows: all 2,704, since the table was created.',
         resolution = 'Reconciled before resolving: this payout WAS paid - a chip_ledger leg, a wallet_transactions row and a rakeback-category credit all exist for the player, and exactly one wallet transaction points back at this row. Across the class, 20 of 20 and 2,703 of 2,704 recovered their pointer from that back-reference (recovered, not guessed - only where exactly one transaction points back). Fixed at the root: the payer now writes the pointer in the same transaction as the credit, and rounds the payout at source. The 933 sub-cent payout_amounts were rounded to the chip unit after proving the wallet matched the rounded value on all 933 and the exact value on none, which also let phase 9.1 CHECK be validated. One row - 0.20, 2026-07-22 - was found to have moved nothing on either side for a user with no membership and no transaction history anywhere; it is marked failed with its evidence rather than left claiming a payment.'
   WHERE i.status = 'open'
     AND i.source = 'fn_ca_settlement_correctness_check:rakeback_chain'
     AND EXISTS (SELECT 1 FROM public.rakeback_period_payouts p
                  WHERE p.id = (i.metadata->>'row_id')::uuid
                    AND p.wallet_transaction_id IS NOT NULL);
  GET DIAGNOSTICS v_resolved = ROW_COUNT;

  RAISE NOTICE 'rakeback evidence: % rounded, % pointers recovered, % orphan corrected, % incidents resolved',
    v_rounded, v_backfilled, v_orphan, v_resolved;
END $mig$;