/**
 * 2026-10-17: the league completes each hand's action stream the way
 * production does (workerRuntime observeCompletedHand). Before this, observe()
 * only saw the prefix each decision was taken on, so the action that ends a
 * hand (a river call, a fold to a bet) never reached league memory and
 * riverBetOpps stayed 0 for every league seat, while production's river read
 * fires ~200k times a day.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { playHand } from './HorseLeague.js';
import { HorseMind } from '../engine/HorseMind.js';

beforeEach(() => HorseMind.reset());
afterEach(() => vi.restoreAllMocks());

type Act = { userId?: string; action: string; stage: string; isFullRaise?: boolean };
const aggressive = (a: Act) =>
  a.action === 'bet' || a.action === 'raise' || (a.action === 'all_in' && a.isFullRaise === true);

/** River responses to another player's bet, exactly as HorseMind.observe attributes them. */
function riverResponses(history: Act[]): Map<string, number> {
  const out = new Map<string, number>();
  let bettor: string | null = null;
  for (const a of history) {
    if (a.stage !== 'river' || !a.userId) continue;
    const response = aggressive(a) || a.action === 'call' || a.action === 'fold';
    if (bettor && a.userId !== bettor && response) out.set(a.userId, (out.get(a.userId) ?? 0) + 1);
    if (aggressive(a)) bettor = a.userId;
  }
  return out;
}

describe('the league completes hands like production', () => {
  it('counts every river response, including the one that ends the hand', () => {
    const expected = new Map<string, number>();
    const settle = HorseMind.observeHandComplete.bind(HorseMind);
    vi.spyOn(HorseMind, 'observeHandComplete').mockImplementation((key, actions, ...rest) => {
      for (const [id, n] of riverResponses((actions ?? []) as Act[]))
        expected.set(id, (expected.get(id) ?? 0) + n);
      return settle(key, actions, ...rest);
    });
    const sb = HorseMind.createSandbox();
    const HANDS = 300;
    for (let h = 0; h < HANDS; h++)
      playHand(7000 + h * 7919, (h % 6) + 1, () => ({}), undefined, sb);
    const total = [...expected.values()].reduce((x, y) => x + y, 0);
    expect(total).toBeGreaterThan(0);
    expect(sb.stats.size).toBe(6);
    for (const [id, s] of sb.stats) {
      expect(s.riverBetOpps, id).toBe(expected.get(id) ?? 0);
      // Decisions and completion share one hand key: no hand counts twice.
      expect(s.hands).toBeLessThanOrEqual(HANDS);
    }
  });

  it('leaves live memory untouched', () => {
    const sb = HorseMind.createSandbox();
    playHand(4242, 1, () => ({}), undefined, sb);
    expect(HorseMind.getStats('league-1')).toBeUndefined();
    expect(HorseMind.dirtyCount()).toBe(0);
  });
});
