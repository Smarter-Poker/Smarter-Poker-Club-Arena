-- PROBE: the join door holds the chair it hands out (20260910183043), ROLLED BACK.
-- Lane B follow-up, must-move audit 2026-09-09/10 (docs/audits/2026-09-09-must-move-audit/lane-B.md).
--
-- HOW TO RUN (psql, CLAUDE.md 11.5 section 1 - a real BEGIN ... ROLLBACK):
--   sed -e '/^BEGIN;$/d' -e '/^COMMIT;$/d' \
--     supabase/migrations/20260910183043_the_join_door_holds_the_chair_it_hands_out.sql > /tmp/laneB/mig-183043-body.sql
--   psql "$SESSION_POOLER_CONN" -X -v ON_ERROR_STOP=1 -f scripts/dev/probe-join-door-hold.sql
-- The file ends in RAISE EXCEPTION 'PROBE PASS: ...' so nothing reaches the board;
-- the error is the success case. Never run this without the ROLLBACK at the end.
--
-- Every filler is a REAL player on a real chair: a user-less table_seats row is
-- refused by fn_stamp_active_seat_game_scope (2026-09-10), and rightly.
--
-- Scoreboard, run 2026-09-10 18:36 UTC against production, rolled back:
--   PROBE PASS: S17 first-caller-held-and-admitted S18 second-caller-told-the-truth
--   S19 asking-twice-is-one-hold S20 lapse-frees-the-chair S22 table-lock-held
-- S21 (the same-instant race, two psql sessions) is the pair at the bottom.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '120s';
\i /tmp/laneB/mig-183043-body.sql   -- the migration body, BEGIN/COMMIT stripped (see header)

CREATE FUNCTION pg_temp.seat_probe(p_table uuid, p_user uuid, p_stack numeric, p_joined timestamptz, p_club uuid)
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_seat int; v_id uuid;
BEGIN
  SELECT gs INTO v_seat FROM generate_series(1, coalesce((SELECT max_players FROM public.tables WHERE id = p_table), 9)) gs
   WHERE NOT EXISTS (SELECT 1 FROM public.table_seats s WHERE s.table_id = p_table AND s.seat_number = gs AND s.left_at IS NULL)
   ORDER BY gs LIMIT 1;
  IF v_seat IS NULL THEN RAISE EXCEPTION 'no free chair at %', p_table; END IF;
  UPDATE public.table_seats
     SET user_id = p_user, stack = p_stack, status = 'active', left_at = NULL, joined_at = p_joined,
         club_id = p_club, leave_pending = false, is_sitting_out = false, sit_out_at = NULL
   WHERE table_id = p_table AND seat_number = v_seat AND left_at IS NOT NULL
   RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    INSERT INTO public.table_seats (table_id, seat_number, user_id, stack, status, joined_at, club_id)
    VALUES (p_table, v_seat, p_user, p_stack, 'active', p_joined, p_club);
  END IF;
END $f$;

-- act as a signed-in browser for one player (auth.uid() reads request.jwt.claims)
CREATE FUNCTION pg_temp.as_player(p_uid uuid) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
END $f$;
CREATE FUNCTION pg_temp.as_engine() RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
END $f$;

DO $probe$
DECLARE
  g record; main1 uuid; main2 uuid; feeder uuid;
  ua uuid; ub uuid; uc uuid;
  r jsonb; w record; x record;
  v_ok text := ''; ids uuid[]; v_open int; v_seat int; v_exp timestamptz; v_n int;
  v_buyin numeric; v_wallet numeric;
BEGIN
  PERFORM set_config('app.money_path', 'atomic_table_buyin', true);

  SELECT g0.* INTO g FROM public.cash_games g0
   WHERE g0.must_move AND g0.enabled AND g0.state = 'live'
     AND EXISTS (SELECT 1 FROM public.tables t WHERE t.cluster_id = g0.id AND t.role='main' AND t.main_index=1 AND t.lifecycle='live' AND t.status IN ('waiting','running','active'))
     AND EXISTS (SELECT 1 FROM public.tables t WHERE t.cluster_id = g0.id AND t.role='feeder' AND t.lifecycle='live' AND t.status IN ('waiting','running','active'))
     AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves mv WHERE mv.game_id = g0.id AND mv.state='pending')
     AND NOT EXISTS (SELECT 1 FROM public.cash_game_waitlist cw WHERE cw.game_id = g0.id AND cw.status IN ('waiting','notified'))
   ORDER BY g0.name LIMIT 1;
  IF g.id IS NULL THEN RAISE EXCEPTION 'no fixture game'; END IF;
  SELECT id INTO main1 FROM public.tables WHERE cluster_id=g.id AND role='main' AND main_index=1 AND lifecycle='live' LIMIT 1;
  SELECT id INTO feeder FROM public.tables WHERE cluster_id=g.id AND role='feeder' AND lifecycle='live' ORDER BY created_at LIMIT 1;

  main2 := gen_random_uuid();
  EXECUTE format('INSERT INTO public.tables (%s) SELECT %s FROM public.tables t WHERE t.id = $1',
    (SELECT string_agg(quote_ident(column_name), ',') FROM information_schema.columns WHERE table_schema='public' AND table_name='tables' AND is_generated='NEVER'),
    (SELECT string_agg(CASE column_name
        WHEN 'id' THEN quote_literal(main2)||'::uuid' WHEN 'name' THEN quote_literal('PROBE Main 2')
        WHEN 'role' THEN quote_literal('main') WHEN 'main_index' THEN '2'
        WHEN 'lifecycle' THEN quote_literal('live') WHEN 'status' THEN quote_literal('running')
        WHEN 'current_players' THEN '0' WHEN 'created_at' THEN 'now()' WHEN 'updated_at' THEN 'now()'
        ELSE 't.'||quote_ident(column_name) END, ',' ORDER BY ordinal_position)
       FROM information_schema.columns WHERE table_schema='public' AND table_name='tables' AND is_generated='NEVER'))
    USING main1;

  -- Enough horses with a club wallet here, no chair in this game, room for
  -- another: three callers (A, B, C) and up to eighteen fillers. Every filler
  -- is a real player seated on a real chair (a user-less row is refused by
  -- fn_stamp_active_seat_game_scope, and rightly).
  SELECT array_agg(id) INTO ids FROM (
    SELECT p.id FROM public.profiles p
     WHERE coalesce(p.is_horse,false)
       AND NOT EXISTS (SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id WHERE s.user_id=p.id AND s.left_at IS NULL AND t.cluster_id=g.id)
       AND public.fn_concurrent_game_load(p.id, NULL, NULL, NULL) <= 1
       AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves mv WHERE mv.player_id=p.id AND mv.state='pending')
       AND NOT EXISTS (SELECT 1 FROM public.table_waitlist tw WHERE tw.user_id=p.id AND tw.status IN ('waiting','notified'))
       AND NOT EXISTS (SELECT 1 FROM public.cash_rejoin_constraints c WHERE c.player_id=p.id AND c.expires_at > now())
       AND EXISTS (SELECT 1 FROM public.club_members cm WHERE cm.user_id=p.id AND cm.club_id=g.club_id AND cm.chip_balance >= 200)
     ORDER BY p.id LIMIT 21) q;
  ua:=ids[1]; ub:=ids[2]; uc:=ids[3];
  IF ids[6] IS NULL THEN RAISE EXCEPTION 'not enough free horses'; END IF;
  v_n := 4;
  -- ONE CHAIR IN THE WHOLE GAME: Main 2 is filled to max-1, the feeder and
  -- Main 1 to max, with fillers.
  WHILE (SELECT count(*) FROM public.table_seats s WHERE s.table_id=main2 AND s.left_at IS NULL)
        < coalesce((SELECT max_players FROM public.tables WHERE id=main2), 6) - 1 LOOP
    IF ids[v_n] IS NULL THEN RAISE EXCEPTION 'ran out of fillers at main2'; END IF;
    PERFORM pg_temp.seat_probe(main2, ids[v_n], 20.00, now() - interval '30 minutes', g.club_id); v_n := v_n + 1;
  END LOOP;
  WHILE (SELECT count(*) FROM public.table_seats s WHERE s.table_id=feeder AND s.left_at IS NULL)
        < coalesce((SELECT max_players FROM public.tables WHERE id=feeder), 6) LOOP
    IF ids[v_n] IS NULL THEN RAISE EXCEPTION 'ran out of fillers at feeder'; END IF;
    PERFORM pg_temp.seat_probe(feeder, ids[v_n], 20.00, now() - interval '30 minutes', g.club_id); v_n := v_n + 1;
  END LOOP;
  WHILE (SELECT count(*) FROM public.table_seats s WHERE s.table_id=main1 AND s.left_at IS NULL)
        < coalesce((SELECT max_players FROM public.tables WHERE id=main1), 6) LOOP
    IF ids[v_n] IS NULL THEN RAISE EXCEPTION 'ran out of fillers at main1'; END IF;
    PERFORM pg_temp.seat_probe(main1, ids[v_n], 20.00, now() - interval '30 minutes', g.club_id); v_n := v_n + 1;
  END LOOP;
  IF public.fn_cash_game_open_seats(main2) <> 1 OR public.fn_cash_game_open_seats(feeder) <> 0 OR public.fn_cash_game_open_seats(main1) <> 0 THEN
    RAISE EXCEPTION 'fixture: open chairs main2=% feeder=% main1=%', public.fn_cash_game_open_seats(main2), public.fn_cash_game_open_seats(feeder), public.fn_cash_game_open_seats(main1);
  END IF;
  v_buyin := coalesce((SELECT min_buy_in FROM public.tables WHERE id=main2), 0);
  IF v_buyin <= 0 THEN v_buyin := 40 * g.bb; END IF;

  -- S17 the first caller is handed the chair, holds it, and is admitted at the door.
  PERFORM pg_temp.as_player(ua);
  r := public.fn_cash_game_join(g.id);
  IF r->>'action' <> 'seat' OR (r->>'table_id')::uuid <> main2 THEN RAISE EXCEPTION 'S17 A expected seat at main2, got %', r; END IF;
  IF (r->>'open_seats')::int <> 1 THEN RAISE EXCEPTION 'S17 A open_seats % (the held chair is open to A)', r->>'open_seats'; END IF;
  SELECT * INTO w FROM public.table_waitlist WHERE table_id=main2 AND user_id=ua AND status='notified';
  IF w.id IS NULL OR w.hold_expires_at IS NULL OR w.hold_expires_at < now() + interval '55 seconds' OR w.position <> 0 THEN
    RAISE EXCEPTION 'S17 hold row wrong: %', to_jsonb(w);
  END IF;
  IF public.fn_cash_game_open_seats(main2) <> 0 THEN RAISE EXCEPTION 'S17 the hold is not subtracted'; END IF;
  -- A buys in: the gate excludes A's own hold, so A is admitted.
  PERFORM pg_temp.as_engine();
  SELECT gs INTO v_seat FROM generate_series(1, coalesce((SELECT max_players FROM public.tables WHERE id=main2), 6)) gs
   WHERE NOT EXISTS (SELECT 1 FROM public.table_seats s WHERE s.table_id=main2 AND s.seat_number=gs AND s.left_at IS NULL) ORDER BY gs LIMIT 1;
  PERFORM public.atomic_table_buyin(ua, main2, v_seat, v_buyin, false, g.club_id, gen_random_uuid());
  IF NOT EXISTS (SELECT 1 FROM public.table_seats WHERE table_id=main2 AND user_id=ua AND left_at IS NULL AND stack = v_buyin) THEN RAISE EXCEPTION 'S17 A not seated'; END IF;
  IF (SELECT status FROM public.table_waitlist WHERE id=w.id) <> 'seated' THEN RAISE EXCEPTION 'S17 hold not flipped to seated: %', (SELECT status FROM public.table_waitlist WHERE id=w.id); END IF;
  v_ok := v_ok || 'S17 first-caller-held-and-admitted ';

  -- Open one more chair on Main 2 for the next rounds.
  UPDATE public.table_seats SET stack=0 WHERE id = (SELECT id FROM public.table_seats WHERE table_id=main2 AND user_id = ids[4] AND left_at IS NULL);
  UPDATE public.table_seats SET left_at=now(), status='left' WHERE table_id=main2 AND user_id = ids[4] AND left_at IS NULL;
  IF public.fn_cash_game_open_seats(main2) <> 1 THEN RAISE EXCEPTION 'fixture2: open chairs main2=%', public.fn_cash_game_open_seats(main2); END IF;

  -- S18 the second caller is told the truth: B holds the chair, C is waitlisted,
  -- and a third caller at the door while B holds is refused SEAT_RESERVED.
  PERFORM pg_temp.as_player(ub);
  r := public.fn_cash_game_join(g.id);
  IF r->>'action' <> 'seat' OR (r->>'table_id')::uuid <> main2 THEN RAISE EXCEPTION 'S18 B expected seat, got %', r; END IF;
  PERFORM pg_temp.as_player(uc);
  r := public.fn_cash_game_join(g.id);
  IF r->>'action' <> 'waitlisted' OR (r->>'position')::int <> 1 THEN RAISE EXCEPTION 'S18 C expected waitlisted #1, got %', r; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cash_game_waitlist WHERE game_id=g.id AND user_id=uc AND status='waiting') THEN RAISE EXCEPTION 'S18 C has no game waitlist row'; END IF;
  -- C goes straight to the buy-in door anyway (a stale tab): the gate honours B's hold.
  PERFORM pg_temp.as_engine();
  SELECT gs INTO v_seat FROM generate_series(1, coalesce((SELECT max_players FROM public.tables WHERE id=main2), 6)) gs
   WHERE NOT EXISTS (SELECT 1 FROM public.table_seats s WHERE s.table_id=main2 AND s.seat_number=gs AND s.left_at IS NULL) ORDER BY gs LIMIT 1;
  BEGIN
    PERFORM public.atomic_table_buyin(uc, main2, v_seat, v_buyin, false, g.club_id, gen_random_uuid());
    RAISE EXCEPTION 'S18 C was admitted onto B''s held chair';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'SEAT_RESERVED%' THEN RAISE EXCEPTION 'S18 wrong refusal for C: % (%)', SQLERRM, SQLSTATE; END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.table_seats WHERE table_id=main2 AND user_id=uc AND left_at IS NULL) THEN RAISE EXCEPTION 'S18 C seated despite the refusal'; END IF;
  v_ok := v_ok || 'S18 second-caller-told-the-truth ';

  -- S19 asking twice is one hold: B asks again -> same table, one live row, expiry refreshed.
  SELECT hold_expires_at INTO v_exp FROM public.table_waitlist WHERE table_id=main2 AND user_id=ub AND status='notified';
  PERFORM pg_sleep(0.05);
  PERFORM pg_temp.as_player(ub);
  r := public.fn_cash_game_join(g.id);
  IF r->>'action' <> 'seat' OR (r->>'table_id')::uuid <> main2 THEN RAISE EXCEPTION 'S19 B second ask: %', r; END IF;
  SELECT count(*) INTO v_n FROM public.table_waitlist tw JOIN public.tables tb ON tb.id=tw.table_id
   WHERE tw.user_id=ub AND tw.status='notified' AND tw.hold_expires_at > now() AND tb.cluster_id=g.id;
  IF v_n <> 1 THEN RAISE EXCEPTION 'S19 B holds % chairs in the game', v_n; END IF;
  IF (SELECT hold_expires_at FROM public.table_waitlist WHERE table_id=main2 AND user_id=ub AND status='notified') < v_exp THEN RAISE EXCEPTION 'S19 hold not refreshed'; END IF;
  -- and a stale hold of B's on another table of the game lapses when B is handed this one:
  INSERT INTO public.table_waitlist (table_id, user_id, position, status, notified_at, hold_expires_at)
  VALUES (feeder, ub, 0, 'notified', now(), now() + interval '60 seconds');
  r := public.fn_cash_game_join(g.id);   -- B's live hold is found on... the newest expiry wins: still one live hold afterwards
  SELECT count(*) INTO v_n FROM public.table_waitlist tw JOIN public.tables tb ON tb.id=tw.table_id
   WHERE tw.user_id=ub AND tw.status='notified' AND tw.hold_expires_at > now() AND tb.cluster_id=g.id;
  IF v_n <> 1 THEN
    -- the existing-hold branch refreshes ONE row and does not expire the other: tighten it here so the invariant holds
    RAISE EXCEPTION 'S19 after a stray hold on another table B holds % chairs (expected 1)', v_n;
  END IF;
  v_ok := v_ok || 'S19 asking-twice-is-one-hold ';

  -- S20 the hold lapses: the chair is free to the next caller, the sweep retires the row.
  UPDATE public.table_waitlist SET hold_expires_at = now() - interval '1 second' WHERE user_id=ub AND status='notified';
  IF public.fn_cash_game_open_seats(main2) <> 1 THEN RAISE EXCEPTION 'S20 lapsed hold still subtracted'; END IF;
  PERFORM pg_temp.as_player(uc);
  r := public.fn_cash_game_join(g.id);
  IF r->>'action' <> 'seat' OR (r->>'table_id')::uuid <> main2 THEN RAISE EXCEPTION 'S20 C expected seat after the lapse, got %', r; END IF;
  IF (SELECT status FROM public.cash_game_waitlist WHERE game_id=g.id AND user_id=uc) <> 'notified' THEN RAISE EXCEPTION 'S20 C game-waitlist row not notified'; END IF;
  PERFORM pg_temp.as_player(ub);
  r := public.fn_cash_game_join(g.id);
  IF r->>'action' <> 'waitlisted' THEN RAISE EXCEPTION 'S20 B after lapse expected waitlisted, got %', r; END IF;
  PERFORM pg_temp.as_engine();
  r := public.fn_sweep_stale_waitlists();
  IF EXISTS (SELECT 1 FROM public.table_waitlist WHERE user_id=ub AND table_id=main2 AND status='notified') THEN RAISE EXCEPTION 'S20 sweep left the lapsed hold notified'; END IF;
  IF (SELECT status FROM public.table_waitlist WHERE user_id=uc AND table_id=main2 AND status IN ('notified','seated') LIMIT 1) <> 'notified' THEN RAISE EXCEPTION 'S20 sweep took the live hold'; END IF;
  -- and C sits: admitted on their own hold.
  SELECT gs INTO v_seat FROM generate_series(1, coalesce((SELECT max_players FROM public.tables WHERE id=main2), 6)) gs
   WHERE NOT EXISTS (SELECT 1 FROM public.table_seats s WHERE s.table_id=main2 AND s.seat_number=gs AND s.left_at IS NULL) ORDER BY gs LIMIT 1;
  PERFORM public.atomic_table_buyin(uc, main2, v_seat, v_buyin, false, g.club_id, gen_random_uuid());
  IF NOT EXISTS (SELECT 1 FROM public.table_seats WHERE table_id=main2 AND user_id=uc AND left_at IS NULL) THEN RAISE EXCEPTION 'S20 C not seated'; END IF;
  v_ok := v_ok || 'S20 lapse-frees-the-chair ';

  -- S22 the lock the door takes is the buy-in gate's key (proves the same-instant race is serialized).
  IF NOT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted) THEN
    RAISE EXCEPTION 'S22 no advisory lock held after the door ran';
  END IF;
  v_ok := v_ok || 'S22 table-lock-held ';

  RAISE EXCEPTION 'PROBE PASS: %', v_ok;
END $probe$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- S21 THE SAME-INSTANT RACE, two sessions, nothing committed.
-- Session 1 (this new door, as player A) is handed a chair and holds the
-- buy-in gate's key `table_seat:<table>` for its transaction, then sleeps.
-- Session 2 asks for that key with lock_timeout = 2s, exactly as the buy-in
-- gate or a second door call would, and MUST time out (55P03).
-- Run 2026-09-10 18:37 UTC: session 1 `RACE_TID <table> ACT seat`,
-- `advisory_locks_held 1`; session 2 `ERROR: canceling statement due to lock
-- timeout`. Both rolled back.
--
-- race-s1.sql
--   BEGIN; SET LOCAL lock_timeout='4s';
--   \i /tmp/laneB/mig-183043-body.sql   -- the migration body, BEGIN/COMMIT stripped (see header)
--   (pick a live must-move game with an open chair, a free horse with a wallet there)
--   SELECT set_config('request.jwt.claims', json_build_object('sub', :'uid', 'role','authenticated')::text, true);
--   SELECT r->>'table_id' AS tid, r->>'action' AS act FROM (SELECT public.fn_cash_game_join(:'gid'::uuid) r) s \gset
--   \echo RACE_TID :tid ACT :act
--   SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted;
--   SELECT pg_sleep(7); ROLLBACK;
-- race-s2.sql (started 4 s later, with -v tid=<from session 1>)
--   BEGIN; SET LOCAL lock_timeout='2s';
--   SELECT pg_advisory_xact_lock(hashtextextended('table_seat:' || :'tid', 0));   -- expect 55P03
--   ROLLBACK;

-- ═════════════════════════════════════════════════════════════════════════════
-- SECTION 2 (2026-09-10, later the same day): F10 and F11, rolled back.
--   F10 20260910184427_the_door_honours_the_chair_the_game_promised  -> S23-S28
--   F11 20260910184439_a_browser_never_writes_the_waitlist_itself     -> S29-S36
-- Build the bodies the same way (BEGIN/COMMIT stripped) into
-- /tmp/laneB/mig-184427-body.sql and /tmp/laneB/mig-184439-body.sql; each
-- block below is ONE psql transaction ending in RAISE EXCEPTION.
--
-- Scoreboards, run 2026-09-10 18:48 / 18:49 UTC against production:
--   PROBE PASS: S23 promised-chair-refused S24 door-and-census-agree
--   S25 own-reservation-never-refuses S26 mover-lands S27 swap-is-not-a-reservation S28 no-is_horse
--   PROBE PASS: S29 direct-writes-refused S30 reads-work S31 join-door-works
--   S32 leave-door-works S33 game-doors-work S34 door-refuses-what-the-offer-refuses
--   S35 service-writes S36 policy-shape
-- ═════════════════════════════════════════════════════════════════════════════

-- ── F10 ──────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '120s';
\i /tmp/laneB/mig-184427-body.sql

CREATE FUNCTION pg_temp.seat_probe(p_table uuid, p_user uuid, p_stack numeric, p_joined timestamptz, p_club uuid)
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_seat int; v_id uuid;
BEGIN
  SELECT gs INTO v_seat FROM generate_series(1, coalesce((SELECT max_players FROM public.tables WHERE id = p_table), 9)) gs
   WHERE NOT EXISTS (SELECT 1 FROM public.table_seats s WHERE s.table_id = p_table AND s.seat_number = gs AND s.left_at IS NULL)
   ORDER BY gs LIMIT 1;
  IF v_seat IS NULL THEN RAISE EXCEPTION 'no free chair at %', p_table; END IF;
  UPDATE public.table_seats
     SET user_id = p_user, stack = p_stack, status = 'active', left_at = NULL, joined_at = p_joined,
         club_id = p_club, leave_pending = false, is_sitting_out = false, sit_out_at = NULL
   WHERE table_id = p_table AND seat_number = v_seat AND left_at IS NOT NULL
   RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    INSERT INTO public.table_seats (table_id, seat_number, user_id, stack, status, joined_at, club_id)
    VALUES (p_table, v_seat, p_user, p_stack, 'active', p_joined, p_club);
  END IF;
END $f$;
CREATE FUNCTION pg_temp.free_seat(p_table uuid) RETURNS int LANGUAGE sql AS $f$
  SELECT gs FROM generate_series(1, coalesce((SELECT max_players FROM public.tables WHERE id = p_table), 9)) gs
   WHERE NOT EXISTS (SELECT 1 FROM public.table_seats s WHERE s.table_id = p_table AND s.seat_number = gs AND s.left_at IS NULL)
   ORDER BY gs LIMIT 1;
$f$;

DO $probe$
DECLARE
  g record; main1 uuid; main2 uuid; feeder uuid;
  um uuid; us uuid; ub uuid; uc uuid;
  r jsonb; x record;
  v_ok text := ''; ids uuid[]; v_n int; v_buyin numeric; v_move uuid; v_move_a uuid; v_move_b uuid;
BEGIN
  PERFORM set_config('app.money_path', 'atomic_table_buyin', true);
  PERFORM set_config('request.jwt.claims', '', true);   -- the engine

  SELECT g0.* INTO g FROM public.cash_games g0
   WHERE g0.must_move AND g0.enabled AND g0.state = 'live'
     AND EXISTS (SELECT 1 FROM public.tables t WHERE t.cluster_id = g0.id AND t.role='main' AND t.main_index=1 AND t.lifecycle='live' AND t.status IN ('waiting','running','active'))
     AND EXISTS (SELECT 1 FROM public.tables t WHERE t.cluster_id = g0.id AND t.role='feeder' AND t.lifecycle='live' AND t.status IN ('waiting','running','active') AND public.fn_cash_game_open_seats(t.id) >= 2)
     AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves mv WHERE mv.game_id = g0.id AND mv.state='pending')
   ORDER BY g0.name LIMIT 1;
  IF g.id IS NULL THEN RAISE EXCEPTION 'no fixture game'; END IF;
  SELECT id INTO main1 FROM public.tables WHERE cluster_id=g.id AND role='main' AND main_index=1 AND lifecycle='live' LIMIT 1;
  SELECT id INTO feeder FROM public.tables WHERE cluster_id=g.id AND role='feeder' AND lifecycle='live' ORDER BY created_at LIMIT 1;
  main2 := gen_random_uuid();
  EXECUTE format('INSERT INTO public.tables (%s) SELECT %s FROM public.tables t WHERE t.id = $1',
    (SELECT string_agg(quote_ident(column_name), ',') FROM information_schema.columns WHERE table_schema='public' AND table_name='tables' AND is_generated='NEVER'),
    (SELECT string_agg(CASE column_name
        WHEN 'id' THEN quote_literal(main2)||'::uuid' WHEN 'name' THEN quote_literal('PROBE Main 2')
        WHEN 'role' THEN quote_literal('main') WHEN 'main_index' THEN '2'
        WHEN 'lifecycle' THEN quote_literal('live') WHEN 'status' THEN quote_literal('running')
        WHEN 'current_players' THEN '0' WHEN 'created_at' THEN 'now()' WHEN 'updated_at' THEN 'now()'
        ELSE 't.'||quote_ident(column_name) END, ',' ORDER BY ordinal_position)
       FROM information_schema.columns WHERE table_schema='public' AND table_name='tables' AND is_generated='NEVER'))
    USING main1;

  SELECT array_agg(id) INTO ids FROM (
    SELECT p.id FROM public.profiles p
     WHERE coalesce(p.is_horse,false)
       AND NOT EXISTS (SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id WHERE s.user_id=p.id AND s.left_at IS NULL AND t.cluster_id=g.id)
       AND public.fn_concurrent_game_load(p.id, NULL, NULL, NULL) <= 1
       AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves mv WHERE mv.player_id=p.id AND mv.state='pending')
       AND NOT EXISTS (SELECT 1 FROM public.table_waitlist tw WHERE tw.user_id=p.id AND tw.status IN ('waiting','notified'))
       AND NOT EXISTS (SELECT 1 FROM public.cash_rejoin_constraints c WHERE c.player_id=p.id AND c.expires_at > now())
       AND EXISTS (SELECT 1 FROM public.club_members cm WHERE cm.user_id=p.id AND cm.club_id=g.club_id AND cm.chip_balance >= 200)
     ORDER BY p.id LIMIT 16) q;
  um:=ids[1]; us:=ids[2]; ub:=ids[3]; uc:=ids[4];
  IF ids[8] IS NULL THEN RAISE EXCEPTION 'not enough free horses'; END IF;
  -- M (the mover) and C on the feeder; B and fillers on Main 2 up to max-1: ONE chair open.
  PERFORM pg_temp.seat_probe(feeder, um, 20.00, now() - interval '50 minutes', g.club_id);
  PERFORM pg_temp.seat_probe(feeder, uc, 20.00, now() - interval '40 minutes', g.club_id);
  PERFORM pg_temp.seat_probe(main2,  ub, 30.00, now() - interval '45 minutes', g.club_id);
  v_n := 5;
  WHILE (SELECT count(*) FROM public.table_seats s WHERE s.table_id=main2 AND s.left_at IS NULL)
        < coalesce((SELECT max_players FROM public.tables WHERE id=main2), 6) - 1 LOOP
    IF ids[v_n] IS NULL THEN RAISE EXCEPTION 'ran out of fillers'; END IF;
    PERFORM pg_temp.seat_probe(main2, ids[v_n], 20.00, now() - interval '30 minutes', g.club_id); v_n := v_n + 1;
  END LOOP;
  IF public.fn_cash_game_open_seats(main2) <> 1 THEN RAISE EXCEPTION 'fixture: main2 open %', public.fn_cash_game_open_seats(main2); END IF;
  v_buyin := coalesce((SELECT min_buy_in FROM public.tables WHERE id=main2), 0);
  IF v_buyin <= 0 THEN v_buyin := 40 * g.bb; END IF;

  -- S23 the tick promised the chair to M: a stranger's buy-in is refused, by name.
  INSERT INTO public.cash_seat_moves (game_id, player_id, from_table_id, to_table_id, reason)
  VALUES (g.id, um, feeder, main2, 'must_move') RETURNING id INTO v_move;
  IF public.fn_cash_game_open_seats(main2) <> 0 THEN RAISE EXCEPTION 'S23 open_seats does not subtract the plan'; END IF;
  BEGIN
    PERFORM public.atomic_table_buyin(us, main2, pg_temp.free_seat(main2), v_buyin, false, g.club_id, gen_random_uuid());
    RAISE EXCEPTION 'S23 the stranger took the promised chair';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'SEAT_RESERVED: the open seat is held for a player the game is moving here%' THEN
      RAISE EXCEPTION 'S23 wrong refusal: % (%)', SQLERRM, SQLSTATE;
    END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.table_seats WHERE table_id=main2 AND user_id=us AND left_at IS NULL) THEN RAISE EXCEPTION 'S23 stranger seated'; END IF;
  IF EXISTS (SELECT 1 FROM public.wallet_transactions WHERE user_id=us AND table_id=main2 AND created_at > now() - interval '1 minute') THEN RAISE EXCEPTION 'S23 chips moved on a refusal'; END IF;
  v_ok := v_ok || 'S23 promised-chair-refused ';

  -- S24 the door and the census agree: seats + holds + plans against max, both ways.
  IF (SELECT count(*) FROM public.table_seats WHERE table_id=main2 AND left_at IS NULL)
     + (SELECT count(*) FROM public.cash_seat_moves WHERE to_table_id=main2 AND state='pending' AND swap_move_id IS NULL)
     <> coalesce((SELECT max_players FROM public.tables WHERE id=main2), 6) THEN
    RAISE EXCEPTION 'S24 arithmetic';
  END IF;
  v_ok := v_ok || 'S24 door-and-census-agree ';

  -- S25 the mover is never refused by their own reservation: M's buy-in at the
  -- destination passes this clause (own move excluded) and is stopped later by
  -- ALREADY_IN_GAME, because M is seated on the feeder. Not SEAT_RESERVED.
  BEGIN
    PERFORM public.atomic_table_buyin(um, main2, pg_temp.free_seat(main2), v_buyin, false, g.club_id, gen_random_uuid());
    RAISE EXCEPTION 'S25 the mover bought a second chair in the game';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SEAT_RESERVED%' THEN RAISE EXCEPTION 'S25 the mover was refused by their own reservation: %', SQLERRM; END IF;
    IF SQLERRM NOT LIKE 'ALREADY_IN_GAME%' THEN RAISE EXCEPTION 'S25 unexpected refusal: % (%)', SQLERRM, SQLSTATE; END IF;
  END;
  v_ok := v_ok || 'S25 own-reservation-never-refuses ';

  -- S26 the mover's own path is unaffected: the executor lands M on the promised chair.
  r := public.fn_cash_seat_move_execute(v_move);
  IF NOT (r->>'ok')::boolean THEN RAISE EXCEPTION 'S26 execute %', r; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.table_seats WHERE table_id=main2 AND user_id=um AND left_at IS NULL AND stack = 20.00) THEN RAISE EXCEPTION 'S26 M not on main2'; END IF;
  IF public.fn_cash_game_open_seats(main2) <> 0 THEN RAISE EXCEPTION 'S26 open after landing %', public.fn_cash_game_open_seats(main2); END IF;
  v_ok := v_ok || 'S26 mover-lands ';

  -- S27 a linked swap is NOT a reservation: one chair opens, B (main2) <-> C
  -- (feeder) are swapping, the stranger is admitted onto the open chair.
  UPDATE public.table_seats SET stack=0 WHERE table_id=main2 AND user_id=ids[5] AND left_at IS NULL;
  UPDATE public.table_seats SET left_at=now(), status='left' WHERE table_id=main2 AND user_id=ids[5] AND left_at IS NULL;
  IF public.fn_cash_game_open_seats(main2) <> 1 THEN RAISE EXCEPTION 'S27 fixture open %', public.fn_cash_game_open_seats(main2); END IF;
  INSERT INTO public.cash_seat_moves (game_id, player_id, from_table_id, to_table_id, reason, to_seat_number)
  VALUES (g.id, ub, main2, feeder, 'seat_change', (SELECT seat_number FROM public.table_seats WHERE table_id=feeder AND user_id=uc AND left_at IS NULL))
  RETURNING id INTO v_move_a;
  INSERT INTO public.cash_seat_moves (game_id, player_id, from_table_id, to_table_id, reason, to_seat_number, swap_move_id)
  VALUES (g.id, uc, feeder, main2, 'seat_change', (SELECT seat_number FROM public.table_seats WHERE table_id=main2 AND user_id=ub AND left_at IS NULL), v_move_a)
  RETURNING id INTO v_move_b;
  UPDATE public.cash_seat_moves SET swap_move_id = v_move_b WHERE id = v_move_a;
  IF public.fn_cash_game_open_seats(main2) <> 1 THEN RAISE EXCEPTION 'S27 the census counted the swap'; END IF;
  PERFORM public.atomic_table_buyin(us, main2, pg_temp.free_seat(main2), v_buyin, false, g.club_id, gen_random_uuid());
  IF NOT EXISTS (SELECT 1 FROM public.table_seats WHERE table_id=main2 AND user_id=us AND left_at IS NULL) THEN RAISE EXCEPTION 'S27 stranger refused beside a swap'; END IF;
  v_ok := v_ok || 'S27 swap-is-not-a-reservation ';

  -- S28 no is_horse in the door.
  IF position('is_horse' in (SELECT prosrc FROM pg_proc WHERE oid='public.atomic_table_buyin_before_maintenance_announcement_gate(uuid,uuid,integer,numeric,boolean,uuid,uuid)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'S28 is_horse in the gate';
  END IF;
  v_ok := v_ok || 'S28 no-is_horse ';

  RAISE EXCEPTION 'PROBE PASS: %', v_ok;
END $probe$;
ROLLBACK;

-- ── F11 ──────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '120s';
\i /tmp/laneB/mig-184439-body.sql
\i /tmp/laneB/mig-183043-body.sql

DO $probe$
DECLARE
  g record; feeder uuid; uh uuid; r jsonb; v_ok text := ''; v_n int; v_id uuid; v_state text;
BEGIN
  SELECT g0.* INTO g FROM public.cash_games g0
   WHERE g0.must_move AND g0.enabled AND g0.state = 'live'
     AND EXISTS (SELECT 1 FROM public.tables t WHERE t.cluster_id = g0.id AND t.role='feeder' AND t.lifecycle='live' AND t.status IN ('waiting','running','active') AND t.tournament_id IS NULL)
   ORDER BY g0.name LIMIT 1;
  SELECT id INTO feeder FROM public.tables WHERE cluster_id=g.id AND role='feeder' AND lifecycle='live' ORDER BY created_at LIMIT 1;
  SELECT p.id INTO uh FROM public.profiles p
   WHERE coalesce(p.is_horse,false)
     AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id)
     AND NOT EXISTS (SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id WHERE s.user_id=p.id AND s.left_at IS NULL AND t.cluster_id=g.id)
     AND NOT EXISTS (SELECT 1 FROM public.table_waitlist tw WHERE tw.user_id=p.id AND tw.status IN ('waiting','notified'))
     AND NOT EXISTS (SELECT 1 FROM public.cash_rejoin_constraints c WHERE c.player_id=p.id AND c.expires_at > now())
     AND EXISTS (SELECT 1 FROM public.club_members cm WHERE cm.user_id=p.id AND cm.club_id=g.club_id)
   ORDER BY p.id LIMIT 1;
  IF uh IS NULL THEN RAISE EXCEPTION 'no fixture player'; END IF;

  -- The browser: role authenticated, a JWT for this player.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', uh, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  -- S29 a direct INSERT of a hold is refused.
  BEGIN
    INSERT INTO public.table_waitlist (table_id, user_id, status, notified_at, hold_expires_at)
    VALUES (feeder, uh, 'notified', now(), now() + interval '10 years');
    RAISE EXCEPTION 'S29 the browser wrote itself a hold';
  EXCEPTION WHEN insufficient_privilege THEN
    v_state := SQLSTATE;
  END;
  IF v_state <> '42501' THEN RAISE EXCEPTION 'S29 state %', v_state; END IF;
  -- and a direct UPDATE, and a direct DELETE
  BEGIN
    UPDATE public.table_waitlist SET status = 'notified', hold_expires_at = now() + interval '10 years' WHERE user_id = uh;
    RAISE EXCEPTION 'S29 the browser updated the waitlist';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.table_waitlist WHERE user_id = uh;
    RAISE EXCEPTION 'S29 the browser deleted from the waitlist';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  v_ok := v_ok || 'S29 direct-writes-refused ';

  -- S30 reading their own rows still works (and the public queue read).
  PERFORM 1 FROM public.table_waitlist WHERE user_id = uh;
  PERFORM count(*) FROM public.table_waitlist WHERE table_id = feeder AND status IN ('waiting','notified');
  v_ok := v_ok || 'S30 reads-work ';

  -- S31 the join door writes the line for them, idempotently.
  r := public.fn_table_waitlist_join(feeder);
  IF NOT (r->>'ok')::boolean OR (r->>'already_on_waitlist')::boolean OR r->'entry'->>'status' <> 'waiting' THEN RAISE EXCEPTION 'S31 join %', r; END IF;
  v_id := (r->'entry'->>'id')::uuid;
  r := public.fn_table_waitlist_join(feeder);
  IF NOT (r->>'already_on_waitlist')::boolean OR (r->'entry'->>'id')::uuid <> v_id THEN RAISE EXCEPTION 'S31 second join %', r; END IF;
  SELECT count(*) INTO v_n FROM public.table_waitlist WHERE user_id = uh AND table_id = feeder AND status IN ('waiting','notified');
  IF v_n <> 1 THEN RAISE EXCEPTION 'S31 % rows', v_n; END IF;
  v_ok := v_ok || 'S31 join-door-works ';

  -- S32 the leave door.
  r := public.fn_table_waitlist_leave(feeder);
  IF NOT (r->>'ok')::boolean OR (r->>'cancelled')::int <> 1 THEN RAISE EXCEPTION 'S32 leave %', r; END IF;
  IF (SELECT status FROM public.table_waitlist WHERE id = v_id) <> 'left' THEN RAISE EXCEPTION 'S32 row not left'; END IF;
  r := public.fn_table_waitlist_leave(feeder);
  IF (r->>'cancelled')::int <> 0 THEN RAISE EXCEPTION 'S32 second leave %', r; END IF;
  v_ok := v_ok || 'S32 leave-door-works ';

  -- S33 the game doors still work for this browser: the join door (which
  -- now writes a hold as the definer) and the game waitlist leave.
  r := public.fn_cash_game_join(g.id);
  IF r->>'action' NOT IN ('seat', 'waitlisted') THEN RAISE EXCEPTION 'S33 game join %', r; END IF;
  IF r->>'action' = 'seat' AND NOT EXISTS (SELECT 1 FROM public.table_waitlist WHERE user_id = uh AND status = 'notified' AND position = 0) THEN
    RAISE EXCEPTION 'S33 the game door could not write its hold as the definer';
  END IF;
  r := public.fn_cash_game_leave_waitlist(g.id);
  IF NOT (r->>'ok')::boolean THEN RAISE EXCEPTION 'S33 game leave %', r; END IF;
  v_ok := v_ok || 'S33 game-doors-work ';

  -- S34 a tournament table and a closed table are refused by the join door.
  BEGIN
    r := public.fn_table_waitlist_join((SELECT id FROM public.tables WHERE tournament_id IS NOT NULL AND status NOT IN ('closed','deleted') LIMIT 1));
    RAISE EXCEPTION 'S34 tournament table joined';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'WAITLIST_TOURNAMENT_TABLE%' THEN RAISE EXCEPTION 'S34 wrong refusal %', SQLERRM; END IF;
  END;
  BEGIN
    r := public.fn_table_waitlist_join((SELECT id FROM public.tables WHERE status = 'closed' AND tournament_id IS NULL LIMIT 1));
    RAISE EXCEPTION 'S34 closed table joined';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'WAITLIST_TABLE_CLOSED%' THEN RAISE EXCEPTION 'S34 wrong refusal %', SQLERRM; END IF;
  END;
  v_ok := v_ok || 'S34 door-refuses-what-the-offer-refuses ';

  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);

  -- S35 the service still writes the table (the engine, the World Hub API).
  IF NOT has_table_privilege('service_role', 'public.table_waitlist', 'INSERT') THEN RAISE EXCEPTION 'S35 service lost INSERT'; END IF;
  EXECUTE 'SET LOCAL ROLE service_role';
  UPDATE public.table_waitlist SET status = 'cleared' WHERE user_id = uh AND status IN ('waiting','notified');   -- the fleet's own prune, as the service
  INSERT INTO public.table_waitlist (table_id, user_id, status) VALUES (feeder, uh, 'waiting') RETURNING id INTO v_id;
  UPDATE public.table_waitlist SET status = 'cleared' WHERE id = v_id;
  EXECUTE 'RESET ROLE';
  v_ok := v_ok || 'S35 service-writes ';

  -- S36 no browser policy but SELECT remains on the table.
  IF (SELECT count(*) FROM pg_policy WHERE polrelid='public.table_waitlist'::regclass AND polcmd <> 'r') > 0 THEN RAISE EXCEPTION 'S36 write policy'; END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid='public.table_waitlist'::regclass AND polcmd = 'r') <> 3 THEN RAISE EXCEPTION 'S36 read policies %', (SELECT count(*) FROM pg_policy WHERE polrelid='public.table_waitlist'::regclass AND polcmd = 'r'); END IF;
  v_ok := v_ok || 'S36 policy-shape ';

  RAISE EXCEPTION 'PROBE PASS: %', v_ok;
END $probe$;
ROLLBACK;
