# Original source read witnesses

The source reader returns the database snapshot identity, read time, hand and
byte counts, source interval and digest. Journal preparation formerly retained
the interval and digest but discarded the rest. Recovering that batch could
not identify its original database read boundary.

New acquisition claims advertise source-witness version 1. The compiled adapter
captures a canonical tuple directly from the validated source response and
sends it with the journal payload in its existing finish call. The service-only
finish wrapper binds the witness to the batch's actor, interval and source
digest, checks the PostgreSQL snapshot format, and caps the witness at 8 KiB.
It preserves the original five-second call budget and adds no network round trip.

The wrapper locks the original request and invokes the existing fenced finish
function. Journal admission, cursor advancement, receipt and source witness
commit in the same transaction. A lost acknowledgment replays only the original
payload and witness bytes; a changed witness cannot replace the first read,
even after a newer lease. Failure while recording the witness rolls back the
entire acquisition. Deferred, refined and gap outcomes do not create witnesses.
Unavailable source metadata defers rather than silently admitting an
unwitnessed payload.

Historical receipts with no witness remain unchanged. A later read cannot
retroactively attest them. Older claims and older clients keep their acquisition
behavior; their receipts do not gain source provenance or coverage authority.
The private receipt table retains its existing grants and row security, and
bounded terminal retention removes witnesses with their receipts.

This is provenance, not a complete-window certificate. A database snapshot is
a point-in-time visibility boundary, and hand timestamps can precede commit.
Late commits, source retention loss, rejected observations and differing slice
snapshots still require reconciliation before source completeness can be
asserted. No model receives a new complete flag, and no adaptive policy is
activated. The existing financial writers, source reader and journal writer
are unchanged. PostgreSQL documents the distinction between
[transaction, statement and wall-clock timestamps](https://www.postgresql.org/docs/17/functions-datetime.html)
and [transaction snapshot visibility](https://www.postgresql.org/docs/17/functions-info.html).

Verification passed TypeScript compilation, 65 focused checks and 11,879
server tests across 801 files in 65.07 seconds (145 existing skipped tests and
one skipped file). The native PostgreSQL 17 proof passed 57 groups, including
13 invalid-witness cases, both legacy receipt representations, exact replay
across leases, journal-capacity refusal, whole-transaction rollback on a witness
write failure, role isolation and retention. The actual compiled worker recorded
both source witnesses across a termination between slices, completed three
journal batches, and stopped without another RPC. Its local database and all
child threads were removed or stopped.

The first focused run exposed two fixture errors: a mutation used a readonly
property assignment, and a supposed oversized snapshot string was actually below
the 8 KiB limit. The fixtures now mutate explicitly and exceed the actual byte
budget; the failed run remains in task evidence. No production fixture hands
or learning writes were made.

The exact source binding and verification artifacts remain in the task record.
Merge, database migration, served engine identity and natural execution remain
separate acceptance facts. This does not complete Phase 14.
