-- ═══════════════════════════════════════════════════════════════════════════════
--  CHIP CONTINUITY PROBE (CLAUDE.md 11.5 / 10.9 rule 4): runs the Slice 0
--  migration AND the A0.x scenarios inside ONE DO block, then RAISES so the
--  whole thing rolls back. Every chip that moves here is un-moved by the
--  raise. The report is the exception message.
--
--  HOW TO RUN: replace the placeholders, paste as one statement. Expect an
--  ERROR whose message begins "PROBE REPORT". That is success. No reload is
--  triggered: pgrst_ddl_watch's NOTIFY is transactional and dies with the
--  rollback.
--
--  PLACEHOLDERS
--    __MIGRATION__   the migration body (without its BEGIN/COMMIT)
--    __U__           a user id holding a club wallet in T1's club
--    __T1__ __T2__   two live nlh 1/2 tables in the SAME club (T1 has a seat)
--    __TPLO__        a live plo table in the same club
--    __T25__         a live nlh 2/5 table in the same club
--    __TOTHER__      a live nlh 1/2 table in ANOTHER club
-- ═══════════════════════════════════════════════════════════════════════════════
DO $probe$
DECLARE
  r text := E'PROBE REPORT\n';
  u uuid := '__U__';
  t1 uuid := '__T1__';
  t2 uuid := '__T2__';
  tplo uuid := '__TPLO__';
  t25 uuid := '__T25__';
  tother uuid := '__TOTHER__';
  s1 int; s2 int;
  j jsonb; msg text; st text; n int; v numeric; x record; tsx timestamptz;
  pend uuid;
BEGIN
  EXECUTE $mig$
__MIGRATION__
$mig$;
  r := r || E'migration applied inside the probe transaction\n';

  -- T1/T2: the two live nlh 1/2 tables in the probe club with the most open
  -- seats RIGHT NOW (a fixed pick fills up between two runs).
  SELECT t.id INTO t1 FROM tables t
   WHERE t.club_id = (SELECT club_id FROM tables WHERE id = t1) AND t.game_variant='nlh'
     AND t.small_blind=1 AND t.big_blind=2 AND t.tournament_id IS NULL AND t.status IN ('waiting','running')
   ORDER BY (t.max_players - (SELECT count(*) FROM table_seats s WHERE s.table_id=t.id AND s.left_at IS NULL)) DESC LIMIT 1;
  SELECT t.id INTO t2 FROM tables t
   WHERE t.club_id = (SELECT club_id FROM tables WHERE id = t1) AND t.game_variant='nlh' AND t.id <> t1
     AND t.small_blind=1 AND t.big_blind=2 AND t.tournament_id IS NULL AND t.status IN ('waiting','running')
   ORDER BY (t.max_players - (SELECT count(*) FROM table_seats s WHERE s.table_id=t.id AND s.left_at IS NULL)) DESC LIMIT 1;
  r := r || format(E'tables: T1 %s, T2 %s\n', t1, t2);

  -- free seats
  SELECT MIN(g) INTO s1 FROM generate_series(1, (SELECT max_players FROM tables WHERE id=t1)) g
   WHERE NOT EXISTS (SELECT 1 FROM table_seats s WHERE s.table_id=t1 AND s.seat_number=g AND s.left_at IS NULL);
  SELECT MIN(g) INTO s2 FROM generate_series(1, (SELECT max_players FROM tables WHERE id=t2)) g
   WHERE NOT EXISTS (SELECT 1 FROM table_seats s WHERE s.table_id=t2 AND s.seat_number=g AND s.left_at IS NULL);
  r := r || format(E'seats: T1 seat %s, T2 seat %s\n', s1, s2);

  -- ── A0.2 buy 100, win to 180: leave rejected, clock started at 10:00 ────
  PERFORM public.atomic_table_buyin(u, t1, s1, 100, false, NULL, NULL);
  SELECT baseline INTO v FROM cash_player_session WHERE player_id=u AND scope_id=t1 AND closed_at IS NULL;
  r := r || format(E'A0.2 session opened baseline=%s\n', v);
  UPDATE table_seats SET stack=180 WHERE table_id=t1 AND user_id=u AND left_at IS NULL;
  j := public.fn_cash_session_evaluate(t1, jsonb_build_array(jsonb_build_object('user_id',u,'stack',180,'active',true)));
  r := r || format(E'A0.2 evaluate@180 -> running=%s remaining=%s locked=%s\n', j->0->>'stay_running', j->0->>'stay_remaining_ms', j->0->>'leave_locked');
  BEGIN
    PERFORM public.atomic_seat_cashout_locked(u, t1, s1, 'voluntary');
    r := r || E'A0.2 FAIL voluntary leave was ALLOWED while up\n';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    r := r || format(E'A0.2 voluntary leave refused: %s %s\n', msg, CASE WHEN msg LIKE 'LEAVE_LOCKED:%' THEN 'PASS' ELSE 'FAIL' END);
  END;

  -- two minutes pass on the clock
  UPDATE cash_player_session SET stay_last_tick_at = now() - interval '2 minutes' WHERE player_id=u AND scope_id=t1 AND closed_at IS NULL;

  -- ── A0.3 drop to 90: leave allowed, remainder stored ────────────────────
  UPDATE table_seats SET stack=90 WHERE table_id=t1 AND user_id=u AND left_at IS NULL;
  j := public.fn_cash_session_evaluate(t1, jsonb_build_array(jsonb_build_object('user_id',u,'stack',90,'active',true)));
  r := r || format(E'A0.3 evaluate@90 -> running=%s remaining=%s locked=%s (expect running=false, ~480000, false) %s\n',
        j->0->>'stay_running', j->0->>'stay_remaining_ms', j->0->>'leave_locked',
        CASE WHEN (j->0->>'stay_running')::boolean = false AND (j->0->>'leave_locked')::boolean = false
              AND (j->0->>'stay_remaining_ms')::int BETWEEN 470000 AND 490000 THEN 'PASS' ELSE 'FAIL' END);

  -- ── A0.4 climb to 120: resumes from remainder, not 10:00 ────────────────
  UPDATE table_seats SET stack=120 WHERE table_id=t1 AND user_id=u AND left_at IS NULL;
  j := public.fn_cash_session_evaluate(t1, jsonb_build_array(jsonb_build_object('user_id',u,'stack',120,'active',true)));
  r := r || format(E'A0.4 evaluate@120 -> running=%s remaining=%s %s\n', j->0->>'stay_running', j->0->>'stay_remaining_ms',
        CASE WHEN (j->0->>'stay_running')::boolean AND (j->0->>'stay_remaining_ms')::int BETWEEN 470000 AND 490000 THEN 'PASS' ELSE 'FAIL' END);

  -- ── A0.5 sit-out while up: frozen, still locked ─────────────────────────
  j := public.fn_cash_session_evaluate(t1, jsonb_build_array(jsonb_build_object('user_id',u,'stack',120,'active',false)));
  j := public.fn_cash_leave_check(u, t1);
  r := r || format(E'A0.5 sit-out -> allowed=%s remaining=%s %s\n', j->>'allowed', j->>'stay_remaining_ms',
        CASE WHEN (j->>'allowed')::boolean = false THEN 'PASS' ELSE 'FAIL' END);
  SELECT stay_running INTO x FROM cash_player_session WHERE player_id=u AND scope_id=t1 AND closed_at IS NULL;
  r := r || format(E'A0.5 clock running while sat out = %s (expect f) %s\n', x.stay_running, CASE WHEN NOT x.stay_running THEN 'PASS' ELSE 'FAIL' END);

  -- ── A0.6 disconnect = same freeze; reconnect resumes ────────────────────
  j := public.fn_cash_session_evaluate(t1, jsonb_build_array(jsonb_build_object('user_id',u,'stack',120,'active',true)));
  r := r || format(E'A0.6 reconnect -> running=%s %s\n', j->0->>'stay_running', CASE WHEN (j->0->>'stay_running')::boolean THEN 'PASS' ELSE 'FAIL' END);

  -- ── A0.16 forged browser cash-out while locked ──────────────────────────
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    PERFORM public.atomic_seat_cashout_locked(u, t1, s1);
    r := r || E'A0.16 FAIL browser cash-out was ALLOWED while locked\n';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    r := r || format(E'A0.16 browser cash-out refused: %s %s\n', msg, CASE WHEN msg LIKE 'LEAVE_LOCKED:%' THEN 'PASS' ELSE 'FAIL' END);
  END;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);

  -- ── A0.7 leave with 250 after the clock ran out -> floor 250 in this club ─
  UPDATE table_seats SET stack=250 WHERE table_id=t1 AND user_id=u AND left_at IS NULL;
  UPDATE cash_player_session SET stay_running=true, stay_remaining_ms=1000, stay_last_tick_at=now()-interval '5 seconds'
   WHERE player_id=u AND scope_id=t1 AND closed_at IS NULL;
  j := public.atomic_seat_cashout_locked(u, t1, s1, 'voluntary');
  SELECT required_stack, expires_at INTO x FROM cash_rejoin_constraints WHERE player_id=u ORDER BY left_at DESC LIMIT 1;
  r := r || format(E'A0.7 left with %s -> constraint required=%s expires_in=%s %s\n', j->>'stack', x.required_stack,
        date_trunc('minute', x.expires_at - now()), CASE WHEN x.required_stack = 250 THEN 'PASS' ELSE 'FAIL' END);
  v := public.fn_cash_rejoin_floor(u, t2);
  r := r || format(E'A0.7 floor at sibling 1/2 table = %s %s\n', v, CASE WHEN v = 250 THEN 'PASS' ELSE 'FAIL' END);
  BEGIN
    PERFORM public.atomic_table_buyin(u, t2, s2, 100, false, NULL, NULL);
    r := r || E'A0.7 FAIL buy-in of 100 accepted under a 250 floor\n';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    r := r || format(E'A0.7 buy-in 100 at sibling refused: %s %s\n', msg, CASE WHEN msg LIKE 'BUYIN_BELOW_FLOOR%' THEN 'PASS' ELSE 'FAIL' END);
  END;
  PERFORM public.atomic_table_buyin(u, t2, s2, 250, false, NULL, NULL);
  r := r || E'A0.7 buy-in 250 at sibling accepted PASS\n';

  -- ── A0.8 / A0.9 / A0.10 other variant, other stakes, other club ─────────
  r := r || format(E'A0.8 floor at PLO same club = %s %s\n', public.fn_cash_rejoin_floor(u, tplo), CASE WHEN public.fn_cash_rejoin_floor(u, tplo) IS NULL THEN 'PASS' ELSE 'FAIL' END);
  r := r || format(E'A0.9 floor at 2/5 same club = %s %s\n', public.fn_cash_rejoin_floor(u, t25), CASE WHEN public.fn_cash_rejoin_floor(u, t25) IS NULL THEN 'PASS' ELSE 'FAIL' END);
  r := r || format(E'A0.10 floor at 1/2 other club = %s %s\n', public.fn_cash_rejoin_floor(u, tother), CASE WHEN public.fn_cash_rejoin_floor(u, tother) IS NULL THEN 'PASS' ELSE 'FAIL' END);

  -- ── A0.15 two tables at once: separate sessions, no copy ─────────────────
  -- (the 250 floor from A0.7 covers T1 too: same club, same game)
  PERFORM public.atomic_table_buyin(u, t1, s1, 250, false, NULL, NULL);
  SELECT count(*) INTO n FROM cash_player_session WHERE player_id=u AND closed_at IS NULL;
  r := r || format(E'A0.15 open sessions while seated at two tables = %s %s\n', n, CASE WHEN n = 2 THEN 'PASS' ELSE 'FAIL' END);
  UPDATE table_seats SET stack=300 WHERE table_id=t1 AND user_id=u AND left_at IS NULL;
  -- the 250 floor from A0.7 still stands; sitting at T1 with 300 must not raise it
  r := r || format(E'A0.15 floor while seated with 300 at T1 = %s (expect 250, unchanged) %s\n', public.fn_cash_rejoin_floor(u, t2), CASE WHEN public.fn_cash_rejoin_floor(u, t2) = 250 THEN 'PASS' ELSE 'FAIL' END);
  UPDATE cash_player_session SET stay_remaining_ms=0, stay_running=false WHERE player_id=u AND scope_id=t1 AND closed_at IS NULL;
  j := public.atomic_seat_cashout_locked(u, t1, s1, 'voluntary');
  r := r || format(E'A0.15 left T1 with 300 -> floor now %s %s\n', public.fn_cash_rejoin_floor(u, t2), CASE WHEN public.fn_cash_rejoin_floor(u, t2) = 300 THEN 'PASS' ELSE 'FAIL' END);

  -- ── after 2 hours: table min again ──────────────────────────────────────
  UPDATE cash_rejoin_constraints SET expires_at = now() - interval '1 second' WHERE player_id=u;
  r := r || format(E'A0.7b floor after expiry = %s %s\n', public.fn_cash_rejoin_floor(u, t1), CASE WHEN public.fn_cash_rejoin_floor(u, t1) IS NULL THEN 'PASS' ELSE 'FAIL' END);

  -- leave T2 with 0 to clean up (bust): no floor written
  UPDATE table_seats SET stack=0 WHERE table_id=t2 AND user_id=u AND left_at IS NULL;
  j := public.atomic_seat_cashout_locked(u, t2, s2, 'voluntary');
  r := r || format(E'A0.11 bust-to-zero leave -> floor %s %s\n', public.fn_cash_rejoin_floor(u, t2), CASE WHEN public.fn_cash_rejoin_floor(u, t2) IS NULL THEN 'PASS' ELSE 'FAIL' END);

  -- ── A0.12 bust then reload in place: baseline += reload, no constraint ──
  PERFORM public.atomic_table_buyin(u, t1, s1, 100, false, NULL, NULL);
  UPDATE table_seats SET stack=0 WHERE table_id=t1 AND user_id=u AND left_at IS NULL;
  PERFORM public.atomic_table_rebuy(u, t1, 100, NULL);
  SELECT id INTO pend FROM table_pending_addons WHERE table_id=t1 AND user_id=u AND resolved_at IS NULL LIMIT 1;
  PERFORM * FROM public.resolve_pending_addon(pend, 400);
  SELECT baseline INTO v FROM cash_player_session WHERE player_id=u AND scope_id=t1 AND closed_at IS NULL;
  SELECT count(*) INTO n FROM cash_rejoin_constraints WHERE player_id=u AND expires_at > now();
  r := r || format(E'A0.12 reload in place -> baseline=%s (expect 200) constraints=%s (expect 0) %s\n', v, n, CASE WHEN v = 200 AND n = 0 THEN 'PASS' ELSE 'FAIL' END);

  -- ── A0.13 buy 100, add-on 50 -> baseline 150; 160 locks, 140 does not ───
  PERFORM public.atomic_table_addon(u, t1, 50, true, NULL);
  SELECT baseline INTO v FROM cash_player_session WHERE player_id=u AND scope_id=t1 AND closed_at IS NULL;
  r := r || format(E'A0.13 baseline after add-on 50 = %s (expect 250 here: 100+100 reload+50) %s\n', v, CASE WHEN v = 250 THEN 'PASS' ELSE 'FAIL' END);
  UPDATE table_seats SET stack=260 WHERE table_id=t1 AND user_id=u AND left_at IS NULL;
  j := public.fn_cash_session_evaluate(t1, jsonb_build_array(jsonb_build_object('user_id',u,'stack',260,'active',true)));
  r := r || format(E'A0.13 stack 260 vs baseline 250 -> locked=%s %s\n', j->0->>'leave_locked', CASE WHEN (j->0->>'leave_locked')::boolean THEN 'PASS' ELSE 'FAIL' END);
  UPDATE table_seats SET stack=240 WHERE table_id=t1 AND user_id=u AND left_at IS NULL;
  j := public.fn_cash_session_evaluate(t1, jsonb_build_array(jsonb_build_object('user_id',u,'stack',240,'active',true)));
  r := r || format(E'A0.13 stack 240 vs baseline 250 -> locked=%s %s\n', j->0->>'leave_locked', CASE WHEN NOT (j->0->>'leave_locked')::boolean THEN 'PASS' ELSE 'FAIL' END);

  -- ── A0.17 add-on cannot exceed table max (400) ──────────────────────────
  BEGIN
    PERFORM public.atomic_table_addon(u, t1, 200, true, NULL);   -- 240 + 200 = 440 > 400
    r := r || E'A0.17 FAIL add-on above max accepted\n';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    r := r || format(E'A0.17 add-on above max refused: %s %s\n', msg, CASE WHEN msg LIKE 'BUYIN_ABOVE_MAX%' THEN 'PASS' ELSE 'FAIL' END);
  END;

  -- ── A0.1 going south: the withdraw function is gone ─────────────────────
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='public' AND p.proname='atomic_table_withdraw';
  r := r || format(E'A0.1 atomic_table_withdraw definitions = %s %s\n', n, CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END);

  -- ── THAW: frozen minutes are given back ─────────────────────────────────
  UPDATE table_seats SET stack=300 WHERE table_id=t1 AND user_id=u AND left_at IS NULL;
  j := public.fn_cash_session_evaluate(t1, jsonb_build_array(jsonb_build_object('user_id',u,'stack',300,'active',true)));
  SELECT stay_last_tick_at INTO tsx FROM cash_player_session WHERE player_id=u AND scope_id=t1 AND closed_at IS NULL;
  INSERT INTO cash_rejoin_constraints (player_id, club_id, variant, sb, bb, required_stack, expires_at)
    VALUES (u, (SELECT club_id FROM tables WHERE id=tplo), 'plo4', 1, 2, 123, now() + interval '30 minutes');
  j := public.fn_thaw_platform(now() - interval '5 minutes', 300, 'probe');
  SELECT stay_last_tick_at INTO x FROM cash_player_session WHERE player_id=u AND scope_id=t1 AND closed_at IS NULL;
  SELECT expires_at INTO v FROM (SELECT extract(epoch FROM expires_at - now()) AS expires_at FROM cash_rejoin_constraints WHERE player_id=u AND required_stack=123) q;
  r := r || format(E'THAW shifted stay clock by %s s, floor expires in %s s (expect ~2100), thaw=%s %s\n',
        round(extract(epoch FROM x.stay_last_tick_at - tsx)), round(v), j->'shifted'->>'cash_stay_last_tick_at',
        CASE WHEN round(extract(epoch FROM x.stay_last_tick_at - tsx)) = 300 AND v BETWEEN 2090 AND 2110 THEN 'PASS' ELSE 'FAIL' END);

  RAISE EXCEPTION '%', r;
END
$probe$;
