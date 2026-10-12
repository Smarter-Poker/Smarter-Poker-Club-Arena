# The finish lane is one seat, even inside one process (2026-09-27)

## What was found

Two related observations from Production Alerts Fleet issue #5070:

1. A decided (one-player-left) Heads-Up/Spin tournament routinely takes far
   longer than the ~20s p99 the codebase's own alert text and law tests
   document to settle - sometimes 10-20 minutes, sometimes much longer.
2. A small subset get **no retry at all, ever, with zero error logged
   anywhere** (four such tournaments were already root-caused and settled by
   an earlier pass of this fleet; they are not touched here).

## Root cause of (1), confirmed live

`fn_complete_tournament_terminal` opens by calling
`fn_ca_lock_settlement_lane_for_finish`, which - for every ordinary
(non-satellite) tournament - takes `pg_advisory_xact_lock('ca:tournament-
finish-lane:v1')`: a single, scope-free, EXCLUSIVE advisory lock. The database
allows exactly **one tournament to finish, platform-wide, at a time**.

Nothing on the engine side knew that. `TournamentEliminationScheduler` bounds
how many elimination sweeps run at once (4, compensated to 8 while any are
stalled) but has no idea that a sweep reaching `finishTournament` can only ever
have one winner across the whole fleet. During a burst of tournaments that
become decided within the same few seconds - which the hourly maintenance
break routinely produces, by pausing many fast single-table (HU/Spin) games at
the same instant and then thawing them together - several sweeps in this one
process entered `fn_complete_tournament_terminal` concurrently and queued on
the exact same Postgres lock. Every blocked caller occupied one scheduler slot
for as long as the RPC's own `statement_timeout` (45s) before Postgres
cancelled it with "canceling statement due to statement timeout" - correctly
classified by `classifyFinishRefusal` as the TRANSIENT `timeout` reason, and
retried, by the existing law (`aRuleRefusalStopsAskingEveryFiveSeconds.law.test.ts`),
on a flat five-second clock. That retry re-entered the very same contended
lock alongside every other decided tournament doing the same, so under
sustained load the backlog did not drain - it kept re-asking a question
forty-five seconds at a time.

**Measured live, 2026-09-27 ~02:09-02:20 UTC**, via read-only Supabase queries
(no writes made):

- 87-114 tournaments simultaneously `status='RUNNING'` with `playing_ct <= 1`,
  growing continuously in that window (new ones appearing roughly every
  30-60s, none draining).
- Every one of their `engine_tournament_leases` rows had a `heartbeat_at`
  under 5 seconds old - ruling out a fenced/dead manager for this batch (a
  separate, already-fixed mechanism: `docs/changelog/2026-09-26-a-heartbeat-
  nobody-answered-is-asked-again.md`, PR #5373).
- `fn_ca_tournament_finished_but_not_completed` correctly raised a critical
  `financial_alerts` row for all 87 (detection is working).
- A live `Tournament.atomic_finish_refused` alert
  (`refusal_reason: "timeout"`, `dedupe_key: "175d2e53-...:timeout"`) named a
  tournament (`175d2e53-3aee-4438-b7fd-ba6417c928ca`) that is itself in the
  stuck list - proof the manager IS attempting the finish and IS losing the
  race for the lock, not staying silent.
- Only 11 `Tournament.atomic_finish_refused` rows existed for the whole
  window despite the much larger stuck population, consistent with the
  existing once-per-reason alert dedupe (`alertFinishRefusalOnce`) suppressing
  every repeat of the same `timeout` streak.

## The fix

`server/src/tournament/terminalFinishGate.ts`: a small process-wide,
in-memory, FIFO mutex (`runInTerminalFinishGate`). The ordinary cash finish
call in `TournamentManagerEliminations.finishTournament` now takes this gate
before calling `requestTournamentTerminalReceipt`. Concurrent sweeps in this
one Node process now take a cheap, synchronous-state, in-memory turn instead
of opening several live Postgres connections that can only ever let one of
them proceed. A caller that cannot get a turn within `TERMINAL_FINISH_GATE_WAIT_MS`
(8s, comfortably under both the RPC's 45s statement_timeout and the
scheduler's 61s stalled-slot warning) never reaches Postgres at all, and
throws `TerminalFinishGateTimeoutError` - a `TerminalSettlementRefusedError`
whose message is recognised by `classifyFinishRefusal` as `timeout`, so it
flows through the existing, **completely unaltered**, refusal/alert/retry law:
one alert if new, a flat five-second re-ask, no backoff, no fence. Nothing
about money changes - a caller that times out here never attempted the RPC,
so there is nothing to reconcile.

This does **not** touch the database (no migration; CLAUDE.md 10.11/10.12: the
lock itself is correct and untouched) and does **not** eliminate cross-process
or database-side contention - only this one engine process's self-inflicted
amplifier. Given the live evidence shows exactly one engine instance currently
serving the fleet (`instance_id: "1-e9c92e5d"` on every stuck lease), this
removes the dominant share of the observed contention.

## What was NOT done, and why

- **No cron, sweep, backfill, or "go pay stuck tournaments" job was added**
  (CLAUDE.md 10.12 is explicit that this is not an acceptable class of fix).
  The gate changes the ENGINE's own retry/dispatch behaviour at its existing,
  already-armed call site; it does not add a new periodic actor.
- **The four already-silently-stuck, zero-alert tournaments from 2026-09-26
  08:47-09:32 UTC were NOT re-investigated or re-settled here** - they were
  already root-caused and paid by an earlier pass of this fleet (see that
  pass's own PR/board comment). What this pass could add: `financial_alerts`
  in that exact window (08:30-09:45 UTC) shows a distinct burst -
  `postHandTasks.hand_history_failed` (126, 09:33:36-09:33:39),
  `ServerTableEngine.authoritative_hand_semantic_refusal` (66,
  09:33:25-09:33:35), `ServerTableEngine.post_commit_obligations_pending` (8) -
  overlapping the four tournaments' decision window, independent of the
  2026-09-26 04:45 UTC lease-heartbeat storm (PR #5373) which precedes their
  decision window by hours and is a materially different signature
  (`engine_recovery_events` shows only routine-baseline `watchdog_kill_rebuild`
  volume in the 08:30-09:45 window, not the fencing pattern from 04:45). This
  is offered as a lead for whichever pass investigates further, not a closed
  finding: the lease-heartbeat-fencing theory as literally stated is NOT
  strongly evidenced for this specific window; a hand-post-processing
  disruption at the same time is.
- `bfcfaf17-2879-4e58-b8e1-1c749ceb3b2f` (9-day-stuck, F06 table-break park,
  PR #5371) was not touched - explicitly out of this fix's scope.

## Hardening (CLAUDE.md 10.11)

1. **Cause named from rows and code**, not guessed (this document, plus the
   live queries that produced it).
2. **The line is changed**: the single call site that opens the finish lane
   now serializes in-process (`TournamentManagerEliminations.ts`,
   `finishTournament`).
3. Nothing needed settling here - no money moved incorrectly; the fix reduces
   how long a correctly-detected, correctly-alerting backlog takes to drain.
4. **Tests pin the cause and the fix**:
   - `server/src/tournament/terminalFinishGate.test.ts` - proven red without
     the fix (mutual exclusion violated, no timeout enforcement; verified by
     temporarily inlining `return fn();` in place of the gate body and
     re-running: 5 of 7 assertions failed), green with it.
   - `server/src/tournament/TerminalFinishGateIntegration.guard.test.ts` -
     pins the exact call site, that it wraps only the ordinary cash path
     (never satellite, never the disagreement/adoption replay), and that a
     gate timeout is classified as a proven, transient refusal (never an
     unknown outcome / never fences the manager).
   - `server/src/tournament/AtomicTournamentFinish.guard.test.ts` updated in
     the same commit (one pinned regex needed to tolerate the new wrapper;
     the RPC identity/arguments it protects are unchanged).
5. **The net (detection) stays and needs no change**: `fn_ca_tournament_
   finished_but_not_completed` and the `financial_alerts` -> `operational_
   alert_events` intake trigger already cover this exact class of tournament
   and were independently confirmed firing correctly throughout this
   investigation.

## Verification run (server/, 2026-09-27)

- `npx tsc --noEmit` - clean.
- `npx vitest run src/tournament/` - 206 files, 3145 tests, all passing.
- `npx vitest run` (full server suite) - 1034 files, 17693 tests passing (167
  pre-existing skips), 0 failures.
- `npx vitest run src/engine/FreezeRegression.test.ts src/engine/TableWatchdog.test.ts
  src/maintenance/MaintenanceBreak.test.ts src/maintenance/thawInstallments.test.ts`
  (the CI-named regression suite) - 121 tests passing.
