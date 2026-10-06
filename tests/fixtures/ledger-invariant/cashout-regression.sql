\set ON_ERROR_STOP on
-- Each refusal subtransaction rolls back both custody and ledger changes.
SELECT pg_temp.expect_refused('cashout custody without its leg',
 $$INSERT INTO chip_escrow VALUES ('cc000000-0000-4000-8000-000000000001',10.25,NULL)$$,
 'cashout_escrow:cc000000-0000-4000-8000-000000000001');
SELECT pg_temp.expect_refused('cashout leg without custody',
 $$INSERT INTO chip_ledger(from_type,to_type,to_entity_id,amount,category)
 VALUES('system_mint','escrow','cc000000-0000-4000-8000-000000000001',10.25,'escrow_hold')$$,
 'cashout_escrow:cc000000-0000-4000-8000-000000000001');
SELECT pg_temp.expect_refused('cashout amount mismatch',
 $$INSERT INTO chip_escrow VALUES ('cc000000-0000-4000-8000-000000000001',10.25,NULL);
 INSERT INTO chip_ledger(from_type,to_type,to_entity_id,amount,category)
 VALUES('system_mint','escrow','cc000000-0000-4000-8000-000000000001',10.24,'escrow_hold')$$,
 'cashout_escrow:cc000000-0000-4000-8000-000000000001');
SELECT pg_temp.expect_refused('one cashout cannot cover another escrow',
 $$INSERT INTO chip_escrow VALUES ('cc000000-0000-4000-8000-000000000001',10.25,NULL);
 INSERT INTO chip_ledger(from_type,to_type,to_entity_id,amount,category)
 VALUES('system_mint','escrow','cc000000-0000-4000-8000-000000000002',10.25,'escrow_hold')$$,
 'cashout_escrow:cc000000-0000-4000-8000-000000000001');
-- The canonical writer writes its leg BEFORE its escrow row. Both orders work.
BEGIN;
INSERT INTO chip_ledger(from_type,to_type,to_entity_id,amount,category)
 VALUES('system_mint','escrow','cc000000-0000-4000-8000-000000000001',10.25,'escrow_hold');
INSERT INTO chip_escrow VALUES ('cc000000-0000-4000-8000-000000000001',10.25,NULL);
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;
SELECT pg_temp.expect_refused('held cashout cannot vanish',
 $$DELETE FROM chip_escrow WHERE id='cc000000-0000-4000-8000-000000000001'$$,
 'cashout_escrow:cc000000-0000-4000-8000-000000000001');
SELECT pg_temp.expect_refused('released cashout requires its release leg',
 $$UPDATE chip_escrow SET released_at=now() WHERE id='cc000000-0000-4000-8000-000000000001'$$,
 'cashout_escrow:cc000000-0000-4000-8000-000000000001');
BEGIN;
INSERT INTO chip_ledger(from_type,from_entity_id,to_type,amount,category)
 VALUES('escrow','cc000000-0000-4000-8000-000000000001','system_burn',10.25,'escrow_release');
UPDATE chip_escrow SET released_at=now() WHERE id='cc000000-0000-4000-8000-000000000001';
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;
-- Original ticket float stays covered and cannot pay for cashout custody.
SELECT pg_temp.expect_refused('ticket leg cannot stand in for cashout hold',
 $$INSERT INTO chip_escrow VALUES ('cc000000-0000-4000-8000-000000000003',5,NULL);
 INSERT INTO chip_ledger(from_type,to_type,to_entity_id,amount,category)
 VALUES('system_mint','escrow','cc000000-0000-4000-8000-000000000003',5,'ticket_issued')$$,
 'ticket_escrow');
SELECT pg_temp.expect_refused('ticket custody still needs its original leg',
 $$INSERT INTO tournament_tickets(id,value,status) VALUES('cc000000-0000-4000-8000-000000000004',7,'issued')$$,
 'ticket_escrow');
BEGIN;
INSERT INTO tournament_tickets(id,value,status) VALUES('cc000000-0000-4000-8000-000000000004',7,'issued');
INSERT INTO chip_ledger(from_type,to_type,to_entity_id,amount,category)
 VALUES('system_mint','escrow','cc000000-0000-4000-8000-000000000004',7,'ticket_issued');
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;
DO $$ BEGIN
 IF (SELECT sum(amount) FROM chip_escrow WHERE released_at IS NULL) IS NOT NULL
 OR (SELECT value FROM tournament_tickets WHERE id='cc000000-0000-4000-8000-000000000004') <> 7
 THEN RAISE EXCEPTION 'cashout or ticket final state differs'; END IF;
END $$;
