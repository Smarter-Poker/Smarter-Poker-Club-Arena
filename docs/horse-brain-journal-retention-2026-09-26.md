# Horse Decision Journal Retention (Decision D4): The Ring Holds the Phase 6A/6B Evidence

Horses are players, and the journal captures every decision they make so Phases 6C and 6D can be reviewed from evidence. On 2026-09-25 at 19:34:05 UTC capture stopped at the archive's 500,000-segment quota. #5270 made that a pause instead of a death; #5355 made the quota a ring. This page is the policy as it stands after the follow-up of 2026-09-27, which corrects what #5355 measured, keeps the only Phase 6A/6B evidence ever captured from being retired, and makes bytes, not segment count, the ring's bound.

## The Host as Measured on 2026-09-27 (Read-Only, 14:10 to 14:36 UTC)

| Figure                       | Value                                                                                                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Serving release              | `f2e484a3d1`, which does not contain #5355: the ring is merged but not deployed                                                                                                    |
| `/health.horseJournal`       | `mode: paused`, `pausedReason: archive_segments`, `pausedSince: 2026-09-26T14:13:54Z`, `queued: 64`, `pendingSegments: 0`, `records: 4139804`, `catalogBytes: 2689761280`          |
| Disk (`df -h /`)             | 75 GB, 52 GB used, 21 GB free (72 percent)                                                                                                                                         |
| Journal directory (`du -sh`) | 9.7 GB; 500,000 segment files                                                                                                                                                      |
| Segments                     | 500,000 published, 0 unpublished                                                                                                                                                   |
| Run 1                        | rowids 1 to 262,387: 2026-09-17 15:02:45 to 2026-09-18 09:20:05 UTC, 16 records a segment, releases before Phase 6A; ended when the former 2 GiB catalog filled                    |
| Gap                          | 2026-09-18 09:20 to 2026-09-25 15:47 UTC: nothing was captured. Phase 6A reached production at 2026-09-18 21:56:28 UTC (`8825af5181`), inside the gap                              |
| Run 2                        | rowids 262,388 to 500,000: 2026-09-25 15:47:23 to 19:34:05 UTC, release `778075b419`: 237,613 segments, 780,363 records, 1.49 GB. This is the only Phase 6A/6B capture that exists |

So #5355's "eight days in 500,000 segments" was wrong. Current capture writes one segment per publisher batch, about 3.3 records, and spent 237,613 segments in 3.8 hours: about 62,800 segments, 205,000 records and 390 MB an hour. At that rate 500,000 segments last about eight hours, and a ring of that length would have retired all of run 2, the 6A/6B evidence, within a day of its deploy.

## The Policy

- **The allocation is a ring, bounded by bytes.** When a batch would exceed the byte, segment, record or catalog quota, the writer retires the oldest retirable published segment inside the reservation transaction until the batch fits (#5355). The segment ceiling is now 2,000,000 so that on this host the 8 GiB byte bound, not the segment count, binds first; the record cap is 16 a segment and never above the 8,000,000 the catalog is sized for.
- **An explicit evidence hold.** Segments whose records fall inside the hold window are never retired. A writer resolves the window once, at open, to a contiguous run of catalog rowids (two binary searches, about forty segment reads, no scan) and records it with its counts in `archive_hold`. Later opens with the same window keep exactly that set; segments captured afterwards are the ring's, so the hold never grows. Held segments count against every quota as before.
- **Only held or unpublished segments can stop capture.** The ring retires the oldest published segment below the hold, then the oldest above it. When nothing retirable remains, the quota refuses by name and the publisher pauses on it, and `/health` says so. A reserved batch in `archive_pending` is still never retired.
- **Retention runs inline** on the append and open paths only. No timer, watcher or job. The 8-day Horse-only hand retention in the database is a separate mechanism and is untouched.

## The Env Vars

| Variable                                      | Default                                     | Meaning                                                                                                                                                                                                                                         |
| --------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HORSE_DECISION_JOURNAL_ARCHIVE_HOLD`         | `2026-09-18T21:56:28Z/2026-09-25T19:34:06Z` | The evidence hold, `<from>/<until>` in UTC whole seconds, or `none`. The default runs from Phase 6A's first serving moment to one second after the last segment written before the archive filled. A malformed value refuses the writer's start |
| `HORSE_DECISION_JOURNAL_ARCHIVE_MAX_BYTES`    | 8 GiB                                       | The ring's byte bound, and on this host its binding limit                                                                                                                                                                                       |
| `HORSE_DECISION_JOURNAL_ARCHIVE_MAX_SEGMENTS` | 2,000,000 (also the ceiling)                | The ring's length in segments                                                                                                                                                                                                                   |

The hold is the one knob this decision adds, and its default fits the host without a configuration change. At steady state the archive is about 12 GB (8 GiB of segments plus a catalog of about 3.3 GB), against 9.7 GB today on a disk with 21 GB free. The ring keeps about 18 hours of new play beside the held 1.49 GB.

## What `/health` Says

`horseJournal` adds `heldSegments`, and the `capture` sentence now carries `held=`:

- `running: the archive is a ring of 2000000 segments; the oldest published segment outside the evidence hold is retired when a new one needs its room; retained=500000 published=500000 held=237613 unpublished=0 retired=0`
- `not running: paused since <time> at <quota> with no published segment outside the evidence hold left to retire (only held or unpublished segments remain); asks again every minute; ...`
- The filesystem, failed, starting, recovering, stopped, unavailable and disabled lines are unchanged.

## How Capture Resumes After Deploy

The engine restarts on the release. The writer opens the catalog, creates `archive_retired`, `archive_ring` and `archive_hold` if absent (no version bump, no rewrite of existing rows), resolves the default hold to rowids 262,388 to 500,000, and answers READY. The first append finds 500,000 segments against a ring of 2,000,000 and 6.48 GB against 8 GiB, so it records without retiring anything; `mode` reads `ready` and `heldSegments` reads 237,613. About five hours later the byte bound is reached and the ring starts retiring run 1 (2026-09-17 and 18, before Phase 6A), oldest first, then the oldest new segments after that. Run 2 is never touched while the hold stands.

## What Remains

- **Deploy.** Capture resumes only when an engine release containing #5355 and this change serves. That is the normal protected engine route at a maintenance break; it was not done from this lane, which is read-only on the host.
- **No off-host archive exists**, so nothing is stuck: the archive is the on-host segment directory and catalog, and no module ships segments to Supabase or storage. Until an export exists, the hold is what keeps the 6A/6B evidence. Once 6C and 6D have their evidence out of the host, set the hold to `none` and the ring reclaims those 1.49 GB oldest first.
- **Phase 6A's own release (`8825af5181`, 2026-09-18 to 2026-09-25) has no journal capture at all**: the former catalog was full for that whole week. That evidence cannot be recovered; the 09-25 run under `778075b419` is the first 6A capture.

## Verification

`server/src/services/HorseDecisionJournal.test.ts` (115 tests), including: the ring retires only outside the hold, below it first and then above it; a held segment is never retired, the quota and the probe refuse by name when only held segments remain, and a released hold is reclaimed oldest first; the held set is resolved once per window and does not grow with later capture; a window that holds nothing leaves the ring whole, and a read-only observer of a pre-hold catalog reports zero held; the hold's default and its refusals; `/health` counts held segments and names them when capture is paused. The existing ring, pause and quota tests pass unchanged apart from the sentence.
