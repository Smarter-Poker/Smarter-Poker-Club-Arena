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
import { holeCardCount, deckSizeFor, maxSeatsFor } from '../engine/VariantRules.js';
import { sliceEnclosingBlock } from '../testHelpers/sourceWindow.js';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const BASE = read('src/tournament/TournamentManagerBase.ts');
const MANAGER = read('src/tournament/TournamentManager.ts');
const DEALING = read('src/engine/ServerTableEngineDealing.ts');
const CAPACITY_SQL = read(
  '../supabase/migrations/20260907204500_late_registration_can_build_its_first_table.sql'
);

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

/**
 * 2026-08-31: THE TOURNAMENT CEILING IS THE DECK, NOT THE CASH SEAT LAW.
 *
 * These three assertions used to pin `clampSeatsForVariant` — the CASH seat
 * law — into both tournament paths. That law is deliberately tighter than the
 * deck so Run It Twice keeps three boards (PLO6 dies at 7 seats: 52 - 6n >= 15
 * gives n <= 6), and Run It Twice is hard-disabled on a tournament table
 * (ServerTableEngineBase: `ritIsTournament` forces `ritEnabled` false). So the
 * tournament was paying a seat for a board it can never be dealt, on a law
 * whose own header reads "CASH GAMES ONLY ... Nothing here may be applied to a
 * table with a tournament_id".
 *
 * The ORDERING assertion is kept exactly as it was — the ceiling must still be
 * applied LAST, after every format branch, or table_size wins. Only the
 * function it is applied with has changed.
 */
describe('tournament tables are built through the DECK ceiling', () => {
  it('createTablesAndSeatPlayers caps seats at what the deck can serve', () => {
    const src = code(BASE);
    expect(src).toContain('maxSeatsTheDeckAllows');
    // the cap must be applied AFTER the table_size branch, or table_size wins
    const capAt = src.indexOf('maxSeatsTheDeckAllows(seatVariant)');
    const sizeAt = src.indexOf('Number(tournament.table_size)');
    expect(capAt).toBeGreaterThan(-1);
    expect(capAt).toBeGreaterThan(sizeAt);
  });

  it('the expansion path caps too, so a new table is dealable as well', () => {
    expect(code(MANAGER)).toContain("'fn_ensure_late_registration_capacity'");
    expect(CAPACITY_SQL).toContain('floor((deck - 5 board cards) / hole cards)');
    expect(CAPACITY_SQL).toMatch(/WHEN 'plo5' THEN 9\s*WHEN 'plo6' THEN 7/);
  });

  it('neither tournament path can reach the cash seat law any more', () => {
    // Not "does not call it" — does not IMPORT it. The cash cap must be
    // unreachable from a tournament path, not merely unused today.
    expect(code(BASE)).not.toContain('clampSeatsForVariant');
    expect(code(MANAGER)).not.toContain('clampSeatsForVariant');
    expect(code(BASE)).not.toContain('config/tableSeating');
    expect(code(MANAGER)).not.toContain('config/tableSeating');
    expect(CAPACITY_SQL).not.toContain('clampSeatsForVariant');
  });
});

describe('a tournament seats what the deck allows, never less, never more', () => {
  /** The ceiling the two tournament paths apply, in one place. */
  const tournamentCeiling = (variant: string, requested: number) =>
    Math.min(requested, maxSeatsFor(variant));

  it('is the exact expression the engine uses, in both paths', () => {
    expect(code(BASE)).toContain('Math.min(maxPerTable, maxSeatsTheDeckAllows(seatVariant))');
    expect(code(MANAGER)).toContain('Math.min(');
  });

  it('seats a PLO6 tournament table 7', () => {
    // 7 x 6 hole cards = 42, plus a 5-card board = 47 of 52. An eighth seat
    // needs 53. The cash law says 6 and stays saying 6.
    expect(tournamentCeiling('plo6', 10)).toBe(7);
    expect(7 * holeCardCount('plo6') + 5).toBeLessThanOrEqual(deckSizeFor('plo6'));
    expect(8 * holeCardCount('plo6') + 5).toBeGreaterThan(deckSizeFor('plo6'));
  });

  it('seats a PLO5 tournament table 9', () => {
    expect(tournamentCeiling('plo5', 10)).toBe(9);
    expect(9 * holeCardCount('plo5') + 5).toBeLessThanOrEqual(deckSizeFor('plo5'));
    expect(10 * holeCardCount('plo5') + 5).toBeGreaterThan(deckSizeFor('plo5'));
  });

  it('never seats a tournament past what its deck can deal, at any request', () => {
    for (const v of [
      'nlh',
      'flh',
      'short_deck',
      'pineapple',
      'plo4',
      'plo5',
      'plo6',
      'plo8',
      'flo8',
    ]) {
      for (let requested = 2; requested <= 30; requested++) {
        const seats = tournamentCeiling(v, requested);
        expect(
          seats * holeCardCount(v) + 5,
          `${v}: asked ${requested}, got ${seats} seats x ${holeCardCount(v)} + 5 board`
        ).toBeLessThanOrEqual(deckSizeFor(v));
      }
    }
  });

  it('leaves a smaller table alone, so a 3-max Spin stays 3-max', () => {
    expect(tournamentCeiling('nlh', 3)).toBe(3);
    expect(tournamentCeiling('plo6', 6)).toBe(6);
  });

  it('is never TIGHTER than the cash law it replaced', () => {
    // The whole point: the cash cap was costing tournaments seats the deck
    // could serve. plo4 8 -> 11, plo5 7 -> 9, plo6 6 -> 7, plo8 8 -> 11,
    // nlh 9 -> 23 (so a table_size 10 NLH MTT keeps its tenth seat).
    for (const v of ['nlh', 'flh', 'plo4', 'plo5', 'plo6', 'plo8', 'flo8', 'short_deck']) {
      expect(maxSeatsFor(v), v).toBeGreaterThanOrEqual(maxSeatsForVariant(v));
    }
    expect(maxSeatsFor('plo4')).toBe(11);
    expect(maxSeatsFor('plo5')).toBe(9);
    expect(maxSeatsFor('plo6')).toBe(7);
    expect(maxSeatsFor('plo8')).toBe(11);
    expect(maxSeatsFor('flo8')).toBe(11);
    expect(maxSeatsFor('nlh')).toBe(23);
    expect(maxSeatsFor('short_deck')).toBe(15);
    expect(maxSeatsFor('pineapple')).toBe(15);
  });

  it('does not move the cash cap while doing it', () => {
    // tests/table-seating-caps.test.ts is the real pin on this; repeated here
    // so a change to the tournament ceiling that also moved the cash law
    // fails in the file that changed it.
    expect(maxSeatsForVariant('plo6')).toBe(6);
    expect(maxSeatsForVariant('plo5')).toBe(7);
    expect(maxSeatsForVariant('plo4')).toBe(8);
    expect(clampSeatsForVariant('plo6', 9)).toBe(6);
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
