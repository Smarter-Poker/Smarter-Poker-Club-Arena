
DO $retirement$
DECLARE g uuid:='10000000-0000-4000-8000-000000000001'; t uuid:='50000000-0000-4000-8000-000000000001';
 u uuid:='60000000-0000-4000-8000-000000000001'; occ uuid:=gen_random_uuid(); req uuid:=gen_random_uuid(); result jsonb;
BEGIN
 UPDATE table_seats SET occupancy_id=occ,joined_at=now() WHERE table_id=t AND user_id=u;
 INSERT INTO fixture_wallet VALUES(u,1000);
 -- Exercise the EXACT installed OFF-commit owner on a disabled source.
 -- Its row/stack digest must remain stable and its halt must remain set.
 UPDATE cash_games SET cluster_mode='pending_off' WHERE id=g;
 INSERT INTO cash_cluster_conversion(cluster_id,conversion_request_id,from_mode,to_mode,epoch_before,on_threshold,off_threshold)
 VALUES(g,req,'lightning','must_move',1,5,4);
 result:=fn_cash_cluster_commit_must_move(g,req);
 IF result->>'reverted'<>'true' OR (SELECT dealing_halted_at FROM tables WHERE id=t) IS NULL THEN RAISE EXCEPTION 'disabled source halt lost at original OFF barrier: %',result; END IF;
 IF (SELECT stack FROM table_seats WHERE occupancy_id=occ)<>57.35 THEN RAISE EXCEPTION 'OFF transition changed custody'; END IF;
 PERFORM set_config('fixture.engine','false',true);
 BEGIN
  PERFORM pg_temp.retire_lightning_occupancies(g,ARRAY[occ]);
  RAISE EXCEPTION 'nonengine retirement accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 PERFORM set_config('fixture.engine','true',true);
 result:=pg_temp.retire_lightning_occupancies(g,ARRAY[occ]);
 IF result->>'reason'<>'halt_not_observed' THEN RAISE EXCEPTION 'retirement bypassed observed halt: %',result; END IF;
 UPDATE tables SET dealing_halt_observed_at=clock_timestamp() WHERE id=t;
 INSERT INTO hand_state_snapshots(table_id,is_complete,updated_at) VALUES(t,false,now());
 result:=pg_temp.retire_lightning_occupancies(g,ARRAY[occ]);
 IF result->>'reason'<>'settlement_in_flight' THEN RAISE EXCEPTION 'retirement bypassed active hand: %',result; END IF;
 UPDATE hand_state_snapshots SET is_complete=true WHERE table_id=t;
 INSERT INTO lightning_reservation(cluster_id,state) VALUES(g,'committed');
 result:=pg_temp.retire_lightning_occupancies(g,ARRAY[occ]);
 IF result->>'reason'<>'settlement_in_flight' THEN RAISE EXCEPTION 'retirement bypassed reservation: %',result; END IF;
 UPDATE lightning_reservation SET state='released' WHERE cluster_id=g;
 IF (SELECT balance FROM fixture_wallet WHERE user_id=u)<>1000 OR EXISTS(SELECT 1 FROM fixture_credits) THEN RAISE EXCEPTION 'waiting retirement moved funds'; END IF;
 result:=pg_temp.retire_lightning_occupancies(g,ARRAY[occ,occ]);
 IF result->>'departed'<>'1' OR result->>'credited_this_call'<>'57.35' OR result->>'remaining_seats'<>'0' THEN RAISE EXCEPTION 'normal retirement wrong: %',result; END IF;
 IF (SELECT balance FROM fixture_wallet WHERE user_id=u)<>1057.35 OR (SELECT count(*) FROM fixture_credits)<>1 THEN RAISE EXCEPTION 'normal original credit wrong'; END IF;
 IF (SELECT key FROM fixture_credits)<>'cashout:occupancy:'||occ::text THEN RAISE EXCEPTION 'original occupancy key lost'; END IF;
 IF (SELECT count(*) FROM fixture_session_closes WHERE user_id=u AND stack=57.35 AND reason='system')<>1 THEN RAISE EXCEPTION 'original session close lost'; END IF;
 result:=pg_temp.retire_lightning_occupancies(g,ARRAY[occ]);
 IF result->>'replayed'<>'1' OR result->>'credited_this_call'<>'0' OR (SELECT balance FROM fixture_wallet WHERE user_id=u)<>1057.35 THEN RAISE EXCEPTION 'retirement replay paid twice: %',result; END IF;
 IF to_regprocedure('public.fn_cash_retire_lightning_occupancies(uuid,uuid[])') IS NOT NULL THEN RAISE EXCEPTION 'retirement installed a public API'; END IF;
END $retirement$;

