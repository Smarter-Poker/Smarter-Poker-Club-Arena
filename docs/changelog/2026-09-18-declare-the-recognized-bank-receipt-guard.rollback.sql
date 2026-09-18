-- Rollback for 20260918041452_declare_the_recognized_bank_receipt_guard.sql
--
-- Removes only the declaration row this migration wrote. The trigger itself
-- belongs to the accounting release and is not touched here; dropping it would
-- leave a recognized tournament fee's bank receipt rewritable, which is the
-- opposite of what a rollback of a DECLARATION should do.
--
-- After this runs, fn_undeclared_money_triggers() reports
-- chip_ledger.accounting_tournament_recognized_bank_immutable again and
-- UndeclaredTriggerOnAMoneyTable fires again, which is the state this
-- migration was written to end.

BEGIN;

DELETE FROM public.ca_declared_money_triggers
 WHERE table_name = 'chip_ledger'
   AND trigger_name = 'accounting_tournament_recognized_bank_immutable';

DO $post$
DECLARE
  v_rows integer;
BEGIN
  SELECT count(*) INTO v_rows
    FROM public.ca_declared_money_triggers
   WHERE table_name = 'chip_ledger'
     AND trigger_name = 'accounting_tournament_recognized_bank_immutable';
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'rollback: the declaration row is still present';
  END IF;
END
$post$;

COMMIT;
