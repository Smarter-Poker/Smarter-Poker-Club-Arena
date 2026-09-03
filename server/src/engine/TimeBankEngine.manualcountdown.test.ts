/**
 * MANUAL TIME BANK — Bible V8 §6.2.d, as re-ruled by the owner on 2026-08-23.
 *
 * THE RULE THIS FILE NOW PINS
 *
 *   "It should not take a time bank or add more time until you have truly used
 *    your entire 15 seconds. Then if the time bank is used, it must reset the
 *    clock for 20 more seconds."
 *
 * So there are two outcomes for a press, not one:
 *
 *   clock still running  -> ARMED. Nothing spent, nothing added, no countdown
 *                           touched. The bank is redeemed by
 *                           onPrimaryTimerExpired the instant the clock dies.
 *   clock exhausted      -> SPENT. The countdown is reset to exactly the bank
 *                           allocation (20s), from a standing start.
 *
 * WHAT THIS FILE USED TO PIN, AND WHY IT CHANGED
 *
 * Pressing "use time bank" once armed TWO deadlines on the same
 * PreciseActionTimer under DIFFERENT keys, so neither cancelled the other:
 *
 *   - TimeBankEngine.activate()  -> key `timebank:<uid>`, duration = bank only
 *   - ServerTableEngine.startTurnTimer() -> key `<uid>`,
 *       duration = (remaining turn clock + bank) + 2s grace
 *
 * Both stayed live and the shorter one won, so a player who had just paid for
 * MORE time was folded early. The 2026-08-18 fix made the bank countdown span
 * `remaining + bank` as well. The two deadlines then agreed — on the wrong
 * number. A bank pressed with 12s left produced a 32-second turn and a bank
 * already spent, which is precisely the complaint above.
 *
 * The desync those old tests guarded cannot recur under the new rule for a
 * structural reason worth stating: there is no longer any leftover clock to
 * span, because a bank is only ever granted from zero. Both deadlines are the
 * same 20 seconds. The last describe block below still asserts they agree.
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
  tbe.configure(TABLE, { secondsPerUse: 20 });
  tbe.initializePlayer(TABLE, 'u1', { remainingSeconds: 60, usesRemaining: 3 });
  const spy = vi.spyOn(timer, 'startTimer');
  return { tbe, timer, spy };
}

function armedMs(spy: ReturnType<typeof vi.spyOn>): number {
  const call = spy.mock.calls.find((c: unknown[]) => String(c[1]).startsWith('timebank:'));
  if (!call) throw new Error('no timebank countdown was armed');
  return call[2] as number;
}

describe('a bank is not spent until the action clock is exhausted', () => {
  it('refuses while the player still has ordinary clock, and spends nothing', () => {
    const { tbe, spy } = bankEngine();

    expect(tbe.tryActivate(TABLE, 'u1', () => {}, 12)).toBe('clock_not_exhausted');

    // The whole point: no countdown, no pool movement, no street activation.
    expect(spy.mock.calls.some((c) => String(c[1]).startsWith('timebank:'))).toBe(false);
    expect(tbe.getUsesRemaining(TABLE, 'u1')).toBe(3);
    expect(tbe.getRemainingSeconds(TABLE, 'u1')).toBe(60);
    expect(tbe.getPlayerBank(TABLE, 'u1')!.streetActivations).toBe(0);
  });

  it('allows the sub-second leftover a real network round trip leaves behind', () => {
    // The client posts /timebank when ITS countdown reaches zero; the engine
    // measures the leftover from its own stamps. A hard zero would refuse every
    // legitimate expiry-path press and auto-fold the player instead.
    const { tbe } = bankEngine();
    expect(TimeBankEngine.CLOCK_EXHAUSTED_EPSILON_SECONDS).toBeGreaterThan(0);
    expect(tbe.tryActivate(TABLE, 'u1', () => {}, 0.4)).toBe('activated');
    tbe.playerActed(TABLE, 'u1');
  });

  it('resets to exactly the bank allocation once the clock is gone', () => {
    const { tbe, spy } = bankEngine();
    expect(tbe.tryActivate(TABLE, 'u1', () => {}, 0)).toBe('activated');
    // 20s, not 20 + whatever was left. Pre-2026-08-23 a press at 12s armed
    // 32_000 here and the turn ran 32 seconds.
    expect(armedMs(spy)).toBe(20_000);
    tbe.playerActed(TABLE, 'u1');
  });

  it('never shortens the countdown, whatever the caller passes', () => {
    const { tbe, spy } = bankEngine();
    expect(tbe.activate(TABLE, 'u1', () => {}, -30)).toBe(true);
    expect(armedMs(spy)).toBe(20_000);
    tbe.playerActed(TABLE, 'u1');
  });
});

describe('arming: the press that costs nothing', () => {
  it('arm() spends nothing and lets the expiry path redeem it', () => {
    const { tbe, spy } = bankEngine();

    expect(tbe.arm(TABLE, 'u1')).toBe(true);
    expect(tbe.isArmed(TABLE, 'u1')).toBe(true);
    expect(tbe.getUsesRemaining(TABLE, 'u1')).toBe(3);
    expect(spy.mock.calls.some((c) => String(c[1]).startsWith('timebank:'))).toBe(false);

    // The clock has now died. THIS is the moment the bank is spent.
    expect(tbe.onPrimaryTimerExpired(TABLE, 'u1', () => {})).toBe(true);
    expect(tbe.getUsesRemaining(TABLE, 'u1')).toBe(2);
    expect(tbe.isArmed(TABLE, 'u1')).toBe(false);
    tbe.playerActed(TABLE, 'u1');
  });

  it('an armed bank fires even when the table has autoActivate off', () => {
    // FIX 123 tables (time_bank_enabled = false) never auto-extend. Without the
    // armed path the manual button would do literally nothing on them.
    const timer = new PreciseActionTimer();
    const tbe = new TimeBankEngine(timer);
    tbe.configure(TABLE, { secondsPerUse: 20, autoActivate: false });
    tbe.initializePlayer(TABLE, 'u1', { remainingSeconds: 40, usesRemaining: 2 });

    expect(tbe.onPrimaryTimerExpired(TABLE, 'u1', () => {})).toBe(false);
    expect(tbe.arm(TABLE, 'u1')).toBe(true);
    expect(tbe.onPrimaryTimerExpired(TABLE, 'u1', () => {})).toBe(true);
    tbe.playerActed(TABLE, 'u1');
    timer.dispose();
  });

  it('an intent not redeemed on this decision does not leak into the next one', () => {
    const { tbe } = bankEngine();
    expect(tbe.arm(TABLE, 'u1')).toBe(true);
    tbe.playerActed(TABLE, 'u1'); // player acted in time; the intent dies with it
    expect(tbe.isArmed(TABLE, 'u1')).toBe(false);
    tbe.arm(TABLE, 'u1');
    tbe.resetStreetActivations(TABLE); // flop
    expect(tbe.isArmed(TABLE, 'u1')).toBe(false);
  });

  it('refuses to arm what cannot be spent', () => {
    const timer = new PreciseActionTimer();
    const tbe = new TimeBankEngine(timer);
    tbe.initializePlayer(TABLE, 'u1', { remainingSeconds: 0, usesRemaining: 0 });
    expect(tbe.arm(TABLE, 'u1')).toBe(false);
    timer.dispose();
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
    engine.timeBankEngine.configure(TABLE, { secondsPerUse: 20 });
    engine.timeBankEngine.initializePlayer(TABLE, 'u1', {
      remainingSeconds: 60,
      usesRemaining: 3,
    });
    // A 15s turn with `remainingSeconds` still to run.
    engine.playerTurnDuration = 15;
    engine.playerTurnStartTime = Date.now() - (15 - remainingSeconds) * 1000;
    return engine;
  }

  it('a press mid-turn arms and does not touch either clock', async () => {
    const engine = harness(12);
    const turnBefore = engine.preciseTimer.getRemainingMs(TABLE, 'u1');

    const res = await engine.activateTimeBank('u1');
    expect(res.success).toBe(true);
    expect(res.armed).toBe(true);
    expect(engine.timeBankEngine.isArmed(TABLE, 'u1')).toBe(true);

    // Nothing spent, no bank countdown, and the turn clock is where it was.
    expect(engine.timeBankEngine.getUsesRemaining(TABLE, 'u1')).toBe(3);
    expect(engine.preciseTimer.getRemainingMs(TABLE, 'timebank:u1')).toBeLessThanOrEqual(0);
    expect(engine.preciseTimer.getRemainingMs(TABLE, 'u1')).toBe(turnBefore);
    expect(engine.timeBankActivatedThisTurn).toBeFalsy();

    engine.preciseTimer.dispose();
  });

  it('a press at expiry resets the clock to 20s and both deadlines match', async () => {
    const engine = harness(0);

    const res = await engine.activateTimeBank('u1');
    expect(res.success).toBe(true);
    expect(res.armed).toBeUndefined();

    const bankMs = engine.preciseTimer.getRemainingMs(TABLE, `timebank:u1`);
    const turnMs = engine.preciseTimer.getRemainingMs(TABLE, 'u1');

    // The turn timer — which is what turn_deadline_ms broadcasts — is the
    // 20s grant plus the 2s §6.1 network grace, and nothing else.
    expect(turnMs).toBeGreaterThan(21_000);
    expect(turnMs).toBeLessThanOrEqual(22_000);

    // The enforcement countdown covers the same 20s.
    expect(bankMs).toBeGreaterThan(19_000);
    expect(bankMs).toBeLessThanOrEqual(20_000);

    // It may only be shorter by the grace period, never by more. This is the
    // §6.2.d assertion the file was originally written for.
    expect(turnMs - bankMs).toBeLessThanOrEqual(2_100);

    engine.preciseTimer.dispose();
  });

  it('pressing the button the instant the turn starts costs nothing at all', async () => {
    const engine = harness(15);

    const res = await engine.activateTimeBank('u1');
    expect(res.armed).toBe(true);
    // Pre-2026-08-23 this spent a bank and produced a 35-second turn.
    expect(engine.timeBankEngine.getRemainingSeconds(TABLE, 'u1')).toBe(60);

    engine.preciseTimer.dispose();
  });
});
