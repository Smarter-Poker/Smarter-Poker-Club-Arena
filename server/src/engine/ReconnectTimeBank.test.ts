/**
 * RECONNECT MUST NOT DESYNC THE TIME BANK DEADLINE (2026-08-18).
 *
 * §6.2.d fixed "two deadlines, the shorter one wins" for the manual time bank
 * button. The reconnect path had the same shape and was not covered.
 *
 * A time bank arms `timebank:<uid>` on the PreciseActionTimer. The ordinary
 * turn clock uses the key `<uid>`. They are different keys, so re-arming one
 * does not cancel the other. rearmTurnTimerIfCurrent (which exists so a player
 * who reconnects on their own turn is not left with no timer at all) called
 * handleTurnChange unconditionally, which:
 *
 *   - replaced `<uid>` with a fresh 15s + grace clock, and
 *   - re-stamped playerTurnStartTime / playerTurnDuration, which is exactly
 *     what turn_deadline_ms broadcasts to the client.
 *
 * The bank countdown underneath kept its original deadline. A player whose tab
 * suspended and woke three seconds before that deadline was shown a fresh
 * twenty seconds and folded three seconds later.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';

const TABLE = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SEAT = 3;

afterEach(() => {
  vi.restoreAllMocks();
});

function harness() {
  const engine = new ServerTableEngine(TABLE) as any;
  engine.tableInfo = {} as any;
  engine.handController = {
    getState: () => ({
      currentPlayerSeat: SEAT,
      currentBet: 0,
      players: [
        {
          user_id: 'u1',
          seat: SEAT,
          bet: 0,
          is_folded: false,
          is_all_in: false,
          is_sitting_out: false,
        },
      ],
    }),
  };
  // rearmTurnTimerIfCurrent -> handleTurnChange needs a seated player to act on;
  // without one it returns early and the test would pass vacuously.
  engine.seatedPlayers = [{ seat_number: SEAT, user_id: 'u1' }];
  engine.timeBankEngine.configure(TABLE, { secondsPerUse: 20 });
  engine.timeBankEngine.initializePlayer(TABLE, 'u1', {
    remainingSeconds: 40,
    usesRemaining: 2,
  });
  engine.playerTurnDuration = 15;
  // The 15s decision clock is SPENT. Since 2026-08-23 that is a precondition
  // for spending a bank at all ("it should not take a time bank ... until you
  // have truly used your entire 15 seconds"). This file is about what a
  // reconnect does to an already-running bank, not about when one may start,
  // so the harness now opens at the only moment a bank can legitimately begin.
  engine.playerTurnStartTime = Date.now() - 15_000;
  return engine;
}

describe('reconnecting while a time bank is running', () => {
  it('leaves the enforcement deadline and the broadcast deadline in agreement', async () => {
    const engine = harness();
    expect((await engine.activateTimeBank('u1')).success).toBe(true);

    const bankBefore = engine.preciseTimer.getRemainingMs(TABLE, 'timebank:u1');
    const turnBefore = engine.preciseTimer.getRemainingMs(TABLE, 'u1');
    const stampBefore = engine.playerTurnStartTime;
    const durationBefore = engine.playerTurnDuration;

    engine.rearmTurnTimerIfCurrent('u1');

    const bankAfter = engine.preciseTimer.getRemainingMs(TABLE, 'timebank:u1');
    const turnAfter = engine.preciseTimer.getRemainingMs(TABLE, 'u1');

    // Neither deadline moved: the reconnect bought nothing and cost nothing.
    expect(Math.abs(bankAfter - bankBefore)).toBeLessThanOrEqual(150);
    expect(Math.abs(turnAfter - turnBefore)).toBeLessThanOrEqual(150);

    // And what the client is told still matches what will actually be enforced.
    // Pre-fix, playerTurnStartTime was re-stamped to now and the duration reset
    // to the plain action clock, so the broadcast promised time the armed bank
    // countdown was never going to honour.
    expect(engine.playerTurnStartTime).toBe(stampBefore);
    expect(engine.playerTurnDuration).toBe(durationBefore);
    expect(turnAfter - bankAfter).toBeLessThanOrEqual(2_100);

    engine.preciseTimer.dispose();
  });

  it('still re-arms a reconnecting player who has NO time bank running', async () => {
    // The hang this method exists to prevent: a reconnect with no live timer.
    const engine = harness();
    engine.preciseTimer.cancelTimer(TABLE, 'u1');
    expect(engine.preciseTimer.getRemainingMs(TABLE, 'u1')).toBeLessThanOrEqual(0);

    engine.rearmTurnTimerIfCurrent('u1');

    expect(engine.preciseTimer.getRemainingMs(TABLE, 'u1')).toBeGreaterThan(1_000);
    engine.preciseTimer.dispose();
  });
});
