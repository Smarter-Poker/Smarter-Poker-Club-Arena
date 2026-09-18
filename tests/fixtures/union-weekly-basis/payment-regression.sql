SET request.jwt.claims='{"role":"service_role","sub":"00000000-0000-0000-0000-000000000900"}';
DO $$ DECLARE result jsonb; replay jsonb; fingerprint text; BEGIN
 result:=fn_union_settle_player_pnl(fixture.u(201),'2026-09-07 07:00Z','2026-09-14 07:00Z',false);
 PERFORM fixture.assert(result->>'success'='true','Original payer closes the certified week: '||result::text);
 PERFORM fixture.assert((result->>'total_collected')::numeric=10 AND (result->>'total_paid')::numeric=10 AND (result->>'total_unpaid')::numeric=0,'Original payer settles exact full obligations');
 PERFORM fixture.assert((SELECT chip_treasury=990 FROM clubs WHERE id=fixture.u(101)) AND (SELECT chip_treasury=1010 FROM clubs WHERE id=fixture.u(102)) AND (SELECT chip_balance=1000 FROM union_wallets WHERE union_id=fixture.u(201)),'All payer balances reconcile');
 PERFORM fixture.assert((SELECT count(*)=2 FROM chip_ledger WHERE category='pnl_settlement'),'Each original obligation produces one posted ledger');
 PERFORM fixture.assert((SELECT count(*)=2 AND bool_and(i.status='paid' AND i.chips_transferred AND i.message_sent) FROM settlement_invoices i JOIN chip_ledger l ON l.id=i.source_ledger_id WHERE l.category='pnl_settlement'),'Every payment produces an actually delivered paid invoice');
 PERFORM fixture.assert((SELECT count(*)>=2 AND count(*)=count(m.id) AND count(*)=count(n.id) FROM accounting_invoice_deliveries d JOIN settlement_invoices i ON i.id=d.invoice_id JOIN chip_ledger l ON l.id=i.source_ledger_id LEFT JOIN social_messages m ON m.id=d.message_id LEFT JOIN notifications n ON n.id=d.notification_id WHERE l.category='pnl_settlement'),'Every invoice delivery binds the actual Messenger message and notification');
 SELECT md5(jsonb_build_array((SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM chip_ledger x),(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM settlement_invoices x),(SELECT jsonb_agg(to_jsonb(x) ORDER BY invoice_id,recipient_id) FROM accounting_invoice_deliveries x))::text) INTO fingerprint;
 replay:=fn_union_settle_player_pnl(fixture.u(201),'2026-09-07 07:00Z','2026-09-14 07:00Z',false);
 PERFORM fixture.assert(replay->>'already_settled'='true','Original payer replay returns the committed settlement');
 PERFORM fixture.assert(fingerprint=(SELECT md5(jsonb_build_array((SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM chip_ledger x),(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM settlement_invoices x),(SELECT jsonb_agg(to_jsonb(x) ORDER BY invoice_id,recipient_id) FROM accounting_invoice_deliveries x))::text)),'Payer replay creates no duplicate payment, invoice, Messenger message or notification');
END $$;
