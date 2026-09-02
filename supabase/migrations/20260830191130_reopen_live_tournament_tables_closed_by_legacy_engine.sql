-- =====================================================================
-- REOPEN LIVE TOURNAMENT TABLES WRONGLY CLOSED BY THE RETIRED LEGACY ENGINE
-- =====================================================================
-- Applied to production 2026-08-30 19:11 UTC via Supabase apply_migration.
--
-- The World Hub legacy GameController (_cleanupStaleTables) closed every
-- claimed tournament table on a timer. Commit 15297cf95f stopped the writer,
-- but the damage was never undone: 71 tables belonging to 19 RUNNING
-- tournaments were left status='closed' with their fields still seated
-- (411 seats, ~4.6M tournament chips). fn_on_table_status_change's live
-- tournament guard is why those seats survived.
--
-- Effect of the damage: the Hetzner engine discovers tables via
-- status IN ('waiting','running'), so it found ZERO tables, dealt ~0 hands
-- (down from 7,455/hour), and every horse stayed pinned at the four-table
-- limit by a dead seat (10,738 "FOUR TABLE LIMIT" rejections in two hours).
-- MTTs did not display, "Enter Table" opened nothing, and the retry storm
-- helped saturate PostgREST into the "Could Not Load Your Clubs" failure.
--
-- This migration ONLY moves closed -> running for tables whose tournament is
-- still RUNNING and which still hold at least one open seat. It touches no
-- seats, no chips, and no wallet. Reopening is safe: fn_on_table_status_change
-- releases seats only on transitions INTO a terminal status, never out of one,
-- and trg_tables_auto_cashout_on_close fires only on the way to closed.
--
-- ROLLBACK:
--   UPDATE public.tables SET status = 'closed'
--    WHERE id = ANY(SELECT table_id FROM public.zz_reopen_20260830_backup);
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.zz_reopen_20260830_backup (
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
INSERT INTO public.zz_reopen_20260830_backup (table_id, tournament_id, old_status, open_seats)
SELECT id, tournament_id, status, open_seats FROM target
ON CONFLICT (table_id) DO NOTHING;

DO $$
DECLARE v_tables int; v_seats int;
BEGIN
    SELECT count(*), coalesce(sum(open_seats),0) INTO v_tables, v_seats
      FROM public.zz_reopen_20260830_backup;
    IF v_tables = 0 THEN
        RAISE EXCEPTION 'Nothing to repair: no closed tables under RUNNING tournaments with open seats.';
    END IF;
    IF v_tables > 200 THEN
        RAISE EXCEPTION 'Refusing: % tables is far beyond the measured 71 - re-measure before running.', v_tables;
    END IF;
    IF v_seats = 0 THEN
        RAISE EXCEPTION 'Refusing: target tables hold no open seats; this is not the ghost-seat repair.';
    END IF;
    RAISE NOTICE 'Reopening % tables carrying % open seats.', v_tables, v_seats;
END $$;

UPDATE public.tables t
   SET status = 'running',
       current_players = b.open_seats
  FROM public.zz_reopen_20260830_backup b
 WHERE t.id = b.table_id
   AND t.status = 'closed';

DO $$
DECLARE v_still_closed int; v_open_seats int;
BEGIN
    SELECT count(*) INTO v_still_closed
      FROM public.tables t JOIN public.zz_reopen_20260830_backup b ON b.table_id = t.id
     WHERE t.status <> 'running';
    IF v_still_closed > 0 THEN
        RAISE EXCEPTION 'Post-apply: % target tables are not running (revival blocked?).', v_still_closed;
    END IF;

    SELECT count(*) INTO v_open_seats
      FROM public.table_seats s JOIN public.zz_reopen_20260830_backup b ON b.table_id = s.table_id
     WHERE s.left_at IS NULL;
    IF v_open_seats < (SELECT coalesce(sum(open_seats),0) FROM public.zz_reopen_20260830_backup) THEN
        RAISE EXCEPTION 'Post-apply: seats were released during reopen (% remain).', v_open_seats;
    END IF;
    RAISE NOTICE 'Repair verified: all target tables running, % seats intact.', v_open_seats;
END $$;
