-- Native composition of original entry/refund/prize owners with weekly books.
-- Only the game inputs (event/standings) and private fixture calendar are synthetic;
-- no ledger, funding, obligation, credit, refund or terminal receipt is seeded.
-- Run after regression.sql in its private native database. Tournament events use
-- IDs410..414; the cash baseline remains club102 +10 and club101 -10.
SELECT fixture.assert(inet_server_addr() IS NULL AND current_user='postgres',
 'Tournament weekly cases run only in the private native fixture');
CREATE TEMP TABLE tournament_weekly_ids(event_id uuid,user_id uuid,registration_id uuid,label text);
INSERT INTO tournaments(id,club_id,union_id,is_private,name,buy_in_amount,buy_in_fee,start_time,max_players,status,current_players,prize_pool,bounty_pool,bounty_pool_paid,total_rake,variant,payout_structure,starting_chips)
VALUES(fixture.u(410),fixture.u(101),fixture.u(201),false,'Original cross-week tournament',50,0,clock_timestamp()+interval '1 day',100,'REGISTERING',0,0,0,0,0,'mtt','[{"place":1,"percentage":100}]',1000);
SET request.jwt.claims='{"role":"service_role","sub":"00000000-0000-0000-0000-000000000903"}';
DO $$ DECLARE r jsonb; BEGIN
 r:=fn_register_for_tournament_request(fixture.u(410),fixture.u(410903));
 PERFORM fixture.assert(r->>'ok'='true','Actual first cross-week entry: '||r::text);
 INSERT INTO tournament_weekly_ids VALUES(fixture.u(410),fixture.u(903),(r->>'registration_id')::uuid,'cross-winner');
END $$;
SET request.jwt.claims='{"role":"service_role","sub":"00000000-0000-0000-0000-000000000904"}';
DO $$ DECLARE r jsonb; BEGIN
 r:=fn_register_for_tournament_request(fixture.u(410),fixture.u(410904));
 PERFORM fixture.assert(r->>'ok'='true','Actual horse cross-week entry: '||r::text);
 INSERT INTO tournament_weekly_ids VALUES(fixture.u(410),fixture.u(904),(r->>'registration_id')::uuid,'cross-loser');
END $$;
SELECT fixture.place_original_transactions('2026-09-06 12:00Z');
DO $$ DECLARE b jsonb; p jsonb; BEGIN
 b:=fn_union_pnl_boundary(fixture.u(201),'2026-09-07 07:00Z');
 PERFORM fixture.assert(b->>'status'='ready','Original cross-week opening boundary qualifies');
 PERFORM fixture.assert((SELECT count(*)=2 AND sum((h->>'amount')::numeric)=100
  FROM jsonb_array_elements(b->'holdings') h WHERE h->>'kind'='deferred_tournament_result'),
  'Both exact paid entries retain 100 of original deferred cost');
 p:=fn_union_pnl_evidence_report(fixture.u(201),'2026-09-07 07:00Z','2026-09-14 07:00Z');
 PERFORM fixture.assert(p->>'status'='ready' AND (SELECT bool_and((x->>'tournament_player_pnl')::numeric=0) FROM jsonb_array_elements(p->'clubs') x),
  'An unchanged open tournament has zero realized result across a whole week');
END $$;

-- A new entry inside the book remains deferred at close instead of becoming
-- a loss; a zero entry retains its original stamped club without a fake debit.
INSERT INTO tournaments(id,club_id,union_id,is_private,name,buy_in_amount,buy_in_fee,start_time,max_players,status,current_players,prize_pool,bounty_pool,bounty_pool_paid,total_rake,variant)
VALUES(fixture.u(411),fixture.u(101),fixture.u(201),false,'Original midweek open entry',40,0,clock_timestamp()+interval '1 day',100,'REGISTERING',0,0,0,0,0,'mtt'),
 (fixture.u(412),fixture.u(101),fixture.u(201),false,'Original free chip entry',0,0,clock_timestamp()+interval '1 day',100,'REGISTERING',0,0,0,0,0,'mtt'),
 (fixture.u(413),fixture.u(101),fixture.u(201),false,'Original refund and new registration',30,0,clock_timestamp()+interval '1 day',100,'REGISTERING',0,0,0,0,0,'mtt');
SET request.jwt.claims='{"role":"service_role","sub":"00000000-0000-0000-0000-000000000905"}';
DO $$ DECLARE r jsonb; BEGIN
 r:=fn_register_for_tournament_request(fixture.u(411),fixture.u(411905));
 PERFORM fixture.assert(r->>'ok'='true','Actual midweek entry succeeds');
 INSERT INTO tournament_weekly_ids VALUES(fixture.u(411),fixture.u(905),(r->>'registration_id')::uuid,'open');
 r:=fn_register_for_tournament_request(fixture.u(413),fixture.u(413905));
 PERFORM fixture.assert(r->>'ok'='true','Actual refundable entry succeeds');
 INSERT INTO tournament_weekly_ids VALUES(fixture.u(413),fixture.u(905),(r->>'registration_id')::uuid,'refunded');
END $$;
SET request.jwt.claims='{"role":"service_role","sub":"00000000-0000-0000-0000-000000000903"}';
DO $$ DECLARE r jsonb; BEGIN
 r:=fn_register_for_tournament_request(fixture.u(412),fixture.u(412903));
 PERFORM fixture.assert(r->>'ok'='true','Actual zero-price entry succeeds');
 INSERT INTO tournament_weekly_ids VALUES(fixture.u(412),fixture.u(903),(r->>'registration_id')::uuid,'free');
 PERFORM fixture.assert(EXISTS(SELECT 1 FROM tournament_participant_funding_receipts f
  WHERE f.registration_id=(r->>'registration_id')::uuid AND f.amount=0 AND f.asset='chips'
   AND f.ledger_id IS NULL AND f.entitlement_id IS NULL AND f.funding_club_id IS NULL
   AND fn_union_pnl_tournament_entry_club(f)=fixture.u(102)),
  'Free chips use the immutable original entry club without inventing funding');
END $$;
SELECT fixture.place_original_transactions('2026-09-09 12:00Z');

SET request.jwt.claims='{"role":"service_role","sub":"00000000-0000-0000-0000-000000000905"}';
DO $$ DECLARE r jsonb; fresh jsonb; old_id uuid; BEGIN
 SELECT registration_id INTO old_id FROM tournament_weekly_ids WHERE label='refunded';
 r:=fn_ca_unregister_tournament_player_exact(fixture.u(413),fixture.u(905),NULL,'Original weekly refund case',fixture.u(413906));
 PERFORM fixture.assert(r->>'ok'='true' AND (r->>'refunded_chips')::numeric=30,'Actual original registration refund returns exactly 30: '||r::text);
 fresh:=fn_register_for_tournament_request(fixture.u(413),fixture.u(413907));
 PERFORM fixture.assert(fresh->>'ok'='true' AND (fresh->>'registration_id')::uuid<>old_id,'Re-registering creates a new original lifecycle');
 INSERT INTO tournament_weekly_ids VALUES(fixture.u(413),fixture.u(905),(fresh->>'registration_id')::uuid,'new-registration');
 PERFORM fixture.assert((SELECT count(*)=1 AND sum(amount)=30 FROM fn_union_pnl_tournament_returns(fixture.u(413),old_id)),
  'Refund is linked to its exact original registration once');
 PERFORM fixture.assert(NOT EXISTS(SELECT 1 FROM fn_union_pnl_tournament_returns(fixture.u(413),(fresh->>'registration_id')::uuid)),
  'Old refund cannot reduce the new registration holding');
END $$;
SELECT fixture.place_original_transactions('2026-09-10 13:00Z');
DO $$ DECLARE b jsonb; p jsonb; BEGIN
 b:=fn_union_pnl_boundary(fixture.u(201),'2026-09-14 07:00Z');
 PERFORM fixture.assert(b->>'status'='ready','Paid, refunded/re-entered and free entry closing boundary qualifies: '||(b->'issues')::text);
 PERFORM fixture.assert((SELECT (h->>'amount')::numeric=30 FROM jsonb_array_elements(b->'holdings') h
  WHERE h->>'source_id'=(SELECT registration_id::text FROM tournament_weekly_ids WHERE label='new-registration')),
  'New registration retains its full 30 original cost despite prior refund');
 PERFORM fixture.assert((SELECT sum((h->>'amount')::numeric)=170 FROM jsonb_array_elements(b->'holdings') h WHERE h->>'kind'='deferred_tournament_result'),
  'Closing deferred amount is original 100 plus new 40 plus re-entry 30');
 p:=fn_union_pnl_evidence_report(fixture.u(201),'2026-09-07 07:00Z','2026-09-14 07:00Z');
 PERFORM fixture.assert(p->>'status'='ready' AND (SELECT bool_and((x->>'tournament_player_pnl')::numeric=0) FROM jsonb_array_elements(p->'clubs') x),
  'Entry, exact refund and new open entry net to zero recognized tournament result');
END $$;

-- Synthetic finished-game standings are inputs; the original terminal owner
-- derives and pays the whole 100 pool, closes escrow and writes its own receipt.
SET request.jwt.claims='{"role":"service_role","sub":"00000000-0000-0000-0000-000000000900"}';
UPDATE tournaments SET status='RUNNING',started_at=clock_timestamp()-interval '1 hour',current_players=1 WHERE id=fixture.u(410);
UPDATE tournament_players SET status=CASE WHEN user_id=fixture.u(903) THEN 'playing' ELSE 'eliminated' END,
 chips=CASE WHEN user_id=fixture.u(903) THEN 2000 ELSE 0 END,
 position=CASE WHEN user_id=fixture.u(903) THEN NULL ELSE 2 END,
 eliminated_at=CASE WHEN user_id=fixture.u(903) THEN NULL ELSE clock_timestamp()-interval '1 minute' END,
 elimination_sequence=CASE WHEN user_id=fixture.u(903) THEN NULL ELSE 1 END WHERE tournament_id=fixture.u(410);
SELECT fixture.place_original_transactions('2026-09-11 12:00Z');
DO $$ DECLARE result jsonb; replay jsonb; amount_before numeric; BEGIN
 result:=fn_complete_tournament_terminal(fixture.u(410),fixture.u(903),'places');
 PERFORM fixture.assert(result->>'ok'='true' AND result->>'status'='COMPLETED'
  AND (result->>'cash_payout_total')::numeric=100,'Actual terminal authority pays the original pool completely');
 PERFORM fixture.assert((SELECT count(*)=1 AND sum(amount)=100 FROM tournament_accounting_credit_receipts WHERE tournament_id=fixture.u(410))
  AND (SELECT prize_balance=0 AND bounty_balance=0 AND fee_balance=0 AND closed_at IS NOT NULL FROM tournament_escrow WHERE tournament_id=fixture.u(410)),
  'Original award proof and exact-zero escrow accompany the terminal receipt');
 SELECT chip_balance INTO amount_before FROM club_members WHERE club_id=fixture.u(102) AND user_id=fixture.u(903);
 replay:=fn_complete_tournament_terminal(fixture.u(410),fixture.u(903),'places');
 PERFORM fixture.assert(replay=result AND (SELECT chip_balance=amount_before FROM club_members WHERE club_id=fixture.u(102) AND user_id=fixture.u(903))
  AND (SELECT count(*)=1 FROM tournament_accounting_credit_receipts WHERE tournament_id=fixture.u(410)),
  'Terminal replay does not pay or retain a second original award');
END $$;
SELECT fixture.place_original_transactions('2026-09-12 12:00Z');
DO $$ DECLARE p jsonb; again jsonb; BEGIN
 p:=fn_union_pnl_evidence_report(fixture.u(201),'2026-09-07 07:00Z','2026-09-14 07:00Z');
 PERFORM fixture.assert(p->>'status'='ready','Completed original tournament week qualifies: '||(p->'issues')::text);
 PERFORM fixture.assert((SELECT (x->>'net')::numeric=60 AND (x->>'tournament_player_pnl')::numeric=50 FROM jsonb_array_elements(p->'clubs') x WHERE x->>'club_id'=fixture.u(102)::text),
  'Winning club has original tournament +50 plus cash +10, exactly +60');
 PERFORM fixture.assert((SELECT (x->>'net')::numeric=-60 AND (x->>'tournament_player_pnl')::numeric=-50 FROM jsonb_array_elements(p->'clubs') x WHERE x->>'club_id'=fixture.u(101)::text),
  'Horse losing club has original tournament -50 plus cash -10, exactly -60');
 PERFORM fixture.assert((SELECT sum((h->>'amount')::numeric)=70 FROM jsonb_array_elements(p#>'{closing_basis,holdings}') h WHERE h->>'kind'='deferred_tournament_result'),
  'Terminal removes only its 100 deferred result; open40 and new registration30 remain');
 again:=fn_union_pnl_evidence_report(fixture.u(201),'2026-09-07 07:00Z','2026-09-14 07:00Z');
 PERFORM fixture.assert(again=p,'Reading the completed week again retains exactly the same result');
END $$;

-- A valid original free Diamond event is outside Union chip scope. Its actual
-- receipt must never acquire a chip earning club or contaminate the Union book.
-- No impossible Diamond/Union association is fabricated for this control.
BEGIN;
INSERT INTO clubs(id,name,owner_id,asset,is_platform,chip_treasury,chip_pool,promo_balance,insurance_balance)
VALUES(fixture.u(103),'Original Diamond fixture',fixture.u(901),'diamonds',true,0,0,0,0);
INSERT INTO club_members(club_id,user_id,chip_balance,role,status)
VALUES(fixture.u(103),fixture.u(905),0,'player','active');
INSERT INTO tournaments(id,club_id,union_id,is_private,name,buy_in_amount,buy_in_fee,start_time,max_players,status,current_players,prize_pool,bounty_pool,bounty_pool_paid,total_rake,variant)
VALUES(fixture.u(414),fixture.u(103),NULL,false,'Original free Diamond refusal',0,0,clock_timestamp()+interval '1 day',100,'REGISTERING',0,0,0,0,0,'mtt');
SET LOCAL request.jwt.claims='{"role":"service_role","sub":"00000000-0000-0000-0000-000000000905"}';
DO $$ DECLARE r jsonb; p jsonb; before_report jsonb; BEGIN
 before_report:=fn_union_pnl_evidence_report(fixture.u(201),'2026-09-07 07:00Z','2026-09-14 07:00Z');
 r:=fn_register_for_tournament_request(fixture.u(414),fixture.u(414905));
 PERFORM fixture.assert(r->>'ok'='true' AND EXISTS(SELECT 1 FROM tournament_participant_funding_receipts f
  WHERE f.registration_id=(r->>'registration_id')::uuid AND f.asset='diamonds' AND f.amount=0 AND f.ledger_id IS NULL),
  'Original free Diamond entry remains a distinct actual instrument');
 PERFORM fixture.assert(EXISTS(SELECT 1 FROM tournament_participant_funding_receipts f
  WHERE f.registration_id=(r->>'registration_id')::uuid AND fn_union_pnl_tournament_entry_club(f) IS NULL),
  'Chip earning basis refuses the original Diamond instrument even at zero value');
 PERFORM fixture.place_original_transactions('2026-09-13 12:00Z');
 p:=fn_union_pnl_evidence_report(fixture.u(201),'2026-09-07 07:00Z','2026-09-14 07:00Z');
 PERFORM fixture.assert(p->>'status'='ready' AND p->'clubs'=before_report->'clubs',
  'A separate Diamond event cannot enter or change the original Union chip result');
END $$;
ROLLBACK;
SELECT fixture.assert(fn_union_pnl_evidence_report(fixture.u(201),'2026-09-07 07:00Z','2026-09-14 07:00Z')->>'status'='ready',
 'All qualified original tournament and cash evidence remains intact');
