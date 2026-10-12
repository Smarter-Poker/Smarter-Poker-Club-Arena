# tests/the-cashier-totals-dedup-is-bounded-by-its-range.law.test.ts

fn_cashier_statement_totals answered HTTP 500 to real club admins - 21 calls,
mean 3,482 ms, max 7,968.7 ms against the `authenticated` role's 8s
statement_timeout, 12 of 16 calls in 24h refused, and the page printed
"Unavailable For This Range". Three earlier migrations had already given both
branch scans purpose-built covering indexes and both were index-only and
optimal, so the cost sat where nobody had read: the `omitted_movements` CTE that
stops a chip_ledger movement being counted twice when a chip_transactions
receipt mirrors it. Its first arm filters club and range, but the only index
able to serve `metadata ? 'idempotency_key'` was
`ux_chip_transactions_idempotency_key`, keyed on the extracted key alone and
carrying neither column - so the planner scanned it IN FULL, every idempotent
receipt on the platform for all time, heap-visiting each to filter: 1,154
entries and 828 cold random reads to find 8, 2,709 ms of a 6,038 ms call. A
one-day range cost exactly what a ninety-two-day range cost, and the cost grew
with platform history rather than with what was asked for. This law pins the
partial index `idx_chip_tx_club_time_idempotency_key` (leading keys club_id and
created_at, the extracted key carried so the arm stays index-only, built
CONCURRENTLY because chip_transactions is on the live money path) AND the three
CTE predicates that are the only reason it can be range-scanned. Either half
failing is silent: the plan reverts, nothing goes red, and the timeout returns.
The residual cost - visibility-map heap fetches on freshly written pages, 3,947
on chip_transactions and 1,484 on chip_ledger for the default range - is not
query waste and is not pinned here; it is measured in
docs/changelog/2026-09-30-the-cashier-totals-dedup-reads-all-of-history.md.
