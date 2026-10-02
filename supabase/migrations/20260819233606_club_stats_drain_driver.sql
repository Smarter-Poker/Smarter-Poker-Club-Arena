-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819233606 "club_stats_drain_driver"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 cf24103579e931448f4ebc3cf77a1bfc of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Time-boxed drain used by the scheduled maintenance job.
--
-- Walks tables that are not yet complete, newest activity first (the default
-- Time Range is "week", so that is what the dashboard reads), chunking each
-- one until either it finishes or the time budget runs out. Because
-- ca_rebuild_table_chunk is resumable, stopping mid-table is safe — the next
-- run picks up from the stored cursor.
--
-- Validated: driving a table in 90-hand chunks produced results byte-identical
-- to the single-statement rebuild (0 differing rows either direction, same
-- profit 2250.0000, same hands_attributed 1301).
DROP TABLE IF EXISTS public._ca_chunk_baseline;

CREATE OR REPLACE FUNCTION public.ca_drain_club_rebuild(
  p_club_id     uuid,
  p_max_seconds integer DEFAULT 120,
  p_chunk       integer DEFAULT 3000,
  p_since       timestamptz DEFAULT now() - interval '90 days'
)
RETURNS TABLE (tables_touched integer, tables_completed integer, hands_processed bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '600s'
AS $fn$
DECLARE
  v_deadline timestamptz := clock_timestamp() + make_interval(secs => greatest(coalesce(p_max_seconds, 120), 5));
  r          record;
  c          record;
  v_touched  integer := 0;
  v_done     integer := 0;
  v_hands    bigint  := 0;
BEGIN
  FOR r IN
    SELECT t.id
    FROM tables t
    JOIN LATERAL (
      SELECT max(hh.created_at) AS last_hand
      FROM hand_history hh
      WHERE hh.table_id = t.id AND hh.created_at >= p_since
    ) lh ON lh.last_hand IS NOT NULL
    LEFT JOIN club_stats_rebuild_log l ON l.table_id = t.id
    WHERE t.club_id = p_club_id
      AND coalesce(l.complete, false) = false
    ORDER BY lh.last_hand DESC
  LOOP
    EXIT WHEN clock_timestamp() >= v_deadline;
    v_touched := v_touched + 1;
    LOOP
      EXIT WHEN clock_timestamp() >= v_deadline;
      BEGIN
        SELECT * INTO c FROM ca_rebuild_table_chunk(r.id, p_chunk);
      EXCEPTION WHEN OTHERS THEN
        -- Never let one bad table stall the drain; it keeps its cursor and
        -- will be retried on the next run.
        RAISE WARNING 'chunk failed for table %: %', r.id, SQLERRM;
        EXIT;
      END;
      v_hands := v_hands + coalesce(c.hands_processed, 0);
      IF c.complete THEN
        v_done := v_done + 1;
        EXIT;
      END IF;
    END LOOP;
  END LOOP;

  tables_touched := v_touched;
  tables_completed := v_done;
  hands_processed := v_hands;
  RETURN NEXT;
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_drain_club_rebuild(uuid, integer, integer, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_drain_club_rebuild(uuid, integer, integer, timestamptz) TO service_role;
