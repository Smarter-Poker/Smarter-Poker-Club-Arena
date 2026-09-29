-- A COUNT THAT HAS NOT CHANGED IS NOT A WRITE (2026-09-29)
--
-- What was wrong, measured on production 2026-09-29 04:04-04:12 UTC
-- ---------------------------------------------------------------------
-- public.clubs was the most contended tuple behind Lock/transactionid in the
-- hand projection: sampling pg_stat_activity and pg_locks, clubs page 46 tuple
-- 4 appeared in 117 observations, page 48 tuple 1 in 74, page 35 tuple 2 in 42.
-- It had taken 128,715 UPDATEs against ten live rows in eleven hours of uptime,
-- leaving 95 percent dead tuples in 756 pages.
--
-- 20260929035649 removed one writer, the per-hand rake total. It was not the
-- big one. After it shipped, clubs was still being written about three times a
-- second, and pg_stat_statements could not say by what, because the writer is
-- not a top-level statement: it is this trigger.
--
-- fn_sync_club_table_counts fires AFTER INSERT, AFTER DELETE, and AFTER UPDATE
-- OF (status, is_deleted, club_id, union_id, tournament_id) on public.tables,
-- and recomputes a denormalised table_count onto the club row. The engine
-- cycles every live table between 'waiting' and 'running' continuously, and
-- each of those transitions fires it. But fn_live_table_count counts
--
--     status NOT IN ('closed', 'deleted')
--
-- so 'waiting' and 'running' both count, and the total does not move. The
-- UPDATE was assigning the value the row already held. Measured at 04:10 UTC,
-- every one of the five clubs had table_count exactly equal to a fresh
-- fn_live_table_count, so every one of those writes was a no-op. The table
-- population says the same thing: 328,237 rows are 'closed' and only about 765
-- are 'waiting' or 'running', so the count only really moves when a table is
-- created, closed or moved - which is rare - while the status cycle that fires
-- the trigger is constant.
--
-- Why a no-op UPDATE is expensive here
-- ---------------------------------------------------------------------
-- It writes a new version of the club settings row; it runs the fifteen
-- triggers that fire on a clubs UPDATE (every lifecycle and treasury guard,
-- the settings audit, the autoledger and four management event emitters); and
-- it takes an exclusive lock on that single row which is held until the
-- writing transaction commits. The engine changes table status inside the hand
-- loop, so that lock was held for the rest of the hand, and every other hand in
-- the club queued behind it. On a union table the same thing happened to the
-- union row as well.
--
-- The fix is the smallest one that removes the write: compute the count as
-- before, and only store it when it differs. The recount stays - it is an index
-- scan on idx_tables_live_by_union, about 255 buffers and 11 ms, and it takes
-- no lock on clubs. The column still ends every call holding exactly
-- fn_live_table_count(id), so no reader can tell the difference.
--
-- Nothing is backfilled and nothing is repaired (CLAUDE.md 10.12): the stored
-- counts are already correct, which is the whole point.
--
-- This is the law the table_seats no-op suppressor established on 2026-09-03:
-- an UPDATE writing the values a row already holds still costs a row version,
-- WAL and a lock, and no reader learns anything from it.

BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '0';

CREATE OR REPLACE FUNCTION public.fn_sync_club_table_counts()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_clubs uuid[];
  v_unions uuid[];
BEGIN
  -- Both sides, so a table MOVING between clubs or unions fixes the club it
  -- left as well as the one it joined.
  v_clubs := array_remove(ARRAY[
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.club_id END,
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.club_id END
  ], NULL);
  v_unions := array_remove(ARRAY[
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.union_id END,
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.union_id END
  ], NULL);

  -- A COUNT THAT HAS NOT CHANGED IS NOT A WRITE (2026-09-29).
  -- This fires on every status change of every table, and the engine cycles a
  -- live table between 'waiting' and 'running' all day. fn_live_table_count
  -- counts tables whose status is NOT IN ('closed','deleted'), so both of those
  -- statuses count and the total does not move: the UPDATE assigned the value
  -- the row already held. Measured 2026-09-29 04:10 UTC, all five clubs had
  -- stored = recomputed, so every one of those writes was a no-op, and there
  -- were 128,715 of them against ten live rows in eleven hours.
  -- A no-op UPDATE is not free. It writes a new version of the club settings
  -- row, runs the fifteen triggers that fire on clubs UPDATE - every lifecycle
  -- and treasury guard, the settings audit, the autoledger, four management
  -- event emitters - and takes an exclusive lock on that one row which is held
  -- until the writing transaction commits. The engine changes table status
  -- inside the hand loop, so that lock was held across the rest of the hand,
  -- and public.clubs was the most contended tuple behind Lock/transactionid.
  -- The recount itself stays: it is an index scan of ~255 buffers and it takes
  -- no lock on clubs. Only the write is conditional, and the column still ends
  -- every call holding exactly fn_live_table_count(id).
  -- Same law as the table_seats no-op suppressor shipped 2026-09-03.
  IF cardinality(v_clubs) > 0 THEN
    UPDATE clubs c
       SET table_count = v.n
      FROM (SELECT t.id, fn_live_table_count(t.id) AS n
              FROM clubs t WHERE t.id = ANY(v_clubs)) v
     WHERE c.id = v.id
       AND c.table_count IS DISTINCT FROM v.n;
  END IF;

  -- Every club that can see a touched union's tables (members + the union row).
  IF cardinality(v_unions) > 0 THEN
    UPDATE clubs c
       SET table_count = v.n
      FROM (SELECT t.id, fn_live_table_count(t.id) AS n
              FROM clubs t
             WHERE t.id = ANY(v_unions)
                OR t.id IN (SELECT club_id FROM union_clubs WHERE union_id = ANY(v_unions))) v
     WHERE c.id = v.id
       AND c.table_count IS DISTINCT FROM v.n;
  END IF;

  RETURN NULL;
END $function$;

REVOKE ALL ON FUNCTION public.fn_sync_club_table_counts() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_sync_club_table_counts() FROM anon;
REVOKE ALL ON FUNCTION public.fn_sync_club_table_counts() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sync_club_table_counts() TO service_role;

DO $counts_postimage$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_sync_club_table_counts()'::regprocedure
       AND md5(p.prosrc) = 'd72fbf737dbfdc0916293447880a424c'
       AND p.prosecdef
       AND p.proconfig = ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'CLUB_TABLE_COUNT_POSTIMAGE_DRIFT: fn_sync_club_table_counts';
  END IF;
  -- The guard is the point: without it this is a per-status-change write.
  IF (SELECT count(*) FROM regexp_matches(
        (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.fn_sync_club_table_counts()'::regprocedure),
        'table_count IS DISTINCT FROM', 'g')) <> 2 THEN
    RAISE EXCEPTION 'CLUB_TABLE_COUNT_WRITES_UNCONDITIONALLY: fn_sync_club_table_counts';
  END IF;
  -- All three triggers must still be bound to it, or the count stops tracking.
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgfoid = 'public.fn_sync_club_table_counts()'::regprocedure AND NOT t.tgisinternal) <> 3 THEN
    RAISE EXCEPTION 'CLUB_TABLE_COUNT_TRIGGERS_MISSING: fn_sync_club_table_counts';
  END IF;
END
$counts_postimage$;

COMMIT;
