-- A byte-exact capture of the LIVE public.cleanup_old_hole_cards() on
-- kuklfnapbkmacvwxktbh, taken 2026-09-20 with pg_get_functiondef, together
-- with its live owner, ACL, search_path, volatility and security mode.
-- The DO block at the end refuses to load anything that is not that capture.
\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION public.cleanup_old_hole_cards()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
    DELETE FROM public.table_hole_cards WHERE created_at < NOW() - INTERVAL '24 hours';
END;
$function$;

ALTER FUNCTION public.cleanup_old_hole_cards() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.cleanup_old_hole_cards() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_old_hole_cards() TO service_role;

DO $capture$
DECLARE target oid := to_regprocedure('public.cleanup_old_hole_cards()');
BEGIN
  IF target IS NULL
  OR md5((SELECT prosrc FROM pg_proc WHERE oid = target)) <> 'cb98131946a9b0ee87250935d06835a3'
  OR md5(pg_get_functiondef(target)) <> '4cf22b42f8a4ac111ae63b77d7f37849'
  OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = target
       AND proowner = 'postgres'::regrole
       AND NOT prosecdef
       AND provolatile = 'v'
       AND proconfig = ARRAY['search_path=public']::text[]
       AND proacl::text = '{postgres=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION 'CAPTURE IS NOT THE LIVE cleanup_old_hole_cards(): body=% def=% acl=%',
      md5((SELECT prosrc FROM pg_proc WHERE oid = target)),
      md5(pg_get_functiondef(target)),
      (SELECT proacl::text FROM pg_proc WHERE oid = target);
  END IF;
END
$capture$;
