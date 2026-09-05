# The resume arrives in installments (2026-09-05)

Branch `fix/the-thaw-arrives-in-installments`, commit 1 of 3. Engine only:
`server/src/maintenance/MaintenanceBreak.ts`, its tests, and a pin in
`tests/the-break-clocks-agree.law.test.ts`. No migration; Phase 4 (the
DATABASE thaw in installments) is done and is not reopened here.

## What was read

Prometheus on the engine host, `poker_engine_info` by `instance_id`, for
2026-09-04 22:00 to 2026-09-05 10:20 UTC:

```
1-40d0cff4 dbe3c513 02:55:30 -> 04:06:30 UTC     <- died 6.5 min after the 04:00 thaw
1-c3b8997e dbe3c513 04:07:30 -> 04:38:30 UTC     <- same build, replaced again
1-fcf77665 dbe3c513 04:39:30 -> 04:55:00 UTC
1-2fff66e4 c6e1bc89 04:55:30 -> 05:15:00 UTC     <- deploy at :55, then died at 05:15
1-71419fd8 c6e1bc89 05:17:30 -> 05:48:30 UTC
1-e969f64e c6e1bc89 05:49:30 -> 05:55:00 UTC
1-c6ceb9c9 4d72600a 05:55:30 -> 06:36:30 UTC
1-c0a6bb13 4d72600a 06:37:30 -> 06:55:00 UTC
1-9b9cbe58 6688dea8 06:55:30 -> 06:58:00 UTC
1-052e2206 6688dea8 07:00:00 -> 07:55:00 UTC     <- from here on, one instance per hour
1-29597ee6 24c0d681 07:55:30 -> 08:55:00 UTC
1-dfaeeb85 8af7bb34 08:55:30 -> 09:55:00 UTC
```

Around the 04:00 UTC break end (`poker_paused_tables` 239 -> 0 at 04:00:30):

```
host CPU (3 cores, avg busy)  03:59 0.086   04:00:30 0.135   04:01 0.240   04:02:30 0.312   04:03-04:07 0.24-0.26   04:08 0.16
node_load1                    03:59 0.24    04:01 1.02       04:02:30 2.01  04:03 2.00      04:06 1.46             04:08 0.76
MemAvailable (GB)             2.08 flat ...  04:07:30 2.78   <- ~700MB freed: the process died between 04:07:00 and 04:07:30
```

The container has no CPU limit (`NanoCpus 0`) and the host has three cores,
but Node's main thread is one of them: 0.31 average busy over three cores is
one core pinned. The engine's `/health` is what `sp-autoheal` and the
watchdog read, and a saturated event loop does not answer it.

Two honest caveats. (1) The Prometheus instance list shows the 04:00 death
is one of six unscheduled replacements between 04:06 and 06:58 UTC, only one
of which sits at a break end; from 07:00 on there is one instance per hour,
so whatever else was dying was fixed by a later build. (2) The core stayed
pinned for six minutes, not six seconds. A resume spread over ten seconds
bounds the instantaneous herd at :00; it does not change the sustained load
of 720 tables dealing on one core, which is EquityLoadGovernor's job and
Phase 8's. This change is the part of that picture that belongs to the
break.

## What the engine did before

`resumeEveryEngine` woke the fleet 25 tables per 750ms in Map insertion
order. After a restart that order is adoption order, which is tournaments
first: the first sixteen batches (12 seconds) were all 402 tournament tables,
then the 318 cash tables. 29 batches, 21 seconds first to last.

## What it does now

- `RESUME_WAVES = 8`, `RESUME_WAVE_GAP_MS = 1500`, `RESUME_WAVE_MIN_TABLES = 25`.
  The fleet is dealt into `min(8, ceil(total / 25))` waves; 720 tables is 8
  waves of ~90, 1.5s apart, 10.5s first to last (`RESUME_SPREAD_MS`). Wave 0
  fires synchronously inside `end()`, as batch 0 did; 25 tables or fewer is
  one wave, so a small fleet (and every test fleet) is up before `end()`
  returns.
- Order within each kind is a stable FNV-1a hash of the table id, ties by
  id, so it owes nothing to adoption order. Cash and tournament tables are
  dealt round-robin into the waves, so every wave carries its share of both
  and no wave is all tournaments.
- `/health` `maintenance.resumeWaves` is
  `{total, done, startedAt, finishedAt, tables, tablesResumed, gapMs}` from
  wave 0 until the next break is announced; `null` otherwise.
- A table that throws on `resumeFromMaintenance()` is logged
  (`could not resume table`) and its wave carries on; the waves behind it
  are unaffected. A wave from a superseded break is dropped, as before.

## "Together", and why a late wave does not burn a clock

CLAUDE.md 13 says every table resumes "together" at :00. That is read as
"within the same few seconds of the same minute", not "in the same
event-loop tick" - the same-tick reading is what saturated the core. The
interpretation is written on the constant.

`end()` computes `frozenSeconds = now - breakStartedAt` and awaits
`fn_thaw_platform` BEFORE wave 0. The shift is uniform and keyed to the
freeze start, so it is identical whether a table wakes in wave 0 or wave 7.
The deadlines it moves (`sit_out_at`, waitlist `hold_expires_at`, add-on and
rebuy windows, bounty `reveal_deadline_at`, `bomb_pot_next_due_at`,
tournament `level_started_at`) are all judged at minute scale; the 0-10.5s a
late wave adds is the same order as a loop's own between-hand sleep and
smaller than the 21s the phase 3 stagger already imposed on this fleet
without a per-table shift (the 23:55 measurement of 2026-09-02 showed
`sit_out_at 6` shifted correctly under that stagger). A per-table second
shift would be one database write per table at :00, the herd this module
exists to avoid, so it is deliberately not done.

## Humans first was considered and rejected (CLAUDE.md 10.5)

The brief offered "tables with humans seated resume in the first wave".
Ordering the queue by `is_horse` gives a horse-only table a later wake, and a
spectator watching two tables would learn which one is horses from which
came back first. That is the tell 10.5 names for the rebuy pause ("TIMING IS
PART OF THE TREATMENT"), and it is the same shape as the `humansSeatedTotal`
drain gate Dan had replaced with `handsInFlightTotal`. The planner reads
nothing about the seats; `MaintenanceBreak.test.ts` and the law both pin
that its source contains no `humansSeated`, `is_horse` or `isHorse`.

## Tests

`server/src/maintenance/MaintenanceBreak.test.ts` (44 tests): 720 tables
into 8 waves of ~90 at 1500ms, spread inside 15s; every wave carries both
kinds; the plan is identical for a fleet inserted in reverse order and is
not insertion order; 60 tables is 3 waves of 20; a small fleet is one
synchronous wave; one throwing table in every seventh seat holds nothing;
the `/health` block counts `done` 1..8 and stamps `finishedAt` at
`startedAt + RESUME_SPREAD_MS`; the slow-insert and superseded-break pins
from phase 3 carried over. `tests/the-break-clocks-agree.law.test.ts` pins
`RESUME_WAVES >= 4`, `(waves-1)*gap <= 15s`, `RESUME_WAVE_MIN_TABLES >= 10`,
the seat-blind planner, and the `/health` key.

## How to verify live

```
curl -sf https://engine.smarter.poker/health -H 'Cache-Control: no-cache' | python3 -c 'import json,sys; print(json.load(sys.stdin)["maintenance"].get("resumeWaves"))'
```

At :00:05 it reads `{'total': 8, 'done': 4, ...}`; by :00:12 `done == total`
and `finishedAt - startedAt == 10500`. Then the 04:00 shape above on the
next break: host CPU should ramp over ten seconds rather than one, and the
first wave of `[MaintenanceBreak] resuming N table(s) in 8 wave(s)` appears
in the engine log.
