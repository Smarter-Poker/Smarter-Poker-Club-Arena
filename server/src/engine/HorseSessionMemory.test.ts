import { beforeEach, describe, expect, it } from 'vitest';
import { TABLE_IMAGE_HANDS, horseSessionMemory } from './HorseSessionMemory.js';

const T = 'table-1';
const seats = (...pairs: Array<[string, number]>) =>
  pairs.map(([user_id, stack]) => ({ user_id, stack }));

describe('HorseSessionMemory', () => {
  beforeEach(() => horseSessionMemory.reset());

  it('knows nothing about a seat it has never seen', () => {
    expect(horseSessionMemory.read(T, 'nobody', 2)).toEqual({
      handsHere: 0,
      minutesSeated: 0,
      netChips: 0,
      netBB: 0,
      hasTableImage: false,
    });
  });

  it('counts hands and nets chips across them', () => {
    horseSessionMemory.noteHandStart(T, seats(['a', 200], ['b', 200]));
    horseSessionMemory.noteHandEnd(T, seats(['a', 260], ['b', 140]));
    horseSessionMemory.noteHandStart(T, seats(['a', 260], ['b', 140]));
    horseSessionMemory.noteHandEnd(T, seats(['a', 240], ['b', 160]));

    const a = horseSessionMemory.read(T, 'a', 2);
    expect(a.handsHere).toBe(2);
    expect(a.netChips).toBe(40);
    expect(a.netBB).toBe(20);
    const b = horseSessionMemory.read(T, 'b', 2);
    expect(b.netChips).toBe(-40);
  });

  it('a rebuy between hands does not read as a loss - the whole point', () => {
    /* The obvious implementation - remember the buy-in, subtract it from the
       stack - reads a rebuy as a catastrophic loss. Summing over HANDS makes
       chips added between them invisible by construction. */
    horseSessionMemory.noteHandStart(T, seats(['a', 200]));
    horseSessionMemory.noteHandEnd(T, seats(['a', 0])); // busted: -200
    // ...tops up to 200 between hands, which nothing here observes...
    horseSessionMemory.noteHandStart(T, seats(['a', 200]));
    horseSessionMemory.noteHandEnd(T, seats(['a', 210])); // +10

    const a = horseSessionMemory.read(T, 'a', 2);
    expect(a.netChips).toBe(-190); // not -390, and not +10
    expect(a.handsHere).toBe(2);
  });

  it('a seat that was not in the hand is not credited with its stack change', () => {
    horseSessionMemory.noteHandStart(T, seats(['a', 200]));
    // 'c' sat down mid-hand and appears only at the settle
    horseSessionMemory.noteHandEnd(T, seats(['a', 220], ['c', 500]));
    expect(horseSessionMemory.read(T, 'c', 2).handsHere).toBe(0);
    expect(horseSessionMemory.read(T, 'c', 2).netChips).toBe(0);
  });

  it('a table image needs a real session behind it', () => {
    for (let i = 0; i < TABLE_IMAGE_HANDS - 1; i++) {
      horseSessionMemory.noteHandStart(T, seats(['a', 100]));
      horseSessionMemory.noteHandEnd(T, seats(['a', 100]));
    }
    expect(horseSessionMemory.read(T, 'a', 2).hasTableImage).toBe(false);
    horseSessionMemory.noteHandStart(T, seats(['a', 100]));
    horseSessionMemory.noteHandEnd(T, seats(['a', 100]));
    expect(horseSessionMemory.read(T, 'a', 2).hasTableImage).toBe(true);
  });

  it('forgets a seat that leaves, and a table that closes', () => {
    horseSessionMemory.noteHandStart(T, seats(['a', 100], ['b', 100]));
    horseSessionMemory.noteHandEnd(T, seats(['a', 120], ['b', 80]));
    expect(horseSessionMemory.size()).toBe(2);
    horseSessionMemory.forgetSeat(T, 'a');
    expect(horseSessionMemory.read(T, 'a', 2).handsHere).toBe(0);
    horseSessionMemory.forgetTable(T);
    expect(horseSessionMemory.size()).toBe(0);
  });

  it('there is no is_horse anywhere in it - CLAUDE.md 10.5', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./HorseSessionMemory.ts', import.meta.url), 'utf8');
    // The header says the words in order to forbid them; strip the comments,
    // then assert on the code.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/is_horse|isHorse/);
  });
});
