-- ============================================================================
-- DIAMOND PHASE 11, LINE 2 - ONE LOCK ORDER FOR EVERY SEAT, REHEARSED
-- ============================================================================
-- REHEARSAL ONLY. Run by the swarm's rehearse.sh against production, once with
-- an empty migration ("before") and once with
-- 20260930131333_every_seat_takes_the_table_cap_before_the_wallet.sql
-- ("after"). ONE transaction ending in RAISE EXCEPTION 'REHEARSAL OK ...', so
-- NOTHING persists: the sessions, the admin role on the system account, the
-- Diamond MTT the staff door creates, the chip club, its freeroll, the club
-- membership and the chip registration exist only inside the rolled-back
-- transaction. No switch is opened and no Diamond moves. The players are the
-- synthetic loosepassive and madehand accounts (horse_final_56 and _57 at
-- hydra.bot), which hold no seat and no membership.
--
-- It proves, in production's catalogue and in one session:
--   - a Diamond seat acquisition takes the player's table-cap lock, before the
--     migration and after it;
--   - a chip seat acquisition takes it after the migration and not before, and
--     answers exactly as it did, holding the Daily Missions lock either way;
--   - a chip registration, through the club join door and the registration
--     door, is admitted exactly as before: ok, asset chips, nothing charged, one
--     roster row - so the chip path changed its lock order and nothing else.
-- The races themselves - a chip registration meeting the same player's Diamond
-- registration or cash buy-in, deadlocking before and not after - run on the
-- isolated fixture: tests/sql/run-diamond-concurrency.py.
-- ============================================================================
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
DO $rehearsal$
DECLARE
  v_staff CONSTANT uuid := '00000000-0000-0000-0000-000000000001';
  v_dia_player CONSTANT uuid := '00000000-0000-0000-0000-000000000056';
  v_chip_player CONSTANT uuid := '00000000-0000-0000-0000-000000000057';
  v_club CONSTANT uuid := 'c0000000-0000-0000-0000-0000000000c1';
  v_identity numeric; v_fixed boolean; v_mode text; v_def text;
  v_dia uuid; v_chip uuid; v_res jsonb; v_reg jsonb; v_diamonds integer;
  v_dia_cap integer; v_chip_cap integer; v_chip_dm integer; v_roster integer;
  k bigint;
BEGIN
  v_identity := (SELECT difference FROM public.fn_ca_diamond_register_vs_supply());
  v_def := pg_get_functiondef('public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)'::regprocedure);
  v_fixed := position('WHERE c.asset = ''diamonds''' IN v_def) = 0
         AND position('hashtextextended(''table_cap:'' || p_user_id::text, 0)' IN v_def) > 0;
  v_mode := CASE WHEN v_fixed THEN 'after' ELSE 'before' END;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE cash_games_enabled OR tournaments_enabled) THEN
    RAISE EXCEPTION 'an arena switch is open; this rehearsal expects both closed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.clubs WHERE id = v_club)
     OR EXISTS (SELECT 1 FROM public.club_members WHERE user_id IN (v_dia_player, v_chip_player)) THEN
    RAISE EXCEPTION 'the rehearsal scene is not empty';
  END IF;
  v_diamonds := (SELECT diamonds FROM public.profiles WHERE id = v_chip_player);

  -- The scene, inside this transaction only. The staff account opens a Diamond
  -- MTT through the staff door, and a chip club with a chip freeroll through the
  -- chip create door, as the club's owner.
  INSERT INTO auth.sessions(id, user_id, created_at, updated_at) VALUES
    (uuid_in(md5('p11-every-seat:' || v_staff::text)::cstring), v_staff, now(), now()),
    (uuid_in(md5('p11-every-seat:' || v_chip_player::text)::cstring), v_chip_player, now(), now());
  UPDATE public.profiles SET role = 'admin' WHERE id = v_staff;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_staff,
    'session_id', uuid_in(md5('p11-every-seat:' || v_staff::text)::cstring))::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_staff::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  v_dia := (public.fn_poker_diamond_create_tournament(jsonb_build_object(
    'name', 'Phase 11 every-seat rehearsal', 'type', 'mtt', 'gameVariant', 'NLH', 'buyIn', 25,
    'maxPlayers', 9, 'minPlayers', 2, 'startingStack', 10000,
    'blindStructure', '[{"level":1,"smallBlind":25,"bigBlind":50,"ante":0,"duration":600},{"level":2,"smallBlind":50,"bigBlind":100,"ante":0,"duration":600}]'::jsonb,
    'payoutStructure', '[{"place":1,"percentage":50},{"place":2,"percentage":30},{"place":3,"percentage":20}]'::jsonb,
    'startTime', (now() + interval '1 hour')::text))->>'tournamentId')::uuid;
  IF v_dia IS NULL THEN RAISE EXCEPTION 'the staff door did not create the Diamond rehearsal event'; END IF;
  INSERT INTO public.clubs(id, name, slug, asset, is_platform, is_union, owner_id, chip_treasury,
                           description, tagline, is_public)
  VALUES (v_club, 'Phase 11 every-seat rehearsal', 'p11-every-seat-rehearsal', 'chips', false, false,
          v_staff, 0, 'Rolled back with the rehearsal.', 'Rehearsal', true);
  v_chip := (public.fn_create_tournament(v_club, jsonb_build_object(
    'name', 'Phase 11 every-seat chip freeroll', 'type', 'mtt', 'gameVariant', 'NLH', 'buyIn', 0,
    'maxPlayers', 9, 'minPlayers', 2, 'startingStack', 10000,
    'blindStructure', '[{"level":1,"smallBlind":25,"bigBlind":50,"ante":0,"duration":600},{"level":2,"smallBlind":50,"bigBlind":100,"ante":0,"duration":600}]'::jsonb,
    'payoutStructure', '[{"place":1,"percentage":50},{"place":2,"percentage":30},{"place":3,"percentage":20}]'::jsonb,
    'startTime', (now() + interval '1 hour')::text))->>'tournament_id')::uuid;
  IF v_chip IS NULL THEN RAISE EXCEPTION 'the chip create door did not create the chip rehearsal event'; END IF;

  -- The engine's seat acquisition, as a registration runs it.
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  v_res := public.fn_ca_lock_tournament_seat_acquisition(v_dia, NULL, v_dia_player);
  IF (v_res->>'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'the seat acquisition refused the Diamond rehearsal event: %', v_res;
  END IF;
  k := hashtextextended('table_cap:' || v_dia_player::text, 0);
  SELECT count(*) INTO v_dia_cap FROM pg_locks
   WHERE pid = pg_backend_pid() AND locktype = 'advisory' AND granted
     AND classid = ((k >> 32) & 4294967295)::oid AND objid = (k & 4294967295)::oid AND objsubid = 1;
  IF v_dia_cap <> 1 THEN
    RAISE EXCEPTION 'a Diamond seat acquisition did not take the table-cap lock (%)', v_mode;
  END IF;

  v_res := public.fn_ca_lock_tournament_seat_acquisition(v_chip, NULL, v_chip_player);
  IF v_res IS DISTINCT FROM jsonb_build_object('ok', true, 'tournament_id', v_chip, 'table_id', NULL,
                                               'status', 'REGISTERING') THEN
    RAISE EXCEPTION 'a chip seat acquisition answered differently: %', v_res;
  END IF;
  k := hashtextextended('table_cap:' || v_chip_player::text, 0);
  SELECT count(*) INTO v_chip_cap FROM pg_locks
   WHERE pid = pg_backend_pid() AND locktype = 'advisory' AND granted
     AND classid = ((k >> 32) & 4294967295)::oid AND objid = (k & 4294967295)::oid AND objsubid = 1;
  k := hashtextextended('daily-missions-user:' || v_chip_player::text, 0);
  SELECT count(*) INTO v_chip_dm FROM pg_locks
   WHERE pid = pg_backend_pid() AND locktype = 'advisory' AND granted
     AND classid = ((k >> 32) & 4294967295)::oid AND objid = (k & 4294967295)::oid AND objsubid = 1;
  IF v_chip_dm <> 1 THEN
    RAISE EXCEPTION 'a chip seat acquisition no longer holds the Daily Missions lock';
  END IF;
  IF v_fixed AND v_chip_cap <> 1 THEN
    RAISE EXCEPTION 'after the migration a chip seat acquisition did not take the table-cap lock';
  ELSIF NOT v_fixed AND v_chip_cap <> 0 THEN
    RAISE EXCEPTION 'before the migration a chip seat acquisition already took the table-cap lock';
  END IF;

  -- The chip player joins the club and registers, through the doors a client calls.
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_chip_player,
    'session_id', uuid_in(md5('p11-every-seat:' || v_chip_player::text)::cstring))::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_chip_player::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM public.fn_join_club(v_club);
  v_reg := public.fn_register_for_tournament_request(v_chip, gen_random_uuid());
  IF (v_reg->>'ok')::boolean IS DISTINCT FROM true OR v_reg->>'asset' IS DISTINCT FROM 'chips'
     OR (v_reg->>'cost')::numeric IS DISTINCT FROM 0 OR v_reg->>'registration_id' IS NULL THEN
    RAISE EXCEPTION 'the chip registration answered differently: %', v_reg;
  END IF;
  SELECT count(*) INTO v_roster FROM public.tournament_players
   WHERE tournament_id = v_chip AND user_id = v_chip_player;
  IF v_roster <> 1 THEN RAISE EXCEPTION 'the chip registration wrote % roster rows', v_roster; END IF;
  IF (SELECT diamonds FROM public.profiles WHERE id = v_chip_player) IS DISTINCT FROM v_diamonds THEN
    RAISE EXCEPTION 'a chip registration moved Diamonds';
  END IF;

  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) IS DISTINCT FROM v_identity THEN
    RAISE EXCEPTION 'the Diamond identity moved';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE cash_games_enabled OR tournaments_enabled) THEN
    RAISE EXCEPTION 'an arena switch was opened';
  END IF;
  RAISE EXCEPTION 'REHEARSAL OK [%]: a Diamond seat acquisition takes the table-cap lock; a chip seat acquisition %, still holds the Daily Missions lock and answers as before; a chip registration is admitted as before (ok, chips, cost 0, one roster row); identity % unchanged, switches closed',
    v_mode, CASE WHEN v_fixed THEN 'takes it too' ELSE 'does not (the inversion)' END, v_identity;
END $rehearsal$;
