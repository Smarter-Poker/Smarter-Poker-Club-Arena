DO $$ DECLARE occ uuid:=gen_random_uuid(); result jsonb; BEGIN
 UPDATE table_seats SET occupancy_id=occ,joined_at=now() WHERE table_id='72000000-0000-4000-8000-000000000001';
 INSERT INTO fixture_wallet VALUES('73000000-0000-4000-8000-000000000001',1000);
 UPDATE tables SET dealing_halt_observed_at=clock_timestamp() WHERE id='72000000-0000-4000-8000-000000000001';
 result:=pg_temp.retire_lightning_occupancies('71000000-0000-4000-8000-000000000001',ARRAY[occ]);
 IF result->>'ok' IS DISTINCT FROM 'true' OR (result->>'credited_this_call')::numeric IS DISTINCT FROM 57.35 THEN RAISE EXCEPTION 'Pineapple normal retirement failed: %',result; END IF;
 result:=pg_temp.retire_lightning_occupancies('71000000-0000-4000-8000-000000000001',ARRAY[occ]);
 IF (result->>'replayed')::int IS DISTINCT FROM 1 OR (result->>'credited_this_call')::numeric IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'Pineapple retirement replay failed'; END IF;
 IF (SELECT balance FROM fixture_wallet WHERE user_id='73000000-0000-4000-8000-000000000001') IS DISTINCT FROM 1057.35 THEN
  RAISE EXCEPTION 'Pineapple wallet credit was not exact'; END IF;
END $$;
