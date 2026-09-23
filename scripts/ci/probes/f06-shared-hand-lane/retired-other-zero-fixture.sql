-- Isolated native players, never a production fixture or a claim about play.
CREATE FUNCTION fixture_seed_other_zero() RETURNS void LANGUAGE plpgsql AS $$
DECLARE j integer; tab uuid:=fixture_other_zero_table(); t uuid:=fixture_origin_t(1401);
BEGIN
 FOR j IN 1..3 LOOP
 INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,occupancy_id,joined_at,left_at)
 VALUES(md5('rz-seat'||j)::uuid,tab,md5('rz-user'||j)::uuid,j,(ARRAY[70000,30000,0])[j],
 md5('rz-occupancy'||j)::uuid,'2026-09-18 21:00:00+00',CASE WHEN j=3 THEN '2026-09-18 22:12:06+00'::timestamptz ELSE NULL END);
 INSERT INTO tournament_players VALUES(md5('rz-registration'||j)::uuid,t,tab,md5('rz-user'||j)::uuid,j,(ARRAY[70000,30000,0])[j],'playing');
 END LOOP;
 PERFORM fixture_other_zero_atomic(1401,'zero',12941429,true);
 PERFORM fixture_other_zero_atomic(1401,'later',12942039,false);
 UPDATE fixture_origin_inputs SET input=jsonb_set(input,'{accepted_zeros}',jsonb_build_array(jsonb_build_object(
 'registration_id',md5('rz-registration3')::uuid,'seat_id',md5('rz-seat3')::uuid,
 'atomic_hand_id',md5('rz-atomic-zero1401')::uuid,'stack_hand_id',md5('rz-stack-zero1401')::uuid))) WHERE i=1401;
END $$;

CREATE FUNCTION fixture_other_zero_business() RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_agg(v ORDER BY v::text) FROM (
 SELECT to_jsonb(x) v FROM tournament_players x UNION ALL SELECT to_jsonb(x) FROM table_seats x
 UNION ALL SELECT to_jsonb(x) FROM hand_atomic_commits x UNION ALL SELECT to_jsonb(x) FROM hand_history x
 UNION ALL SELECT to_jsonb(x) FROM settlement_idempotency_keys x UNION ALL SELECT to_jsonb(x) FROM ca_settlements x
 UNION ALL SELECT to_jsonb(x) FROM smarter_private.f06_operations x UNION ALL SELECT to_jsonb(x) FROM smarter_private.f06_members x
 UNION ALL SELECT to_jsonb(x) FROM smarter_private.f06_attempts x UNION ALL SELECT to_jsonb(x) FROM tournament_seat_move_receipts x
 ) q
$$;
