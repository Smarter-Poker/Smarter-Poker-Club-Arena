SET request.jwt.claims='{"role":"service_role","sub":"00000000-0000-0000-0000-000000000900"}';
-- The current setting differs intentionally. Closed original terms still
-- govern the old period and must not be skipped by a current-state gate.
UPDATE unions SET settings=settings||'{"eco_enabled":false}' WHERE id=fixture.u(201);
DO $$ DECLARE result jsonb; replay jsonb; invoices bigint; deliveries bigint; BEGIN
 result:=fn_union_settlement_cascade(fixture.u(201),'2026-09-07 07:00Z','2026-09-14 07:00Z');
 PERFORM fixture.assert(result->>'success'='true','Actual full original Union cascade closes the qualified week: '||result::text);
 PERFORM fixture.assert(result#>>'{eco_recorded,success}'='true','Cascade uses original ECO terms after today settings change');
 PERFORM fixture.assert((SELECT count(*)=4 FROM union_settlement_rounds WHERE union_id=fixture.u(201)),'All four original settlement rounds retain their receipts');
 PERFORM fixture.assert((SELECT count(*)=2 FROM accounting_routed_settlement_runs WHERE union_id=fixture.u(201)),'Both original downstream payout stages retain complete receipts');
 PERFORM fixture.assert((SELECT count(*)=2 AND bool_and(message_sent) FROM settlement_invoices WHERE invoice_type='club_weekly_accounting'),'Each club receives one delivered weekly summary');
 PERFORM fixture.assert((SELECT count(*)=2 AND bool_and(message_sent) FROM settlement_invoices WHERE invoice_type='union_weekly_squareup'),'Each club receives one delivered Union invoice');
 SELECT count(*) INTO invoices FROM settlement_invoices;
 SELECT count(*) INTO deliveries FROM accounting_invoice_deliveries;
 replay:=fn_union_settlement_cascade(fixture.u(201),'2026-09-07 07:00Z','2026-09-14 07:00Z');
 PERFORM fixture.assert(replay->>'success'='true' AND invoices=(SELECT count(*) FROM settlement_invoices) AND deliveries=(SELECT count(*) FROM accounting_invoice_deliveries),'Full cascade replay creates no duplicate invoice or message delivery');
END $$;
