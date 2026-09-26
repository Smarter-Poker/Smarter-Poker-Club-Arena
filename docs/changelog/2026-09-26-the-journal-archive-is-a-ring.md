# 2026-09-26: the Horse decision journal archive is a ring, and capture keeps running

## What broke

Read-only on the engine host on 2026-09-26 14:28 UTC: `/health.horseJournal` was `paused` at `archive_segments` with 500,000 published segments, 4,139,804 records, 6.48 GB compressed and 9.7 GB on disk of a 75 GB disk with 21 GB free. #5270 had made the quota a pause instead of a death, but nothing made room: capture had been stopped since 2026-09-25 19:34:05 UTC and Phases 6C and 6D need it.

## What changed

- The archive allocation is a ring. When a batch would exceed the segment, record, byte or catalog quota, the writer retires the oldest published segments, oldest first, inside the reservation transaction until the batch fits, then records it. Only rows of `archive_segments` are candidates; a reserved batch in `archive_pending` is never retired, so only unpublished segments can hold capture at a quota. A batch that could not fit an empty archive is refused before anything is retired. The filesystem's free space is not a ring quota.
- A retirement removes the index rows, the catalog row and the usage together, names the file in the new `archive_retired` table and unlinks it after the commit; an interrupted unlink is finished at the next open or append. Cumulative counts live in the new `archive_ring` table. No schema version bump; no timer, watcher or job.
- The read-only capacity probe answers room when the append would retire to make it.
- `/health.horseJournal` adds `segments`, `maxSegments`, `publishedSegments`, `retiredSegments`, `retiredRecords`, `compressedBytes`, `maxBytes` and a `capture` sentence saying whether capture runs and why, with retained/published/unpublished/retired counts, built on the serving thread from finite fields.
- `HORSE_DECISION_JOURNAL_ARCHIVE_MAX_SEGMENTS` (default and ceiling 500,000, about eight days on the host) is the ring's length; the host configuration is unchanged.

Details, the measured host state and what remains: `docs/horse-brain-journal-retention-2026-09-26.md`.
