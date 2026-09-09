DO $mig$
DECLARE v_src text; v_new text;
BEGIN
  /* fn_pay_player_chips is the shared door every rakeback path goes through -
     atomic_pay_player_rakeback in both its shapes, credit_player_rakeback, and
     others - and it credits a club member wallet without ever saying where the
     chips came from. So the trigger fell back to settlement_suspense and the
     journal recorded the payment as an anonymous arrival. On 2026-09-07 that
     was 231,046.71 of rakeback in 1,691 legs.

     It has always known the answer: it resolves v_club precisely so it can
     credit that club's wallet, and a player paid from their club is paid out
     of that club's treasury. It declares that now. A caller that has already
     declared a counterparty keeps it - a satellite or a tournament path knows
     better than this function does - and the declaration is cleared again
     afterwards so it cannot leak onto an unrelated write later in the same
     transaction. */
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_pay_player_chips';
  IF v_src IS NULL THEN RAISE EXCEPTION 'fn_pay_player_chips is gone'; END IF;
  IF position($chk$ledger_counterparty$chk$ IN v_src) <> 0 THEN
    RAISE EXCEPTION 'fn_pay_player_chips already names its bank';
  END IF;
  IF position($chk$  UPDATE club_members
     SET chip_balance = COALESCE(chip_balance,0) + p_amount, updated_at = NOW()
   WHERE user_id = p_user_id AND club_id = v_club$chk$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'the member credit moved; re-read it before editing';
  END IF;

  v_new := replace(v_src,
$old$DECLARE v_club uuid; v_balance numeric;$old$,
$new$DECLARE v_club uuid; v_balance numeric; v_had_cp text; v_cat text;$new$);

  v_new := replace(v_new,
$old$  UPDATE club_members
     SET chip_balance = COALESCE(chip_balance,0) + p_amount, updated_at = NOW()
   WHERE user_id = p_user_id AND club_id = v_club$old$,
$new$  /* THE BANK IS NAMED (2026-09-09). A player paid from their club is paid
     out of that club's treasury, and this function has already resolved which
     club. Declaring it here is what stops the journal recording the payment
     as an anonymous arrival out of settlement_suspense. p_category is a
     wallet_transactions category and is only used when the ledger vocabulary
     also has it; otherwise the leg is an adjustment, which is what it was
     before. */
  v_had_cp := COALESCE(NULLIF(current_setting('app.ledger_counterparty', true), ''), '');
  IF v_had_cp = '' THEN
    SELECT CASE WHEN EXISTS (
             SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.chip_ledger'::regclass
                AND conname = 'chip_ledger_category_check'
                AND pg_get_constraintdef(oid) LIKE '%''' || lower(btrim(COALESCE(p_category,''))) || '''%')
           THEN lower(btrim(p_category)) ELSE 'adjustment' END
      INTO v_cat;
    PERFORM public.fn_ca_declare_ledger(v_cat, 'club_treasury', v_club);
  END IF;

  UPDATE club_members
     SET chip_balance = COALESCE(chip_balance,0) + p_amount, updated_at = NOW()
   WHERE user_id = p_user_id AND club_id = v_club$new$);

  v_new := replace(v_new,
$old$  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'club wallet for player % in club % could not be credited', p_user_id, v_club;
  END IF;$old$,
$new$  IF v_had_cp = '' THEN
    -- Cleared so a declaration made for THIS credit cannot label a later one.
    PERFORM set_config('app.ledger_counterparty', '', true);
    PERFORM set_config('app.ledger_counterparty_entity', '', true);
    PERFORM set_config('app.ledger_category', '', true);
  END IF;

  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'club wallet for player % in club % could not be credited', p_user_id, v_club;
  END IF;$new$);

  IF v_new = v_src THEN RAISE EXCEPTION 'fn_pay_player_chips was not changed'; END IF;
  EXECUTE v_new;

  IF (SELECT position($chk$PERFORM public.fn_ca_declare_ledger(v_cat, 'club_treasury', v_club);$chk$
        IN pg_get_functiondef(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='fn_pay_player_chips') = 0 THEN
    RAISE EXCEPTION 'fn_pay_player_chips did not learn to name its bank';
  END IF;
END
$mig$;;
