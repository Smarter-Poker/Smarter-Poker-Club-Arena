/**
 * THE BUTTON HAS TO COME FROM THE COLUMN THAT HOLDS IT.
 *
 * `HandHistoryService.mapHandHistoryRow` derived the button from
 * `players[].isButton` — a field NOTHING in this codebase has ever written. It
 * therefore fell back to seat 1 on every hand, and every position badge the
 * table drew (Hand History, Hand Detail, the shared-hand export) was wrong.
 * `hand_history.button_seat` has been written correctly the whole time and was
 * simply missing from the SELECT.
 *
 * It then fed that button into a local `getPositionName` doing
 * `(seat - buttonSeat + playerCount) % playerCount` — modular arithmetic on RAW
 * seat numbers. That is wrong the moment seating is sparse, and a six-handed
 * hand on seats 1, 2, 3, 5, 8, 9 is the normal case here.
 * `src/utils/pokerPositions.ts` exists for exactly this and says so in its own
 * header; the service never used it.
 *
 * Two static guards, because both failures are silent: nothing throws, a badge
 * is simply wrong, and on a money surface a wrong badge is not cosmetic.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { derivePositions } from '../../src/utils/pokerPositions';
import { sliceStatement } from '../helpers/sourceWindow';

const SRC = readFileSync(resolve(__dirname, '../../src/services/HandHistoryService.ts'), 'utf8');

/**
 * Comments stripped, because the file DOCUMENTS the old broken formula and the
 * guard below must not match the explanation of the bug it is guarding against.
 * A test that fails on its own changelog teaches the next person to delete the
 * changelog.
 */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('hand history reads the real button', () => {
  it('selects button_seat on every hand_history query', () => {
    // One select list for every hand_history read (2026-09-04), and it carries
    // the column.
    const list = SRC.slice(
      SRC.indexOf('export const HAND_HISTORY_COLUMNS'),
      SRC.indexOf('].join(')
    );
    expect(list).toContain("'button_seat'");
    const reads = [...SRC.matchAll(/from\('hand_history'\)\s*\.select\(([^)]*)\)/g)].map((m) =>
      m[1].trim()
    );
    expect(reads.length).toBeGreaterThan(0);
    /**
     * ONE COLUMN LIST, AND AN EMBED MAY BE ADDED TO IT (2026-09-20).
     *
     * This used to require the argument to BE `HAND_HISTORY_COLUMNS`, which
     * said two things at once: the column list is shared, and a read may not
     * embed anything. The first is the invariant - `button_seat` reaches every
     * surface because there is one list - and it still holds exactly.
     *
     * The second was never the point and now blocks the arena scope:
     * `getPlayerHands` embeds `ca_hand_facts` under its named constraint to
     * filter a Diamond player's record to the arena server-side, and that embed
     * is APPENDED to the shared constant rather than replacing it. So the pin
     * is now: every read names the constant, and no read spells a column list
     * of its own. A literal `'some_column',` inside a select argument is the
     * drift this test exists to refuse, and it still fails here.
     */
    for (const r of reads) {
      expect(r, `${r} does not read the one select list`).toContain('HAND_HISTORY_COLUMNS');
      expect(r, `${r} spells a column list of its own instead of the shared one`).not.toMatch(
        /'[a-z_]+'\s*,/
      );
    }
  });

  it('never derives the button from isButton alone', () => {
    // The floor is allowed to mention it; the primary read must be the column.
    const idx = SRC.indexOf('const buttonSeat');
    expect(idx).toBeGreaterThan(-1);
    const decl = sliceStatement(SRC, 'const buttonSeat');
    expect(decl).toContain('button_seat');
  });

  it('uses the shared derivation, not local modular arithmetic', () => {
    expect(CODE).toContain('derivePositions(');
    expect(CODE).not.toMatch(/\(seat - buttonSeat \+ playerCount\) % playerCount/);
  });

  it('rebuilds the per-player net instead of summing raise-to levels', () => {
    // buildResult used to sum actions[].amount, which double-counts every
    // re-raise because a raise carries the TO level for the street.
    expect(CODE).toContain('buildReplay(');
    expect(CODE).not.toMatch(/const invested = jsonbActions/);
  });
});

describe('derivePositions on the seating this platform actually uses', () => {
  it('is right where the old modular arithmetic was wrong', () => {
    // Six-handed, sparse seats, button on 8. The old formula computed
    // (seat - 8 + 6) % 6, which for seat 9 gives 1 -> "SB" and for seat 1
    // gives 5 -> a middle position. Neither is the real order.
    const seats = [1, 2, 3, 5, 8, 9];
    const pos = derivePositions(seats, 8);
    expect(pos).toEqual({
      8: 'BTN',
      9: 'SB',
      1: 'BB',
      2: 'UTG',
      3: 'MP',
      5: 'CO',
    });
  });

  it('returns nothing rather than guessing when the button is not seated', () => {
    expect(derivePositions([1, 3, 5], 7)).toEqual({});
  });

  it('gives the button the small blind heads up, as the real rule does', () => {
    expect(derivePositions([2, 6], 6)).toEqual({ 6: 'SB', 2: 'BB' });
  });
});
