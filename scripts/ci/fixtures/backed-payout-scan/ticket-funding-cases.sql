-- Ticket and house-funding cases (2026-10-03). Every expected delta is written
-- by hand from the rows below, independently of either formula.
--
-- tf-sat: a satellite whose five places went to tf-ticket-target as
--   a) ticket on the payout row only, redeemed in the target   -> arrived
--   b) ticket on the payout row only, still issued              -> not arrived
--   c) ticket on the payout row only, cancelled and paid cash   -> not arrived
--   d) legacy direct seat, no ticket anywhere                   -> arrived
--   e) award row with a redeemed ticket                         -> arrived
--   It collected 500, paid c's 100 in cash and 400 in seats: delta 0.00.
-- tf-ticket-target: 300 arrived (a, d, e), paid 300 in prizes: delta 0.00.
--   The original formula credits a, b, c and d as arrivals: +200.00.
INSERT INTO tournaments(id,name,prize_pool,ended_at,status,variant)
VALUES(md5('tf-sat')::uuid,'tf-sat',500,now()-interval '2 days','COMPLETED','satellite'),
      (md5('tf-ticket-target')::uuid,'tf-ticket-target',300,now()-interval '1 day','COMPLETED',NULL);
INSERT INTO wallet_transactions(related_entity_id,type,category,amount,user_id)
SELECT md5('tf-sat')::uuid,'debit','tournament_buyin',100,md5('tf-user-'||n)::uuid FROM generate_series(1,5)n;
INSERT INTO wallet_transactions(related_entity_id,type,category,amount,user_id)
VALUES(md5('tf-sat')::uuid,'credit','prize',100,md5('tf-user-3')::uuid),
      (md5('tf-ticket-target')::uuid,'credit','prize',300,md5('tf-user-1')::uuid);
INSERT INTO tournament_tickets(id,status)
VALUES(md5('tf-ticket-1')::uuid,'redeemed'),(md5('tf-ticket-2')::uuid,'issued'),
      (md5('tf-ticket-3')::uuid,'cancelled'),(md5('tf-ticket-5')::uuid,'redeemed');
INSERT INTO tournament_satellite_awards(tournament_id,place,ticket_id,delivery_kind)
VALUES(md5('tf-sat')::uuid,5,md5('tf-ticket-5')::uuid,'ticket');
INSERT INTO tournament_payouts(tournament_id,user_id,amount,source,position,metadata)
VALUES
 (md5('tf-sat')::uuid,md5('tf-user-1')::uuid,100,'satellite_ticket',NULL,
  jsonb_build_object('satellite_target_id',md5('tf-ticket-target')::uuid::text,'ticket_id',md5('tf-ticket-1')::uuid::text)),
 (md5('tf-sat')::uuid,md5('tf-user-2')::uuid,100,'satellite_ticket',NULL,
  jsonb_build_object('satellite_target_id',md5('tf-ticket-target')::uuid::text,'ticket_id',md5('tf-ticket-2')::uuid::text)),
 (md5('tf-sat')::uuid,md5('tf-user-3')::uuid,100,'satellite_ticket',NULL,
  jsonb_build_object('satellite_target_id',md5('tf-ticket-target')::uuid::text,'ticket_id',md5('tf-ticket-3')::uuid::text)),
 (md5('tf-sat')::uuid,md5('tf-user-4')::uuid,100,'satellite_seat',NULL,
  jsonb_build_object('satellite_target_id',md5('tf-ticket-target')::uuid::text)),
 (md5('tf-sat')::uuid,md5('tf-user-5')::uuid,100,'satellite_ticket',5,
  jsonb_build_object('satellite_target_id',md5('tf-ticket-target')::uuid::text));

-- A malformed ticket id on a payout row is not a ticket and must not break
-- the read: tf-malformed-target credits it as the legacy seat it then is.
-- 100 arrived, 100 paid: delta 0.00 under both formulas. Its satellite
-- tf-sat-2 collected 100 and paid that seat: delta 0.00.
INSERT INTO tournaments(id,name,prize_pool,ended_at,status,variant)
VALUES(md5('tf-malformed-target')::uuid,'tf-malformed-target',100,now()-interval '1 day','COMPLETED',NULL),
      (md5('tf-sat-2')::uuid,'tf-sat-2',100,now()-interval '2 days','COMPLETED','satellite');
INSERT INTO wallet_transactions(related_entity_id,type,category,amount,user_id)
VALUES(md5('tf-malformed-target')::uuid,'credit','prize',100,md5('tf-user-6')::uuid),
      (md5('tf-sat-2')::uuid,'debit','tournament_buyin',100,md5('tf-user-6')::uuid);
INSERT INTO tournament_payouts(tournament_id,user_id,amount,source,position,metadata)
VALUES(md5('tf-sat-2')::uuid,md5('tf-user-6')::uuid,100,'satellite_ticket',NULL,
  jsonb_build_object('satellite_target_id',md5('tf-malformed-target')::uuid::text,'ticket_id','not-a-ticket'));

-- tf-correction-target: collected 1,000, paid 1,180; the house funded the
-- extra 180 club_treasury -> prize_liability as a 'correction'. A suspense
-- leg and a player's leg into the pool are not house funding. Delta 0.00;
-- the original formula: -180.00.
INSERT INTO tournaments(id,name,prize_pool,ended_at,status)
VALUES(md5('tf-correction-target')::uuid,'tf-correction-target',1180,now()-interval '1 day','COMPLETED');
INSERT INTO wallet_transactions(related_entity_id,type,category,amount,user_id)
VALUES(md5('tf-correction-target')::uuid,'debit','tournament_buyin',1000,md5('tf-user-7')::uuid),
      (md5('tf-correction-target')::uuid,'credit','prize',1180,md5('tf-user-7')::uuid);
INSERT INTO chip_ledger(tournament_id,amount,category,to_type,from_type,from_entity_id,metadata)
VALUES(md5('tf-correction-target')::uuid,180,'correction','prize_liability','club_treasury',NULL,NULL),
      (md5('tf-correction-target')::uuid,50,'correction','prize_liability','settlement_suspense',NULL,NULL),
      (md5('tf-correction-target')::uuid,30,'correction','prize_liability','player_wallet',NULL,NULL),
      (md5('tf-correction-target')::uuid,20,'correction','player_wallet','union_bank',NULL,NULL);

-- tf-overlay-and-correction: an overlay of 100 AND a correction of 50, both
-- from the union bank. They are two fundings: 900 + 100 + 50 = 1,050 paid.
-- Delta 0.00; the original formula: -50.00.
INSERT INTO tournaments(id,name,prize_pool,ended_at,status)
VALUES(md5('tf-overlay-and-correction')::uuid,'tf-overlay-and-correction',1050,now()-interval '1 day','COMPLETED');
INSERT INTO wallet_transactions(related_entity_id,type,category,amount,user_id)
VALUES(md5('tf-overlay-and-correction')::uuid,'debit','tournament_buyin',900,md5('tf-user-8')::uuid),
      (md5('tf-overlay-and-correction')::uuid,'credit','prize',1050,md5('tf-user-8')::uuid);
INSERT INTO chip_ledger(tournament_id,amount,category,to_type,from_type,from_entity_id,metadata)
VALUES(md5('tf-overlay-and-correction')::uuid,100,'overlay','prize_liability','union_bank',NULL,NULL),
      (md5('tf-overlay-and-correction')::uuid,50,'correction','prize_liability','union_bank',NULL,NULL);

-- tf-phantom-backing: the reconciler reports 100 owed. Its only satellite
-- place is a ticket still unredeemed, so the pool holds nothing: collected
-- 500, paid 500. The original formula reads +100.00 of phantom backing and,
-- applying, pays it; the successor reads 0.00, so the pool backs nothing
-- and nothing is paid from it.
-- Its satellite tf-sat-3 collected 100 and issued that ticket: delta 0.00.
INSERT INTO tournaments(id,name,prize_pool,ended_at,status,variant,fixture_topup)
VALUES(md5('tf-phantom-backing')::uuid,'tf-phantom-backing',1000,now()-interval '1 day','COMPLETED',NULL,100),
      (md5('tf-sat-3')::uuid,'tf-sat-3',100,now()-interval '2 days','COMPLETED','satellite',0);
INSERT INTO wallet_transactions(related_entity_id,type,category,amount,user_id)
VALUES(md5('tf-phantom-backing')::uuid,'debit','tournament_buyin',500,md5('tf-user-9')::uuid),
      (md5('tf-phantom-backing')::uuid,'credit','prize',500,md5('tf-user-9')::uuid),
      (md5('tf-sat-3')::uuid,'debit','tournament_buyin',100,md5('tf-user-9')::uuid);
INSERT INTO tournament_tickets(id,status) VALUES(md5('tf-ticket-9')::uuid,'issued');
INSERT INTO tournament_payouts(tournament_id,user_id,amount,source,position,metadata)
VALUES(md5('tf-sat-3')::uuid,md5('tf-user-9')::uuid,100,'satellite_ticket',NULL,
  jsonb_build_object('satellite_target_id',md5('tf-phantom-backing')::uuid::text,'ticket_id',md5('tf-ticket-9')::uuid::text));
