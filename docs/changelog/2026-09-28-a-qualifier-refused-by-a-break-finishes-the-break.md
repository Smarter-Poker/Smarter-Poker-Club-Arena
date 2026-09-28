# A qualifier settlement refused by a table break finishes the break

2026-09-28, stream stall-b. Engine only; no migration, no money written.

## What was frozen

Five RUNNING events with no hand for hours, read at 16:30Z on engine 763e4cec
(instance 1-6c9b5f69):

| Event    | Name                                    | Playing                              | Last hand | Open table break                                                                                                                   |
| -------- | --------------------------------------- | ------------------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| b165b22f | Sunday Funday Main Event Satellite      | 6 (7 full tickets)                   | 01:16:58Z | 8fea2a2b `park_requested`, 0 members, source de4f9a82 (2 seats), since 23:25Z                                                      |
| 0e1d340e | Sunday Funday Six-Card Closer Satellite | 6 (6 full tickets)                   | 01:35:27Z | b7c61dda `begun`, 4 active attempts e9dcfa9c -> e700e241, since 23:27Z                                                             |
| e8cc6c78 | DSS Tuesday $22 NLH Deepstack Satellite | 5 (5 full tickets)                   | 05:12:08Z | 5586c18d `park_requested`, 0 members, source 9e87e287 (3 seats), since 03:51Z                                                      |
| 2dbd67a7 | $100 Freeroll 12:00 AM                  | 10 on 11 tables, one each            | 13:28:18Z | 0d1ff042 `begun`, 1 active attempt 569f8bc1 -> 6004b0b7; 60c9887a `begun`, its one member already moved, source 40f38110 now empty |
| 6a18ddaa | Morning Free Buy (NLH)                  | 44 on 40 tables (39 hold one player) | 15:07:36Z | fae96c1e `begun` under lease generation bb31566e, 5 active attempts from 9245b2c9 to five single-player tables                     |

Every event had exactly one current lease on the live instance, heartbeating,
and every table engine was running: sources "Parked between hands", the rest
"Waiting for players... (1/2)", with the fleet zombie reaper rebuilding the
parked ones every ten to fourteen minutes (each rebuild takes a fresh
`fn_f06_admit_parked_movement`, which is why 8fea2a2b is at revision 124).

## Cause 1: the satellite qualifier check and the break wait on each other

The three satellites each have every remaining player inside the full-ticket
count, so `fn_get_satellite_qualifier_state` answers `qualifying` (read from
the same rows it reads: `tournament_satellite_entitlements` seat_or_cash 7/6/5
against 6/6/5 players `playing` with chips, no pending knockout candidate, no
open `hand_atomic_commits`). The manager parks every table for the qualifier
boundary and calls `fn_settle_satellite_qualifiers`. That transaction writes
the qualifiers' seats and registrations, and `smarter_private.f06_source_guard`
refuses those writes while a table break names one of the event's tables as
its source: `F06_SOURCE_EXCLUDED`. The engine logged it four times in 25
minutes as `[Tournament.satellite_qualifiers_refused] ... F06_SOURCE_EXCLUDED`,
without saying which event.

`checkSatelliteQualifierCompletion` answered every refusal with `'pending'`.
`runEliminationSweep` turns `'pending'` into `eliminationSweepCursor.reset()`,
so the sweep never reaches `balanceStage`, the only caller of
`checkTableBalance`, the only thing that begins, dispatches and retires a
break. The settlement waited for the break and the break waited for the
settlement, with every table parked. Nothing else was logged for these
events after 16:04:40Z.

**Fix.** `TournamentManagerEliminations.checkSatelliteQualifierCompletion`: a
refusal recognised by `isTableBreakExclusion` (the door's own code,
`F06_SOURCE_EXCLUDED`) answers `'continue'` and requests an urgent re-drive.
The qualifier boundary is not released, so no table deals; the sweep goes on
to the balance stage, which finishes the break, and the next pass asks the
settlement door again. Every other refusal answers `'pending'` exactly as
before. The refusal report now carries `tournamentId` and `qualifierCount`.

## Cause 2 (named, not yet closed): a begun break that moves nobody is silent

Breaks fae96c1e, 0d1ff042 and b7c61dda each hold active attempts to free,
existing destination seats (every destination seat was read empty and every
destination table `waiting`/`running`), yet no member was ever dispatched and
no `Tournament.break_member_outcome_unresolved` or
`Tournament.break_recovery_unresolved` line exists for them. fae96c1e's
attempts carry lease generation bb31566e, the generation that held the lease
from 16:01Z, so this manager began the break and then declined to move anyone.
Every guard in `dispatchTournamentBreakMembers` (an unresolved seat-move
outcome, a missing or unretainable source engine, a withdrawn mutation
authority, an unclaimed source boundary) and the two refusals before it in
`recoverTournamentBreak` / `repairTournamentBreakDestinations` answered a bare
`return`, so which one is holding these events cannot be read from the log.

**Change.** Each of those guards keeps its condition and order and now names
itself once per change: `[Tournament:xxxxxxxx] Break yyyyyyyy members not
dispatched: <reason>`, readable through `lastBreakDispatchRefusal(breakId)`,
cleared by a full dispatch and forgotten when the break is acknowledged
(CLAUDE.md 10.86 rule 1). This is a diagnostic, not the fix for cause 2; the
first deploy carrying it names the guard, and the fix follows from that name.

## Pinned by

`server/src/tournament/aQualifierRefusedByABreakFinishesTheBreak.law.test.ts`
(`docs/laws.d/a-qualifier-refused-by-a-break-finishes-the-break.md`).

## Not done / unproven

- Not deployed. The engine half goes live only at a :55 cutover after merge.
- That the three satellites' breaks then complete is reasoned, not observed:
  b165b22f and e8cc6c78 still have to be begun (`prepareParkedTournamentBreak`
  names any refusal), and 0e1d340e's begun break meets cause 2.
- Why 8fea2a2b and 5586c18d were not begun in the hours BEFORE their events
  reached the qualifier count (23:25Z-01:16Z, 03:51Z-05:12Z) is not known; the
  engine log for that period is gone with the earlier container.
- Postgres restarted at 16:36:37Z during this investigation (not caused by
  this work; a read already timed out at connection time before it); the
  lease churn that followed is not part of this change.
