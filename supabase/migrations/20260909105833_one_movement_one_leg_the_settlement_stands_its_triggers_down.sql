DO $mig$
DECLARE
  v_src text;
  v_new text;
BEGIN
  ------------------------------------------------------------------
  -- 1. THE AUTOSKIP CONTRACT IS ONE CONTRACT.
  ------------------------------------------------------------------
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_club_members_ledger_writer';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_club_members_ledger_writer is gone';
  END IF;
  IF position($chk$  d := COALESCE(NEW.chip_balance, 0) - COALESCE(OLD.chip_balance, 0);$chk$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'fn_club_members_ledger_writer: the delta line moved; re-read it before editing';
  END IF;
  IF position($chk$ledger_autoskip_club_members$chk$ IN v_src) <> 0 THEN
    RAISE EXCEPTION 'fn_club_members_ledger_writer already stands down; nothing to add';
  END IF;

  v_new := replace(v_src,
$old$  d := COALESCE(NEW.chip_balance, 0) - COALESCE(OLD.chip_balance, 0);$old$,
$new$  /* THE AUTOSKIP CONTRACT IS ONE CONTRACT (2026-09-09). Every other journal
     writer on this platform stands down when the caller sets
     app.ledger_autoskip_<table>, because the caller is writing the leg itself
     with the period, the key and the metadata that only it knows. This writer
     never learned that clause. So a settlement that suppressed the clubs
     trigger and wrote its own named leg still got an anonymous twin from this
     side, and the movement reached the journal twice: on 2026-09-09 round 2
     moved 20,377.49 of commission and recorded 40,754.98 of legs. Standing
     down here is what makes one movement, one leg true for the busiest
     balance column on the platform. */
  IF current_setting('app.ledger_autoskip_club_members', true) = '1' THEN
    RETURN NEW;
  END IF;

  d := COALESCE(NEW.chip_balance, 0) - COALESCE(OLD.chip_balance, 0);$new$);

  IF v_new = v_src THEN
    RAISE EXCEPTION 'fn_club_members_ledger_writer: nothing was replaced';
  END IF;
  EXECUTE v_new;

  ------------------------------------------------------------------
  -- 2. ROUND 2 WRITES ITS OWN LEG, SO THE TRIGGERS STAND DOWN.
  ------------------------------------------------------------------
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_settle_round2_club_to_agents';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_settle_round2_club_to_agents is gone';
  END IF;
  IF position($chk$    v_debit := public.fn_debit_treasury($chk$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'round 2: the treasury debit call moved';
  END IF;
  IF position($chk$     RETURNING chip_balance INTO v_agent_bal;$chk$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'round 2: the agent credit moved';
  END IF;
  IF position($chk$ledger_autoskip$chk$ IN v_src) <> 0 THEN
    RAISE EXCEPTION 'round 2 already stands the triggers down; nothing to add';
  END IF;

  v_new := replace(v_src,
$old$    v_debit := public.fn_debit_treasury($old$,
$new$    /* ONE MOVEMENT, ONE LEG (2026-09-09). The leg for this payment is
       written by hand at the bottom of this loop, carrying the period, the
       row count and an idempotency key that a replay can recognise. Until
       today both balance writes ALSO fired their own journal triggers, and
       neither had been told who the counterparty was, so each wrote an
       anonymous twin through settlement_suspense. Every commission was
       therefore journalled twice. The two stand-downs are set immediately
       before each write and cleared immediately after, so a CONTINUE out of
       this iteration can never leave a later statement silently unjournalled. */
    PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
    v_debit := public.fn_debit_treasury($new$);

  v_new := replace(v_new,
$old$    IF COALESCE((v_debit->>'success')::boolean, false) IS NOT TRUE THEN$old$,
$new$    PERFORM set_config('app.ledger_autoskip_clubs', '', true);
    IF COALESCE((v_debit->>'success')::boolean, false) IS NOT TRUE THEN$new$);

  v_new := replace(v_new,
$old$    PERFORM public.fn_ensure_club_wallet(r.agent_user, r.club_id);
    UPDATE club_members
       SET chip_balance = COALESCE(chip_balance, 0) + r.owed, updated_at = now()
     WHERE user_id = r.agent_user AND club_id = r.club_id$old$,
$new$    PERFORM public.fn_ensure_club_wallet(r.agent_user, r.club_id);
    PERFORM set_config('app.ledger_autoskip_club_members', '1', true);
    UPDATE club_members
       SET chip_balance = COALESCE(chip_balance, 0) + r.owed, updated_at = now()
     WHERE user_id = r.agent_user AND club_id = r.club_id$new$);

  v_new := replace(v_new,
$old$     RETURNING chip_balance INTO v_agent_bal;$old$,
$new$     RETURNING chip_balance INTO v_agent_bal;
    PERFORM set_config('app.ledger_autoskip_club_members', '', true);$new$);

  IF v_new = v_src THEN
    RAISE EXCEPTION 'round 2: nothing was replaced';
  END IF;
  EXECUTE v_new;

  ------------------------------------------------------------------
  -- 3. ROUND 3 THE SAME, ON BOTH SIDES OF ONE TABLE.
  ------------------------------------------------------------------
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_settle_round3_agents_to_players';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_settle_round3_agents_to_players is gone';
  END IF;
  IF position($chk$    UPDATE club_members SET chip_balance = chip_balance - r.owed, updated_at = now()
     WHERE user_id = r.agent_user AND club_id = r.club_id;$chk$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'round 3: the agent debit moved';
  END IF;
  IF position($chk$ledger_autoskip$chk$ IN v_src) <> 0 THEN
    RAISE EXCEPTION 'round 3 already stands the trigger down; nothing to add';
  END IF;

  v_new := replace(v_src,
$old$    UPDATE club_members SET chip_balance = chip_balance - r.owed, updated_at = now()
     WHERE user_id = r.agent_user AND club_id = r.club_id;

    PERFORM public.fn_ensure_club_wallet(r.player_id, r.club_id);
    UPDATE club_members SET chip_balance = COALESCE(chip_balance,0) + r.owed, updated_at = now()
     WHERE user_id = r.player_id AND club_id = r.club_id;$old$,
$new$    /* ONE MOVEMENT, ONE LEG (2026-09-09). Both sides of this transfer live
       in club_members, and the leg that names them - agent wallet to player
       wallet - is written by hand below. Without these stand-downs the
       club_members trigger fired twice per payment, once for the debit and
       once for the credit, and neither knew the counterparty, so a single
       rakeback payment reached the journal as an anonymous pair through
       settlement_suspense PLUS the named leg. */
    PERFORM set_config('app.ledger_autoskip_club_members', '1', true);
    UPDATE club_members SET chip_balance = chip_balance - r.owed, updated_at = now()
     WHERE user_id = r.agent_user AND club_id = r.club_id;

    PERFORM public.fn_ensure_club_wallet(r.player_id, r.club_id);
    UPDATE club_members SET chip_balance = COALESCE(chip_balance,0) + r.owed, updated_at = now()
     WHERE user_id = r.player_id AND club_id = r.club_id;
    PERFORM set_config('app.ledger_autoskip_club_members', '', true);$new$);

  IF v_new = v_src THEN
    RAISE EXCEPTION 'round 3: nothing was replaced';
  END IF;
  EXECUTE v_new;

  ------------------------------------------------------------------
  -- POST-APPLY ASSERTIONS
  ------------------------------------------------------------------
  IF (SELECT position($chk$IF current_setting('app.ledger_autoskip_club_members', true) = '1' THEN$chk$
        IN pg_get_functiondef(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname='fn_club_members_ledger_writer') = 0 THEN
    RAISE EXCEPTION 'the club_members writer did not learn to stand down';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public'
         AND p.proname IN ('fn_settle_round2_club_to_agents','fn_settle_round3_agents_to_players')
         AND position($chk$app.ledger_autoskip_club_members$chk$ IN pg_get_functiondef(p.oid)) > 0) <> 2 THEN
    RAISE EXCEPTION 'a settlement round did not learn to stand the trigger down';
  END IF;
END
$mig$;;
