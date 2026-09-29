# HORSE SYSTEM BUG REPORT

**Re-verified:** 2026-09-24, against `origin/main` at `2dc43f8a54`.
**Originally written:** 2026-03-11 (commit `f25c9436df`), 887 lines, 16 bugs, 4 gaps, 2 race conditions.

## What this document is now

Nothing in the 2026-03-11 report is live.

Every one of its 16 bugs was fixed five minutes after it was written, by commit
`cca3b88c27` ("fix: 16 horse system bugs", 2026-03-11 07:49:53, five minutes after
the report landed at 07:44:28). The report itself was never touched again, so for
six months it described defects that no longer existed, in files that increasingly
no longer existed, quoting a path from a session sandbox
(`/sessions/exciting-quirky-noether/...`) that had never been part of the repo.

Then the subsystem it describes was replaced. Commit `d394826734`
(2026-04-24, "Phases U1+U2+U3+U4+U5.1+U6") deleted `src/engine/` wholesale and moved
the table engine into `server/`. Of the six files the report names, **not one is in
the tree today**:

| Report's file                       | Status on `origin/main`                                                                                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/engine/HeadlessTableEngine.ts` | Deleted. Replaced by `server/src/engine/ServerTableEngine*.ts` (Base, Dealing, HandEvents, Runout, Seating, Settlement, Turns) plus `HandController.ts`. |
| `src/engine/HorseBrainAdapter.ts`   | Deleted. Replaced by `server/src/engine/HorseMind.ts` behind the out-of-loop worker in `server/src/engine/horseDecision/`.                               |
| `src/engine/BotLogic.ts`            | Deleted. Replaced by `server/src/engine/HorseLogic.ts` (7,826 lines, Monte Carlo equity per street).                                                     |
| `src/services/RakeService.ts`       | Deleted. Replaced by `server/src/services/supabase/rake.ts`, `rakeAllocation.ts`, `rakeAttributionLedger.ts`.                                            |
| `src/services/BBJService.ts`        | Deleted. Replaced by `server/src/services/supabase/bbj.ts` and the detector in `server/src/config/RakeConfig.ts`.                                        |
| `src/services/AutoRebuyService.ts`  | Deleted. Replaced by `server/src/services/HorseRebuyPolicy.ts` and the database rebuy path.                                                              |

`src/services/HydraService.ts` is the only named file that survived, and it survived
gutted: `seatHorse` is gone and `seedTable` refuses, because the browser does not seat
horses any more.

**Triage tally: 0 still live, 16 fixed, 4 never real, 2 obsolete.** The counts below
sum over the 16 bugs, 4 gaps and 2 race conditions the original report raised.

## The verdicts

Each verdict was reached from the current code or the commit history, never from the
old report's own claims.

### BUG #1 (and its duplicate, BUG #13): the brain was fed placeholder hand results

**Claim.** `HeadlessTableEngine.handleHandEvent()` called
`HorseBrainAdapter.processHandResult()` with `chipDelta: 0`, `showedCards: true`,
`folded: false` and `invested: 0` for every player on every hand, so the anti-exploit
modules learned from data that described no hand that had ever been dealt.

**Verdict: FIXED, then OBSOLETE.** This is the most consequential entry in the report
and the one worth the most words, because a brain trained on fabricated results is
degraded silently and permanently.

The claim was true when written. It was fixed the same morning by `cca3b88c27`, which
computed the four values from the engine's own player state. The file, the adapter and
the `processHandResult` signature were then all deleted in `d394826734`. The identifier
`chipDelta` appears nowhere in the tree today; neither does `processHandResult`,
`HorseBrainAdapter` or `warmGTOCache`.

What replaced it derives every field from the committed hand and cannot carry a
placeholder in the first place. In `server/src/services/supabase/handHistory.ts`, after
the authoritative hand transaction has been accepted, the settlement path enqueues one
`observeCompletedHand` request whose payload is:

- `committedHandId` = the UUID the accepted hand transaction returned,
- `handKey` = the hand's own table id and hand number,
- `actions` = `acceptedActions`, the recomputed accepted action list of that hand,
- `bigBlind` = the hand's big blind,
- `showdown` = the hand's own showdown reveal,
- `scope` = `readScopeOf(...)` over the hand's variant and dealt count.

`HorseMind.observeHandComplete` (`server/src/engine/HorseMind.ts`) then derives fold to
c-bet, fold to 3-bet and the big-river-bet reads from those actions and that showdown.
There is no per-seat outcome struct to fill with zeros: who folded is read from the fold
actions, what was invested is read from the action amounts, and who showed is read from
the showdown reveal's `mucked` flag.

**Pinned by:** a new assertion in
`server/src/engine/LiveHorseDecisionWorkerWiring.guard.test.ts`, "observes the hand that
was dealt, never a constant standing in for it". It pins each field of the observation to
the expression it reads from, pins `handKey` and `acceptedActions` to their own derivations,
and then walks every top-level field of the call and fails any field bound to a literal.
The second half is the part the original defect lacked: a measurement written into the
call as a constant is a red test, including for fields nobody has added yet.

Mutation-tested 2026-09-24. Rewriting `actions: acceptedActions` to `actions: []` fails it;
rewriting `bigBlind: params.bigBlind` to `bigBlind: 2` fails it; adding a fabricated
`folded: false` field fails it with the field named. Restoring each makes it pass.

### BUG #2: rake not attributed because `clubId` was undefined

**Verdict: FIXED, then OBSOLETE.** Fixed by `cca3b88c27`. `RakeService.distributeHandRake`
no longer exists; there is no browser-side rake waterfall at all. Attribution is now a
durable ledger, `server/src/services/rakeAttributionLedger.ts`, which rejects any stored
attribution row whose `club_id` is not a UUID rather than skipping it, and
`server/src/services/supabase/rake.ts` reads the club row before crediting anything.

### BUG #3: horses took 2.7 to 25 hours to reseed after a real player left

**Verdict: FIXED.** Fixed by `cca3b88c27`. `HydraService.onRealPlayerLeft` now reads
`randomInRange(entryDelayRange[0], entryDelayRange[1]) * 1000`, converting once. The path
is also dead twice over: `onRealPlayerLeft` has no callers, and `seedTable` refuses
(`37d6bb9410`) because the server fleet owns horse seats.

### BUG #4: stack sync promise not awaited, failures swallowed

**Verdict: OBSOLETE.** Fixed by `cca3b88c27`, then removed. `stackSyncPromise`,
`syncStacksToDatabase` and `syncTournamentPlayerChips` appear nowhere in the tree.
Stack persistence is now a step of settlement itself
(`server/src/engine/ServerTableEngineSettlement.ts`, "Update player stacks (atomic via
AtomicStackService)"), with the chip-conservation verifier in
`server/src/engine/eventlog/ChipConservationVerifier.ts` and the `ChipContinuity` and
`TournamentChipsAreConserved` laws over it.

### BUG #5: bet sizes silently capped to stack, looking like unintended all-ins

**Verdict: OBSOLETE.** Fixed by `cca3b88c27`. `playNuttedHand` does not exist.
`HorseLogic.decidePostflop` prices every decision off effective stacks: `toCall` is
capped by the actor's stack and the uncallable excess is stripped from the pot before
any ratio is taken, and sizing is chosen from equity rather than from a pot fraction
that is then clamped.

### BUG #6: BBJ money dropped from the pot but never contributed to a pool

**Verdict: OBSOLETE.** Fixed by `cca3b88c27`. The waterfall is gone.
`logBBJCollection` in `server/src/services/supabase/bbj.ts` calls one RPC,
`bbj_record_table_contribution`, which resolves the private or union pool and posts the
contribution inside a single database transaction, and the caller treats the call as
failed unless the returned receipt matches the table, club, hand id, hand number, amount
and big blind it sent. There is no window in which the drop is taken and the pool lookup
then fails.

### BUG #7: `warmGTOCache()` failure left the brain marked available

**Verdict: OBSOLETE.** Fixed by `cca3b88c27`. `HorseBrainAdapter` and `warmGTOCache` do
not exist. The live decision worker has an explicit readiness contract instead. In
`server/src/GameServer.ts`, READY is a boot prerequisite: table discovery cannot admit a
live horse turn until the worker exists, and unexpected worker loss is process-fatal
rather than silently replaced, because replacing it would reset RNG and learned-memory
ordering inside active hands. There is no synchronous fallback and no respawn path, which
`LiveHorseDecisionWorkerLifecycle.guard.test.ts` and
`LiveHorseDecisionWorkerWiring.guard.test.ts` pin.

### BUG #8: rebuy and reseat used different lock key formats

**Verdict: OBSOLETE.** Fixed by `cca3b88c27`. `AutoRebuyService`, `rebuyInProgress`,
`rebuyHorse` and `reseatHorse` do not exist. Horse rebuys are decided by
`server/src/services/HorseRebuyPolicy.ts` and funded through the database, whose own
atomicity covers what the in-memory lock was reaching for.

### BUG #9: hand timeout raced with concurrently added horse timers

**Verdict: OBSOLETE.** Fixed by `cca3b88c27`. `pendingTimerIds` and the 120 second
`handCompleteTimeout` do not exist. Horse decision work is now cancelled as one
turn-owned unit: `cancelHorseDecisionWork()` bumps `horseTurnToken`, aborts the in-flight
request and clears both the second-look and action timers, and both `clearLooseHandTimers()`
and `clearTurnTimer()` call it. That is pinned by the existing "cancels the request, deep
delay and action timer as one turn-owned unit" assertion.

### BUG #10: `compareKickers` treated a missing kicker as rank 0

**Verdict: NEVER REAL.** The reported shape is still in the tree, in
`compareKickers` in `server/src/config/RakeConfig.ts`, and it is still
`Math.max(a.length, b.length)` with a `?? 0` default. It is not a defect, and the
report's proposed replacement ("longer array wins") would have been an arbitrary rule
rather than a correct one.

Every one of the seven call sites compares two hands only after `handRanking` has already
been established as equal. Kicker arrays are produced per ranking by `PokerEngine`, and
within a ranking their shape is fixed (a full house is `[tripRank, pairRank]`, quads lead
with the quad rank, a flush is the five ranks, and the no-hand case is `[]` on both
sides). Two hands of equal ranking therefore always have equal-length kicker arrays, so
the `?? 0` branch is unreachable and there is nothing to fix. `cca3b88c27` did change the
old copy of this function; the change was harmless and the code has since been rewritten
in a different file anyway.

### BUG #11: postflop decisions used preflop hand strength

**Verdict: OBSOLETE.** Fixed by `cca3b88c27`. `decidePostflop` in
`server/src/engine/HorseLogic.ts` computes real equity per street against the
opponents' read ranges, averaged per board on multi-board hands, using the Monte Carlo
sampler. There is no carried preflop scalar.

### BUG #12: organic recede removed the first horse found, not the newest

**Verdict: FIXED.** Fixed by `cca3b88c27`. `HydraService.onRealPlayerJoined` sorts a copy
of the horses by `joinedAt` descending and removes the most recently joined one that is
not already leaving.

### BUG #14: union rake update did not check the union exists

**Verdict: FIXED.** `server/src/services/supabase/rake.ts` reads `union_id` off the club
row rather than taking it from a caller, so it cannot name a union that does not exist.
The credit is one atomic `increment_union_wallet` call that writes the wallet move and its
journal leg together, and its error is reported. The split-write drift this replaced
(-71.00 on 2026-08-19 and +25.39 across 2026-07-19 to 2026-07-24) is documented in the
function's own header.

### BUG #15: top-up amount could go negative

**Verdict: OBSOLETE.** Fixed by `cca3b88c27`. `AutoRebuyService.topUpWallet` and
`minWalletBalance` do not exist.

### BUG #16: variance calculation could be negative

**Verdict: NEVER REAL.** The report says so itself: the value was clamped to 0 to 1 and
the entry is filed as a readability note. `cca3b88c27` recorded it as "already safe". The
code no longer exists.

### GAP #1: no validation of dealer seat rotation

**Verdict: OBSOLETE.** Button selection is seat-based now, in
`server/src/engine/ServerTableEngineDealing.ts`: it works from the sorted live seats, has
an explicit heads-up rule keyed off the last big blind seat, and refuses to hand the
button to a player who has not yet been dealt in. `dealerSeatIndex` survives only as a
defensive back-fill for legacy readers, set from `sortedSeats.indexOf(dealerSeat)`, so it
can no longer index past the roster.

### GAP #2: tournament blind levels never advanced

**Verdict: FIXED.** `server/src/tournament/TournamentManagerBase.ts` has
`advanceBlindLevel`, a persisted level clock (`level_started_at`), break handling, and the
rule that a level is not spent on a hand that was never dealt.

### GAP #3: `HAND_COMPLETE` was not scoped to the hand that emitted it

**Verdict: FIXED.** `HandController` emits
`{ type: 'HAND_COMPLETE', handNumber: this.config.handNumber, rake, bbjFee }`, and the
engine's horse work is additionally fenced by turn token, lease generation and an exact
per-turn fence string, which `LiveHorseDecisionWorkerWiring.guard.test.ts` pins.

### GAP #4: no minimum betting unit, sub-cent bets possible

**Verdict: FIXED.** Chip granularity is now explicit and pinned by law: a Diamond is
indivisible and every divider on that path refuses a fraction rather than flooring it
(`docs/laws.d/a-diamond-does-not-divide.md`), tournament chips are whole
(`server/src/engine/tournamentWholeChips.ts`, `aTournamentChipDoesNotDivide.law.test.ts`),
and cash divides to the cent.

### RACE CONDITION #1: stack sync raced the next deal

**Verdict: OBSOLETE.** Same disposition as BUG #4. The fire-and-forget stack sync promise
does not exist.

### RACE CONDITION #2: parallel `seatHorse` calls could collide on a seat

**Verdict: OBSOLETE.** `seatHorse` was deleted and `seedTable` refuses. Horse seats are
created only by the server fleet, through `fn_horse_seat_from_treasury` and
`fn_seat_horse_in_seat_first_game`, which the database's seat guard recognises.

## What was changed on 2026-09-24

1. This document, rewritten. The dead sandbox paths are gone.
2. One new assertion in `server/src/engine/LiveHorseDecisionWorkerWiring.guard.test.ts`
   so BUG #1's class of defect cannot return silently. See BUG #1 above for the
   mutation test.

No production code was changed, because nothing the report raised is live.

## What was deliberately left

- **BUG #10's code shape.** Recorded as never real above. Changing an unreachable branch
  to a different unreachable branch is not a fix.
- **`HydraService.onRealPlayerLeft`.** It is dead (no callers) and its one effect would be
  to schedule a call to a `seedTable` that reports a refusal. Removing dead browser horse
  code is a separate piece of work from triaging this report, and it is not a defect
  anyone can reach.
- **Everything outside this report.** Re-verifying a stale report is not a licence to open
  a new audit.
