# 2026-09-28: the Horse decision journal cannot stop for good because its archive is full

Horse Brain only; no money path, no schema version bump, no engine configuration change.

## What happened

Read-only on the engine host at 03:08 UTC, release `41b91390f6` (container started 00:56:14Z): `/health.horseJournal` was `failed` at `retry_exhausted` since 01:04:07.621Z, `publishers {total 2, byMode {failed 2}}`, `compressedBytes 8589934095` of `maxBytes 8589934592`, 723,624 segments of which 237,613 held, `retired=4098`. From 01:04Z no Horse decision was journaled, so no Phase 6 gate could be verified on the release.

The engine log has one ring line per writer lifetime and the two stops:

| UTC           | line                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------- |
| 01:03:30.193  | `archive ring retired its oldest published segment so capture keeps running` (first retirement) |
| 01:03:31.848  | the same, the other shard's writer                                                              |
| 01:04:07.623  | `capture stopped mode=failed reason=retry_exhausted`                                            |
| 01:09:49      | ring line (a replacement writer on the surviving shard)                                         |
| 01:18:12, :35 | ring lines (two more replacements)                                                              |
| 01:20:19      | `capture stopped mode=failed reason=termination_unverified`                                     |

`horse_brain_flush_receipts` (`phase15_journal_*`, per shard, per minute) shows what the ring did to capture. On the previous release `cfe8a739` each shard recorded 3,400 to 5,500 records a minute until 00:05; the archive reached its byte bound at 00:06, and from that minute one shard stopped (`retry_exhausted`, 13 lock retries, 3 replacements) and the other recorded 350 to 500 a minute, dropping 3,000 to 4,000 a minute at the 64-record queue bound. On `41b91390` the archive was already full, so the same shape began at the first append: at 01:04 shard `ff8759b0` had 30 lock retries, two replacements and `retry_exhausted`; shard `a9d76e82` recorded 320 to 576 a minute (16 records a batch, so an append every two seconds or so) and dropped 3,000 to 5,800 a minute until it stopped at 01:20 with `termination_unverified`.

## Cause

Not the evidence hold. 486,011 published segments outside the hold were still retirable (run 1, 2026-09-17 and 18, below the hold, is what the ring was retiring), and a ring with nothing to retire pauses by name (`archive_bytes`), it does not fail.

The cause is one line of SQLite behaviour. `archive_events.segment_sha` is declared `REFERENCES archive_segments(sha)`, the catalog connection opened with `enableForeignKeyConstraints: true`, and there is no index on `segment_sha`. So every `DELETE FROM archive_segments WHERE sha=?` in `retireSegment` made SQLite search for child rows by scanning the whole events table: `EXPLAIN QUERY PLAN` reads `SEARCH archive_segments USING INDEX ... | SCAN archive_events`. Measured: about 0.13 s per million rows on a 2-CPU Linux box, 2.5 s for 49 retirements over 600,000 rows on the Mac Studio; production had 5.4 million rows. Once the archive is at its bound every append retires at least one segment, so every append held the shared catalog's write lock for about a second or more:

1. The other shard's writer met SQLite BUSY on every attempt and exhausted its 12 lock retries (#5480), so the publisher replaced it; the replacement opening the catalog met the same lock, and after two replacements the shard stopped at `retry_exhausted`.
2. An append that had to retire several segments outran the five-second progress watchdog; the writer was retired while still inside a native scan, `terminate()` could not confirm inside the one-second fence, and the shard stopped at `termination_unverified`.
3. Both stops were terminal for the life of the process, although the condition behind them passes.

## Fix

1. **A retirement never scans the catalog.** The catalog connection opens with foreign-key enforcement off (`HORSE_ARCHIVE_CATALOG_CONNECTION`). The invariant the constraint guarded is kept by the only code that can break it: an event row is inserted only in `finishPending`, in the transaction that inserts its segment row, and `retireSegment` deletes exactly the segment's `records` rows before its catalog row and refuses as index corruption otherwise (unchanged). Every statement a retirement runs is a rowid or primary-key search, and `RING_STATEMENTS` lists them so a test proves that under the writer's own connection options.
2. **The evidence hold has its own budget.** Held segments count against every quota, so a hold as large as the allocation would leave the ring nothing to retire. The hold may now keep at most half of each quota (bytes, segments, records: `horseJournalHoldBudget`); the other half always belongs to new capture. A window whose segments exceed the budget keeps its oldest segments up to it (for the default window, the start of the only Phase 6A/6B capture), says so in one log line, and records how many it released in `archive_hold.trimmed_segments`; the rest become the ring's. The hold's bytes are recorded in `archive_hold.bytes`. Both columns are added in place (`ALTER TABLE ... ADD COLUMN`) to the table an earlier writer made. On production the default hold is about 1.49 GB of 8 GiB and 237,613 of 2,000,000 segments, well inside its budget: nothing is trimmed, and the 6A/6B evidence stays exactly as held.
3. **A stopped capture re-arms itself.** A publisher that stopped at `retry_exhausted`, `termination_unverified` or `restart_failed` starts a fresh writer, with a fresh budget and the queue it kept, once a minute (`HORSE_JOURNAL_REARM_MS`), and only after the writer it retired has actually exited (the `terminate()` promise itself, not the one-second fence), so it never owns two live writers. It keeps doing so until a writer captures. Integrity refusals (`ack_mismatch`, `writer_unavailable`), a journal that never started, a missing restart and shutdown stay terminal. Counted as `phase15_journal_rearm_started`.
4. **`/health` says which.** `horseJournal` adds `heldBytes`, `holdBudgetBytes` and `holdTrimmedSegments`, and the capture sentence carries them. A pause at a ring quota while segments are held reads `...: the evidence hold is crowding capture, no published segment outside it is left to retire ...`; without a hold it reads `... with no published segment left to retire (only unpublished segments remain) ...`. A re-armable stop reads `capture stopped at <reason> since <time>; a fresh writer is started every minute until one captures`; only a terminal one still says `stopped for good`.

Why this design and not the alternatives: an index on `segment_sha` would also end the scan, but building it on a five-million-row catalog at open outlasts the writer's five-second start fence and adds about 400 MB of catalog pages. Exporting or compacting the hold would keep all of it and all of capture, but nothing ships segments off the host yet; the budget is what guarantees capture now, and on this host it trims nothing.

## Pinned by

`server/src/services/horseDecisionJournal/holdCannotStarve.test.ts`. On unfixed `main` 8 of its 10 tests fail, among them: one append at the byte bound over a 600,000-row catalog took 2,502 ms for its 49 retirements (the test allows 1,000; fixed, the same append took 77 ms, about 1.6 ms a retirement), a hold over the whole full archive refused the next append, and a publisher at `retry_exhausted` never started another writer. With the fix all pass, as do the journal suites (`HorseDecisionJournal.test.ts`, `horseDecisionJournal/*.test.ts`, `handlers/health.test.ts`, `engine/HorseDataLedger.test.ts`: 356 tests). The existing test that pinned "a hold of every segment refuses the next append" now pins the budget instead.

## What to watch after the release

The running engine stays `failed` until a release containing this change serves at a :55 break; it was not touched. After it:

- `/health.horseJournal.mode` reads `ready` on both shards (`publishers.byMode.ready: 2`), `heldSegments` 237,613, `holdTrimmedSegments` 0, `heldBytes` about 1.49e9, `holdBudgetBytes` 4294967296.
- `retiredSegments` climbs from 4,098 while `compressedBytes` stays at or under `maxBytes`: the ring is retiring run 1 (2026-09-17/18) at the rate new capture needs.
- `phase15_journal_recorded` per shard returns to thousands a minute, with `queue_capacity` and `capture_unavailable` near zero and no `retry_exhausted`.
- A `capture stopped` line followed within a minute by `capture re-armed with a fresh writer` means the re-arm worked; the cause of the stop is then its own defect.
