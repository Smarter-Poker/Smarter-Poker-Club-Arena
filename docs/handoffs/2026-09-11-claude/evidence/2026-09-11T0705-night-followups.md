# Workflow evidence: night-followups

- run: wf_04a6396a-5b0
- finished: 2026-09-11T07:05:11.171Z
- status: completed
- agents: 4
- summary: Four parallel follow-ups: process-root timers, resume-budget fixes, adversarial review of the frozen-hand fix, registering-walk speedup

## key

process-timers

## status

committed

## branch

fix/every-process-timer-runs-as-the-process

## commit

f7d52cdcd6aa108cbc308bebba202407c8dc444c

## worktree

/Users/smarter.poker/Documents/.agent-trees/club-arena/claude-process-timers

## summary

Both review findings are fixed and committed locally as one commit on top of origin/main 1579ac7c14. Not pushed, no PR opened.

(1) server/src/services/HorseHandReview.ts:1127. The retention prune setTimeout is now `setTimeout(bindToProcessRoot(() => {...}), 10*60*1000)`, with a dated comment explaining the incident. The prune is armed by the first flagged hand, reached via ServerTableEngineSettlement.postHandTasks -> logHandHistory -> handHistory.ts:590. It used to inherit that tournament's authority, so its DELETE across horse_hand_reviews (older than 30 days) and three horse daily rollup tables (older than 180 days) was sent under the lease headers. That was either admitted as the manager's work, or refused TOURNAMENT_MANAGER_FENCED once the tournament had finished (migration 20260908043200). Because pruneArmed is never reset, one refusal meant retention never ran again for the life of the process.

(2) server/src/services/supabase/dataActorContext.ts:69. bindToProcessRoot now returns `processRootScope.bind((...args) => tournamentManagerActor.run(undefined as unknown as TournamentManagerActorContext, () => work(...args)))`. It does not use exit(). The doc comment explains why: Node 22's AsyncLocalStorage writes the store onto the executing resource, which inside a root-bound callback is processRootScope itself, and exit() lets B leak back after a nested run().

Tests are in server/src/engine/theDeadlineClockBelongsToNoTournament.test.ts. The second describe is renamed to "the process's own database work never goes out as a tournament", with a dated header that states what the sweep found. The old name's claim ("every lazily-started process-wide timer") is not literally true: the two inert inheritors listed below still exist. Two tests were added:

- A behavioural prune test. It calls the real recordHorseHandReviews inside runWithTournamentDataAuthority(A), with vi.mock of the supabase client that records currentTournamentDataAuthority() when rpc('sp_prune_horse_hand_reviews') is called, and asserts [null].
- A nested-case test. A root-bound tick armed inside A calls B's bound method, which calls a root-bound helper. The test asserts the helper sees null, a nested run of C works, the store is null after that run, the helper's timer sees null, B is restored afterwards, and the tick is null.

The sweep read all 165 timer call sites in 72 non-test files under server/src. Only the prune needed binding; the classification is in findings. The commit message corrects #4225's claim that the nets flush was the only other lazy process timer.

## tests_run

All commands were run from server/ in the worktree on Node v24.15.0, each twice: with the default settings and with NODE_OPTIONS=--no-async-context-frame, which gives the async_hooks AsyncLocalStorage that Node 22 uses (production Dockerfile node:22-slim; CI server job uses Node 22).
(a) npx vitest run src/engine/theDeadlineClockBelongsToNoTournament.test.ts: 8/8 pass in both modes.
(b) The 11 dataActorContext test files (found with grep -rl dataActorContext src --include=\*.test.ts) plus the 17 HorseHandReview test files, deduplicated to 27 files: 256/256 pass in both modes. Baseline before the change was 96 + 164 tests.
(c) npx tsc -p tsconfig.json --noEmit: exit 0, no output. Re-run after the final test edit.
(d) Full server suite, npx vitest run: 668 files passed and 1 skipped; 9,175 tests passed and 145 skipped; exit 0. #4225 had 9,173; this commit adds 2.
(e) npx prettier --check on the 3 changed files: clean. lint-staged ran prettier on commit.
(f) node scripts/ci/check-horses-are-players.mjs: exit 0. Its note about an unused handFacts.ts register entry was already there and is unrelated.

## proved_failing_on_old_code

Each fix was reverted with git checkout of the source file, the final test file was run, and then the fixed files were restored. cmp confirmed the restored files are identical to the fixed copies.

- Both fixes reverted, Node 24 default: 1 failed, 7 passed. The prune test fails with Received [{tournamentId: aaaaaaaa-…0a, leaseGeneration: aaaaaaaa-…a1}] against Expected [null].
- Both fixes reverted, Node 22 semantics: 2 failed. The prune test fails the same way. The nested test fails with helper = B, helperAfterC = B, timerTheHelperStarted = B, and helperRunsC = "Tournament data authority cannot be rebound inside another manager context" (the production error).
- Only the old bindToProcessRoot restored, Node 22 semantics: only the nested test fails.
- The wrapper swapped to exit() as a variant, Node 22 semantics: the nested test fails with helperAfterC = B and timerTheHelperStarted = B. This confirms exit() leaks B back, so the test rejects that alternative too.
- New code: 8/8 pass on both implementations.

## findings

```json
[
  {
    "severity": "medium",
    "title": "FIXED: horse retention prune timer inherited the arming tournament's authority",
    "file": "server/src/services/HorseHandReview.ts",
    "line": "1127",
    "detail": "The prune is a one-shot setTimeout(10 min) guarded by the module-level pruneArmed. It is armed by the first flagged hand via ServerTableEngineSettlement.postHandTasks -> logHandHistory -> handHistory.ts:590 `void recordHorseHandReviews`, so it can be a tournament table's continuation. It calls supabase.rpc('sp_prune_horse_hand_reviews'), a process-wide DELETE. The timer inherited A's AsyncLocalStorage store: the behavioural test showed the rpc going out with A's authority on the old code.",
    "fix": "setTimeout(bindToProcessRoot(() => {...}), 10*60*1000), plus a behavioural test."
  },
  {
    "severity": "low",
    "title": "FIXED: bindToProcessRoot's contract failed when re-entered synchronously inside a tournament run on Node 22",
    "file": "server/src/services/supabase/dataActorContext.ts",
    "line": "69",
    "detail": "Under async_hooks AsyncLocalStorage, run(B) inside a root-bound callback writes B onto the shared processRootScope, so a nested root-bound call ran as B, and so did its timers. I reproduced this with --no-async-context-frame. It does not happen under Node 24's AsyncContextFrame. Production was not affected because every call site is a timer callback.",
    "fix": "The wrapper now clears the store with tournamentManagerActor.run(undefined as unknown as TournamentManagerActorContext, ...). It does not use exit(). A nested-case test was added."
  },
  {
    "severity": "info",
    "title": "SWEEP - process-wide, can be armed from a tournament path, does DB work: bound",
    "file": "server/src/engine/DeadlineScheduler.ts",
    "line": "360",
    "detail": "(i) DeadlineScheduler tick (DeadlineScheduler.ts:360), started by the first PreciseActionTimer. (ii) Horse nets flush (HorseHandReview.ts:827), started by the first settled hand. Both were bound by #4225 and are left unchanged. (iii) Horse prune (HorseHandReview.ts:1127), bound in this commit. These are the only three."
  },
  {
    "severity": "info",
    "title": "SWEEP - can inherit an authority but never uses it: left unbound",
    "file": "server/src/tournament/TournamentEliminationScheduler.ts",
    "line": "318",
    "detail": "(a) TournamentEliminationScheduler wakeTimer (:318) and warningTimer (:478). They are armed from scheduleWake/remove/dispatch in the calling manager's context. Every tournament call goes through AsyncResource.bind(registration.run/isActive) (:150-153), which is pinned by TournamentEliminationAuthority.test.ts:89 'a timer armed by A dispatches B in its registration context'. The work done in the ambient context is only queue bookkeeping, gauges and reportError. Binding the wake would also reindent the callback that the sched agent's fix edits.\n(b) EquityWorkerPool respawn (EquityWorkerPool.ts:446). It is reached through retireWorker from onJobTimeout, and the job timer (:304) is created in the requesting engine's context, which can be a tournament table. The replacement Worker's message/error/exit listeners inherit that context, but they only move jobs and settle promises; each awaiting caller resumes in its own context. There is no DB work and no bound call.\n(c) Horse decision client per-job timers (client.ts:460, 510, 772) and queueMicrotask(onFatal) (:716). These only end in a fatal shutdown, and index.ts:426 already runs that shutdown bound to the bootstrap context."
  },
  {
    "severity": "info",
    "title": "SWEEP - already capture the process owner at start",
    "file": "server/src/services/supabase/handProjection.ts",
    "line": "511",
    "detail": "handProjection retryTimer and pollTimer (:440, :539) go through runOwnedDrain = AsyncResource.bind(beginDrain) (:511); start throws if called inside an authority (:506). GameServer timers at :6109, :6147, :6280 and :6304 are armed only from realtime receivers bound with AsyncResource at start and guarded at :6018/:6160. index.ts shutdown timers (:351, :372) run inside the bound shutdown (:426). Realtime channel callbacks go through bindRealtimeCallbacksToRegistration."
  },
  {
    "severity": "info",
    "title": "SWEEP - boot-started, worker-thread, per-entity or per-operation: correctly unbound",
    "file": "server/src/GameServer.ts",
    "line": "1766-2188",
    "detail": "Boot-started from GameServer.start(), index.ts startLeaderOwnedServices, or module evaluation:\n- GameServer: break, feeReconcile, clockSkew, leaseReap, bombLedgerRepair and breakResume timers\n- errorReporter, rakeSpecGuard, handOutboxMetrics and handOutboxListener\n- leadership, EquityLoadGovernor, EventLoopLagMonitor, StatsHealthMonitor, MaintenanceBreak\n- ChannelHub and http/auth module-level intervals, the WebSocket heartbeats, ClusterController\n- DealRate, HorseFleet, HorseLifecycle, Rakeback, Replication, ScheduledTournament, Spin/Tournament metrics, TournamentRecurring, StableHand and SessionRotator\n- BrainTelemetryFlush, the Gto drivers, HorseDailyAudit, HorseDataLedgerSync, HorseLaneLoader, HorseOverlayGuard, HorseSelfTuner, HorseLeague\n- the TournamentEliminationScheduler metrics interval (module singleton), and the equity pool and horse decision client ready/status timers\n\nWorker-thread only: AdaptiveRefreshLoop (GTO loaders), SolverPolicyArtifactLoader, HorseMindPersistence. src/scale is not imported by production code.\n\nPer table, tournament, connection or job, so they keep that authority:\n- all ServerTableEngine* instance timers, HandController, DisconnectEngine, EngineTelemetry (per engine), TournamentManagerBase lifecycle timers\n- GameServer per-table/per-tournament admission retries (:884, :1231), armed only from GameServer, discovery or cash contexts\n- ClusterController.wake (:358), guarded to cash tables at ServerTableEngineBase.ts:3175\n- WebSocket per-connection reapers and club-join retries\n\nPer-operation sleeps and aborts: the client.ts fetch timeout and retry, handHistory, bbj, wallets, pagination, FeeReconciler, TournamentRecurring retries, engineAlerts, TournamentBrainContext.withRefreshTimeout, the tournament/*Rpc sleeps and the engine sleeps."
  }
]
```

## concerns

```json
[
  "I deviated from 'fake timers'. Vitest fake timers cannot detect this defect: the fake clock fires callbacks inside advanceTimersByTime, in the test's own context. I checked this empirically: a callback armed inside A sees null on the fake clock and A on real timers, so a fake-timer test passes on the old code. The prune test therefore uses real Node timers, with a setTimeout spy that shortens only the 10-minute delay synchronously inside the arming call. Mocked supabase, arming inside A and the null assertion are as requested.",
  "The nested-case test only discriminates under the async_hooks AsyncLocalStorage: Node 22 (production and the CI server job) or Node 24 with --no-async-context-frame. On Node 24 defaults the old code also passes it, because the bug does not exist there. The test comment says this.",
  "I renamed the second describe from 'every lazily-started process-wide timer runs as the process' to \"the process's own database work never goes out as a tournament\". The old literal claim stays false for two timers that inherit an authority but never use it: the TournamentEliminationScheduler wake timer and the EquityWorkerPool worker respawn. I left both unbound because nothing in them needs binding. Binding the wake timer would also reindent the callback that the separate sched-finding fix edits. If the orchestrator wants the literal claim true, bind EquityWorkerPool.ts:446 and TournamentEliminationScheduler.ts:318 in a follow-up.",
  "handProjection.ts:511, GameServer's realtime receivers and index.ts:426 use a bare AsyncResource.bind. On Node 22 that has the same theoretical nested re-entry weakness the old bindToProcessRoot had, but none of their bound functions is re-entered synchronously from inside a tournament run today. I did not change them.",
  "Out of scope, noted only: process-wide in-flight refresh promises run in the first caller's context. An example is bbjDrillRegistry.maybeArmed, which is cash-only because BBJ is disabled for tournament tables, so it is not a live issue.",
  "origin/main has moved 5 commits past the base 1579ac7c14. None of them touches the 3 changed files, so the branch should merge cleanly. Not pushed and no PR, as instructed."
]
```

---

## key

resume-budget

## status

committed

## branch

fix/the-resume-budget-counts-only-real-losses

## commit

d8f1efcb6ed811aede5e601e318ec2a9bb196dec

## worktree

/Users/smarter.poker/Documents/.agent-trees/club-arena/claude-resume-budget

## summary

I made two local commits on fix/the-resume-budget-counts-only-real-losses, on top of origin/main 1579ac7c14. Nothing is pushed and no PR is open.

Commit 4b1e79903a0be8d1ed95bb0aa0bdd4f0b8a92ab7 fixes the three resume-budget findings.
(1) Completions no longer count as distress. performOwnedEngineLeaseProofRenewal now judges each lost manager before calling manager.fenceForTournamentLeaseLoss(), using a new read-only TournamentManagerBase.stoodDownWithItsLeaseIntact(): `!tournamentLeaseAuthorityExpired && (stopFenceApplied || (!running && !shutdownDrainFenceApplied))`. The drain clause copies the refusal condition in renewTournamentLeaseProof, so a manager draining hands at shutdown still counts as holding its lease. I checked the side effects first: isRunning(), hasCurrentTournamentLeaseAuthority(), lifecycleIsCurrent() and captureLifecycleToken() all expire a lapsed proof, and expiry fences the manager, so none of them could be used. A manager that stood down on its own is still fenced and retired, but it is neither reported as GameServer.tournament_lease_lost nor charged. An expired proof, a database fence or a takeover while running is still reported and charged.
(3) Each manager is charged at most once, using a WeakSet named tournamentManagersJudgedLost. The set holds every manager that has been judged, not only the charged ones. This matters: the first pass's fence sets the expiry flag, so a set of charged managers only would still charge finished managers on the next pass. The test showed this (6 charged instead of 1).
(2) Failing heads no longer starve the tail. tournamentResumeBudget.ts, still import-free, gets resumeCooldownMs (5s, doubling, capped at 5 min), a RunningResumeCooldowns class, and a coolingDown() predicate on RunningResumePass. selectRunningResumes skips cooling ids without spending budget. In the lane, the .finally of each resume records a failure when there is no manager and forgets the id when there is one. settle() ends a streak when the id has a manager or has left the RUNNING board, and it only runs on a board that was actually read. admissionInFlight and the re-check after the stagger now also count ids waiting on tournamentManagerAdmissionRetryTimers. /health gains tournamentResumesFailing.
Tests for this commit: the old pin that required `+= lostManagers.length` is replaced. The new pin requires the judgment to come before the fence, the charge to happen only when the manager did not stand down, each manager to be judged once, and the accessor not to call any of the side-effecting methods. The new test file server/src/aFinishedTournamentIsNotALostLease.test.ts runs the real renewal pass against real manager instances. The starvation law test uses 740 rows with budget+3 heads that always fail, at budget 25 and at the floor of 5; it requires the whole tail to be adopted and the heads to be retried on the doubling schedule. I also updated the existing wiring pins.

Commit d8f1efcb6ed811aede5e601e318ec2a9bb196dec fixes both LOW scheduler findings. Each fix is a few lines and each has a test, which is why I included them; they are in a separate commit so you can drop it if you want.
(a) The wake-timer due batch now counts as a pump pass (pumping=true inside try/finally), so a pump triggered by an unregister while the batch is being built is folded into the single pump that follows.
(b) An urgent upgrade now removes the entry's old reference from routineQueue.

Files changed:

- server/src/GameServer.ts
- server/src/tournament/TournamentManagerBase.ts
- server/src/tournamentResumeBudget.ts
- server/src/tournamentResumeBudget.test.ts
- server/src/aFinishedTournamentIsNotALostLease.test.ts (new)
- server/src/tournament/TournamentEliminationScheduler.ts
- server/src/tournament/TournamentEliminationScheduler.test.ts
- server/src/tournament/aDeadManagerCannotRecurseTheScheduler.test.ts

## tests_run

All run inside the worktree.

- Required list: server/src/tournamentResumeBudget.test.ts (20), server/src/engine/DirectEngineRecovery.guard.test.ts (18), server/src/tournament/SpinStartsInOneSecondAndPlaysInFull.test.ts (16), and the grep hit server/src/theLongestWaitIsAdoptedFirst.test.ts (6). All pass.
- Other tests touching these names or the lease internals, all pass: aFinishedTournamentIsNotALostLease (3), EngineLeaseBoundary.guard, DirectAdmissionLifecycle, TournamentEliminationScheduler (11), aDeadManagerCannotRecurseTheScheduler (4), EliminationSweepLock.guard, TournamentEliminationAuthority, theSweepOnTheCoreIsANumber, TournamentLeaseProofDeadline, AFencedManagerStandsDown, TournamentLifecycleOwnership.guard, TournamentManagerOwnership, GameServerRealtimeOwnership, TournamentLeaseGeneration.guard. That is 18 files and 176 tests.
- Full server suite (`cd server && npx vitest run`): 669 files passed, 1 skipped; 9,183 tests passed, 145 skipped.
- Root tests: the 42 files under tests/ that read GameServer, TournamentManagerBase, the scheduler or the budget, including realtime-capacity-alerts.law, all pass (765 tests).
- Server typecheck (`cd server && npx tsc -p tsconfig.json --noEmit`): exit 0, no output, both before and after the final edit.
- Prettier check is clean, and lint-staged ran on both commits.
- After committing, I re-ran 9 key files (99 tests) on HEAD; all pass.

## proved_failing_on_old_code

Each new test was reverted against and fails for the reason it targets:

- Reverting the renewal fix to the old `tournamentResumeDistress += lostManagers.length`, with the accessor left in place: aFinishedTournamentIsNotALostLease fails with 'expected 5 to be 3', and the pin fails with 'not to contain lostManagers.length'.
- Removing only the judged-once WeakSet and keeping the stand-down check: the second pass charges 6 instead of 1 ('expected 6 to be 1').
- Removing only the coolingDown skip from selectRunningResumes: the starvation law fails with 'the whole tail is adopted at budget 25: expected +0 to be 712', and the cooling selection test returns ['t-0000','t-0001','t-0002'].
- Running the scheduler tests against origin/main's TournamentEliminationScheduler.ts: the batch test reads [R, U] instead of [U, R], and the stale-reference test reads [X, A, A, B, C] instead of [X, A, B, C, A]. These are the reviewer's exact reproductions.
  The fixed files were restored after each revert, and the committed HEAD tests green.

## concerns

```json
[
  "Trade-off in finding 2: the cooldown also applies when the claim answers owned_elsewhere. If a previous process still holds leases (a crash restart inside TOURNAMENT_LEASE_STALE_SECONDS=30, or an overlapping drain), a head id can be adopted up to one cooldown step later than before. For example, ids retried at 5, 15, 35 and 75 seconds wait up to about 40 seconds after a 60-second hold ends. That is the cost of not re-claiming the same heads every 5 seconds while the tail waits.",
  "The retry-timer part of finding 2 was applied as suggested. Ids waiting on tournamentManagerAdmissionRetryTimers count as in flight but hold no budget slot, so the lane moves on to the tail while those ids run their own retry chains (250ms doubling to 15s, repeating while the claim stays retryable_failure). If the board reads but claims keep failing, the set of ids in retry chains can now spread across the board: at most about 740 ids times one claim per 15s, roughly 50 claims per second. Before, it stayed near the ~25 head ids. New launches are still bounded by the budget each pass, and a failed board read launches nothing. If that load matters, a follow-up could count lane-launched ids with a pending retry against the room, capped by RESUME_IN_FLIGHT_HORIZON_MS.",
  "Unchanged by design: a resume that settles without a manager and without a retry timer (resume_failed, owned_elsewhere) still adds no distress. It now only cools the id down.",
  "Remaining edge in finding 1: renewVerifiedTournamentManagerLeaseProofs calls hasCurrentTournamentLeaseAuthority() before the judgment. So a manager that stood down and whose 20s proof then lapsed before any renewal pass read it (a stall of 15s or more) is still charged. This is documented in the code comment as a storm signature. Handling it would mean judging before the heartbeat loop or changing which managers get heartbeats; I left the heartbeat set as it was on purpose.",
  "Behaviour change: stood-down managers, including finished tournaments, no longer log GameServer.tournament_lease_lost, and a quarantined manager logs it once instead of every 5s. Its stop failure is still reported on every pass as GameServer.tournament_lease_lost_stop_failed. Any dashboard counting tournament_lease_lost will drop by about the completion rate.",
  "The new behavioural test builds a bare GameServer (Object.create, the same pattern as DirectAdmissionLifecycle.test.ts) and sets private fields by name, including tournamentManagersJudgedLost. Renaming that field will break the test.",
  "The 'deadline' key in wf_args.json (HorseHandReview prune timer, bindToProcessRoot) was not part of this task and was not touched.",
  "The two commits are separate: 4b1e79903a is the resume budget, d8f1efcb6e is the scheduler. If you squash them, the PR text needs to cover both."
]
```

## findings

```json
[
  {
    "severity": "medium",
    "title": "Normal completions charged as re-adoption distress (fixed)",
    "file": "server/src/GameServer.ts",
    "line": "699-744",
    "detail": "performOwnedEngineLeaseProofRenewal counted every retired manager. A finished tournament's manager is stopped but stays in tournamentEngines until this pass retires it, so each completion was charged and logged as a lost lease.",
    "fix": "Each lost manager is judged before the fence with the new read-only TournamentManagerBase.stoodDownWithItsLeaseIntact() (TournamentManagerBase.ts ~641). Only a manager that did not stand down on its own is reported and charged. Fencing and retirement still happen for every lost manager."
  },
  {
    "severity": "low",
    "title": "A lost manager was charged on every renewal pass (fixed)",
    "file": "server/src/GameServer.ts",
    "line": "730-741",
    "detail": "A quarantined manager whose stop() keeps failing was charged every 5s, holding the budget at the floor.",
    "fix": "A WeakSet (tournamentManagersJudgedLost) records every judged manager, charged or not, so each manager is reported and charged at most once. Recording only charged managers is not enough, because the fence flips the expiry flag."
  },
  {
    "severity": "medium",
    "title": "A failing RUNNING head could starve younger tournaments (fixed)",
    "file": "server/src/tournamentResumeBudget.ts",
    "line": "86-199",
    "detail": "Selection had no memory of ids whose resume came back without a manager, and ids waiting on a retry timer were relaunched every pass.",
    "fix": "Added RunningResumeCooldowns (5s doubling to a 5 min cap) and a coolingDown predicate that is skipped without spending budget. The lane records a failure or forgets the id in each resume's .finally, and settles streaks against each successfully read board. admissionInFlight now also counts tournamentManagerAdmissionRetryTimers. /health reports tournamentResumesFailing."
  },
  {
    "severity": "low",
    "title": "Wake-timer due batch pumped mid-batch when a manager died inside enqueue (fixed)",
    "file": "server/src/tournament/TournamentEliminationScheduler.ts",
    "line": "354-369",
    "detail": "The unregister closure's pump ran outside a pump pass, so a routine sweep could take the slot before an urgent sweep in the same batch was enqueued.",
    "fix": "The batch enqueue runs with pumping=true inside try/finally; a pump requested during it is folded into the single pump that follows."
  },
  {
    "severity": "low",
    "title": "Stale routine reference after an urgent upgrade let a hot tournament jump the queue (fixed)",
    "file": "server/src/tournament/TournamentEliminationScheduler.ts",
    "line": "290-305",
    "detail": "The old routine reference became valid again after a routine rerun, giving X,A,A,B,C instead of X,A,B,C,A.",
    "fix": "The upgrade branch splices the entry's reference out of routineQueue, so each queued entry has one reference."
  }
]
```

---

## key

review-frozen-hand

## status

review-only

## worktree

~/Documents/.agent-trees/club-arena/claude-frozen-hand

## branch

fix/a-hand-frozen-at-the-break-is-reaped

## commit

5d1f406248

## summary

Not correct as shipped. The change is sound for the case it handles: a table that is mid-hand and held only by maintenancePaused. isParkedByDesign() only differs from isPausedByDesign() when maintenancePaused is set, the table is mid-hand and no other authority holds it, so nothing changes outside the break. Replacements are parked on arrival on both the tournament and cash rebuild paths. A hand landing after :55 goes down the same path any straggler already takes.

It has two defects that block it:
(1) HIGH, the fix is incomplete. At :55 the tournament synchronized break (TournamentManagerBase.pauseForBreak) calls pauseAfterHand() on every table, including tables still mid-hand, which sets handForHandPaused. The new predicate counts that authority immediately, even mid-hand. So from :55 the watchdog and the reaper stand down again for a frozen hand at any tournament that takes the break (every format except Spin/SNG). The reaper's exemption lasts until :53 + 10 min = :03. readyForRestart can only open between :55 and :57. The fix therefore covers MTT tables only in the :53-:55 window. For #4225's population the watchdog never ran (heartbeat callbacks threw), and the reaper can only get them before :55 and only past 180s without progress, so in that incident the break would most likely still not have certified. A temporary harness test proves it: with maintenancePaused plus pauseAfterHand(break+grace, {beforeNextHand, untilResumed}) mid-hand, isParkedByDesign() is true, six watchdog runs do nothing, and the reaper predicate still exempts the table. The commit's own test at TableWatchdog.test.ts:448 pins this behaviour.
(2) HIGH, the build goes red. tests/unit/tournamentRakeAndBreaks.test.ts:188 still requires engine.isPausedByDesign() in the reaper. The commit removes that call, and its own law test forbids it. The failure was checked on the commit and the test passes on the parent. The CI client shards and the publisher shards run tests/.

Recommended fix: count handForHandPaused and dealHoldUntilMs only between hands. The tournament manager puts both back on any replacement before admitting it (TournamentManagerBase.prepareManagedTableEngineForPlay), so the 'a rebuild deals into it' reason does not apply to them. That fix passes 431 server test files, apart from the commit's own 4th test, which has to be inverted.

## findings

```json
[
  {
    "severity": "high",
    "title": "The :55 tournament break shields a frozen MTT hand again, so the fix misses the incident population and the certificate window",
    "file": "server/src/engine/ServerTableEngineBase.ts",
    "line": "4897-4917",
    "detail": "isParkedByDesign() counts every non-break authority immediately, even mid-hand (4899 -> isHeldByDesignApartFromTheBreak, handForHandPaused at 4910). At :55 GameServer.triggerSynchronizedBreak (GameServer.ts:3997) calls tm.pauseForBreak for every running tournament that takes the break. pauseForBreak loops over every table engine with no mid-hand check and calls engine.pauseAfterHand(break+grace, {beforeNextHand:true, untilResumed:true}) (TournamentManagerBase.ts:1653-1668). That sets handForHandPaused (ServerTableEngineBase.ts:4083-4094). From :55 a frozen mid-hand MTT table is therefore 'parked by design' again: the watchdog returns early (ServerTableEngineTurns.ts:442) and the reaper sets parkedOnPurpose=true (GameServer.ts:4900) until msPaused > 10 min. pausedSinceMs was stamped at :53 by pauseForMaintenance (ServerTableEngineBase.ts:4118) and pauseAfterHand does not reset it, so the exemption runs to :03. readyForRestart needs phase counting_down and at least 3 min remaining (MaintenanceBreak.ts:319, 2055-2062), so it can only open between :55 and :57. That is exactly when the shield is up. Only Spin/SNG, or tournaments with synchronized_breaks=false, skip the :55 break (breakEligibility.ts:45-49, 75). For #4225 specifically, the heartbeat and turn callbacks threw (see the 999b57756e message), so the watchdog half never ran and the reaper was the only rescuer. With this commit the reaper can only reap an MTT table between :53 and :55, and only once msSinceProgress > 180s. A table the zombie loop rebuilt in the minute before :53 (about 1/3 of a 3-minute cycle) still holds the gate through :57. The waitForAllTablesParked ceiling (GameServer.ts:4204-4214, 5 min) only starts the tournament countdown and kills nothing. Proven in a temporary detached worktree with the TableWatchdog harness. The setup was maintenancePaused plus e.pauseAfterHand(420000, {beforeNextHand, untilResumed}), mid-hand, 46s stale. Results: isBetweenHands=false, isPausedByDesign=true, isParkedByDesign=true; six runTableWatchdog calls gave no startTimer, no forced action and no kill; the reaper predicate gave parkedOnPurpose=true at msSinceProgress 200s. The commit's own test TableWatchdog.test.ts:448-466 asserts this outcome is intended.",
    "fix": "Count handForHandPaused and dealHoldUntilMs only between hands, like the break. TournamentManagerBase.prepareManagedTableEngineForPlay (763-787) puts onBreak, the add-on break and hand-for-hand back on every replacement before replaceTableEngine or registerTableEngine; tests/unit/tournamentRakeAndBreaks.test.ts:195-201 already pins that. Keep the mid-hand exemption only for per-engine fences a rebuild would lose. For example: isParkedByDesign(){ if (this.isBetweenHands()) return this.isPausedByDesign(); return this.finalTableDealPaused || this.terminalCloseoutPaused || this.tableFSM.state === 'paused'; }. With that change, the server engine/maintenance/tournament/cluster suites (431 files, 5,901 tests) passed in a scratch tree; the only failure was the commit's 4th test, which has to move handForHandPaused and dealHoldUntilMs to the 'worked' side. Add a test of the real :55 sequence (maintenancePaused plus pauseAfterHand(..., {beforeNextHand, untilResumed}) mid-hand and stale: Tier 1 re-arms the clock, and the reaper predicate is false). Correct the comment, changelog and commit text that say every other authority holds a table mid-hand, and the claim that the watchdog addresses #4225."
  },
  {
    "severity": "high",
    "title": "Root suite red: tournamentRakeAndBreaks.test.ts:188 still requires engine.isPausedByDesign() in the reaper",
    "file": "tests/unit/tournamentRakeAndBreaks.test.ts",
    "line": "183-193",
    "detail": "The test slices 3000 chars from 'const shouldBeDealing' and expects /engine\\.isPausedByDesign\\(\\)/. The commit replaces the only such call (GameServer.ts:4900), and its new law test (tests/a-parked-table-is-not-a-stalled-one.law.test.ts:175-180) forbids it, so the two pins contradict each other. I ran the 42 root tests that read GameServer.ts, ServerTableEngineBase.ts or ServerTableEngineTurns.ts: 1 failed ('GameServer's reaper skips engines paused by design'), 694 passed. A slice check against parent 1a0cdc3eed confirms the regex matched before the commit. CI runs 'vitest run tests/ --shard' for any server/ diff (ci.yml:196-198, 1015), and the publisher re-runs the same shards. ci.yml:186-194 records this same file going red on main on 2026-09-02 and freezing production publishing.",
    "fix": "Change line 188 to expect(reaper).toMatch(/engine\\.isParkedByDesign\\(\\)/) and keep the gate regex at 190-192. Add a dated comment explaining that the reaper now asks whether the pause has taken effect. Before committing, run npx vitest run tests/unit/tournamentRakeAndBreaks.test.ts tests/a-parked-table-is-not-a-stalled-one.law.test.ts, ideally the whole tests/ tree."
  },
  {
    "severity": "medium",
    "title": "The new pins claim every other authority holds a table mid-hand, which is false for all of them",
    "file": "server/src/engine/TableWatchdog.test.ts",
    "line": "448-466",
    "detail": "Every authority in isPausedByDesign() is a no-new-hand fence that can be raised mid-hand while the current hand plays on: pauseAfterHand (4083; used for hand-for-hand at TournamentManagerEliminations.ts:1462-1466, the :55 break, the add-on break at TournamentManagerBase.ts:6334-6343, and the shutdown drain), pauseForFinalTableDeal (4126, 'stop before the next hand'), parkForTerminalCloseout (4174, 'next-hand fence'), holdDealingUntil (525; raised mid-hand by the add-on break at TournamentManagerBase.ts:6323), and setMaintenanceLock, which sets FSM 'paused' immediately (ServerTableEngineSeating.ts:1466-1468). The move-pause term already requires handForHandResolve !== null, meaning the loop is on the gate. None of them stops the turn clock, so a frozen hand under any of them is as dead as under the break. There is also a pre-existing, same-class latent freeze: a hand that freezes during hand-for-hand is never rescued and holds the whole bubble barrier until the 10-min reaper ceiling. The 4th watchdog test and the law assertion 'every other authority counts at once' (a-parked-table-is-not-a-stalled-one.law.test.ts:188-192) lock this in, which makes the fix for finding 1 harder. The test rationale 'a rebuild would deal into it' is contradicted for handForHandPaused and dealHoldUntilMs by prepareManagedTableEngineForPlay.",
    "fix": "Keep the 'still exempt mid-hand' test only for finalTableDealPaused, terminalCloseoutPaused and FSM 'paused' (state a rebuild really loses). Move handForHandPaused and dealHoldUntilMs to a 'worked mid-hand' test. Relax the law test so it asserts the between-hands clause instead of the current split."
  },
  {
    "severity": "low",
    "title": "The reaper half has no behavioural test",
    "file": "server/src/GameServer.ts",
    "line": "4899-4900",
    "detail": "Mutation check: reverting 4900 to engine.isPausedByDesign() leaves all 23 TableWatchdog tests green and is caught only by the source regex in the new law test. Reverting the watchdog line (ServerTableEngineTurns.ts:442) does fail the two new behavioural cases, which confirms the commit's claim for the watchdog. Nothing checks the reaper decision itself (shouldBeDealing, parkedOnPurpose, msSinceProgress > 180_000) against engine states, or the end-to-end result: frozen mid-hand at :55, then reap, then adopt, then readyForRestart true.",
    "fix": "Extract the reaper verdict into a pure static helper, e.g. GameServer.isZombie(engine, seatedCount), and unit-test it: maintenance-only mid-hand at 181s reaps; maintenance between hands is exempt; maintenance plus the :55 tournament break mid-hand reaps once finding 1 is fixed. Optionally add a MaintenanceBreak test where a fake mid-hand engine is replaced by an adopted between-hands engine and readyForRestart opens."
  },
  {
    "severity": "low",
    "title": "(g) drainHands is dead code with a vacuous predicate; the real SIGTERM drain does not read isPausedByDesign",
    "file": "server/src/GameServer.ts",
    "line": "3473-3518",
    "detail": "drainHands() has no production caller: index.ts delegates shutdown to GameServer.stop(), and a test pins that it does not call drainHands. The actual drain is GameServer.stop() at 2503-2512, which uses isDrained(). Leaving 3500 on isPausedByDesign has no runtime effect. The predicate is vacuous anyway: drainHands calls pauseAfterHand() on every engine (3482) before polling, which makes isPausedByDesign() true everywhere. Switching it to the committed isParkedByDesign() would be equally vacuous, because handForHandPaused counts immediately. The commit text's 'SIGTERM drain' label and MaintenanceBreak.ts:43 / ServerTableEngineBase.ts:3840 point at this dead method.",
    "fix": "No change needed in this commit. Follow-up: delete drainHands, or base it on isBetweenHands()/isDrained(), and correct the stale comments."
  },
  {
    "severity": "none",
    "title": "(c) The tournament reap path parks the replacement: verified hop by hop",
    "file": "server/src/GameServer.ts",
    "line": "4919-4922, 7439-7487",
    "detail": "Hops: GameServer.ts:4919-4922 fenceForEngineLeaseLoss('tournament_table_zombie', true) -> ServerTableEngineBase.ts:863-868 killForRestart(reason, notifyOwner=true) -> 3734-3779 (running=false, handController=null) and signalRestartRequired via queueMicrotask -> TournamentManagerBase.ts:1285-1296 onRestartRequired -> recoverManagedTableEngine (907) -> performManagedTableEngineRecovery (959-1036): stop, seat-move quarantine, createManagedTableEngine, prepareManagedTableEngineForPlay (763-787), replaceTableEngine -> GameServer.ts:7439-7487 identity-CAS replaceOwnedTableEngine, then maintenanceBreak.adopt at 7485 -> MaintenanceBreak.ts:1006-1010 pauseForMaintenance(remainingParkBudgetMs) -> startManagedTableEngine. The replacement never resumes the hand: checkCrashRecovery at ServerTableEngineBase.ts:6579-6620 marks it complete. The start-up loop parks at the top (2556-2566), so the table is between hands and not in unparkedTables. The deferred path, admitMissingManagedTableEngine (866-905), goes through registerTableEngine, which adopts at 7429. A killed engine is !isRunning and not counted while its recovery is pending (MaintenanceBreak.ts:1649).",
    "fix": "None."
  },
  {
    "severity": "none",
    "title": "(d) The cash reap path parks the replacement: verified",
    "file": "server/src/GameServer.ts",
    "line": "4923-4931, 990-1048, 7826",
    "detail": "Hops: fenceForEngineLeaseLoss('cash_table_zombie', false) and recoverDirectTableEngine (4923-4931) -> performDirectTableEngineRecovery (990-1048: stop, exact lease release, delete, ensureCashTableEngineAdmission) -> new ServerTableEngine -> maintenanceBreak.adopt(tableId, engine) at 7826, before engine.start(). A Tier-3 watchdog kill reaches the same path via wireDirectTableEngineRecovery (948-958). cash_tables_needing_engine has no freeze gate, so shouldBeDealing still holds during the break.",
    "fix": "None."
  },
  {
    "severity": "none",
    "title": "(b) and (e): freeze semantics and pausedSinceMs",
    "file": "supabase/migrations/20260905075122_the_journal_is_never_refused_by_the_freeze.sql",
    "line": "82-90",
    "detail": "The latest fn_refuse_while_frozen still exempts service_role, so the engine's settlement of a hand that lands after :55 is written. fn_refuse_new_entries_while_frozen only refuses new seats, registrations and launches. Tournament eliminations and moves defer on isMaintenanceFrozen. No in-hand path reads the freeze flag, so the break never causes a mid-hand stall. This is the existing straggler path (MaintenanceBreak.beginCountdown, 1191-1206). What is new is only that the watchdog and reaper can now cause a landing (Tier 1/2) or a void (Tier 3/reaper) inside :53-:00, exactly as they would outside the break. The rebuild during the freeze is the same boot path adopt() serves every hour at about :58. (e) pausedSinceMs is set at :53 even on mid-hand tables and is not reset by later authorities; pausedTooLong only matters once a table is parked. Parked tables are exempt until :03, after the :00 end. No issue.",
    "fix": "None."
  },
  {
    "severity": "none",
    "title": "(f) The other isPausedByDesign readers are correctly left alone",
    "file": "server/src/GameServer.ts",
    "line": "3555",
    "detail": "tableLivenessSnapshot.paused feeds DealRateVerifier (1545-1549), /health stalledTables (2688-2690), metrics (3157-3159) and EngineLivenessVerdict.ts:48. These are describing or alerting readers. Switching them would count break-frozen mid-hand tables as stalls and could push the liveness verdict toward a restart mid-break. The areAllTablesParked and unparkedTables gates already use isBetweenHands. The only other intervening reader, drainHands, is dead code (see above). No reader was switched that should not have been.",
    "fix": "None."
  },
  {
    "severity": "low",
    "title": "Unrelated prettier reflow in the commit",
    "file": "server/src/engine/ServerTableEngineBase.ts",
    "line": "3243, 5719-5720",
    "detail": "Two unrelated lines (readPendingSeatMoves ternary, auto_utg_straddle assignment) were reformatted. No test pins them; the root and server pin tests pass. This is noise only.",
    "fix": "Optional: drop the hunks, or accept them as lint-staged output."
  }
]
```

## proved_failing_on_old_code

Mutation check in a temporary detached worktree, since removed; the reviewed tree was not touched. Reverting ServerTableEngineTurns.ts:442 to isPausedByDesign() fails the two new behavioural cases ('works a stalled hand...', 'a hand that still cannot move... escalates to a rebuild'); 21 other tests pass. So the commit's claim holds for the watchdog. Reverting GameServer.ts:4900 is caught only by the law-test regex; all 23 TableWatchdog tests stay green. My gap test (maintenancePaused plus the :55 pauseAfterHand(break+grace, {beforeNextHand, untilResumed}), mid-hand, stale) FAILS on 5d1f406248 (no watchdog action in 6 runs; the reaper predicate still exempts the table). It PASSES with the targeted predicate (between hands: isPausedByDesign(); mid-hand: only finalTableDealPaused, terminalCloseoutPaused or FSM 'paused'). tournamentRakeAndBreaks.test.ts:188 fails on 5d1f406248; a slice-and-regex check shows the pattern matches at parent 1a0cdc3eed.

## tests_run

On the commit (claude-frozen-hand): 42 root tests that read GameServer/ServerTableEngineBase/ServerTableEngineTurns: 1 failed (tests/unit/tournamentRakeAndBreaks.test.ts: 'GameServer's reaper skips engines paused by design'), 694 passed. Also run: tests/a-parked-table-is-not-a-stalled-one.law.test.ts and tests/unit/noFixedSizeSourceWindows.test.ts, both pass. Server: vitest run src/engine src/maintenance src/tournament src/cluster gave 430 files, 5,900 passed, 145 skipped. The 11 targeted server files (TableWatchdog, MaintenanceBreak, FinalTableDealPause, TheMoveIsNeverMidHand, etc.) gave 265 passed. Server tsc --noEmit is clean. Scratch-worktree experiments: (A) the gap test fails on the commit; (B) predicate isBetweenHands() && isPausedByDesign() passes every relevant server test except the commit's 4th watchdog test; (C and D) the mutation checks above; (E) the targeted predicate gives 431 server files passing, with only the commit's 4th test failing.

## concerns

```json
[
  "I did not run the full root tests/ suite, only the 42 root files that read the touched sources, and I ran the server engine/maintenance/tournament/cluster directories rather than the whole server suite.",
  "I could not measure the MTT vs Spin/SNG split of the 514-526 frozen tables on 404948b3 (no production access). Finding 1's claim that the certificate would still have failed rests on the code path plus #4225's description (561 tournament tables, a zombie loop every ~3 min, heartbeat/turn callbacks throwing).",
  "The targeted fix keeps finalTableDealPaused, terminalCloseoutPaused and FSM 'paused' exempt mid-hand, because a rebuild loses them. A frozen hand under those rarer fences stays unrescued until the 10-min reaper ceiling. That is pre-existing and needs its own design (e.g. allow Tier 1/2 but not Tier 3).",
  "The experiments ran in a temporary detached worktree (~/Documents/.agent-trees/club-arena/review-frozen-hand-tmp). It was removed with git worktree remove plus prune; no branch was created, and the reviewed worktree and main checkout are unchanged."
]
```

---

## key

registering-walk

## status

committed

## branch

perf/the-registering-walk-reads-the-fleet-once

## commit

3f01c6580f

## worktree

/Users/smarter.poker/Documents/.agent-trees/club-arena/claude-registering-walk

## summary

I landed the REGISTERING-walk speedup locally as commit 3f01c6580f on perf/the-registering-walk-reads-the-fleet-once. Its parent is origin/main fcde405674. It is not pushed and there is no PR. The investigator's fix.diff applied cleanly to current main: origin/main has changed only one line in TournamentRecurringService since 404948b354. That draft passed tsc and every listed test as it stood. Reviewing it as a skeptic, I found and fixed four problems and one test-hygiene issue.

(a) Concurrency cap lowered from 8 to 4. The draft's lock premise is out of date. Since migration 20260910173147 (live 17:31 UTC on 2026-09-10, per docs/HANDOFF_CURRENT_STATE.md and its changelog), a horse seat or registration takes the platform lock G shared and only its own tournament's lock T(id) exclusively. Hand settlement takes B and its own T shared, and never takes G. So running 8 at once does not slow any hand, and seats on different boards do not queue behind each other. Two things still wait on seats in flight: a terminal authority (takes G exclusive, tens of calls an hour) waits for the longest one, with later seat purchases queued behind it; and the :53 break announcement waits on the maintenance boundary. Both waits, and the stale-snapshot over-claim of the cash-room reserve (enforced only in app code), grow with the cap.

(b) The pass now holds an answer for at most 10 s (HORSE_TOP_UP_PASS_MAX_AGE_MS). The draft held answers for the whole walk. The pass only hears about its own seats; cash seating, the fast lane, the scheduler and humans change horse load without telling it.

(c) A board's clock is set only when its top-up is actually launched. The draft set it before the slot wait, so a top-up skipped by the freeze/generation re-check still used up the board's turn (up to 10 min).

(d) The set of in-flight top-ups now lives outside the try and is drained again after the catch. In the draft, a walk that threw left its top-ups running into the next pass, which could then run its own 4 on top.

(e) Test hygiene: the draft's catch pin used a 120-character window, which sourceWindow.ts forbids. It is now a structural match.

Expected effects (estimates from the report's numbers; nothing deployed or measured on production):

- A seat-first top-up that seats nobody drops from about 16 round trips (2.6 s) to 3-7 (0.35-0.8 s).
- The walk drops from 7-9 minutes to about 13-40 s on the pass after a thaw at cap 4 (7-20 s at 8), and a few seconds otherwise, plus about 1.3 s per ramp, which still runs inline.
- MTTs on the hour should start within about one pass of the thaw instead of 7-17 min late.
- The pass itself stays about 50-70 s because of the decided-but-RUNNING sweep.

Verification on the committed tree:

- tsc exit 0.
- The 24 listed server test files pass (376 tests), including theFreezeIsTotal.law and the new test file.
- The 8 listed root test files pass (122 tests).
- Full server suite: 669 files passed, 1 skipped (9,191 tests).
- All 38 root test files that read GameServer.ts or TournamentRecurringService.ts pass (526 tests).

## findings

```json
[
  {
    "severity": "medium",
    "title": "The draft's lock premise is out of date; cap lowered from 8 to 4",
    "file": "server/src/GameServer.ts",
    "line": "215",
    "detail": "The report says fn_seat_horse_in_seat_first_game 'takes the global lock that hand settlement waits on'. That was true only before 20260910035245 / 20260910173147. Since 17:31 UTC on 2026-09-10, fn_ca_lock_tournament_seat_acquisition -> fn_ca_lock_settlement_lane_for_tournament takes G SHARED and then T(id) EXCLUSIVE, and hand settlement (fn_ca_share_settlement_lane_for_table) takes B and T shared, never G. The changelog confirms this on production: after 17:31, G had no queue and up to 4 authorities for different tournaments held their locks at once. So seats on different REGISTERING boards run concurrently, and no hand waits on them: an unstarted board has no hands. What still waits: a terminal/rare authority, which takes G exclusive and waits for the longest seat in flight (the max, not the sum), with later rolling authorities such as human seat purchases queued behind it; and the :53 break announcement, which takes 530090 exclusive while entry doors hold it shared. Measured 2026-09-10 (from the in-code comment): the seat RPC does under 5 ms of real work (572 shared blocks, 2.4 ms minimum). The added wait is therefore the max of N short holds, about 2.1x one hold's mean at N=4 and 2.7x at N=8 for exponential holds. The cash-room reserve undershoot also grows with N. I could not derive a post-split mean: the report's 458.9 ms mean and 9.3 s max are not comparable with the migration's 571 ms mean and 20.2 s max for the same reset.",
    "fix": "PAST_START_TOP_UP_CONCURRENCY = 4, with a comment stating the current lock layout and the trade-off. The walk after a thaw takes about 13-40 s at 4, against 7-20 s at 8 and 8-10 min today. A test pins 2 <= cap <= 4."
  },
  {
    "severity": "medium",
    "title": "Held answers could be as old as the walk itself",
    "file": "server/src/services/TournamentRecurringService.ts",
    "line": "1322",
    "detail": "In the draft, HorseTopUpPass held the load map, fleet, reserve and membership until one of its own top-ups seated someone. Cash seating, the fast lane, the scheduler and humans change horse load without the pass knowing, so answers could be up to one walk old: about 40 s on a thaw pass, and unbounded if the walk slows down. The old code re-read at every top-up, so its answers were a few seconds old.",
    "fix": "HORSE_TOP_UP_PASS_MAX_AGE_MS = 10_000. once() treats an entry older than that as absent and re-reads. The clock is injectable for tests. Unknown answers are still never held, and forget() still clears everything."
  },
  {
    "severity": "low",
    "title": "A top-up that never launched still used up the board's turn",
    "file": "server/src/GameServer.ts",
    "line": "5196",
    "detail": "The draft set pastStartTopUpClock before waiting for a slot. If the freeze began or the generation changed during the wait, the re-check skipped the launch, but the board kept a clock saying it had just been tried. With misses=4 that delays it up to 10 min, for example past the :00 thaw.",
    "fix": "The clock is set after the re-check, right before launch. Pinned by a test."
  },
  {
    "severity": "low",
    "title": "A pass that threw left its top-ups running into the next pass",
    "file": "server/src/GameServer.ts",
    "line": "5000",
    "detail": "The drain (Promise.allSettled) sat only after the walk, inside the try. An exception in the loop after launches skipped it: top-ups outlived their pass, and the next pass created a new set and cap on top of them. The tracked promises cannot reject, because reportError never throws. That matters because index.ts:473 makes an unhandledRejection fatal.",
    "fix": "pastStartTopUps is declared outside the try and drained after the catch as well. That second drain is empty on the normal path. Pinned by a test."
  },
  {
    "severity": "low",
    "title": "Source pin used a fixed-size text window",
    "file": "server/src/services/theWalkReadsTheFleetOnce.test.ts",
    "line": "120",
    "detail": "The pin used /catch \\{[\\s\\S]{0,120}pass\\?\\.forget/, the fixed-size window that testHelpers/sourceWindow.ts forbids: a longer comment would turn it red while the code is fine.",
    "fix": "It now matches the whole catch body in blankNonCode(top)."
  },
  {
    "severity": "info",
    "title": "(1) Concurrent claims: what the database refuses, and how refusals are handled",
    "file": "server/src/services/TournamentRecurringService.ts",
    "line": "4959",
    "detail": "Two top-ups can pick the same horse (shared snapshot, independent shuffles). That is legal for different boards up to 4 games. The four-table limit cannot be exceeded: fn_enforce_four_table_limit takes pg_advisory_xact_lock('table_cap:'||user) and then counts, and the per-horse missions lock also serialises seat acquisitions. A refusal ('FOUR TABLE LIMIT', 23514) is an expected refusal in the seat path: counted in the tally, not reported. In registerHorses it goes into the existing one-line warn summary. The same board is serialised by T(id), the seat ledger and table_full. A started or frozen board returns ok:false, counted as a no-op without noise. Club scoping is exact: membership is held per (club, union) key and nothing crosses clubs. The cash-room reserve is app-only: in-flight top-ups can undershoot it temporarily, bounded by the seats they take (at most (cap-1) x 3 seat-first seats) and by the 10 s limit. MTT registrations do not consult the reserve at all (unchanged). No leaks: lifecycle scopes are released in finally, the pass lives for one walk, and the set is drained. A local simulation of the slot-wait pattern (40 jobs, cap 4, some throwing) showed at most 4 in flight, all settled, errors reported, no unhandled rejection."
  },
  {
    "severity": "info",
    "title": "(3) Freeze starting mid-pass",
    "file": "server/src/services/TournamentRecurringService.ts",
    "line": "5649",
    "detail": "In-flight top-ups are gated at topUpWithHorses entry and before every seat or registration RPC (continue/break per candidate). The walk breaks at the top of the loop and re-checks the freeze and generation after a slot wait. The database backstops this: fn_entry_purchases_frozen inside the lock helper returns platform_frozen (a silent no-op), and the zz_freeze_entry_guard triggers sit on table_seats and tournament_players. The drain waits for in-flight top-ups, which exit quickly once the gates fire. At :53 up to 4 (was 1) 'seat-first fill added nobody' warn lines can appear. theFreezeIsTotal.law passes unchanged."
  },
  {
    "severity": "info",
    "title": "(6) The start decision is still evaluated for every row the walk reaches",
    "file": "server/src/GameServer.ts",
    "line": "5184",
    "detail": "The only await left in the past-start branch is the slot wait; the next row's start is decided after at most one slot. The freeze and generation breaks are unchanged. A new pin forbids awaiting the past-start top-up inline, which is what made the start decision for every later row wait."
  },
  {
    "severity": "info",
    "title": "(5) Pruning, and (7) horses are players",
    "file": "server/src/GameServer.ts",
    "line": "5310",
    "detail": "pastStartTopUpClock is pruned together with lastMttRampAt when an event leaves REGISTERING, so it is bounded by the size of the board. Entries do not reset when an event stops being short; that is harmless because such events start or leave. No is_horse filter was added. The pass changes when the fleet plumbing reads, never who is eligible."
  }
]
```

## concerns

```json
[
  "The backoff (45/90/180/360 s, then 10 min) also applies to MTTs. An MTT still short after its start with no horses available is asked less often after four empty top-ups: still more often than today's production (once per 8-10 min pass) but slower than the 5 s design, and a human registered in it waits too. Empty MTT top-ups make no seat RPCs, so a shorter maximum interval for non-seat-first rows could be considered.",
  "A faster pass changes the database load profile. The 45 s MTT ramps return to their design cadence, which means more fn_register_horse_for_tournament calls per hour than today's slow production. The decided-but-RUNNING sweep (368 serial counts) and the rest of the pass run about 8x as often, which is the cadence they already run at during every :53-:00 freeze.",
  "Existing comments in TournamentRecurringService.ts (around line 1631, and line 5530: 'the global exclusive lock every hand settlement waits on') still describe the lock layout before 2026-09-10 17:31, and they misled the draft. They are worth a dated correction in a separate change; I left them alone to avoid colliding with other agents.",
  "Existing issue, unchanged: clubMemberIdsForTournament (line 4748) fails open when the host tournament row cannot be read, which makes the whole platform fleet eligible for a club's event.",
  "Observability: the '[TournamentRecurring] holding N horse(s) back ... claimable' line carries no tournament id. With parallel top-ups, per-board timing can no longer be read from log gaps, which is how the investigator measured.",
  "All effects are estimates; nothing was deployed. No hold-time figure for the seat RPC after the lock split is available, and the report's pg_stat_statements snapshot cannot be compared with the migration's.",
  "The pass will still take about 50-70 s until the decided-but-RUNNING sweep's counts are batched (out of scope). The drains still wait on a top-up that hangs, exactly as the old serial walk did.",
  "Not pushed, no PR. The main checkout ~/Documents/club-arena was not modified; I only ran git fetch and git worktree add there."
]
```

## tests_run

On the committed tree: server tsc (exit 0); prettier --check clean on the 5 changed files. The 24 listed server files pass (376 tests): the new theWalkReadsTheFleetOnce, HorsesStayInTheirClub, aClubBoardFillsFromItsOwnMembers, pickFreeHorsesLimits, seatFirstFillOrder, seatFirstSeatPrecheck, seatFirstCountSync, HorseConcurrency, PagedReadsAreDeterministic.law, PagedReadsCannotLieAboutBeingComplete, FourTableLimit, MttPrestartRamp, heldEmptyRotationAndSoleOpen, oneCandidatePerSeatIsABet, maintenance/theFreezeIsTotal.law, engineStartBudget, tournamentResumeBudget, SpinStartsInOneSecondAndPlaysInFull, bootOrderDiscoveryFirst, theSweepOnTheCoreIsANumber, spinLaunchParking, DirectEngineRecovery.guard, theLongestWaitIsAdoptedFirst and supabase/pagination. The 8 listed root files pass (122 tests). Full server suite: 669 files passed, 1 skipped (9,191 tests passed, 145 skipped). All 38 root test files that read GameServer.ts or TournamentRecurringService.ts pass (526 tests), including finalSweep20260908.test.tsx, which failed in the investigator's copy. The investigator's draft as-is also passed tsc, 24 server files (370 tests) and 8 root files (122 tests) on current main.

## proved_failing_on_old_code

theWalkReadsTheFleetOnce.test.ts, re-run after the final edit, with source files swapped in the worktree and then restored (git checkout HEAD; worktree clean afterwards). Against origin/main's GameServer.ts and TournamentRecurringService.ts: 15 of 15 tests fail ('HorseTopUpPass is not a constructor', missing pins). Against the investigator's draft (fix.diff applied to origin/main): 5 of 15 fail, and they are exactly the review-fix pins: re-read after the max age, the 10 s constant, 2 <= cap <= 4, the clock set only after the re-check, and the drain after the catch. Against the commit: 15 of 15 pass. The HorsesStayInTheirClub and aClubBoardFillsFromItsOwnMembers regex changes are the investigator's; the report says they fail without them.
