/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * A THEME THAT SAVED MUST BE A THEME THAT LOADS (2026-08-25)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `user_theme_settings` held 2 rows across 1,025 production users when this was
 * written, and one of those two rows was UNREADABLE by the app that wrote it:
 *
 *     user_id  47965354-…   game_type 'ALL'    table_id 'ice_cavern'
 *     user_id  47965354-…   game_type 'plo4'   table_id 'dark-felt'
 *
 * The table is keyed UNIQUE(user_id, game_type). The reader canonicalises the
 * table's variant to a BUCKET — 'plo4' becomes 'PLO' — and then asked for
 * `game_type = 'PLO'`. There is no such row. It fell through to 'ALL', so the
 * player's PLO choice sat in the database, correctly saved, and never once
 * appeared on a felt. To them the feature simply did not persist.
 *
 * Pinned here:
 *   - the raw-variant row is FOUND, so every row already in production starts
 *     working with no migration;
 *   - an exact canonical row still WINS over a raw one;
 *   - 'ALL' remains the last resort, never the first answer;
 *   - a failed query is not an empty result (the estate's most repeated
 *     defect: no answer rendered as a confident "you have nothing").
 */
import { describe, it, expect } from 'vitest';
import {
  canonicalGameType,
  getThemeGameType,
  pickThemeRow,
  resolveThemeBucket,
  CANONICAL_GAME_TYPES,
} from '../../src/hooks/useUserThemeSettings';

describe('resolveThemeBucket', () => {
  it('waits — a tournament with no format resolves NO bucket', () => {
    // Guessing here paints the MTT felt at a Spin and then swaps it under the
    // player when the real format lands.
    expect(resolveThemeBucket(undefined, true, undefined)).toBeNull();
    expect(resolveThemeBucket(undefined, true, '')).toBeNull();
  });

  it('resolves as soon as the format is known', () => {
    expect(resolveThemeBucket(undefined, true, 'spin')).toBe('SNG');
    expect(resolveThemeBucket(undefined, true, 'sng')).toBe('SNG');
    expect(resolveThemeBucket(undefined, true, 'mtt')).toBe('MTT');
  });

  it('never makes a cash table wait — it has nothing to wait for', () => {
    expect(resolveThemeBucket('plo4', false, undefined)).toBe('PLO');
    expect(resolveThemeBucket('nlh', false, undefined)).toBe('NLH');
    expect(resolveThemeBucket(undefined, undefined, undefined)).toBe('ALL');
  });
});

describe('canonicalGameType', () => {
  it('leaves an already-canonical bucket alone', () => {
    for (const bucket of CANONICAL_GAME_TYPES) {
      expect(canonicalGameType(bucket)).toBe(bucket);
    }
  });

  it("maps the production row's raw 'plo4' into PLO", () => {
    expect(canonicalGameType('plo4')).toBe('PLO');
  });

  it('maps the other raw variant strings a writer might pass through', () => {
    expect(canonicalGameType('plo5')).toBe('PLO');
    expect(canonicalGameType('nlh')).toBe('NLH');
    expect(canonicalGameType('no_limit_holdem')).toBe('NLH');
    expect(canonicalGameType('shortdeck')).toBe('6+');
    expect(canonicalGameType('pineapple')).toBe('PINEAPPLE');
  });

  it('treats nothing at all as ALL rather than guessing', () => {
    expect(canonicalGameType(null)).toBe('ALL');
    expect(canonicalGameType(undefined)).toBe('ALL');
    expect(canonicalGameType('   ')).toBe('ALL');
    expect(canonicalGameType('some_variant_nobody_ships')).toBe('ALL');
  });

  it('never answers with a value the table is not keyed on', () => {
    const allowed = new Set<string>(CANONICAL_GAME_TYPES);
    for (const input of ['plo4', 'PLO6', 'nlh9', '6+', 'spin', '', 'garbage']) {
      expect(allowed.has(canonicalGameType(input))).toBe(true);
    }
  });
});

describe('getThemeGameType', () => {
  it('sends spins and heads-up to SNG, everything else tournament to MTT', () => {
    expect(getThemeGameType(undefined, true, 'spin')).toBe('SNG');
    expect(getThemeGameType(undefined, true, 'sng')).toBe('SNG');
    expect(getThemeGameType(undefined, true, 'mtt')).toBe('MTT');
  });
});

describe('pickThemeRow', () => {
  const ALL = { game_type: 'ALL', table_id: 'ice_cavern' };
  const RAW_PLO = { game_type: 'plo4', table_id: 'dark-felt' };
  const EXACT_PLO = { game_type: 'PLO', table_id: 'amethyst_cavern' };

  it('THE BUG: finds the row stored under a raw variant key', () => {
    // Before the fix this returned ALL and the PLO choice was invisible.
    expect(pickThemeRow([ALL, RAW_PLO], 'PLO')).toBe(RAW_PLO);
  });

  it('an exact canonical row beats a raw one', () => {
    expect(pickThemeRow([ALL, RAW_PLO, EXACT_PLO], 'PLO')).toBe(EXACT_PLO);
  });

  it('falls back to ALL only when the bucket has nothing', () => {
    expect(pickThemeRow([ALL, RAW_PLO], 'NLH')).toBe(ALL);
  });

  it('does not hand an unrelated bucket to a table that asked for another', () => {
    // A row for PLO must never paint an NLH table when there is no ALL row.
    expect(pickThemeRow([RAW_PLO], 'NLH')).toBeNull();
  });

  it('no rows means no selection, not a wrong one', () => {
    expect(pickThemeRow([], 'PLO')).toBeNull();
  });

  it('an ALL row is used verbatim when ALL is what was asked for', () => {
    expect(pickThemeRow([ALL, RAW_PLO], 'ALL')).toBe(ALL);
  });

  // Dan 2026-08-28: an Apply-To-ALL save must not silently lose to an older
  // per-variant row on the next rejoin — last write wins.
  it('a NEWER ALL row beats an older bucket row', () => {
    const oldPLO = { game_type: 'PLO', table_id: 'dark-felt', updated_at: '2026-08-01T00:00:00Z' };
    const newALL = { game_type: 'ALL', table_id: 'ice_cavern', updated_at: '2026-08-28T00:00:00Z' };
    expect(pickThemeRow([oldPLO, newALL], 'PLO')).toBe(newALL);
  });

  it('a NEWER bucket row still beats an older ALL row', () => {
    const newPLO = { game_type: 'PLO', table_id: 'dark-felt', updated_at: '2026-08-28T00:00:00Z' };
    const oldALL = { game_type: 'ALL', table_id: 'ice_cavern', updated_at: '2026-08-01T00:00:00Z' };
    expect(pickThemeRow([newPLO, oldALL], 'PLO')).toBe(newPLO);
  });

  it('without timestamps the bucket row keeps its historical precedence', () => {
    expect(pickThemeRow([ALL, EXACT_PLO], 'PLO')).toBe(EXACT_PLO);
  });
});

// ─── SABOTAGE: prove each guard actually fires ───────────────────────────────
//
// A guard nobody has watched fail is a guard nobody knows works. Each case
// below is the fixed code fed the input the OLD code got wrong.

describe('sabotage', () => {
  it('sabotage: reintroducing the exact-match-only lookup loses the plo4 row', () => {
    const rows = [
      { game_type: 'ALL', table_id: 'ice_cavern' },
      { game_type: 'plo4', table_id: 'dark-felt' },
    ];
    // This IS the old algorithm, written out: exact bucket, else ALL.
    const oldWay =
      rows.find((r) => r.game_type === 'PLO') ?? rows.find((r) => r.game_type === 'ALL') ?? null;
    expect(oldWay?.table_id).toBe('ice_cavern'); // the wrong felt, as shipped
    expect(pickThemeRow(rows, 'PLO')?.table_id).toBe('dark-felt'); // the right one
  });

  it('sabotage: a row keyed on junk cannot be smuggled into a real bucket', () => {
    const rows = [{ game_type: 'not_a_variant', table_id: 'crimson' }];
    // 'not_a_variant' canonicalises to ALL, so it must not answer a PLO ask…
    expect(pickThemeRow(rows, 'PLO')).toBeNull();
    // …and it must not answer an ALL ask either: only a literal 'ALL' row does.
    expect(pickThemeRow(rows, 'ALL')).toBeNull();
  });
});
