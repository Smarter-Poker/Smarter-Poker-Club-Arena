-- ═══════════════════════════════════════════════════════════════════════════
--  ONE lower() COST A SEQUENTIAL SCAN OF 64,670 ROWS, EVERY CALL
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The first working cut of the cash list inside get_club_home was written
--
--     (status IS NULL OR lower(status) NOT IN ('closed','deleted'))
--
-- which is correct and unusable. public.tables carries three partial indexes
-- built for exactly this list --
--
--     idx_tables_platform_open, idx_tables_live_by_union, idx_tables_live_by_club
--
-- and every one of their predicates says `status <> ALL (ARRAY['closed',
-- 'deleted'])`. Postgres cannot prove that a call to lower() implies it, so
-- none of them applied:
--
--     Seq Scan on tables ... Rows Removed by Filter: 64626   -> 593 ms
--
-- to return 44 rows. Written the way the client writes it -- and the client is
-- the reason those rows are lowercase in the first place --
--
--     Index Scan using idx_tables_platform_open ...          -> 4.8 ms
--
-- 593 ms to 4.8 ms for the identical 44 rows. NULL status is excluded either
-- way, exactly as PostgREST's `not.in` excludes it, so the fast paint and the
-- authoritative query still return the same list.
--
-- APPLIED TO PRODUCTION 2026-08-23 via the Supabase MCP. The settled function
-- body lives in 20260823280000_get_club_home_was_never_run.sql, which already
-- carries this form and asserts against the regression; this file records the
-- measurement and re-checks it, so a replay of the history is verified at the
-- point the change was actually made.
-- ═══════════════════════════════════════════════════════════════════════════

DO $check$
DECLARE def text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO def FROM pg_proc WHERE proname = 'get_club_home';
  IF def IS NULL THEN
    RAISE EXCEPTION 'get_club_home is missing - apply 20260823280000 first';
  END IF;
  IF def LIKE '%lower(status)%' THEN
    RAISE EXCEPTION 'the cash list is back on lower(status): a 64k-row seq scan on every lobby paint';
  END IF;
  IF def NOT LIKE '%status NOT IN (%closed%' THEN
    RAISE EXCEPTION 'the cash list no longer states its status filter in the form the partial indexes can use';
  END IF;
END $check$;
