/**
 * A REFUSED ACTION DOES NOT BUY A NEW CLOCK (2026-10-04).
 *
 * The action path cancels the turn clock before applying the action. When the
 * hand controller then refused the action, the seat was given a whole new
 * action clock and normal bank eligibility, so one request the validator
 * passes and the controller refuses - a `raise` from a seat that may not
 * reopen the betting - reset the turn every time it was sent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';

const TABLE = 'dddddddd-1234-4321-9876-dddddddddddd';
const PLAYER = 'stalling-player';
const T0 = 1_800_000_000_000;
const engines: any[] = [];

function harness() {
  const now = vi.spyOn(Date, 'now').mockReturnValue(T0);
  const engine = new ServerTableEngine(TABLE) as any;
  engines.push(engine);
  engine.running = true;
  engine.isCurrentEngine = () => true;
  engine.tableInfo = { action_time_seconds: 15, big_blind: 2, variant: 'nlh' };
  const state = {
    currentPlayerSeat: 2,
    currentBet: 10,
    minRaise: 10,
    pot: 30,
    stage: 'flop',
    actionHistory: [],
    players: [
      {
        user_id: PLAYER,
        seat: 2,
        bet: 0,
        stack: 100,
        totalInvested: 0,
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      },
    ],
  };
  const performAction = vi.fn(() => false);
  engine.handController = { getState: () => state, performAction };
  engine.seatedPlayers = [{ user_id: PLAYER, seat_number: 2 }];
  engine.hub = { emitEvent: vi.fn() };
  engine.requestSnapshot = vi.fn();
  engine.timeBankEngine.configure(TABLE, { secondsPerUse: 20, autoActivate: true });
  engine.timeBankEngine.initializePlayer(TABLE, PLAYER, { remainingSeconds: 40, usesRemaining: 2 });
  engine.disconnectEngine.registerPlayer(TABLE, PLAYER);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const displayDeadline = () => engine.playerTurnStartTime + engine.playerTurnDuration * 1000;
  return { engine, state, now, performAction, displayDeadline };
}

afterEach(() => {
  for (const engine of engines.splice(0)) {
    engine.timeBankEngine.dispose(TABLE);
    engine.disconnectEngine.disposeAll();
    engine.preciseTimer.dispose();
  }
  vi.restoreAllMocks();
});

describe('a refused action keeps the clock it was answering', () => {
  it('the published deadline and the enforcement deadline do not move', () => {
    const h = harness();
    h.engine.startTurnTimer(PLAYER, 2, 15);
    const published = h.displayDeadline();
    const enforced = h.engine.preciseTimer.getDeadline(TABLE, PLAYER);
    expect(published).toBe(T0 + 15_000);
    expect(enforced).toBe(T0 + 17_000);

    // Five refused raises, one every two seconds: ten seconds of the fifteen.
    for (let i = 1; i <= 5; i++) {
      h.now.mockReturnValue(T0 + i * 2_000);
      expect(h.engine.handlePlayerAction(PLAYER, 'raise', 30)).toMatchObject({
        success: false,
        code: 'INVALID_ACTION',
      });
      expect(h.performAction).toHaveBeenCalledTimes(i);
      expect(h.displayDeadline()).toBe(published);
      expect(h.engine.preciseTimer.getDeadline(TABLE, PLAYER)).toBe(enforced);
      expect(h.engine.turnFSM.state).toBe('timer_running');
    }
    expect(h.engine.timeBankEngine.getUsesRemaining(TABLE, PLAYER)).toBe(2);
  });

  it('a refusal inside the enforcement grace still leaves a clock, and no extra time', () => {
    const h = harness();
    h.engine.startTurnTimer(PLAYER, 2, 15);
    h.now.mockReturnValue(T0 + 16_000);
    h.engine.handlePlayerAction(PLAYER, 'raise', 30);
    expect(h.engine.preciseTimer.hasTimer(TABLE, PLAYER)).toBe(true);
    expect(h.engine.preciseTimer.getDeadline(TABLE, PLAYER)).toBeLessThanOrEqual(T0 + 18_001);
  });

  it('a refusal during a running bank does not open a second bank on the same turn', async () => {
    const h = harness();
    h.engine.startTurnTimer(PLAYER, 2, 15);
    h.now.mockReturnValue(T0 + 15_000);
    expect(await h.engine.activateTimeBank(PLAYER)).toMatchObject({ success: true });
    const bankDeadline = h.displayDeadline();
    expect(bankDeadline).toBe(T0 + 35_000);

    h.now.mockReturnValue(T0 + 27_000);
    h.engine.handlePlayerAction(PLAYER, 'raise', 30);

    expect(h.displayDeadline()).toBe(bankDeadline);
    expect(h.engine.timeBankActivatedThisTurn).toBe(true);
    expect(h.engine.timeBankEngine.getPlayerBank(TABLE, PLAYER).isActive).toBe(false);
    expect(h.engine.timeBankEngine.getUsesRemaining(TABLE, PLAYER)).toBe(1);
  });

  it('a seat that is no longer on the clock is given none', () => {
    const h = harness();
    h.engine.startTurnTimer(PLAYER, 2, 15);
    h.engine.preciseTimer.cancelTimer(TABLE, PLAYER);
    h.state.currentPlayerSeat = 3;
    h.engine.restoreTurnClockAfterRejectedAction(PLAYER, 2, T0 + 15_000);
    expect(h.engine.preciseTimer.hasTimer(TABLE, PLAYER)).toBe(false);
  });
});
