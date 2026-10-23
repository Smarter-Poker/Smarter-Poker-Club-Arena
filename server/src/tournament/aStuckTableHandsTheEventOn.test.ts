import { describe, expect, it, vi } from 'vitest';
import { TournamentManagerBase } from './TournamentManagerBase.js';

/*
 * A STUCK TABLE HANDS THE EVENT TO A FRESH GENERATION (2026-10-22): every
 * other table finishes the hand in front of its players and parks, then the
 * event is handed to a successor generation that reads every table back.
 */

const STUCK = 'aaaaaaaa-0000-4000-8000-000000000001';
const A = 'aaaaaaaa-0000-4000-8000-000000000002';
const B = 'aaaaaaaa-0000-4000-8000-000000000003';

function eng(running: boolean, betweenHands: boolean) {
  return {
    isRunning: vi.fn(() => running),
    isBetweenHands: vi.fn(() => betweenHands),
    pauseAfterHand: vi.fn(),
  };
}

function manager(engines: [string, any][], failing: string[] = []) {
  const m = Object.create(TournamentManagerBase.prototype) as any;
  m.running = true;
  m.tournamentLeaseAuthorityIsCurrent = () => true;
  m.tournamentId = 'eeeeeeee-0000-4000-8000-000000000001';
  m.tableEngines = new Map(engines);
  m.tableAdmissionFailingSince = new Map(failing.map((id) => [id, 0]));
  m.gameServer = { handTournamentToSuccessorGeneration: vi.fn() };
  return m;
}

describe('a stuck table hands the event to a fresh generation', () => {
  it('parks every other running table and hands off once all are between hands', () => {
    const a = eng(true, true);
    const b = eng(true, true);
    const m = manager([
      [STUCK, eng(false, true)],
      [A, a],
      [B, b],
    ]);
    expect(m.requestSuccessorForStuckTable(STUCK)).toBe(true);
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

  it('waits while another table still has cards in the air', () => {
    const a = eng(true, false);
    const m = manager([
      [STUCK, eng(false, true)],
      [A, a],
    ]);
    expect(m.requestSuccessorForStuckTable(STUCK)).toBe(true);
    expect(a.pauseAfterHand).toHaveBeenCalled();
    expect(m.gameServer.handTournamentToSuccessorGeneration).not.toHaveBeenCalled();
  });

  it('refuses a table whose dealer is running', () => {
    const m = manager([
      [STUCK, eng(true, true)],
      [A, eng(true, true)],
    ]);
    expect(m.requestSuccessorForStuckTable(STUCK)).toBe(false);
    expect(m.gameServer.handTournamentToSuccessorGeneration).not.toHaveBeenCalled();
  });

  it('accepts a table it is failing to admit, which has no engine', () => {
    const m = manager([[A, eng(true, true)]], [STUCK]);
    expect(m.requestSuccessorForStuckTable(STUCK)).toBe(true);
  });

  it('refuses a table it does not own', () => {
    const m = manager([[A, eng(true, true)]]);
    expect(m.requestSuccessorForStuckTable(STUCK)).toBe(false);
  });
});
