# 2026-09-11 — A hand frozen at the break is reaped, so the break can still certify

## The defect

`pauseForMaintenance` raises `maintenancePaused` at :53 on every table,
including tables still playing a hand; for those the flag means "stop at the
next hand boundary". `isPausedByDesign()` answers true from that moment, and
two readers took the flag for the fact:

- the **table watchdog** (`runTableWatchdog`) stood down for every table still
  mid-hand at :53, so a seat that lost its clock in the last-hand window could
  not be given one back, forced, or rebuilt;
- the **zombie reaper** (GameServer discovery) exempted it for
  `MAX_HEALTHY_PAUSE_MS` - ten minutes, longer than the whole break.

A hand that froze in that window therefore never landed and never parked, and
one table that never parks keeps `maintenance.readyForRestart` shut. On
2026-09-11 build `404948b3` froze tournament tables mid-hand (the deadline
clock bug, #4225) and held 514, 526 and 523 of them unparked through the
02:55, 03:55 and 04:55 countdowns. No certificate, no restart, and the fix
could only ship through an owner-approved one-build exception (#4235).

## The fix

`ServerTableEngineBase.isParkedByDesign()` - a by-design pause that has TAKEN
EFFECT. Between hands, every authority counts exactly as `isPausedByDesign()`
says. Mid-hand, only a fence a rebuild would LOSE still holds the table (the
final-table deal, the terminal closeout, an FSM `paused` lock). The next-hand
fences - the maintenance break (:53), the tournament's own break and
hand-for-hand (:55, `pauseAfterHand` -> `handForHandPaused`) and a deal hold -
survive a rebuild: `MaintenanceBreak.adopt()` parks every engine created in the
break, and `TournamentManagerBase.prepareManagedTableEngineForPlay()` re-applies
the tournament break, the add-on break and hand-for-hand before admitting a
replacement.

The first draft let every non-maintenance authority count mid-hand. An
adversarial review caught that the :55 tournament break raises
`handForHandPaused` on every MTT table, so from :55 - the only minutes
`readyForRestart` can open - the draft shielded a frozen MTT hand again; it
also caught a root law test (`tournamentRakeAndBreaks.test.ts`) the draft
would have turned red.

The watchdog and the reaper now stand down on `isParkedByDesign()`. A frozen
hand is worked by the watchdog (clock back, forced action, rebuild) and reaped
on its usual 180s clock inside the break, and its replacement is parked on
arrival by `MaintenanceBreak.adopt()` - so the certificate is earned, not
waived. Readers that describe a table rather than intervene (the liveness
snapshot, the stall filters, the SIGTERM drain) keep `isPausedByDesign()`.

## Pins

- `server/src/engine/TableWatchdog.test.ts` - a stalled hand mid-flight under
  the break is worked (tier 1) and escalates to a rebuild (tier 3); the :55
  tournament break (the real `pauseAfterHand` call), hand-for-hand and a deal
  hold do not shield it; a fence a rebuild would lose still does; a table
  between hands is parked under every authority. The behavioural cases fail
  on the old predicate and on the first draft.
- `tests/a-parked-table-is-not-a-stalled-one.law.test.ts` - the reaper and the
  watchdog read `isParkedByDesign()`; between hands it is exactly
  `isPausedByDesign()`, and mid-hand it names only the fences a rebuild loses.
- `tests/unit/tournamentRakeAndBreaks.test.ts` - the reaper's pin now names
  `isParkedByDesign()`.
