-- Preserve the two existing service-only accounting readers explicitly.
-- CREATE OR REPLACE preserved the live private ACLs, confirmed after installation;
-- source-only authorization checks cannot infer that unchanged catalogue state.
-- This successor restates the contract without editing applied migration bytes.
BEGIN;
SET LOCAL lock_timeout = '3s';
DO $guard$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.fn_pnl_cash_hand_evidence(uuid,bigint)', '79c1675f477cbd7b3ed80c91ab918ce0'),
    ('public.fn_hand_history_prune_backlog()', '7eaba40f4568528a27ec53ee9ca37b2e')
  ) expected(signature, body_md5)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(r.signature)
      AND md5(p.prosrc)=r.body_md5 AND pg_get_userbyid(p.proowner)='postgres'
      AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN
      RAISE EXCEPTION 'accounting reader predecessor or private ACL changed: %', r.signature;
    END IF;
  END LOOP;
END
$guard$;
REVOKE ALL ON FUNCTION public.fn_pnl_cash_hand_evidence(uuid,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_pnl_cash_hand_evidence(uuid,bigint) TO service_role;
REVOKE ALL ON FUNCTION public.fn_hand_history_prune_backlog() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_hand_history_prune_backlog() TO service_role;
COMMIT;
