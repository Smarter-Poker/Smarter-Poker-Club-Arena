/**
 * LAW - THE HERO'S STACK DOES NOT MOVE WHEN THEY ARE DEALT IN
 *
 * Dan 2026-10-12: "YOU CAN NOT SEE YOUR STACK SIZE WHEN YOU HAVE A HAND OR ARE
 * INVOLVED IN A HAND. THIS NEEDS TO BE FIXED AND BE EXACTLY THE SAME AS HOW IT
 * IS IN THE CLUB ARENA."
 *
 * The live hand-strength row under the hero's plate was in flow, so it grew
 * the centred seat block whenever the hero held cards and pushed the plate
 * (and the stack on it) down under the action bar. It hangs out of flow now.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceCssRule } from './helpers/sourceWindow';

const CSS = readFileSync(resolve(__dirname, '../src/components/table/SeatSlot.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
);

describe("LAW - the hero's stack stays where it is during a hand", () => {
  it('the hand-strength row is out of flow and hangs under the plate', () => {
    const rule = sliceCssRule(CSS, '.seat__strength');
    expect(rule).toMatch(/position:\s*absolute/);
    expect(rule).toMatch(/top:\s*100%/);
  });
});
