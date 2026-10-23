import { describe, expect, it, vi } from 'vitest';
import { TournamentManagerBase } from './TournamentManagerBase.js';

/*
 * A STALLED BUST SWEEP HANDS THE EVENT TO A FRESH GENERATION (2026-10-22).
 *
 * Coffee Break Freeroll (PLO4) f5a98d7e: one admitted elimination sweep never
 * settled, so for 23 minutes no bust was recorded, every table break and
 * re-admission refused on unrecorded busts, and six tables lost their dealer.
 * The stalled sweep itself now triggers the hand-off.
 */

const A = 'aaaaaaaa-0000-4000-8000-000000000002';
const B = 'aaaaaaaa-0000-4000-8000-000000000003';

function eng(running: boolean, betweenHands: boolean) {
  return {
    isRunning: vi.fn(() => running),
    isBetweenHands: vi.fn(() => betweenHands),
    pauseAfterHand: vi.fn(),
  };
}

function manager(engines: [string, any][], processing: boolean, startedAt: number, bustSince = 0) {
  const m = Object.create(TournamentManagerBase.prototype) as any;
  m.running = true;
  m.tournamentLeaseAuthorityIsCurrent = () => true;
  m.bustAwaitingSinceMs = bustSince;
  m.tournamentId = 'eeeeeeee-0000-4000-8000-000000000001';
  m.tableEngines = new Map(engines);
  m.isProcessingEliminations = processing;
  m.eliminationSweepStartedAt = startedAt;
  m.gameServer = { handTournamentToSuccessorGeneration: vi.fn() };
  return m;
}

describe('a stalled elimination sweep hands the event to a fresh generation', () => {
  it('reports how long the in-flight sweep has been running', () => {
    const m = manager([], true, 1_000);
    expect(m.getStalledEliminationSweep(181_000)).toEqual({
      msInFlight: 180_000,
      msBustWaiting: 0,
      stage: -1,
      step: null,
      msInStep: 0,
    });
  });

  it('names the step a stalled sweep is stuck in, and for how long', () => {
    const m = manager([], true, 1_000);
    m.eliminationSweepStep = 'recoverPendingBountyObligations';
    m.eliminationSweepStepAt = 61_000;
    expect(m.getStalledEliminationSweep(181_000)).toEqual({
      msInFlight: 180_000,
      msBustWaiting: 0,
      stage: -1,
      step: 'recoverPendingBountyObligations',
      msInStep: 120_000,
    });
  });

  it('records each step the sweep enters', () => {
    const m = manager([], true, 1);
    const before = Date.now();
    m.noteEliminationSweepStep('eliminatePlayer');
    expect(m.eliminationSweepStep).toBe('eliminatePlayer');
    expect(m.eliminationSweepStepAt).toBeGreaterThanOrEqual(before);
  });

  it('reports nothing while no sweep is in flight', () => {
    expect(manager([], false, 0).getStalledEliminationSweep(5_000)).toBeNull();
    expect(manager([], true, 0).getStalledEliminationSweep(5_000)).toBeNull();
  });

  it('parks every running table and hands off once all are between hands', () => {
    const a = eng(true, true);
    const b = eng(true, true);
    const m = manager(
      [
        [A, a],
        [B, b],
      ],
      true,
      1
    );
    expect(m.requestSuccessorForStalledEliminationSweep()).toBe(true);
    expect(a.pauseAfterHand).toHaveBeenCalledWith(undefined, {
      beforeNextHand: true,
      untilResumed: true,
    });
    expect(b.pauseAfterHand).toHaveBeenCalledWith(undefined, {
      beforeNextHand: true,
      untilResumed: true,
    });
    expect(m.gameServer.handTournamentToSuccessorGeneration).toHaveBeenCalledWith(
      m.tournamentId,
      m
    );
  });

  it('never cuts a hand short: waits while a table still has cards in the air', () => {
    const a = eng(true, false);
    const m = manager([[A, a]], true, 1);
    expect(m.requestSuccessorForStalledEliminationSweep()).toBe(true);
    expect(a.pauseAfterHand).toHaveBeenCalled();
    expect(m.gameServer.handTournamentToSuccessorGeneration).not.toHaveBeenCalled();
  });

  it('times a bust the bust stage never completed, even with no sweep in flight', () => {
    // A sweep that returns early on every pass leaves no promise in flight;
    // the waiting bust is what proves the event is stuck.
    const m = manager([], false, 0, 10_000);
    expect(m.getStalledEliminationSweep(130_000)).toEqual({
      msInFlight: 0,
      msBustWaiting: 120_000,
      stage: -1,
      step: null,
      msInStep: 0,
    });
  });

  it('hands off an event whose busts are waiting though no sweep is in flight', () => {
    const a = eng(true, true);
    const m = manager([[A, a]], false, 0, 1);
    expect(m.requestSuccessorForStalledEliminationSweep()).toBe(true);
    expect(m.gameServer.handTournamentToSuccessorGeneration).toHaveBeenCalled();
  });

  it('does nothing once the sweep has settled', () => {
    const a = eng(true, true);
    const m = manager([[A, a]], false, 0);
    expect(m.requestSuccessorForStalledEliminationSweep()).toBe(false);
    expect(a.pauseAfterHand).not.toHaveBeenCalled();
    expect(m.gameServer.handTournamentToSuccessorGeneration).not.toHaveBeenCalled();
  });
});
