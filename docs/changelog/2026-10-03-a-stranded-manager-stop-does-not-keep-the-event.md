# A stranded manager stop does not keep the event (2026-10-03)

## What happened

Spin `20a7de08` (club `2a1132b9`, table `9aa37b13`) dealt its last hand at 16:33:34. Its
`engine_tournament_leases` row was last renewed at 16:34:22 and kept naming the live instance
`1-14d6b5c1`, which renewed 221 other leases normally the whole time. The database restarted at
16:34:50. The orphan sweep filed a CRITICAL at 16:52, 17:52 and 18:52. The event was re-adopted
around 19:2x and completed at 19:23:22 with money whole. `engine_recovery_events` holds nothing
for that table.

## Root cause

The renewal pass fences a tournament manager whose proof has lapsed (or that stood down on its
own) and retires it through `GameServer.stopTournamentManagerIfOwned` →
`stopOwnedTournamentManager`. Every later pass joins that same retirement. The retirement awaited
the manager's physical `stop()` with no bound. The teardown joins every in-flight writer
(elimination scheduler jobs, lifecycle jobs, each table engine's settlements) before anything
else. When one of those awaits never settles, as an await stranded by a connection reset does,
nothing after it ever runs:

- there is no quarantine record, so `/health` showed `tournamentManagersQuarantined: 0` and the
  event counted as owned;
- there is no lease release, and the successor barrier stays up;
- the slot is never freed for re-adoption;
- a table engine stranded the same way never gives back its process-wide slot (`liveEngines`, the
  shared heartbeat and turn deadlines), so no successor engine could claim the table.

The quarantine exists for a stop that FAILS. A stop that never returns fell outside it.

## Fix (engine, no database change)

- `stopOwnedTournamentManager` (`server/src/tournament/TournamentManagerOwnership.ts`) waits at most
  `STRANDED_TOURNAMENT_MANAGER_STOP_MS` (45 s). After that it evicts the manager when that is safe.
  It returns true, so `stopTournamentManagerIfOwned` releases the EXACT lease generation as after
  any stop. The barrier opens and the RUNNING re-adoption lane re-admits the event under a new
  generation, about a minute after the stall instead of hours.
- Eviction does the following, in order:
  - It fences the manager (synchronous, idempotent) and requires its lease authority to be gone.
  - It requires every table engine to be stopped and to hold no claimed seat-move boundary.
  - It gives back each engine's process slot through
    `surrenderProcessOwnershipOfStrandedTeardown` (`server/src/engine/strandedTeardownOwnership.ts`,
    terminal engines only).
  - It writes stopped time banks down (bounded 15 s).
  - It unregisters each engine through GameServer's identity-CAS unregister, which still refuses a
    table whose banks are not on disk.
  - It frees the slot with an identity-CAS delete.
- It refuses for an F06 recovery owner, a claimed seat-move boundary, time banks that cannot be
  written down, or anything that is not a fenceable manager. The attempt then fails like any
  failed stop, the quarantine names it on `/health` (`tournamentManagersQuarantined`,
  `tournamentsRunningWithoutOwner`), and the quarantine retries it on its own backoff.
- Each eviction and each refusal is reported through the retirement's error context with a
  message naming the reason.

## What does not change

- Fencing against another generation: the database stays authoritative. Hand submissions and
  manager writes are refused unless instance, generation and heartbeat match, and a successor can
  hold the row only under a new generation after this generation's exact release or its 30 s
  staleness.
- The evicted generation cannot deal (its engines are terminal) and cannot renew
  (`renewTournamentLeaseProof` refuses an expired proof). Every later step of its stranded
  teardown is identity-CAS, so it never removes a successor.
- A stop that settles inside the bound behaves exactly as before.

## Not in this change

Lease rows left on COMPLETED events (`aa27c94f`, `e52435d6`) by a holder that died at the 19:07
restart are still removed only by the reaper (`reap_dead_engine_leases`, called at boot and hourly
with a one-hour cutoff). Shortening that needs either the engine reaper cadence in `GameServer.ts`
or a terminal-event clause in the SQL reaper. Those rows grant no authority; a successor reclaims
any such lease through the stale-takeover clause.

## Tests

`server/src/tournament/aStrandedManagerStopDoesNotKeepTheEvent.test.ts` (fake timers, real
`GameServer.stopTournamentManagerIfOwned` and `TournamentManagerBase`) reproduces a teardown await
that never settles after a connection reset:

- Without the bound, nothing settles and nothing is released.
- At 45 s the manager is evicted, the exact generation is released, the barrier opens and the slot
  is free.
- The evicted generation stays fenced, and a successor is untouched by a late retirement.
- F06 custody, and time banks that cannot be written down, keep the manager in the quarantine with
  no release.
- A stopped table's banks are written down and its registry slot freed before eviction.
- A prompt stop is untouched.
- A stranded table engine gives its process slot to a successor only once terminal, and never takes
  it back.
