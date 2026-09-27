-- Numeric terms, nulls, negative receipts and irrelevant type/category rows.
INSERT INTO tournaments(id,name,club_id,prize_pool,ended_at,status,variant,tournament_type)
SELECT md5('event-'||n)::uuid,'case-'||n,md5('club')::uuid,100,
 now()-make_interval(days=>n/10,secs=>n), 'COMPLETED',NULL,NULL FROM generate_series(1,80)n;
INSERT INTO wallet_transactions(related_entity_id,type,category,amount,user_id)
SELECT id,'debit','tournament_buyin',100,id FROM tournaments;
INSERT INTO wallet_transactions(related_entity_id,type,category,amount,user_id)
SELECT id,x.type,x.category,x.amount,id FROM tournaments CROSS JOIN (VALUES
 ('debit','rebuy',20.001::numeric),('debit','addon',9.994),('credit','refund',4.995),
 ('credit','prize',50),('credit','bounty',2),('debit','refund',500),('credit','rebuy',800),
 ('credit','unrelated',999),('credit','refund',NULL),('credit','refund',-1.005))x(type,category,amount);
INSERT INTO rake_records(tournament_id,rake_amount,is_tournament) SELECT id,5,true FROM tournaments;
INSERT INTO rake_records(tournament_id,rake_amount,is_tournament) SELECT id,500,false FROM tournaments;
INSERT INTO rake_records(tournament_id,rake_amount,is_tournament) SELECT id,900,NULL FROM tournaments;
INSERT INTO chip_ledger(tournament_id,amount,category,to_type) SELECT id,8,'overlay','prize_liability' FROM tournaments;
INSERT INTO chip_ledger(tournament_id,amount,category,to_type) SELECT id,1000,'overlay','other' FROM tournaments;
INSERT INTO tournament_guarantee_overlays SELECT id,11 FROM tournaments;
INSERT INTO tournament_conservation_baseline SELECT id,3.111 FROM tournaments;
-- Legacy seat, issued/redeemed/cancelled ticket, cash delivery, null position,
-- missing ticket, duplicate amounts, malformed/uppercase target text.
INSERT INTO tournaments(id,name,prize_pool,ended_at,status)
SELECT md5('sat-'||n)::uuid,'sat-'||n,0,now(),'RUNNING' FROM generate_series(1,10)n;
INSERT INTO tournament_payouts(tournament_id,user_id,amount,source,position,metadata)
SELECT md5('sat-'||n)::uuid,md5('player-'||n)::uuid,7+n,
 CASE WHEN n%2=0 THEN 'satellite_ticket' ELSE 'satellite_seat' END,
 CASE WHEN n=7 THEN NULL ELSE n END,
 jsonb_build_object('satellite_target_id',CASE WHEN n=9 THEN 'malformed'
 WHEN n=10 THEN upper(md5('event-1')::uuid::text) ELSE md5('event-'||n)::uuid::text END)
FROM generate_series(1,10)n;
INSERT INTO tournament_tickets SELECT md5('ticket-'||n)::uuid,
 CASE n WHEN 2 THEN 'issued' WHEN 3 THEN 'redeemed' WHEN 4 THEN 'cancelled' ELSE NULL END
 FROM generate_series(2,4)n;
INSERT INTO tournament_satellite_awards SELECT md5('sat-'||n)::uuid,n,
 CASE WHEN n IN(2,3,4) THEN md5('ticket-'||n)::uuid ELSE NULL END,
 CASE WHEN n=5 THEN 'cash' WHEN n=6 THEN NULL ELSE 'ticket' END
 FROM generate_series(2,6)n;
-- Seat-outgoing cases also exist on non-satellite events; never assume absent.
INSERT INTO tournament_payouts(tournament_id,user_id,amount,source,position,metadata)
SELECT md5('event-'||n)::uuid,md5('player-'||n)::uuid,7+n,'satellite_ticket',n,'{}'
FROM generate_series(11,20)n;
INSERT INTO wallet_transactions(related_entity_id,type,category,amount,user_id)
SELECT md5('event-11')::uuid,'credit','prize',18,md5('player-11')::uuid;
INSERT INTO tournament_tickets VALUES(md5('out-issued')::uuid,'issued'),(md5('out-cancelled')::uuid,'cancelled');
INSERT INTO tournament_satellite_awards VALUES
 (md5('event-12')::uuid,12,md5('out-issued')::uuid,'ticket'),
 (md5('event-13')::uuid,13,md5('out-cancelled')::uuid,'ticket'),
 (md5('event-14')::uuid,14,NULL,'cash');
-- Exact scope boundaries, including null and case-sensitive source semantics.
UPDATE tournaments SET ended_at=now()-interval '30 days' WHERE name='case-21';
UPDATE tournaments SET ended_at=now()-interval '30 days'+interval '5 minutes' WHERE name='case-22';
UPDATE tournaments SET ended_at=now()-interval '31 days' WHERE name='case-23';
UPDATE tournaments SET ended_at=NULL WHERE name='case-24';
UPDATE tournaments SET status='RUNNING' WHERE name='case-25';
UPDATE tournaments SET variant='satellite' WHERE name='case-26';
UPDATE tournaments SET tournament_type='sAtElLiTe' WHERE name='case-27';
UPDATE tournaments SET satellite_target_id=md5('target')::uuid WHERE name='case-28';
UPDATE tournaments SET variant='spin' WHERE name='case-29';
UPDATE tournaments SET variant='SPIN' WHERE name='case-30';
-- Distinct whole-function branches: skipped debt, paid, refused, withheld.
UPDATE tournaments SET fixture_topup=4 WHERE name IN('case-1','case-31');
UPDATE tournaments SET fixture_topup=90 WHERE name='case-32';
UPDATE tournaments SET fixture_topup=0.005 WHERE name='case-33';
UPDATE tournaments SET fixture_topup=NULL WHERE name='case-34';
UPDATE tournaments SET prize_pool=40,fixture_topup=12 WHERE name='case-35';
UPDATE tournaments SET prize_pool=0,fixture_topup=3 WHERE name='case-36';
-- Deltas on the 0.01/0.02 selection boundary.
DELETE FROM wallet_transactions WHERE related_entity_id IN(md5('event-40')::uuid,md5('event-41')::uuid);
DELETE FROM rake_records WHERE tournament_id IN(md5('event-40')::uuid,md5('event-41')::uuid);
DELETE FROM chip_ledger WHERE tournament_id IN(md5('event-40')::uuid,md5('event-41')::uuid);
DELETE FROM tournament_guarantee_overlays WHERE tournament_id IN(md5('event-40')::uuid,md5('event-41')::uuid);
DELETE FROM tournament_conservation_baseline WHERE tournament_id IN(md5('event-40')::uuid,md5('event-41')::uuid);
INSERT INTO wallet_transactions(related_entity_id,type,category,amount) VALUES
(md5('event-40')::uuid,'debit','tournament_buyin',0.014),
(md5('event-41')::uuid,'debit','tournament_buyin',0.015);

-- The reused partial covering index excludes only zero/null sums. Keep signed
-- amounts, null-only groups and zero-only groups equivalent to the scalar.
DELETE FROM rake_records WHERE tournament_id IN(md5('event-73')::uuid,md5('event-74')::uuid,md5('event-75')::uuid,md5('event-76')::uuid);
INSERT INTO rake_records(tournament_id,rake_amount,is_tournament) VALUES
 (md5('event-73')::uuid,NULL,true),(md5('event-74')::uuid,0,true),
 (md5('event-75')::uuid,-3.005,true),(md5('event-75')::uuid,0,true),
 (md5('event-76')::uuid,2.005,true),(md5('event-76')::uuid,-2.005,true),
 (md5('event-76')::uuid,NULL,true),(NULL,999,true);
INSERT INTO wallet_transactions(related_entity_id,type,category,amount) VALUES
 (NULL,'credit','prize',1000),(NULL,'debit','rebuy',1000);
