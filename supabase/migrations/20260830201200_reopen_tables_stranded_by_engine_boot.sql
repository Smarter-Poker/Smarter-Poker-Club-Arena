-- =====================================================================
-- THIRD REPAIR: fields stranded by an ENGINE BOOT
-- =====================================================================
-- Applied to production 2026-08-30 20:12 UTC via Supabase apply_migration.
--
-- Isolated cleanly: a controlled `docker restart club-arena-engine` at 20:00
-- UTC reproduced the damage exactly. 50 live-tournament closes landed at
-- 20:02-20:03 (the boot window) and NOTHING in the seven minutes either side.
-- Every resulting ghost seat was truly stranded - the player had no other live
-- seat in the same tournament - so this is players being LOST, not seat rows
-- leaking behind a completed table-break move.
--
-- THE BOOT PATH IS NOT FIXED BY THIS MIGRATION. This only puts the surviving
-- fields back. See docs/changelog/2026-08-30-ghost-seats-froze-every-live-
-- tournament.md, "Still open for Dan". The 300-storm made this fire every ~10
-- minutes (the engine was self-exiting because leadership claims were
-- unanswerable); with the storm gone it fires once per deploy, and this repo
-- deploys the engine on every push touching server/**.
--
-- Result: 12 tables, restoring the last of the stranded fields.
--
-- ROLLBACK:
--   UPDATE public.tables SET status = 'closed'
--    WHERE id = ANY(SELECT table_id FROM public.zz_reopen3_20260830_backup);
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.zz_reopen3_20260830_backup (
    table_id uuid PRIMARY KEY, tournament_id uuid, old_status text,
    open_seats integer, captured_at timestamptz NOT NULL DEFAULT now()
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

-- A boot in progress is exactly when NOT to repair.
DO $$
DECLARE v_tables int; v_seats int; v_recent int;
BEGIN
    SELECT count(*) INTO v_recent FROM public.engine_recovery_events
     WHERE event = 'table_closed_under_live_tournament'
       AND created_at > now() - interval '4 minutes';
    IF v_recent > 0 THEN
        RAISE EXCEPTION 'Refusing: % close(s) in the last 4 minutes - a boot is in progress.', v_recent;
    END IF;
    SELECT count(*), coalesce(sum(open_seats),0) INTO v_tables, v_seats
      FROM public.zz_reopen3_20260830_backup;
    IF v_tables = 0 THEN RAISE EXCEPTION 'Nothing to repair.'; END IF;
    IF v_tables > 300 THEN RAISE EXCEPTION 'Refusing: % tables beyond measured damage.', v_tables; END IF;
    RAISE NOTICE 'Reopening % tables carrying % open seats.', v_tables, v_seats;
END $$;

UPDATE public.tables t
   SET status = 'running', current_players = b.open_seats
  FROM public.zz_reopen3_20260830_backup b
 WHERE t.id = b.table_id AND t.status = 'closed';

DO $$
DECLARE v_bad int; v_seats int;
BEGIN
    SELECT count(*) INTO v_bad FROM public.tables t
      JOIN public.zz_reopen3_20260830_backup b ON b.table_id = t.id
     WHERE t.status <> 'running';
    IF v_bad > 0 THEN RAISE EXCEPTION 'Post-apply: % target tables not running.', v_bad; END IF;
    SELECT count(*) INTO v_seats FROM public.table_seats s
      JOIN public.zz_reopen3_20260830_backup b ON b.table_id = s.table_id
     WHERE s.left_at IS NULL;
    IF v_seats < (SELECT coalesce(sum(open_seats),0) FROM public.zz_reopen3_20260830_backup) THEN
        RAISE EXCEPTION 'Post-apply: seats released during reopen (% remain).', v_seats;
    END IF;
    RAISE NOTICE 'Repair verified: % seats intact.', v_seats;
END $$;
