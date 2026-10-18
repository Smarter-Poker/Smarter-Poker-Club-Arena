-- A later buy-in at the same table must not change the historical club.
-- Also prove the dated seat fallback and preserve the per-hand witness.
DO $$
DECLARE
  J constant uuid := 'a0000000-0000-0000-0000-000000000001';
  S constant uuid := 'a4143400-0000-0000-0000-000000000001';
  U constant uuid := 'fade0000-0000-0000-0000-000000000001';
  P constant uuid := '00000000-0000-0000-0000-0000000000b1';
  T uuid := gen_random_uuid(); T2 uuid := gen_random_uuid();
  H uuid := gen_random_uuid(); H2 uuid := gen_random_uuid();
  at_hand timestamptz := now() - interval '36 hours';
  failures text[] := '{}'; v numeric;
BEGIN
  INSERT INTO tables(id,club_id,union_id,name) VALUES(T,S,U,'Historical receipt'),(T2,S,U,'Historical seat');
  INSERT INTO cash_participant_funding_receipts(operation_kind,table_id,account_entity_id,funding_club_id,seat_joined_at)
    VALUES('buyin',T,P,J,at_hand-interval '1 hour'),('buyin',T,P,S,at_hand+interval '1 hour');
  INSERT INTO table_seats(table_id,user_id,club_id,stack,left_at,joined_at)
    VALUES(T2,P,J,0,at_hand+interval '30 minutes',at_hand-interval '1 hour'),
          (T2,P,S,100,NULL,at_hand+interval '1 hour');
  INSERT INTO rake_records(id,table_id,club_id,is_tournament,rake_amount,player_contributions,created_at)
    VALUES(H,T,U,false,10,jsonb_build_object(P::text,1.5),at_hand),
          (H2,T2,U,false,7,jsonb_build_object(P::text,2.5,'malformed','ignored'),at_hand);
  SELECT sum(rake) INTO v FROM fn_ca_club_rake_daily_compute(at_hand,at_hand,ARRAY[H]) WHERE club_id=J;
  IF v IS DISTINCT FROM 10::numeric THEN failures:=array_append(failures,'later receipt moved historical rake'); END IF;
  SELECT sum(rake) INTO v FROM fn_ca_club_rake_daily_compute(at_hand,at_hand,ARRAY[H2]) WHERE club_id=J;
  IF v IS DISTINCT FROM 7::numeric THEN failures:=array_append(failures,'later seat moved historical rake'); END IF;
  SELECT sum(rake) INTO v FROM fn_ca_club_rake_daily_compute(at_hand,at_hand,ARRAY[H,H2]);
  IF v IS DISTINCT FROM 17::numeric THEN failures:=array_append(failures,'rake conservation failed'); END IF;
  INSERT INTO rake_attributions(rake_record_id,player_id,club_id) VALUES(H,P,S);
  SELECT sum(rake) INTO v FROM fn_ca_club_rake_daily_compute(at_hand,at_hand,ARRAY[H]) WHERE club_id=S;
  IF v IS DISTINCT FROM 10::numeric THEN failures:=array_append(failures,'witness lost precedence'); END IF;
  IF cardinality(failures)>0 THEN RAISE EXCEPTION 'history regression: %',array_to_string(failures,', '); END IF;
  RAISE NOTICE 'HISTORY SCENARIO PASSED';
END $$;
