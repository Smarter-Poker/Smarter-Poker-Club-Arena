-- Synthetic zero-prize boundary: the actual terminal core, source writer,
-- fee bank setter, marker trigger and receipt verifier execute unchanged.
-- This does not certify the separate nonzero prize/bounty/satellite payers.
INSERT INTO clubs(id,union_id) VALUES(u(99),u(90));
INSERT INTO union_wallets(union_id) VALUES(u(90));
UPDATE tournaments SET status='RUNNING',prize_pool=0,bounty_pool=0,bounty_pool_paid=0,prize_pool_finalized=false,is_bounty=false,is_pko=false,is_mystery_bounty=false,on_break=false WHERE id IN(u(5000),u(5100),u(5200));
INSERT INTO tournament_escrow(tournament_id,prize_balance,bounty_balance,fee_balance) VALUES(u(5000),0,0,1),(u(5100),0,0,1),(u(5200),0,0,1);
INSERT INTO fixture_tournament_fee_escrow VALUES(u(5000),1),(u(5100),1),(u(5200),1);
INSERT INTO tables(id,tournament_id,status,lifecycle,current_players) VALUES(u(5070),u(5000),'playing','active',1),(u(5170),u(5100),'playing','active',1);
INSERT INTO table_seats(id,table_id,user_id,status,left_at,leave_pending,is_sitting_out,is_away) VALUES(u(5071),u(5070),u(5011),'active',NULL,false,false,false),(u(5171),u(5170),u(5111),'active',NULL,false,false,false);
CREATE OR REPLACE FUNCTION public.fn_settle_tournament_places(t uuid,w uuid) RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN
 IF (SELECT prize_pool<>0 OR bounty_pool<>0 FROM tournaments WHERE id=t) THEN RAISE EXCEPTION 'zero_prize_fixture_only'; END IF;
 UPDATE tournaments SET status='COMPLETING',prize_pool_finalized=true WHERE id=t;
 UPDATE tournament_players SET status=CASE WHEN user_id=w THEN 'winner' ELSE 'eliminated' END,
  position=CASE WHEN user_id=w THEN 1 ELSE CASE WHEN user_id=u(5112) THEN 2 ELSE 3 END END,
  eliminated_at=CASE WHEN user_id=w THEN NULL ELSE transaction_timestamp() END,
  elimination_sequence=CASE WHEN user_id=w THEN NULL ELSE CASE WHEN user_id=u(5112) THEN 2 ELSE 1 END END WHERE tournament_id=t;
 RETURN jsonb_build_object('ok',true,'fully_settled',true,'status','COMPLETING','winner_amount',0,'payouts',jsonb_build_array(jsonb_build_object('place',1,'user_id',w,'amount',0)));
END$$;
-- Conservation fixture synchronizes actual fee escrow after the existing bank
-- primitive executes. The terminal core must still prove all three zero banks.
CREATE FUNCTION fixture_sync_terminal_fee() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 UPDATE tournament_escrow SET fee_balance=NEW.balance WHERE tournament_id=NEW.tournament_id;RETURN NEW;
END$$;
CREATE TRIGGER fixture_sync_terminal_fee AFTER UPDATE ON fixture_tournament_fee_escrow FOR EACH ROW EXECUTE FUNCTION fixture_sync_terminal_fee();
