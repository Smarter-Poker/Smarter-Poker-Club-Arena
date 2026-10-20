-- Private captured PostgreSQL fixture only; every money leg rolls back.
\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('test.clock_fixed', :'clock_fixed', true);
SET LOCAL "test.user"='d1000000-0000-4000-8000-000000000005';
DO $$
DECLARE
 player uuid:='d1000000-0000-4000-8000-000000000005';
 club uuid:='d1000000-0000-4000-8000-000000000003';
 fixed boolean:=current_setting('test.clock_fixed')::boolean;
 at_time timestamptz:=clock_timestamp();
 rid uuid; r crash_rounds; result jsonb; replay jsonb;
 before_chips numeric; before_promo numeric; elapsed bigint;
BEGIN
 IF current_database()<>'diamond_games_probe' THEN RAISE EXCEPTION 'Requires The Isolated Fixture'; END IF;
 DELETE FROM engine_maintenance_thaws;
 UPDATE engine_maintenance_break SET enforce_freeze=false;
 INSERT INTO engine_maintenance_thaws(freeze_started_at,frozen_seconds,shifted)
 VALUES(at_time-interval '305 seconds',300,'{}');
 INSERT INTO diamond_game_configs(host_id,host_kind,game,enabled,min_seconds_between_rounds)
 VALUES(club,'club','crash',true,0);
 INSERT INTO diamond_game_pools(host_id,game,intake_diamonds) VALUES(club,'crash',10000);
 rid:=gen_random_uuid();
 INSERT INTO crash_rounds(id,host_id,host_kind,club_id,user_id,bet_diamonds,bet_chips,diamonds_per_chip,commit_id,server_seed_hash,server_seed,client_seed,nonce,roll,crash_cents,cap_cents,growth_k,reserved_chips,started_at,chips_minted,diamonds_after)
 VALUES(rid,club,'club',club,player,100,1,100,gen_random_uuid(),encode(extensions.digest('clock-server','sha256'),'hex'),'clock-server','clock-client',1,1,500,1000,.12,10,at_time-interval '310 seconds',0,100000)
 RETURNING * INTO r;
 UPDATE diamond_game_pools SET reserved_chips=reserved_chips+10 WHERE host_id=club AND game='crash';
 SELECT chip_balance INTO before_chips FROM club_members WHERE club_id=club AND user_id=player;
 SELECT promo_balance INTO before_promo FROM clubs WHERE id=club;
 SET LOCAL ROLE authenticated;
 result:=fn_crash_settle(rid,false);
 RESET ROLE;
 IF NOT fixed THEN
  IF result->>'status'<>'crashed' THEN RAISE EXCEPTION 'Did not reproduce the break consuming the flight: %',result; END IF;
  RAISE NOTICE 'PASS Crash clock before: wall time consumes the paused flight';
  RETURN;
 END IF;
 IF result->>'status'<>'open' OR abs((result->>'elapsed_ms')::bigint-10000)>1000 THEN
  RAISE EXCEPTION 'Paused flight was consumed: %',result;
 END IF;
 IF (SELECT chip_balance FROM club_members WHERE club_id=club AND user_id=player)<>before_chips THEN RAISE EXCEPTION 'An open flight paid'; END IF;
 SET LOCAL ROLE authenticated;
 result:=fn_crash_cashout(rid,257);
 replay:=fn_crash_cashout(rid,257);
 RESET ROLE;
 IF result#>>'{outcome,payout_chips}'<>'2.57' OR replay->'outcome' IS DISTINCT FROM result->'outcome'
 OR (SELECT chip_balance FROM club_members WHERE club_id=club AND user_id=player)<>before_chips+2.57
 OR (SELECT promo_balance FROM clubs WHERE id=club)<>before_promo-2.57 THEN RAISE EXCEPTION 'Wrong resumed payout or replay: %',result; END IF;
 -- Exact interval boundaries, including a round started inside a freeze,
 -- successive breaks and a current break already represented in thaw history.
 DELETE FROM engine_maintenance_thaws;
 INSERT INTO engine_maintenance_thaws(freeze_started_at,frozen_seconds,shifted)
 VALUES('2040-01-01T00:00:10Z',300,'{}'),('2040-01-01T01:00:10Z',300,'{}');
 IF fn_crash_flight_ms('2040-01-01T00:00:00Z','2040-01-01T00:00:10Z')<>10000
 OR fn_crash_flight_ms('2040-01-01T00:00:00Z','2040-01-01T00:05:10Z')<>10000
 OR fn_crash_flight_ms('2040-01-01T00:00:00Z','2040-01-01T00:05:12Z')<>12000
 OR fn_crash_flight_ms('2040-01-01T00:01:00Z','2040-01-01T00:05:12Z')<>2000
 OR fn_crash_flight_ms('2040-01-01T00:00:00Z','2040-01-01T01:05:12Z')<>3312000
 THEN RAISE EXCEPTION 'Historical freeze overlap was not exact'; END IF;
 INSERT INTO engine_maintenance_break(id,phase,enforce_freeze,break_started_at,break_ends_at,ownership_token)
 VALUES(true,'counting_down',true,'2040-01-01T00:00:10Z','2040-01-01T00:05:10Z',gen_random_uuid())
 ON CONFLICT(id) DO UPDATE SET enforce_freeze=true,break_started_at=excluded.break_started_at;
 IF fn_crash_flight_ms('2040-01-01T00:00:00Z','2040-01-01T00:05:12Z')<>12000 THEN RAISE EXCEPTION 'Recorded break was counted twice'; END IF;
 DELETE FROM engine_maintenance_thaws;
 IF fn_crash_flight_ms('2040-01-01T00:00:00Z','2040-01-01T00:03:00Z')<>10000 THEN RAISE EXCEPTION 'Current break advances the flight'; END IF;
 IF has_function_privilege('authenticated','fn_crash_flight_ms(timestamptz,timestamptz)','EXECUTE')
 OR has_function_privilege('anon','fn_crash_flight_ms(timestamptz,timestamptz)','EXECUTE') THEN RAISE EXCEPTION 'Private clock access widened'; END IF;
 RAISE NOTICE 'PASS Crash maintenance clock: paused flight stays open, exact resumed payout once, historical/current/multiple freeze boundaries and private authority';
END $$;
ROLLBACK;
