\set ON_ERROR_STOP on
DO $$ BEGIN
 IF current_database()<>'poker_diamond_phase6_test' OR inet_server_addr() IS NOT NULL
 OR current_setting('port')<>'55472' THEN RAISE EXCEPTION 'isolated phase6 fixture only'; END IF;
END $$;
-- The door under certification, loaded from the SAME file that was applied to
-- production. Its own preflight pins the md5 of the four Phase 6 functions it
-- depends on, so if this fixture has drifted from production the load fails
-- here rather than certifying something the estate does not run.
\ir ../../supabase/migrations/20260912004100_a_diamond_seat_tops_up_from_the_custody_it_sat_with.sql

-- A player who exists and is NOT seated, so the no-seat refusal proves the seat
-- check rather than a missing profile. The fixture holds only the two seated
-- players, and using an id that is neither made that case answer
-- profile_not_found: a true refusal, and not the one it was written to prove.
INSERT INTO profiles(id,diamonds,updated_at)
 VALUES('10000000-0000-0000-0000-000000000003',500,now())
 ON CONFLICT (id) DO NOTHING;
