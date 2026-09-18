SELECT pg_temp.assert(fn_pnl_cash_hand_evidence('20000000-0000-4000-8000-000000000001',1000004)->>'status'='blocked',
 'Legacy accepted roster cannot become an original dealt population');
SELECT pg_temp.assert(fn_pnl_cash_hand_evidence('20000000-0000-4000-8000-000000000001',9999999)->>'status'='blocked',
 'Absent accepted hand cannot qualify');
SELECT 'PASS original cash PNL consumer: signed independent oracle, full roster, exact hashes and broken-link refusal';
