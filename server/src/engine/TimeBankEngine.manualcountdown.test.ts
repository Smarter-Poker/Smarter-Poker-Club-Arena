/**
 * MANUAL TIME BANK COUNTDOWN — Bible V8 §6.2.d
 *
 * The bug these tests lock out:
 *
 * Pressing "use time bank" armed TWO deadlines on the same PreciseActionTimer
 * under DIFFERENT keys, so neither cancelled the other:
 *
 *   - TimeBankEngine.activate()  -> key `timebank:<uid>`, duration = bank only
 *   - ServerTableEngine.startTurnTimer() -> key `<uid>`,
 *       duration = (remaining turn clock + bank) + 2s grace
 *
 * Both stayed live and the shorter one won. The client is told about the turn
 * timer, so with 12s still on a 30s clock and a 15s bank the screen counted
 * down from 27s while the fold landed at 15s — twelve seconds early, on a
 * player who had just paid for MORE time. It got worse the earlier in the turn
 * the button was pressed.
 *
 * The fix passes the leftover turn clock into activate() so the bank countdown
 * spans the same window as the turn timer. The auto-activation path (primary
 * timer already expired, nothing left over) passes nothing and is unchanged.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import { TimeBankEngine } from './TimeBankEngine.js';
import { PreciseActionTimer } from './PreciseActionTimer.js';

const TABLE = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const SEAT = 3;

afterEach(() => {
  vi.restoreAllMocks();
});

function bankEngine() {
  const timer = new PreciseActionTimer();
  const tbe = new TimeBankEngine(timer);
  tbe.configure(TABLE, { secondsPerUse: 15 });
  tbe.initializePlayer(TABLE, 'u1', { remainingSeconds: 60, usesRemaining: 4 });
  const spy = vi.spyOn(timer, 'startTimer');
  return { tbe, timer, spy };
}

function armedMs(spy: ReturnType<typeof vi.spyOn>): number {
  const call = spy.mock.calls.find((c) => String(c[1]).startsWith('timebank:'));
  if (!call) throw new Error('no timebank countdown was armed');
  return call[2] as number;
}

describe('TimeBankEngine.activate countdown window', () => {
  it('auto path (no leftover clock) still arms exactly the bank allocation', () => {
    const { tbe, spy } = bankEngine();
    expect(tbe.activate(TABLE, 'u1', () => {})).toBe(true);
    expect(armedMs(spy)).toBe(15_000);
    tbe.playerActed(TABLE, 'u1');
  });

  it('manual path adds the leftover turn clock to the countdown', () => {
    const { tbe, spy } = bankEngine();
    expect(tbe.activate(TABLE, 'u1', () => {}, 12)).toBe(true);
    // 12s still on the clock + 15s bank. Pre-fix this was 15_000.
    expect(armedMs(spy)).toBe(27_000);
    tbe.playerActed(TABLE, 'u1');
  });

  it('never shortens the countdown, whatever the caller passes', () => {
    const { tbe, spy } = bankEngine();
    expect(tbe.activate(TABLE, 'u1', () => {}, -30)).toBe(true);
    expect(armedMs(spy)).toBe(15_000);
    tbe.playerActed(TABLE, 'u1');
  });
});

describe('engine: the two deadlines agree', () => {
  function harness(remainingSeconds: number) {
    const engine = new ServerTableEngine(TABLE) as any;
    engine.tableInfo = {} as any;
    engine.handController = {
      getState: () => ({
        currentPlayerSeat: SEAT,
        currentBet: 0,
        players: [{ user_id: 'u1', seat: SEAT, bet: 0 }],
      }),
    };
    engine.timeBankEngine.configure(TABLE, { secondsPerUse: 15 });
    engine.timeBankEngine.initializePlayer(TABLE, 'u1', {
      remainingSeconds: 60,
      usesRemaining: 4,
    });
    // A 30s turn that started 18s ago => 12s left.
    engine.playerTurnDuration = 30;
    engine.playerTurnStartTime = Date.now() - (30 - remainingSeconds) * 1000;
    return engine;
  }

  it('the enforcement deadline is not shorter than the clock the player is shown', async () => {
    const engine = harness(12);

    const res = await engine.activateTimeBank('u1');
    expect(res.success).toBe(true);

    const bankMs = engine.preciseTimer.getRemainingMs(TABLE, `timebank:u1`);
    const turnMs = engine.preciseTimer.getRemainingMs(TABLE, 'u1');

    // The turn timer — which is what turn_deadline_ms broadcasts — is
    // 12 + 15 = 27s plus the 2s §6.1 network grace.
    expect(turnMs).toBeGreaterThan(28_000);
    expect(turnMs).toBeLessThanOrEqual(29_000);

    // The enforcement countdown must cover the same 27s. Pre-fix it was 15s,
    // and this assertion is the whole point of the file.
    expect(bankMs).toBeGreaterThan(26_000);
    expect(bankMs).toBeLessThanOrEqual(27_000);

    // It may only be shorter by the grace period, never by more.
    expect(turnMs - bankMs).toBeLessThanOrEqual(2_100);

    engine.preciseTimer.dispose();
  });

  it('pressing the button the instant the turn starts does not shorten it either', async () => {
    const engine = harness(30);

    expect((await engine.activateTimeBank('u1')).success).toBe(true);

    const bankMs = engine.preciseTimer.getRemainingMs(TABLE, `timebank:u1`);
    const turnMs = engine.preciseTimer.getRemainingMs(TABLE, 'u1');

    // 30 + 15 = 45s. Pre-fix the fold landed at 15s — thirty seconds early.
    expect(bankMs).toBeGreaterThan(44_000);
    expect(turnMs - bankMs).toBeLessThanOrEqual(2_100);

    engine.preciseTimer.dispose();
  });
});
