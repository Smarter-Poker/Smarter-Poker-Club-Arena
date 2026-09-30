-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424014838 "20260421183000_hg_drop_xp_safety_stubs_no_callers"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f8b20a4696686005b9f3c5c49f946e0b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Bug hunt: 3 XP safety stubs (add_xp, fn_add_xp, fn_award_xp) have
-- empty/no-op bodies. Verified zero callers. Drop to achieve absolute
-- zero XP surface — the xp_ban_guard event trigger would prevent any
-- attempt to re-add these.
--
-- Note: these fns were created BEFORE the DDL guard was installed, so
-- they predate the ban. Once dropped they cannot come back.

DROP FUNCTION IF EXISTS public.add_xp(uuid, integer);
DROP FUNCTION IF EXISTS public.fn_add_xp(uuid, integer);
DROP FUNCTION IF EXISTS public.fn_award_xp(uuid, integer, text, numeric, jsonb);
