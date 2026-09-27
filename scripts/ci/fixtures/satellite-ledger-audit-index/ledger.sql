-- Disposable local data only. Start from the same exact full-audit fixture.
ALTER TABLE chip_ledger ALTER COLUMN amount TYPE numeric(15,2);
ALTER TABLE chip_ledger ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX idx_chip_ledger_from_entity_created ON chip_ledger(from_entity_id,created_at DESC);
CREATE UNIQUE INDEX ux_chip_ledger_idempotency_key ON chip_ledger(idempotency_key) WHERE idempotency_key IS NOT NULL;
ALTER TABLE chip_ledger ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON chip_ledger TO authenticated;
CREATE POLICY fixture_own_ledger ON chip_ledger TO authenticated USING(from_entity_id::text=current_setting('fixture.uid',true));
-- Positive, negative, NULL amount and false-positive text/category/type cases.
INSERT INTO chip_ledger(from_type,from_entity_id,category,idempotency_key,amount) VALUES
 ('prize_liability',u(4),'tournament_buyin','tourney:'||u(4)::text||':seat:2:pool_transfer',7.25),
 ('prize_liability',u(4),'tournament_buyin','tourney:'||u(4)::text||':seat:3:pool_transfer',-2.50),
 ('prize_liability',u(4),'tournament_buyin','tourney:'||u(4)::text||':seat:4:pool_transfer',NULL),
 ('player_wallet',u(4),'tournament_buyin','tourney:'||u(4)::text||':seat:5:pool_transfer',999),
 ('prize_liability',u(4),'other','tourney:'||u(4)::text||':seat:6:pool_transfer',999),
 ('prize_liability',u(4),'tournament_buyin','tourney:'||u(3)::text||':seat:7:pool_transfer',999),
 ('prize_liability',u(4),'tournament_buyin','tourney:'||u(4)::text||':seat:8:pool_transfer_extra',999),
 ('prize_liability',u(4),'tournament_buyin',NULL,999);
-- Dense unrelated entity history reproduces why a broad entity index is costly.
INSERT INTO chip_ledger(from_type,from_entity_id,category,idempotency_key,amount)
SELECT 'player_wallet',CASE WHEN n%3=0 THEN u(4) ELSE u(10000+n%40) END,
 'cash_hand','unrelated:'||n,1 FROM generate_series(1,150000)n;
VACUUM ANALYZE chip_ledger;
