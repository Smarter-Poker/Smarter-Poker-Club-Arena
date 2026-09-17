-- Representative indexes present on production source authorities. This is
-- a bounded-volume plan test, not a claim of production throughput.
CREATE INDEX ON accounting_cash_rake_sources(rake_record_id,player_id);
CREATE INDEX ON accounting_cash_rake_sources(union_id,earned_at);
CREATE INDEX ON accounting_cash_bank_receipts(union_id,banked_at);
CREATE INDEX ON accounting_tournament_fee_sources(tournament_id);
CREATE INDEX ON accounting_tournament_recognized_sources(tournament_id,recognized_at);
CREATE INDEX ON union_wallet_transactions(union_id,created_at);
CREATE INDEX ON accounting_agreement_history(entity_type,entity_key,observed_at DESC,id DESC);
INSERT INTO rake_records SELECT u(100000+n),u(200000+n),u(1),20,'2026-09-12T12:00Z',false,NULL FROM generate_series(1,1000)n;
INSERT INTO union_wallet_transactions(id,union_id,amount,tx_type,wallet,direction,created_at)
 SELECT u(300000+n),u(1),20,'rake','rake_wallet','credit','2026-09-12T12:00Z' FROM generate_series(1,1000)n;
INSERT INTO accounting_cash_bank_receipts SELECT u(100000+n),u(1),u(1),u(300000+n),NULL,'2026-09-12T12:00Z',20 FROM generate_series(1,1000)n;
INSERT INTO accounting_cash_accrual_batches SELECT u(100000+n),'2026-09-12T12:00Z','accrued' FROM generate_series(1,1000)n;
INSERT INTO accounting_cash_rake_sources SELECT u(400000+n*20+p),u(100000+n),u(500000+p),u(2),u(1),u(1),'2026-09-12T12:00Z',1,contract(2,500000+p,1,'2026-09-12T12:00Z',2)
 FROM generate_series(1,1000)n CROSS JOIN generate_series(1,20)p;
ANALYZE;
SET statement_timeout='20s';
\timing on
SELECT assert_true((plan()->>'period_rake')::numeric=20350 AND (SELECT sum((d->>'payout')::numeric)=16245 FROM jsonb_array_elements(plan()->'basis_detail')d),'20,000 additional sources match 1,000 bank deposits with exact aggregate cents');
\timing off
