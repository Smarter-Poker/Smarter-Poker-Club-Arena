-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830214622; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Remove nine chip_ledger rows I wrote that the trigger had already written.
--
-- MY MISTAKE, found by the platform's own check. When I reversed the 20,880
-- paid out by the tournament that never finished
-- (20260830_reverse_dfae9288_dead_run_payouts_v2), I updated
-- club_members.chip_balance AND inserted an explicit chip_ledger row for each
-- of the nine finishers. But fn_club_members_ledger_writer already records
-- EVERY balance delta, so the trigger wrote nine auto-audited rows for the same
-- movement. The ledger therefore says 20,880 left those wallets twice, while
-- the wallets only moved once.
--
-- fn_chip_drift_since_baseline() — the forward-looking check established on
-- 2026-08-27 when the pre-baseline gap was deliberately drawn a line under —
-- reported exactly this: 9 rows of drift, net 20,880.00, worst 6,264.00, and
-- nothing else in 1,502 rows. That is the check doing its job on my work.
--
-- The trigger's rows are the canonical record and are kept. Mine are deleted:
-- they are the redundant copy, and a duplicate in an audit trail is worse than
-- a terse one, because it makes the ledger disagree with the money.
--
-- NO CHIPS MOVE HERE. Balances are already correct; only the double-count in
-- the ledger is removed. Asserted both ways below.
--
-- The lesson, recorded because the next person will hit it: with this trigger
-- in place, a migration that moves chips must NOT also write chip_ledger. It
-- names the movement with set_config('app.ledger_category', ...) and lets the
-- trigger record it. The repayment migration later the same day did exactly
-- that and produced no drift.

DO $$
DECLARE
  v_rows    int;
  v_chips   numeric;
  v_drift0  numeric;
  v_drift1  numeric;
  v_bal0    numeric;
  v_bal1    numeric;
BEGIN
  SELECT coalesce(sum(chip_balance),0) INTO v_bal0 FROM public.club_members;

  SELECT coalesce(sum(drift),0) INTO v_drift0
    FROM public.fn_chip_drift_since_baseline() WHERE round(drift,2) <> 0;

  SELECT count(*), coalesce(sum(amount),0) INTO v_rows, v_chips
    FROM public.chip_ledger
   WHERE description = 'reversal: dfae9288 dead-run payout returned to treasury';

  IF v_rows = 0 THEN
    RAISE NOTICE 'Duplicates already removed — no-op.';
    RETURN;
  END IF;

  IF v_rows <> 9 OR round(v_chips,2) <> 20880.00 THEN
    RAISE EXCEPTION 'Expected 9 duplicate rows totalling 20880.00, found % totalling %', v_rows, v_chips;
  END IF;

  -- Every one must have a surviving auto-audited twin, or it is not a duplicate
  -- and must not be deleted.
  IF EXISTS (
    SELECT 1
    FROM public.chip_ledger mine
    WHERE mine.description = 'reversal: dfae9288 dead-run payout returned to treasury'
      AND NOT EXISTS (
        SELECT 1 FROM public.chip_ledger auto
         WHERE auto.description LIKE 'auto-audited club_members.chip_balance delta -%'
           AND auto.from_entity_id = mine.from_entity_id
           AND auto.club_id        = mine.club_id
           AND auto.amount         = mine.amount
           AND auto.created_at BETWEEN mine.created_at - interval '10 minutes'
                                   AND mine.created_at + interval '10 minutes'
      )
  ) THEN
    RAISE EXCEPTION 'A reversal row has no auto-audited twin — refusing to delete a unique record';
  END IF;

  DELETE FROM public.chip_ledger
   WHERE description = 'reversal: dfae9288 dead-run payout returned to treasury';

  -- Balances must be untouched.
  SELECT coalesce(sum(chip_balance),0) INTO v_bal1 FROM public.club_members;
  IF v_bal1 <> v_bal0 THEN
    RAISE EXCEPTION 'Balances moved (% -> %) — this migration must move no chips', v_bal0, v_bal1;
  END IF;

  -- And the drift the check reported must be gone.
  SELECT coalesce(sum(drift),0) INTO v_drift1
    FROM public.fn_chip_drift_since_baseline() WHERE round(drift,2) <> 0;
  IF round(v_drift1,2) <> 0 THEN
    RAISE EXCEPTION 'Drift is still % after removing the duplicates (was %)', v_drift1, v_drift0;
  END IF;

  RAISE NOTICE 'Removed % duplicate ledger rows; drift % -> 0; balances unchanged.', v_rows, v_drift0;
END $$;
