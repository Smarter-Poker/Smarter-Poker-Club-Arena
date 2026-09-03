-- ============================================================================
-- Migration: remove the 96 phantom prize ledger rows, reversibly
-- Date:      2026-08-22 · Tier: 3 (deletes rows — ROLLBACK below, and nothing
--            is deleted that is not first archived in full)
-- Applied to production 2026-08-22 as `archive_phantom_prize_ledger_rows`.
-- ============================================================================
--
-- The defect is fixed in code by PR #248 (fn_credit_and_log). This is the data
-- left behind by it: prize credits logged twice for the same tournament,
-- player and amount, because the CREDIT deduped under the shared key
-- `tourney:{id}:prize:{user}:{place}` and the LEDGER WRITE did not.
--
-- 96 groups, every one exactly two rows, every one carrying a
-- "(recovery)" row from the stuck-COMPLETING watchdog. 7,450.45 chips of prize
-- money in `wallet_transactions` that was never paid to anybody.
--
-- IT WAS NOT COSMETIC. `fn_tournament_payout_reconcile` sums prize credits per
-- player per tournament, so these read as OVERPAYMENTS: 97 unresolved critical
-- `financial_alerts`, all false, for two days. That is how a real overpayment
-- gets missed.
--
-- Player balances were never wrong and are not touched here. The chips did not
-- move; only the record of them did.
--
-- ROLLBACK — every removed row is archived complete, as jsonb:
--
--   INSERT INTO public.wallet_transactions
--   SELECT * FROM jsonb_populate_recordset(
--            NULL::public.wallet_transactions,
--            (SELECT jsonb_agg(row) FROM public.wallet_transactions_phantom_archive));
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.wallet_transactions_phantom_archive (
  id              uuid PRIMARY KEY,
  archived_at     timestamptz NOT NULL DEFAULT now(),
  reason          text        NOT NULL,
  kept_row_id     uuid,
  row             jsonb       NOT NULL
);

COMMENT ON TABLE public.wallet_transactions_phantom_archive IS
  'Complete wallet_transactions rows removed as phantom duplicates, with the id '
  'of the row kept in their place. Written 2026-08-22 for the credit-then-log '
  'double-entry defect fixed in Club Arena PR #248.';

REVOKE ALL ON TABLE public.wallet_transactions_phantom_archive FROM PUBLIC;
REVOKE ALL ON TABLE public.wallet_transactions_phantom_archive FROM anon;
REVOKE ALL ON TABLE public.wallet_transactions_phantom_archive FROM authenticated;
ALTER TABLE public.wallet_transactions_phantom_archive ENABLE ROW LEVEL SECURITY;

-- The archive-then-delete body, with its guard rails, is recorded in the
-- production migration of the same name and in
-- .agent/audits/2026-08-22-null-multiplier-spins-and-the-double-ledger.md.
-- It refuses to run if it finds more than 200 candidates, if any row marked
-- for removal has no surviving sibling, or if a duplicate group remains
-- afterwards. Re-running it is a no-op: it selects only groups of >1, and
-- there are none.
