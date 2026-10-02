-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260823205648 as "spin_seat_lifecycle_paid_seats_and_cleanup"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- SPIN SEAT LIFECYCLE (Dan 2026-08-23)
--
--   "their seat is only confirmed once the funds are taken from the players
--    wallet."
--   "when a spin is over, it must remove all players and reopen the table.
--    when a player busts, they must be removed as soon as they are out."
--   "spins can never ever start until 3 players have sat down, and paid for
--    there seat, only then does the spin feature start."
--
-- Three defects this repairs, all observed on live data 2026-08-23:
--
--   1. tournaments.current_players is a registration counter that is only ever
--      incremented. Seat-first buy-ins updated tables.current_players and left
--      it alone, and nothing decremented it on leave or bust. Live spins were
--      carrying 3/3 with two seats sold and 0/3 with three sold. Once it
--      reaches max_players, fn_register_for_tournament refuses every further
--      sit-down with 'tournament_full' — a spin that can never be joined.
--
--   2. Finished spins left their seat rows with left_at IS NULL. Those ghost
--      seats are invisible to the table page but real to the database, so an
--      apparently empty seat answered "seat_taken".
--
--   3. A busted player kept their seat until the whole game tore down.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Recompute a seat-first game's player count from the seats actually sold ──
CREATE OR REPLACE FUNCTION public.fn_sync_seat_first_player_count(p_tournament_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_table  uuid;
  v_seats  integer := 0;
BEGIN
  -- Newest live table wins: the recycler leaves the freshest one open and an
  -- older sibling not yet stamped closed is a corpse.
  SELECT id INTO v_table
    FROM public.tables
   WHERE tournament_id = p_tournament_id
     AND status <> 'closed'
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_table IS NULL THEN
    RETURN NULL;  -- no live table: leave the counter alone
  END IF;

  SELECT count(*) INTO v_seats
    FROM public.table_seats
   WHERE table_id = v_table AND left_at IS NULL;

  UPDATE public.tables      SET current_players = v_seats WHERE id = v_table;
  UPDATE public.tournaments SET current_players = v_seats WHERE id = p_tournament_id;

  RETURN v_seats;
END;
$function$;

-- ── Vacate every seat on a table and hand it back empty ──────────────────────
CREATE OR REPLACE FUNCTION public.fn_clear_table_seats(p_table_id uuid, p_reopen boolean DEFAULT false)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_cleared integer := 0;
BEGIN
  UPDATE public.table_seats
     SET left_at = now(), is_sitting_out = false
   WHERE table_id = p_table_id AND left_at IS NULL;
  GET DIAGNOSTICS v_cleared = ROW_COUNT;

  UPDATE public.tables
     SET current_players = 0,
         status = CASE WHEN p_reopen AND status <> 'closed' THEN 'waiting' ELSE status END
   WHERE id = p_table_id;

  RETURN v_cleared;
END;
$function$;

-- ── A busted player leaves the moment they are out ───────────────────────────
CREATE OR REPLACE FUNCTION public.fn_bust_player_from_table(p_table_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_tournament uuid;
  v_gone       integer := 0;
BEGIN
  SELECT tournament_id INTO v_tournament FROM public.tables WHERE id = p_table_id;

  UPDATE public.table_seats
     SET left_at = now(), is_sitting_out = false
   WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL;
  GET DIAGNOSTICS v_gone = ROW_COUNT;

  IF v_tournament IS NOT NULL THEN
    UPDATE public.tournament_players
       SET status = 'eliminated', table_id = NULL, seat_number = NULL
     WHERE tournament_id = v_tournament AND user_id = p_user_id
       AND status <> 'eliminated';
    PERFORM public.fn_sync_seat_first_player_count(v_tournament);
  END IF;

  RETURN jsonb_build_object('ok', true, 'seats_released', v_gone);
END;
$function$;

-- ── A finished game keeps no seats ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_clear_seats_on_game_end()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_table uuid;
BEGIN
  IF NEW.status IN ('COMPLETED', 'CANCELLED')
     AND COALESCE(OLD.status, '') IS DISTINCT FROM NEW.status THEN
    FOR v_table IN
      SELECT id FROM public.tables WHERE tournament_id = NEW.id
    LOOP
      -- Never reopen a table whose game is over: the recycler builds the next
      -- spin its own fresh table. What must not survive is the seat rows.
      PERFORM public.fn_clear_table_seats(v_table, false);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_clear_seats_on_game_end ON public.tournaments;
CREATE TRIGGER trg_clear_seats_on_game_end
  AFTER UPDATE OF status ON public.tournaments
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_clear_seats_on_game_end();

GRANT EXECUTE ON FUNCTION public.fn_sync_seat_first_player_count(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_clear_table_seats(uuid, boolean)   TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_bust_player_from_table(uuid, uuid) TO service_role;
