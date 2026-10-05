-- 20261005115325_a_browser_cannot_read_which_seat_or_member_is_a_horse.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- Applied to production as version 20261005140843 (the apply transport stamps its
-- own version; match by name, never by version).
--
-- WHAT WAS WRONG (2026-10-05)
--
-- table_seats.horse_id names the account in a seat when that account is a
-- horse, and NULL for a person. Every browser role could read it: anon and
-- authenticated held table-level SELECT and the "Public read access" policy is
-- USING (true). Measured 2026-10-05: 965,180 of 1,303,476 seat rows carry it,
-- so one query from a console - logged out - listed every horse on the
-- platform. Dan, 2026-09-02: "NOBODY SHOULD EVER EVER EVER BE ABLE TO LOOK AT
-- OUR CODE OR USE A DEVELOPER TOOL AND FIND THIS OUT."
--
-- club_members.is_bot is the same fact, mirrored from profiles.is_horse by
-- trigger, readable by every signed-in member of a club for every row the
-- club-roster policies show them (1,903 of 1,926 rows are bots).
--
-- The 2026-09-07 close (20260907221341) revoked the column on table_seats and
-- its own post-apply check caught that a column REVOKE is a no-op under a
-- TABLE-level grant, so that half was rolled back and never redone.
--
-- WHAT THIS DOES
--
-- 1. Refuses to run while any reader a browser can reach still names either
--    column: an invoker function anon or authenticated can execute, an
--    invoker trigger on a table they can write, an RLS policy, or a view
--    they can read.
-- 2. For each table: revokes the TABLE-level SELECT from anon and
--    authenticated and grants SELECT back on every column except the one
--    withheld, built from the catalogue so no column is forgotten.
--    INSERT, UPDATE, DELETE, RLS, policies and service_role are untouched.
-- 3. Asserts the result: the withheld columns are unreadable, every other
--    column is readable exactly as before, writes and policies unchanged.
--
-- The browser stopped naming both columns before this was applied (PR
-- "the browser stops reading horse_id", tests/unit/tableSeatsCountNamesAColumn
-- scans every src file). Realtime already drops a column a role cannot select
-- (realtime.apply_rls checks has_column_privilege per column), and table_seats
-- is in no publication. GRANT and REVOKE take no lock on the table data.
--
-- Never apply between :50 and :03 of any hour.
--
-- APPLIED 2026-10-05 14:08Z, after the client that stopped naming either
-- column was published (main db1a7c231d). Verified live: has_column_privilege
-- is false for anon and authenticated on table_seats.horse_id and
-- club_members.is_bot, true on every other column; as anon, the client's
-- roster read returned rows; as anon, reading or filtering on horse_id and, as
-- authenticated, reading is_bot each raised 42501.
--
-- @live-proof: (SELECT NOT has_column_privilege('anon','public.table_seats','horse_id','SELECT') AND NOT has_column_privilege('authenticated','public.table_seats','horse_id','SELECT') AND NOT has_column_privilege('anon','public.club_members','is_bot','SELECT') AND NOT has_column_privilege('authenticated','public.club_members','is_bot','SELECT'))
-- @live-proof: (SELECT has_column_privilege('authenticated','public.table_seats','seat_number','SELECT') AND has_column_privilege('anon','public.table_seats','user_id','SELECT') AND has_column_privilege('authenticated','public.club_members','role','SELECT'))

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. EVERY READER HAS MOVED
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_bad text;
BEGIN
  WITH browser_tables AS (
    SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
       AND (has_table_privilege('authenticated', c.oid, 'INSERT') OR has_table_privilege('authenticated', c.oid, 'UPDATE')
         OR has_table_privilege('authenticated', c.oid, 'DELETE') OR has_table_privilege('anon', c.oid, 'INSERT')
         OR has_table_privilege('anon', c.oid, 'UPDATE') OR has_table_privilege('anon', c.oid, 'DELETE'))
  ), reach AS (
    SELECT p.oid FROM pg_proc p
     WHERE NOT p.prosecdef AND p.prokind IN ('f','p')
       AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))
    UNION
    SELECT t.tgfoid FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE NOT t.tgisinternal AND NOT p.prosecdef AND t.tgrelid IN (SELECT oid FROM browser_tables)
  )
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
    FROM reach r JOIN pg_proc p ON p.oid = r.oid JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog','information_schema','extensions','graphql','graphql_public','pgsodium',
                           'vault','realtime','storage','supabase_functions','net','cron','pgbouncer','auth')
     AND ((p.prosrc ~* '\mtable_seats\M'
           AND (p.prosrc ~* '\mhorse_id\M' OR p.prosrc ~* 'table_seats%rowtype'
             OR p.prosrc ~* 'select\s+\*\s+from\s+(public\.)?table_seats\M'))
       OR (p.prosrc ~* '\mclub_members\M'
           AND (p.prosrc ~* '\mis_bot\M' OR p.prosrc ~* 'club_members%rowtype'
             OR p.prosrc ~* 'select\s+\*\s+from\s+(public\.)?club_members\M')));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'a reader a browser can reach may still read a withheld column: %', v_bad;
  END IF;

  SELECT string_agg(c.relname || '.' || po.polname, ', ') INTO v_bad
    FROM pg_policy po JOIN pg_class c ON c.oid = po.polrelid
   WHERE (coalesce(pg_get_expr(po.polqual, po.polrelid), '') || coalesce(pg_get_expr(po.polwithcheck, po.polrelid), ''))
         ~* '\mhorse_id\M|\mis_bot\M'
     AND (c.oid IN ('public.table_seats'::regclass, 'public.club_members'::regclass)
       OR (coalesce(pg_get_expr(po.polqual, po.polrelid), '') || coalesce(pg_get_expr(po.polwithcheck, po.polrelid), ''))
          ~* '\mtable_seats\M|\mclub_members\M');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'a policy reads a withheld column: %', v_bad;
  END IF;

  SELECT string_agg(DISTINCT v.oid::regclass::text, ', ') INTO v_bad
    FROM pg_depend d
    JOIN pg_rewrite rw ON rw.oid = d.objid
    JOIN pg_class v ON v.oid = rw.ev_class
    JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
   WHERE (a.attrelid, a.attname) IN (('public.table_seats'::regclass, 'horse_id'::name),
                                     ('public.club_members'::regclass, 'is_bot'::name))
     AND v.oid NOT IN ('public.table_seats'::regclass, 'public.club_members'::regclass)
     AND (has_table_privilege('authenticated', v.oid, 'SELECT') OR has_table_privilege('anon', v.oid, 'SELECT'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'a browser-readable view reads a withheld column: %', v_bad;
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 2. TABLE-LEVEL SELECT BECOMES COLUMN-LEVEL, LESS THE ONE THAT SAYS "HORSE"
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  r record;
  v_cols text;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('table_seats', 'horse_id'), ('club_members', 'is_bot')) AS t(tbl, withheld)
  LOOP
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO v_cols
      FROM pg_attribute a
     WHERE a.attrelid = ('public.' || r.tbl)::regclass AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attname <> r.withheld;
    IF v_cols IS NULL OR position(quote_ident(r.withheld) in v_cols) > 0 THEN
      RAISE EXCEPTION 'column list for % is wrong: %', r.tbl, v_cols;
    END IF;
    EXECUTE format('REVOKE SELECT ON public.%I FROM anon, authenticated', r.tbl);
    EXECUTE format('GRANT SELECT (%s) ON public.%I TO anon, authenticated', v_cols, r.tbl);
  END LOOP;
END $m$;

-- ---------------------------------------------------------------------------
-- 3. THE RESULT, ASSERTED
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  r record;
  v_n integer;
  v_total integer;
  v_role text;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('table_seats', 'horse_id'), ('club_members', 'is_bot')) AS t(tbl, withheld)
  LOOP
    SELECT count(*) INTO v_total FROM pg_attribute a
     WHERE a.attrelid = ('public.' || r.tbl)::regclass AND a.attnum > 0 AND NOT a.attisdropped;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_table_privilege(v_role, ('public.' || r.tbl)::regclass, 'SELECT') THEN
        RAISE EXCEPTION '% still holds table-level SELECT on %', v_role, r.tbl;
      END IF;
      IF has_column_privilege(v_role, ('public.' || r.tbl)::regclass, r.withheld, 'SELECT') THEN
        RAISE EXCEPTION '% can still read %.%', v_role, r.tbl, r.withheld;
      END IF;
      SELECT count(*) INTO v_n FROM pg_attribute a
       WHERE a.attrelid = ('public.' || r.tbl)::regclass AND a.attnum > 0 AND NOT a.attisdropped
         AND has_column_privilege(v_role, a.attrelid, a.attname, 'SELECT');
      IF v_n <> v_total - 1 THEN
        RAISE EXCEPTION '% reads % of % columns of %, expected %', v_role, v_n, v_total, r.tbl, v_total - 1;
      END IF;
    END LOOP;
    IF NOT has_table_privilege('service_role', ('public.' || r.tbl)::regclass, 'SELECT')
       OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || r.tbl)::regclass) THEN
      RAISE EXCEPTION 'service_role or row security of % changed', r.tbl;
    END IF;
  END LOOP;
  -- Writes are as they were: the browser roles keep INSERT and UPDATE.
  IF NOT has_table_privilege('authenticated', 'public.table_seats', 'UPDATE')
     OR NOT has_table_privilege('authenticated', 'public.club_members', 'UPDATE') THEN
    RAISE EXCEPTION 'a write grant changed';
  END IF;
END $m$;

COMMIT;
