BEGIN;
SET LOCAL lock_timeout='3s';
DO $guard$
DECLARE f oid:='public.atomic_table_rebuy_before_maintenance_announcement_gate(uuid,uuid,numeric,uuid)'::regprocedure;
BEGIN
 IF md5(pg_get_functiondef(f))<>'7b987a8d9bc21645b5bf7ba1bde36f85'
  OR has_function_privilege('anon',f,'EXECUTE')
  OR has_function_privilege('authenticated',f,'EXECUTE')
  OR has_function_privilege('service_role',f,'EXECUTE') THEN
  RAISE EXCEPTION 'Audited private rebuy definition or permissions changed';
 END IF;
END $guard$;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes)
VALUES('atomic_table_rebuy_before_maintenance_announcement_gate','approved',
 'Audited 2026-09-08 with shared entry-purchase receipts: finite whole cents, mandatory key, transactional wallet/journal/entitlement/history, scoped ledger settings; 46 isolated PostgreSQL cases. Owner-only core, reached through atomic_table_rebuy. Body 7b987a8d9bc21645b5bf7ba1bde36f85.')
ON CONFLICT(proname) DO NOTHING;
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.ca_money_rpc_registry WHERE proname='atomic_table_rebuy_before_maintenance_announcement_gate' AND status='approved') THEN
  RAISE EXCEPTION 'A conflicting private rebuy registry decision needs review';
 END IF;
END $guard$;
COMMIT;
