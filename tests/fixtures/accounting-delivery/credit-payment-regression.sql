SELECT set_config('test.engine','false',false);
SELECT set_config('test.uid','10000000-0000-0000-0000-000000000002',false);
INSERT INTO credit_invoices(id,agent_id,period_start,period_end,debt_owed,due_date)
 VALUES('70000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','2026-09-07','2026-09-14',100,'2026-09-17');
CREATE FUNCTION fixture_pay(numeric,uuid DEFAULT '80000000-0000-0000-0000-000000000001',text DEFAULT 'wallet',text DEFAULT NULL)
 RETURNS jsonb LANGUAGE sql AS $$SELECT fn_process_credit_invoice_payment('70000000-0000-0000-0000-000000000001',$1,$3,$2,$4)$$;
SELECT assert_true(fixture_pay(101)->>'reason'='amount_exceeds_remaining','overpayment is refused before a debit');
SELECT assert_true(fixture_pay('NaN')->>'reason'='invalid_payment' AND fixture_pay('Infinity')->>'reason'='invalid_payment'
 AND fixture_pay(1.001)->>'reason'='invalid_payment' AND fixture_pay(NULL)->>'reason'='invalid_payment','nonfinite unknown and fractional-cent amounts are refused');
SELECT assert_true(fixture_pay(1,'80000000-0000-0000-0000-000000000001','diamonds')->>'reason'='unsupported_payment_method','unsupported diamond conversion cannot forgive chip debt');
SELECT assert_true(refuses($$SELECT fixture_pay(1,'80000000-0000-0000-0000-000000000001','external','bank-1')$$,'42501'),'debtor cannot attest their own external payment');
SELECT set_config('test.uid','10000000-0000-0000-0000-000000000001',false);
SELECT assert_true(refuses($$SELECT fixture_pay(1)$$,'42501'),'club owner cannot spend the agent wallet');
SELECT set_config('test.uid','10000000-0000-0000-0000-000000000003',false);
SELECT assert_true(refuses($$SELECT fixture_pay(1,'80000000-0000-0000-0000-000000000001','external','bank-1')$$,'42501'),'another club cannot forgive this debt');
SELECT set_config('test.uid','10000000-0000-0000-0000-000000000002',false);
SELECT set_config('app.ledger_club_id','20000000-0000-0000-0000-000000000002',false);
SELECT assert_true((fixture_pay(5.04)->>'ok')::boolean,'actual agent user can pay its invoice despite different agents primary key');
SELECT assert_true((SELECT chip_balance=94.96 FROM club_members WHERE club_id='20000000-0000-0000-0000-000000000001')
 AND (SELECT chip_balance=1000 FROM club_members WHERE club_id='20000000-0000-0000-0000-000000000002'),'only the invoice club wallet pays');
SELECT assert_true(current_setting('app.ledger_club_id')='20000000-0000-0000-0000-000000000002','caller ledger context is restored');
SELECT assert_true((SELECT credit_used=94.96 FROM agents) AND (SELECT amount_remaining=94.96 AND amount_paid=5.04 FROM credit_invoices),'wallet debit equals invoice payment and drawn debt reduction');
SELECT assert_true((fixture_pay(5.04)->>'duplicate')::boolean AND (SELECT count(*)=1 FROM credit_payments)
 AND (SELECT count(*)=1 FROM fixture_credit_debits),'same operation returns its receipt without paying twice');
SELECT assert_true(fixture_pay(4)->>'reason'='operation_conflict','operation identity cannot be reused with another amount');
SELECT assert_true((fixture_pay(5.04,'80000000-0000-0000-0000-000000000002')->>'ok')::boolean,'separate intentional equal partial payments remain possible');
SELECT assert_true((SELECT count(*)=2 FROM credit_payments),'separate payment creates a separate receipt');
CREATE FUNCTION fixture_credit_delivery_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF current_setting('test.fail_delivery',true)='true' THEN RAISE EXCEPTION 'injected notification failure';END IF;RETURN NEW;END$$;
CREATE TRIGGER fixture_credit_fail BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION fixture_credit_delivery_failure();
SELECT set_config('test.fail_delivery','true',false);
SELECT assert_true(refuses($$SELECT fixture_pay(10,'80000000-0000-0000-0000-000000000003')$$,'P0001'),'notification failure aborts the payment');
SELECT set_config('test.fail_delivery','false',false);
SELECT assert_true((SELECT credit_used=89.92 FROM agents) AND (SELECT amount_remaining=89.92 FROM credit_invoices)
 AND (SELECT count(*)=2 FROM credit_payments) AND (SELECT count(*)=2 FROM fixture_credit_debits),'failed delivery rolls back debit debt payment and documents');
SELECT assert_true((fn_apply_credit_payment('70000000-0000-0000-0000-000000000001',1,'wallet')->>'ok')::boolean,'legacy apply cannot mark a wallet payment without charging it');
SELECT assert_true((fn_apply_credit_payment('70000000-0000-0000-0000-000000000001',1,'wallet')->>'duplicate')::boolean,'legacy retry shares the same operation');
SELECT set_config('test.uid','10000000-0000-0000-0000-000000000001',false);
SELECT assert_true(fixture_pay(10,'80000000-0000-0000-0000-000000000004','external')->>'reason'='payment_reference_required','external payment requires evidence reference');
SELECT assert_true((fixture_pay(10,'80000000-0000-0000-0000-000000000004','external','bank-1')->>'ok')::boolean,'receiving club records referenced external payment');
SELECT assert_true((fixture_pay(10,'80000000-0000-0000-0000-000000000005','external','bank-1')->>'duplicate')::boolean,'same external reference cannot repay twice under a new operation key');
SELECT assert_true((SELECT count(*)=3 FROM fixture_credit_debits),'external payment performs no wallet debit');
SELECT set_config('test.uid','10000000-0000-0000-0000-000000000002',false);
UPDATE credit_invoices SET status='disputed';
SELECT assert_true(fixture_pay(1,'80000000-0000-0000-0000-000000000006')->>'reason'='invoice_not_payable','disputed invoice requires resolution before payment');
UPDATE credit_invoices SET status='partial',amount_remaining=79;
SELECT assert_true(refuses($$SELECT fixture_pay(1,'80000000-0000-0000-0000-000000000006')$$,'23514'),'contradictory debt evidence cannot be paid');
UPDATE credit_invoices SET amount_remaining=78.92;
SELECT assert_true((fixture_pay(78.92,'80000000-0000-0000-0000-000000000006')->>'ok')::boolean,'final exact balance can be paid');
SELECT assert_true((SELECT credit_used=0 FROM agents) AND (SELECT amount_remaining=0 AND amount_paid=100 AND status='paid' FROM credit_invoices)
 AND (SELECT status='paid' FROM settlement_invoices WHERE source_credit_invoice_id IS NOT NULL),'debt and original invoice reach paid together');
SELECT assert_true((fixture_pay(78.92,'80000000-0000-0000-0000-000000000006')->>'duplicate')::boolean,'full payment retry returns the original receipt after invoice is paid');
SELECT assert_true((SELECT count(*)=6 FROM settlement_invoices) AND (SELECT count(*)=12 FROM accounting_invoice_deliveries),'every original invoice and payment has one document and both deliveries');
