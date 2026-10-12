-- This SELECT returns quoted DDL for the ISOLATED destination only.
-- No returned statement is executed on the source connection.
WITH RECURSIVE dependencies AS (
  SELECT e.oid AS root, e.oid AS dependency, ARRAY[e.oid] AS path
  FROM pg_catalog.pg_extension e
  UNION ALL
  SELECT d.root, p.refobjid, d.path || p.refobjid
  FROM dependencies d JOIN pg_catalog.pg_depend p
    ON p.classid='pg_catalog.pg_extension'::regclass AND p.objid=d.dependency
   AND p.refclassid='pg_catalog.pg_extension'::regclass
  WHERE NOT p.refobjid=ANY(d.path)
), depths AS (
  SELECT root,max(cardinality(path)) AS depth FROM dependencies GROUP BY root
)
SELECT pg_catalog.format(
  'BEGIN; ALTER ROLE %1$I SUPERUSER; SET ROLE %1$I; CREATE EXTENSION %2$I WITH SCHEMA %3$I VERSION %4$L; RESET ROLE; ALTER ROLE %1$I %5$s; COMMIT;',
  r.rolname,e.extname,n.nspname,e.extversion,
  CASE WHEN r.rolsuper THEN 'SUPERUSER' ELSE 'NOSUPERUSER' END)
FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace
JOIN pg_catalog.pg_roles r ON r.oid=e.extowner JOIN depths d ON d.root=e.oid
ORDER BY (e.extname='plpgsql') DESC,d.depth,e.extname;

SELECT pg_catalog.format('ALTER TABLESPACE %I OWNER TO %I;',spcname,
  pg_catalog.pg_get_userbyid(spcowner))
FROM pg_catalog.pg_tablespace WHERE spcname IN ('pg_default','pg_global') ORDER BY spcname;
