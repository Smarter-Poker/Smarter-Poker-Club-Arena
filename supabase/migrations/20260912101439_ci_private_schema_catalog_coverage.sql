SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='15s';
-- Proposal only. Root applies after independent review in one transaction.
CREATE FUNCTION public.fn_ci_smarter_private_manifest()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_namespace oid;
  v_result jsonb;
BEGIN
  SELECT n.oid INTO v_namespace
    FROM pg_catalog.pg_namespace AS n
   WHERE n.nspname = 'smarter_private';
  IF v_namespace IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '3F000',
      MESSAGE = 'smarter_private manifest unavailable: namespace does not exist';
  END IF;

  WITH relations AS (
    SELECT c.oid, pg_catalog.format('%I.%I', n.nspname, c.relname) AS identifier
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
     WHERE c.relnamespace = v_namespace
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  ), relation_columns AS (
    SELECT r.identifier,
      COALESCE((SELECT pg_catalog.jsonb_agg(a.attname ORDER BY a.attnum)
                  FROM pg_catalog.pg_attribute AS a
                 WHERE a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped),
               '[]'::jsonb) AS names
      FROM relations AS r
  ), routines AS (
    SELECT DISTINCT pg_catalog.format('%I.%I', n.nspname, p.proname) AS identifier
      FROM pg_catalog.pg_proc AS p
      JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
     WHERE p.pronamespace = v_namespace
  )
  SELECT pg_catalog.jsonb_build_object(
    'version', 1,
    'schema', 'smarter_private',
    'complete', true,
    'tables', COALESCE((SELECT pg_catalog.jsonb_agg(r.identifier ORDER BY r.identifier COLLATE "C") FROM relations AS r), '[]'::jsonb),
    'functions', COALESCE((SELECT pg_catalog.jsonb_agg(f.identifier ORDER BY f.identifier COLLATE "C") FROM routines AS f), '[]'::jsonb),
    'columns', COALESCE((SELECT pg_catalog.jsonb_object_agg(c.identifier, c.names) FROM relation_columns AS c), '{}'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.fn_ci_smarter_private_manifest() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ci_smarter_private_manifest() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ci_smarter_private_manifest() TO service_role;
-- Refuse unexpected default ACLs rather than silently expose the new helper.
DO $acl$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS p
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS a
     WHERE p.oid = 'public.fn_ci_smarter_private_manifest()'::pg_catalog.regprocedure
       AND a.grantee NOT IN (
         (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postgres'),
         (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role'))
  ) THEN
    RAISE EXCEPTION 'unexpected private manifest function ACL';
  END IF;
END;
$acl$;
