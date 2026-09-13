# Workflow evidence: elimination-sweep-throughput

- run: wf_8b24f241-54c
- finished: 2026-09-11T08:13:30.881Z
- status: completed
- agents: 1
- summary: Find why tournament elimination sweeps take ~9.5 s and the scheduler queue sits at ~550 with a 15-minute oldest wait; fix it safely

## status

committed

## branch

fix/elimination-sweeps-keep-up

## commit

eb0fe1dae704973d1837df99df189b7f28d0ecac

## worktree

/Users/smarter.poker/Documents/.agent-trees/club-arena/claude-sweep-throughput

## summary

I committed eb0fe1dae7 locally on fix/elimination-sweeps-keep-up. Nothing was pushed or deployed, and production was only read. The commit fixes the two scheduler/sweep problems that are safe to fix tonight. It does NOT clear the backlog: most of it comes from the database refusing every tournament finish, which needs a database fix I could not make.

(1) Queue-ordering bug in TournamentEliminationScheduler.ts. When an urgent wake arrived for a tournament already waiting in the routine lane, the old code moved it to the back of the much longer urgent lane and threw away its routine place. That pushed back exactly the entries that had waited longest, and their original enqueue time kept counting. A thrown-away routine reference could also come back to life and let a busy tournament skip ahead of its peers. Now each queued place carries a generation number (ticket). An urgent wake adds an urgent place under the same ticket and keeps the routine place, so the tournament is served at whichever place is reached first; running it retires both. The guarantees are unchanged: at most 4 at a time, urgent first, and routine still gets one turn after every 3 urgent.

(2) Fewer back-to-back database reads in a sweep (TournamentManagerEliminations.ts):

- The zero-chip-field guard and the finishing-place ladder read the same 'playing' count twice in a row; they now share one read.
- The taken-places list and the unplaced count are read in parallel.
- The three chip-cap counts are read in parallel.
  A one-bust event now reaches its first elimination after 5 sequential round trips instead of 7, and the chip-cap refresh takes 1 instead of 3. Every fail-closed path is kept. One change: a failed 'playing' count now defers the batch immediately instead of skipping the guard and reading again.

Expected effect: the oldest-wait gauge stops being inflated by demotions, and each sweep saves about 2-4 round trips, roughly 0.3-2 s at the current 150-500 ms per trip. My estimate is 15-25% more sweeps per slot. That is useful, but it cannot catch up while the finish-refusal loop keeps growing: 468 refused finishes and 0 completed by 08:12.

Not done:

- Raising concurrency: the event loop has no headroom (main thread at 100% CPU), and more concurrent sweeps would increase how often the refused finishes take the database's global settlement lock.
- Changing the finish retry loop: see risks.

## root_cause

1. BIGGEST CAUSE, in the database and not fixable by me tonight. Since the 06:57 boot, every ordinary tournament finish has been refused with SQLSTATE P0404 'tournament seat-exit authority left 1 live seat(s) unconsumed'.

- Migration 20260911050554_final_deal_receipts_survive_real_terminal_settlement is recorded as applied in production. It comes from branch agent/codex-live-realtime/stage-b-clean-v3 (commit ee3e351c6d) and is not on origin/main.
- It wraps fn_complete_tournament_terminal in a seat-exit authority and closes it with require_consumed = (result.ok).
- The trigger that consumes those authorizations (zy_tournament_live_seat_exit_requires_authority, function fn_tournament_live_seat_exit_requires_authority) does not exist in production. Migration 20260910051125 left it out on purpose and closes its own authority with require_consumed=false for exactly this reason.
- So every successful settlement with a seated winner rolls back. In three finished events I checked (f0c5fcd0 SPIN, db68a465 SNG, 67a4db5a MTT), the one unconsumed live seat is the winner's own seat.

2. The engine multiplies that refusal. requestTournamentTerminalReceipt treats any error, even a definite database refusal, like a lost network response. It replays the call 5 times with 200/400/800/1600 ms of deliberate sleep, then calls the resolver. Each of those calls takes the global settlement lock (G+B exclusive), which blocks every hand settlement on the platform while it runs. One refused finish therefore holds a scheduler slot for about 10 s. The tournament then re-arms 5 s later, forever, as an urgent job.

3. Where a sweep's time goes, against the five hypotheses:

- Not (b) inside the engine: stalled_slots 0, timed_out 0, failed 0, no local lock waits.
- The slow half of sweeps (the >5 s mode, 45% of them) is (c) plus (e): the refused-finish replays and sleeps above, and database-side slow calls. fn_eliminate_tournament_player_atomic takes 1.2-2.2 s of database CPU per call.
- Plus (a) multiplied by (d): 7 sequential reads before the first elimination (10 when the chip-cap refresh is due), then about 5 more round trips per elimination. Every round trip also waits out main event-loop delay (p50 142 ms at 07:22, 490 ms at 07:51, 446 ms at 08:12, main thread at 100% CPU).

4. The oldest entry is served, just slowly. The head's enqueue time moved 07:00:10 → 07:06:53 → 07:27:59, and the gauge peaked at 1,470 s at 07:42. Two reasons:

- Routine work gets only 1 of every 4 dispatches out of about 0.9 per second. About 350 events with a zero-stack 'playing' player keep the urgent lane full, and about 600 boot registrations were queued at the same moment.
- The scheduler bug (fixed): an urgent wake moved a waiting entry to the back of the long urgent lane, and orphaned references let busy tournaments jump peers.
  It is not a stale reference propping up the gauge (the gauge only counts live entries) and not an unrunnable registration (those are dropped when the scheduler reaches them).

## evidence

Engine /metrics and the host's Prometheus:

- 07:19: 553 queued of 597 registered.
- 08:12: 627 queued of 690 registered, 4 slots in flight, stalled 0, timed_out 0, failed 0.
- Oldest wait: 49 s at 07:01, 1,470 s at 07:42, 821 s at 08:12. The head's enqueue time keeps advancing.
- Sweep time histogram at 07:22: 675 of 1,367 sweeps took 1 s or less, 76 took 1-5 s, 616 took over 5 s. Mean 4.2 s then, 5.3 s at 08:12 (3,336 sweeps, 17,698 slot-seconds).
- Main event-loop delay p50: 20 ms before 07:14, 142 ms at 07:22, 490 ms at 07:51, 446 ms at 08:12. top -H shows the main node thread at 99.9% CPU.

Engine logs since 06:57:

- 159 'FINALIZING', 153 of them refused by 07:35, all with 'seat-exit authority left 1 live seat(s) unconsumed'. 468 refused and 0 'COMPLETE - winner' by 08:12.
- Paired FINALIZING-to-refusal intervals are 9.6-15.5 s, which matches 5 RPCs + 3.0 s of sleeps + the resolver.
- Refused finishes are about 18% of all slot time at 07:35 and about 28% at 08:12.
- 161 sweeps logged 'bust preparation spent the whole 5000ms budget' in 38 minutes.
- 703 eliminations in 38 minutes.

Database (SELECT only):

- 354 RUNNING events hold 1,757 zero-chip 'playing' rows. Of these, 249 SPINs, 44 SNGs and 7 satellites have exactly 1 live player.
- Wakes: 161 of 169 from the last 40 minutes unconsumed at 07:47; the ones consumed took about 1,046 s.
- pg_stat_statements: fn_eliminate_tournament_player_atomic averages 1,216 ms over 23.5k calls, and 2,246 ms in a 41-second window at 07:28. Activity samples show it running on CPU, not waiting on locks.
- Activity samples show fn_ca_commit_hand_settlement (hand settlement) waiting on advisory locks in 85 of about 160 samples.
- The consuming trigger and its function are absent from pg_trigger/pg_proc. Migration 20260911050554 appears in schema_migrations.

Local round-trip harness (each request answered 100 ms after it is sent):

- One-bust sweep to first elimination: 700 ms on the parent vs 500 ms with the commit (7 vs 5 sequential trips).
- Chip-cap refresh: 300 ms vs 100 ms.

## tests_run

All in the worktree:

1. server: npx vitest run src/tournament → 143 files, 1,692 tests pass. Re-run after the pre-commit hook: same result.
2. server: full npx vitest run → 670 files, 9,196 tests pass, 145 skipped.
3. server: npx tsc --noEmit -p tsconfig.json → exit 0.
4. Root: npx vitest run on the 17 tests/ files that read the changed modules → 360 pass. This includes tests/unit/lateRegistrationTakesASeat.test.ts, whose text pin I updated from liveCount to playingCount, and tests/config/tournamentWinnerExit.test.ts.

Proof against the parent (old source files swapped back in temporarily):

- TournamentEliminationScheduler.test.ts: the 2 new tests fail. Old order serves 'newer' before 'oldest', and serves 'hot' twice ahead of its peers.
- TheSweepAsksIndependentQuestionsTogether.test.ts: 5 of 9 fail, as expected:
  - bust stage 700 ms instead of 500 ms;
  - two identical 'playing' count reads;
  - taken-places and unplaced reads sent 100 ms apart;
  - one of the failed-read cases reads the count twice;
  - chip-cap refresh 300 ms instead of 100 ms.
- The 4 tests that pin unchanged fail-closed behaviour pass on both versions.

## risks

```json
[
  "The backlog remains until the database finish refusal is fixed: every finished event loops (468 refused, 0 completed by 08:12), and the loop's share of scheduler time is growing (about 28%). Suggested database fix, for the owner to decide: close the terminal wrapper's authority with require_consumed=false, as 20260910051125 does for moves, or install the consuming trigger with the full cutover. Once that lands, about 300 finished events should complete on their next pass.",
  "Not included on purpose: making requestTournamentTerminalReceipt treat a definite database refusal (an error carrying a non-transient SQLSTATE, with no earlier unknown outcome) as final, with no replays, sleeps or resolver. That would save about 8.8 s of slot time per refusal. But while the database bug is live, faster refusals mean more frequent global settlement-lock acquisitions (G+B exclusive), which stalls hand settlement platform-wide. Ship it only after the database fix, or together with a process-wide limiter and no financial alert for locally deferred attempts.",
  "The dispatch order changes: a tournament that got an urgent wake can now be served from its old routine place, using up a routine turn. Concurrency cap, urgent-first and the guaranteed routine turn are unchanged, and all 10 existing scheduler tests pass.",
  "If the 'playing' count read fails, the bust batch is now deferred immediately. Before, the zero-field guard was skipped and a second read could still go ahead. This is the fail-closed direction.",
  "Reads now overlap: each sweep can have up to 3 requests in flight instead of 1, so at most about 12 from the sweeps as a whole (was 4). PostgREST had 71 idle connections, so this should be fine.",
  "Event-loop saturation (main thread 100% CPU, p50 about 450 ms) is unaddressed, and it makes every database round trip slower. Raising sweep concurrency is not safe until it is resolved. Separately seen: the equity worker pool is dead (ready 0, 447 'Equity worker pool is unavailable' errors in 5 minutes), and fn_eliminate_tournament_player_atomic costs 1.2-2.2 s of database CPU per call, which sets a floor on elimination speed.",
  "Not deployed; production is unchanged until someone reviews and deploys branch fix/elimination-sweeps-keep-up."
]
```
