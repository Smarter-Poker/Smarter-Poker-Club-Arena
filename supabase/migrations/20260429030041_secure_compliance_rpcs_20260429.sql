-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260429030041 "secure_compliance_rpcs_20260429"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a53f43b461384a51846001ad85d18ce1 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

REVOKE EXECUTE ON FUNCTION public.fn_set_age_verified(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_kyc_start_inquiry(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_kyc_resolve_inquiry(text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_delete_user_gdpr(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_mark_gdpr_completed(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_rg_set_limits(uuid, numeric, numeric, numeric, numeric, integer, integer, boolean) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_rg_self_exclude(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_rg_start_session(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_rg_end_session(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_rg_should_show_reality_check(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.add_bbj_contribution(uuid, uuid, numeric, numeric, integer, text, numeric, numeric, numeric) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.award_bbj(uuid, uuid, bigint, uuid, text, text, text, uuid, text, text, text, numeric, numeric, numeric, numeric, text, text, numeric) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_bbj_payout(uuid, uuid, uuid, uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.calculate_cascading_commission(uuid, uuid, uuid, numeric, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_rake(uuid, uuid, uuid, numeric, numeric, integer, jsonb, boolean, uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.settle_hand_atomically(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_claim_settlement_period(text, text, uuid, timestamp with time zone, timestamp with time zone) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_close_settlement_period(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_finalize_settlement_period(uuid, text, integer, integer, numeric, numeric, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_log_admin_action(uuid, text, text, text, jsonb, jsonb, jsonb, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.unlock_free_avatars(uuid) FROM PUBLIC, anon, authenticated;
