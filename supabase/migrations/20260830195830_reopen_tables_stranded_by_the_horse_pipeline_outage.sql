-- =====================================================================
-- SECOND REPAIR: tables stranded by the 300-storm outage
-- =====================================================================
-- Applied to production 2026-08-30 19:58 UTC via Supabase apply_migration.
--
-- The legacy World Hub horse pipeline (GameController._runHorsePipeline) was
-- hammering club_members with an ambiguous `profiles!inner` embed - 9,000 to
-- 14,000 requests a minute, every one an HTTP 300 - which saturated PostgREST
-- until Cloudflare returned 520/521/522/525 for the origin. The Hetzner
-- engine's leadership claims then went unanswerable, so it repeatedly
-- self-exited ("exiting so the supervisor restarts it as a real leader") and
-- every boot closed live tournament tables underneath their seated fields.
--
-- The writer is retired in World Hub PR #1033 (merged 19:52 UTC).
--
-- Reopens closed -> running ONLY for tables whose tournament is still RUNNING
-- and which still hold an open seat. No seat, chip or wallet is touched.
-- Result: 47 tables, 266 seats restored.
--
-- ROLLBACK:
--   UPDATE public.tables SET status = 'closed'
--    WHERE id = ANY(SELECT table_id FROM public.zz_reopen2_20260830_backup);
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.zz_reopen2_20260830_backup (
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
INSERT INTO public.zz_reopen2_20260830_backup (table_id, tournament_id, old_status, open_seats)
SELECT id, tournament_id, status, open_seats FROM target
ON CONFLICT (table_id) DO NOTHING;

-- Refuse if the closer is still active: repairing mid-storm feeds the shredder.
DO $$
DECLARE v_tables int; v_seats int; v_recent_closes int;
BEGIN
    SELECT count(*) INTO v_recent_closes FROM public.engine_recovery_events
     WHERE event = 'table_closed_under_live_tournament'
       AND created_at > now() - interval '5 minutes';
    IF v_recent_closes > 0 THEN
        RAISE EXCEPTION 'Refusing: % live-tournament close(s) in the last 5 minutes.', v_recent_closes;
    END IF;
    SELECT count(*), coalesce(sum(open_seats),0) INTO v_tables, v_seats
      FROM public.zz_reopen2_20260830_backup;
    IF v_tables = 0 THEN RAISE EXCEPTION 'Nothing to repair.'; END IF;
    IF v_tables > 300 THEN RAISE EXCEPTION 'Refusing: % tables beyond measured damage.', v_tables; END IF;
    RAISE NOTICE 'Reopening % tables carrying % open seats.', v_tables, v_seats;
END $$;

UPDATE public.tables t
   SET status = 'running', current_players = b.open_seats
  FROM public.zz_reopen2_20260830_backup b
 WHERE t.id = b.table_id AND t.status = 'closed';

DO $$
DECLARE v_bad int; v_seats int;
BEGIN
    SELECT count(*) INTO v_bad FROM public.tables t
      JOIN public.zz_reopen2_20260830_backup b ON b.table_id = t.id
     WHERE t.status <> 'running';
    IF v_bad > 0 THEN RAISE EXCEPTION 'Post-apply: % target tables not running.', v_bad; END IF;
    SELECT count(*) INTO v_seats FROM public.table_seats s
      JOIN public.zz_reopen2_20260830_backup b ON b.table_id = s.table_id
     WHERE s.left_at IS NULL;
    IF v_seats < (SELECT coalesce(sum(open_seats),0) FROM public.zz_reopen2_20260830_backup) THEN
        RAISE EXCEPTION 'Post-apply: seats released during reopen (% remain).', v_seats;
    END IF;
    RAISE NOTICE 'Repair verified: % seats intact.', v_seats;
END $$;
