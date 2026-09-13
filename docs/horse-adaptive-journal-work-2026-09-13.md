# Durable adaptive journal work

A caller could lose the prepared snapshot between acquisition and journal
acknowledgment. The new work table first records the exact canonical public
batch, then a bounded processor claims it, revalidates the bytes, writes through
the existing immutable journal and acknowledges the exact stored receipt.
The queue contains no raw player name, private card, result or tunable policy.

`enqueueAdaptiveJournalWork` is the entry point after committed acquisition.
Its first RPC records the batch key, digest, count and payload. An identical
enqueue returns the durable identity; a changed payload cannot overwrite it.
A lost enqueue reply is unknown. Capacity refusal leaves the input unaccepted;
the source-discovery layer must retain or reacquire it and cannot advance a
completeness watermark merely because enqueue was attempted.

`processAdaptiveJournalWork` processes at most one job per invocation, with the
existing five-second client budget on each RPC. Claims use a thirty-second
database lease and skip locked rows. The token fences acknowledgments; an old
worker cannot complete a replacement worker's lease. The journal itself makes
concurrent immutable retries converge without incrementing observations.

Completion requires the journal's exact batch key, digest, observation count
and canonical payload. Only then does the queue clear its buffered payload.
Unknown write replies defer the original bytes with bounded exponential
backoff, from two seconds to sixty seconds. A known database rejection moves
the job into an explicit quarantine and retains its payload. Malformed claim
responses do not quarantine possibly valid stored work; their lease expires
and the next worker re-reads it. A lost completion reply remains unknown to the
caller even if the durable completion committed.

New work is capped at 256 unfinished jobs and 64 MiB total buffered payload,
including quarantine. Capacity reservations use a nonwaiting advisory lock.
Existing identical jobs remain replayable when new-work capacity is exhausted.
Partial indexes keep pending-work scans separate from completed history. All
three RPCs are service-only; RLS remains enabled and application roles have no
direct table permissions. There is no hot-table foreign key, settlement/table
trigger, timer, fleet change or adaptive-policy activation.

Native PostgreSQL checks exercise actual committed-controller observations
through queue, processor and journal; a fresh process receives only database
connection details and resumes the stored work. Proof covers receipt refusal
before recording, old-token refusal, restart after lease expiry, lost committed
write and acknowledgment replies, concurrent claims, capacity contention,
conflicting payloads, quarantine, the 257th job and the 64 MiB boundary. The
isolated fixture is stopped and removed afterward. Unit checks cover transport
and envelope failures separately.

This is durable processing after acquisition. A live source-discovery producer,
isolated scheduling/lifecycle ownership, retention of completed metadata and
old journal evidence, source-window completeness, scoped model consumption,
counterfactual evaluation and activation/rollback remain unfinished Phase 14
requirements. No claim of full learning-pipeline completion follows from this
queue or its tests.

Migration20260913181841 was applied once at18:31:33 UTC under history 20260913183133. All three function bodies, both queue indexes, RLS and
service-only permissions match the verified SQL; the production queue is empty.
Compilation,207focused checks and22native proof groups passed. The first full
run passed11,403tests with145existing skips but failed the Phase10CLI command
near its20-second limit. The same unchanged command later completed in5.91s
directly and its unmodified test passed in5.80s. That failure and retry evidence
are retained; the unchanged repeated full run passed11,404tests in775files with145existing skipped tests and one skipped file (201.22s). No timeout or
acceptance guard was relaxed.
