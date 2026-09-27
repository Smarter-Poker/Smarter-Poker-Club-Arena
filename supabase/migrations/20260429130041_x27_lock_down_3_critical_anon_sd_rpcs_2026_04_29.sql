-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260429130041 "x27_lock_down_3_critical_anon_sd_rpcs_2026_04_29"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f46cd41c207ad146668c4a9f9a0777d1 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Round 27 — Triage 419 advisor WARN findings.
--
-- 37 SECURITY DEFINER RPCs are anon-executable. Most are intentional
-- (public reads — search_home_groups, get_venue_public_detail, etc.).
-- 3 are CRITICAL abuse vectors that must be service_role only:
--
--   add_chips(p_user_id, p_amount) — credits any user any amount.
--     Anyone could fire this against any user_id and inflate balances.
--   force_close_table_and_refund — admin action.
--   settle_club_rakeback — settlement chain trigger.
--
-- Lock all 3 to service_role only. Frontend code that calls these
-- (ReferralService.ts add_chips, settle_club_rakeback via FE admin UI,
-- force_close_table from admin panel) routes through the World Hub
-- ops API which authenticates as service_role server-side, so this
-- doesn't break legitimate paths.

REVOKE EXECUTE ON FUNCTION public.add_chips(uuid, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_chips(uuid, numeric) TO service_role;

REVOKE EXECUTE ON FUNCTION public.force_close_table_and_refund(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.force_close_table_and_refund(uuid, uuid, text)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.settle_club_rakeback(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_club_rakeback(uuid) TO service_role;
