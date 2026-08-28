/**
 * A TOURNAMENT TABLE MUST BE DEALABLE (2026-08-25).
 *
 * Tournament tables were built from `table_size` verbatim, and table_size knows
 * nothing about how many hole cards the game deals. A 9-handed PLO6 table needs
 * 9 x 6 = 54 hole cards plus a 5-card board out of 52. It can never be dealt.
 *
 * The engine refused correctly and then slept without marking progress, so the
 * watchdog read a deliberate refusal as a wedged loop and restarted the whole
 * engine - every table on the instance - to cure one table that would refuse
 * again immediately.
 *
 * Measured live before the fix: 58 of 70 PLO6 tournament tables were seated
 * beyond their deck's ceiling, and never-dealt rates were PLO6 36.5% and PLO5
 * 35.9% against NLH 22.3%.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { clampSeatsForVariant, maxSeatsForVariant } from '../config/tableSeating.js';
import { holeCardCount, deckSizeFor } from '../engine/VariantRules.js';
import { sliceEnclosingBlock } from '../testHelpers/sourceWindow.js';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const BASE = read('src/tournament/TournamentManagerBase.ts');
const MANAGER = read('src/tournament/TournamentManager.ts');
const DEALING = read('src/engine/ServerTableEngineDealing.ts');

describe('the seat law is arithmetic, not preference', () => {
  it('every variant cap leaves enough cards for its own board', () => {
    for (const v of ['nlh', 'plo4', 'plo5', 'plo6', 'plo8', 'flo8', 'short_deck', 'pineapple']) {
      const seats = maxSeatsForVariant(v);
      const needed = seats * holeCardCount(v) + 5;
      expect(
        needed,
        `${v}: ${seats} seats x ${holeCardCount(v)} cards + 5 board = ${needed} > ${deckSizeFor(v)}`
      ).toBeLessThanOrEqual(deckSizeFor(v));
    }
  });

  it('a 9-handed PLO6 table is refused by the clamp, because it cannot be dealt', () => {
    expect(clampSeatsForVariant('plo6', 9)).toBeLessThanOrEqual(7);
    expect(clampSeatsForVariant('plo6', 9) * 6 + 5).toBeLessThanOrEqual(52);
  });
});

describe('tournament tables are built through the clamp', () => {
  it('createTablesAndSeatPlayers clamps seats to what the deck can serve', () => {
    const src = code(BASE);
    expect(src).toContain('clampSeatsForVariant');
    // the clamp must be applied AFTER the table_size branch, or table_size wins
    const clampAt = src.indexOf('clampSeatsForVariant(seatVariant');
    const sizeAt = src.indexOf('Number(tournament.table_size)');
    expect(clampAt).toBeGreaterThan(sizeAt);
  });

  it('the expansion path clamps too, so a new table is dealable as well', () => {
    expect(code(MANAGER)).toContain('clampSeatsForVariant');
  });
});

describe('a deliberate refusal must not read as a wedged loop', () => {
  it('the deck-capacity guard marks progress before it sleeps', () => {
    const src = code(DEALING);
    const guardAt = src.indexOf('deck_capacity_exceeded');
    expect(guardAt).toBeGreaterThan(-1);
    const window = sliceEnclosingBlock(src, 'deck_capacity_exceeded');
    // markProgress must come BEFORE the sleep, or the watchdog kills the engine
    const progressAt = window.indexOf('this.markProgress()');
    const sleepAt = window.indexOf('this.sleep(30000)');
    expect(progressAt).toBeGreaterThan(-1);
    expect(sleepAt).toBeGreaterThan(-1);
    expect(progressAt).toBeLessThan(sleepAt);
  });
});
