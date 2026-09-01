-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825194623; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- A 6-MAX TABLE WAS ACCEPTING A BUY-IN AT SEAT 9
-- ───────────────────────────────────────────────────────────────────────────
-- Dan 2026-08-25, table-creation parity. The "Table Size" slider is enforced
-- in the client only. atomic_table_buyin is the sole hard gate on taking a
-- seat, and it never selected `max_players`, let alone checked it — the only
-- structural limits on table_seats are UNIQUE(table_id, seat_number) and
-- seat_number BETWEEN 1 AND 10. So a host's 6-max table would seat a player at
-- seat 9, and a full table would seat a seventh player at any free number.
--
-- Two checks, because they fail differently:
--   * the SEAT NUMBER must exist at this table size;
--   * the SEAT COUNT must be under it — the race a lock has to cover.
--
-- THE LOCK. The function already takes pg_advisory_xact_lock keyed on the
-- USER, which serialises one player against themselves and does nothing about
-- two different players reaching for the same last seat. A second lock keyed
-- on the TABLE is what makes the count check mean anything. Both are
-- transaction-scoped, so they release on commit or rollback, and they are
-- taken in a fixed order (user then table) so two callers cannot deadlock.
-- ═══════════════════════════════════════════════════════════════════════════

DO $migration$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'atomic_table_buyin';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'atomic_table_buyin does not exist - refusing to guess';
  END IF;

  IF position('TABLE_SIZE' IN v_def) > 0 THEN
    RAISE NOTICE 'atomic_table_buyin already enforces table size; nothing to do';
    RETURN;
  END IF;

  -- The three anchors this rewrite depends on. Assert each rather than let a
  -- silent no-op replace look like success.
  IF position('SELECT t.club_id, c.union_id, t.min_buy_in, t.max_buy_in' IN v_def) = 0 THEN
    RAISE EXCEPTION 'the tables SELECT has changed shape - widen it by hand';
  END IF;
  IF position('Player already seated at this table' IN v_def) = 0 THEN
    RAISE EXCEPTION 'the already-seated guard has moved - place the new checks by hand';
  END IF;
  IF position('v_max_buy_in numeric' IN v_def) = 0
     AND position('v_max_buy_in  numeric' IN v_def) = 0
     AND position('v_max_buy_in' IN v_def) = 0 THEN
    RAISE EXCEPTION 'v_max_buy_in is not declared - the DECLARE block has changed';
  END IF;

  -- 1. carry max_players out of the row we already read
  v_def := replace(
    v_def,
    'SELECT t.club_id, c.union_id, t.min_buy_in, t.max_buy_in',
    'SELECT t.club_id, c.union_id, t.min_buy_in, t.max_buy_in, COALESCE(t.max_players, 0)'
  );
  v_def := replace(
    v_def,
    'INTO v_club_id, v_union_id, v_min_buy_in, v_max_buy_in',
    'INTO v_club_id, v_union_id, v_min_buy_in, v_max_buy_in, v_max_players'
  );

  -- 2. declare the two new variables alongside the existing ones
  v_def := replace(
    v_def,
    E'DECLARE\n',
    E'DECLARE\n  v_max_players integer;\n  v_seats_taken integer;\n'
  );

  -- 3. the checks themselves, immediately after the already-seated guard
  v_def := replace(
    v_def,
    $anchor$    RAISE EXCEPTION 'Player already seated at this table';
  END IF;$anchor$,
    $ins$    RAISE EXCEPTION 'Player already seated at this table';
  END IF;

  -- ── TABLE SIZE (added 2026-08-25) ──────────────────────────────────────
  -- Serialise every buy-in AT THIS TABLE. The user-keyed lock above cannot
  -- stop two different players racing for one seat.
  PERFORM pg_advisory_xact_lock(hashtextextended('table_seat:' || p_table_id::text, 0));

  IF v_max_players > 0 AND p_seat_number > v_max_players THEN
    RAISE EXCEPTION 'TABLE_SIZE: seat % does not exist at this table (% max)',
      p_seat_number, v_max_players;
  END IF;

  IF v_max_players > 0 THEN
    SELECT COUNT(*) INTO v_seats_taken
      FROM table_seats
     WHERE table_id = p_table_id AND left_at IS NULL;
    IF v_seats_taken >= v_max_players THEN
      RAISE EXCEPTION 'TABLE_SIZE: table is full (% of % seats taken)',
        v_seats_taken, v_max_players;
    END IF;
  END IF;$ins$
  );

  EXECUTE v_def;
END
$migration$;

DO $verify$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'atomic_table_buyin';
  IF position('TABLE_SIZE' IN v_def) = 0 THEN
    RAISE EXCEPTION 'the table-size checks did not land';
  END IF;
  IF position('table_seat:' IN v_def) = 0 THEN
    RAISE EXCEPTION 'the table-scoped advisory lock did not land';
  END IF;
  IF position('v_max_players integer' IN v_def) = 0 THEN
    RAISE EXCEPTION 'v_max_players was not declared';
  END IF;
END
$verify$;

-- ROLLBACK: re-run pg_get_functiondef, strip the block between the
-- "TABLE SIZE (added 2026-08-25)" comment and the second END IF, drop
-- v_max_players/v_seats_taken from DECLARE and from the SELECT INTO, EXECUTE.
-- Reverting re-opens over-seating; prefer fixing forward.
