-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821154426 "retire_duplicate_table_waitlists"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e5a3356e77b013ab6e7a1981e5bd42d6 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
--  ONE WAITLIST TABLE  (Tier 3: DROP -- rollback at the bottom)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- There were two: `table_waitlist` (singular) and `table_waitlists` (plural),
-- same meaning, and the readers were split across them.
--
--   singular : World Hub /api/club-arena/waitlist, TableService,
--              WaitlistManager, WaitlistPage, GlobalWaitlistListener
--   plural   : WaitlistService (the table-page join/leave flow) AND
--              server/src/services/supabase/seats.ts (the ENGINE's
--              notifyWaitlistSeatOpen, which offers the seat)
--
-- So a player joining from the table modal landed in one queue while the
-- engine watched the other. The seat-offer path was reading a table nothing
-- ever wrote. The feature could not have worked end to end, which matches the
-- evidence: both tables held zero rows, all-time.
--
-- The clients and the engine now all use the singular. This drops the orphan
-- so a future reader cannot pick the wrong one again.
--
-- Safe because it is empty: asserted below rather than assumed, since a DROP
-- that silently discarded a real queue would be unrecoverable.
DO $do$
DECLARE v_n int;
BEGIN
  IF to_regclass('public.table_waitlists') IS NULL THEN
    RAISE NOTICE 'table_waitlists already gone; nothing to do';
    RETURN;
  END IF;
  EXECUTE 'SELECT count(*) FROM public.table_waitlists' INTO v_n;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'ABORT: table_waitlists holds % row(s). Migrate them into table_waitlist before dropping.', v_n;
  END IF;
END $do$;

DROP TABLE IF EXISTS public.table_waitlists;

-- `position` on the survivor is now vestigial. It is NOT NULL DEFAULT 1 and
-- every reader (the engine's notifier, WaitlistService, WaitlistManager)
-- orders by created_at instead. It was previously written client-side as
-- `waitlist.length + 1`, which collided when two players joined at once and
-- never renumbered when somebody left. Kept rather than dropped so the column
-- can be removed in its own migration once nothing selects it.
COMMENT ON COLUMN public.table_waitlist.position IS
  'VESTIGIAL. Queue order is created_at, everywhere. Kept only so existing '
  'SELECTs do not break; do not write a meaningful value here.';

COMMENT ON TABLE public.table_waitlist IS
  'Canonical cash-table waitlist. FIFO by created_at. Replaced the duplicate '
  'public.table_waitlists on 2026-08-21.';

-- ═══════════════════════════════════════════════════════════════════════════
--  ROLLBACK
-- ═══════════════════════════════════════════════════════════════════════════
--   CREATE TABLE public.table_waitlists (
--     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
--     table_id uuid NOT NULL,
--     user_id uuid NOT NULL,
--     created_at timestamptz DEFAULT now(),
--     notified_at timestamptz,
--     status text
--   );
--   ALTER TABLE public.table_waitlists ENABLE ROW LEVEL SECURITY;
--   -- then revert the table name in src/services/WaitlistService.ts and
--   -- server/src/services/supabase/seats.ts.
-- It held no data, so nothing needs restoring.
