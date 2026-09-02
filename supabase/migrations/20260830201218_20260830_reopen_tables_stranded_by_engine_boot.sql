-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830201218; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- =====================================================================
-- THIRD REPAIR: fields stranded by an ENGINE BOOT
-- =====================================================================
-- Isolated cleanly at 20:00 UTC: a controlled `docker restart
-- club-arena-engine` reproduced the damage exactly. 50 live-tournament closes
-- landed at 20:02-20:03 (the boot window) and NOTHING in the seven minutes
-- either side. Every one of the resulting ghost seats is truly stranded - the
-- player has no other live seat in the same tournament - so this is players
-- being lost, not seat rows leaking behind a completed move.
--
-- That makes the boot sequence, not the 300-storm, the remaining cause. The
-- storm made it fire constantly (the engine was self-exiting every ~10 minutes
-- because leadership claims were unanswerable); with the storm gone it now
-- fires once per deploy, and this repo deploys the engine on every push
-- touching server/**. The boot path itself is NOT fixed by this migration and
-- is written up for Dan - the closes are not logged by the engine, so finding
-- the exact statement needs a longer look than an incident window allows.
--
-- Same safety properties as the first two repairs. closed -> running only for
-- tables whose tournament is still RUNNING and which still hold an open seat.
-- No seat, chip or wallet is touched.
--
-- ROLLBACK:
--   UPDATE public.tables SET status = 'closed'
--    WHERE id = ANY(SELECT table_id FROM public.zz_reopen3_20260830_backup);
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.zz_reopen3_20260830_backup (
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
INSERT INTO public.zz_reopen3_20260830_backup (table_id, tournament_id, old_status, open_seats)
SELECT id, tournament_id, status, open_seats FROM target
ON CONFLICT (table_id) DO NOTHING;

DO $$
DECLARE v_tables int; v_seats int; v_recent int;
BEGIN
    SELECT count(*) INTO v_recent FROM public.engine_recovery_events
     WHERE event = 'table_closed_under_live_tournament'
       AND created_at > now() - interval '4 minutes';
    IF v_recent > 0 THEN
        RAISE EXCEPTION 'Refusing: % close(s) in the last 4 minutes - a boot is in progress, wait for it to finish.', v_recent;
    END IF;

    SELECT count(*), coalesce(sum(open_seats),0) INTO v_tables, v_seats
      FROM public.zz_reopen3_20260830_backup;
    IF v_tables = 0 THEN RAISE EXCEPTION 'Nothing to repair.'; END IF;
    IF v_tables > 300 THEN
        RAISE EXCEPTION 'Refusing: % tables is beyond the measured damage.', v_tables;
    END IF;
    RAISE NOTICE 'Reopening % tables carrying % open seats.', v_tables, v_seats;
END $$;

UPDATE public.tables t
   SET status = 'running',
       current_players = b.open_seats
  FROM public.zz_reopen3_20260830_backup b
 WHERE t.id = b.table_id
   AND t.status = 'closed';

DO $$
DECLARE v_bad int; v_seats int;
BEGIN
    SELECT count(*) INTO v_bad
      FROM public.tables t JOIN public.zz_reopen3_20260830_backup b ON b.table_id = t.id
     WHERE t.status <> 'running';
    IF v_bad > 0 THEN RAISE EXCEPTION 'Post-apply: % target tables are not running.', v_bad; END IF;

    SELECT count(*) INTO v_seats
      FROM public.table_seats s JOIN public.zz_reopen3_20260830_backup b ON b.table_id = s.table_id
     WHERE s.left_at IS NULL;
    IF v_seats < (SELECT coalesce(sum(open_seats),0) FROM public.zz_reopen3_20260830_backup) THEN
        RAISE EXCEPTION 'Post-apply: seats were released during reopen (% remain).', v_seats;
    END IF;
    RAISE NOTICE 'Repair verified: all target tables running, % seats intact.', v_seats;
END $$;
