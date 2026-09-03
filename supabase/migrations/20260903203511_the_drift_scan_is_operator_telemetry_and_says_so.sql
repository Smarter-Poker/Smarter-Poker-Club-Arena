-- ============================================================================
--  THE DRIFT SCAN IS OPERATOR TELEMETRY, AND SAYS SO IN THE FILE THAT SHIPS IT
--
--  Chip Accounting Standard, Phase 2, lane 2.5 - companion to
--  20260903201301_two_orphan_money_doors_are_closed_and_manual_movements_are_reported.
--
--  WHAT WAS WRONG. That file re-declares fn_ca_money_rpc_drift (SECURITY
--  DEFINER, no auth.uid() in its body, because it is a daily cron scan and an
--  epoch-gate probe) with its body plus one loop, and writes no GRANT or
--  REVOKE for it. Live, the function was already closed on 2026-08-31:
--  proacl = {postgres=X/postgres, service_role=X/postgres}, and a
--  CREATE OR REPLACE keeps the existing ACL, so nothing changed for any
--  caller. But scripts/ci/check-definer-authorization.mjs reads migration
--  files, not the live catalogue, and a declaration with no REVOKE in the
--  branch reads as "EXECUTE granted to PUBLIC" - which is the Postgres
--  default for a function whose grants were never written down. The gate is
--  right to refuse a guess.
--
--  THE RULE. A SECURITY DEFINER function that never asks who is calling is
--  operator or engine telemetry, and the migration that declares it names
--  the roles that may run it. These two statements are idempotent against
--  the live ACL: the REVOKE removes nothing that is held, the GRANT adds
--  nothing that is missing. The self-check proves the grants are exactly
--  what the cron (ca-money-rpc-drift-daily, runs as postgres) and the epoch
--  gates need, and nothing more.
-- ============================================================================

REVOKE ALL ON FUNCTION public.fn_ca_money_rpc_drift() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_money_rpc_drift() TO service_role;

DO $$
DECLARE
  v_oid oid;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p
   WHERE p.proname = 'fn_ca_money_rpc_drift' AND p.pronamespace = 'public'::regnamespace;
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'fn_ca_money_rpc_drift is missing';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_ca_money_rpc_drift must not be executable by a browser role';
  END IF;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_ca_money_rpc_drift must stay executable by service_role';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-money-rpc-drift-daily') THEN
    RAISE EXCEPTION 'the daily drift scan cron job is gone - this file pins grants for a scan that must keep running';
  END IF;
END $$;

