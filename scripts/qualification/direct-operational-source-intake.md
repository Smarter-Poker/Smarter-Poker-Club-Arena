# Direct operational source intake — source candidate

Status: native qualification pending. This source is composed into PR4722;
production installation and publication remain separate, uncompleted steps.
The current required `test-production-alert-core-postgres.py` job is extended;
there is no new job, watcher, cron, sender, financial decision or release route.

## Exact change and evidence

Fresh installed catalog was observed at 2026-09-17 05:16:36 UTC, after the
05:04:17 producer-body capture. Both are retained in
`fixtures/direct-operational-source-intake/authority.json`, including their
original query/result and source capture hash. Function preimages:

- `fn_record_engine_alerts(jsonb)`: `2baee523d4b95afa879c230f4a5ff4f0`.
- Generic inbox recorder: `36601e205494e8768f5a1dce09f4a186`, unchanged.
- Current financial bridge: `00a43ae03ab12cec9505e2bfed71d937`, unchanged.

The new component adds three AFTER row hooks, immutable private full financial
and drift snapshots (plus oversized engine snapshots), separate explicit pending/captured delivery state, and a
strict engine replay call. Engine public receipts, UUID collision rules, ordered
producer locks, legacy no-ID behavior and batch transaction are unchanged. The
predicted engine full-definition postimage is
`3b97b07170b81947137ee2adfc268717`; only native readback can validate that prediction.

Existing `*-backfill` and `*-updates` namespaces/keys are preserved. Normal-sized
payloads retain `original_event` / `original_incident`. On first observation by
UPDATE, OLD is captured before NEW; it is not relabeled as the historical initial
state. A digest collision compares the entire JSONB and fails. An identical
snapshot returning later is still deduplicated, not a count of every UPDATE.

The first stored snapshot owns first-observed identity even if its inbox attempt
fails. A later exact snapshot cannot take the original key while that first
snapshot is pending. Out-of-order explicit attempts remain pending; no scheduled
retry is introduced. Existing old originals are retained, and legitimate changed
rows use their digest keys. New INSERT collisions do not overwrite originals.

## Acknowledgement and failure boundaries

Engine capture and replay are strict. A failed inbox write or wrong receipt
aborts the engine transaction. No successful engine acknowledgement may rely
only on its previously committed producer receipt.

A valid engine RPC can expand beyond the inbox bound when its labels are copied
into source columns. That complete engine row uses the same private reference
store, without a financial-style exception handler. Engine snapshot storage,
capture, delivery state and producer acknowledgement succeed or roll back in the
same transaction. Normal-sized engine rows keep their existing inline format.

Financial/drift snapshots are written in their source transaction before a nested
inbox attempt. An inbox failure leaves the complete immutable snapshot and a
pending error without changing the accepted financial/source outcome. The
service-only retry accepts one exact retained snapshot UUID; it never retries a
financial operation. No-op source updates do not call it.

If the snapshot store itself fails, PostgreSQL cannot guarantee both durable
full evidence and unconditional money progress. The source catches ordinary
storage errors, retains the existing source outcome, and emits an explicit
PostgreSQL WARNING with source identity/digest/SQLSTATE. It does **not** fabricate
a pending row or success. Query cancellation and shutdown are not swallowed.
This is an explicit remaining evidence-loss boundary, not guaranteed delivery.
No new timeout is imposed on a caller's financial transaction; its existing
transaction cancellation policy still applies.

Already-existing no-DML financial dedupe returns do not generate a new source
transition. The fixture verifies an original captured in the same lineage remains
present on dedupe replay. Historical missing captures still need the authorized
finite intake; this hook does not claim to reconstruct them.

## Oversized evidence and the actual reader

A full row exceeding the existing 262144-byte inbox envelope remains unchanged
in the immutable private store. The inbox envelope uses
`evidence_storage=immutable_reference` and an exact descriptor: format,
snapshot UUID, source kind/ID, digest and full JSONB text byte count. It never
claims to contain the full original inline. `fn_read_operational_source_snapshot`
accepts one exact inbox ID, validates descriptor, actual stored row, classification,
namespace/key and task, and returns the full row. Ordinary roles cannot read the
store or invoke the reader; service can read, but cannot change evidence.

Consumers must call this reader for reference envelopes. No direct event-to-Codex
turn admission has been installed or proved. The proposed source does not make
queue persistence a chat-delivery claim. The former heartbeat remains paused.

A missing task is accepted only for an already-observed finite-reader legacy
envelope with string `captured_at` and `backfill_window_start`, absent/new-unknown
snapshot marker rejected, and full identity/classification equality. References
and new capture markers require the fixed task. After any recorder call, the
returned receipt must have the exact fixed task; a racing legacy finite reader
may therefore cause explicit failure/pending followed by an owner-event retry.
A non-null wrong task always fails. This is compatibility for trusted retained
reader envelopes, not authentication of arbitrary administrative JSON.

## Installation and retaining rollback

`supabase/components/direct-operational-source-intake.sql` is first-install only.
An existing namespace or new entrypoint refuses, rather than silently repairing
or replacing it. Its transaction verifies exact current function authority and
five relation schemas/constraints/index definitions/policies/ACL/trigger bodies.
Role OIDs are compared by their freshly confirmed names; index definitions are
sorted independently of creation OID. The source and stored authority retain the
original OIDs as provenance only. A second install is deliberately not replay.

An owner-provided exclusion of target/dependency DDL must span the first guard,
installation and final readback. Table locks do not serialize arbitrary function
redefinition; this file does not pretend that they do. Current installed source
must be reread at release, and the same guard must pass. No old source is assumed
installed. There is no historical alert backfill in the install.

Rollback requires the exact new function bodies/ACLs and trigger bindings,
restores only the old engine recorder, and removes active source capture/retry
entrypoints. It retains all full snapshots, pending delivery records, inbox
receipts, immutability guards and read-only hydration. No source/history/financial
row is deleted. Reinstallation after rollback needs an explicitly reviewed
retained-store migration; the first-install guard intentionally refuses it.

## Timestamp representation compatibility

New row serialization uses UTC. Previously captured JSON remains exactly as
retained, including offset spelling, fractional precision and every other field.
JSON snapshots are compared as JSON; equivalent timestamp instants do not make
different JSON strings the same snapshot. On replay or UPDATE, a UTC observation
that differs only in representation therefore receives its own digest-keyed
`*-updates` record linked to the unchanged original. Its `snapshot_kind` records
the actual observation (`replay`, `update_old`, or `update_new`), not a claim that
game or financial state changed. A repeated identical UTC replay creates nothing
more. INSERT with an already-existing differing original is still a collision.

The native case creates a genuine finite-reader original under America/Chicago,
proves that its timestamp instants and other fields match the UTC row, and then
requires two distinct unchanged snapshots. Timestamp casts appear only in this
test oracle, never in production equality/digest computation. The legacy envelope
compatibility is shape validation within the existing trusted service-writer
boundary; it is not cryptographic proof of which historical reader wrote it.

## Existing required native seam and remaining qualification

The existing CI `production-alert-core` stage restores its real notification,
financial bridge, 21-argument incident raiser and resolution chain. New input
`engine-catalog.sql` supplies only the genuinely missing current engine relations,
receipt function and exact missing captured indexes; no financial writer is
stubbed or disabled. Sequence owner/ACL/bounds were separately observed at
05:22:56 UTC (bigint bounds as exact text). The original fixed budgets and cleanup
are retained. A pre-component producer receipt proves the absent-inbox baseline.

The new rollback-scoped SQL asserts actual producer/trigger capture, old engine
replay, collision refusal, engine info compatibility, changed/no-op rows,
financial dedupe, admitted/rejected nested resolution, both occurrence snapshots,
inbox failure/source survival/pending retry, full oversized hydration, wrong
reference/task rejection, local storage failure diagnostics, immutable evidence,
and private permissions. It also refuses extra same-name capture hooks on either
non-source relation. The engine boundary case calls the unchanged RPC with a
valid batch below its 262144-byte bound whose copied full row exceeds the inbox
bound; it requires exact reference hydration/replay and atomic storage refusal.
The existing required wrapper test rejects omission of any executed input and
rejects wrong/missing blocker identities or an unrelated race failure.

Four subsequent committed schedules use two actual psql sessions and a third
read-only `pg_stat_activity` / `pg_blocking_pids` observation. The holder commits
only after its exact live backend is observed blocking the exact waiter:

- Finite engine reader wins: its unchanged old envelope has no target marker;
  the in-flight strict ACK must fail with the exact collision, and a new explicit
  replay can accept that now-retained legacy original without mutation.
- Engine capture wins: the finite reader waits, returns the existing ID, and
  preserves the captured original with its fixed task.
- Two old engine receipts are replayed in reversed overlapping batches. The
  actual ordered producer locks serialize them; each public receipt remains in
  input order and each engine row has exactly one inbox original.
- Finite financial reader wins against an actual source UPDATE. Its old envelope
  stays intact; the old snapshot retains a pending collision, while the actual
  updated row commits with its separately linked captured snapshot.

The original work deadline remains 240 seconds and owned cluster cleanup remains
30 seconds. Race readiness/commit is at most 12 seconds within that same work
deadline; overlap observation must occur within 2 seconds, before the unchanged
3-second SQL lock timeout. Missing overlap, client failure or wrong error is a
failure. Logs and exact backend observations are retained. Killing a client is
never accepted as proof of database retirement; final allocation shutdown and
PID/socket absence remain mandatory, with sticky cleanup failures.

After rollback-scoped tests prove the full selected committed baseline unchanged,
the schedules deliberately commit only disposable source evidence. Financial and
engine oversized references, the financial pending record, ordinary captured
rows and legacy offset evidence all survive component rollback. Independent
sessions compare complete ordered JSON row state before/after, without floating
point conversion or digest-only equality, and hydrate full references after the
active capture hooks/retry API are removed. The original invoice positive still
runs using its real payment chain after these checks. No test evidence is deleted
to manufacture an empty-state result. No assertion was executed here.

Remaining release gates, explicitly not claimed by these source cases:

1. Execute the existing required native job on these exact final bytes; establish
   actual guard/provider parity, permissions, predicted function postimage and
   outer rollback/cleanup. The preceding engine/notification/core category has
   existing successful checks; there is no successful direct-source bridge baseline.
2. Qualify the implemented separate-session and nonempty retaining-rollback cases
   under that same job. Source completeness is not a concurrency or retention pass.
3. Independent source review, exact production catalog/DDL exclusion, guarded
   installation/readback and safe real-event receipts. No synthetic production
   gameplay or alerts are needed.
4. The actual task consumer must use the finite reference reader. Direct event
   admission into this chat remains a separate missing capability; neither stored
   target metadata nor this native SQL gate establishes it.
