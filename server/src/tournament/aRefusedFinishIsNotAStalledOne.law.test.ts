/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A REFUSED FINISH IS NOT A STALLED ONE (2026-10-07)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 2026-09-18 made a repeated rule refusal back off to a fifteen-minute cap
 * (aRuleRefusalStopsAskingEveryFiveSeconds), and #6403 made the finish-stage
 * re-arm keep that delay. Four Spins (87f6d0ee, 9d4067ab, a19b10fe, a6ae23f9)
 * were still asked fn_complete_tournament_terminal every ~10.6 s each.
 *
 * The wake came from GameServer's discovery pass, STALLED DECIDED-BUT-RUNNING
 * RECOVERY: every pass it reads RUNNING events with one player `playing` and
 * calls requestDecidedEliminationSweep on each live manager. That wake has a
 * zero delay and the scheduler keeps the EARLIEST pending wake, so it pulled
 * the backed-off retry forward to now on every pass. Measured from edge logs
 * at 13:15 UTC: the decided board read, then four refusals 110 ms apart
 * (DECIDED_RECOVERY_STAGGER_MS), repeating at the discovery cadence.
 *
 * The recovery exists for a finish that never ran. A finish the database
 * refused already owns its next ask. These pins keep the two apart, and keep
 * the recovery for the case it was written for: once the refusal's own retry
 * is due, the recovery may wake it again.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FINISH_REFUSAL_BACKOFF_CAP_MS } from '../observability/engineInstruments.js';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import { TournamentManagerEliminations } from './TournamentManagerEliminations.js';

const ELIM_PROTO = TournamentManagerEliminations.prototype;
const BASE = TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS;
const GAME_SERVER = readFileSync(resolve(__dirname, '../GameServer.ts'), 'utf8');

const P0404 = Object.assign(
  new Error(
    'tournament 87f6d0ee-0e7b-4921-87f4-b481f43973b1 has no complete durable elimination sequence (1/1 of 2)'
  ),
  { code: 'P0404' }
);

function freshManager() {
  const m = Object.create(ELIM_PROTO) as any;
  m.tournamentId = '87f6d0ee-0e7b-4921-87f4-b481f43973b1';
  m.tournamentFinished = false;
  m.finishRefusalStreak = 0;
  m.lastFinishRefusalReason = null;
  m.finishRefusalRetryDueAtMs = null;
  const wakes: string[] = [];
  m.declareFieldDecided = () => undefined;
  m.requestEliminationSweep = (reason?: string) => {
    wakes.push(String(reason));
    return true;
  };
  return { m, wakes };
}

describe('a refused finish owns its next ask', () => {
  it('a manager with no refusal is woken by the decided recovery, as before', () => {
    const { m, wakes } = freshManager();
    expect(m.awaitsItsOwnFinishRetry()).toBe(false);
    expect(m.requestDecidedEliminationSweep('stalled_decided_survivor')).toBe(true);
    expect(wakes).toEqual(['stalled_decided_survivor']);
  });

  it('a proven rule refusal holds the decided recovery off until its own retry is due', () => {
    const { m, wakes } = freshManager();
    const t0 = Date.now();
    for (let i = 0; i < 9; i++) m.noteFinishRefusal(true, P0404);
    expect(m.finishRetryDelayMs()).toBe(FINISH_REFUSAL_BACKOFF_CAP_MS);
    expect(m.awaitsItsOwnFinishRetry(t0 + 10_600)).toBe(true);
    // Every discovery pass in the measured window is answered by the wake
    // already pending, not by a new one.
    for (let pass = 0; pass < 5; pass++) {
      expect(m.requestDecidedEliminationSweep('stalled_decided_survivor')).toBe(false);
      expect(m.requestDecidedEliminationSweep('seat_first_terminal_stack')).toBe(false);
    }
    expect(wakes).toEqual([]);
    // Past the due time the recovery may wake it again: a lost retry is
    // still found by the next pass.
    expect(m.awaitsItsOwnFinishRetry(t0 + FINISH_REFUSAL_BACKOFF_CAP_MS + 1_000)).toBe(false);
  });

  it('the due time is the delay the refusal asked the scheduler for', () => {
    const { m } = freshManager();
    const before = Date.now();
    m.noteFinishRefusal(true, P0404);
    expect(m.finishRefusalRetryDueAtMs).toBeGreaterThanOrEqual(before + BASE);
    expect(m.finishRefusalRetryDueAtMs).toBeLessThanOrEqual(Date.now() + BASE);
    m.noteFinishRefusal(true, P0404);
    m.noteFinishRefusal(true, P0404);
    expect(m.finishRefusalRetryDueAtMs).toBeGreaterThanOrEqual(before + BASE * 4);
  });

  it('an unproven outcome is not a refusal and holds nothing off', () => {
    const { m, wakes } = freshManager();
    m.noteFinishRefusal(false, new Error('socket hang up'));
    expect(m.awaitsItsOwnFinishRetry()).toBe(false);
    expect(m.requestDecidedEliminationSweep('stalled_decided_survivor')).toBe(true);
    expect(wakes).toHaveLength(1);
  });

  it('a committed settlement clears the hold', () => {
    const { m } = freshManager();
    for (let i = 0; i < 4; i++) m.noteFinishRefusal(true, P0404);
    expect(m.awaitsItsOwnFinishRetry()).toBe(true);
    m.clearFinishRefusalStreak();
    expect(m.awaitsItsOwnFinishRetry()).toBe(false);
    expect(m.finishRefusalRetryDueAtMs).toBeNull();
  });
});

describe('both decided recoveries in GameServer ask before they wake', () => {
  it('STALLED DECIDED-BUT-RUNNING skips a manager awaiting its own retry before the stagger', () => {
    const start = GAME_SERVER.indexOf('STALLED DECIDED-BUT-RUNNING RECOVERY');
    expect(start).toBeGreaterThan(0);
    const block = GAME_SERVER.slice(start, GAME_SERVER.indexOf('STARTED-BUT-NEVER-DEALT', start));
    const skip = block.indexOf('?.awaitsItsOwnFinishRetry?.()) continue;');
    expect(skip).toBeGreaterThan(0);
    expect(skip).toBeLessThan(block.indexOf('if (decidedRecoveries++ > 0)'));
    expect(skip).toBeLessThan(
      block.indexOf("requestDecidedEliminationSweep('stalled_decided_survivor')")
    );
  });

  it('the seat-first finish sweep skips it before its reads', () => {
    const start = GAME_SERVER.indexOf('private async finishSeatFirstGamesThatAreOver');
    expect(start).toBeGreaterThan(0);
    const body = GAME_SERVER.slice(start, start + 6000);
    const skip = body.indexOf('?.awaitsItsOwnFinishRetry?.()) continue;');
    expect(skip).toBeGreaterThan(0);
    expect(skip).toBeLessThan(body.indexOf(".from('tables')"));
    expect(skip).toBeLessThan(
      body.indexOf("requestDecidedEliminationSweep('seat_first_terminal_stack')")
    );
  });

  it('the manager refuses a decided wake on its own, whoever calls it', () => {
    const base = readFileSync(resolve(__dirname, './TournamentManagerBase.ts'), 'utf8');
    const i = base.indexOf('requestDecidedEliminationSweep(reason: string): boolean {');
    expect(i).toBeGreaterThan(0);
    const body = base.slice(i, base.indexOf('\n  }\n', i));
    expect(body).toContain('if (this.awaitsItsOwnFinishRetry()) return false;');
    expect(body.indexOf('awaitsItsOwnFinishRetry')).toBeLessThan(
      body.indexOf('this.requestEliminationSweep(reason)')
    );
  });
});
