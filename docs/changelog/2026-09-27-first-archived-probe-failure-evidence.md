# First archived Spin probe preserves bank-failure evidence

The first production rollback probe failed at its unchanged bank comparison on
2026-09-27 at approximately 14:04 UTC. Its `P0001` named `public.union_wallets`
but discarded the transaction's before and inside values. Independent readback
found no payout, admission or terminal record. Concurrent rake credits are
present in the bounded journal, but those observations do not establish the
specific delta that failed the comparison.

## Source correction

`scripts/qualification/fixtures/archived-spin/first-production-rollback-probe.sql`
previously raised a message alone at line 132. The same refusal now includes
the exact scoped financial projections, operation/event identity, transaction
ID, isolation mode and explicit incomplete-result flags in PostgreSQL DETAIL.
It still aborts. No comparison, admission guard, installed function, historical
source, financial amount or transaction isolation has been changed.

Repeatable-read isolation is not an interchangeable observer fix: the original
admission checks also read maintenance and accounting authority after waits.
Changing their snapshot could hide newly committed authority. That alternative
is not installed or qualified by this change.

## Verification and remaining work

The connected regression must provoke a genuine bank mismatch in the existing
isolated PostgreSQL allocation, retain the original diagnostic, confirm exact
values and an aborted transaction, and independently prove no durable row
changes. The unchanged successful probe and malformed diagnostic controls must
also pass. Qualification and delivery results are recorded in the task's
existing checkpoint. Production attribution, financial completion and the
oldest alert remain unresolved; additional diagnostics are not a settlement.

Source reread: verified after edit. Compiler and connected qualification:
pending on this follow-up candidate.
