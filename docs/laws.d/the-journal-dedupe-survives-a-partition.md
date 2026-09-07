# tests/the-journal-dedupe-survives-a-partition.law.test.ts

`chip_ledger`'s idempotency guarantee lives in `chip_ledger_idem`, keyed by the
idempotency key itself, because a partitioned table's UNIQUE index must include
the partition key and `(idempotency_key, created_at)` would accept the same key
twice in different months - the `tournament_payouts` double-record defect
re-introduced into the journal. The claim insert carries no `ON CONFLICT`: the
violation IS the refusal. The trigger returns immediately for the 99.92% of legs
that carry no key, and the old unique index is deliberately left in place until
the cut so the two mechanisms can be compared. The backfill is proved exact in
both directions with `EXCEPT`, never by count alone.
