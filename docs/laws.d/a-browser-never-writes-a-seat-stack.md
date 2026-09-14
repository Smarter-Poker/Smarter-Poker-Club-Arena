# tests/a-browser-never-writes-a-seat-stack.law.test.ts

The deleted `AutoRebuyService` skipped `atomic_table_rebuy` - one plpgsql
transaction that debits the wallet and credits the seat together - for a bare
`table_seats.update({ stack })` read-modify-write with no wallet leg, no
idempotency key and no atomicity. It produced 268 `Auto-rebuy failed` reports
across 160 horses and the double-debit that commit 6d5cbfdaf4 removed the
service to end. This keeps every file under `src/` out of the `stack` column,
and pins the horse rebuy to `fn_horse_fund_from_treasury` with an op_id
derived from table+user+hand so a retry cannot fund a horse twice.
