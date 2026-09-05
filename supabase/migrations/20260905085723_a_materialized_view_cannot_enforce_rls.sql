-- A MATERIALIZED VIEW CANNOT ENFORCE RLS (2026-09-05)
--
-- Row Level Security is what actually protects this database: 1,016 of 1,017
-- tables in `public` have it enabled. The broad `GRANT ALL` Supabase applies to
-- anon and authenticated by default - 767 relations carry write privileges - is
-- therefore mostly inert, because RLS refuses the rows.
--
-- MATERIALIZED VIEWS ARE THE HOLE IN THAT. Postgres does not apply RLS to a
-- matview, so a SELECT grant on one is a straight read of its contents. Four
-- exist in public, and one was readable by anon:
--
--   training_leaderboard_top    anon SELECT + INSERT   <- exposed
--   mv_active_poker_locations   anon INSERT only
--   mv_hand_histories           anon INSERT only
--   mv_home_groups_trending     no anon grants
--
-- training_leaderboard_top holds zero rows today, so nothing leaked, and the
-- fix is cheap now rather than after it is populated. mv_hand_histories is the
-- one that would have mattered - hand histories are the most sensitive table on
-- a poker platform - and it was already closed.
--
-- The INSERT grants are inert (Postgres refuses INSERT on a matview whatever
-- the ACL says) but they are removed too: an ACL claiming a privilege the
-- engine will not honour is a line the next reader has to work out, and if one
-- of these is ever converted to a plain table the grant arrives with it.
--
-- spatial_ref_sys is the single table in public without RLS, and it is the
-- PostGIS reference catalogue owned by supabase_admin. Not ours to change, and
-- it holds no platform data.
--
-- APPLIED 2026-09-05.

DO $lock$
DECLARE r record; v_count integer := 0;
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
   WHERE c.relkind='m' AND pg_get_userbyid(c.relowner) = current_user
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
  RAISE NOTICE 'clean: 0 matviews open to browser roles, % readable by service_role', v_service;
END
$verify$;
