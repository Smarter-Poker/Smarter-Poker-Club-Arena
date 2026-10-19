# The first archived Spin recognition period and the seven-report window roll forward (2026-10-19)

At 2026-10-19T07:00:00Z the weekly window two accounting qualifications pin closed. Since then every pull request fails `Server Engine (typecheck + tests)`:

- Accounting PostgreSQL shard 1 refuses the `first-archived-spin` image with `ARCHIVE_RECOGNITION_PERIOD_CAPTURE_EXPIRED`. Seen on #7419, #7420 and #7406.
- Shard 3 refuses `actual-b9-current-seven-report-cash-conservation` with `exactsevenactualheldsource_refused`.

## First archived Spin

This is the same weekly rollover as #6734 (2026-10-12) and #5524.

- New read-only production capture at `2026-10-19T10:58:12.215982Z`, made with the unchanged maintained query (query sha256 `67f65046...`).
  - Period: `2026-10-19T07:00:00Z..2026-10-26T07:00:00Z`.
  - Zero blocking runs and zero overlapping runs.
  - The same two routing scopes as last week.
- The raw capture and the active temporal state carry the new evidence. The 2026-10-12 record moves to recognition period history unchanged.
- The seven carriers move their window one week forward.
- The completion SQL pin, the rollback probe pin, the manifest and the CI manifest hash are recomputed from the exact bytes.

## Seven-report window

Fixed on main by #7432 (the report period follows the recorded discharge). The interim copy of #7420's bytes is dropped in favour of main's.

No production write, DDL, migration, settlement operation, amount, function or engine behavior is part of this change.
