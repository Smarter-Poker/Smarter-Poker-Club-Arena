SET request.jwt.claims='{"role":"service_role","sub":"00000000-0000-0000-0000-000000000900"}';
DO $$ DECLARE result jsonb; BEGIN
 result:=fn_union_pnl_evidence_report(fixture.u(201),'2026-08-31 07:00Z','2026-09-07 07:00Z');
 PERFORM fixture.assert(result->>'status'='blocked' AND result->'issues' ? 'week_precedes_complete_original_capture','Historical incomplete population cannot qualify');
 BEGIN
  UPDATE union_pnl_cash_outcomes SET evidence=evidence||'{"basis_certified":false}';
  RAISE EXCEPTION 'immutable evidence accepted mutation';
 EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
 PERFORM fixture.assert(NOT has_table_privilege('service_role','union_pnl_cash_outcomes','INSERT') AND NOT has_function_privilege('authenticated','fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)','EXECUTE'),'Original evidence cannot be fabricated through application roles');
END $$;
BEGIN;
UPDATE club_members SET status='left' WHERE user_id=fixture.u(903);
SELECT fixture.assert(fn_union_pnl_evidence_report(fixture.u(201),'2026-09-07 07:00Z','2026-09-14 07:00Z')->>'status'='ready','Later membership change cannot rewrite the original earning club');
ROLLBACK;
BEGIN;
ALTER TABLE union_pnl_cash_outcomes DISABLE TRIGGER original_pnl_immutable;
UPDATE union_pnl_cash_outcomes SET evidence=evidence||'{"basis_certified":false}';
DO $$ BEGIN
 BEGIN
  PERFORM fn_union_settle_player_pnl(fixture.u(201),'2026-09-07 07:00Z','2026-09-14 07:00Z',false);
  RAISE EXCEPTION 'uncertified accepted hand reached payer';
 EXCEPTION WHEN SQLSTATE '55000' THEN
  PERFORM fixture.assert(SQLERRM='union_pnl_basis_uncertified','Incomplete original accepted proof blocks before any money');
 END;
 PERFORM fixture.assert(NOT EXISTS(SELECT 1 FROM union_pnl_settlements),'Uncertified week cannot create a settlement claim');
END $$;
ROLLBACK;
-- Inject a deterministic delivery failure at the real document INSERT, then
-- verify the actual payer's enclosing savepoint restores every monetary leg.
CREATE FUNCTION fixture.refuse_invoice() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'native_invoice_delivery_failure';END$$;
CREATE TRIGGER native_invoice_delivery_failure BEFORE INSERT ON settlement_invoices FOR EACH ROW EXECUTE FUNCTION fixture.refuse_invoice();
DO $$ DECLARE result jsonb; BEGIN
 result:=fn_union_settle_player_pnl(fixture.u(201),'2026-09-07 07:00Z','2026-09-14 07:00Z',false);
 PERFORM fixture.assert(result->>'success'='false' AND result->>'rolled_back'='true' AND result->>'error'='native_invoice_delivery_failure','Actual document failure rolls back the entire payout transaction');
 PERFORM fixture.assert((SELECT bool_and(chip_treasury=1000) FROM clubs) AND (SELECT chip_balance=1000 FROM union_wallets WHERE union_id=fixture.u(201)),'Delivery failure preserves all original balances');
 PERFORM fixture.assert(NOT EXISTS(SELECT 1 FROM chip_ledger WHERE category='pnl_settlement') AND NOT EXISTS(SELECT 1 FROM settlement_invoices),'Delivery failure leaves no payment or partial invoice');
END $$;
DROP TRIGGER native_invoice_delivery_failure ON settlement_invoices;
