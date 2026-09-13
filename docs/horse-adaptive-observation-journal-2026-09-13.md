# Immutable qualified observation journal

Repeated committed-source acquisition previously had no durable observation
identity ledger. A retried or overlapping read could not prove which facts had
already survived a process restart. This journal stores version-one qualified
public observations once per committed hand/action identity. It reconstructs
evidence without incrementing lifetime counters.

`prepareAdaptiveJournalBatch` validates and canonicalizes one actor's committed
snapshot. Only the qualifier's public scope arrays, hashed identities, action
category, origin, session partition and source metadata are serialized. Private
names, cards, outcomes and arbitrary object fields are excluded. The batch key
binds the actor, committed source digest and source window; a separate digest
binds its exact canonical payload. Stable observation ordering makes reordered
input equivalent. The source digest remains tied to the committed acquisition,
including its rejected source entries; it is not a source-completeness watermark.

The committed source reader captures the actor and interval before its first
asynchronous call. Mutating the caller's object while that request is in flight
cannot change which response is accepted or which scope enters the source
digest. Both the valid original response and a substituted response are covered
by regressions that failed before the request capture was added.

`persistAdaptiveJournalSnapshot` sends one bounded transaction. The service-only
database function inserts observation identities in a common order and refuses
any changed payload for an existing identity. Any conflict rolls back the whole
batch, including earlier new observations in that transaction. A verified batch
receipt returns the same key, digest and observation count on replay. A lost
reply or malformed receipt is reported as unknown so callers can retry the same
snapshot; it is never described as a rolled-back write.

The recovery extension saves the exact canonical public payload in that same
batch transaction. `readAdaptiveJournalBatch` retrieves it by the previously
computed batch key, verifies the envelope hash, source identity, canonical
ordering, every public observation and all bounds, and returns frozen bytes.
`persistPreparedAdaptiveJournalBatch` retries those verified bytes. It never
acquires a replacement history snapshot. This is required because the original
source can change or expire while a process is down.

A missing receipt is unavailable, not proof of rollback. A legacy receipt with
no saved payload is explicitly `legacy_batch_payload_unavailable`; the extension
does not backfill guessed contents or change an existing receipt. Retrieval is
historical evidence of the recorded batch, not a current model window. A durable
ingestion job still must retain its expected batch key before submitting the
write. This extension does not supply that job queue or its progress watermark.

The read function takes actor, public scope, session partition, human/policy
cohort and an observation-time interval. One STABLE statement returns all
matching journaled observations or refuses an oversized result. The reader
validates every returned identity, scope, ordering, byte count and interval,
then freezes the resulting public evidence. Its coverage is explicitly
`journaled_qualified_observations`. It does not emit the scoped model's complete
window flag: uncommitted, uncaptured or uningested actions remain outside this
population. The interval includes its lower endpoint and excludes its upper.

Bounds are 20,000 observations, 16 MiB per batch/read, 16 KiB per observation,
8 KiB per scope and a 30-day eligible journal window. Source windows remain at
most six hours. The client uses the existing five-second abort budget; that
does not certify database cancellation. Concurrent writers wait at most the
function's two-second lock timeout before reporting an unknown outcome. No
direct table read, insert, update or delete is granted to application roles;
only service-role function execution is granted. Both new tables have RLS.
There is no hot-table foreign key, trigger, timer, money mutation, automatic
retention job or live decision caller.

Twenty-five boundary tests passed, including actual completed-controller
evidence, actor/scope validation, replay receipts, request mutation during a
read, conflict classification and refusal of partial results. Native PostgreSQL
17 verified three complete controller hands through the actual committed reader,
qualifier and journal, producing 12 observations. Replays preserved 12 identities;
a concurrent new identity produced 13, visible from a fresh Node process. Native
checks also cover cross-batch rollback, role privileges, 29 invalid input cases,
interval edges, concurrent snapshot visibility (4 before, 4 during, 5 after),
and complete refusal at 20,001 rows or over 16 MiB. The synthetic database was
stopped and removed. The first SQL run caught a CASE-expression syntax error;
another proof expectation was corrected to count a newly inserted fixture row.
Those failures are retained in the task evidence.

The original journal's separate 2,000-observation synthetic batch passed through the actual writer
and reader: 1,587,151 input bytes, 215 ms to store and 91 ms to read in one native
sample. This is not a production latency certification. Compilation and 161
focused checks passed. The complete server suite passed 11,309 tests in 769
files, with 145 existing skipped tests and one skipped file.

The recovery extension passed 184 final focused checks and 15 native proof
groups. A fresh Node process received only the batch key after its synthetic
source history was removed; it recovered the same 12-observation payload and
retried it without changing the 13 unique stored observations. Missing/legacy
payloads, substituted contents, service-only access and receipt visibility before
commit are covered. Native fixture shutdown and deletion were verified. The
final 2,000-observation sample recovered its exact 1,587,151 bytes in 114 ms;
concurrent local load makes this a single functional sample, not a production
capacity claim. The runtime passed a full 11,378-test server run with 145 existing
skips; two subsequent test-only historical/empty-batch cases passed in the final
focused run. Reserved migration 20260913175935 was applied once at 18:07:06 UTC
under history 20260913180706; both function bodies and permissions were verified.

This is the persistence component, not the complete Phase 14 learning pipeline.
No production PostgREST transport, durable acquisition cursor, ingestion cadence,
retention policy, full observation coverage, live consumer, causal counterfactual
utility, held-out uplift, activation or rollback is certified by these tests.
Those remain required before enabling adaptive behavior. Broader tests and
protected deployment receipts are recorded separately.
