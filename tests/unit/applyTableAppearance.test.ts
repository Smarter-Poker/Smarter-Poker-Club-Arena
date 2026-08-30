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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const emit = vi.fn();
const upsert = vi.fn();
const capture = vi.fn();

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

vi.mock('../../src/lib/analytics', () => ({
  capture: (...args: unknown[]) => capture(...args),
}));

import { applyTableAppearance } from '../../src/lib/applyTableAppearance';

beforeEach(() => {
  emit.mockClear();
  capture.mockClear();
  upsert.mockReset();
  upsert.mockResolvedValue({ error: null });
});

afterEach(() => {
  vi.useRealTimers();
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

    expect(order).toContain('upsert');
    expect(order.indexOf('emit:UI_THEME_CHANGED')).toBeLessThan(order.indexOf('upsert'));
  });

  it('a card back ALSO syncs the global card-back setting', async () => {
    /* The /settings page and the card-back store display
       useTableSettings.cardBack. Without this the dropdown shows one design
       while the felt deals another — in both directions. */
    await applyTableAppearance({ cards_id: 'dragon' }, { userId: 'u1' });
    expect(emitsOf('SETTINGS_CHANGED')).toEqual([
      { setting: 'cardBack', value: 'dragon', userId: 'u1' },
    ]);
  });

  it('a felt/button/background change does NOT touch the card-back setting', async () => {
    await applyTableAppearance({ table_id: 'neon_city' }, { userId: 'u1' });
    expect(emitsOf('SETTINGS_CHANGED')).toHaveLength(0);
  });

  it('records one privacy-safe timing result after persistence settles', async () => {
    await applyTableAppearance({ table_id: 'neon_city' }, { userId: 'private-user-id' });

    expect(capture).toHaveBeenCalledWith(
      'table_appearance_apply',
      expect.objectContaining({
        outcome: 'saved',
        game_type: 'ALL',
        fields: ['table_id'],
        field_count: 1,
        signed_in: true,
        duration_ms: expect.any(Number),
      })
    );
    expect(JSON.stringify(capture.mock.calls)).not.toContain('private-user-id');
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
    expect(emitsOf('UI_THEME_CHANGED')[0]).toMatchObject({
      key: 'PLO',
      value: { table_id: 'x' },
      userId: 'u1',
    });
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
    expect(themes[0]).toMatchObject({ key: 'ALL', value: { cards_id: 'dragon' } });
    expect(themes[1], 'the felt was left showing a rejected choice').toMatchObject({
      key: 'ALL',
      value: { cards_id: 'classic_blue' },
    });
    // and the global setting is reverted with it, or the two disagree
    expect(emitsOf('SETTINGS_CHANGED').at(-1)).toEqual({
      setting: 'cardBack',
      value: 'classic_blue',
      userId: 'u1',
    });
  });

  it('an older failed tap cannot roll back a newer visible choice', async () => {
    let resolveFirst: ((value: { error: { message: string } }) => void) | undefined;
    upsert
      .mockImplementationOnce(
        () =>
          new Promise<{ error: { message: string } }>((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce({ error: null });

    const first = applyTableAppearance(
      { table_id: 'first' },
      { userId: 'rapid-user', previous: { table_id: 'old' } }
    );
    const second = applyTableAppearance(
      { table_id: 'second' },
      { userId: 'rapid-user', previous: { table_id: 'first' } }
    );

    // The second write is queued, but both paints happened immediately.
    await Promise.resolve();
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(
      emitsOf('UI_THEME_CHANGED')
        .slice(0, 2)
        .map(({ key, value }) => ({ key, value }))
    ).toEqual([
      { key: 'ALL', value: { table_id: 'first' } },
      { key: 'ALL', value: { table_id: 'second' } },
    ]);

    resolveFirst?.({ error: { message: 'first failed' } });
    const firstResult = await first;
    expect(firstResult.reverted).toEqual({});
    await second;

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls.map(([row]) => row.table_id)).toEqual(['first', 'second']);
    expect(emitsOf('UI_THEME_CHANGED')).toHaveLength(2);
  });

  it('retries a thrown network failure before rolling anything back', async () => {
    upsert.mockRejectedValueOnce(new Error('network down'));
    const result = await applyTableAppearance(
      { background_id: 'vegas' },
      { userId: 'u1', previous: { background_id: 'midnight' } }
    );

    expect(result.ok).toBe(true);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(emitsOf('UI_THEME_CHANGED')).toHaveLength(1);
  });

  it('turns exhausted network retries into a stale-safe rollback result', async () => {
    upsert.mockRejectedValue(new Error('network down'));
    const result = await applyTableAppearance(
      { background_id: 'vegas' },
      { userId: 'u1', previous: { background_id: 'midnight' } }
    );

    expect(result.ok).toBe(false);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(result.reverted).toEqual({ background_id: 'midnight' });
    expect(emitsOf('UI_THEME_CHANGED').at(-1)).toMatchObject({
      key: 'ALL',
      value: { background_id: 'midnight' },
    });
  });

  it('aborts two hung attempts instead of wedging the row write queue', async () => {
    vi.useFakeTimers();
    upsert.mockImplementation(() => ({
      abortSignal: (signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('appearance write aborted', 'AbortError')),
            { once: true }
          );
        }),
    }));

    const pending = applyTableAppearance(
      { table_id: 'hung' },
      { userId: 'u1', previous: { table_id: 'durable' } }
    );
    await vi.advanceTimersByTimeAsync(50_000);
    const result = await pending;

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: false, reverted: { table_id: 'durable' } });
    expect(emitsOf('UI_THEME_CHANGED').at(-1)).toMatchObject({
      value: { table_id: 'durable' },
    });
  });

  it('two rejected rapid taps return to the last durable artwork', async () => {
    upsert
      .mockResolvedValueOnce({ error: { message: 'first denied' } })
      .mockResolvedValueOnce({ error: { message: 'second denied' } });

    const first = applyTableAppearance(
      { button_id: 'first' },
      { userId: 'double-failure-user', previous: { button_id: 'durable' } }
    );
    const second = applyTableAppearance(
      { button_id: 'second' },
      { userId: 'double-failure-user', previous: { button_id: 'first' } }
    );
    const [, secondResult] = await Promise.all([first, second]);

    expect(secondResult.reverted).toEqual({ button_id: 'durable' });
    expect(emitsOf('UI_THEME_CHANGED').at(-1)).toMatchObject({
      key: 'ALL',
      value: { button_id: 'durable' },
    });
  });

  it('without a previous, it still reports the failure rather than claiming success', async () => {
    upsert.mockResolvedValue({ error: { message: 'nope' } });
    const result = await applyTableAppearance({ table_id: 'x' }, { userId: 'u1' });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(capture).toHaveBeenCalledWith(
      'table_appearance_apply',
      expect.objectContaining({ outcome: 'failed', fields: ['table_id'] })
    );
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
