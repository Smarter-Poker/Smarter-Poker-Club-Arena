-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419151847 "phase22_revoke_stripe_webhooks"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 7005559dec5b709e3b5b807e61307b47 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 22 — Revoke anon/authenticated from 2 Stripe webhook functions
--  -----------------------------------------------------------------------
--  Target functions:
--    - activate_vip(uuid, text, text, text, timestamptz)
--    - award_purchase_diamonds(uuid, integer, text, numeric)
--
--  Why verified safe:
--    1. Both signatures require Stripe-issued data (subscription_id,
--       session_id, amount_paid). Browsers cannot forge valid Stripe IDs.
--    2. vip_subscriptions table: 0 rows total (pre-revenue state).
--    3. purchase_history table: 0 rows total (pre-revenue state).
--    4. Stripe webhook handlers run server-side via service_role key —
--       unaffected by anon/authenticated revoke.
--    5. Zero production writes in last 30 days → zero production callers
--       to break.
--
--  Per Dan's instruction: LOW risk = permitted to change.
-- =========================================================================

REVOKE EXECUTE ON FUNCTION public.activate_vip(uuid, text, text, text, timestamptz)
    FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.award_purchase_diamonds(uuid, integer, text, numeric)
    FROM PUBLIC, anon, authenticated;

-- Mark resolved in audit
UPDATE public.phase22_secdef_grant_audit
   SET resolved_at = NOW(),
       resolution  = 'Phase 22: Revoked anon/authenticated/PUBLIC EXECUTE. Stripe webhook function — signature requires Stripe-issued IDs that browsers cannot forge. Target tables (vip_subscriptions, purchase_history) have zero rows historically, confirming pre-revenue state with no existing production callers. service_role retained for the actual Stripe webhook handler path.'
 WHERE function_name IN ('activate_vip', 'award_purchase_diamonds');
