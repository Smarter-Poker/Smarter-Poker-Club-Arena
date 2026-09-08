BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '170s';

/* PHASE 8 OF 8 (UNION ACCOUNTING) - CONTROL, PART 2: ROUND 3 IS ON THE JOURNAL
   TOO.
   ---------------------------------------------------------------------------
   20260908113416 put round 2 and the agent claim on chip_ledger. This finishes
   the sweep. Every remaining union money path was checked against the same
   question - does it move a balance, and does it write a leg:

     fn_settle_round3_agents_to_players   moves balances, NO LEG   <- this
     fn_union_eco_adjustment              moves no balance         (reporting)
     fn_union_eco_record                  moves no balance         (reporting)
     fn_union_weekly_statement            moves no balance         (reporting)
     fn_union_weekly_agent_statements     moves no balance         (reporting)

   Round 3 debits the agent's club_members.chip_balance and credits the
   player's, and records the movement in a single one-sided wallet_transactions
   row. IT HAS RUN: 559 such rows totalling 43,990.40 on 2026-08-20, with
   nothing in the journal behind them.

   WHY NO READER CAUGHT IT, AND WHY THAT IS THE INTERESTING PART. Both sides of
   round 3 are club_members.chip_balance, which the supply snapshot calls
   member_wallets and fn_ca_trial_balance reports as the single account
   player_wallets. The debit and the credit therefore cancel inside one account
   and the account total never moves: the trial balance is STRUCTURALLY BLIND
   to an agent-to-player transfer, no matter how large. fn_ca_ledger_replay is
   per ACCOUNT OWNER and would flag both the agent and the player - and feeding
   that reader is precisely what phase 8 is for. A leg that only the replay can
   check is still worth writing; a movement no reader can check is not control.

   DORMANT, NOT DEAD, WHICH IS WHY THIS IS CHEAP TODAY. Measured 2026-09-08:
   2,766 pending rakeback rows worth 325,960.71, and 1,575 club members
   carrying an agent_id - but ZERO rows where a PENDING rakeback belongs to a
   player who has an agent AND whose club sits in a union, which is the exact
   intersection round 3 pays on. It has nothing to pay right now. The moment
   that intersection is non-empty it pays again, and it will pay onto the
   journal.

   THE LEG. player_wallet -> player_wallet, because both sides genuinely are
   member wallets. A same-type leg is already ordinary here (prize_liability ->
   prize_liability, 582 legs in two days). Category 'rakeback', which is what
   this money is - the commission legs from 20260908113416 stay 'commission',
   so a reader can still tell the two obligations apart. Keyed
   round3:<union>:<period start>:<club>:<agent>:<player> against
   ux_chip_ledger_idempotency_key, so a replayed close cannot double-post.

   PROVED ON PRODUCTION, inside a transaction rolled back by its own RAISE. No
   union has an eligible pair today, so the probe built one - a club in a union,
   one member made the other's agent, one pending rakeback row - applied this
   transform, and ran the real function:

     round 3 result   payees 1, amount 25.00, shortfalls 0
     agent    500.00 -> 475.00            (delta -25.00)
     player   615,200.75 -> 615,225.75    (delta +25.00)
     journal  1 leg, sum 25.00

   The leg equals the movement, on both sides, to the cent.

   A transform rather than a pasted body, for the same reason as
   20260908113416: this is live money code, and retyping it to add one INSERT
   risks altering a payout by accident. The block asserts its anchor appears
   exactly once and aborts rather than guessing, is a no-op on a database that
   already has the leg, and asserts afterwards that round 3 kept its rakeback
   status update, its wallet_transactions row and its settlement-freeze guard. */

DO $migrate_round3$
DECLARE
  v_def    text;
  v_anchor text := $anchor$FROM club_members cm WHERE cm.user_id = r.player_id AND cm.club_id = r.club_id;$anchor$;
  v_leg    text := $leg$

    /* CONTROL (phase 8): the same movement as a balanced leg on the journal.
       Both sides are member wallets, so the trial balance nets them to zero
       and cannot see this; fn_ca_ledger_replay is per account owner and can. */
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, union_id, description, idempotency_key, metadata)
    VALUES
      (COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
       'player_wallet', r.agent_user, 'player_wallet', r.player_id,
       round(r.owed, 2), 'rakeback', r.club_id, p_union_id,
       'Round 3: agent -> player rakeback (period '
         || to_char(p_period_start, 'YYYY-MM-DD') || '..'
         || to_char(p_period_end, 'YYYY-MM-DD') || ')',
       'round3:' || p_union_id::text || ':'
         || to_char(p_period_start at time zone 'UTC', 'YYYY-MM-DD') || ':'
         || r.club_id::text || ':' || r.agent_user::text || ':' || r.player_id::text,
       jsonb_build_object('period_start', p_period_start, 'period_end', p_period_end))
    ON CONFLICT DO NOTHING;$leg$;
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'fn_settle_round3_agents_to_players';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fn_settle_round3_agents_to_players does not exist';
  END IF;
  IF position('INSERT INTO public.chip_ledger' IN v_def) > 0 THEN
    RAISE NOTICE 'round 3 already writes a journal leg; nothing to do';
    RETURN;
  END IF;
  v_hits := array_length(string_to_array(v_def, v_anchor), 1) - 1;
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'round 3 anchor expected exactly once, found %', v_hits;
  END IF;
  EXECUTE replace(v_def, v_anchor, v_anchor || v_leg);
END
$migrate_round3$;

DO $assert$
DECLARE r3 text;
BEGIN
  SELECT prosrc INTO r3 FROM pg_proc
   WHERE proname = 'fn_settle_round3_agents_to_players' AND pronamespace = 'public'::regnamespace;
  IF r3 IS NULL THEN
    RAISE EXCEPTION 'round 3 went missing during the rewrite';
  END IF;
  IF r3 !~ 'INSERT INTO public\.chip_ledger' THEN
    RAISE EXCEPTION 'round 3 still pays without a journal leg';
  END IF;
  IF r3 !~ 'round3:' THEN
    RAISE EXCEPTION 'round 3 leg is not idempotency keyed';
  END IF;
  IF r3 !~ 'rakeback_periods' OR r3 !~ 'wallet_transactions'
     OR r3 !~ 'GLOBAL_SETTLEMENT_FREEZE' THEN
    RAISE EXCEPTION 'round 3 lost a step it had before';
  END IF;
END
$assert$;

COMMIT;
