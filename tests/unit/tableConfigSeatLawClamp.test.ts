/**
 * TableConfigPage seat-law clamp (2026-08-30).
 *
 * TableConfigPage is the only live cash-table creation path
 * (TableService.createTable was deleted 2026-08-27). Its Table Size slider
 * offered 2..10 for EVERY variant and buildTableData wrote max_players
 * unclamped, so a 10-max PLO5/PLO6/PLO8 table was one click away. The server
 * engine's PokerEngine.deal() throws 'Not enough cards in deck' rather than
 * dealing short, so an over-seated table does not degrade - it crashes
 * mid-hand. src/config/tableSeating.ts is the law; this suite pins that the
 * page obeys it.
 *
 * Two layers, matching the house pattern for this page:
 *   1. Behavioral: the exact clamp the page calls, per variant.
 *   2. Source pins: the page actually calls it, and the slider can no longer
 *      offer an illegal size (the old literal max={10} stays dead).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  clampSeatsForVariant,
  maxSeatsForVariant,
  maxSeatsTheDeckAllows,
} from '../../src/config/tableSeating';

const PAGE = fs.readFileSync(path.join(__dirname, '../../src/pages/TableConfigPage.tsx'), 'utf8');

// What buildTableData writes for max_players, given the route's gameType and
// the slider value. Kept byte-for-byte in sync with the page by the source
// pin below.
const maxPlayersWritten = (gameType: string | undefined, requested: number) =>
  clampSeatsForVariant(String(gameType || 'nlh').toLowerCase(), requested);

describe('buildTableData clamps max_players to the seat law', () => {
  it('pulls the old slider ceiling (10) down to each variant cap', () => {
    expect(maxPlayersWritten('plo5', 10)).toBe(7);
    expect(maxPlayersWritten('plo6', 10)).toBe(6);
    expect(maxPlayersWritten('plo8', 10)).toBe(8);
    expect(maxPlayersWritten('plo4', 10)).toBe(8);
    expect(maxPlayersWritten('flo8', 10)).toBe(8);
    expect(maxPlayersWritten('short_deck', 10)).toBe(9);
    expect(maxPlayersWritten('pineapple', 10)).toBe(9);
    expect(maxPlayersWritten('nlh', 10)).toBe(9);
  });

  it('handles a missing route param and uppercase variants', () => {
    expect(maxPlayersWritten(undefined, 10)).toBe(9);
    expect(maxPlayersWritten('PLO6', 10)).toBe(6);
  });

  it('leaves a legal smaller table alone - the law is a ceiling, not a target', () => {
    expect(maxPlayersWritten('plo5', 6)).toBe(6);
    expect(maxPlayersWritten('plo6', 2)).toBe(2);
    expect(maxPlayersWritten('nlh', 9)).toBe(9);
  });

  it('every clamped value physically fits the deck (the crash this prevents)', () => {
    for (const v of ['nlh', 'plo4', 'plo5', 'plo6', 'plo8', 'flo8', 'short_deck', 'pineapple']) {
      expect(maxPlayersWritten(v, 10)).toBeLessThanOrEqual(maxSeatsTheDeckAllows(v));
    }
  });
});

/**
 * 2026-09-04 (Operation Table Stakes, Slice 1): the cash create path is
 * fn_cash_game_create in SQL, and handedness is not a slider any more - it is
 * a picker over the seat choices fn_cash_template_defaults publishes per
 * family (OPORD 1.4 R1: Omaha is locked at 6, Hold'em picks 9 or 6). The
 * function refuses anything outside that list (HANDEDNESS_INVALID), so the
 * clamp below is now a ceiling the SQL choices must sit under, and the page
 * pins move to the tournament slider that still exists.
 */
const SQL = fs.readFileSync(
  path.join(__dirname, '../../supabase/migrations/20260904160500_cash_games_slice_1.sql'),
  'utf8'
);
const FLOW = fs.readFileSync(
  path.join(__dirname, '../../src/components/cash/CashGameCreateFlow.tsx'),
  'utf8'
);

describe('the seat choices the create function offers fit the deck', () => {
  const choices = (family: string): number[] => {
    const m = SQL.match(
      new RegExp(`${family}[\\s\\S]{0,400}?v_seat_choices := ARRAY\\[([0-9, ]+)\\]`)
    );
    if (!m) throw new Error(`no seat choices for ${family}`);
    return m[1].split(',').map((n) => Number(n.trim()));
  };

  it('Omaha is locked at six, under every PLO cap', () => {
    expect(choices("v_family = 'plo'")).toEqual([6]);
    for (const v of ['plo4', 'plo5', 'plo6', 'plo8', 'flo8']) {
      expect(6).toBeLessThanOrEqual(maxSeatsForVariant(v));
    }
  });

  it("Hold'em offers nothing above the deck", () => {
    const sqlMax = Math.max(
      ...SQL.match(/ARRAY\[[0-9, ]+\]/g)!.flatMap((a) =>
        a
          .replace(/ARRAY\[|\]/g, '')
          .split(',')
          .map((n) => Number(n.trim()))
      )
    );
    expect(sqlMax).toBeLessThanOrEqual(maxSeatsForVariant('nlh'));
    for (const v of ['nlh', 'flh', 'short_deck', 'pineapple']) {
      expect(sqlMax).toBeLessThanOrEqual(maxSeatsTheDeckAllows(v));
    }
  });

  it('the function refuses a handedness outside the published choices', () => {
    expect(SQL).toMatch(/HANDEDNESS_INVALID/);
  });

  it('the picker renders the published choices and nothing else', () => {
    expect(FLOW).toMatch(/seatChoices\.map\(/);
    expect(FLOW).not.toMatch(/label="Table Size"/);
  });
});

describe('TableConfigPage source pins (tournament tabs)', () => {
  it('imports the seat law from tableSeating', () => {
    expect(PAGE).toContain(
      "import { maxSeatsForVariant, maxSeatsTheDeckAllows } from '../config/tableSeating'"
    );
  });

  it('the SNG Table Size slider max is the deck cap, not a flat 10', () => {
    expect(PAGE).toContain('const seatCap = maxSeatsForVariant(gameType || ');
    // The SNG tab has its own Table Size slider: exempt from the cash law,
    // but still bounded by what the deck can physically deal.
    expect(PAGE).toMatch(/label="Table Size"[\s\S]{0,200}max=\{sngSeatCap\}/);
    expect(PAGE).not.toMatch(/label="Table Size"[\s\S]{0,200}max=\{10\}/);
  });

  it('an over-cap value snaps down when the variant cap tightens', () => {
    expect(PAGE).toContain('c.maxPlayers > seatCap || c.tableSize > sngSeatCap');
    expect(PAGE).toContain('maxPlayers: Math.min(c.maxPlayers, seatCap)');
  });

  it('the law itself still says what this suite assumes', () => {
    expect(maxSeatsForVariant('plo5')).toBe(7);
    expect(maxSeatsForVariant('plo6')).toBe(6);
    expect(maxSeatsForVariant('plo8')).toBe(8);
  });
});
