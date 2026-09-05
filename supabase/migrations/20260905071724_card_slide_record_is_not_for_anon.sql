-- 20260905071724_card_slide_record_is_not_for_anon.sql
--
-- Applied to production 2026-09-05 (version recorded by the Supabase MCP).
--
-- WHAT THIS CHANGES, AND WHY:
--
-- `fn_record_card_slide_usage` was not flagged by the telemetry-exposure guard,
-- because it DOES look at its caller - it reads auth.uid() and returns early
-- when there is none, so a logged-out browser could never write a row. It was
-- still executable by `anon`, which is a handle on a SECURITY DEFINER routine
-- held by someone who has not signed in. Postgres grants EXECUTE to PUBLIC on
-- every new function; the original migration revoked PUBLIC but that had
-- already been inherited. Take it away by name.

BEGIN;

REVOKE ALL ON FUNCTION public.fn_record_card_slide_usage(integer, integer, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_record_card_slide_usage(integer, integer, integer, integer) TO authenticated;

COMMIT;
