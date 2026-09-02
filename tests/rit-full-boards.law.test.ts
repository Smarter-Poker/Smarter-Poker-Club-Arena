/**
 * RIT FULL BOARDS LAW (Dan 2026-08-30, binding)
 *
 * When a hand is run 2 or 3 times, EVERY board row shows the complete board:
 * the shared flop/turn cards appear on runs 2+ exactly as they were dealt,
 * plus that run's re-dealt streets. The bug that shipped: TablePage.css hid
 * the shared prefix on extra runs (`visibility: hidden` keyed off
 * data-base-count), so a turn all-in run 3 times rendered runs 2 and 3 as a
 * lone river card. This pin keeps that rule dead.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('RIT full boards law', () => {
  it('TablePage.css never hides the shared board prefix on extra runs', () => {
    const css = readFileSync(resolve(__dirname, '../src/pages/TablePage.css'), 'utf8');
    // The shipped bug: .community-area__run--extra[data-base-count=...] with
    // visibility: hidden on the prefix card slots.
    const blocks = css.split('}');
    const offenders = blocks.filter(
      (b) =>
        b.includes('community-area__run--extra') &&
        b.includes('data-base-count') &&
        /visibility\s*:\s*hidden|display\s*:\s*none|opacity\s*:\s*0(?![.\d])/.test(b)
    );
    expect(offenders).toEqual([]);
  });

  it('engine builds each RIT board as existing board plus run cards (full boards on the wire)', () => {
    const src = readFileSync(
      resolve(__dirname, '../server/src/engine/ServerTableEngineRunout.ts'),
      'utf8'
    );
    expect(src).toContain('boards.push([...existingBoard, ...runCards])');
  });
});
