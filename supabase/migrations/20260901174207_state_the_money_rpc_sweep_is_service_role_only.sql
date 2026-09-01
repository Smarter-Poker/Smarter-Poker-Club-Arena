-- The pre-push definer gate refused the mirror of
-- the_money_rpc_sweep_reads_columns_not_just_tables because it re-declares
-- fn_ca_money_rpc_drift, a SECURITY DEFINER function that writes (it raises
-- incidents) and never asks who is calling.
--
-- Checked against production first: anon and authenticated already have NO
-- execute here and service_role has it, and CREATE OR REPLACE does not touch
-- grants - so nothing was exposed and the migration changed nothing. The gate
-- reads the migration text rather than the live catalogue, and it is right to:
-- a migration that declares a definer writer should say who may call it.

REVOKE ALL ON FUNCTION public.fn_ca_money_rpc_drift() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_money_rpc_drift() TO service_role;

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.fn_ca_money_rpc_drift()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_money_rpc_drift()', 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can still execute the money-RPC sweep';
  END IF;
END $$;
