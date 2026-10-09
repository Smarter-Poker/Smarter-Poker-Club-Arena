-- Permission-only declaration for the guarded leaderboard ranking replacement.
-- CREATE OR REPLACE preserves its authenticated/postgres/service-only ACL.
-- Reassert the already-denied PUBLIC and anon access for the source gate.
-- No grant, financial write or schema-cache reload is introduced. Both the
-- original and exact qualified successor are accepted so normal version order
-- and explicit companion-first installation preserve the same restrictions.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $preserve$
DECLARE target oid; before_image jsonb; after_image jsonb; grants text;
BEGIN
  target:=to_regprocedure('public.fn_club_leaderboard_by_dates(uuid,text,date,date,integer,integer)');
  SELECT string_agg(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END||':'||a.privilege_type,
    ',' ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END||':'||a.privilege_type)
    INTO grants FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE p.oid=target;
  IF current_user<>'postgres' OR target IS NULL OR grants IS DISTINCT FROM
      'authenticated:EXECUTE,postgres:EXECUTE,service_role:EXECUTE'
    OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=target
      AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef AND p.provolatile='s'
      AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[]
      AND ((md5(p.prosrc)='00824a10870941337666dea8adcaa39c'
        AND md5(pg_get_functiondef(p.oid))='b0efe3c4e9f3f7aac7c6cf9a6985ea6c')
        OR md5(p.prosrc)='a18a33b02c4577c984907828dff7e8cb')) THEN
    RAISE EXCEPTION 'Exact closed leaderboard ranking predecessor or qualified successor required';
  END IF;
  SELECT to_jsonb(p) INTO STRICT before_image FROM pg_proc p WHERE p.oid=target;
  REVOKE ALL ON FUNCTION public.fn_club_leaderboard_by_dates(uuid,text,date,date,integer,integer) FROM PUBLIC, anon;
  SELECT to_jsonb(p) INTO STRICT after_image FROM pg_proc p WHERE p.oid=target;
  IF after_image IS DISTINCT FROM before_image THEN
    RAISE EXCEPTION 'Leaderboard ranking permission declaration changed the catalog preimage';
  END IF;
END $preserve$;
COMMIT;
