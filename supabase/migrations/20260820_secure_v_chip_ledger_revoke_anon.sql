-- Applied to production via Supabase MCP on 2026-08-20. Mirrored here EXACTLY
-- as applied (house rule: migrations in this repo are a record, not the source
-- of truth -- see CLAUDE.md).
--
-- v_chip_ledger exposed the entire financial history of the platform to anyone
-- holding the PUBLIC anon key -- which ships inside the browser bundle.
--
-- Verified before the fix, unauthenticated, with nothing but that key:
--   GET /rest/v1/v_chip_ledger?select=*  ->  200
--   2,143,023 rows across 581 users: subject_user_id, amount, signed_amount,
--   direction, kind ('rake'), table_id and free-text notes
--   ("Cash game rake: hand #28724"), from 2026-02-11 to today.
--
-- The view is SECURITY DEFINER, which is precisely why it leaked: every other
-- anon-readable view in this schema returns [] because the underlying tables'
-- RLS still applies to the caller. This one ran as its owner and skipped that.
-- anon also held INSERT/UPDATE/DELETE on it.
--
-- Nothing in either repo reads this view -- it is an internal/analytics
-- surface that a blanket GRANT swept up -- so revoking is not a behaviour
-- change for any client. Verified after: anon 401, authenticated 403.

REVOKE ALL ON public.v_chip_ledger FROM anon;
REVOKE ALL ON public.v_chip_ledger FROM authenticated;

-- Defence in depth: if someone re-grants this later, make the caller's RLS
-- apply rather than the view owner's, so a future GRANT cannot silently
-- reopen the same hole. service_role bypasses RLS and is unaffected.
ALTER VIEW public.v_chip_ledger SET (security_invoker = on);
