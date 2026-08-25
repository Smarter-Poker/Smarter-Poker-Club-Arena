-- ═══════════════════════════════════════════════════════════════════════════
-- NO RATHOLE, ENFORCED
-- ───────────────────────────────────────────────────────────────────────────
-- Dan 2026-08-25, table-creation parity. `tables.no_rathole` has been a toggle
-- since February with ZERO readers in server/src. The lobby even printed a
-- medallion saying "Players must return with their full previous stack", and
-- nothing anywhere made that true: a player could leave a 5,000 stack and sit
-- straight back down for the 400 minimum.
--
-- It needs no new column. `table_seats` keeps the departed row — `left_at` is
-- stamped and `stack` is left intact — so the stack a player walked away with
-- is already recorded. The rule is read off that.
--
-- THE FLOOR IS CAPPED AT max_buy_in. A player who left with more than the
-- table's ceiling (they won a big pot) cannot be asked to bring back more than
-- the table will accept, which would lock them out of their own game forever.
--
-- Placed AFTER the table-size checks and BEFORE the wallet resolve, and
-- critically before the function's own
--   DELETE FROM table_seats WHERE ... AND left_at IS NOT NULL
-- which would otherwise erase the very history this reads when a player
-- returns to the same seat number. The post-apply assertion checks that
-- ordering explicitly.
--
-- APPLIED to production 2026-08-25 and probed three ways on a live table:
--   flag off, short buy-in  -> accepted
--   flag on,  short buy-in  -> 'NO_RATHOLE: this table requires you to return
--                               with the 40.00 you left with'
--   flag on,  full buy-in   -> accepted
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

  IF position('NO_RATHOLE' IN v_def) > 0 THEN
    RAISE NOTICE 'atomic_table_buyin already enforces no_rathole; nothing to do';
    RETURN;
  END IF;

  IF position('TABLE_SIZE: table is full' IN v_def) = 0 THEN
    RAISE EXCEPTION
      'the table-size checks are not present - apply 20260825_atomic_table_buyin_honours_table_size first';
  END IF;

  v_def := replace(
    v_def,
    E'DECLARE\n',
    E'DECLARE\n  v_no_rathole boolean;\n  v_last_stack numeric;\n  v_rathole_floor numeric;\n'
  );
  v_def := replace(
    v_def,
    'SELECT t.club_id, c.union_id, t.min_buy_in, t.max_buy_in, COALESCE(t.max_players, 0)',
    'SELECT t.club_id, c.union_id, t.min_buy_in, t.max_buy_in, COALESCE(t.max_players, 0), COALESCE(t.no_rathole, false)'
  );
  v_def := replace(
    v_def,
    'INTO v_club_id, v_union_id, v_min_buy_in, v_max_buy_in, v_max_players',
    'INTO v_club_id, v_union_id, v_min_buy_in, v_max_buy_in, v_max_players, v_no_rathole'
  );
  v_def := replace(
    v_def,
    $anchor$      RAISE EXCEPTION 'TABLE_SIZE: table is full (% of % seats taken)',
        v_seats_taken, v_max_players;
    END IF;
  END IF;$anchor$,
    $ins$      RAISE EXCEPTION 'TABLE_SIZE: table is full (% of % seats taken)',
        v_seats_taken, v_max_players;
    END IF;
  END IF;

  -- ── NO RATHOLE (added 2026-08-25) ──────────────────────────────────────
  -- Come back with what you left with. Read from the departed seat row, which
  -- still carries the stack; capped at the table maximum so a player who won
  -- a big pot is not locked out of their own game.
  IF v_no_rathole THEN
    SELECT ts.stack INTO v_last_stack
      FROM table_seats ts
     WHERE ts.table_id = p_table_id
       AND ts.user_id = p_user_id
       AND ts.left_at IS NOT NULL
     ORDER BY ts.left_at DESC
     LIMIT 1;

    IF v_last_stack IS NOT NULL AND v_last_stack > 0 THEN
      v_rathole_floor := v_last_stack;
      IF v_max_buy_in IS NOT NULL AND v_max_buy_in > 0 AND v_rathole_floor > v_max_buy_in THEN
        v_rathole_floor := v_max_buy_in;
      END IF;
      IF p_amount < v_rathole_floor THEN
        RAISE EXCEPTION
          'NO_RATHOLE: this table requires you to return with the % you left with', v_rathole_floor
          USING HINT = 'The host has switched ratholing off for this table.';
      END IF;
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
  IF position('NO_RATHOLE' IN v_def) = 0 THEN
    RAISE EXCEPTION 'the no-rathole check did not land';
  END IF;
  IF position('v_no_rathole boolean' IN v_def) = 0 THEN
    RAISE EXCEPTION 'v_no_rathole was not declared';
  END IF;
  IF position('NO_RATHOLE' IN v_def) > position('left_at IS NOT NULL;' IN v_def) THEN
    RAISE EXCEPTION 'the check landed after the departed-seat DELETE and would read nothing';
  END IF;
END
$verify$;

-- ROLLBACK: re-run pg_get_functiondef, strip the block between the
-- "NO RATHOLE (added 2026-08-25)" comment and its closing END IF, drop
-- v_no_rathole / v_last_stack / v_rathole_floor from DECLARE and the flag from
-- the SELECT INTO, EXECUTE.
