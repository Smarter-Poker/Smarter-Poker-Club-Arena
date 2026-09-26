# A departed player leaves no time-bank metadata behind, and one zombie table does not fence its tournament

**2026-09-25.** Release `778075b4` wedged tournaments permanently: 17
tournament managers quarantined with `GameServer.tournament_lease_lost_stop_failed`
and 50 tables idle for hours. Two defects, one root and one amplifier, both
introduced or exposed by `bd70e87204` "fix(mtt): preserve stopped original
custody after lease-row loss (#4914)".

## What broke

### The root: metadata that outlived its bank

`ServerTableEngineBase.performStop` captures stopped time-bank custody on a
tournament table and refuses, by design, when `timeBankMeta` names a user who
has no bank in `timeBankEngine`:

```
Stopped time bank metadata has no original balance
```

On a tournament table that was every table that had ever lost a player. The
deal sets `timeBankMeta` for every player dealt in
(`ServerTableEngineDealing`, "Only initialize time bank if player is NEW"),
and every departure removed the bank and kept the metadata:

- a cash seat-move departure, a busted-seat release, a sit-out eviction, a
  held leave, the leave-pending sweep, the horse profit-target cashout and
  `tearDownDepartedSeats` all called `timeBankEngine.removePlayer` alone;
- the only `timeBankMeta.delete` on the whole engine was in the cash branch of
  `adoptSeatRoster`;
- the tournament branch of `adoptSeatRoster` returned early and deleted
  nothing, and a tournament seat that closes (a table-balancing move, an
  accepted elimination) is simply absent from the next roster: the engine
  runs no leave path of its own for it (`TournamentGhostSeat.law`), so no
  tournament departure ever cleaned up.

The refusal happens before `stoppedTimeBankCustody` is assigned, so
`hasUnretiredStoppedTimeBankCustody()` answered true for ever through its
`timeBankMeta.size > 0` branch, `drainedF06Originals` stayed null,
`GameServer.unregisterTableEngine` refused (it is gated on
`retireStoppedTimeBanksForClosedSession()`), and the manager's `stop()` failed
every 5 seconds with "retained time-bank custody".

### The amplifier: a lease renewal that asked a corpse to renew

`TournamentManagerBase.renewTournamentLeaseProof` renews every engine in
`tableEngines` and fences the WHOLE tournament (`fenceForTournamentLeaseLoss`)
when any one of them cannot renew. The zombie watchdog kills a single
tournament table with
`engine.fenceForEngineLeaseLoss('tournament_table_zombie', true)`
(GameServer), which expires that engine's proof, marks it terminal and signals
the manager to replace it. Until the replacement's `stop()` settled the engine
was not `terminalTeardownComplete`, so it was not a drained original, fell
through to `renewEngineLeaseProof`, refused (an expired proof refuses by
design), and the manager fenced every sibling table for it. GameServer's
comment at the kill promised the opposite: "its identity-CAS replacement
preserves the tournament lease".

## The measurement

- 31,061 `Stopped time bank metadata has no original balance` throws over 24
  engines in 1.6 hours of the release.
- Single-table zombie kills at 19:54:05 UTC and 20:15:20 UTC each fenced a
  whole tournament; 17 managers quarantined with
  `tournament_lease_lost_stop_failed`; 50 tables idle for hours.

## What changed

### `ServerTableEngineBase.forgetTimeBank(userId)`

One helper, one invariant: `timeBankMeta` may name only a user who either has
a live bank in `timeBankEngine` or is covered by `stoppedTimeBankCustody`. The
helper removes the bank and deletes the metadata in one call and is used at
every departure that used to remove the bank alone: the cash seat-move
departure, the busted-seat release, the sit-out eviction, the held leave, the
leave-pending sweep, the gone-player prune in Dealing, the leave teardown in
Seating, the horse profit-target cashout and `tearDownDepartedSeats` in
Settlement. The tournament branch of `adoptSeatRoster` now forgets the bank
and the metadata of every user the next authoritative roster no longer holds,
which is the one place a tournament departure is observed.

Ordering: a cash seat-move deposits the player's presence (bank and metadata
included) for the destination table BEFORE it forgets them, in the same
synchronous block, exactly as before. A tournament move carries nothing
engine-side (the destination deals a fresh allowance), so nothing is deposited
after being forgotten. The cash branch of `adoptSeatRoster`, which already
deleted the metadata, is unchanged.

### `renewTournamentLeaseProof` skips a fenced dealer this manager is replacing

`ServerTableEngineBase.isTerminalFencedForTournamentLease(tableId, authority)`
is a read-only identity: terminal, not running, the same table under the same
tournament lease generation, with no claim about teardown completion and no
authority to deal. The manager treats an engine that satisfies it AND that the
manager is itself replacing (`tableEngineRecoveries` holds an operation for
that exact object, or a retry is booked for its table naming that object in
the new `tableEngineRecoveryExpected` map) the way it treats a drained
original: ownership is still checked against GameServer, no gameplay proof is
asked of it, and the manager's own lease is not lost for it.

## What is not changed

- The stop-time invariant check in `performStop` is not weakened. The
  departures now agree with it. A metadata entry with no bank still refuses
  custody and still quarantines the original (tested).
- A fenced dealer that nobody is replacing still fences the tournament
  (the existing "terminal without teardown" case, plus a new one).
- A live dealer that truly cannot renew still fences the tournament.
- A stopped dealer whose teardown failed and that has no replacement in flight
  still fences the tournament (existing "does not certify a failed teardown"
  case).
- No repair loop, no timer, no sweep. The retired 8825 checkpoint guard's
  description of the old behaviour (`legacy-engine-checkpoint-guard.mjs`) is
  historical and is left as written.

## How it was tested

- `server/src/engine/DepartedTimeBankMetadata.test.ts` (new): a tournament
  engine with three players dealt in (bank and metadata each); the next roster
  holds only one. Before the fix: 3 of 4 tests failed, `stop()` rejected with
  `Stopped time bank metadata has no original balance` at
  `ServerTableEngineBase.ts:3777`. After: the departed users are gone from
  `timeBankMeta` and `timeBankEngine`, `stop()` resolves,
  `stoppedTimeBankCustody.banks` names only the seated player,
  `unregisterTableEngine` succeeds and `hasUnretiredStoppedTimeBankCustody()`
  is false; the acknowledged-park path reaches the same answer; the invariant
  check itself still refuses when metadata is left without a bank.
- `server/src/tournament/TournamentLeaseProofDeadline.test.ts` (five new
  cases): a manager with two dealers, one killed through the watchdog's exact
  call with its stop held in flight; one renewal pass keeps the manager's
  lease and renews the sibling, and the zombie is neither asked to renew nor
  revived. The same holds while a retry is booked after a failed stop. A
  fenced dealer nobody is replacing, a live sibling that cannot renew, and a
  replaced dealer whose server ownership changed each still fence the
  tournament. Before the fix the two "keeps the manager lease" cases failed.
- `TheMoveIsNeverMidHand.law.test.ts` D5 now names `forgetTimeBank` as the
  time-bank line of the shared teardown.
- `npx tsc --noEmit -p server` clean; `src/engine` and `src/tournament`
  suites run (counts in the commit).
