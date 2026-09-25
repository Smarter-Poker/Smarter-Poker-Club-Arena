CREATE FUNCTION spin_fixture.complete_union_original_admission() RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',spin_fixture.u(2),'role','authenticated')::text,true);
 PERFORM spin_fixture.assert(public.fn_register_for_tournament_before_atomic_capacity_20260907(spin_fixture.u(202),true)->>'ok'='true','Second original Union entry succeeds');
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',spin_fixture.u(3),'role','authenticated')::text,true);
 PERFORM spin_fixture.assert(public.fn_register_for_tournament_before_atomic_capacity_20260907(spin_fixture.u(202),true)->>'ok'='true','Third original Union entry succeeds');
 PERFORM set_config('session_replication_role','replica',true);
 INSERT INTO public.tables(id,club_id,union_id,tournament_id,name,game_type,max_players,status,starting_chips,seat_game_scope,seat_admission_key)
 VALUES(spin_fixture.u(302),spin_fixture.u(102),spin_fixture.u(151),spin_fixture.u(202),'Original Union Spin Table','tournament',3,'waiting',300,
 'table:'||spin_fixture.u(302)::text,'tournament:'||spin_fixture.u(202)::text);
 INSERT INTO public.table_seats(id,table_id,user_id,seat_number,stack,club_id,occupancy_id,active_game_scope,active_parent_key)
 SELECT spin_fixture.u(600+n),spin_fixture.u(302),spin_fixture.u(n),n,300,spin_fixture.u(102),spin_fixture.u(700+n),
 'table:'||spin_fixture.u(302)::text,'tournament:'||spin_fixture.u(202)::text FROM generate_series(1,3)n;
 PERFORM set_config('session_replication_role','origin',true);
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 PERFORM spin_fixture.assert(public.fn_spin_book_entry(spin_fixture.u(202))->>'ok'='true','Original Union booking creates reserve and raw fee');
 -- Final card/finish state alone is a synthetic scene; money remains original.
 PERFORM set_config('session_replication_role','replica',true);
 UPDATE public.tournaments SET status='COMPLETING' WHERE id=spin_fixture.u(202);
 PERFORM set_config('session_replication_role','origin',true);
END $$;
