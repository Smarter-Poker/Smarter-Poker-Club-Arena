-- FINAL adoption stage: apply only after the occupancy engine and frontend
-- are verified live. The additive occupancy migration is a separate stage.
BEGIN;
SET LOCAL lock_timeout='2s';
DO $guard$
BEGIN
 IF md5(pg_get_functiondef('public.atomic_seat_cashout_locked(uuid,uuid,integer,text)'::regprocedure))
    <> '8d84b96cb2e7649ee2bf7ecf1f7028c9' THEN
  RAISE EXCEPTION 'Unreviewed canonical cashout before browser retirement';
 END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_admin_kick_player(uuid,uuid,text)'::regprocedure)
    <> '32b279d176d6c260fcc8530546a7a1db' THEN
  RAISE EXCEPTION 'Unreviewed admin cashout before browser retirement';
 END IF;
 IF has_function_privilege('authenticated','public.fn_cashout_seat_occupancy(uuid,uuid,integer,uuid,text)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.fn_cashout_seat_occupancy(uuid,uuid,integer,uuid,text)','EXECUTE') THEN
  RAISE EXCEPTION 'Occupancy engine authority must be installed first';
 END IF;
END $guard$;
REVOKE ALL ON FUNCTION public.atomic_seat_cashout_locked(uuid,uuid,integer,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_seat_cashout_locked(uuid,uuid,integer,text) TO service_role;
-- The authenticated admin replacement is the engine's kick-occupancy endpoint.
-- No app role may select a current seat through the retired unbound SQL door.
REVOKE ALL ON FUNCTION public.fn_admin_kick_player(uuid,uuid,text)
 FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
