-- A SATELLITE AWARD IS FOUND BY ITS PAYOUT, NEVER BY ITS PLACE (20261001151646).
-- The fixture award table adopts the production key before any case is added:
-- payout_id NOT NULL, UNIQUE, and a FOREIGN KEY to tournament_payouts. Every
-- award already in this cluster is a ranked (receipt_version 2) award whose
-- place is its payout's position, so that is the rule that fills the key; the
-- native qualification proves each award finds exactly one payout first.
ALTER TABLE tournament_satellite_awards ADD COLUMN payout_id bigint;
UPDATE tournament_satellite_awards a SET payout_id = p.id
  FROM tournament_payouts p
 WHERE p.tournament_id = a.tournament_id AND p.position = a.place;
ALTER TABLE tournament_satellite_awards ALTER COLUMN payout_id SET NOT NULL;
ALTER TABLE tournament_satellite_awards
  ADD CONSTRAINT tournament_satellite_awards_payout_id_key UNIQUE (payout_id),
  ADD CONSTRAINT tournament_satellite_awards_payout_id_fkey
    FOREIGN KEY (payout_id) REFERENCES tournament_payouts(id);
CREATE TABLE tournament_satellite_settlements(tournament_id uuid PRIMARY KEY);

-- An independent oracle, counted by hand. scalar: the restated delta. batch:
-- the payer's inline delta (NULL when the event is not payer-eligible, as a
-- satellite never is). old_scalar: the predecessor formula, place = position.
CREATE TABLE fixture_expected_awards(name text PRIMARY KEY, scalar numeric NOT NULL,
  batch numeric, old_scalar numeric NOT NULL);
INSERT INTO fixture_expected_awards VALUES
 -- 100 in, 210 prizes, seats arriving 20+20+20+50 = 110. The predecessor also
 -- credited the issued (1), cash (3) and cancelled (5) NULL-position tickets
 -- and, through the swapped place/position pair, the issued 30 instead of the
 -- redeemed 50: 20+20+20+20+20+20+30 = 150, so it read +40.00 retained.
 ('award-target', 0, 0, 40),
 -- 200 in, 40 cash prizes (3 and 5), seats leaving 20+20+20+20+30+50 = 160.
 ('award-source', 0, NULL, 0),
 -- House-funded bubble protection: one correction leg of 180 into
 -- prize_liability paired with one bubble_protection payout of 180.
 ('award-bubble', 0, -180, -180),
 -- Two legs of 50, one payout of 50: one payout never absorbs two legs.
 ('award-bubble-two-legs', 0, -50, -50),
 -- One leg of 60, two payouts of 60: one leg never funds two payouts.
 ('award-bubble-two-payouts', -60, -120, -120),
 -- A correction leg with no bubble_protection payout is some other correction.
 ('award-bubble-unpaired', -44.80, -44.80, -44.80),
 -- A leg and a payout of different amounts never pair.
 ('award-bubble-other-amount', -180, -180, -180),
 -- A correction leg that does not go into prize_liability is not funding.
 ('award-bubble-wrong-direction', -180, -180, -180);

INSERT INTO tournaments(id,name,club_id,prize_pool,ended_at,status,variant)
SELECT md5(name)::uuid, name, md5('club')::uuid, 100, now()-interval '1 day', 'COMPLETED',
       CASE WHEN name = 'award-source' THEN 'satellite' END
  FROM fixture_expected_awards;
INSERT INTO tournament_satellite_settlements VALUES (md5('award-source')::uuid);

INSERT INTO wallet_transactions(related_entity_id,type,category,amount,user_id) VALUES
 (md5('award-target')::uuid,'debit','tournament_buyin',100,NULL),
 (md5('award-target')::uuid,'credit','prize',210,NULL),
 (md5('award-source')::uuid,'debit','tournament_buyin',200,NULL),
 (md5('award-source')::uuid,'credit','prize',20,md5('award-user-3')::uuid),
 (md5('award-source')::uuid,'credit','prize',20,md5('award-user-5')::uuid),
 (md5('award-bubble')::uuid,'debit','tournament_buyin',100,NULL),
 (md5('award-bubble')::uuid,'credit','prize',280,NULL),
 (md5('award-bubble-two-legs')::uuid,'debit','tournament_buyin',100,NULL),
 (md5('award-bubble-two-legs')::uuid,'credit','prize',150,NULL),
 (md5('award-bubble-two-payouts')::uuid,'debit','tournament_buyin',100,NULL),
 (md5('award-bubble-two-payouts')::uuid,'credit','prize',220,NULL),
 (md5('award-bubble-unpaired')::uuid,'debit','tournament_buyin',100,NULL),
 (md5('award-bubble-unpaired')::uuid,'credit','prize',144.80,NULL),
 (md5('award-bubble-other-amount')::uuid,'debit','tournament_buyin',100,NULL),
 (md5('award-bubble-other-amount')::uuid,'credit','prize',280,NULL),
 (md5('award-bubble-wrong-direction')::uuid,'debit','tournament_buyin',100,NULL),
 (md5('award-bubble-wrong-direction')::uuid,'credit','prize',280,NULL);

-- receipt_version 3: unranked co-qualifiers keep a NULL position (1-5); 6 is
-- ranked with place = position; 7 and 8 have positions that name each
-- other's place, so only the payout key finds the right ticket.
INSERT INTO tournament_tickets(id,status) VALUES
 (md5('award-ticket-1')::uuid,'issued'), (md5('award-ticket-2')::uuid,'redeemed'),
 (md5('award-ticket-5')::uuid,'cancelled'), (md5('award-ticket-6')::uuid,'redeemed'),
 (md5('award-ticket-7')::uuid,'issued'), (md5('award-ticket-8')::uuid,'redeemed');
INSERT INTO tournament_payouts(tournament_id,user_id,amount,source,position,metadata)
SELECT md5('award-source')::uuid, md5('award-user-'||n)::uuid,
       CASE n WHEN 7 THEN 30 WHEN 8 THEN 50 ELSE 20 END,
       CASE WHEN n = 4 THEN 'satellite_seat' ELSE 'satellite_ticket' END,
       CASE n WHEN 6 THEN 6 WHEN 7 THEN 8 WHEN 8 THEN 7 END,
       jsonb_build_object('satellite_target_id', md5('award-target')::uuid::text)
  FROM generate_series(1,8) n;
INSERT INTO tournament_satellite_awards(tournament_id,place,ticket_id,delivery_kind,payout_id)
SELECT p.tournament_id, n,
       CASE WHEN n IN (1,2,5,6,7,8) THEN md5('award-ticket-'||n)::uuid END,
       CASE n WHEN 3 THEN 'cash' WHEN 4 THEN 'seat' ELSE 'ticket' END, p.id
  FROM generate_series(1,8) n
  JOIN tournament_payouts p ON p.tournament_id = md5('award-source')::uuid
                           AND p.user_id = md5('award-user-'||n)::uuid;

INSERT INTO chip_ledger(tournament_id,amount,category,to_type) VALUES
 (md5('award-bubble')::uuid,180,'correction','prize_liability'),
 (md5('award-bubble-two-legs')::uuid,50,'correction','prize_liability'),
 (md5('award-bubble-two-legs')::uuid,50,'correction','prize_liability'),
 (md5('award-bubble-two-payouts')::uuid,60,'correction','prize_liability'),
 (md5('award-bubble-unpaired')::uuid,100,'correction','prize_liability'),
 (md5('award-bubble-other-amount')::uuid,180,'correction','prize_liability'),
 (md5('award-bubble-wrong-direction')::uuid,180,'correction','club_treasury');
INSERT INTO tournament_payouts(tournament_id,user_id,amount,source,position,metadata) VALUES
 (md5('award-bubble')::uuid,md5('award-bubble-user')::uuid,180,'bubble_protection',NULL,NULL),
 (md5('award-bubble-two-legs')::uuid,md5('award-bubble-user')::uuid,50,'bubble_protection',NULL,NULL),
 (md5('award-bubble-two-payouts')::uuid,md5('award-bubble-user')::uuid,60,'bubble_protection',NULL,NULL),
 (md5('award-bubble-two-payouts')::uuid,md5('award-bubble-user-2')::uuid,60,'bubble_protection',NULL,NULL),
 (md5('award-bubble-other-amount')::uuid,md5('award-bubble-user')::uuid,100,'bubble_protection',NULL,NULL),
 (md5('award-bubble-wrong-direction')::uuid,md5('award-bubble-user')::uuid,180,'bubble_protection',NULL,NULL);
