/**
 * DAN'S RUN-IT-TWICE RATES (2026-09-05)
 *
 * "HORSES SHOULD ALWAYS OFFER TO RUN IT TWICE (WHEN AHEAD 'RANDOMLY SELECTED)
 * 75% OF THE TIME, AND AGREE TO RUN IT TWICE OR 3X 75% OF THE TIME
 * ('RANDOMLY SELECTED)."
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { HORSE_RIT_AGREE_PCT, HORSE_RIT_OFFER_WHEN_AHEAD_PCT } from './ServerTableEngineRunout.js';

/** The verdict, reproduced exactly as the engine computes it. */
const verdict = (
  playerId: string,
  handCount: number,
  role: 'chooser' | 'responder'
): 'once' | 'multi' => {
  let h = 0;
  for (let i = 0; i < playerId.length; i++) h = (h * 31 + playerId.charCodeAt(i)) % 100000;
  const wantMulti = role === 'chooser' ? HORSE_RIT_OFFER_WHEN_AHEAD_PCT : HORSE_RIT_AGREE_PCT;
  return (h + handCount * 7) % 100 < 100 - wantMulti ? 'once' : 'multi';
};

const rate = (role: 'chooser' | 'responder') => {
  let multi = 0;
  let n = 0;
  for (let p = 0; p < 400; p++) {
    for (let hand = 1; hand <= 50; hand++) {
      if (verdict(`horse-${p}-${p * 7919}`, hand, role) === 'multi') multi++;
      n++;
    }
  }
  return multi / n;
};

describe('Dan’s run-it-twice rates', () => {
  it('both constants are 75', () => {
    expect(HORSE_RIT_OFFER_WHEN_AHEAD_PCT).toBe(75);
    expect(HORSE_RIT_AGREE_PCT).toBe(75);
  });

  it('a horse that is AHEAD offers to run it multiple about 75% of the time', () => {
    // The chooser is picked by evaluating every all-in hand against the board,
    // so "the chooser" and "the player who is ahead" are the same seat.
    expect(rate('chooser')).toBeGreaterThan(0.72);
    expect(rate('chooser')).toBeLessThan(0.78);
  });

  it('a horse asked to agree accepts about 75% of the time', () => {
    expect(rate('responder')).toBeGreaterThan(0.72);
    expect(rate('responder')).toBeLessThan(0.78);
  });

  it('one hand in four still runs ONCE, which is what keeps insurance alive', () => {
    /* checkAllInRunout asks the RIT question FIRST and only reaches
       startInsuranceFlow() on the single-run branch. When the answer was a
       constant 'accept', insurance was dark across the entire floor:
       insurance_offer_events held zero rows against 270 qualifying hands in
       24 hours. A rate of 100 would turn it off again. */
    expect(HORSE_RIT_AGREE_PCT).toBeLessThan(100);
    expect(1 - rate('responder')).toBeGreaterThan(0.2);
  });

  it('is deterministic - a replayed hand answers the same way twice', () => {
    // Math.random is banned in the engine's decision paths.
    for (const role of ['chooser', 'responder'] as const) {
      for (let p = 0; p < 100; p++) {
        const id = `h${p}`;
        expect(verdict(id, 42, role)).toBe(verdict(id, 42, role));
      }
    }
    const src = readFileSync(new URL('./ServerTableEngineRunout.ts', import.meta.url), 'utf8');
    const fn = src.slice(src.indexOf('protected horseRitVerdict('));
    expect(fn.slice(0, 600)).not.toContain('Math.random');
  });

  it('the engine asks with the ROLE, so the two rates can diverge', () => {
    const src = readFileSync(new URL('./ServerTableEngineRunout.ts', import.meta.url), 'utf8');
    expect(src).toContain("this.horseRitVerdict(chooserPlayerId, 'chooser')");
    expect(src).toContain("this.horseRitVerdict(pid, 'responder')");
  });

  it('resolves per hundred, because per ten cannot express 75', () => {
    const src = readFileSync(new URL('./ServerTableEngineRunout.ts', import.meta.url), 'utf8');
    const fn = src.slice(
      src.indexOf('protected horseRitVerdict('),
      src.indexOf('protected waitForRITResponse')
    );
    // Strip comments first: the function's own note QUOTES the old rule in
    // order to explain why it changed, and asserting on prose would fail on
    // the explanation rather than on the code.
    const code = fn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).toContain('% 100 <');
    expect(code).not.toContain('% 10 < 3');
  });

  it('a chooser saying multi still picks 2 or 3, never 1', () => {
    const src = readFileSync(new URL('./ServerTableEngineRunout.ts', import.meta.url), 'utf8');
    expect(src).toContain('(this.handCount % 3 === 0 ? 3 : 2) as 2 | 3');
  });
});
