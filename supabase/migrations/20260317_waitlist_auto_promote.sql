-- ═══════════════════════════════════════════════════════════════════════════════
-- WAITLIST AUTO-SEAT — Promote Next Waitlisted Player When Seat Opens
-- ═══════════════════════════════════════════════════════════════════════════════
-- Created: 2026-03-17
-- Called by: TableService.leaveTable() after a player leaves and a seat opens.
-- Logic:
--   1. Find the next 'waiting' player in line (ordered by position)
--   2. Find the first open seat_number at the table
--   3. Insert into table_seats
--   4. Update waitlist entry status to 'seated'
--   5. Re-compact remaining waitlist positions
--   6. Return the promoted user_id (or NULL if no one in queue)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION promote_next_waitlisted_player(
  p_table_id UUID
)
RETURNS UUID AS $$
DECLARE
  v_next_user_id UUID;
  v_next_waitlist_id UUID;
  v_preferred_seat INTEGER;
  v_open_seat INTEGER;
  v_max_players INTEGER;
  v_rows INTEGER;
BEGIN
  -- 1. Find next waiting player (first in queue)
  SELECT id, user_id, preferred_seat
    INTO v_next_waitlist_id, v_next_user_id, v_preferred_seat
    FROM table_waitlists
   WHERE table_id = p_table_id
     AND status = 'waiting'
   ORDER BY position ASC
   LIMIT 1
   FOR UPDATE SKIP LOCKED;   -- Lock row to prevent race conditions

  -- No one waiting → nothing to do
  IF v_next_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- 2. Get table max_players
  SELECT max_players INTO v_max_players
    FROM tables
   WHERE id = p_table_id;

  IF v_max_players IS NULL THEN
    v_max_players := 9;
  END IF;

  -- 3. Find an open seat number
  -- Try preferred seat first (if specified and available)
  IF v_preferred_seat IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM table_seats
       WHERE table_id = p_table_id
         AND seat_number = v_preferred_seat
         AND left_at IS NULL
    ) THEN
      v_open_seat := v_preferred_seat;
    END IF;
  END IF;

  -- If preferred seat not available, find any open seat
  IF v_open_seat IS NULL THEN
    SELECT s.n INTO v_open_seat
      FROM generate_series(1, v_max_players) AS s(n)
     WHERE NOT EXISTS (
       SELECT 1 FROM table_seats
        WHERE table_id = p_table_id
          AND seat_number = s.n
          AND left_at IS NULL
     )
     ORDER BY s.n ASC
     LIMIT 1;
  END IF;

  -- No open seat → should not happen (called after a player left), but guard anyway
  IF v_open_seat IS NULL THEN
    RETURN NULL;
  END IF;

  -- 4. Clear stale seat row first (UNIQUE constraint on table_id+seat_number
  --    would block INSERT if an old row with left_at set still exists)
  DELETE FROM table_seats
   WHERE table_id = p_table_id
     AND seat_number = v_open_seat
     AND left_at IS NOT NULL;

  -- Insert the player into the seat (stack = 0, they'll buy in on arrival)
  INSERT INTO table_seats (table_id, seat_number, user_id, stack, status, is_sitting_out, joined_at)
  VALUES (p_table_id, v_open_seat, v_next_user_id, 0, 'sitting_out', true, NOW())
  ON CONFLICT (table_id, seat_number) DO NOTHING;

  -- CRITICAL: Verify the INSERT actually worked — if a concurrent RPC
  -- grabbed the same seat, DO NOTHING silently drops the row and we must
  -- NOT mark this player as 'seated' on the waitlist.
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    -- Seat was taken by concurrent operation — leave waitlist entry as is
    RETURN NULL;
  END IF;

  -- 5. Update waitlist entry to 'seated'
  UPDATE table_waitlists
     SET status = 'seated',
         updated_at = NOW()
   WHERE id = v_next_waitlist_id;

  -- 6. Re-compact remaining waitlist positions
  WITH ranked AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY position ASC) AS new_pos
      FROM table_waitlists
     WHERE table_id = p_table_id
       AND status = 'waiting'
  )
  UPDATE table_waitlists w
     SET position = r.new_pos
    FROM ranked r
   WHERE w.id = r.id;

  -- 7. Increment table player count
  UPDATE tables
     SET current_players = (
       SELECT COUNT(*) FROM table_seats
        WHERE table_id = p_table_id AND left_at IS NULL
     )
   WHERE id = p_table_id;

  RETURN v_next_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

