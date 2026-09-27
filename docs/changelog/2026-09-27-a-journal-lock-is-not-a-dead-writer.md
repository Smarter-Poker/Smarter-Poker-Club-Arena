# A journal lock is not a dead writer, and /health shows every decision shard

2026-09-27. Horse Brain only; no money path.

## What happened

Rerunning the Phase 6B bounded route proof on the serving release e6b9dc5d
(started 20:56:03Z), the engine's `/health` reported the Horse journal `ready`
before the read and `failed` (`termination_unverified`, since 21:22:51.994Z)
after it. Eight consecutive reads from one process answered `failed` once and
`ready` seven times.

The horse decision lane runs two worker shards (#5303, #5329), and each shard
starts its own journal publisher and writer on the one shared archive. Read
from `horse_brain_flush_receipts` (`phase15_journal_*`, per shard, per five
minutes): from about 21:07Z both writers were replaced 3 to 45 times per five
minutes and dropped 5,374 to 10,881 records per five minutes at the 64-record
queue bound; at 21:22:51 one shard stopped for good and from then on that
shard's tables captured nothing (11,000 to 22,000 records per five minutes
`capture_unavailable`), while the other shard, alone on the catalog, ran with
no replacement. Earlier releases on 2026-09-27 show the same shape (a shard
stopped and six-figure `capture_unavailable` counts per hour on 6b6eabb1,
c8cbe6e6, cbee6e60 and a3806102).

## Cause

1. `HorseDecisionJournalPublisher.message`: a writer's RETRYABLE (SQLite BUSY
   after the 250 ms busy timeout, because the other shard's writer held the
   catalog) was handled by `recover()`: terminate the writer, start a
   replacement, budget two, one-second termination fence. A lock is routine
   when two writers share a catalog, so the publisher kept tearing down healthy
   writers; each replacement reopened the multi-gigabyte catalog, the queue
   filled, and eventually a retiring writer did not confirm termination inside
   the fence and the fence ended capture for the life of the process.
2. `relayHorseDecisionJournalHealth`: one module-level slot for every shard's
   report, so `/health` showed whichever shard had answered last.

## Fix

1. A RETRYABLE from a ready writer with a batch in flight is retried on the
   same writer, with the same immutable records, after a bounded backoff
   (`HORSE_JOURNAL_LOCK_RETRY_DELAYS_MS`: 25, 50, 100, 200, 400, 800 ms then
   1 s, 12 steps). The writer rolled back and holds nothing; the store answers
   a record it already holds as `replayed`, so nothing is written twice. Only a
   batch refused 12 times in a row falls back to the replacement path, whose
   budget and fence are unchanged. The exact ACK and a new writer reset the
   lock budget. A lock before READY is still a replacement.
2. `/health` keeps one report per shard (`client.ts` names each shard). The
   mode, failure and pause fields are the least healthy shard's, the catalog
   figures the freshest shard's, `queued` the sum, and `publishers` counts the
   shards by mode; the capture sentence says how many shards are running.
3. The Phase 6B observer records `publishers` in its before and after reads.

## Pinned by

`server/src/services/horseDecisionJournal/retry.test.ts` ("a lock is not a dead
writer") and `server/src/services/HorseDecisionJournal.test.ts` ("/health shows
every decision shard" and "a competing writer on the shared archive is a lock,
not a dead writer"). The lock-retry and `/health` tests failed on the unfixed
source and pass with the fix.

## Not done here

The fix is not yet in a serving release; capture on e6b9dc5d stays split until
one that contains it serves. No engine configuration was changed.
