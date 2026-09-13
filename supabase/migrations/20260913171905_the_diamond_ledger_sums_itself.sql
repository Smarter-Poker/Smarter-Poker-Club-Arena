-- 20260913171905_the_diamond_ledger_sums_itself.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Both wallets print a player's LIFETIME diamonds earned and spent. Neither
-- asked the database for the sum. Club Arena's DiamondService.getLifetimeStats
-- and the World Hub's /api/store/diamond-transactions each read up to 5,000
-- rows of `diamond_transactions` into JavaScript and added them up there, and
-- when the read failed both reported `0 / 0` - a figure indistinguishable from
-- a brand-new account. Measured 2026-09-13: 1,166 players hold diamond rows and
-- the longest ledger is 431, so the cap has not bitten yet; it is a cliff with
-- a date on it rather than a bug with a symptom, and the silent zero is a
-- CLAUDE.md 10.86 violation today ("never coerce an unreadable answer into an
-- empty one").
--
-- One STABLE, SECURITY INVOKER function that sums the ledger where the ledger
-- lives. INVOKER, so `diamond_transactions_select_own` still decides what an
-- authenticated caller may see - a player passing another player's id gets
-- zero rows, not another player's history - and `service_role` (the World Hub
-- API) sees the whole table exactly as it does today. `p_user_id` defaults to
-- the caller so a browser client need pass nothing. The (user_id) and
-- (user_id, created_at) indexes already serve the scan.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_diamond_lifetime_totals(
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS TABLE (
    lifetime_earned bigint,
    lifetime_spent  bigint,
    credits         bigint,
    debits          bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
    SELECT
        COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount END), 0)::bigint AS lifetime_earned,
        COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount END), 0)::bigint AS lifetime_spent,
        COUNT(*) FILTER (WHERE t.amount > 0)::bigint AS credits,
        COUNT(*) FILTER (WHERE t.amount < 0)::bigint AS debits
    FROM public.diamond_transactions t
    WHERE t.user_id = p_user_id;
$fn$;

COMMENT ON FUNCTION public.fn_diamond_lifetime_totals(uuid) IS
  'Lifetime diamonds earned (sum of positive rows) and spent (sum of |negative rows|) for one user, summed in SQL over the WHOLE ledger. SECURITY INVOKER: RLS on diamond_transactions decides visibility. Replaces two client-side 5,000-row sums (Club Arena DiamondService.getLifetimeStats, World Hub /api/store/diamond-transactions) that reported 0/0 on failure.';

REVOKE ALL ON FUNCTION public.fn_diamond_lifetime_totals(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_lifetime_totals(uuid) TO authenticated, service_role;

COMMIT;
