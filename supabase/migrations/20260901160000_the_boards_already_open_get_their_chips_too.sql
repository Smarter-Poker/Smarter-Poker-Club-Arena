-- The seats already sitting on open boards when the seat-writes-its-chips
-- change landed still hold the zero they were created with, so a player
-- looking at the lobby right now still sees an empty stack beside a paid seat.
-- 76 of them, every one on a REGISTERING Spin, every one still 'playing'.
--
-- They get the board's own starting_chips - the identical number the table
-- build would write when the game starts, so nothing is created and nothing
-- moves. Tournament chips, not wallet chips.
--
-- Scoped hard: REGISTERING only, stack = 0 only, spins only. A RUNNING game's
-- zero is a player who busted and must stay zero.
--
-- ROLLBACK: none needed - the values written are the ones the start path
-- would write moments later anyway.

UPDATE public.table_seats s
   SET stack = t.starting_chips
  FROM public.tables tb
  JOIN public.tournaments t ON t.id = tb.tournament_id
 WHERE s.table_id = tb.id
   AND t.variant = 'spin'
   AND t.status = 'REGISTERING'
   AND s.left_at IS NULL
   AND s.stack = 0
   AND COALESCE(t.starting_chips, 0) > 0;

UPDATE public.tournament_players tp
   SET chips = t.starting_chips
  FROM public.tournaments t
 WHERE tp.tournament_id = t.id
   AND t.variant = 'spin'
   AND t.status = 'REGISTERING'
   AND tp.status = 'playing'
   AND COALESCE(tp.chips, 0) = 0
   AND COALESCE(t.starting_chips, 0) > 0;

DO $$
DECLARE v_left integer;
BEGIN
  SELECT count(*) INTO v_left
  FROM public.table_seats s
  JOIN public.tables tb ON tb.id = s.table_id
  JOIN public.tournaments t ON t.id = tb.tournament_id
  WHERE t.variant = 'spin' AND t.status = 'REGISTERING'
    AND s.left_at IS NULL AND s.stack = 0
    AND COALESCE(t.starting_chips, 0) > 0;
  IF v_left <> 0 THEN
    RAISE EXCEPTION '% open Spin seat(s) still hold no chips', v_left;
  END IF;
END $$;;
