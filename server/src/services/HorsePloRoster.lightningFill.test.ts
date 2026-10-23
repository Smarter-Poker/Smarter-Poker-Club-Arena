import { afterEach, describe, expect, it } from 'vitest';
import { __setLightningFillForTest, lightningFillVerdict } from './HorsePloRoster.js';

/* Dan 2026-10-23: "make sure the horses are all playing 50 horses need to
   join both holdem and plo". A fill horse plays its own Lightning test game,
   outside the roster rules there, and takes no new cash seat anywhere else
   (the database seat guard refuses one too). */
const NLH = 'b3c63129-9377-4c61-9f62-089893a20c66';
const PLO = '705270cd-03c2-40d9-8749-038f741a295c';

describe('a Lightning fill horse plays its own test game', () => {
  afterEach(() => __setLightningFillForTest([]));

  it('is free when it is not on the fill list', () => {
    __setLightningFillForTest([['horse-a', NLH]]);
    expect(lightningFillVerdict('horse-b', NLH)).toBe('free');
    expect(lightningFillVerdict('horse-b', 'some-other-game')).toBe('free');
  });

  it('is fill at its own game and elsewhere at every other one', () => {
    __setLightningFillForTest([
      ['horse-a', NLH],
      ['horse-p', PLO],
    ]);
    expect(lightningFillVerdict('horse-a', NLH)).toBe('fill');
    expect(lightningFillVerdict('horse-a', PLO)).toBe('elsewhere');
    expect(lightningFillVerdict('horse-p', PLO)).toBe('fill');
    expect(lightningFillVerdict('horse-p', NLH)).toBe('elsewhere');
  });

  it('treats a table with no game as elsewhere, as the seat guard does', () => {
    __setLightningFillForTest([['horse-a', NLH]]);
    expect(lightningFillVerdict('horse-a', null)).toBe('elsewhere');
    expect(lightningFillVerdict('horse-a', undefined)).toBe('elsewhere');
  });
});
