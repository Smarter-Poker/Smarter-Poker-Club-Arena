-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260905085723; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260905085723   (the stamp IS the apply time, UTC: 2026-09-05 08:57:23)
--   name        a_materialized_view_cannot_enforce_rls
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 3442 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260905085723 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     (no CREATE/DROP of a named object; see the body)
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- A MATERIALIZED VIEW CANNOT ENFORCE RLS (2026-09-05)
--
-- Row Level Security is what actually protects this database: 1,016 of 1,017
-- tables in `public` have it enabled. The broad `GRANT ALL` that Supabase
-- applies to anon and authenticated by default - 767 relations carry write
-- privileges - is therefore mostly inert, because RLS refuses the rows.
--
-- MATERIALIZED VIEWS ARE THE HOLE IN THAT. Postgres does not apply RLS to a
-- matview, so a SELECT grant on one is a straight read of its contents. There
-- are four in public, and one was readable by anon:
--
--   training_leaderboard_top    anon SELECT + INSERT   <- exposed
--   mv_active_poker_locations   anon INSERT only
--   mv_hand_histories           anon INSERT only
--   mv_home_groups_trending     no anon grants
--
-- training_leaderboard_top holds zero rows today, so nothing has leaked, and
-- the fix is cheap now rather than after it is populated. mv_hand_histories is
-- the one that would have mattered - hand histories are the most sensitive
-- table on a poker platform - and it is already closed.
--
-- The INSERT grants are inert (Postgres refuses INSERT on a matview whatever
-- the ACL says) but they are removed too: an ACL that claims a privilege the
-- engine will not honour is a line the next reader has to work out, and if one
-- of these is ever converted to a plain table the grant arrives with it.
--
-- spatial_ref_sys is the single table in public without RLS, and it is the
-- PostGIS reference catalogue owned by supabase_admin. It is not ours to
-- change and holds no platform data.

DO $lock$
DECLARE
  r record;
  v_count integer := 0;
BEGIN
  FOR r IN
    SELECT quote_ident(n.nspname)||'.'||quote_ident(c.relname) AS rel
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     WHERE c.relkind = 'm'
       AND pg_get_userbyid(c.relowner) = current_user
       AND (has_table_privilege('anon', c.oid, 'SELECT')
         OR has_table_privilege('authenticated', c.oid, 'SELECT')
         OR has_table_privilege('anon', c.oid, 'INSERT')
         OR has_table_privilege('authenticated', c.oid, 'INSERT'))
  LOOP
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC, anon, authenticated', r.rel);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'closed % materialized views to the browser roles', v_count;
END
$lock$;

DO $verify$
DECLARE v_open integer; v_service integer;
BEGIN
  SELECT count(*) INTO v_open
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
   WHERE c.relkind='m'
     AND pg_get_userbyid(c.relowner) = current_user
     AND (has_table_privilege('anon', c.oid,'SELECT')
       OR has_table_privilege('authenticated', c.oid,'SELECT'));
  IF v_open <> 0 THEN
    RAISE EXCEPTION '% materialized views are still readable by a browser role', v_open;
  END IF;

  -- service_role must keep its access or the jobs that refresh and read these
  -- break. Closing a hole must not close the door the platform uses.
  SELECT count(*) INTO v_service
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
   WHERE c.relkind='m' AND has_table_privilege('service_role', c.oid,'SELECT');
  IF v_service = 0 THEN
    RAISE EXCEPTION 'service_role lost SELECT on every materialized view';
  END IF;

  RAISE NOTICE 'clean: 0 matviews open to browser roles, % still readable by service_role', v_service;
END
$verify$;
