/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT IS ACTUALLY ON THE CORE (2026-09-07)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * On 2026-09-07 at 04:05 the fleet fell from ~480 hands a minute to 6 for
 * twenty minutes. The engine container sat at 100.8% CPU - one core, pegged -
 * while two of the box's three cores idled and Postgres answered the query the
 * engine was "timing out" on in 133 ms.
 *
 * The cause was the elimination sweep. The ONLY way to see that was to SSH to
 * the box and run
 *
 *     docker logs club-arena-engine | grep -c "elimination sweep still running"
 *
 * which returned **780 for fifteen minutes** - from a warning that fires once
 * per stuck episode, so that is ~780 distinct stuck sweeps. A number you can
 * only get by grepping a container is a number nobody watches, and it is the
 * reason a twenty-minute outage was diagnosed by hand instead of by a chart.
 *
 * The fix replaces that fan-out with one process-wide, concurrency-bounded
 * scheduler. Bust-shaped hand completions are urgent; one slow global safety
 * pass keeps recovery and non-hand transitions live.
 *
 * These pins keep the three series wired. They measure and change nothing -
 * the fix for the cause is P0/P1 in docs/HANDOFF_CURRENT_STATE.md section 16,
 * and it needs this data to choose between optimising one sweep and
 * re-scheduling thirty.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  blankNonCode,
  sliceBlockAfter,
  sliceEnclosingBlock,
  sliceMethod,
  sliceStatement,
} from '../testHelpers/sourceWindow.js';
import {
  eliminationSweepMs,
  eliminationSweepsInflight,
  eliminationSweepOverrunsTotal,
} from '../observability/engineInstruments.js';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const INSTRUMENTS = read('src/observability/engineInstruments.ts');
const SWEEP = read('src/tournament/TournamentManagerEliminations.ts');
const SCHEDULER = read('src/tournament/TournamentEliminationScheduler.ts');
const BASE = read('src/tournament/TournamentManagerBase.ts');
const MANAGER = read('src/tournament/TournamentManager.ts');
const GAME_SERVER = read('src/GameServer.ts');
const SETTLEMENT = read('src/engine/ServerTableEngineSettlement.ts');

describe('the three series exist and are always on', () => {
  it('names the sweep duration, its concurrency, and its overruns', () => {
    expect(INSTRUMENTS).toContain("'poker_tournament_elimination_sweep_ms'");
    expect(INSTRUMENTS).toContain("'poker_tournament_elimination_sweeps_inflight'");
    expect(INSTRUMENTS).toContain("'poker_tournament_elimination_sweep_overruns_total'");
  });

  it('puts them on the ALWAYS-ON registry, not the ENGINE_METRICS-gated one', () => {
    // An outage metric behind a feature flag is a metric that is off during
    // the outage.
    const block = INSTRUMENTS.slice(INSTRUMENTS.indexOf('export const alwaysOnRegistry'));
    for (const name of [
      'poker_tournament_elimination_sweep_ms',
      'poker_tournament_elimination_sweeps_inflight',
      'poker_tournament_elimination_sweep_overruns_total',
    ]) {
      expect(block).toContain(name);
    }
  });

  it('exports them as usable instruments', () => {
    expect(typeof eliminationSweepMs.observe).toBe('function');
    expect(typeof eliminationSweepsInflight.inc).toBe('function');
    expect(typeof eliminationSweepsInflight.dec).toBe('function');
    expect(typeof eliminationSweepOverrunsTotal.inc).toBe('function');
  });
});

describe('the sweep actually reports itself', () => {
  it('counts an inflight sweep when it takes the lock', () => {
    expect(SWEEP).toContain('eliminationSweepsInflight.inc()');
  });

  it('records how long the sweep took, on every path out of it', () => {
    // In the `finally`, not the happy path: a sweep that threw is exactly the
    // one whose duration matters.
    expect(SWEEP).toContain('eliminationSweepMs.observe(Date.now() - sweepStartedAt)');
    const observeAt = SWEEP.indexOf('eliminationSweepMs.observe(');
    const finallyAt = SWEEP.indexOf('} finally {');
    expect(finallyAt).toBeGreaterThan(0);
    expect(observeAt).toBeGreaterThan(finallyAt);
  });

  it('counts a warned overrun without inventing a forced release', () => {
    expect(SCHEDULER).toContain("eliminationSweepOverrunsTotal.inc(1, { outcome: 'warned' })");
    expect(SCHEDULER).not.toContain("outcome: 'forced'");
  });
});

describe('the gauge cannot drift', () => {
  it('does not release either physical or logical inflight ownership on a warning', () => {
    const warning = sliceEnclosingBlock(SCHEDULER, 'if (settled) return;', 1);
    expect(warning).toContain("dispatchTotal.inc(1, { outcome: 'timed_out' })");
    expect(warning).not.toMatch(/runningCount\s*=|activeEntries\.delete/);
  });

  it('decrements the logical gauge exactly once in the sweep finally', () => {
    const sweep = sliceMethod(SWEEP, 'private async runEliminationSweep(');
    expect(sweep.match(/eliminationSweepsInflight\.inc\(\)/g)).toHaveLength(1);
    expect(sweep.match(/eliminationSweepsInflight\.dec\(\)/g)).toHaveLength(1);
    expect(sweep.indexOf('eliminationSweepsInflight.dec()')).toBeGreaterThan(
      sweep.indexOf('} finally {')
    );
  });

  it('takes its start time inside the tick, not from the shared lock field', () => {
    // eliminationSweepStartedAt is zeroed by whoever releases the lock, so
    // reading it in the finally would measure 0 for every superseded sweep.
    expect(SWEEP).toContain('const sweepStartedAt = Date.now()');
  });
});

describe('the measured fan-out is replaced, not merely charted', () => {
  it('has no per-manager interval and admits every sweep through the singleton', () => {
    expect(SWEEP).not.toContain('setInterval(');
    expect(SWEEP).toContain('this.registerEliminationScheduler(');
    expect(BASE).not.toContain('eliminationTimer');
    expect(SCHEDULER).toContain('export const tournamentEliminationScheduler');
  });

  it('bounds global concurrency without an all-tournament wall-clock repair pass', () => {
    expect(SCHEDULER).toContain('DEFAULT_MAX_CONCURRENT_SWEEPS = 4');
    expect(SCHEDULER).not.toContain('DEFAULT_SAFETY_SWEEP_MS');
    expect(SCHEDULER).not.toContain('runSafetySweep');
    expect(SCHEDULER.match(/setInterval\(/g)).toHaveLength(1);
  });

  it('wakes from a bust-shaped hand completion instead of every ordinary hand', () => {
    expect(BASE).toContain('engine.onHandComplete(');
    expect(BASE).toContain('finalStacks.some(');
    expect(BASE).toContain('this.requestEliminationSweep()');
  });

  it('fires only after the one accepted-hand receipt includes stacks, history, and tournament chips', () => {
    const postHandTasks = sliceMethod(SETTLEMENT, 'protected async postHandTasks(');
    const commitAt = postHandTasks.indexOf('atomicCommit: {');
    const historyAt = postHandTasks.indexOf('v_handHistoryId = result.handId');
    const acceptedAt = postHandTasks.indexOf('authoritativeCommitSucceeded = true');
    const failClosedAt = postHandTasks.indexOf('if (!authoritativeCommitSucceeded) {');
    const callbackAt = postHandTasks.indexOf('this.handCompleteCallback(');
    expect(commitAt).toBeGreaterThan(-1);
    expect(historyAt).toBeGreaterThan(commitAt);
    expect(acceptedAt).toBeGreaterThan(historyAt);
    expect(failClosedAt).toBeGreaterThan(acceptedAt);
    expect(callbackAt).toBeGreaterThan(failClosedAt);
    const executable = blankNonCode(postHandTasks);
    expect(executable).not.toMatch(/\bsyncStacks\s*\(/);
    expect(executable).not.toMatch(/\bsyncTournamentChips\s*\(/);
    const callback = sliceEnclosingBlock(postHandTasks, 'this.handCompleteCallback(');
    expect(callback).not.toContain('await ');
    expect(callback).not.toContain('async ');
  });

  it('cannot wake eliminations or unlock the table after an authoritative commit failure', () => {
    const postHandTasks = sliceMethod(SETTLEMENT, 'protected async postHandTasks(');
    const gateAt = postHandTasks.indexOf('if (!authoritativeCommitSucceeded) {');
    const callbackAt = postHandTasks.indexOf('this.handCompleteCallback(');
    const unlockAt = postHandTasks.indexOf("type: 'table_unlocked'");
    expect(gateAt).toBeGreaterThan(-1);
    expect(callbackAt).toBeGreaterThan(gateAt);
    expect(unlockAt).toBeGreaterThan(callbackAt);

    const semanticRefusal = sliceEnclosingBlock(postHandTasks, 'const semantic =');
    expect(semanticRefusal).toContain("'settlement_fault_semantic'");
    expect(semanticRefusal).toContain("'authoritative_hand_semantic_refusal'");
    expect(semanticRefusal).toContain('throw err;');
  });

  it('wires every tournament engine construction and rebuild path', () => {
    const count = (source: string, needle: string) => source.split(needle).length - 1;
    // Construction is centralized so every dealer inherits the manager's exact
    // tournament lease generation and data-authority binding.
    expect(count(BASE, 'new ServerTableEngine(')).toBe(2);
    expect(count(BASE, 'this.createManagedTableEngine(')).toBe(5);
    expect(count(BASE, 'this.wireEliminationWake(')).toBe(5);
    expect(count(MANAGER, 'new ServerTableEngine(')).toBe(0);
    expect(count(MANAGER, 'this.createManagedTableEngine(')).toBe(1);
    expect(count(MANAGER, 'this.wireEliminationWake(')).toBe(1);
  });

  it('unregisters on manager stop and never awaits the hand-complete wake', () => {
    expect(BASE).toContain('this.unregisterEliminationScheduler()');
    expect(BASE.match(/this\.unregisterEliminationScheduler\(\)/g)?.length).toBeGreaterThanOrEqual(
      3
    );
    const callback = sliceEnclosingBlock(BASE, 'engine.onHandComplete(');
    expect(callback).not.toContain('await ');
    expect(callback).not.toContain('async ');
  });

  it('does not poll tournament discovery to repair a partially committed registration', () => {
    const discovery = sliceMethod(GAME_SERVER, 'private async discoverTournaments(');
    expect(GAME_SERVER).not.toContain('sweepSeatlessLateRegistrantsAndWakeManagers');
    expect(GAME_SERVER).not.toContain("supabase.rpc('fn_sweep_seatless_late_registrants')");
    expect(discovery).not.toContain('lateRegistration');
  });

  it('exports queue-depth, slot, and oldest-wait incident gauges', () => {
    expect(SCHEDULER).toContain("'poker_tournament_elimination_scheduler_queue_depth'");
    expect(SCHEDULER).toContain("'poker_tournament_elimination_scheduler_slots_inflight'");
    expect(SCHEDULER).toContain("'poker_tournament_elimination_scheduler_oldest_wait_ms'");
  });

  it('drives bounty crash recovery from Realtime plus one persisted due instant', () => {
    const subscription = sliceMethod(
      GAME_SERVER,
      'private startTournamentBountyObligationSubscription('
    );
    const discovery = sliceMethod(GAME_SERVER, 'private async discoverTournaments(');
    const drain = sliceMethod(GAME_SERVER, 'private async sweepPendingTournamentBounties(');
    expect(subscription).toContain("table: 'tournament_bounty_obligations'");
    expect(subscription).toContain("event: 'INSERT'");
    expect(subscription).toContain("event: 'UPDATE'");
    expect(subscription).toContain("state === 'pending'");
    expect(subscription).toContain("state === 'settled'");
    expect(subscription).toContain("requestEliminationSweep('bounty_settled')");
    expect(subscription).toContain("status === 'CHANNEL_ERROR'");
    expect(subscription).toContain("status === 'TIMED_OUT'");
    expect(subscription).toContain("status === 'CLOSED'");
    expect(subscription).toContain('this.scheduleTournamentBountySubscriptionReconnect()');
    expect(subscription).not.toContain('row.next_attempt_at');
    const subscribedAt = subscription.indexOf("status === 'SUBSCRIBED'");
    const initialDrainAt = subscription.indexOf(
      'this.requestPendingTournamentBountyRecovery()',
      subscribedAt
    );
    expect(subscribedAt).toBeGreaterThan(-1);
    expect(initialDrainAt).toBeGreaterThan(subscribedAt);
    expect(discovery).not.toContain('sweepPendingTournamentBounties');
    expect(drain).toContain('answer.retry_after_ms');
    expect(drain).toContain('answer.processed');
    expect(drain).not.toContain('answer.backfill_may_have_more');
    expect(drain).not.toContain('backfillMayHaveMore');
    expect(drain).toContain('answer.settled_tournament_ids');
    expect(drain).toContain("requestEliminationSweep('bounty_settled')");
    expect(drain).toContain('this.armPendingTournamentBountyRecovery(retryAfterMs)');
    expect(drain).toContain('this.bountyRecoveryContentionBackoffMs * 2');
    expect(drain).toContain('this.armPendingTournamentBountyRecovery(contentionDelayMs)');
    expect(drain).toContain("outcome: failed > 0 ? 'partial' : 'completed'");
    expect(drain).not.toContain('Date.parse');
    expect(GAME_SERVER).not.toContain('setInterval(() => this.sweepPendingTournamentBounties');
    expect(INSTRUMENTS).toContain("'poker_tournament_bounty_recovery_sweep_runs_total'");
    expect(INSTRUMENTS).toContain("'poker_tournament_bounty_realtime_connected'");
    const fastVerdict = sliceMethod(SWEEP, 'protected async recoverPendingBountyObligations(');
    expect(fastVerdict).not.toContain('backfill_may_have_more');
    expect(fastVerdict).not.toContain('bounty_backfill_continue');
    expect(fastVerdict).toContain('if (hasPending !== false) return false;');
    const pendingVerdict = sliceStatement(fastVerdict, 'if (hasPending !== false) return false;');
    expect(pendingVerdict).not.toContain('requestUrgentEliminationSweepAfter');
  });

  it('preserves narrow feature cadence and re-drives a promoted full-table entrant', () => {
    expect(SCHEDULER).toContain('wakeAfter(tournamentId: string, delayMs: number)');
    expect(SWEEP).toContain('TournamentManagerBase.ADD_ON_RETRY_MS');
    expect(SWEEP).toContain('TournamentManagerBase.FINAL_TABLE_DEAL_POLL_MS');
    expect(SWEEP).toContain('TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS');
    expect(MANAGER).toContain('TournamentManagerBase.LATE_REG_REDRIVE_MS');
    expect(MANAGER).toContain('this.requestUrgentEliminationSweepAfter(0)');
  });

  it('retains every transient finish, mystery activation, and hand-for-hand failure cause', () => {
    const handForHandFailure = sliceBlockAfter(
      SWEEP,
      'if (playingNowErr || playingNow === null || playingNow === undefined)'
    );
    expect(handForHandFailure).toContain('this.requestUrgentEliminationSweepAfter(');
    expect(handForHandFailure).toMatch(/requestUrgentEliminationSweepAfter\([\s\S]*?\);\s*return;/);

    const mysteryFailure = sliceBlockAfter(SWEEP, 'catch (mbErr)');
    expect(mysteryFailure).toContain('this.requestUrgentEliminationSweepAfter(');
    expect(mysteryFailure).toMatch(/requestUrgentEliminationSweepAfter\([\s\S]*?\);\s*return;/);

    const finishFailure = sliceBlockAfter(SWEEP, 'catch (finishErr)');
    expect(finishFailure).toContain('this.requestUrgentEliminationSweepAfter(');
    expect(finishFailure).toMatch(/requestUrgentEliminationSweepAfter\([\s\S]*?\);\s*return;/);
  });

  it('repairs a closed entry payout structure through its atomic durable-wake authority', () => {
    const invalidStructure = sliceBlockAfter(
      SWEEP,
      'if (this.prizePoolFinalized && paidPlaces === null)'
    );
    expect(invalidStructure).toMatch(
      /reconcileTournamentEntryWindow\(\s*'engine\.payout_structure_repair'\s*\)/
    );
    expect(invalidStructure).toContain(
      'parsePayoutStructure(this.tournamentCache.payout_structure)'
    );
    expect(invalidStructure).toContain('this.requestUrgentEliminationSweepAfter(');
  });

  it('upgrades an already-open add-on window after start and resume registration', () => {
    const urgentAfterRegistration =
      BASE.match(
        /this\.startEliminationChecker\(\);[\s\S]*?this\.addOnPeriodTriggered[\s\S]*?this\.requestEliminationSweep\(\);/g
      ) ?? [];
    expect(urgentAfterRegistration).toHaveLength(2);
  });
});
