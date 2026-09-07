# tests/one-payment-is-one-payout-row.law.test.ts

A migration that credits a player through the platform's idempotent path
(`fn_credit_and_log`, `fn_tournament_payout_reconcile`) must NOT also INSERT
the `tournament_payouts` row: the credit path records the payout itself, and
doing both records one payment twice. Migration 20260906153943 did both, and
tournament 3e281f5c read as 142.50 paid against a 71.25 pool for six hours
while `chip_ledger` showed the money had moved exactly once. The database half
of the rule is `zz_a_payout_row_carries_its_key`, which derives an idempotency
key for any row whose writer supplies none - never refusing the row - so the
partial unique index on that column finally covers all of them.
