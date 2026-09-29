# 2026-09-27: the Horse decision journal ring holds the Phase 6A/6B evidence and is bounded by bytes

## What was wrong

Read-only on the engine host on 2026-09-27: the 500,000 archived segments are not eight days of play. They are 262,387 segments from 2026-09-17 15:02 to 2026-09-18 09:20 UTC (before Phase 6A, ended by the former 2 GiB catalog), nothing until 2026-09-25 15:47, and 237,613 segments from 15:47 to 19:34:05 UTC under release `778075b419`: the only Phase 6A/6B capture that exists. Current capture writes about 3.3 records a segment, so 500,000 segments last about eight hours. The ring merged in #5355 retires oldest first and nothing ships segments off the host, so within a day of its deploy it would have retired all of that evidence. The engine still serves `f2e484a3d1`, paused at `archive_segments` since 2026-09-26 14:13:54 UTC.

## What changed

- `HORSE_DECISION_JOURNAL_ARCHIVE_HOLD` (default `2026-09-18T21:56:28Z/2026-09-25T19:34:06Z`, or `none`): an explicit evidence hold. A writer resolves it at open to a contiguous run of catalog rowids, records it in the new `archive_hold` table, and the ring never retires those segments; it retires the oldest published segment below the hold, then above it. Only held or unpublished segments can stop capture, and then a quota refuses by name.
- The segment ceiling and default are 2,000,000 so the 8 GiB byte bound binds first on this host; the record cap stays at 8,000,000. About 18 hours of new play beside the held 1.49 GB, about 12 GB on a disk with 21 GB free.
- `/health.horseJournal` adds `heldSegments`, and the `capture` sentence carries `held=`.

Details, measured host state and what remains: `docs/horse-brain-journal-retention-2026-09-26.md`.
