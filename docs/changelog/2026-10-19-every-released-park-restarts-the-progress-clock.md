# Every released park restarts the progress clock

Date: 2026-10-19
Scope: engine (`server/src/engine/ServerTableEngineBase.ts`, `ServerTableEngineDealing.ts`)
Follows: #7426 (`2026-10-19-a-held-launch-table-is-live.md`)

## What players saw

Big tournaments starting at :30 had almost every table torn down and rebuilt
in the first seconds of the event: 85 tables at 01:30, 88 at 03:30, 46 at 05:30
and 14 at 13:30 UTC on 2026-10-19 (`engine_recovery_events`,
`watchdog_kill_rebuild` / `tournament_table_zombie:*`, hand_count 0-1). Each
read "no progress for 389-395s". The first deal came late, and the alert
`ClubArenaEngineKillStorm` fired.

## Why, read from the rows

GameServer's sweep condemns a table that should be dealing, is not parked on
purpose, and has made no progress for 180 s. Prepared launches seat their
tables 3-7 minutes early and hold them with `holdDealingUntil(start)`. The
hold's wait never stamped progress, so the moment the hold ended the table
stopped reading as parked and was judged on a clock that had last moved when
it was built.

Why only the :30 starts were hit (every killed event in the last 16 hours
started at :30; no :00 event was hit, even with 701-887 s leads): the :53
maintenance break parks a :00 event's tables at the pause gate, and
`releasePauseGate()` already credits a table that was parked at the gate. The
deal hold had no such credit. (The 04:45 events, about 400 s lead, were not
hit either. Their engine logs are gone with the 14:00 restart, so the reason
is not proven.)

#7426 (merged 13:43) fixed the deal hold. It went live with release 1370116c
at the 14:55 break.

## What this change adds: the other exits of the same shape

Every deliberate park was checked for an exit that leaves the clock aged:

| Park                                                                                                | Exit                                           | Clock at exit before                                                   | Now                                                   |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| Deal hold (prepared launch, spin reveal, add-on break, chest)                                       | hold expires                                   | aged (fixed by #7426)                                                  | fresh                                                 |
| Maintenance break, tournament break, hand-for-hand, final-table deal, terminal closeout, move pause | authority releases the gate                    | fresh (`releasePauseGate`)                                             | fresh                                                 |
| Same gate                                                                                           | the gate's own safety timeout lets the loop go | **aged**                                                               | fresh: `awaitPauseGate` stamps after the loop returns |
| Admin pause / maintenance lock (POST /admin/pause, /admin/maintenance)                              | operator resumes                               | **aged**: a table paused for more than 3 minutes was rebuilt on resume | fresh: `waitOneAdminLockSlice` stamps each slice      |
| Cluster halt, operator floor boundary                                                               | polled                                         | fresh (already stamped)                                                | unchanged                                             |
| Mystery bounty reveal                                                                               | deadline-bounded, seconds long                 | not a park                                                             | unchanged                                             |

Each stamp is written after the awaited wait returns, and only while the engine
may still mutate. So it is earned by the loop coming back. A table frozen
anywhere else gets no credit (the 2026-09-18 rule in `releasePauseGate` still
holds). The 180 s threshold, the sweep, the fleet-wide stand-down and the
per-table watchdog are all unchanged, and no watcher was added.

## Pinned

`server/src/engine/AReleasedParkRestartsTheProgressClock.test.ts` runs the real
engine through each exit at the production timing: built at 01:23:30, released
at 01:30:00 (390 s). It checks that:

- every exit leaves the table un-condemned;
- a released table that then makes no progress is condemned after 180 s;
- a table that never reached the gate earns nothing from a resume;
- a stopped engine earns nothing from a lock slice.

Without this change, 6 of its 13 tests fail on current main. The deal-hold
case also fails against the code serving before 1370116c.
