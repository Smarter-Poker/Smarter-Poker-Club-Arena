-- PROBE: the Must Move Lobby (20260905060000), rolled back.
-- Run: build with scripts/dev/build-probe.sh style substitution of the PART2 token
-- (the migration's Part 2c without BEGIN/COMMIT; 2a and 2b are applied first) and psql -f; the file ends in
-- ROLLBACK, so nothing here reaches the board. CLAUDE.md 11.5.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

__PART2__

DO $probe$
DECLARE
  g record; main1 uuid; main2 uuid; feeder uuid;
  ua uuid; ub uuid; uc uuid; ud uuid; ue uuid;
  sid uuid;
  r jsonb; l jsonb; m record; x record;
  v_move_a uuid; v_move_b uuid; v_move uuid;
  v_seat_a int; v_seat_b int; v_pos int;
  v_stack_a numeric; v_stack_b numeric;
  v_ok text := '';
  v_n int;
  ids uuid[];
  v_ts timestamptz;
BEGIN
  -- Fixture: the one live game with a feeder (PLO4 0.10/0.25 Classic).
  SELECT * INTO g FROM public.cash_games WHERE id = '2ba1c0a6-5b5e-4d0d-bf0b-effebd63b1c5';
  IF NOT FOUND THEN RAISE EXCEPTION 'fixture game gone'; END IF;
  SELECT id INTO main1 FROM public.tables WHERE cluster_id = g.id AND role = 'main' AND main_index = 1 AND lifecycle <> 'closed';
  SELECT id INTO feeder FROM public.tables WHERE cluster_id = g.id AND role = 'feeder' AND lifecycle <> 'closed';
  IF main1 IS NULL THEN RAISE EXCEPTION 'fixture Main 1 gone'; END IF;

  -- A Main 2 copied from Main 1, live and empty; the feeder made live.
  -- (generated columns dropped from the copy)
  main2 := gen_random_uuid();
  EXECUTE format('INSERT INTO public.tables (%s) SELECT %s FROM public.tables t WHERE t.id = $1',
    (SELECT string_agg(quote_ident(column_name), ',') FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tables' AND is_generated = 'NEVER'),
    (SELECT string_agg(CASE column_name
        WHEN 'id' THEN quote_literal(main2) || '::uuid'
        WHEN 'name' THEN quote_literal('PROBE Main 2')
        WHEN 'role' THEN quote_literal('main')
        WHEN 'main_index' THEN '2'
        WHEN 'lifecycle' THEN quote_literal('live')
        WHEN 'status' THEN quote_literal('running')
        WHEN 'current_players' THEN '0'
        WHEN 'created_at' THEN 'now()'
        WHEN 'updated_at' THEN 'now()'
        ELSE 't.' || quote_ident(column_name) END, ',' ORDER BY ordinal_position)
       FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tables' AND is_generated = 'NEVER'))
    USING main1;
  IF feeder IS NULL THEN
    feeder := gen_random_uuid();
    EXECUTE format('INSERT INTO public.tables (%s) SELECT %s FROM public.tables t WHERE t.id = $1',
      (SELECT string_agg(quote_ident(column_name), ',') FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'tables' AND is_generated = 'NEVER'),
      (SELECT string_agg(CASE column_name
          WHEN 'id' THEN quote_literal(feeder) || '::uuid'
          WHEN 'name' THEN quote_literal('PROBE Feeder')
          WHEN 'role' THEN quote_literal('feeder')
          WHEN 'main_index' THEN 'NULL'
          WHEN 'lifecycle' THEN quote_literal('live')
          WHEN 'status' THEN quote_literal('running')
          WHEN 'current_players' THEN '0'
          WHEN 'created_at' THEN 'now()'
          WHEN 'updated_at' THEN 'now()'
          ELSE 't.' || quote_ident(column_name) END, ',' ORDER BY ordinal_position)
         FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tables' AND is_generated = 'NEVER'))
      USING main1;
  END IF;
  UPDATE public.tables SET lifecycle = 'live', status = 'running' WHERE id = feeder;

  -- Five horses with no chair in this game and fewer than four live chairs.
  SELECT array_agg(id) INTO ids FROM (
    SELECT p.id FROM public.profiles p
     WHERE coalesce(p.is_horse, false)
       AND NOT EXISTS (SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id = s.table_id
                        WHERE s.user_id = p.id AND s.left_at IS NULL AND t.cluster_id = g.id)
       AND public.fn_concurrent_game_load(p.id, NULL, NULL, NULL) <= 1
       AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves mv WHERE mv.player_id = p.id AND mv.state = 'pending')
     ORDER BY p.id LIMIT 5) q;
  ua := ids[1]; ub := ids[2]; uc := ids[3]; ud := ids[4]; ue := ids[5];
  IF ue IS NULL THEN RAISE EXCEPTION 'not enough free horses'; END IF;

  -- Seat them: A and C on Main 2 (A first), B on the feeder (B joined the
  -- game between A and C), D on the feeder last, E on Main 2.
  INSERT INTO public.table_seats (table_id, seat_number, user_id, stack, status, joined_at, club_id)
  VALUES (main2, 1, ua, 20.00, 'active', now() - interval '50 minutes', g.club_id);
  INSERT INTO public.table_seats (table_id, seat_number, user_id, stack, status, joined_at, club_id)
  VALUES (feeder, 1, ub, 30.00, 'active', now() - interval '40 minutes', g.club_id);
  INSERT INTO public.table_seats (table_id, seat_number, user_id, stack, status, joined_at, club_id)
  VALUES (main2, 2, uc, 25.00, 'active', now() - interval '30 minutes', g.club_id);
  INSERT INTO public.table_seats (table_id, seat_number, user_id, stack, status, joined_at, club_id)
  VALUES (feeder, 2, ud, 12.50, 'active', now() - interval '20 minutes', g.club_id);
  INSERT INTO public.table_seats (table_id, seat_number, user_id, stack, status, joined_at, club_id)
  VALUES (main2, 3, ue, 15.00, 'active', now() - interval '10 minutes', g.club_id);

  -- S1 the roster trigger put all five on the list at their chair time.
  SELECT count(*) INTO v_n FROM public.cash_game_roster WHERE game_id = g.id AND left_at IS NULL AND user_id IN (ua, ub, uc, ud, ue);
  IF v_n <> 5 THEN RAISE EXCEPTION 'S1 roster: % of 5', v_n; END IF;
  SELECT pos INTO v_pos FROM public.fn_cash_game_must_move_list(g.id) WHERE user_id = ua;
  IF v_pos <> 1 THEN RAISE EXCEPTION 'S1 order: A should be first, is %', v_pos; END IF;
  SELECT pos INTO v_pos FROM public.fn_cash_game_must_move_list(g.id) WHERE user_id = ub;
  IF v_pos <> 2 THEN RAISE EXCEPTION 'S1 order: B should be second, is %', v_pos; END IF;
  v_ok := v_ok || 'S1 roster+order ';

  -- S2 a Main 1 chair opens: the planner takes A (Main 2, earliest joiner),
  -- not B (the feeder's earliest), because Main 1 draws from the whole list.
  UPDATE public.table_seats SET stack = 0 WHERE table_id = main1 AND seat_number = (SELECT min(seat_number) FROM public.table_seats WHERE table_id = main1 AND left_at IS NULL);
  UPDATE public.table_seats SET left_at = now(), status = 'left' WHERE table_id = main1 AND stack = 0 AND left_at IS NULL;
  r := public.fn_cash_cluster_tick(g.id, 0);
  SELECT * INTO m FROM public.cash_seat_moves WHERE game_id = g.id AND state = 'pending' AND to_table_id = main1 ORDER BY created_at DESC LIMIT 1;
  IF m.player_id IS DISTINCT FROM ua THEN RAISE EXCEPTION 'S2 planner took % not A (tick %)', m.player_id, r; END IF;
  IF m.reason <> 'must_move' THEN RAISE EXCEPTION 'S2 reason %', m.reason; END IF;
  v_ok := v_ok || 'S2 main1-from-whole-list ';

  -- S3 executing it: A lands on Main 1 with entry_hold = moved, nothing
  -- posted, roster row untouched (same joined_at), off the must-move list.
  SELECT joined_at INTO v_ts FROM public.cash_game_roster WHERE game_id = g.id AND user_id = ua AND left_at IS NULL;
  r := public.fn_cash_seat_move_execute(m.id);
  IF NOT (r->>'ok')::boolean THEN RAISE EXCEPTION 'S3 execute %', r; END IF;
  SELECT * INTO m FROM public.table_seats WHERE user_id = ua AND left_at IS NULL AND table_id = main1;
  IF m.entry_hold IS DISTINCT FROM 'moved' OR m.entry_post_agreed THEN RAISE EXCEPTION 'S3 entry % %', m.entry_hold, m.entry_post_agreed; END IF;
  IF m.stack <> 20.00 THEN RAISE EXCEPTION 'S3 stack %', m.stack; END IF;
  IF (SELECT joined_at FROM public.cash_game_roster WHERE game_id = g.id AND user_id = ua AND left_at IS NULL) <> v_ts THEN
    RAISE EXCEPTION 'S3 roster joined_at moved';
  END IF;
  IF EXISTS (SELECT 1 FROM public.fn_cash_game_must_move_list(g.id) WHERE user_id = ua) THEN RAISE EXCEPTION 'S3 A still on the list'; END IF;
  v_ok := v_ok || 'S3 moved-entry ';
  -- (the same tick also planned B and D from the feeder onto Main 2's open
  -- chairs - must-move working as designed; those plans are withdrawn here
  -- so the seat-change door can be exercised on B and D, and the withdrawal
  -- is aged past the planner's back-off)
  UPDATE public.cash_seat_moves SET state = 'cancelled', note = 'probe', created_at = created_at - interval '2 minutes'
   WHERE game_id = g.id AND state = 'pending' AND player_id IN (ub, ud);

  -- S4 the door: B (feeder) requests any table. Main 2 has chairs open, so
  -- B is moving now with a seat_change move; entry will be waiting+agreed.
  INSERT INTO auth.sessions (id, user_id, created_at, updated_at) VALUES (gen_random_uuid(), ub, now(), now()) RETURNING id INTO sid;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated', 'session_id', sid)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  r := public.fn_cash_seat_change_request(g.id, NULL);
  EXECUTE 'RESET ROLE';
  IF r->>'action' <> 'moving' THEN RAISE EXCEPTION 'S4 expected moving, got %', r; END IF;
  SELECT * INTO m FROM public.cash_seat_moves WHERE game_id = g.id AND player_id = ub AND state = 'pending';
  IF m.reason <> 'seat_change' OR m.to_table_id <> main2 THEN RAISE EXCEPTION 'S4 move % -> %', m.reason, m.to_table_id; END IF;
  r := public.fn_cash_seat_move_execute(m.id);
  IF NOT (r->>'ok')::boolean THEN RAISE EXCEPTION 'S4 execute %', r; END IF;
  SELECT * INTO m FROM public.table_seats WHERE user_id = ub AND left_at IS NULL AND table_id = main2;
  IF m.entry_hold IS DISTINCT FROM 'waiting' OR NOT m.entry_post_agreed THEN RAISE EXCEPTION 'S4 entry % %', m.entry_hold, m.entry_post_agreed; END IF;
  IF (SELECT seat_change_used_at FROM public.cash_game_roster WHERE game_id = g.id AND user_id = ub AND left_at IS NULL) IS NULL THEN
    RAISE EXCEPTION 'S4 button not consumed';
  END IF;
  v_ok := v_ok || 'S4 seat-change-now ';

  -- S5 used once: B asks again -> SEAT_CHANGE_USED. From Main 1 (A) -> refused.
  -- To Main 1 (D) -> refused.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated', 'session_id', sid)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    r := public.fn_cash_seat_change_request(g.id, NULL);
    RAISE EXCEPTION 'S5 second request allowed: %', r;
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'SEAT_CHANGE_USED%' THEN RAISE EXCEPTION 'S5 wrong refusal %', SQLERRM; END IF;
  END;
  EXECUTE 'RESET ROLE';
  INSERT INTO auth.sessions (id, user_id, created_at, updated_at) VALUES (gen_random_uuid(), ua, now(), now()) RETURNING id INTO sid;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated', 'session_id', sid)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    r := public.fn_cash_seat_change_request(g.id, NULL);
    RAISE EXCEPTION 'S5 main 1 request allowed: %', r;
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'SEAT_CHANGE_NOT_FROM_MAIN%' THEN RAISE EXCEPTION 'S5 wrong refusal %', SQLERRM; END IF;
  END;
  EXECUTE 'RESET ROLE';
  INSERT INTO auth.sessions (id, user_id, created_at, updated_at) VALUES (gen_random_uuid(), ud, now(), now()) RETURNING id INTO sid;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', ud, 'role', 'authenticated', 'session_id', sid)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    r := public.fn_cash_seat_change_request(g.id, main1);
    RAISE EXCEPTION 'S5 to main 1 allowed: %', r;
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'SEAT_CHANGE_NEVER_TO_MAIN%' THEN RAISE EXCEPTION 'S5 wrong refusal %', SQLERRM; END IF;
  END;
  EXECUTE 'RESET ROLE';
  v_ok := v_ok || 'S5 refusals ';

  -- S6 the list and the swap. Fill Main 2 (6-max: A left it, B, C, E there =
  -- 3; add three more chairs by copying) so it has no open chair; D (feeder)
  -- requests Main 2 -> listed #1. C (Main 2) requests the feeder -> swap
  -- planned: two linked moves with each other's seat numbers.
  INSERT INTO public.table_seats (table_id, seat_number, user_id, stack, status, joined_at, club_id)
  SELECT main2, gs, NULL, 0, 'active', now(), g.club_id FROM generate_series(4, 6) gs
   WHERE NOT EXISTS (SELECT 1 FROM public.table_seats s WHERE s.table_id = main2 AND s.seat_number = gs AND s.left_at IS NULL);
  -- (a user-less chair still occupies the seat number for the census)
  PERFORM set_config('request.jwt.claims', json_build_object('sub', ud, 'role', 'authenticated', 'session_id', sid)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  r := public.fn_cash_seat_change_request(g.id, main2);
  EXECUTE 'RESET ROLE';
  IF r->>'action' <> 'listed' OR (r->>'position')::int <> 1 THEN RAISE EXCEPTION 'S6 expected listed #1, got %', r; END IF;
  l := public.fn_cash_game_lobby(g.id);
  IF (SELECT (t->>'seat_change_queue')::int FROM jsonb_array_elements(l->'tables') t WHERE t->>'id' = main2::text) <> 1 THEN
    RAISE EXCEPTION 'S6 lobby queue count wrong: %', l->'tables';
  END IF;
  INSERT INTO auth.sessions (id, user_id, created_at, updated_at) VALUES (gen_random_uuid(), uc, now(), now()) RETURNING id INTO sid;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', uc, 'role', 'authenticated', 'session_id', sid)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  r := public.fn_cash_seat_change_request(g.id, feeder);
  EXECUTE 'RESET ROLE';
  IF r->>'action' <> 'swapping' THEN RAISE EXCEPTION 'S6 expected swapping, got %', r; END IF;
  SELECT id, to_seat_number INTO v_move_a, v_seat_a FROM public.cash_seat_moves WHERE game_id = g.id AND player_id = ud AND state = 'pending';
  SELECT id, to_seat_number INTO v_move_b, v_seat_b FROM public.cash_seat_moves WHERE game_id = g.id AND player_id = uc AND state = 'pending';
  IF v_move_a IS NULL OR v_move_b IS NULL THEN RAISE EXCEPTION 'S6 swap moves missing'; END IF;
  IF (SELECT swap_move_id FROM public.cash_seat_moves WHERE id = v_move_a) <> v_move_b THEN RAISE EXCEPTION 'S6 link a'; END IF;
  IF v_seat_a <> 2 OR v_seat_b <> 2 THEN RAISE EXCEPTION 'S6 seats % %', v_seat_a, v_seat_b; END IF;
  -- Swaps are not reservations: Main 2 still reads as full, not over-full.
  IF public.fn_cash_game_open_seats(main2) <> 0 THEN RAISE EXCEPTION 'S6 open seats %', public.fn_cash_game_open_seats(main2); END IF;
  v_ok := v_ok || 'S6 listed+swap-planned ';

  -- S7 executing the swap: the first side is held, the second lands both.
  r := public.fn_cash_seat_move_execute(v_move_a);
  IF (r->>'reason') <> 'waiting_partner' OR NOT (r->>'held')::boolean THEN RAISE EXCEPTION 'S7 first side %', r; END IF;
  IF (SELECT ready_at FROM public.cash_seat_moves WHERE id = v_move_a) IS NULL THEN RAISE EXCEPTION 'S7 ready_at not set'; END IF;
  r := public.fn_cash_seat_move_execute(v_move_b);
  IF NOT (r->>'ok')::boolean OR NOT (r->>'swap')::boolean THEN RAISE EXCEPTION 'S7 second side %', r; END IF;
  SELECT * INTO m FROM public.table_seats WHERE user_id = ud AND left_at IS NULL;
  IF m.table_id <> main2 OR m.seat_number <> 2 OR m.stack <> 12.50 THEN RAISE EXCEPTION 'S7 D landed % seat % stack %', m.table_id, m.seat_number, m.stack; END IF;
  IF m.entry_hold IS DISTINCT FROM 'waiting' OR NOT m.entry_post_agreed THEN RAISE EXCEPTION 'S7 D entry'; END IF;
  SELECT * INTO m FROM public.table_seats WHERE user_id = uc AND left_at IS NULL;
  IF m.table_id <> feeder OR m.seat_number <> 2 OR m.stack <> 25.00 THEN RAISE EXCEPTION 'S7 C landed % seat % stack %', m.table_id, m.seat_number, m.stack; END IF;
  IF (SELECT count(*) FROM public.cash_seat_moves WHERE id IN (v_move_a, v_move_b) AND state = 'done') <> 2 THEN RAISE EXCEPTION 'S7 moves not done'; END IF;
  IF (SELECT count(*) FROM public.cash_game_roster WHERE game_id = g.id AND user_id IN (uc, ud) AND left_at IS NULL) <> 2 THEN RAISE EXCEPTION 'S7 roster closed by the swap'; END IF;
  IF EXISTS (SELECT 1 FROM public.ca_seat_stack_exits e WHERE e.user_id IN (uc, ud) AND e.occurred_at > now() - interval '1 minute' AND e.stack > 0) THEN
    RAISE EXCEPTION 'S7 a stack exit was logged for a swap';
  END IF;
  v_ok := v_ok || 'S7 swap-executed ';

  -- S8 cancel gives the button back; the roster closes when the last chair
  -- empties, and a rejoin is a new row at the bottom.
  INSERT INTO auth.sessions (id, user_id, created_at, updated_at) VALUES (gen_random_uuid(), ue, now(), now()) RETURNING id INTO sid;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', ue, 'role', 'authenticated', 'session_id', sid)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  r := public.fn_cash_seat_change_request(g.id, feeder);   -- feeder has chairs (C is there, D left): moving now
  IF r->>'action' <> 'moving' THEN RAISE EXCEPTION 'S8 expected moving, got %', r; END IF;
  r := public.fn_cash_seat_change_cancel(g.id);
  EXECUTE 'RESET ROLE';
  IF (r->>'cancelled')::int <> 0 THEN RAISE EXCEPTION 'S8 a planned move was cancellable: %', r; END IF;
  -- a listed request IS cancellable and returns the button
  UPDATE public.cash_seat_moves SET state = 'cancelled', note = 'probe', created_at = created_at - interval '2 minutes' WHERE player_id = ue AND state = 'pending';
  UPDATE public.cash_game_roster SET seat_change_used_at = NULL WHERE game_id = g.id AND user_id = ue;   -- as if never used, for the next step
  -- fill every feeder chair (revive a departed row, insert a fresh one)
  UPDATE public.table_seats SET left_at = NULL, user_id = NULL, stack = 0, status = 'active'
   WHERE table_id = feeder AND left_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.table_seats s2 WHERE s2.table_id = feeder AND s2.seat_number = table_seats.seat_number AND s2.left_at IS NULL);
  INSERT INTO public.table_seats (table_id, seat_number, user_id, stack, status, joined_at, club_id)
  SELECT feeder, gs, NULL, 0, 'active', now(), g.club_id FROM generate_series(1, 6) gs
   WHERE NOT EXISTS (SELECT 1 FROM public.table_seats s WHERE s.table_id = feeder AND s.seat_number = gs);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', ue, 'role', 'authenticated', 'session_id', sid)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  r := public.fn_cash_seat_change_request(g.id, feeder);
  IF r->>'action' <> 'listed' THEN RAISE EXCEPTION 'S8 expected listed, got %', r; END IF;
  r := public.fn_cash_seat_change_cancel(g.id);
  EXECUTE 'RESET ROLE';
  IF (r->>'cancelled')::int <> 1 THEN RAISE EXCEPTION 'S8 cancel %', r; END IF;
  IF (SELECT seat_change_used_at FROM public.cash_game_roster WHERE game_id = g.id AND user_id = ue AND left_at IS NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'S8 button not returned';
  END IF;
  SELECT joined_at INTO v_ts FROM public.cash_game_roster WHERE game_id = g.id AND user_id = ue AND left_at IS NULL;
  UPDATE public.table_seats SET stack = 0 WHERE user_id = ue AND left_at IS NULL;
  UPDATE public.table_seats SET left_at = now(), status = 'left' WHERE user_id = ue AND left_at IS NULL;
  IF EXISTS (SELECT 1 FROM public.cash_game_roster WHERE game_id = g.id AND user_id = ue AND left_at IS NULL) THEN RAISE EXCEPTION 'S8 roster stayed open after the last chair emptied'; END IF;
  INSERT INTO public.table_seats (table_id, seat_number, user_id, stack, status, joined_at, club_id)
  VALUES (main2, 3, ue, 15.00, 'active', now(), g.club_id)
  ON CONFLICT DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM public.table_seats WHERE user_id = ue AND left_at IS NULL) THEN
    UPDATE public.table_seats SET user_id = ue, stack = 15.00, left_at = NULL, status = 'active', joined_at = now() WHERE table_id = main2 AND seat_number = 3;
  END IF;
  IF (SELECT joined_at FROM public.cash_game_roster WHERE game_id = g.id AND user_id = ue AND left_at IS NULL) <= v_ts THEN
    RAISE EXCEPTION 'S8 rejoin did not go to the bottom';
  END IF;
  IF (SELECT pos FROM public.fn_cash_game_must_move_list(g.id) WHERE user_id = ue) <> (SELECT max(pos) FROM public.fn_cash_game_must_move_list(g.id)) THEN
    RAISE EXCEPTION 'S8 rejoin not last on the list';
  END IF;
  v_ok := v_ok || 'S8 cancel+rejoin-bottom ';

  -- S9 the floor is for winners: a session that closes below baseline writes
  -- no floor; one above does.
  INSERT INTO public.cash_player_session (player_id, club_id, scope_type, scope_id, table_id, variant, sb, bb, baseline, stay_clock_ms, rejoin_window_ms, stay_remaining_ms, stay_running)
  VALUES (ud, g.club_id, 'table', main2, main2, g.variant, g.sb, g.bb, 100, 600000, 7200000, 0, false);
  DELETE FROM public.cash_rejoin_constraints WHERE player_id = ud;
  PERFORM public.fn_cash_session_close(ud, main2, 60, 'leave');
  IF EXISTS (SELECT 1 FROM public.cash_rejoin_constraints WHERE player_id = ud AND expires_at > now()) THEN RAISE EXCEPTION 'S9 a loser got a floor'; END IF;
  INSERT INTO public.cash_player_session (player_id, club_id, scope_type, scope_id, table_id, variant, sb, bb, baseline, stay_clock_ms, rejoin_window_ms, stay_remaining_ms, stay_running)
  VALUES (ud, g.club_id, 'table', main2, main2, g.variant, g.sb, g.bb, 100, 600000, 7200000, 0, false);
  PERFORM public.fn_cash_session_close(ud, main2, 150, 'leave');
  SELECT * INTO m FROM public.cash_rejoin_constraints WHERE player_id = ud AND expires_at > now();
  IF m.required_stack IS DISTINCT FROM 150 THEN RAISE EXCEPTION 'S9 winner floor % (expected 150)', m.required_stack; END IF;
  IF m.expires_at < now() + interval '119 minutes' THEN RAISE EXCEPTION 'S9 window %', m.expires_at - now(); END IF;
  v_ok := v_ok || 'S9 winner-floor ';

  -- S10 the lobby read as B (seated on Main 2, used their change).
  INSERT INTO auth.sessions (id, user_id, created_at, updated_at) VALUES (gen_random_uuid(), ub, now(), now()) RETURNING id INTO sid;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated', 'session_id', sid)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  l := public.fn_cash_game_lobby(g.id);
  EXECUTE 'RESET ROLE';
  IF NOT (l->'me'->>'seated')::boolean OR (l->'me'->>'table_id')::uuid <> main2 THEN RAISE EXCEPTION 'S10 me %', l->'me'; END IF;
  IF (l->'me'->'seat_change'->>'available')::boolean THEN RAISE EXCEPTION 'S10 button offered after use'; END IF;
  IF jsonb_array_length(l->'tables') < 3 THEN RAISE EXCEPTION 'S10 tables %', jsonb_array_length(l->'tables'); END IF;
  IF (l->'me'->>'must_move_position')::int IS NULL THEN RAISE EXCEPTION 'S10 position missing'; END IF;
  v_ok := v_ok || 'S10 lobby ';

  RAISE EXCEPTION 'PROBE PASS: %', v_ok;
END $probe$;

ROLLBACK;
