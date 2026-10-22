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

function manager(engines: [string, any][], processing: boolean, startedAt: number) {
  const m = Object.create(TournamentManagerBase.prototype) as any;
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
    expect(m.getStalledEliminationSweep(181_000)).toEqual({ msInFlight: 180_000, stage: -1 });
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
    expect(a.pauseAfterHand).toHaveBeenCalledWith(undefined, { untilResumed: true });
    expect(b.pauseAfterHand).toHaveBeenCalledWith(undefined, { untilResumed: true });
    expect(m.gameServer.handTournamentToSuccessorGeneration).toHaveBeenCalledWith(
      m.tournamentId,
      m
    );
  });

  it('never cuts a hand short: waits while a table still has cards in the air', () => {
    const a = eng(true, false);
    const m = manager([[A, a]], true, 1);
    expect(m.requestSuccessorForStalledEliminationSweep()).toBe(false);
    expect(a.pauseAfterHand).toHaveBeenCalled();
    expect(m.gameServer.handTournamentToSuccessorGeneration).not.toHaveBeenCalled();
  });

  it('does nothing once the sweep has settled', () => {
    const a = eng(true, true);
    const m = manager([[A, a]], false, 0);
    expect(m.requestSuccessorForStalledEliminationSweep()).toBe(false);
    expect(a.pauseAfterHand).not.toHaveBeenCalled();
    expect(m.gameServer.handTournamentToSuccessorGeneration).not.toHaveBeenCalled();
  });
});
