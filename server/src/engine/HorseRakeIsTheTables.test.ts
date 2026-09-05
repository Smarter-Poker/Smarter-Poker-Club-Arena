import { describe, expect, it } from 'vitest';
import { rakeDrag } from './HorseLogic.js';

describe('the rake a horse reasons about is the rake the table charges', () => {
  it('falls back to the old constants when the schedule is unknown', () => {
    // Byte-identical to the pre-2026-09-05 behaviour, which is what makes the
    // change safe in one step: the league simulator and every existing test
    // pass no schedule.
    expect(rakeDrag(10, 2)).toBe(0.1); // small pot: taxed
    expect(rakeDrag(1000, 2)).toBe(0); // past the approximated 2.5bb cap
  });

  it('uses the table’s percent when it has one', () => {
    expect(rakeDrag(10, 2, { rakePercent: 0.05 })).toBe(0.05);
    expect(rakeDrag(10, 2, { rakePercent: 0.02 })).toBe(0.02);
  });

  it('a rake-free table is honest at every pot size', () => {
    // A freeroll or a rake-free promotion. Pot odds are raw pot odds, and the
    // early return says so rather than falling through to the cap arithmetic.
    expect(rakeDrag(10, 2, { rakePercent: 0 })).toBe(0);
    expect(rakeDrag(100_000, 2, { rakePercent: 0 })).toBe(0);
  });

  it('uses the table’s cap, so the marginal rake stops where the club says', () => {
    // 1bb cap at 1/2 = 2 chips. A 25-chip pot is already past it at 10%.
    expect(rakeDrag(25, 2, { rakePercent: 0.1, rakeCapBB: 1 })).toBe(0);
    expect(rakeDrag(15, 2, { rakePercent: 0.1, rakeCapBB: 1 })).toBe(0.1);
    // A generous 10bb cap keeps the tax alive far longer than the old guess.
    expect(rakeDrag(150, 2, { rakePercent: 0.1, rakeCapBB: 10 })).toBe(0.1);
    expect(rakeDrag(150, 2)).toBe(0); // the old 2.5bb approximation
  });

  it('ignores a nonsense schedule rather than dividing by it', () => {
    expect(rakeDrag(10, 2, { rakePercent: Number.NaN })).toBe(0.1);
    expect(rakeDrag(10, 2, { rakePercent: -1 })).toBe(0.1);
    expect(rakeDrag(10, 2, { rakeCapBB: 0 })).toBe(0.1);
    expect(rakeDrag(10, 2, { rakeCapBB: Number.NaN })).toBe(0.1);
  });

  it('the engine hands it the real schedule', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./ServerTableEngineTurns.ts', import.meta.url), 'utf8');
    expect(src).toContain('rakeSchedule: this.getRakeOverride()');
    // ...and every call site inside the brain passes it on.
    const brain = readFileSync(new URL('./HorseLogic.ts', import.meta.url), 'utf8');
    // every CALL (not the declaration) passes the schedule on
    const calls = [...brain.matchAll(/rakeDrag\((?!pot: number)[^)]*\)/g)].map((m) => m[0]);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const c of calls) expect(c).toContain('gs.rakeSchedule');
  });
});
