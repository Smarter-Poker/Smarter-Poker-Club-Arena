-- Metadata only. Quoted statements execute exclusively in the disposable DB.
SELECT COALESCE(jsonb_agg(jsonb_build_object(
  'elevate',format('ALTER ROLE %I SUPERUSER;',rolname),
  'restore',format('ALTER ROLE %I NOSUPERUSER;',rolname)) ORDER BY rolname),'[]'::jsonb)
FROM pg_catalog.pg_roles
WHERE NOT rolsuper AND oid IN (SELECT evtowner FROM pg_catalog.pg_event_trigger);
