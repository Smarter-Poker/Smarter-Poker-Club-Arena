-- HR2 compliance fix: fn_ca_repair_write_failure is an operator repair tool.
-- It is SECURITY DEFINER, takes no identity argument, and never inspects the
-- caller, so a logged-in browser must not be able to execute it. The
-- telemetry-exposure CI gate caught the default authenticated grant left by
-- ca_hr2_phase1_sanctioned_corrections. Service role only, like its siblings.
REVOKE ALL ON FUNCTION public.fn_ca_repair_write_failure(bigint, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_repair_write_failure(bigint, text, uuid, text) TO service_role;
