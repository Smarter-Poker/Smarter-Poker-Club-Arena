# Two qualification fixtures stopped at the 2026-10-19 union-week rollover

At `2026-10-19T07:00:00Z` (midnight Pacific, `fn_union_week_start`) two required
accounting qualifications went red on every pull request touching the server,
through `Accounting transactions (PostgreSQL 17)` and therefore the required
`Server Engine (typecheck + tests)` aggregate. Both reproduced locally on
unmodified `origin/main` `29f3e1822` with PostgreSQL 17.

## 1. Original seven discharge (shard 3): a fixed report window, fixed for good

`original-seven-discharge/test-discharge.py`, case
`actual-b9-current-seven-report-cash-conservation`, raised
`exactsevenactualheldsource_refused`. The case performs the seven discharges
inside its own transaction, so their ledger rows carry today's clock, then read
the flows back over the fixed window `2026-10-12 07:00Z .. 2026-10-19 07:00Z`.
Once the clock passed the window's end, the seven returns fell outside it and
the count was 0, not 7.

The report window now closes at the end of the Los Angeles week that contains
the transaction (never before `2026-10-19 07:00Z`), and the opening boundary
stays the certified `2026-10-12 07:00Z`. Every assertion is unchanged: exactly
seven returns, seven distinct ledger ids, a `ready` receivable, two clubs,
1,845.87 cash returned against 1,845.87 opening receivable, zero net, rake,
winnings and losses. This does not expire again. The bytes are identical to the
same correction in #7420, so the two merge cleanly. `source-binding.json`
carries the two new hashes, and `verify-source-bindings.py` passes.

## 2. First archived Spin (shard 1): the weekly authentic recapture

`first-temporal-refusal.sql:43` raised `ARCHIVE_RECOGNITION_PERIOD_CAPTURE_EXPIRED`.
This guard is deliberate and was not made clock-relative. The capture is
production evidence for one union week: the archived event's routing scopes, and
no routed settlement run overlapping that week. The completion and rollback-probe
carriers are written to run against production. The event is still unadmitted
there (read 2026-10-19 11:02Z: terminal settlement row present, no admission, no
lease). A bound derived from the clock, or a pinned CI clock, would let those
carriers act on a week nobody observed. That weakens exactly what they certify.

So, as on 2026-09-28 (#5524), 2026-10-05 and 2026-10-12 (#6734):

- **Capture.** A new read-only capture at `2026-10-19T11:02:41.205014Z` used
  the unchanged maintained query (sha256
  `67f65046f981cdf2f377b5243349a21c900a1bde31b1c425c34ee73102e62301`). It binds
  the week `2026-10-19T07:00:00Z .. 2026-10-26T07:00:00Z`, with zero blocking
  runs and zero overlapping runs. The scopes are unchanged: source club
  `a41434bb-8d0c-400a-8f0d-e8b3d65afed4` and host club
  `fade0000-0000-0000-0000-000000000001`, both coordinated by union
  `fade0000-0000-0000-0000-000000000001`.
- **State.** The raw capture and the active temporal state carry it, and the
  2026-10-12 record moves to `recognition_period_history` unchanged.
- **Carriers.** The seven carriers move one week forward, and so does the
  stale-guard mutation case.
- **Pins.** The completion SQL, rollback probe, manifest and CI pins were
  recomputed from the exact bytes.

**New: the expiry now explains itself.** Before, the expiry surfaced only as a
`P0001` inside a retained artifact, after a full cluster build.
`require_recognition_capture_current` now runs before any cluster is allocated
for the four archived Spin images. It names the captured week, the run's time
and this procedure, and it refuses to widen the bound.
`test_expired_recognition_capture_is_named_before_any_cluster` pins it.
It is not part of `validate_sources` or the database-free self-test, so the
unit suites do not start depending on the wall clock.

**Next expiry: `2026-10-26T07:00:00Z`.** Repeat the same read-and-advance. If the
event is admitted or settled in production, retire the time-bound carriers rather
than recapturing.

No production write, DDL, migration, settlement or engine behaviour is part of
this change.
