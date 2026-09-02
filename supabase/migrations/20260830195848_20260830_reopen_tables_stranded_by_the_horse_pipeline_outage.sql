-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830195848; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- =====================================================================
-- SECOND REPAIR: tables stranded by the 300-storm outage
-- =====================================================================
-- Same shape as 20260830191130, different cause. The legacy World Hub horse
-- pipeline (GameController._runHorsePipeline) was hammering club_members with
-- an ambiguous `profiles!inner` embed - 9,000-14,000 requests a minute, every
-- one an HTTP 300 - which saturated PostgREST until Cloudflare returned 520s
-- for the origin. The Hetzner engine's leadership claims then went
-- unanswerable, so it repeatedly self-exited ("exiting so the supervisor
-- restarts it as a real leader") and every boot closed live tournament tables
-- underneath their seated fields.
--
-- The writer is retired in World Hub PR #1033 (merged 19:52 UTC) and the storm
-- has stopped; `table_closed_under_live_tournament` has logged nothing for
-- eight minutes. This puts the surviving fields back on live felt.
--
-- Identical safety properties to the first repair: closed -> running only for
-- tables whose tournament is still RUNNING and which still hold an open seat.
-- No seat, chip or wallet is touched. fn_on_table_status_change releases seats
-- only on transitions INTO a terminal status, never out of one.
--
-- ROLLBACK:
--   UPDATE public.tables SET status = 'closed'
--    WHERE id = ANY(SELECT table_id FROM public.zz_reopen2_20260830_backup);
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.zz_reopen2_20260830_backup (
    table_id      uuid PRIMARY KEY,
    tournament_id uuid,
    old_status    text,
    open_seats    integer,
    captured_at   timestamptz NOT NULL DEFAULT now()
);

WITH target AS (
    SELECT t.id, t.tournament_id, t.status,
           (SELECT count(*) FROM public.table_seats s
             WHERE s.table_id = t.id AND s.left_at IS NULL)::int AS open_seats
      FROM public.tables t
      JOIN public.tournaments tn ON tn.id = t.tournament_id
     WHERE t.status = 'closed'
       AND upper(coalesce(tn.status,'')) = 'RUNNING'
       AND COALESCE(t.is_deleted, false) = false
       AND EXISTS (SELECT 1 FROM public.table_seats s
                    WHERE s.table_id = t.id AND s.left_at IS NULL)
)
INSERT INTO public.zz_reopen2_20260830_backup (table_id, tournament_id, old_status, open_seats)
SELECT id, tournament_id, status, open_seats FROM target
ON CONFLICT (table_id) DO NOTHING;

-- Pre-flight. Refuse if the writer is evidently still running: a repair made
-- while tables are still being closed just feeds the shredder.
DO $$
DECLARE v_tables int; v_seats int; v_recent_closes int;
BEGIN
    SELECT count(*) INTO v_recent_closes
      FROM public.engine_recovery_events
     WHERE event = 'table_closed_under_live_tournament'
       AND created_at > now() - interval '5 minutes';
    IF v_recent_closes > 0 THEN
        RAISE EXCEPTION 'Refusing: % live-tournament close(s) in the last 5 minutes - the closer is still active.', v_recent_closes;
    END IF;

    SELECT count(*), coalesce(sum(open_seats),0) INTO v_tables, v_seats
      FROM public.zz_reopen2_20260830_backup;
    IF v_tables = 0 THEN
        RAISE EXCEPTION 'Nothing to repair.';
    END IF;
    IF v_tables > 300 THEN
        RAISE EXCEPTION 'Refusing: % tables is beyond the measured damage - re-measure first.', v_tables;
    END IF;
    RAISE NOTICE 'Reopening % tables carrying % open seats.', v_tables, v_seats;
END $$;

UPDATE public.tables t
   SET status = 'running',
       current_players = b.open_seats
  FROM public.zz_reopen2_20260830_backup b
 WHERE t.id = b.table_id
   AND t.status = 'closed';

DO $$
DECLARE v_still_closed int; v_open_seats int;
BEGIN
    SELECT count(*) INTO v_still_closed
      FROM public.tables t JOIN public.zz_reopen2_20260830_backup b ON b.table_id = t.id
     WHERE t.status <> 'running';
    IF v_still_closed > 0 THEN
        RAISE EXCEPTION 'Post-apply: % target tables are not running.', v_still_closed;
    END IF;

    SELECT count(*) INTO v_open_seats
      FROM public.table_seats s JOIN public.zz_reopen2_20260830_backup b ON b.table_id = s.table_id
     WHERE s.left_at IS NULL;
    IF v_open_seats < (SELECT coalesce(sum(open_seats),0) FROM public.zz_reopen2_20260830_backup) THEN
        RAISE EXCEPTION 'Post-apply: seats were released during reopen (% remain).', v_open_seats;
    END IF;
    RAISE NOTICE 'Repair verified: all target tables running, % seats intact.', v_open_seats;
END $$;
