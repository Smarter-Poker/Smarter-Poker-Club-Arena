/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A FIELD ECHO REPORTS WHAT CHANGED, NOT THE WHOLE ROW
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two PostgresSyncHooks mirrors decided what to publish by diffing the new row
 * against `payload.old`:
 *
 *   user_theme_settings   REPLICA IDENTITY DEFAULT, primary key `id`. Postgres
 *                         puts only the replica identity columns in the old
 *                         tuple, so the old row is `{ id }`. Unambiguous.
 *   user_table_settings   REPLICA IDENTITY FULL, primary key `user_id`, RLS on.
 *                         Supabase documents that an RLS-enabled table sends
 *                         the primary key alone regardless.
 *
 * Either way `previous[field]` is `undefined` and every comparison is true.
 * `legacyChanged` below is that code, copied, so the regression is demonstrated
 * rather than asserted.
 *
 * The values were never wrong — `payload.new` is a complete post image — the
 * repaint was. `useDeckStyle` invalidates its cache on ANY `SETTINGS_CHANGED`,
 * and user_table_settings mirrors 48 columns one event at a time.
 */
import { describe, it, expect } from 'vitest';
import {
  decideFieldEcho,
  readEchoFields,
  acceptNonEmptyString,
  acceptScalar,
  type EchoFields,
} from '../../src/services/realtimeFieldEcho';

const THEME_COLUMNS = ['theme_id', 'table_id', 'button_id', 'background_id', 'cards_id'] as const;

const themeRow = {
  id: 'row-1',
  user_id: 'user-1',
  game_type: 'NLH',
  theme_id: 'midnight',
  table_id: 'felt-green',
  button_id: 'button-gold',
  background_id: 'bg-city',
  cards_id: 'deck-classic',
  updated_at: '2026-09-20T00:00:00.000Z',
};

/** The comparison that shipped, reproduced exactly. `previous` is `payload.old`. */
function legacyChanged(
  row: Record<string, unknown>,
  previous: Record<string, unknown>,
  columns: readonly string[]
): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  for (const field of columns) {
    if (typeof row[field] === 'string' && row[field] && row[field] !== previous[field]) {
      value[field] = row[field];
    }
  }
  return value;
}

/** What production actually delivers for these tables: the primary key alone. */
const OLD_ROW_AS_DELIVERED = { id: 'row-1' };

describe('the old row these tables deliver', () => {
  it('carries the primary key and none of the mirrored columns', () => {
    for (const field of THEME_COLUMNS) {
      expect(OLD_ROW_AS_DELIVERED).not.toHaveProperty(field);
    }
  });

  it('REGRESSION: the shipped comparison called every field changed', () => {
    // Nothing changed at all — this is a bare `updated_at` touch.
    const changed = legacyChanged(themeRow, OLD_ROW_AS_DELIVERED, THEME_COLUMNS);
    expect(Object.keys(changed).sort()).toEqual([...THEME_COLUMNS].sort());
    // And so the deck cache was dropped for a change to nothing.
    expect(changed.cards_id).toBe('deck-classic');
  });
});

describe('decideFieldEcho — the theme mirror', () => {
  const theme = (row: Record<string, unknown>, remembered: EchoFields | undefined) =>
    decideFieldEcho({ row, columns: THEME_COLUMNS, accept: acceptNonEmptyString, remembered });

  it('a first sighting is news: everything is changed', () => {
    const { changed, seed } = theme(themeRow, undefined);
    expect(Object.keys(changed).sort()).toEqual([...THEME_COLUMNS].sort());
    expect(seed).toEqual(changed);
  });

  it('an update that changed nothing emits nothing', () => {
    const remembered = readEchoFields(themeRow, THEME_COLUMNS, acceptNonEmptyString);
    expect(theme({ ...themeRow }, remembered).changed).toEqual({});
  });

  it('a bare updated_at touch emits nothing', () => {
    const remembered = readEchoFields(themeRow, THEME_COLUMNS, acceptNonEmptyString);
    const touched = { ...themeRow, updated_at: '2026-09-20T00:05:00.000Z' };
    expect(theme(touched, remembered).changed).toEqual({});
  });

  it('changing only the felt does NOT report the card back', () => {
    const remembered = readEchoFields(themeRow, THEME_COLUMNS, acceptNonEmptyString);
    const { changed } = theme({ ...themeRow, table_id: 'felt-blue' }, remembered);
    expect(changed).toEqual({ table_id: 'felt-blue' });
    // The whole point: no cards_id means no SETTINGS_CHANGED, means the deck
    // cache survives and the cards on the table do not re-render.
    expect(changed.cards_id).toBeUndefined();
  });

  it('changing the card back DOES report it', () => {
    const remembered = readEchoFields(themeRow, THEME_COLUMNS, acceptNonEmptyString);
    expect(theme({ ...themeRow, cards_id: 'deck-neon' }, remembered).changed).toEqual({
      cards_id: 'deck-neon',
    });
  });

  it('reports several fields when several moved', () => {
    const remembered = readEchoFields(themeRow, THEME_COLUMNS, acceptNonEmptyString);
    const { changed } = theme(
      { ...themeRow, cards_id: 'deck-neon', button_id: 'button-steel' },
      remembered
    );
    expect(changed).toEqual({ cards_id: 'deck-neon', button_id: 'button-steel' });
  });

  it('the seed is the full row even when nothing changed, so the next update compares correctly', () => {
    const remembered = readEchoFields(themeRow, THEME_COLUMNS, acceptNonEmptyString);
    const first = theme(themeRow, remembered);
    expect(first.changed).toEqual({});
    expect(theme({ ...themeRow, theme_id: 'dawn' }, first.seed).changed).toEqual({
      theme_id: 'dawn',
    });
  });

  it('a field cleared to null is not reported, and the cleared slot can be refilled', () => {
    const remembered = readEchoFields(themeRow, THEME_COLUMNS, acceptNonEmptyString);
    const { changed, seed } = theme({ ...themeRow, background_id: null }, remembered);
    expect(changed).toEqual({});
    expect(seed.background_id).toBeUndefined();
    expect(theme({ ...themeRow, background_id: 'bg-beach' }, seed).changed).toEqual({
      background_id: 'bg-beach',
    });
  });

  it('ignores a missing row, and non-string or empty values', () => {
    expect(decideFieldEcho({ row: null, columns: THEME_COLUMNS, remembered: {} }).changed).toEqual(
      {}
    );
    const remembered = readEchoFields(themeRow, THEME_COLUMNS, acceptNonEmptyString);
    const { changed } = theme(
      { ...themeRow, theme_id: '', button_id: 42, background_id: { a: 1 } },
      remembered
    );
    expect(changed).toEqual({});
  });
});

/**
 * The 48-column mirror. Its accepted types are wider — a setting may be a
 * boolean or a number, and `false` and `0` are real values that must survive a
 * round trip. It is also the one whose over-fire actually hurt: one toggle
 * produced one SETTINGS_CHANGED per mirrored column.
 */
describe('decideFieldEcho — the table-settings mirror', () => {
  const COLUMNS = ['show_avatars', 'sound_volume', 'color_theme', 'four_color_deck'] as const;
  const row = {
    user_id: 'user-1',
    show_avatars: true,
    sound_volume: 0.8,
    color_theme: 'dark',
    four_color_deck: false,
    updated_at: '2026-09-20T00:00:00.000Z',
  };
  const settings = (r: Record<string, unknown>, remembered: EchoFields | undefined) =>
    decideFieldEcho({ row: r, columns: COLUMNS, remembered });

  it('keeps false and zero, which are real settings values', () => {
    const { seed } = settings(row, undefined);
    expect(seed.four_color_deck).toBe(false);
    expect(readEchoFields({ sound_volume: 0 }, ['sound_volume'], acceptScalar)).toEqual({
      sound_volume: 0,
    });
  });

  it('one toggle is one event, not forty-eight', () => {
    const remembered = readEchoFields(row, COLUMNS);
    const { changed } = settings({ ...row, show_avatars: false }, remembered);
    expect(Object.keys(changed)).toEqual(['show_avatars']);
    expect(changed.show_avatars).toBe(false);

    // What the shipped code would have emitted for the same update.
    const legacyCount = COLUMNS.filter((c) => {
      const v = { ...row, show_avatars: false }[c as keyof typeof row];
      return v !== undefined && v !== (OLD_ROW_AS_DELIVERED as Record<string, unknown>)[c];
    }).length;
    expect(legacyCount).toBe(COLUMNS.length);
    expect(Object.keys(changed).length).toBeLessThan(legacyCount);
  });

  it('turning a setting back on is reported, not swallowed by the memory', () => {
    const remembered = readEchoFields(row, COLUMNS);
    const off = settings({ ...row, show_avatars: false }, remembered);
    expect(off.changed).toEqual({ show_avatars: false });
    expect(settings(row, off.seed).changed).toEqual({ show_avatars: true });
  });

  it('a bare updated_at touch emits nothing at all', () => {
    const remembered = readEchoFields(row, COLUMNS);
    expect(
      settings({ ...row, updated_at: '2026-09-20T01:00:00.000Z' }, remembered).changed
    ).toEqual({});
  });

  it('an INSERT is a first sighting and reports the whole row', () => {
    const { changed } = settings(row, undefined);
    expect(Object.keys(changed).sort()).toEqual([...COLUMNS].sort());
  });
});

describe('the decision never consults the old row', () => {
  it('takes no old row at all, so it cannot depend on one', () => {
    const remembered = readEchoFields(themeRow, THEME_COLUMNS, acceptNonEmptyString);
    const moved = { ...themeRow, table_id: 'felt-blue' };
    const decision = decideFieldEcho({
      row: moved,
      columns: THEME_COLUMNS,
      accept: acceptNonEmptyString,
      remembered,
    });
    expect(decision.changed).toEqual({ table_id: 'felt-blue' });
    // And unlike the shipped code, it does not call an unchanged row changed.
    expect(legacyChanged(moved, OLD_ROW_AS_DELIVERED, THEME_COLUMNS)).not.toEqual(decision.changed);
  });
});
