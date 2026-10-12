-- ============================================================================
-- DIAMOND PHASE 11, LINE 2 - ONE LOCK ORDER FOR A DIAMOND SEAT, REHEARSED
-- ============================================================================
-- REHEARSAL ONLY. Run by the swarm's rehearse.sh against production, once with
-- an empty migration ("before") and once with
-- 20260930123828_a_diamond_seat_takes_the_table_cap_before_the_wallet.sql
-- ("after"). ONE transaction ending in RAISE EXCEPTION 'REHEARSAL OK ...', so
-- NOTHING persists: the session, the admin role on the system account and the
-- Diamond MTT the staff door creates exist only inside the rolled-back
-- transaction. No switch is opened and no Diamond moves. The player is the
-- synthetic horse_final_56@hydra.bot account (no seat, no journal row since May).
--
-- It proves, in production's catalogue and in one session: a Diamond seat
-- acquisition takes the player's table-cap lock (the lock the Diamond cash doors
-- take first) - not before the migration, and after it - while a seat
-- acquisition for an event that is not a Diamond event takes none. The race
-- itself - a registration and a cash buy-in of one player deadlocking, and not
-- after the fix - runs on the isolated fixture: tests/sql/run-diamond-concurrency.py.
-- ============================================================================
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '20s';
DO $rehearsal$
DECLARE
  v_staff CONSTANT uuid := '00000000-0000-0000-0000-000000000001';
  v_player CONSTANT uuid := '00000000-0000-0000-0000-000000000056';
  v_other CONSTANT uuid := '00000000-0000-0000-0000-000000000057';
  v_identity numeric; v_tid uuid; v_fixed boolean; v_mode text; v_res jsonb; v_held integer; v_other_held integer;
  k bigint;
BEGIN
  v_identity := (SELECT difference FROM public.fn_ca_diamond_register_vs_supply());
  v_fixed := position('hashtextextended(''table_cap:'' || p_user_id::text, 0)' IN
                      pg_get_functiondef('public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)'::regprocedure)) > 0;
  v_mode := CASE WHEN v_fixed THEN 'after' ELSE 'before' END;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE cash_games_enabled OR tournaments_enabled) THEN
    RAISE EXCEPTION 'an arena switch is open; this rehearsal expects both closed';
  END IF;

  -- The scene, inside this transaction only: the staff door creates a Diamond MTT.
  INSERT INTO auth.sessions(id, user_id, created_at, updated_at) VALUES
    (uuid_in(md5('p11-lock-order:' || v_staff::text)::cstring), v_staff, now(), now());
  UPDATE public.profiles SET role = 'admin' WHERE id = v_staff;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_staff,
    'session_id', uuid_in(md5('p11-lock-order:' || v_staff::text)::cstring))::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_staff::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  v_tid := (public.fn_poker_diamond_create_tournament(jsonb_build_object(
    'name', 'Phase 11 lock-order rehearsal', 'type', 'mtt', 'gameVariant', 'NLH', 'buyIn', 25,
    'maxPlayers', 9, 'minPlayers', 2, 'startingStack', 10000,
    'blindStructure', '[{"level":1,"smallBlind":25,"bigBlind":50,"ante":0,"duration":600},{"level":2,"smallBlind":50,"bigBlind":100,"ante":0,"duration":600}]'::jsonb,
    'payoutStructure', '[{"place":1,"percentage":50},{"place":2,"percentage":30},{"place":3,"percentage":20}]'::jsonb,
    'startTime', (now() + interval '1 hour')::text))->>'tournamentId')::uuid;
  IF v_tid IS NULL THEN RAISE EXCEPTION 'the staff door did not create the rehearsal event'; END IF;

  -- The engine's seat acquisition for the synthetic player, as a registration runs it.
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  v_res := public.fn_ca_lock_tournament_seat_acquisition(v_tid, NULL, v_player);
  IF (v_res->>'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'the seat acquisition refused the rehearsal event: %', v_res;
  END IF;
  k := hashtextextended('table_cap:' || v_player::text, 0);
  SELECT count(*) INTO v_held FROM pg_locks
   WHERE pid = pg_backend_pid() AND locktype = 'advisory' AND granted
     AND classid = ((k >> 32) & 4294967295)::oid AND objid = (k & 4294967295)::oid AND objsubid = 1;
  IF v_fixed AND v_held <> 1 THEN
    RAISE EXCEPTION 'after the migration a Diamond seat acquisition did not take the table-cap lock';
  ELSIF NOT v_fixed AND v_held <> 0 THEN
    RAISE EXCEPTION 'before the migration a Diamond seat acquisition already took the table-cap lock';
  END IF;

  -- An event that is not a Diamond event takes no table-cap lock (an id no event has).
  v_res := public.fn_ca_lock_tournament_seat_acquisition(gen_random_uuid(), NULL, v_other);
  k := hashtextextended('table_cap:' || v_other::text, 0);
  SELECT count(*) INTO v_other_held FROM pg_locks
   WHERE pid = pg_backend_pid() AND locktype = 'advisory'
     AND classid = ((k >> 32) & 4294967295)::oid AND objid = (k & 4294967295)::oid AND objsubid = 1;
  IF v_other_held <> 0 THEN
    RAISE EXCEPTION 'a seat acquisition for an event that is not a Diamond event took the table-cap lock';
  END IF;

  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) IS DISTINCT FROM v_identity THEN
    RAISE EXCEPTION 'the Diamond identity moved';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE cash_games_enabled OR tournaments_enabled) THEN
    RAISE EXCEPTION 'an arena switch was opened';
  END IF;
  RAISE EXCEPTION 'REHEARSAL OK [%]: a Diamond seat acquisition % the table-cap lock, a non-Diamond one takes none, identity % unchanged, switches closed',
    v_mode, CASE WHEN v_fixed THEN 'takes' ELSE 'does not take (the inversion)' END, v_identity;
END $rehearsal$;
