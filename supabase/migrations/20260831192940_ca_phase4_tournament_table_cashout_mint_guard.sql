-- BACKFILLED 2026-09-03 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831192940; the file committed at the time was a placeholder
-- marker (kept below) that said to export the body. Content is byte-exact to
-- what ran. Do NOT re-apply; it is already live.

-- ZERO-DRIFT PHASE 4 - STOP THE TOURNAMENT-TABLE CASHOUT MINT
-- (prod 2026-08-31 19:33 UTC; canonical body in prod schema_migrations)
-- Caught by the phase-1 supply monitor, root-caused via the ledger: the
-- engine calls atomic_table_cashout for HORSE seats on TOURNAMENT-ATTACHED
-- tables, crediting PLAY-chip stacks to club_members.chip_balance as REAL
-- chips. Zero matching debits: 46.4M chips created into horse wallets since
-- 2026-08-24 (2.57M on 08-31 alone; 391 cashouts, 235 accounts, all
-- is_horse). atomic_table_cashout now closes tournament-table seats WITH NO
-- WALLET CREDIT (tournament results settle only through the tournament
-- payout path) and raises a deduped warning incident per blocked attempt so
-- the engine exit path gets fixed. Verified by rolled-back probe: 220-chip
-- tournament stack -> credit 0, seat closed, incident raised. The minted
-- 46.4M sits in house horse wallets, queued for formal chip_retirement at
-- the Midway epoch-3 reset (doc 05 §3). No table, game, or wallet locked.

-- ═══════════════════════════════════════════════════════════════════════════
-- ZERO-DRIFT PHASE 4 — STOP THE TOURNAMENT-TABLE CASHOUT MINT
-- ═══════════════════════════════════════════════════════════════════════════
-- Caught by the phase-1 supply monitor and root-caused today: the engine has
-- been calling atomic_table_cashout for HORSE seats on TOURNAMENT-ATTACHED
-- tables. A tournament seat's stack is PLAY CHIPS, but the cashout credited
-- it to club_members.chip_balance as REAL chips — one-way minting (zero
-- matching debits): 46.4M chips created into horse wallets since 2026-08-24,
-- 2.57M today alone, all is_horse accounts.
-- The guard: a seat on a table with tournament_id set closes WITHOUT any
-- wallet credit (tournament results settle exclusively through the
-- tournament payout path). Each blocked mint raises a deduped warning
-- incident so the engine-side caller gets fixed. Nothing is locked; seats
-- still close; cash tables are untouched.
CREATE OR REPLACE FUNCTION public.atomic_table_cashout(p_user_id uuid, p_table_id uuid, p_seat_number integer DEFAULT NULL::integer)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_stack NUMERIC; v_new_balance NUMERIC; v_seat_club UUID; v_is_tournament boolean;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( auth.uid() <> p_user_id)) THEN
    RAISE EXCEPTION 'Cannot cash out for another user';
  END IF;

  PERFORM set_config('app.ledger_category', 'table_cashout', true);
  PERFORM set_config('app.ledger_counterparty', 'table_stack', true);
  PERFORM set_config('app.ledger_counterparty_entity', COALESCE(p_table_id::text, ''), true);

  IF p_seat_number IS NOT NULL THEN
    SELECT stack, club_id INTO v_stack, v_seat_club FROM table_seats
      WHERE table_id = p_table_id AND user_id = p_user_id AND seat_number = p_seat_number AND left_at IS NULL
      FOR UPDATE;
  ELSE
    SELECT stack, club_id INTO v_stack, v_seat_club FROM table_seats
      WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
      FOR UPDATE;
  END IF;

  IF NOT FOUND THEN RAISE EXCEPTION 'Active seat not found for cash-out'; END IF;

  -- ZERO-DRIFT phase 4: tournament stacks are play chips. They NEVER cash
  -- out to a wallet — prizes flow through the tournament payout path.
  SELECT (t.tournament_id IS NOT NULL) INTO v_is_tournament
    FROM public.tables t WHERE t.id = p_table_id;
  IF COALESCE(v_is_tournament, false) AND v_stack > 0 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'atomic_table_cashout:tournament_mint_blocked', 'unauthorized_adjustment', 'warning',
      'tourney-cashout-blocked:' || p_table_id::text,
      v_stack, 0, v_stack, 'ledger', 'tables', p_table_id, v_seat_club,
      NULL, p_table_id, NULL, NULL, NULL, NULL, NULL,
      'engine attempted a real-chip cashout of a tournament-table stack (play chips) — credit blocked; fix the engine exit path for this table type',
      NULL, jsonb_build_object('user_id', p_user_id, 'stack', v_stack));
    UPDATE table_seats SET left_at = NOW(), leave_pending = false
      WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL;
    UPDATE tables SET current_players = (
      SELECT COUNT(*) FROM table_seats WHERE table_id = p_table_id AND left_at IS NULL
    ) WHERE id = p_table_id;
    RETURN 0;
  END IF;

  IF v_stack > 0 THEN
    IF v_seat_club IS NULL THEN
      v_seat_club := public.fn_player_home_club(p_user_id, NULL);
    END IF;
    IF v_seat_club IS NULL THEN
      RAISE EXCEPTION 'No club wallet resolves for cash-out of player %', p_user_id;
    END IF;

    PERFORM public.fn_ensure_club_wallet(p_user_id, v_seat_club);

    UPDATE club_members
       SET chip_balance = COALESCE(chip_balance, 0) + v_stack, updated_at = NOW()
     WHERE user_id = p_user_id AND club_id = v_seat_club
     RETURNING chip_balance INTO v_new_balance;

    INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
      VALUES (p_user_id, 'PLAYER', 'credit', v_stack, 'cashout',
              'Cash-out to club wallet', p_table_id, v_new_balance);
  END IF;

  UPDATE table_seats SET left_at = NOW(), leave_pending = false
    WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL;
  UPDATE tables SET current_players = (
    SELECT COUNT(*) FROM table_seats WHERE table_id = p_table_id AND left_at IS NULL
  ) WHERE id = p_table_id;

  RETURN v_stack;
END;
$function$;
