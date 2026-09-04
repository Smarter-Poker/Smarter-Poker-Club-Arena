-- CLUSTER CONTROLLER PROBE (Slice 2 + 6 SQL half; OPORD 1.4 s18.7 A6.1-A6.10
-- as far as SQL can carry them). One DO block: applies the migration, builds
-- a must-move game, walks it through open / must-move / promote / break /
-- dormant / disabled / R3-reopen / thaw, RAISES its report so nothing
-- commits. Placeholders (double-underscored): MIGRATION, OWNER, CLUB.
-- Substitute ONLY inside the DO block.
DO $probe$
DECLARE
  r text := E'PROBE-S2 REPORT\n';
  owner uuid := '__OWNER__';
  club uuid := '__CLUB__';
  sid uuid := gen_random_uuid();
  j jsonb; g uuid; main1 uuid; feeder uuid; msg text; n int; x record; y record; k int; s int; p uuid; mv uuid;
  players uuid[]; felt_before numeric; felt_after numeric; t0 timestamptz;
BEGIN
  EXECUTE $mig$
__MIGRATION__
$mig$;
  r := r || E'migration applied inside the probe transaction\n';

  -- A club owner creates a must-move Classic NLH 3/6 6-max game (an unusual key).
  INSERT INTO auth.sessions (id, user_id, created_at, updated_at) VALUES (sid, owner, now(), now());
  PERFORM set_config('request.jwt.claims', json_build_object('sub', owner, 'role', 'authenticated', 'session_id', sid)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  j := public.fn_cash_game_create(club, 'classic', 'nlh', 3, 6, 6, '{}'::jsonb, 'Probe Cluster', true);
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);   -- the rest of the probe is the engine
  g := (j->>'game_id')::uuid; main1 := (j->>'table_id')::uuid;
  SELECT auto_extension, auto_restart, lifecycle, role, main_index, opened_at IS NOT NULL AS opened INTO x FROM tables WHERE id = main1;
  r := r || format(E'CREATE main 1 via the cluster writer: ext=%s restart=%s lifecycle=%s role=%s idx=%s opened_at=%s %s\n',
        x.auto_extension, x.auto_restart, x.lifecycle, x.role, x.main_index, x.opened,
        CASE WHEN NOT x.auto_extension AND NOT x.auto_restart AND x.lifecycle='live' AND x.role='main' AND x.main_index=1 AND x.opened THEN 'PASS' ELSE 'FAIL' END);

  -- A6.9 first half: empty game, no horses -> dormant; with horses -> live.
  j := public.fn_cash_cluster_tick(g, 0);
  SELECT state INTO x FROM cash_games WHERE id = g;
  r := r || format(E'A6.9 empty + 0 horses: state=%s %s\n', x.state, CASE WHEN x.state='dormant' THEN 'PASS' ELSE 'FAIL' END);
  j := public.fn_cash_cluster_tick(g, 2);
  SELECT state INTO x FROM cash_games WHERE id = g;
  r := r || format(E'A6.9 0 seated + 2 eligible horses: state=%s %s\n', x.state, CASE WHEN x.state='live' THEN 'PASS' ELSE 'FAIL' END);

  -- Six members sit at Main 1 (the engine's own buy-in RPC, club wallet).
  SELECT array_agg(user_id) INTO players FROM (
    SELECT cm.user_id FROM club_members cm
     WHERE cm.club_id = club AND cm.chip_balance >= 2000
       AND NOT EXISTS (SELECT 1 FROM table_seats ts WHERE ts.user_id = cm.user_id AND ts.left_at IS NULL)
       AND public.fn_concurrent_game_load(cm.user_id, NULL, NULL, NULL) < 2
       -- the union table resolves a wallet through a member club of the union
       AND EXISTS (SELECT 1 FROM club_members m2 JOIN clubs c2 ON c2.id = m2.club_id
                    WHERE m2.user_id = cm.user_id AND c2.union_id = club AND c2.id <> club AND m2.chip_balance >= 2000)
     ORDER BY random() LIMIT 8) q;
  IF coalesce(array_length(players, 1), 0) < 8 THEN
    RAISE EXCEPTION 'probe needs 8 idle funded members in the club, found %', coalesce(array_length(players, 1), 0);
  END IF;
  FOR k IN 1..6 LOOP
    PERFORM public.atomic_table_buyin(players[k], main1, k, 400, false, NULL, NULL);
  END LOOP;
  SELECT count(*) INTO n FROM table_seats WHERE table_id = main1 AND left_at IS NULL;
  r := r || format(E'SETUP main 1 seated=%s %s\n', n, CASE WHEN n=6 THEN 'PASS' ELSE 'FAIL' END);

  -- A6.2: full table, ONE buyer, no horses: no table; the hold starts; after
  -- 60 s it expires; zero 'opening' rows ever.
  INSERT INTO cash_game_waitlist (game_id, user_id) VALUES (g, players[7]);
  j := public.fn_cash_cluster_tick(g, 0);
  SELECT count(*) INTO n FROM tables WHERE cluster_id = g AND lifecycle = 'opening';
  SELECT opening_hold_since IS NOT NULL AS held INTO x FROM cash_games WHERE id = g;
  r := r || format(E'A6.2 one buyer: opening rows=%s hold=%s %s\n', n, x.held, CASE WHEN n=0 AND x.held THEN 'PASS' ELSE 'FAIL' END);
  UPDATE cash_games SET opening_hold_since = clock_timestamp() - interval '61 seconds' WHERE id = g;
  j := public.fn_cash_cluster_tick(g, 0);
  SELECT count(*) INTO n FROM cash_cluster_events WHERE game_id = g AND kind = 'table_opening_hold_expired';
  r := r || format(E'A6.2 hold expired after 60 s: events=%s %s\n', n, CASE WHEN n=1 THEN 'PASS' ELSE 'FAIL' END);

  -- A6.1: full table, two buyers (one waiting human + one eligible horse): a
  -- feeder opens within one tick, role feeder, lifecycle opening.
  j := public.fn_cash_cluster_tick(g, 1);
  SELECT id, role, lifecycle, name INTO x FROM tables WHERE cluster_id = g AND role = 'feeder';
  feeder := x.id;
  r := r || format(E'A6.1 two buyers: feeder=%s lifecycle=%s name=%s %s\n', feeder IS NOT NULL, x.lifecycle, x.name,
        CASE WHEN feeder IS NOT NULL AND x.lifecycle='opening' THEN 'PASS' ELSE 'FAIL' END);
  -- A second tick opens nothing more (one opening table at a time).
  j := public.fn_cash_cluster_tick(g, 5);
  SELECT count(*) INTO n FROM tables WHERE cluster_id = g AND lifecycle <> 'closed';
  r := r || format(E'A6.6/idempotent: tables after a second tick=%s %s\n', n, CASE WHEN n=2 THEN 'PASS' ELSE 'FAIL' END);

  -- Two buyers sit at the feeder: it goes live (18.3).
  PERFORM public.atomic_table_buyin(players[7], feeder, 1, 400, false, NULL, NULL);
  PERFORM public.atomic_table_buyin(players[8], feeder, 2, 400, false, NULL, NULL);
  UPDATE table_seats SET joined_at = joined_at - interval '1 minute' WHERE table_id = feeder AND user_id = players[7];  -- seniority: 7 sat first
  j := public.fn_cash_cluster_tick(g, 0);
  SELECT lifecycle, live_at IS NOT NULL AS live INTO x FROM tables WHERE id = feeder;
  r := r || format(E'PROMOTE feeder at 2 seated: lifecycle=%s live_at=%s %s\n', x.lifecycle, x.live, CASE WHEN x.lifecycle='live' AND x.live THEN 'PASS' ELSE 'FAIL' END);

  -- MUST-MOVE (1.3 s9.5): a seat opens on Main 1 (player 3 leaves through the
  -- engine's cash-out); the next tick plans the longest-seated feeder player
  -- onto it; the engine executes it; chips, session and seniority travel.
  SELECT coalesce(sum(stack), 0) INTO felt_before FROM table_seats ts JOIN tables t ON t.id = ts.table_id WHERE t.cluster_id = g AND ts.left_at IS NULL;
  PERFORM public.atomic_seat_cashout_locked(players[3], main1, 3, 'voluntary');
  j := public.fn_cash_cluster_tick(g, 0);
  SELECT id, player_id, to_table_id, reason, state INTO x FROM cash_seat_moves WHERE game_id = g AND state = 'pending' ORDER BY created_at LIMIT 1;
  mv := x.id; p := x.player_id;
  r := r || format(E'MUST-MOVE planned: player=%s to=main1:%s reason=%s %s\n', p = players[7], x.to_table_id = main1, x.reason,
        CASE WHEN p = players[7] AND x.to_table_id = main1 AND x.reason='must_move' THEN 'PASS' ELSE 'FAIL' END);
  SELECT count(*) INTO n FROM cash_seat_moves WHERE game_id = g AND state = 'pending';
  r := r || format(E'MUST-MOVE one plan per open seat: pending=%s %s\n', n, CASE WHEN n=1 THEN 'PASS' ELSE 'FAIL' END);
  -- the engine, at the hand boundary:
  SELECT count(*) INTO n FROM public.fn_cash_seat_moves_pending(feeder);
  -- every row this transaction wrote carries created_at = now(); the move
  -- must add none for the player (a move is not a cash-out and not a buy-in)
  SELECT count(*) INTO s FROM wallet_transactions w WHERE w.user_id = p AND w.created_at >= now();
  j := public.fn_cash_seat_move_execute(mv);
  SELECT coalesce(sum(stack), 0) INTO felt_after FROM table_seats ts JOIN tables t ON t.id = ts.table_id WHERE t.cluster_id = g AND ts.left_at IS NULL;
  SELECT (SELECT table_id FROM cash_player_session WHERE player_id = p AND closed_at IS NULL) AS sess_table,
         (SELECT stack FROM table_seats WHERE user_id = p AND left_at IS NULL) AS stack,
         (SELECT table_id FROM table_seats WHERE user_id = p AND left_at IS NULL) AS at_table,
         (SELECT count(*) FROM ca_seat_stack_exits e WHERE e.user_id = p AND e.table_id = feeder) AS exits_logged,
         (SELECT count(*) FROM wallet_transactions w WHERE w.user_id = p AND w.created_at >= now()) - s AS wallet_rows
    INTO x;
  r := r || format(E'MOVE executed: ok=%s reason=%s pending_seen_by_engine=%s at=main1:%s stack=%s session_follows=%s felt %s->%s exits_logged=%s wallet_rows=%s %s\n',
        j->>'ok', coalesce(j->>'reason','') || ' ' || coalesce(j->>'detail',''), n, x.at_table = main1, x.stack, x.sess_table = main1, felt_before, felt_after, x.exits_logged, x.wallet_rows,
        CASE WHEN (j->>'ok')::boolean AND n=1 AND x.at_table = main1 AND x.stack = 400 AND x.sess_table = main1
                  AND felt_before = felt_after + 400 AND x.exits_logged = 0 AND x.wallet_rows = 0 THEN 'PASS' ELSE 'FAIL' END);
  -- (felt_before included player 3's 400 which cashed out before the move; the
  --  move itself moved 400 and lost none: after = before - the cash-out.)

  -- Expired move: planned, not executed in 60 s, expires; next tick re-plans.
  PERFORM public.atomic_seat_cashout_locked(players[4], main1, 4, 'voluntary');
  j := public.fn_cash_cluster_tick(g, 0);
  UPDATE cash_seat_moves SET expires_at = clock_timestamp() - interval '1 second' WHERE game_id = g AND state = 'pending';
  j := public.fn_cash_cluster_tick(g, 0);
  SELECT count(*) FILTER (WHERE state='expired') AS expired, count(*) FILTER (WHERE state='pending') AS pending INTO x FROM cash_seat_moves WHERE game_id = g AND reason='must_move';
  r := r || format(E'MOVE expiry: expired=%s re-planned pending=%s %s\n', x.expired, x.pending, CASE WHEN x.expired=1 AND x.pending=1 THEN 'PASS' ELSE 'FAIL' END);
  SELECT id INTO mv FROM cash_seat_moves WHERE game_id = g AND state='pending';
  j := public.fn_cash_seat_move_execute(mv);

  -- BREAK (18.3): Main 1 now has 6 seated (4 originals + 2 moved), feeder 0.
  -- Everyone fits in Main 1 at the floor: the feeder is the candidate; the
  -- first tick marks break_eligible_since; nothing breaks yet (A6.4 shape);
  -- after 5 minutes it breaks; empty, it closes; roles hold (A6.5).
  j := public.fn_cash_cluster_tick(g, 0);
  SELECT break_eligible_since IS NOT NULL AS eligible, lifecycle INTO x FROM tables WHERE id = feeder;
  r := r || format(E'A6.4 break needs the window: eligible=%s lifecycle=%s %s\n', x.eligible, x.lifecycle, CASE WHEN x.eligible AND x.lifecycle='live' THEN 'PASS' ELSE 'FAIL' END);
  -- A6.4: the condition fails once (a player sits at the feeder) -> reset.
  PERFORM public.atomic_table_buyin(players[3], feeder, 3, 400, false, NULL, NULL);
  j := public.fn_cash_cluster_tick(g, 0);
  SELECT break_eligible_since IS NULL AS reset INTO x FROM tables WHERE id = feeder;
  r := r || format(E'A6.4 condition failed once: window reset=%s %s\n', x.reset, CASE WHEN x.reset THEN 'PASS' ELSE 'FAIL' END);
  -- 7 seated across 2 tables (6-max: cap 12, floor 3/table). Everyone does
  -- NOT fit in Main 1 (7 > 6): no break. Player 3 leaves again: 6 fit.
  PERFORM public.atomic_seat_cashout_locked(players[3], feeder, 3, 'voluntary');
  j := public.fn_cash_cluster_tick(g, 0);
  UPDATE tables SET break_eligible_since = clock_timestamp() - interval '6 minutes' WHERE id = feeder;
  j := public.fn_cash_cluster_tick(g, 0);
  SELECT lifecycle, status INTO x FROM tables WHERE id = feeder;
  r := r || format(E'A6.3 feeder breaks after the window and closes empty: lifecycle=%s status=%s %s\n', x.lifecycle, x.status,
        CASE WHEN x.lifecycle IN ('breaking','closed') THEN 'PASS' ELSE 'FAIL' END);
  j := public.fn_cash_cluster_tick(g, 0);
  SELECT lifecycle, status INTO x FROM tables WHERE id = feeder;
  SELECT role, main_index, lifecycle INTO y FROM tables WHERE id = main1;
  r := r || format(E'A6.5 main 1 survives: main1 role=%s idx=%s lifecycle=%s; feeder=%s/%s %s\n', y.role, y.main_index, y.lifecycle, x.lifecycle, x.status,
        CASE WHEN y.role='main' AND y.main_index=1 AND y.lifecycle='live' AND x.lifecycle='closed' AND x.status='closed' THEN 'PASS' ELSE 'FAIL' END);
  SELECT count(*) INTO n FROM cash_cluster_events WHERE game_id = g AND kind IN ('table_break_started','table_break_completed');
  r := r || format(E'EMIT break events=%s %s\n', n, CASE WHEN n=2 THEN 'PASS' ELSE 'FAIL' END);

  -- A6.10: enabled=false -> no opening even with buyers; empties close.
  UPDATE cash_games SET enabled = false WHERE id = g;
  j := public.fn_cash_cluster_tick(g, 9);
  SELECT count(*) INTO n FROM tables WHERE cluster_id = g AND lifecycle = 'opening';
  r := r || format(E'A6.10 disabled: no feeder opened with 9 buyers: opening=%s %s\n', n, CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END);
  UPDATE cash_games SET enabled = true WHERE id = g;

  -- R3: something closes Main 1 with nobody seated -> next tick reopens it.
  FOR k IN 1..8 LOOP
    PERFORM public.atomic_seat_cashout_locked(ts.user_id, ts.table_id, ts.seat_number, 'voluntary')
      FROM table_seats ts JOIN tables t ON t.id = ts.table_id WHERE t.cluster_id = g AND ts.left_at IS NULL AND ts.seat_number = k;
  END LOOP;
  UPDATE tables SET status = 'closed', lifecycle = 'closed' WHERE id = main1;
  j := public.fn_cash_cluster_tick(g, 0);
  SELECT count(*) INTO n FROM tables WHERE cluster_id = g AND role = 'main' AND main_index = 1 AND lifecycle = 'live' AND status = 'waiting';
  r := r || format(E'R3 main 1 reopened by the controller: live main 1 rows=%s %s\n', n, CASE WHEN n=1 THEN 'PASS' ELSE 'FAIL' END);
  SELECT state INTO x FROM cash_games WHERE id = g;
  r := r || format(E'A6.9 last seat emptied, no horses: state=%s %s\n', x.state, CASE WHEN x.state='dormant' THEN 'PASS' ELSE 'FAIL' END);

  -- 18.5: the thaw gives the cluster clocks back. NOT executed here - a
  -- probe that calls fn_thaw_platform deadlocks against the live engine on
  -- tournament rows (seen 2026-09-04 and again 2026-09-05). The two steps
  -- are asserted from the source; the shift arithmetic is the same
  -- statement shape every other step uses.
  SELECT prosrc INTO msg FROM pg_proc WHERE proname = 'fn_thaw_platform';
  r := r || format(E'A6.8 thaw carries the cluster clocks: break_eligible=%s move_expires=%s %s\n',
        position('cluster_break_eligible_since' in msg) > 0, position('cluster_move_expires_at' in msg) > 0,
        CASE WHEN position('cluster_break_eligible_since' in msg) > 0 AND position('cluster_move_expires_at' in msg) > 0 THEN 'PASS' ELSE 'FAIL' END);

  -- Frozen: the tick refuses.
  PERFORM set_config('app.freeze_bypass', '', true);
  -- the break row is a singleton (id = true); rolled back with everything else
  INSERT INTO engine_maintenance_break (id, phase, announced_at, break_started_at, break_ends_at, reason, enforce_freeze)
  VALUES (true, 'counting_down', now(), now(), now() + interval '5 minutes', 'probe', true)
  ON CONFLICT (id) DO UPDATE SET phase = 'counting_down', break_ends_at = now() + interval '5 minutes', enforce_freeze = true;
  j := public.fn_cash_cluster_tick(g, 0);
  r := r || format(E'A6.8 frozen tick: %s %s\n', j->>'skipped', CASE WHEN j->>'skipped'='frozen' THEN 'PASS' ELSE 'FAIL' END);

  RAISE EXCEPTION '%', r;
END
$probe$;
