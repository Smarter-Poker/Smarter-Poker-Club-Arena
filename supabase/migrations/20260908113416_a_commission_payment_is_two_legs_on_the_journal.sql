BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '170s';

/* PHASE 8 OF 8 (UNION ACCOUNTING) - CONTROL: A COMMISSION PAYMENT IS TWO LEGS
   ON THE JOURNAL.
   ---------------------------------------------------------------------------
   WHAT PHASE 8 IS. Phase 6 deferred it in as many words
   (docs/changelog/2026-09-07-one-source-of-truth-for-rake.md, section 5):
   "A full journal (every wallet movement as two balanced legs with a trial
   balance) touches every money writer on the platform and is the most invasive
   item in the brief with the least urgency ... It belongs in Phase 8 (Control)
   next to approve-before-execute, where a journal has a reader."

   MOST OF CONTROL IS ALREADY BUILT, BY ANOTHER LANE, AND THIS DOES NOT REBUILD
   IT. The chip-accounting programme shipped the journal itself (chip_ledger),
   its append-only guard, fn_ca_trial_balance, fn_ca_ledger_replay,
   fn_ca_conservation_sweep, and approve-before-execute
   (fn_ca_propose_manual_adjustment / _approve / _reject). What was missing is
   narrower and specific to this lane: THE UNION'S COMMISSION PAYERS ARE NOT ON
   THAT JOURNAL.

   MEASURED ON PRODUCTION, 2026-09-08.

     fn_union_weekly_rakeback_close   (round 1)  writes a chip_ledger leg,
                                                 idempotency-keyed, and asserts
                                                 conservation on the balances.
     fn_settle_round2_club_to_agents  (round 2)  NO LEG. It debits through
                                                 fn_debit_treasury (which writes
                                                 chip_transactions, one-sided)
                                                 and credits by UPDATE-ing
                                                 club_members.chip_balance
                                                 directly, logging one
                                                 wallet_transactions row.
     fn_agent_claim_commission        (claim)    NO LEG. UPDATEs
                                                 clubs.chip_treasury and
                                                 club_members.chip_balance
                                                 directly, plus one
                                                 chip_transactions row.

   Round 2 even carries the comment "Both sides of the entry: club-side debit
   above, agent credit here." Those two "sides" are rows in two unrelated
   one-sided tables. They are not balanced legs and no reader can pair them.

   The only commission legs that exist in chip_ledger are 78 legs totalling
   117.92, all written on 2026-03-24. Commission has been off the journal since
   March.

   WHY IT MATTERS, AND WHY NOW. fn_ca_trial_balance compares, per account, the
   movement in the balances against the net of the journal's legs. It already
   carries both accounts this money crosses - club_treasuries (clubs
   .chip_treasury) and player_wallets (club_members.chip_balance) - and both
   read 0.00 difference today. A payment that moves the balances and writes no
   leg is therefore drift BY CONSTRUCTION: balance_delta moves, ledger_net does
   not, and the difference is the whole payout. This is the same shape CLAUDE.md
   section 11.5 records for atomic_table_buyin, where writing
   club_members.chip_balance directly made 48 chips invisible to the one check
   that existed.

   NOTHING HAS LEAKED YET, AND THIS IS THE POINT. chip_transactions holds ZERO
   rows of transaction_type 'commission_claim' - the current claim has never
   paid anybody - and agent_commission_settlements is empty, so round 2 has not
   run since the phase 7 model change. Meanwhile 1,008,323.53 of commission is
   owed. The first union close would move roughly a million chips through a path
   the journal cannot see. This lands before that, not after it.

   THE CHANGE. One INSERT into public.chip_ledger in each payer, written the way
   round 1 writes its own leg:

     from_type       club_treasury  (clubs.chip_treasury, the account debited)
     to_type         player_wallet  (club_members.chip_balance, the account
                                     credited - this is what the supply snapshot
                                     calls member_wallets and the trial balance
                                     calls player_wallets)
     category        commission     ONE category for one kind of money. The
                                    vocabulary also has 'agent_claim', but
                                    round 2 and the claim are the same economic
                                    event paid by two different doors, and a
                                    reader asking "what has this agent been
                                    paid" should not have to know both words.
                                    Which door paid is in the description and
                                    the idempotency key.
     idempotency_key round2:<union>:<period start>:<club>:<agent>
                     agent_claim:<op_id>
                     ux_chip_ledger_idempotency_key is a unique index, so a
                     replayed close or a retried claim cannot double-post.
                     ON CONFLICT DO NOTHING makes that explicit rather than an
                     error.
     performed_by    COALESCE(auth.uid(), the system identity) - copied exactly
                     from round 1, because a cron-run close has no auth.uid()
                     and the column is NOT NULL.

   NO NEW FAILURE MODE. zz_freeze_guard already sits on clubs, club_members,
   chip_transactions and wallet_transactions, which both payers already write,
   so the maintenance freeze refuses these payments today exactly as it will
   after this change; adding chip_ledger (also guarded) changes nothing about
   when they can run.

   WHY A TRANSFORM AND NOT A PASTED FUNCTION BODY. Round 2 is 5.2K and the claim
   is 12.5K of live money code. Retyping either to add one INSERT risks altering
   a payout by accident. Each block below asserts its anchor appears EXACTLY
   ONCE, splices the leg beside it, and re-executes; it aborts rather than
   guessing. Both were probed on production inside a transaction that was rolled
   back by its own RAISE before this was committed (section 11.5). */

-- ── round 2: club -> agent, the weekly close ────────────────────────────────
DO $migrate_round2$
DECLARE
  v_def    text;
  v_anchor text := $anchor$'Round 2: club -> agent commission [club wallet]', v_agent_bal);$anchor$;
  v_leg    text := $leg$

    /* CONTROL (phase 8): the same movement as two balanced legs, on the
       journal fn_ca_trial_balance reads. Without this the club_treasuries and
       player_wallets accounts move with no ledger_net to match. */
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, union_id, description, idempotency_key, metadata)
    VALUES
      (COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
       'club_treasury', r.club_id, 'player_wallet', r.agent_user,
       round(r.owed, 2), 'commission', r.club_id, p_union_id,
       'Round 2: club -> agent commission (period '
         || to_char(p_period_start, 'YYYY-MM-DD') || '..'
         || to_char(p_period_end, 'YYYY-MM-DD') || ')',
       'round2:' || p_union_id::text || ':'
         || to_char(p_period_start at time zone 'UTC', 'YYYY-MM-DD') || ':'
         || r.club_id::text || ':' || r.agent_user::text,
       jsonb_build_object('period_start', p_period_start, 'period_end', p_period_end,
                          'rows_count', r.n, 'agent_balance_after', v_agent_bal))
    ON CONFLICT DO NOTHING;$leg$;
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'fn_settle_round2_club_to_agents';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fn_settle_round2_club_to_agents does not exist';
  END IF;

  IF position('INSERT INTO public.chip_ledger' IN v_def) > 0 THEN
    RAISE NOTICE 'round 2 already writes a journal leg; nothing to do';
    RETURN;
  END IF;

  v_hits := array_length(string_to_array(v_def, v_anchor), 1) - 1;
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'round 2 anchor expected exactly once, found %', v_hits;
  END IF;

  EXECUTE replace(v_def, v_anchor, v_anchor || v_leg);
END
$migrate_round2$;

-- ── the agent claim ─────────────────────────────────────────────────────────
DO $migrate_claim$
DECLARE
  v_def    text;
  v_anchor text := $anchor$INSERT INTO chip_transactions$anchor$;
  v_leg    text := $leg$/* CONTROL (phase 8): the claim is two balanced legs on the journal, the
       same movement chip_transactions records one-sidedly below. */
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, description, idempotency_key, metadata)
    VALUES
      (v_actor, 'club_treasury', p_club_id, 'player_wallet', v_actor,
       round(v_amount, 2), 'commission', p_club_id,
       'Agent claimed commission from the club bank',
       'agent_claim:' || v_op_id::text,
       jsonb_build_object('op_id', v_op_id, 'rows_settled', v_rows,
                          'bank_after', v_bank_after,
                          'agent_balance_after', v_to_after))
    ON CONFLICT DO NOTHING;

    $leg$;
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'fn_agent_claim_commission';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fn_agent_claim_commission does not exist';
  END IF;

  IF position('INSERT INTO public.chip_ledger' IN v_def) > 0 THEN
    RAISE NOTICE 'the claim already writes a journal leg; nothing to do';
    RETURN;
  END IF;

  v_hits := array_length(string_to_array(v_def, v_anchor), 1) - 1;
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'claim anchor expected exactly once, found %', v_hits;
  END IF;

  EXECUTE replace(v_def, v_anchor, v_leg || v_anchor);
END
$migrate_claim$;

/* Assert the postcondition against the live catalogue. */
DO $assert$
DECLARE r2 text; cl text;
BEGIN
  SELECT prosrc INTO r2 FROM pg_proc
   WHERE proname = 'fn_settle_round2_club_to_agents' AND pronamespace = 'public'::regnamespace;
  SELECT prosrc INTO cl FROM pg_proc
   WHERE proname = 'fn_agent_claim_commission' AND pronamespace = 'public'::regnamespace;

  IF r2 IS NULL OR cl IS NULL THEN
    RAISE EXCEPTION 'a commission payer went missing during the rewrite';
  END IF;
  IF r2 !~ 'INSERT INTO public\.chip_ledger' THEN
    RAISE EXCEPTION 'round 2 still pays without a journal leg';
  END IF;
  IF cl !~ 'INSERT INTO public\.chip_ledger' THEN
    RAISE EXCEPTION 'the agent claim still pays without a journal leg';
  END IF;
  -- the payers must keep doing everything else they did
  IF r2 !~ 'agent_commission_settlements' OR r2 !~ 'fn_debit_treasury' THEN
    RAISE EXCEPTION 'round 2 lost its settlement row or its treasury debit';
  END IF;
  IF cl !~ 'agent_commission_settlements' OR cl !~ 'chip_transactions' THEN
    RAISE EXCEPTION 'the claim lost its settlement row or its transaction record';
  END IF;
END
$assert$;

COMMIT;
