# 2026-09-26: the Horse decision journal pauses at its quota instead of dying, and /health says which

## What broke

Diagnosed read-only on production release 778075b4.

1. **A quota ended capture for the life of the process.** When the journal
   writer refused an append at a named archive quota (`archive_bytes`,
   `archive_segments`, `archive_catalog_capacity`,
   `archive_storage_capacity`), the publisher treated it like a broken writer:
   `fail()` set `mode = 'failed'`, cleared its timers, terminated the writer
   and never built a replacement. Every later `record()` answered
   `capture_unavailable`. On 2026-09-18 the 2 GiB catalog ceiling did this.
   On 2026-09-25 at 19:34:05 UTC it happened again at 500,000 segments
   (`[HorseDecisionJournal] capture stopped mode=failed reason=archive_segments`),
   and from then on telemetry counted `phase15_journal_capture_unavailable` in
   the millions per day with zero `enqueued`.
2. **/health said `starting` for seven hours.** From 19:34 UTC on 2026-09-25
   until at least 02:16 UTC on 2026-09-26, `/health.horseJournal` answered
   `{"mode": "starting", "lastFailureReason": null, "queued": 0, ...}` with
   every figure null while the publisher was failed. Root cause: the
   publisher lives in the Horse decision worker thread (`workerRuntime.ts`
   starts it), but `/health` is served by the main thread, whose own copy of
   `HorseDecisionJournal.ts` never has a publisher. With a journal directory
   configured and no local publisher, `horseDecisionJournalHealth()` fell
   through to `starting`. It could never have reported anything else in
   production, whatever the journal was doing.

## What changed

- **A. A quota is a condition, not a death sentence.** A named quota refusal
  of an in-flight append now puts the publisher in a named `paused` mode. It
  keeps the writer and the bounded queue (64 records or 4 MiB, dropping
  beyond that with `queue_capacity` exactly as before), stops dispatching,
  and once a minute sends the writer a read-only `PROBE` carrying the batch
  it would dispatch next. The store's new `capacityRefusal()` answers from
  the usage row, the catalog page counts and the filesystem's free space,
  using the same byte, segment and catalog checks the writer itself uses (now
  shared code, so the two cannot disagree). It never reserves, writes,
  finishes pending work or deletes anything. When there is room the
  publisher resumes `ready` and replays the kept queue with the same event
  ids and digests; the store answers any record it already holds as
  `replayed`, so nothing is written twice. A probe is not a retry: it does
  not spend the restart budget. `ack_mismatch` and every other integrity or
  writer refusal stays terminal, and so does a capacity report from a writer
  that never became ready (it has closed its port, so there is nothing to
  probe). One `console.warn` on entering pause, one on resuming.
- **Telemetry tells paused from failed.** `record()` while paused counts
  `phase15_journal_capture_paused_capacity` (the same call also counts its
  queue outcome). Entering and leaving count `phase15_journal_capacity_paused`
  and `phase15_journal_capacity_resumed`. All three are exact receipts in
  `HorseDataLedger.ts`, and the ledger's source check now reads the
  publisher's file.
- **B. /health tells the truth in every state.** The Horse decision worker's
  STATUS reply (already polled once a second) now carries the journal's own
  report, and the client relays it to the main thread. `horseJournal.mode` is
  one of `starting`, `ready`, `paused`, `recovering`, `failed`, `stopped`,
  `unavailable` or `disabled` (no journal directory), with
  `lastFailureReason`, `pausedReason`, `pausedSince`, `failedSince`, the last
  catalog figures the writer reported (kept, not cleared, on pause or
  failure) and `reportAgeMs`, the age of the relayed report. A malformed
  report is ignored and never fails the worker; only the finite field set
  crosses the thread boundary. Without a journal directory the section now
  reads `disabled` instead of being left out. The HTTP code is unchanged:
  `sendJSON(res, dealerReady ? 200 : 503, status)` stands.

## What is not changed

- **No quota, retention or deletion behaviour.** The byte, segment, record
  and catalog allocations, their defaults and their environment overrides are
  exactly as they were. No record is ever deleted; "No quota grants
  permission to delete records" in `horseDecisionJournal/config.ts` stands.
  Pausing only means capture waits for room instead of ending. Whether to
  raise a quota, rotate the archive or retain less is the owner's decision.
- A journal already at its segment quota stays paused until an operator
  makes room; this change makes that visible and recoverable, it does not
  make room.

## How it was tested

- `server/src/services/HorseDecisionJournal.test.ts`: for each of the four
  quota reasons a fake writer refuses an append; the publisher is `paused`
  (not `failed`), keeps its writer and queue, counts the paused key on
  `record()`, sends nothing before 60 s and one probe a minute after, stays
  paused on "no room", resumes `ready` on "room" and appends the queued
  records once with identical ids and digests, then stops probing. The queue
  bound holds while paused; stopping while paused is prompt and names the
  gap, as does a quota refusal while draining for shutdown. `ack_mismatch`
  still fails terminally, never probes, and a late
  "room" cannot revive it. Health shows `paused` with reason, time and the
  retained stats, and `failed` with reason, time and the retained stats.
  The store's probe agrees with the writer at the segment, byte and catalog
  quotas, changes nothing, and sees catalog room return; the real worker
  answers `PROBE` without writing. Health reads `disabled`, then `starting`,
  then the relayed report, and drops malformed or extra fields.
- `server/src/engine/horseDecision/client.test.ts`: a STATUS_RESULT carrying
  a failed, then paused, journal report reaches `horseDecisionJournalHealth()`
  on the client's thread. Before this change the same test failed with
  `expected { mode: 'starting', ... } to match object { mode: 'failed', ... }`,
  which is the production symptom.
- `server/src/handlers/health.test.ts`: the routing verdict is unchanged,
  and a body read through the default source carries `mode: disabled` when
  no journal is configured.
- `server/src/engine/HorseDataLedger.test.ts`: the three keys are exact
  receipts and are fired by the publisher.
- `npx tsc --noEmit -p server`, every server test that imports the journal,
  its worker, the Horse decision client/runtime/protocol or the health
  handler, the root release-seal and degraded-engine law tests, and the
  pre-commit checks.
