-- EVERY LEG THE JOURNAL WAS REFUSED IS WRITTEN BACK.
--
-- ca_ledger_write_failures is the list of moments when a balance moved and the
-- journal row that should have recorded it did not get written. It holds 116
-- rows, and exactly TWO of them had ever been repaired - both by hand, both in
-- early September, both correct. The other 114 sat there. The machinery has
-- existed since Phase 6 - fn_ca_repair_write_failure posts a compensating leg
-- through fn_ca_post_correction, keyed 'correction:lwf:<id>' so it can only ever
-- post once - and almost nobody had called it. A queue with a working drain and
-- no hand on the handle is the same as no queue.
--
-- THE 116, READ ROW BY ROW.
--
--   104  55006 PLATFORM_FROZEN, +9.69   BBJ drops that arrived during the :55
--        maintenance break. The freeze guard refused the journal row while the
--        pool balance write stood. That producer was closed on 2026-09-05 by
--        20260905075122 (the journal is never refused by the freeze) and the
--        newest of these is 06:58 that morning, an hour before it applied.
--        All 104 are increases, one club, every one carrying a user - a drop
--        off the felt. Repaired as table_stack -> bbj_pool.
--
--     1  55P03 lock timeout, +0.13      The same shape, one hour later on a
--        lock rather than the freeze. Same repair.
--
--     8  55P03 lock timeout, -440.00    spin_bonus_pools.balance decreases:
--        spin prizes leaving the reserve. Each row names its player, so each is
--        repaired as spin_reserve -> that player's wallet.
--
--     1  55P03 lock timeout, -10.00     The message names no column, so the
--        store cannot be read from the row. It goes to settlement_suspense,
--        which is what the standard says an undeclared leg is - visible, and
--        still owed a declaration.
--
--     1  40P01 deadlock, +18.00         fn_ca_fund_overlay_on_lock for Late
--        Night PKO (PLO4) 1068cd04. ALREADY REPAIRED on 2026-09-03 15:54 by
--        another agent, union_bank -> prize_liability 18.00. Derived here
--        independently from the tournament's union stamp before the repair was
--        found, and it agrees to the cent. The branch is kept, guarded by the
--        idempotency key, because it costs nothing and documents the reasoning.
--
--     1  23505 duplicate key, 100000.00 ALREADY REPAIRED on 2026-09-01 00:42.
--        Not the shape it looks like from the message: a cert-club owner member
--        credit of 100,000 whose ledger row was refused because a
--        transaction-scoped app.ledger_idempotency_key was inherited by a second
--        row. system_mint -> player_wallet, posted by hand twelve minutes later.
--        Left exactly as it is.
--
--     1  40P01 deadlock, -175.00        A diamond audit insert. A diamond is not
--        a chip and chip_ledger is not its book, so this is left for the diamond
--        programme, which already owns fn_ca_diamond_snapshot on the board. It
--        is the ONE row this migration leaves unrepaired, and the migration
--        asserts that it is the only one.
--
-- No balance is touched by any of this. fn_ca_post_correction writes a
-- chip_ledger row and nothing else, which is exactly right: the money already
-- moved, it is the record of the movement that was lost.

BEGIN;

DO $repair$
DECLARE
  r RECORD;
  v_felt uuid := '00000000-0000-0000-0000-0000000fe17e';
  v_res jsonb;
  v_bbj int := 0; v_spin int := 0; v_susp int := 0; v_over int := 0;
  v_left int;
BEGIN
  -- The repair posts as the platform, through the platform's own path.
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  -- 1 + 2. BBJ drops refused by the freeze or a lock: table_stack -> bbj_pool.
  FOR r IN
    SELECT f.id FROM public.ca_ledger_write_failures f
     WHERE f.message LIKE '%bbj_pools.%' AND f.delta > 0
       AND NOT EXISTS (SELECT 1 FROM public.chip_ledger l
                        WHERE l.idempotency_key = 'correction:lwf:' || f.id)
     ORDER BY f.id
  LOOP
    v_res := public.fn_ca_repair_write_failure(r.id, 'table_stack', v_felt,
      'Compensating leg for a bad beat jackpot drop whose journal row was refused '
      || 'while the pool balance write stood (ca_ledger_write_failures ' || r.id::text
      || '). The drop came off the felt; the chips are already in the pool.');
    IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
      RAISE EXCEPTION 'bbj repair % failed: %', r.id, v_res->>'reason';
    END IF;
    v_bbj := v_bbj + 1;
  END LOOP;

  -- 3. Spin prizes leaving the reserve: spin_reserve -> the player who won it.
  FOR r IN
    SELECT f.id, f.user_id FROM public.ca_ledger_write_failures f
     WHERE f.message LIKE '%spin_bonus_pools.%' AND f.delta < 0 AND f.user_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.chip_ledger l
                        WHERE l.idempotency_key = 'correction:lwf:' || f.id)
     ORDER BY f.id
  LOOP
    v_res := public.fn_ca_repair_write_failure(r.id, 'player_wallet', r.user_id,
      'Compensating leg for a spin prize that left the reserve while its journal row '
      || 'was refused by a lock timeout (ca_ledger_write_failures ' || r.id::text
      || '). The player was paid; only the record was lost.');
    IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
      RAISE EXCEPTION 'spin repair % failed: %', r.id, v_res->>'reason';
    END IF;
    v_spin := v_spin + 1;
  END LOOP;

  -- 4. The one whose store cannot be read goes to suspense, still owed a name.
  FOR r IN
    SELECT f.id FROM public.ca_ledger_write_failures f
     WHERE f.sqlstate = '55P03'
       AND f.message NOT LIKE '%bbj_pools.%'
       AND f.message NOT LIKE '%spin_bonus_pools.%'
       AND NOT EXISTS (SELECT 1 FROM public.chip_ledger l
                        WHERE l.idempotency_key = 'correction:lwf:' || f.id)
     ORDER BY f.id
  LOOP
    v_res := public.fn_ca_repair_write_failure(r.id, 'settlement_suspense', NULL,
      'Compensating leg for a balance write whose journal row was refused by a lock '
      || 'timeout and whose store the failure message does not name '
      || '(ca_ledger_write_failures ' || r.id::text || '). Booked to suspense so the '
      || 'movement is visible; it is still owed a declaration.');
    IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
      RAISE EXCEPTION 'suspense repair % failed: %', r.id, v_res->>'reason';
    END IF;
    v_susp := v_susp + 1;
  END LOOP;

  -- 5. The overlay: union_bank -> prize_liability, which the generic mapping
  --    cannot infer because the failure message names no store.
  IF NOT EXISTS (SELECT 1 FROM public.chip_ledger WHERE idempotency_key = 'correction:lwf:704') THEN
    IF (SELECT count(*) FROM public.chip_ledger
         WHERE tournament_id = '1068cd04-41c8-4168-83cb-243ebe693918'
           AND category = 'overlay') > 0 THEN
      RAISE EXCEPTION 'tournament 1068cd04 now has an overlay leg - do not post a second';
    END IF;
    v_res := public.fn_ca_post_correction(
      'union_bank', 'fade0000-0000-0000-0000-000000000001'::uuid,
      'prize_liability', '1068cd04-41c8-4168-83cb-243ebe693918'::uuid,
      18.00,
      'Compensating leg for the guarantee overlay of Late Night PKO (PLO4). '
      || 'fn_ca_fund_overlay_on_lock debited the union bank and its journal INSERT '
      || 'deadlocked (ca_ledger_write_failures 704, 2026-09-03). The event is not '
      || 'private and its union is fade0000-0000-0000-0000-000000000001, so the bank '
      || 'that paid is the union bank.',
      NULL, 704, 'fade0000-0000-0000-0000-000000000001'::uuid,
      'fade0000-0000-0000-0000-000000000001'::uuid,
      jsonb_build_object('repaired_via', 'migration 20260906023900',
                         'store', 'union_wallets.chip_balance'));
    IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
      RAISE EXCEPTION 'overlay repair failed: %', v_res->>'reason';
    END IF;
    v_over := 1;
  END IF;

  -- What is left must be exactly the two that are not missing legs.
  SELECT count(*) INTO v_left FROM public.fn_ca_unresolved_write_failures();
  IF v_left <> 1 THEN
    RAISE EXCEPTION 'expected 1 row left (the diamond audit, which is not a chip leg), found %', v_left;
  END IF;

  RAISE NOTICE 'WRITE_FAILURES_REPAIRED: % bbj, % spin, % suspense, % overlay; 1 left by design',
    v_bbj, v_spin, v_susp, v_over;
END $repair$;

-- The critical alerts this queue raised are answered.
UPDATE public.financial_alerts
   SET resolved = true, resolved_at = now(),
       resolution = 'verified: the swallowed journal rows were written back by migration '
                 || '20260906023900 through fn_ca_repair_write_failure / fn_ca_post_correction, '
                 || 'each keyed correction:lwf:<id> so it can post only once. No balance was '
                 || 'touched - the money had already moved and it was the record that was lost. '
                 || 'One row remains unrepaired on purpose: a diamond audit insert, which is '
                 || 'not a chip leg and belongs to the diamond programme.'
 WHERE source = 'drift_incident:fn_ca_quick_reconcile:ledger_write_failure'
   AND resolved IS NOT TRUE;

COMMIT;
