BEGIN;
SET LOCAL lock_timeout='2s';
DO $guard$
DECLARE f oid:='public.fn_register_for_tournament_request(uuid,uuid)'::regprocedure;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=f)<>'c80d08529c03284adc51c6cb03764a55'
  OR has_function_privilege('anon',f,'EXECUTE')
  OR has_function_privilege('service_role',f,'EXECUTE')
  OR NOT has_function_privilege('authenticated',f,'EXECUTE') THEN
  RAISE EXCEPTION 'Audited registration receipt definition or permissions changed';
 END IF;
END $guard$;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes)
VALUES('fn_register_for_tournament_request','approved',
 'Audited 2026-09-09: authenticated live-session entry wrapper, mandatory request UUID, exact caller/event binding, same-transaction canonical registration and immutable shared receipt. Ten local PostgreSQL wrapper assertions and client identity tests; underlying funding-core acceptance remains separately tracked. Body c80d08529c03284adc51c6cb03764a55.')
ON CONFLICT(proname) DO NOTHING;
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.ca_money_rpc_registry
   WHERE proname='fn_register_for_tournament_request' AND status='approved') THEN
  RAISE EXCEPTION 'A conflicting registration registry decision needs review';
 END IF;
END $guard$;
COMMIT;
