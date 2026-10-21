-- Anonymous mixed original-entry / transferred-stack destination, transactionally rolled back.
BEGIN;
SET LOCAL session_replication_role=replica;
DELETE FROM tournament_participant_funding_receipts;
DELETE FROM chip_ledger;
UPDATE tournament_players SET rebuys=0,add_on=false,chips=CASE WHEN seat_number=1 THEN 22619 ELSE 22000 END;
UPDATE table_seats SET stack=CASE WHEN seat_number=1 THEN 22619 ELSE 22000 END;
INSERT INTO tournament_participant_funding_receipts(id,tournament_id,user_id,registration_id,operation,observed_at,asset,amount,registration_snapshot,tournament_snapshot)
 SELECT md5('arrival-fund:'||p.id)::uuid,p.tournament_id,p.user_id,p.id,'entry',s.joined_at-interval '1 minute','diamonds',100,
 jsonb_build_object('id',p.id,'user_id',p.user_id,'chips',CASE WHEN p.seat_number=1 THEN 0 ELSE 22000 END),
 jsonb_build_object('id',p.tournament_id,'starting_chips',22000)
 FROM tournament_players p JOIN table_seats s ON s.user_id=p.user_id AND s.table_id=p.table_id;
INSERT INTO tournament_seat_move_receipts
 SELECT md5('arrival:'||s.id)::uuid,p.tournament_id,s.user_id,md5('original-source')::uuid,s.table_id,md5('original-source-chair')::uuid,s.id,3,s.seat_number,'live_source',s.stack,s.joined_at
 FROM table_seats s JOIN tournament_players p ON p.user_id=s.user_id AND p.table_id=s.table_id WHERE s.seat_number=1;
SET LOCAL session_replication_role=origin;
