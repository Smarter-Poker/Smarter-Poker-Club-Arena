-- SUPERSEDED AND DELIBERATELY NEUTRALISED 2026-08-26. DO NOT APPLY.
--
-- This file was merged to main by PR #994 and was never applied to production.
-- That is fortunate: applying it would have left the hole it was written to
-- close, and opened a second one.
--
-- Three defects, verified against the live database on 2026-08-26:
--
--  1. Its fn_bbj_promo_payout_atomic block declares a 3-arg signature
--     (p_amount, p_event_type, p_reason). The live function is 5-arg
--     (p_pool_id, p_amount, p_recipient_user_ids, p_reason, p_event_type).
--     It is not a replacement, it is a NEW function that ignores the caller's
--     recipient list and credits every 'eligible' row in promo_eligibility.
--
--  2. Its final line then GRANTs EXECUTE to `authenticated` on the 5-arg
--     signature -- the original, which this file never guards. Net effect for
--     that function: hole re-opened, stray mass-payout overload created.
--
--  3. Its fn_pay_player_chips and fn_purchase_club_chips bodies are SHORTER
--     than the live definitions (1702 vs 1795 and 2640 vs 2991 chars), so
--     CREATE OR REPLACE would silently drop live logic.
--
-- The original 315-line content is preserved in git history at commit
-- 5ca221eecd632be8c72365e6f4341ad43d948c2a.
--
-- What actually shipped, and IS applied in production:
--   supabase/migrations/20260826150000_revoke_authenticated_execute_on_five_economy_functions.sql
--
-- Full write-up:
--   .agent/audits/2026-08-26-pr994-never-applied-and-defective.md
--
-- Adding the in-body auth.uid() guards remains open work. Each one must be
-- built from the LIVE pg_get_functiondef output with the guard injected after
-- BEGIN -- never from this file.

DO $$
BEGIN
  RAISE EXCEPTION
    'Migration 20260826140045_fix_economy_auth_guards is superseded and must not be applied. See 20260826150000_revoke_authenticated_execute_on_five_economy_functions.sql';
END
$$;
