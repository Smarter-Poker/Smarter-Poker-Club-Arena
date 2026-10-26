# Cashier history and authority recovery (2026-10-25)

Three cashier defects found by a line-by-line review of the PR #8059 / #8063 work, each reproduced by a regression that fails before the fix and passes after it (`tests/cashier-club-load-order.test.tsx`):

1. **A failed history refresh no longer leaves a silent gap.** If a balance-event refresh failed while Load Older was in flight, the late older page landed on the emptied list, and Retry merged it under a fresh first page, dropping every row between the two. The failure now retires the pending older page and forgets the filter key, so Retry starts from page one.
2. **History opened while a `/clubs/<slug>/cashier` link resolves stays open.** The club reset effect sent the viewer back to Trade when the slug lookup landed. It now returns to Trade only on a move from one real club to another.
3. **An unreadable live authority check offers Retry.** It used to lock every money action silently while the status read "Balances Synchronized" and History sat on "Loading Transactions...". It now shows "Cashier Access Could Not Be Verified" with Retry, on Trade and on History.

Also: the Lightning readiness law now checks both directions (see `docs/laws.d/lightning-readiness-names-its-tables.md`).
