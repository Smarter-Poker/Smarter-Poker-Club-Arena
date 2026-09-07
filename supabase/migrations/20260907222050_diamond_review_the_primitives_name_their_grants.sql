-- DIAMOND ACCOUNTING STANDARD - REVIEW FIX 2b (2026-09-07)
-- The review fix re-declared the two diamond primitives and the audit and mirror triggers as
-- SECURITY DEFINER without restating their grants in the file; the pre-push definer guard reads
-- the branch and asked for them. These statements are the LIVE truth already (every one of these
-- is postgres + service_role, or a trigger function): no grant changes, nothing moves.
BEGIN;
SET LOCAL lock_timeout = '4s';
REVOKE ALL ON FUNCTION public.add_diamonds_to_balance(uuid, integer, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_diamonds_to_balance(uuid, integer, text, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_snapshot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_snapshot() TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_trial_balance(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_trial_balance(timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_trial_balance_watch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_trial_balance_watch() TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_journal_classifier() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_earn_ledger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_born_with_balance() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_journal_append_only() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ca_promo_vault_buy(uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_promo_vault_buy(uuid, text, integer) TO authenticated, service_role;
COMMIT;
