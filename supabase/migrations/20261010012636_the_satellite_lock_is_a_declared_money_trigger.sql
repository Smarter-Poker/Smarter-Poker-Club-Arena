-- the_satellite_lock_is_a_declared_money_trigger
--
-- Completes migration 20261010012144 a_satellite_completes_only_with_its_settlement_receipt
-- (approved for production by Dan 2026-10-09, "Yes, apply all 3"). That
-- migration created the constraint trigger satellite_completed_requires_settlement_receipt
-- on public.tournaments, one of the tables fn_undeclared_money_triggers()
-- watches, without its row in ca_declared_money_triggers, so
-- poker_money_undeclared_triggers counted it and UndeclaredTriggerOnAMoneyTable
-- would have read it as unreviewed. This is that declaration, and the proof
-- that the register no longer lists it. No money moves; no trigger changes.
BEGIN;
SET LOCAL lock_timeout = '5s';

INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)
VALUES ('tournaments', 'satellite_completed_requires_settlement_receipt',
  'Deferred constraint trigger from migration a_satellite_completes_only_with_its_settlement_receipt (2026-10-09): a satellite may become COMPLETED only with its tournament_satellite_settlements receipt and closed source escrow, checked at COMMIT. Satellite twin of non_satellite_completed_requires_terminal_receipt. It moves no money; it refuses a completion that would leave the field unpaid.')
ON CONFLICT DO NOTHING;

DO $prove$
BEGIN
  IF EXISTS (SELECT 1 FROM public.fn_undeclared_money_triggers() u
              WHERE u.trigger_name = 'satellite_completed_requires_settlement_receipt') THEN
    RAISE EXCEPTION 'SATELLITE_LOCK_STILL_UNDECLARED';
  END IF;
END
$prove$;

COMMIT;