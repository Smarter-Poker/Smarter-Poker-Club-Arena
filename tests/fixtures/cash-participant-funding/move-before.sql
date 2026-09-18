SET request.jwt.claims='{"role":"service_role","sub":"00000000-0000-0000-0000-000000000900"}';
INSERT INTO auth.users(id) SELECT fixture.u(x) FROM generate_series(1190,1193) x;
INSERT INTO profiles(id,username,is_horse) SELECT fixture.u(x),'move_native_'||x,x IN(1191,1192) FROM generate_series(1190,1193) x;
INSERT INTO club_members(user_id,club_id,chip_balance,role,status) SELECT fixture.u(x),fixture.u(101),500,'player','active' FROM generate_series(1190,1193) x;
INSERT INTO cash_games(id,club_id,union_id,name,template_name,variant,sb,bb,handedness,ruleset_snapshot) VALUES(fixture.u(1200),fixture.u(101),fixture.u(201),'Original move game','classic','nlh',3,6,9,'{}');
INSERT INTO tables(id,name,game_type,cluster_id,club_id,union_id,min_buy_in,max_buy_in,is_private,status,max_players) SELECT fixture.u(x),'Original move table '||x,'cash',fixture.u(1200),fixture.u(101),fixture.u(201),1,1000,false,'waiting',9 FROM generate_series(1201,1204) x;
SELECT atomic_table_buyin_before_maintenance_announcement_gate(fixture.u(1190),fixture.u(1201),1,100,false,fixture.u(101),NULL);
SELECT atomic_table_buyin_before_maintenance_announcement_gate(fixture.u(1191),fixture.u(1201),2,100,false,fixture.u(101),NULL);
CREATE FUNCTION fixture.move(n int,p int,src int,dst int) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;BEGIN
 INSERT INTO cash_seat_moves(id,player_id,game_id,from_table_id,to_table_id,reason,state,expires_at)
 VALUES(fixture.u(n),fixture.u(p),fixture.u(1200),fixture.u(src),fixture.u(dst),'must_move','pending',clock_timestamp()+interval '10 minutes');
 r:=fn_cash_seat_move_execute(fixture.u(n));
 PERFORM fixture.assert(r->>'ok'='true','Actual original move '||n||': '||r::text);RETURN r;
END $$;
CREATE FUNCTION fixture.move_roster(t int) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_agg(jsonb_build_object('user_id',s.user_id,'seat_id',s.id,'occupancy_id',s.occupancy_id,'seat_joined_at',s.joined_at,'stack_before',s.stack,'is_horse',p.is_horse) ORDER BY s.user_id)
 FROM table_seats s JOIN profiles p ON p.id=s.user_id WHERE s.table_id=fixture.u(t) AND s.left_at IS NULL
$$;
INSERT INTO engine_table_leases(table_id,instance_id,lease_generation,protocol_version,heartbeat_at)
SELECT fixture.u(x),'move-native',fixture.u(1299),2,clock_timestamp() FROM generate_series(1201,1204) x;
SELECT fixture.move(1301,1190,1201,1202);
SELECT fixture.move(1302,1190,1202,1203);
SELECT fixture.move(1303,1191,1201,1203);
SELECT fixture.assert((fn_cash_capture_hand_manifest(fixture.u(1203),1013001,fixture.move_roster(1203),'move-native',fixture.u(1299))->>'funding_provenance_complete')::boolean=false,'RED original manifest loses exact original buy-in after legal move');
SELECT fixture.assert((SELECT count(*)=2 FROM cash_participant_funding_receipts WHERE user_id IN(fixture.u(1190),fixture.u(1191))),'Move creates no second debit or admission');
-- A separate original wallet admission plus actual same-club treasury reload.
SELECT atomic_table_buyin_before_maintenance_announcement_gate(fixture.u(1192),fixture.u(1204),1,100,false,fixture.u(101),NULL);
SELECT atomic_table_buyin_before_maintenance_announcement_gate(fixture.u(1193),fixture.u(1204),2,100,false,fixture.u(101),NULL);
SET request.jwt.claims='{"role":"service_role","sub":"00000000-0000-0000-0000-000000000901"}';
SELECT fixture.assert(fn_horse_fund_from_treasury_before_maintenance_gate(fixture.u(1204),fixture.u(1192),25,fixture.u(1400))->>'success'='true','Original same-club treasury top-up');
SELECT fixture.assert((fn_cash_capture_hand_manifest(fixture.u(1204),1013002,fixture.move_roster(1204),'move-native',fixture.u(1299))->>'funding_provenance_complete')::boolean=false,'RED old account-level test refuses evidenced same-club funding');
