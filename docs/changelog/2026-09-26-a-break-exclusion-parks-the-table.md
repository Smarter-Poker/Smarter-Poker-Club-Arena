# A break exclusion parks the table (2026-09-26)

## What was wrong

Table 715aee14 of tournament 21f9013b ("Sunday Deep Stack Satellite",
release 92d59cfb, lease generation 745329d5) stopped dealing at 03:42 UTC with
four players seated, and stayed that way for 34 minutes. Its tournament's other
table kept dealing, `/health.stalledTableCount` was above zero, and the
post-deploy certification failed with "production had stalled tables before
observation".

## What the rows said

Measured on production (SELECT only) between 04:07 and 04:22 UTC:

|                                                     |                                                     |
| --------------------------------------------------- | --------------------------------------------------- |
| break row (`smarter_private.f06_operations`)        | cbf00eca, `park_requested`, created 03:41:11.984    |
| hand in progress when it was requested              | #14633520, started 0.7 s earlier                    |
| that hand committed / post-commit completed         | 03:42:03.298 / 03:42:03.409                         |
| break rows for this tournament                      | 1 `acknowledged` (09-25), 1 `park_requested` (this) |
| `custody_id` on the break before the next release   | null (revision 0, no movement admission)            |
| reserved hand permits on the table                  | 0 (last permit 14633520 `accepted`)                 |
| `fn_f06_allocate_hand_number` while the row exists  | `{"ok": false, "reason": "source_excluded"}`        |
| movement proof preconditions (`f06_movement_prior`) | all satisfied: sealed commit, 4 seats = 4 playing   |
| next release's lease generation                     | 2d71fb99 (release f1d956c3, from about 04:06)       |
| movement admission under that generation            | d8d5e10a, custody claimed, revision 1               |
| the four players moved                              | 04:16:14.708 to 04:16:15.357, break `acknowledged`  |
| `park_requested` rows fleet-wide at 04:22           | 81 (9 without custody)                              |

## The cause, named

The balancer's break asked the source engine to park with a one-second probe
(`TournamentManager.prepareParkedTournamentBreak`,
`MOVE_BOUNDARY_PROBE_MS = 1_000`). A hand was 0.7 s old, so the probe missed,
by design: the owner stays armed and the engine parks at its next boundary.
It did, at 03:42:03. From that moment
`ServerTableEngineBase.armUnclaimedTournamentMovePauseExpiry` gave the park
fifteen seconds (`TOURNAMENT_MOVE_UNCLAIMED_PARK_MS`) to be claimed by a sweep
and then released it. The process-wide elimination scheduler runs at most four
sweeps at a time for every tournament on the host, and no sweep reached this
manager in that window, so the pause was released.

That expiry exists for a planner that stopped wanting a move. A durable break
is not that planner: while a break row names the table as its source,
`fn_f06_hand_number_state` answers `blocked_reason = 'source_excluded'` and
`fn_f06_allocate_hand_number` refuses every hand. Releasing the pause could
only make the dealer ask for hand numbers it would never get, which it did:
nine `f06_allocation_unproven` attempts until the zombie watchdog stopped it at
03:45:39. Nothing woke the sweep when the engine parked either: the park edge
(`onPauseReady`) only advanced hand-for-hand and stage-end barriers.

## The fix

- `ServerTableEngineBase.parkForTournamentMove(owner, probe, heldByDurableBreak)`:
  an owner armed for a durable break goes into
  `breakHeldTournamentMovePauseOwners`. The unclaimed-park expiry and the
  two-minute pause safety timeout skip it; only
  `releaseTournamentMovePause` (the break's acknowledgement, its no-start
  withdrawal, manager shutdown, or engine replacement) or engine teardown
  removes it. No timer was added.
- `TournamentManager.prepareParkedTournamentBreak` arms the source that way.
  The break's park row is the claim the pause waits for.
- The park edge is now an event: `wireEliminationWake`'s `onPauseReady` wakes
  the manager's sweep (`tournament_move_parked`) when the engine parked with a
  tournament-move owner no sweep has claimed
  (`ServerTableEngineBase.awaitsTournamentMoveClaim`).
- The admission's allocator and fresh-hand projection in
  `TournamentManagerBase.startManagedTableEngine` name a `source_excluded`
  refusal `f06_source_excluded_by_break` instead of `f06_allocation_unproven`,
  and hand the table to `TournamentManager.holdSourceForItsBreak`, which fences
  the dealer for its break with the manager's own boundary owner and wakes the
  sweep. That covers a dealer with nothing armed, such as a park request whose
  reply was lost.

## What was NOT changed

- The startup path for a table whose break is still open
  (`TournamentManagerBase.startManagedTableEngine`, `source_excluded` branch,
  then `TournamentManager.startParkedMovementEngine` and
  `fn_f06_admit_parked_movement`) was already correct and needed no change.
  The SQL admits a `park_requested` row with `custody_id` null by claiming
  custody for the caller's fresh custody UUID, and production proved it: the
  next release admitted this exact break movement-only (d8d5e10a) and moved
  the four players at 04:16. No migration was needed.
- `ServerTableEngineDealing.ts` (prepared allocation) and
  `recoverF06OriginalAdmissions` are untouched; a separate change owns them.
- Ordinary balancing moves keep the fifteen-second expiry.

## Pinned

`server/src/tournament/aBreakExclusionParksTheTable.law.test.ts`, with a real
ServerTableEngine, the real TournamentManager break path and the admission's
real allocator:

1. The park the probe missed stays parked past sixteen seconds and past the
   two-minute safety timeout, `fn_f06_allocate_hand_number` is never called,
   the park edge wakes the sweep, and the sweep claims the boundary and the
   break reaches `begun`.
2. After a restart with the break `park_requested` and `custody_id` null, the
   table starts movement-only and parked, its park edge wakes the sweep, and
   the break reaches `begun`.
3. A dealer with nothing armed that meets `source_excluded` rejects with
   `f06_source_excluded_by_break`, is fenced, wakes the sweep, stays parked,
   and the break reaches `begun`.

Before the fix: all three fail (the wake is missing; case 3 gets
`f06_allocation_unproven`). With the wake assertions removed, case 1 still
fails because the owner is gone after sixteen seconds (the expiry released it)
and case 3 still fails; case 2 passes, which is the unchanged startup path.
After: 3/3.

## Still open, measured, and not papered over

81 `park_requested` rows remain fleet-wide at 04:22, 72 of them already
holding movement custody under a live generation in events with many open
tables. They are not the shape fixed here (their custody was claimed, so their
tables were admitted movement-only and are not dealing into a refusal), and
this change does not claim to drain them.
