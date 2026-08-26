/**
 * APPEARANCE CHANGES REACH THE FELT, OR SAY WHY NOT.
 *
 * Dan 2026-08-26: "if a user changes their avatar, deck color, table,
 * background, button or anything else... it needs to change, save and update
 * in real time on the felt."
 *
 * Before this, FOUR surfaces wrote table appearance and each did it its own
 * way. One of them (HamburgerMenu) SELECTed the whole row and spread it back
 * into the upsert, re-sending generated columns; one of them (/settings "Card
 * Back Style") wrote a key the felt reads only as an unreachable fallback, so
 * it was decorative. These tests pin the single writer that replaced them.
 *
 * What matters, in order:
 *   1. the felt is told BEFORE the network — the repaint must not wait on a
 *      round trip;
 *   2. only the columns being changed are written — never a whole row;
 *   3. a rejected write PUTS THE FELT BACK, because a table showing a choice
 *      the database refused is worse than one that never changed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const emit = vi.fn();
const upsert = vi.fn();

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: (...args: unknown[]) => emit(...args),
  },
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({ upsert: (...args: unknown[]) => upsert(...args) }),
  },
}));

import { applyTableAppearance } from '../../src/lib/applyTableAppearance';

beforeEach(() => {
  emit.mockClear();
  upsert.mockReset();
  upsert.mockResolvedValue({ error: null });
});

const emitsOf = (name: string) => emit.mock.calls.filter((c) => c[0] === name).map((c) => c[1]);

describe('the felt repaints before the network', () => {
  it('emits UI_THEME_CHANGED first, then writes', async () => {
    const order: string[] = [];
    emit.mockImplementation((n: string) => order.push(`emit:${n}`));
    upsert.mockImplementation(() => {
      order.push('upsert');
      return Promise.resolve({ error: null });
    });

    await applyTableAppearance({ table_id: 'neon_city' }, { userId: 'u1' });

    expect(order[0]).toBe('emit:UI_THEME_CHANGED');
    expect(order).toContain('upsert');
    expect(order.indexOf('emit:UI_THEME_CHANGED')).toBeLessThan(order.indexOf('upsert'));
  });

  it('a card back ALSO syncs the global card-back setting', () => {
    /* The /settings page and the card-back store display
       useTableSettings.cardBack. Without this the dropdown shows one design
       while the felt deals another — in both directions. */
    void applyTableAppearance({ cards_id: 'dragon' }, { userId: 'u1' });
    expect(emitsOf('SETTINGS_CHANGED')).toEqual([{ setting: 'cardBack', value: 'dragon' }]);
  });

  it('a felt/button/background change does NOT touch the card-back setting', () => {
    void applyTableAppearance({ table_id: 'neon_city' }, { userId: 'u1' });
    expect(emitsOf('SETTINGS_CHANGED')).toHaveLength(0);
  });
});

describe('it writes only what changed', () => {
  it('sends the composite key plus the patch, and nothing else', async () => {
    await applyTableAppearance({ cards_id: 'royal' }, { userId: 'u1' });
    expect(upsert).toHaveBeenCalledTimes(1);
    const [row, opts] = upsert.mock.calls[0];
    expect(row).toEqual({ user_id: 'u1', game_type: 'ALL', cards_id: 'royal' });
    expect(opts).toEqual({ onConflict: 'user_id,game_type' });
  });

  it('never re-sends generated columns — the HamburgerMenu bug', async () => {
    /* It used to SELECT '*' and spread the result, handing PostgREST back
       `id`, `created_at`, `updated_at`. One immutable column and every save
       failed, reverting the tile for no reason the player could see. */
    await applyTableAppearance({ background_id: 'midnight' }, { userId: 'u1' });
    const [row] = upsert.mock.calls[0];
    for (const forbidden of ['id', 'created_at', 'updated_at']) {
      expect(Object.keys(row)).not.toContain(forbidden);
    }
  });

  it('writes the per-game-type bucket when asked', async () => {
    await applyTableAppearance({ table_id: 'x' }, { userId: 'u1', gameType: 'PLO' });
    expect(upsert.mock.calls[0][0].game_type).toBe('PLO');
    expect(emitsOf('UI_THEME_CHANGED')[0]).toEqual({ key: 'PLO', value: { table_id: 'x' } });
  });
});

describe('a rejected write puts the felt back', () => {
  it('re-emits the previous selection and reports not-ok', async () => {
    upsert.mockResolvedValue({ error: { message: 'immutable column' } });

    const result = await applyTableAppearance(
      { cards_id: 'dragon' },
      { userId: 'u1', previous: { cards_id: 'classic_blue' } }
    );

    expect(result.ok).toBe(false);
    const themes = emitsOf('UI_THEME_CHANGED');
    expect(themes[0]).toEqual({ key: 'ALL', value: { cards_id: 'dragon' } });
    expect(themes[1], 'the felt was left showing a rejected choice').toEqual({
      key: 'ALL',
      value: { cards_id: 'classic_blue' },
    });
    // and the global setting is reverted with it, or the two disagree
    expect(emitsOf('SETTINGS_CHANGED').at(-1)).toEqual({
      setting: 'cardBack',
      value: 'classic_blue',
    });
  });

  it('without a previous, it still reports the failure rather than claiming success', async () => {
    upsert.mockResolvedValue({ error: { message: 'nope' } });
    const result = await applyTableAppearance({ table_id: 'x' }, { userId: 'u1' });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('signed out', () => {
  it('applies live but does not pretend it saved', async () => {
    const result = await applyTableAppearance({ cards_id: 'royal' }, { userId: null });
    // The felt still moves — a guest may still look at a theme.
    expect(emitsOf('UI_THEME_CHANGED')).toHaveLength(1);
    // …but nothing was written and the caller is told so.
    expect(upsert).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });
});
