-- 20261003144033_stats_overview_owner_acl.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
-- The earlier Stats club-scope migration replaced the All Clubs owner facade
-- but omitted the explicit browser ACL restoration at the end of that file.
-- PostgreSQL therefore restored PUBLIC execute while the function itself still
-- enforced ca_assert_self. Close that defence-in-depth gap on already-installed
-- databases without changing its body or any Stats data.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
--
-- @live-proof: NOT has_function_privilege('anon','public.ca_player_stats_overview_v2(uuid,integer,text,text)','EXECUTE') AND has_function_privilege('authenticated','public.ca_player_stats_overview_v2(uuid,integer,text,text)','EXECUTE') AND has_function_privilege('service_role','public.ca_player_stats_overview_v2(uuid,integer,text,text)','EXECUTE')

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $contract$
BEGIN
  IF to_regprocedure('public.ca_player_stats_overview_v2(uuid,integer,text,text)') IS NULL THEN
    RAISE EXCEPTION 'Stats overview owner facade is missing; refusing ACL repair'
      USING ERRCODE = 'P0404';
  END IF;
END;
$contract$;

REVOKE ALL ON FUNCTION public.ca_player_stats_overview_v2(uuid,integer,text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_overview_v2(uuid,integer,text,text)
  TO authenticated,service_role;

COMMIT;
