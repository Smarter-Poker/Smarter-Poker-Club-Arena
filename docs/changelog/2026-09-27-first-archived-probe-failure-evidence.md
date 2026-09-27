# First archived Spin probe preserves genuine failure evidence

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

## Management transport correction

A read-only production transport check on September 27 retained ERROR and
DETAIL but omitted a preceding NOTICE. Requiring that omitted NOTICE could
never verify the financial probe through this transport. The probe now invokes
the pinned original fee-capture owner separately under its actual service
context, inside an exception subtransaction before canonical completion. It
captures the real SQLSTATE, message and exception context and proves that the
provisional batch/source rows rolled back immediately. Unexpected success or
any different error aborts the entire probe. The final DETAIL identifies this
separate invocation honestly and binds it to the canonical admission's
transaction. It does not reconstruct the missing original canonical NOTICE.

Native qualification still requires that original canonical NOTICE separately.
The explicit management reader requires the structured refusal instead, and
rejects missing or altered evidence. Connected isolated cases verify release of
the original rake-row and fee locks before canonical completion, unexpected
success and missing-function refusals, full retained row rollback, and the
actual aborted transaction status. Derived fault SQL is separately identified
and source-bound; none is a production input. No sequence rollback is claimed.

The expected error precedes the reconciliation insert in the pinned owner.
That relation is not added to the finite fixture or claimed snapshotted. The
unavailable original fee terms and the original bank mismatch remain unresolved.
No installed function, migration, fee disposition or isolation policy changes.

## Lease timestamp observation correction

Hosted run 36325576281 refused the operation-authority check before cancellation.
Its original error omitted the individual values, so the exact failing field is
not known. Source inspection found an invalid equality: the captured lease owner
calls clock_timestamp() separately for acquisition and heartbeat, while the probe
required identical timestamps. The observer now requires both timestamps, an
acquisition no earlier than this transaction, and a heartbeat between acquisition
and the actual inside observation. Full lease identity and replay equality remain
required. Authority failures now retain the original admission, lease and time
bounds in DETAIL. The installed lease owner is unchanged. Native controls evaluate
the exact maintained predicate against equal, distinct, missing, reversed, old and
future timestamps. Qualification remains pending on this corrected candidate.

## Shared union bank observation

The original READ COMMITTED financial equality can observe an unrelated committed
union-bank update between its snapshots. A newly proposed observer captures each
financial projection, its PostgreSQL row version, transaction status and snapshot
bound together. It accepts a changed version only when that exact version is newer
than the probe's assigned transaction and independently committed. Own parent and
child transactions, unknown status, insertion/deletion, changed identity, malformed
metadata, frozen versions and an ambiguous transaction epoch remain refusals.
Both the first invocation and same-operation replay are checked. Other financial
stores and all admission, maintenance, custody and historical-source checks retain
their existing comparisons. Transaction isolation remains READ COMMITTED.

The additional `first-archived-spin-bank-mvcc` image uses the existing allocator
and captured owners. It explicitly inserts a synthetic zero-valued bank only
after the authentic fixture checks. Actual external committed updates retain their
immutable journal entries until normal allocation disposal; this variant never
claims those synthetic rows were rolled back or the original fixture restored.
Original nine images, including all original admission/committed concurrency
checks, remain mandatory. The additional variant exercises committed changes in
both observation intervals, own parent/subtransaction changes in both intervals,
own no-op and offsetting changes, and an external commit after observation.
Source-bound barriers and original SQL output distinguish actual concurrency
from synthetic parser controls. Post-abort verification and production use remain
unqualified until independently validated; no settlement or alert is closed by
this observer change.
