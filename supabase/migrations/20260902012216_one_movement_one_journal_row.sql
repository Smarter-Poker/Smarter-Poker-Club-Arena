-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902012216; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- back_fund_the_six_unfunded_guarantees wrote its own chip_ledger rows for
-- each back-payment. It should not have: the balance writes it made are
-- already auto-journalled by fn_ca_autoledger, and because the migration had
-- correctly declared app.ledger_category='overlay' and
-- app.ledger_counterparty='prize_liability' first, the automatic rows came out
-- perfectly categorised.
--
-- The result was two journal rows for one movement. Verified 1:1 before
-- touching anything: 46 explicit rows and 46 automatic rows, every explicit
-- one matched by an automatic row with the same recipient and the same amount,
-- both totalling 1,703.00.
--
-- This does not affect the supply measure - neither prize_liability nor
-- player_wallet is a non-circulating store, so the rows contribute nothing to
-- mint or burn - but a journal with two entries for one movement is exactly
-- the hygiene this whole sweep exists to enforce, and it would mislead the
-- first person who summed it.
--
-- atomic_distribute_rake already shows the right pattern: it sets
-- app.ledger_autoskip_clubs before its explicit write so the auto-journal
-- stands down for that statement. The lesson for anyone writing a money
-- migration here: DECLARE the category and let the auto-journal do it, or
-- suppress the auto-journal and write it yourself. Never both.
--
-- Removed through the sanctioned maintenance path so the deletion is recorded
-- in ca_ledger_mutation_log rather than being a quiet edit of an append-only
-- journal.

DO $cleanup$
DECLARE v_n int;
BEGIN
  PERFORM set_config('app.ledger_maintenance',
    'duplicate-journal-cleanup: back_fund_the_six_unfunded_guarantees wrote explicit rows for balance writes the auto-journal had already recorded 1:1', true);

  DELETE FROM public.chip_ledger
   WHERE description LIKE 'Guarantee overlay back-payment (main bank)%'
      OR description LIKE 'Main bank funding six guarantee overlays%';
  GET DIAGNOSTICS v_n = ROW_COUNT;

  PERFORM set_config('app.ledger_maintenance', '', true);
  RAISE NOTICE 'removed % duplicate journal rows', v_n;
END $cleanup$;

