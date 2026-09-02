-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827161707; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- THE NIGHTLY RECONCILER HAS BEEN ROLLING BACK, AND WOULD HAVE ROLLED BACK
-- EXACTLY WHEN IT MATTERED. (2026-08-27)
--
-- `ledger_reconcile_log_entity_type_check` allowed five entity_type values:
--   player_wallet, club_treasury, agent_wallet, seat_stack_exit, chip_circulation
--
-- But reconcile_ledger_nightly emits NINE. The four missing ones:
--
--   frozen_wallets_pool    added this morning by the dead-pool refit. It is an
--                          INSERT ... VALUES, so it fires on EVERY run - which
--                          broke the job immediately. No rows were written for
--                          2026-08-27 at all: the 08:00 UTC run raised 23514
--                          and the whole transaction rolled back, taking every
--                          other check down with it. That regression is mine.
--
--   cashout_escrow_stuck   added earlier the same day by the cashier audit.
--   negative_balance       All three are INSERT ... SELECT, so on a healthy
--   over_claimed_send      night they insert ZERO rows and never test the
--                          constraint. They were latent landmines: the FIRST
--                          time a cashout escrow got stuck, a wallet went
--                          negative, or an agent over-claimed a send, that
--                          insert would violate the check, roll back the whole
--                          run, and leave the log silent on the very night a
--                          real money fault appeared. A monitor that fails
--                          closed at the moment of failure is worse than none.
--
-- Fixing both shapes together, because they are the same defect: a function
-- that grew new row kinds while the table's constraint did not.
--
-- Tier 2. No data moves. Rollback: restore the previous CHECK from this file's
-- git history (but note that doing so re-breaks the nightly job).

ALTER TABLE public.ledger_reconcile_log
  DROP CONSTRAINT IF EXISTS ledger_reconcile_log_entity_type_check;

ALTER TABLE public.ledger_reconcile_log
  ADD CONSTRAINT ledger_reconcile_log_entity_type_check
  CHECK (entity_type = ANY (ARRAY[
    -- balance reconciliation
    'player_wallet'::text,
    'club_treasury'::text,
    'agent_wallet'::text,
    -- pool-level invariants
    'frozen_wallets_pool'::text,
    'chip_circulation'::text,
    -- money-leak detectors
    'seat_stack_exit'::text,
    'cashout_escrow_stuck'::text,
    'negative_balance'::text,
    'over_claimed_send'::text
  ]));

-- Post-apply assertion: every entity_type the function can emit must pass the
-- constraint. Asserted by INSERTING one row of each kind inside a transaction
-- that is then rolled back, so the check is proven against the real constraint
-- without leaving a single synthetic row behind.
DO $$
DECLARE
  k text;
  kinds text[] := ARRAY['player_wallet','club_treasury','agent_wallet',
                        'frozen_wallets_pool','chip_circulation','seat_stack_exit',
                        'cashout_escrow_stuck','negative_balance','over_claimed_send'];
BEGIN
  FOREACH k IN ARRAY kinds LOOP
    BEGIN
      INSERT INTO public.ledger_reconcile_log
        (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)
      VALUES (k, NULL, 0, 0, 'ok', jsonb_build_object('probe', true));
    EXCEPTION WHEN check_violation THEN
      RAISE EXCEPTION 'entity_type % still rejected by the check constraint', k;
    END;
  END LOOP;
  -- Remove the probe rows: this DO block shares the migration's transaction,
  -- so a plain DELETE is the cleanup (no synthetic row can survive).
  DELETE FROM public.ledger_reconcile_log WHERE metadata ->> 'probe' = 'true';
END $$;
