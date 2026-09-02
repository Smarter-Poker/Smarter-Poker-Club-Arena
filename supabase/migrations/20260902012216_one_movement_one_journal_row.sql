-- back_fund_the_six_unfunded_guarantees wrote its own chip_ledger rows for
-- each back-payment. It should not have: the balance writes it made are
-- already auto-journalled by fn_ca_autoledger, and because the migration had
-- correctly declared app.ledger_category='overlay' and
-- app.ledger_counterparty='prize_liability' first, the automatic rows came out
-- perfectly categorised.
--
-- Two journal rows for one movement. Verified 1:1 before touching anything:
-- 46 explicit and 46 automatic, every explicit row matched by an automatic row
-- with the same recipient and amount, both totalling 1,703.00.
--
-- It does not affect the supply measure - neither prize_liability nor
-- player_wallet is a non-circulating store, so they contribute nothing to mint
-- or burn - but a journal with two entries for one movement is exactly the
-- hygiene this sweep exists to enforce, and it would mislead whoever summed it.
--
-- THE RULE FOR ANYONE WRITING A MONEY MIGRATION HERE: declare the category and
-- let the auto-journal record it, OR suppress the auto-journal
-- (app.ledger_autoskip_*, as atomic_distribute_rake does) and write the row
-- yourself. Never both.

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
