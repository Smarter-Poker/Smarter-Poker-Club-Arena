/**
 * Regression tests for the Club Settings rules.
 *
 * Every case here corresponds to a bug that actually shipped on this surface
 * (audit: .agent/audits/2026-08-19-club-settings-page-audit.md).
 */
import { describe, it, expect } from 'vitest';
import {
  BUYIN_BB_CEILING,
  BUYIN_BB_FLOOR,
  CLUB_NAME_MAX,
  WATCHED_COLUMNS,
  clampBuyin,
  CSV_BOM,
  csvSafeCell,
  sanitizationWouldAlter,
  toCSV,
  validateBuyinRange,
  validateClubName,
} from '../../src/utils/clubSettingsRules';

describe('clampBuyin', () => {
  it('keeps in-range values untouched', () => {
    expect(clampBuyin(40, BUYIN_BB_FLOOR)).toBe(40);
    expect(clampBuyin(200, BUYIN_BB_CEILING)).toBe(200);
  });

  it('clamps to the floor and the ceiling', () => {
    expect(clampBuyin(0, BUYIN_BB_FLOOR)).toBe(BUYIN_BB_FLOOR);
    expect(clampBuyin(-5, BUYIN_BB_FLOOR)).toBe(BUYIN_BB_FLOOR);
    expect(clampBuyin(99999, BUYIN_BB_CEILING)).toBe(BUYIN_BB_CEILING);
  });

  it('falls back for the empty field (NaN) instead of snapping mid-edit', () => {
    // The bug: clamping on every keystroke turned a backspaced-empty field
    // into 1000, so the value could not be retyped.
    expect(clampBuyin(NaN, BUYIN_BB_CEILING)).toBe(BUYIN_BB_CEILING);
    expect(clampBuyin(NaN, BUYIN_BB_FLOOR)).toBe(BUYIN_BB_FLOOR);
  });
});

describe('validateBuyinRange', () => {
  it('accepts a sane range', () => {
    expect(validateBuyinRange(40, 200)).toBeNull();
  });

  it('rejects an inverted or degenerate range', () => {
    expect(validateBuyinRange(200, 40)).toMatch(/greater than the minimum/);
    expect(validateBuyinRange(100, 100)).toMatch(/greater than the minimum/);
  });

  it('rejects out-of-bounds values', () => {
    expect(validateBuyinRange(0, 200)).toMatch(/at least/);
    expect(validateBuyinRange(40, BUYIN_BB_CEILING + 1)).toMatch(/cannot exceed/);
  });

  it('rejects a half-typed (NaN) field so the save is blocked', () => {
    expect(validateBuyinRange(NaN, 200)).toMatch(/must be numbers/);
    expect(validateBuyinRange(40, NaN)).toMatch(/must be numbers/);
  });
});

describe('csvSafeCell', () => {
  it('neutralises formula-injection strings', () => {
    expect(csvSafeCell('=1+1')).toBe(JSON.stringify("'=1+1"));
    expect(csvSafeCell('+cmd')).toBe(JSON.stringify("'+cmd"));
    expect(csvSafeCell('@SUM(A1)')).toBe(JSON.stringify("'@SUM(A1)"));
    expect(csvSafeCell('-2+3+cmd')).toBe(JSON.stringify("'-2+3+cmd"));
  });

  it('leaves negative NUMBERS alone', () => {
    // The bug: the guard tested the stringified value, so every negative
    // number (chips_lost, net) was quoted as a formula and corrupted.
    expect(csvSafeCell(-5)).toBe('-5');
    expect(csvSafeCell(-12345.67)).toBe('-12345.67');
    expect(csvSafeCell(0)).toBe('0');
  });

  it('renders null/undefined as an empty string', () => {
    expect(csvSafeCell(null)).toBe('""');
    expect(csvSafeCell(undefined)).toBe('""');
  });
});

describe('toCSV', () => {
  it('returns empty string for no rows', () => {
    expect(toCSV([])).toBe('');
  });

  it('writes a header row and preserves negative numbers', () => {
    const csv = toCSV([
      { player: 'Dan', chips_won: 100, chips_lost: -250 },
      { player: 'Ann', chips_won: 0, chips_lost: -1 },
    ]);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('player,chips_won,chips_lost');
    expect(lines[1]).toBe('"Dan",100,-250');
    expect(lines[2]).toBe('"Ann",0,-1');
  });
});

describe('WATCHED_COLUMNS', () => {
  it('covers every editable settings column and no hot-path column', () => {
    expect(WATCHED_COLUMNS).toContain('name');
    expect(WATCHED_COLUMNS).toContain('default_rake_percent');
    expect(WATCHED_COLUMNS).toContain('max_buyin_bb');
    // chip_pool / member_count are rewritten constantly by the engine and the
    // membership trigger; reacting to them refetched the page nonstop.
    expect(WATCHED_COLUMNS).not.toContain('chip_pool');
    expect(WATCHED_COLUMNS).not.toContain('member_count');
  });
});

describe('validateClubName', () => {
  it('accepts a normal name', () => {
    expect(validateClubName('Midway Union')).toBeNull();
  });

  it('rejects empty and whitespace-only names', () => {
    // The bug: clubs.name is NOT NULL but has no CHECK against '', and the
    // page had no validation — a blank name saved fine, and then armed the
    // delete confirmation with an empty input box.
    expect(validateClubName('')).toMatch(/cannot be empty/);
    expect(validateClubName('   ')).toMatch(/cannot be empty/);
  });

  it('rejects a name that is empty only AFTER sanitising', () => {
    expect(validateClubName('<b></b>', '')).toMatch(/cannot be empty/);
  });

  it('rejects an over-long name', () => {
    expect(validateClubName('x'.repeat(CLUB_NAME_MAX + 1))).toMatch(/cannot exceed/);
    expect(validateClubName('x'.repeat(CLUB_NAME_MAX))).toBeNull();
  });
});

describe('sanitizationWouldAlter', () => {
  it('detects silent stripping', () => {
    expect(sanitizationWouldAlter('Friday <8pm>', 'Friday')).toBe(true);
  });

  it('ignores pure whitespace differences', () => {
    expect(sanitizationWouldAlter('  Midway  ', 'Midway')).toBe(false);
  });
});

describe('CSV_BOM', () => {
  it('is the UTF-8 byte order mark Excel needs', () => {
    // Declared in pass 5 but never imported anywhere — a live stub. Wired
    // into the CSV download in pass 6; this pins the value.
    expect(CSV_BOM).toBe('\ufeff');
    expect(CSV_BOM).toHaveLength(1);
  });

  it('prefixes a CSV without disturbing the header row', () => {
    const csv = CSV_BOM + toCSV([{ player: 'José', hands_played: 12 }]);
    expect(csv.startsWith('\ufeff')).toBe(true);
    expect(csv.slice(1).split('\n')[0]).toBe('player,hands_played');
  });
});
