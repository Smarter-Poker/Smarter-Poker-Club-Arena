-- Make the already-enforced service-only contract explicit to static checks.
-- The applied body replacement required these ACLs before and after replacement.
-- Keep that applied file immutable; this forward migration changes no body/data.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '10s';

DO $reprice_access_preflight$
DECLARE v_target regprocedure := to_regprocedure('public.fn_complete_tournament_entry_reprice(uuid)');
BEGIN
  IF v_target IS NULL OR NOT COALESCE((
    SELECT md5(prosrc) = '784df9021f906ca9e42e43942b692e2f'
       AND prosecdef AND prorettype = 'jsonb'::regtype
       AND proconfig @> ARRAY['search_path=public, pg_temp']
    FROM pg_proc WHERE oid = v_target
  ), false) THEN
    RAISE EXCEPTION 'cash entry reprice body or security contract changed';
  END IF;
END;
$reprice_access_preflight$;

REVOKE ALL ON FUNCTION public.fn_complete_tournament_entry_reprice(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_entry_reprice(uuid) TO service_role;

DO $reprice_access_postflight$
DECLARE v_target regprocedure := 'public.fn_complete_tournament_entry_reprice(uuid)'::regprocedure;
BEGIN
  IF has_function_privilege('anon', v_target, 'EXECUTE')
     OR has_function_privilege('authenticated', v_target, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_target, 'EXECUTE')
     OR EXISTS (
       SELECT 1 FROM pg_proc p,
         LATERAL aclexplode(COALESCE(p.proacl, acldefault('f',p.proowner))) a
       WHERE p.oid = v_target AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
     )
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = v_target)
        <> '784df9021f906ca9e42e43942b692e2f' THEN
    RAISE EXCEPTION 'cash entry reprice service-only access was not proven';
  END IF;
END;
$reprice_access_postflight$;
COMMIT;
