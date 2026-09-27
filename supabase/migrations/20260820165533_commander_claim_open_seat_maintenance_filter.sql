-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820165533 "commander_claim_open_seat_maintenance_filter"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 09cce5422366c23b75aae103d3912c4b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Align the atomic seat-claim RPC with the JS seating paths.
--
-- The RPC filtered its table pool with `ct.status IS DISTINCT FROM 'closed'`.
-- commander_tables_status_check only allows available/in_use/reserved/
-- maintenance, so 'closed' never occurs on this table ('closed' belongs to the
-- legacy `tables` table) and the predicate excluded nothing.
--
-- seat-draw.js and tournamentSeating.findOpenSeat were just corrected to
-- exclude 'maintenance' (a broken or pulled table, the only state that really
-- means "do not seat anyone here") while keeping 'reserved' in the pool. This
-- brings the atomic path, which is what actually seats late registrations,
-- alternate promotions and restored players, into agreement with them.
--
-- IS DISTINCT FROM is null-safe, so a table with a NULL status stays seatable,
-- matching the `status.is.null` leg the JS predicates use.

CREATE OR REPLACE FUNCTION commander_claim_open_seat(
  p_entry_id uuid,
  p_tournament_id uuid,
  p_expected_status text DEFAULT NULL
)
RETURNS TABLE (table_number integer, seat_number integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_venue_id integer;
  v_starting_chips integer;
  v_seat record;
  v_current_status text;
BEGIN
  SELECT venue_id, starting_chips INTO v_venue_id, v_starting_chips
  FROM commander_tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament % not found', p_tournament_id;
  END IF;

  SELECT status INTO v_current_status
  FROM commander_tournament_entries
  WHERE id = p_entry_id AND tournament_id = p_tournament_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF p_expected_status IS NOT NULL AND v_current_status IS DISTINCT FROM p_expected_status THEN
    RETURN;
  END IF;

  WITH pool AS (
    SELECT ct.table_number, COALESCE(ct.max_seats, 9) AS max_seats
    FROM commander_tables ct
    WHERE ct.venue_id = v_venue_id
      AND ct.tournament_id = p_tournament_id
      AND ct.status IS DISTINCT FROM 'maintenance'
    UNION
    SELECT e.table_number, 9
    FROM commander_tournament_entries e
    WHERE e.tournament_id = p_tournament_id
      AND e.status IN ('registered','seated','active')
      AND e.table_number IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM commander_tables ct2
        WHERE ct2.venue_id = v_venue_id AND ct2.tournament_id = p_tournament_id
      )
  ),
  occupancy AS (
    SELECT p.table_number, p.max_seats,
           (SELECT count(*) FROM commander_tournament_entries e
             WHERE e.tournament_id = p_tournament_id
               AND e.status IN ('registered','seated','active')
               AND e.seat_number IS NOT NULL
               AND e.table_number = p.table_number) AS seated_count
    FROM pool p
  ),
  candidates AS (
    SELECT o.table_number, s.seat_number, o.seated_count
    FROM occupancy o
    CROSS JOIN LATERAL generate_series(1, o.max_seats) AS s(seat_number)
    WHERE NOT EXISTS (
      SELECT 1 FROM commander_tournament_entries e
      WHERE e.tournament_id = p_tournament_id
        AND e.status IN ('registered','seated','active')
        AND e.table_number = o.table_number
        AND e.seat_number = s.seat_number
        AND e.id <> p_entry_id
    )
  )
  SELECT c.table_number, c.seat_number INTO v_seat
  FROM candidates c
  ORDER BY c.seated_count ASC, c.table_number ASC, c.seat_number ASC
  LIMIT 1;

  IF v_seat IS NULL THEN
    RETURN;
  END IF;

  UPDATE commander_tournament_entries e
  SET table_number = v_seat.table_number,
      seat_number  = v_seat.seat_number,
      status       = CASE WHEN e.status = 'active' THEN 'active' ELSE 'seated' END,
      current_chips = CASE
                        WHEN COALESCE(e.current_chips, 0) > 0 THEN e.current_chips
                        ELSE COALESCE(v_starting_chips, 0)
                      END
  WHERE e.id = p_entry_id AND e.tournament_id = p_tournament_id;

  table_number := v_seat.table_number;
  seat_number  := v_seat.seat_number;
  RETURN NEXT;
END;
$$;

REVOKE EXECUTE ON FUNCTION commander_claim_open_seat(uuid, uuid, text) FROM anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.proname = 'commander_claim_open_seat'
      AND pg_get_functiondef(p.oid) LIKE '%IS DISTINCT FROM ''maintenance''%'
  ) THEN
    RAISE EXCEPTION 'commander_claim_open_seat maintenance filter not applied';
  END IF;
END $$;
