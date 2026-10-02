-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260820121527 as "union_law_seat_provenance_self_healing"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--

-- ============================================================================
-- UNION LAW — SEAT PROVENANCE SELF-HEALING (2026-08-20)
--
-- A small number of tournament seats still arrived unstamped. Cause: the seat
-- and its table are written in the same batch, so at INSERT time the table row
-- (and therefore its union stamp) is not yet visible to the resolver, which
-- returns NULL and leaves club_id empty.
--
-- Two guards, so provenance always converges:
--   1. The stamp trigger also runs on UPDATE while club_id is still NULL, so
--      the next touch of the row fills it in.
--   2. A 5-minute healer stamps any active seat still missing a club. Cheap:
--      the partial index means it only ever scans unstamped live seats.
--
-- Impact of the gap was limited to tournament seats, which do not drive cash
-- rake attribution (tournament rake is the entry fee, attributed at
-- registration), but provenance should be complete regardless.
-- ============================================================================

DROP TRIGGER IF EXISTS trg_table_seats_stamp_club ON public.table_seats;
CREATE TRIGGER trg_table_seats_stamp_club
  BEFORE INSERT OR UPDATE ON public.table_seats
  FOR EACH ROW
  WHEN (NEW.club_id IS NULL)
  EXECUTE FUNCTION public.fn_stamp_seat_club();

CREATE INDEX IF NOT EXISTS idx_table_seats_unstamped_active
  ON public.table_seats (table_id)
  WHERE left_at IS NULL AND club_id IS NULL;

CREATE OR REPLACE FUNCTION public.fn_heal_seat_provenance()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_n integer;
BEGIN
  UPDATE table_seats ts
     SET club_id = public.fn_seat_club_for_user(ts.user_id, ts.table_id, NULL)
   WHERE ts.left_at IS NULL
     AND ts.club_id IS NULL
     AND ts.user_id IS NOT NULL
     AND public.fn_seat_club_for_user(ts.user_id, ts.table_id, NULL) IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $function$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'union-seat-provenance-heal') THEN
    PERFORM cron.unschedule('union-seat-provenance-heal');
  END IF;
  PERFORM cron.schedule('union-seat-provenance-heal', '*/5 * * * *',
                        'SELECT public.fn_heal_seat_provenance();');
END $$;

SELECT public.fn_heal_seat_provenance();

