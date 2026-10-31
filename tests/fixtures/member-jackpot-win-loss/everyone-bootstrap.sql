ALTER TABLE bbj_payouts ADD metadata jsonb;
ALTER TABLE hand_history ADD table_id uuid, ADD hand_number bigint, ADD source text;
ALTER TABLE tables ADD game_variant text, ADD game_type text;
ALTER TABLE chip_ledger ADD idempotency_key text, ADD category text;
UPDATE tables SET game_variant='plo5';
-- A departed recipient has no retained hand/fact, but an original wallet credit.
INSERT INTO bbj_payouts(id,table_id,kind,metadata) VALUES
 ('90000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','mini','{"variant":"plo5"}');
INSERT INTO bbj_payout_recipients VALUES('90000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002',25,now());
INSERT INTO chip_ledger(club_id,to_entity_id,to_type,amount,status,category,idempotency_key) VALUES
 ('10000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002','player_wallet',25,'posted','bbj_payout','bbj:90000000-0000-0000-0000-000000000001:20000000-0000-0000-0000-000000000002');
-- Explicit display-only seed, joined by table/hand number when hand_id is absent.
INSERT INTO hand_history(id,table_id,hand_number,source,game_variant) VALUES
 ('60000000-0000-0000-0000-000000000009','30000000-0000-0000-0000-000000000001',999,'seed','nlh');
INSERT INTO bbj_payouts(id,table_id,hand_number,kind) VALUES
 ('90000000-0000-0000-0000-000000000009','30000000-0000-0000-0000-000000000001',999,'main');
INSERT INTO bbj_payout_recipients VALUES('90000000-0000-0000-0000-000000000009','20000000-0000-0000-0000-000000000002',1000000,now());
