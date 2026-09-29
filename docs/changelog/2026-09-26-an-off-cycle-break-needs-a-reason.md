# An Off-Cycle Break Needs A Reason

2026-09-26

## What Players Saw

On busy hours the floor was parked for 29 to 36 minutes out of 60. Measured
from `engine_maintenance_break_log` (break_started_at to break_ended_at):

| Hour (UTC)  | Breaks | Paused Minutes | Unscheduled |
| ----------- | -----: | -------------: | ----------: |
| 09-25 22:00 |      5 |           33.5 |           4 |
| 09-26 02:00 |      4 |           29.3 |           3 |
| 09-26 03:00 |      4 |           29.0 |           3 |
| 09-26 05:00 |      5 |           36.2 |           4 |

Hands per minute fell from about 550 to about 200. A regular player got a
seven-minute break roughly every twelve minutes.

## The Cause

Every autopilot merge dispatches its own engine release, and every release
could reserve one off-cycle "Deployment Recovery" window. The seal granted one
to any release that had observed a missed certificate, and the transaction
recorded a miss for every `CERTIFICATE_RC=2` read. When several releases wait
through one break, the first admission ships and every other release reads the
rest of that break (down to "0ms remaining" after it ends) as a miss. At :03
each of them asked for a window of its own, which again only one could use.

The host journal for 2026-09-26 shows it exactly: 902565dd, 94c7cf0b, 1cb373d1
and 6cd35918 were in flight together. All four read the 05:55 break as missed;
1cb373d1 announced the 06:05 window and 94c7cf0b shipped in it; 902565dd died
behind the new high-water; 6cd35918 then announced the 06:13 window, and nobody
was admitted in it. Three breaks in twenty minutes for one shipped release.

The scheduled :55 break does not yet reliably certify in time on the current
engines (none of 03:55, 04:55 and 05:55 admitted a release inside the 40
seconds of countdown the ladder accepts), so the escape hatch is still needed.
It is now proportionate instead of per merge.

## The Policy

`request_recovery_window` in `server/scripts/engine-release-transaction.sh`:

1. **A reason is required.** An ordinary release waits for the scheduled :55
   break. It may ask for an off-cycle window only when a commit it adds over
   the sealed high-water carries the trailer `Engine-Release: urgent`; when
   `/health` shows the serving engine degraded (`liveness` dead,
   `wholeFleetStalled`, `breaksSinceRestartCertified` of 1 or more, or 100 or
   more quarantined tournament managers); when no scheduled break can admit it
   before its own certificate deadline; or when it was already waiting while a
   break could still admit it, that break never did, and no release shipped in
   it. The seal's existing cause, an unshipped failed ancestor, is unchanged.
2. **The newest release owns the window.** A release never asks while a
   release of a newer protected-main engine SHA has a live unit on the host.
3. **One per rolling hour.** `engine-release-seal.py reserve-recovery-window`
   answers `rate-limited` when any other run's durable reservation is less than
   an hour old. The reservation files already exist for every window ever
   announced, so the limit holds across processes, retries and control
   generations. A rate-limited release waits and asks again a minute later.

Nothing that makes a cutover safe moved: `maintenance_certificate`, the
admission and locked rungs, the rollback reserve, the database in-flight
witness and the locked read are byte-for-byte as they were. The policy only
changes when a release asks for a break.

## Deadlines

A release that now waits for :55 always has one: the host transaction's
certificate deadline is at least 8400 - 720 - 3450 seconds after its build
ends, more than an hour plus the 40-second admission, and the runner's own
not-after (12000 - 600 seconds) is never the shorter clock. Pinned by
`tests/an-off-cycle-break-needs-a-reason.law.test.ts`.

## Tests

- `tests/operations/engine-release-recovery-window.py`: 13 new cases. A
  degraded, urgent, deadline-bound or genuinely missed release still gets its
  window; an ordinary one and one whose sibling shipped do not; a newer live
  release owns the window, a finished or unrelated one does not; a spent hour
  waits and asks again; one window per release whatever its reasons; only a
  release waiting while the break could admit it has missed it.
- `tests/operations/engine-release-window-queue.py`: both ordinary short
  certificate reads judge arrival time before recording a miss.
- `tests/engine-release-seal.law.test.ts`: the real seal limits the hour,
  replays a run's own reservation, counts an unreadable reservation by its
  file time, accepts the three named causes and refuses any other.

## Calibration After The First Hour In Production

The policy went live with a1a17fbd. At 07:03Z that release logged that
209d1b45 had shipped in the 06:55 scheduled break it also waited through, and
asked for nothing, which is the case that used to cost a window every time. At
07:35Z the newest release, 3de1c39f, read 16 quarantined tournament managers
as "degraded" and spent the hour's window at 07:37Z; neither waiting release
was admitted in it. 209d1b45 was dealing normally (liveness ok, 27 managers
quarantined by 07:45Z), while the 04:45Z wedge fixed by #5298 quarantined 338.
The quarantine threshold is now 100: a quarantine count is a reason to pause
every table only when it is wedge-sized.

## No Window The Certificate Will Refuse

From 07:37Z 209d1b45 reported 27 `stopped_bank_custody_stuck` tables
(`tournament_lease_lost_stop_failed`: "retained time-bank custody"). The
certificate refuses that class in every break, with no serving-release
exception since #5288, so neither the 07:37Z window nor the 07:55 scheduled
break could admit a release. While `/health` reports
`maintenance.stoppedCustodyStuckTables` above 0, no release asks for an
off-cycle window for any reason: it would pause every table and admit nobody.
The count is the engine's own last census, so the first break that finds the
custody cleared makes windows possible again.
