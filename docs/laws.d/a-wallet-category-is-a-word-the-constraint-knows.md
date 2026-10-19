# tests/a-wallet-category-is-a-word-the-constraint-knows.law.test.ts

A wallet category is a word the constraint knows. `wallet_transactions.category`
is closed by `wallet_transactions_category_check`; a word outside that list does
not become a badly-labelled row, it raises 23514 and takes its whole transaction
with it. Pins three copies of one vocabulary to each other: the constraint as the
migration defines it, the `WALLET_TRANSACTION_CATEGORIES` list the TypeScript
types are derived from, and every literal category any source file hands to
`log_wallet_transaction` or `WalletService.logTransaction`. Also pins that the
two refused spellings are never added to the constraint as a shortcut - the
spelling was the defect, not the vocabulary. Written after the same defect was
paid for twice: `HydraService.seatHorse` logged a horse buy-in as `'buy_in'`
against a constraint that only knows `'buyin'` (8,535 rejected duplicate writes,
333 horses, 2,016,133.30 chips, 2026-04-01 to 2026-04-14 - no money lost, the
correct receipt was written two lines above and the failing call was never
awaited), and `fn_payout_leaderboard` credited `'leaderboard_payout'` before the
constraint knew it, which aborted every leaderboard payout ever attempted until
migration 20260903225331 added the word.
