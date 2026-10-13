-- 20261013161705_horse_retention_exact_space_diagnostics.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- @live-proof: EXISTS(SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgstattuple' AND e.extversion='1.5' AND n.nspname='extensions') AND (SELECT count(*)=9 AND bool_and(has_function_privilege('postgres',p.oid,'EXECUTE') AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE') AND NOT has_function_privilege('service_role',p.oid,'EXECUTE')) FROM pg_proc p JOIN pg_depend d ON d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e' JOIN pg_extension e ON e.oid=d.refobjid WHERE e.extname='pgstattuple')
-- Retention deletes have completed without shrinking the allocated heap.
-- Install the provider-allowlisted exact free-byte reader, with its upstream
-- pg_stat_scan_tables authority. This migration performs NO relation scan,
-- vacuum, compaction, balance change, role membership change or schedule change.
-- A separate explicitly admitted read measures only named affected relations.
-- Approximate free space is never substituted for exact scanned free bytes.

BEGIN;
SET LOCAL lock_timeout='2s';
DO $diagnostic_precondition$
BEGIN
 IF current_user<>'postgres' OR NOT pg_has_role(current_user,'pg_stat_scan_tables','MEMBER')
 OR EXISTS(SELECT 1 FROM pg_extension WHERE extname='pgstattuple')
 OR NOT EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='pgstattuple' AND default_version='1.5')
 OR NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='extensions')
 THEN RAISE EXCEPTION 'HORSE_SPACE_DIAGNOSTIC_PREIMAGE_CHANGED'; END IF;
 -- Native qualification uses a privileged installer then a NOSUPER reader.
 -- On Supabase the actual NOSUPER installer requires its existing allowlist.
 IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user)
 AND NOT ('pgstattuple'=ANY(regexp_split_to_array(coalesce(current_setting('supautils.privileged_extensions',true),''),'\s*,\s*')))
 THEN RAISE EXCEPTION 'HORSE_SPACE_DIAGNOSTIC_PROVIDER_NOT_ALLOWED'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('anon','authenticated','service_role')
  AND pg_has_role(rolname,'pg_stat_scan_tables','MEMBER'))
 THEN RAISE EXCEPTION 'HORSE_SPACE_DIAGNOSTIC_READER_AUTHORITY_CHANGED'; END IF;
END $diagnostic_precondition$;
CREATE EXTENSION pgstattuple WITH SCHEMA extensions VERSION '1.5';
DO $diagnostic_acl$
DECLARE r record; n integer:=0;
BEGIN
 FOR r IN SELECT p.oid,p.oid::regprocedure::text AS signature FROM pg_proc p
 JOIN pg_depend d ON d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e'
 JOIN pg_extension e ON e.oid=d.refobjid WHERE e.extname='pgstattuple'
 LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',r.signature);
  IF NOT has_function_privilege('postgres',r.oid,'EXECUTE')
  OR has_function_privilege('anon',r.oid,'EXECUTE')
  OR has_function_privilege('authenticated',r.oid,'EXECUTE')
  OR has_function_privilege('service_role',r.oid,'EXECUTE')
  THEN RAISE EXCEPTION 'HORSE_SPACE_DIAGNOSTIC_ACL_CHANGED'; END IF;
  n:=n+1;
 END LOOP;
 IF n<>9 THEN RAISE EXCEPTION 'HORSE_SPACE_DIAGNOSTIC_EXTENSION_VERSION_CHANGED'; END IF;
END $diagnostic_acl$;
COMMIT;
