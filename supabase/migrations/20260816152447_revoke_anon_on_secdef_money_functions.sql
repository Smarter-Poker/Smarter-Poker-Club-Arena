-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260816152447 "revoke_anon_on_secdef_money_functions"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b898c010caf976d0a6407dc697a09fd2 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- CRITICAL: SECURITY DEFINER money functions were executable by `anon`
-- ═══════════════════════════════════════════════════════════════════════════
-- Found by the new fn_audit_privileged_grants() invariant. SECURITY DEFINER
-- bypasses RLS, so `anon` + SECURITY DEFINER on a money function is the worst
-- combination in the schema: an unauthenticated caller reaching privileged
-- writes with row-level security disabled.
--
-- All five are club-owner / union-owner operations that inherently require an
-- authenticated identity, so `anon` was never legitimate here -- it is the
-- default-grant leak, not a deliberate choice. `authenticated` and
-- `service_role` are preserved; each function keeps its own internal
-- authorization.
--
-- (These pre-date this session's work; the invariant simply surfaced them.)

REVOKE EXECUTE ON FUNCTION public.fn_claim_rakeback(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_open_settlement_period(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_set_settlement_period_status(uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_union_clawback_from_club(uuid, uuid, numeric, text, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_union_deposit_from_wallet(uuid, numeric, text, uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fn_claim_rakeback(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_open_settlement_period(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_set_settlement_period_status(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_union_clawback_from_club(uuid, uuid, numeric, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_union_deposit_from_wallet(uuid, numeric, text, uuid) TO authenticated, service_role;
