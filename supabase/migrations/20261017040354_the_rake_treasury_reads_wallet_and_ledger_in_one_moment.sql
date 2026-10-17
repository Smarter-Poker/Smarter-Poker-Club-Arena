-- 20261017040354_the_rake_treasury_reads_wallet_and_ledger_in_one_moment
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-17 04:03:54 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
-- Say what was wrong, what this changes, and what you measured. A
-- migration whose header is its own filename is the next agent's mystery.
--
-- WHAT WAS WRONG
--
-- Dan's sweep (2026-10-17) read Midway Union's Rake Treasury detail as a
-- multi-million "drift" between the rake wallet and its ledger. There is no
-- money missing. Production, one REPEATABLE READ snapshot, 2026-10-17
-- 03:58 UTC: union_wallets.rake_wallet 2,849,954.40; the rake_wallet legs of
-- union_wallet_transactions (3,665,867 rows) credit 10,239,130.75 and debit
-- 7,389,176.35, net 2,849,954.40. Drift 0.00.
--
-- The panel compared two different moments. The World Hub route
-- (pages/api/club-arena/union-wallet.js, get_rake_detail) read the LIVE wallet
-- and, in a separate request, fn_union_rake_ledger_summary, which returns the
-- union_rake_ledger_checkpoint row ALONE: the lifetime sums as of cp.as_of,
-- which fn_union_rake_ledger_totals / _checkpoint_verify only ever advance to
-- now() - 1 hour and which had not advanced since 2026-10-16 22:17 (28,556
-- rake legs behind). A union whose tables credit rake every hand therefore
-- always showed every chip raked since the checkpoint as "drift", and the
-- labels on the dense panel made the credits figure read as the balance.
--
-- WHAT THIS CHANGES
--
-- Adds fn_union_rake_ledger_reconciliation(uuid): the checkpoint plus the
-- tail of rake legs at or after its as_of (the same partition
-- fn_union_rake_ledger_totals uses), and the rake wallet, in ONE statement,
-- so both readings share a snapshot and drift is computed in SQL. The tail is
-- an index-only scan of idx_uwt_rake_wallet_recon (28,556 rows, 16 ms on
-- production). It writes nothing, advances no checkpoint and is gated by
-- fn_union_report_caller_ok exactly like fn_union_rake_ledger_summary, which
-- is left untouched for any other caller. The World Hub route moves to it.
--
-- @live-proof: (SELECT p.prosecdef AND p.provolatile = 's' AND position('fn_union_report_caller_ok(p_union_id)' IN pg_get_functiondef(p.oid)) > 0 AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') FROM pg_proc p WHERE p.oid = 'public.fn_union_rake_ledger_reconciliation(uuid)'::regprocedure)

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_union_rake_ledger_reconciliation(p_union_id uuid)
RETURNS TABLE(
  credits          numeric,
  debits           numeric,
  net              numeric,
  rows_seen        bigint,
  as_of            timestamptz,
  last_verified_at timestamptz,
  through_day      date,
  wallet_balance   numeric,
  drift            numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  WITH cp AS (
    SELECT c.as_of, c.credits, c.debits, c.rows_seen, c.last_verified_at
      FROM public.union_rake_ledger_checkpoint c
     WHERE c.union_id = p_union_id
  ),
  tail AS (
    SELECT COALESCE(SUM(t.amount) FILTER (WHERE t.direction = 'credit'), 0) AS cr,
           COALESCE(SUM(t.amount) FILTER (WHERE t.direction = 'debit'), 0)  AS db,
           COUNT(*) AS n
      FROM public.union_wallet_transactions t
     WHERE t.union_id = p_union_id
       AND t.wallet = 'rake_wallet'
       AND t.created_at >= COALESCE((SELECT cp.as_of FROM cp), '-infinity'::timestamptz)
  ),
  w AS (
    SELECT uw.rake_wallet FROM public.union_wallets uw WHERE uw.union_id = p_union_id
  )
  SELECT
    (COALESCE(cp.credits, 0) + tail.cr)::numeric,
    (COALESCE(cp.debits, 0) + tail.db)::numeric,
    ((COALESCE(cp.credits, 0) + tail.cr) - (COALESCE(cp.debits, 0) + tail.db))::numeric,
    (COALESCE(cp.rows_seen, 0) + tail.n)::bigint,
    statement_timestamp(),
    cp.last_verified_at,
    (SELECT max(d.day)
       FROM public.club_rake_daily_user d
       JOIN public.fn_union_club_scope(p_union_id) s ON s.club_id = d.club_id),
    w.rake_wallet::numeric,
    CASE WHEN w.rake_wallet IS NULL THEN NULL
         ELSE round(w.rake_wallet
                    - ((COALESCE(cp.credits, 0) + tail.cr) - (COALESCE(cp.debits, 0) + tail.db)), 2)
    END
  FROM tail
  LEFT JOIN cp ON true
  LEFT JOIN w ON true
  WHERE public.fn_union_report_caller_ok(p_union_id);
$$;

REVOKE ALL ON FUNCTION public.fn_union_rake_ledger_reconciliation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_union_rake_ledger_reconciliation(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_union_rake_ledger_reconciliation(uuid) IS
  'Rake Treasury reconciliation: checkpoint plus tail and the rake wallet in one snapshot; read-only. 20261017040354.';

COMMIT;
