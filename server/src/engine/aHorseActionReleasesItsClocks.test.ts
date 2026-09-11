/**
 * A HORSE'S ACTION RELEASES ITS CLOCKS THE WAY A HUMAN'S DOES (2026-09-11).
 *
 * `_handlePlayerActionInner` cancels the seat's `turn:<uid>` deadline, calls
 * `timeBankEngine.playerActed` for a bank spent or armed this turn, and
 * `disconnectEngine.recordPlayerActed`. The horse path called performAction
 * directly and did none of it. Measured 60 minutes to 13:27 UTC 2026-09-11 with
 * zero humans seated: 67 "Time bank expiry: FSM in 'timer_running' but seat N
 * is still current - resolving anyway" lines, each an orphaned bank deadline
 * from the same seat's previous turn forcing a check/fold over the horse's real
 * decision and counting a strike; `engine_presence_parked` at the 14:55 park
 * carried 12 horses SAT_OUT 'forced' and 257 horse entries with strikes.
 *
 * HORSES ARE PLAYERS (CLAUDE.md 10.5): same bookkeeping, same order.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sliceEnclosingBlock } from '../testHelpers/sourceWindow.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ServerTableEngine } from './ServerTableEngine.js';
import { alwaysOnPrometheusLines } from '../observability/engineInstruments.js';

const TABLE = 'f0f0f0f0-f0f0-f0f0-f0f0-f0f0f0f0f0f0';
const HORSE = 'horse-7';

const src = readFileSync(
  fileURLToPath(new URL('./ServerTableEngineTurns.ts', import.meta.url)),
  'utf8'
);

function engineWithSpies(opts: { bankActivatedThisTurn?: boolean; armed?: boolean } = {}) {
  const engine = new ServerTableEngine(TABLE) as any;
  const cancelTimer = vi.fn();
  const playerActed = vi.fn();
  const recordPlayerActed = vi.fn();
  const recordTimerActed = vi.fn();
  engine.preciseTimer = { cancelTimer };
  engine.timeBankEngine = { playerActed, isArmed: () => opts.armed === true };
  engine.disconnectEngine = { recordPlayerActed };
  engine.engineTelemetry = { recordTimerActed };
  engine.timeBankActivatedThisTurn = opts.bankActivatedThisTurn === true;
  return { engine, cancelTimer, playerActed, recordPlayerActed, recordTimerActed };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('settleHorseSeatActed', () => {
  it('cancels the turn deadline, clears the strike streak and records the timer as acted', () => {
    const { engine, cancelTimer, playerActed, recordPlayerActed, recordTimerActed } =
      engineWithSpies();
    engine.settleHorseSeatActed(HORSE);
    expect(cancelTimer).toHaveBeenCalledWith(TABLE, HORSE);
    expect(recordPlayerActed).toHaveBeenCalledWith(TABLE, HORSE);
    expect(recordTimerActed).toHaveBeenCalledWith(TABLE);
    // No bank was spent or armed this turn: nothing to release.
    expect(playerActed).not.toHaveBeenCalled();
  });

  it('releases a bank the auto-activation spent on this turn (use it or lose it, like a human)', () => {
    const { engine, playerActed } = engineWithSpies({ bankActivatedThisTurn: true });
    engine.settleHorseSeatActed(HORSE);
    expect(playerActed).toHaveBeenCalledWith(TABLE, HORSE);
  });

  it('releases an armed-but-unspent bank too, the same gate the human path uses', () => {
    const { engine, playerActed } = engineWithSpies({ armed: true });
    engine.settleHorseSeatActed(HORSE);
    expect(playerActed).toHaveBeenCalledWith(TABLE, HORSE);
  });

  it('never lets a bookkeeping throw reach the felt', () => {
    const { engine } = engineWithSpies();
    engine.preciseTimer = {
      cancelTimer: () => {
        throw new Error('boom');
      },
    };
    expect(() => engine.settleHorseSeatActed(HORSE)).not.toThrow();
  });
});

describe('the horse commit path is wired to it', () => {
  it('settles the seat only once an action LANDED, before markProgress', () => {
    const marker = 'this.settleHorseSeatActed(player.user_id);';
    const i = src.indexOf(marker);
    expect(i, 'the horse commit path no longer settles the seat').toBeGreaterThan(-1);
    // Inside the `if (applied)` branch of the horse commit, not the fallback.
    /* Bounded by the structure, never by a byte count
       (tests/unit/noFixedSizeSourceWindows): the `if (applied)` block is what
       this pin is about, and it grows exactly as fast as the code does. */
    const applied = sliceEnclosingBlock(src, marker);
    expect(applied).toContain('this.settleHorseSeatActed(player.user_id);');
    expect(applied).toContain('this.markProgress();');
    // One level out holds the branch header, which is how we know the block
    // above is the `if (applied)` arm and not the fallback beside it.
    expect(sliceEnclosingBlock(src, marker, 0, 2)).toContain('if (applied) {');
    // The unactable branch keeps the ordinary clock armed: no settle there.
    const unactable = src.indexOf("'Horse seat ' + seat + ' could not be acted");
    expect(unactable).toBeGreaterThan(i);
    expect(src.slice(i + marker.length, unactable)).not.toContain('settleHorseSeatActed(');
  });

  it('counts a horse turn the clock resolved, and nothing for a human', () => {
    const engine = new ServerTableEngine(TABLE) as any;
    engine.seatedPlayers = [
      { user_id: HORSE, seat_number: 1, is_horse: true },
      { user_id: 'human-2', seat_number: 2, is_horse: false },
    ];
    const before = alwaysOnPrometheusLines().join('\n');
    const read = (kind: string) => {
      const m = alwaysOnPrometheusLines()
        .join('\n')
        .match(new RegExp(`poker_horse_turn_timeouts_total\\{kind="${kind}"\\} (\\d+)`));
      return m ? Number(m[1]) : NaN;
    };
    const timerBefore = read('timer');
    const bankBefore = read('timebank');
    expect(before).toContain('poker_horse_turn_timeouts_total');
    engine.noteHorseTurnTimeout('human-2', 'timer');
    expect(read('timer')).toBe(timerBefore);
    engine.noteHorseTurnTimeout(HORSE, 'timer');
    engine.noteHorseTurnTimeout(HORSE, 'timebank');
    expect(read('timer')).toBe(timerBefore + 1);
    expect(read('timebank')).toBe(bankBefore + 1);
  });

  it('the four input-device series are always on and registered at zero', () => {
    const text = alwaysOnPrometheusLines().join('\n');
    for (const name of [
      'poker_horse_turn_timeouts_total',
      'poker_horse_decision_fallbacks_total',
      'poker_horse_seat_unactable_total',
      'poker_horse_forced_sit_outs_total',
    ]) {
      expect(text, name + ' must be on the always-on registry').toContain(name);
    }
    // The two expiry sites, the worker fallback, the unactable branch and the
    // forced sit-out handler all feed them.
    expect(src.match(/noteHorseTurnTimeout\(userId, 'timer'\)/g)?.length).toBe(1);
    expect(src.match(/noteHorseTurnTimeout\(userId, 'timebank'\)/g)?.length).toBe(1);
    expect(src).toContain('EngineMetrics.horseDecisionFallbacksTotal.inc(1)');
    expect(src).toContain('EngineMetrics.horseSeatUnactableTotal.inc(1)');
    const base = readFileSync(
      fileURLToPath(new URL('./ServerTableEngineBase.ts', import.meta.url)),
      'utf8'
    );
    expect(base).toContain("event.reason === 'forced' && satPlayer?.is_horse");
    expect(base).toContain('EngineMetrics.horseForcedSitOutsTotal.inc(1');
  });

  it('the bank-burn plan mirrors every refusal tryActivate can return', () => {
    const i = src.indexOf('const bankUsable =');
    expect(i).toBeGreaterThan(-1);
    const expr = src.slice(i, src.indexOf(';', i));
    expect(expr).toContain('isActive');
    expect(expr).toContain('streetActivations');
    expect(expr).toContain('usesRemaining !== 0');
  });
});
