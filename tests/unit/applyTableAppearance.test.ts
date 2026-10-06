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
const rpc = vi.fn();
const capture = vi.fn();

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: (...args: unknown[]) => emit(...args),
  },
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
  },
}));

vi.mock('../../src/lib/analytics', () => ({
  capture: (...args: unknown[]) => capture(...args),
}));

import { applyTableAppearance } from '../../src/lib/applyTableAppearance';

beforeEach(() => {
  emit.mockClear();
  capture.mockClear();
  rpc.mockReset();
  rpc.mockResolvedValue({ data: {}, error: null });
});

afterEach(() => {
  vi.useRealTimers();
});

const emitsOf = (name: string) => emit.mock.calls.filter((c) => c[0] === name).map((c) => c[1]);

describe('the felt repaints before the network', () => {
  it('emits UI_THEME_CHANGED first, then writes', async () => {
    const order: string[] = [];
    emit.mockImplementation((n: string) => order.push(`emit:${n}`));
    rpc.mockImplementation(() => {
      order.push('rpc');
      return Promise.resolve({ data: {}, error: null });
    });

    await applyTableAppearance({ table_id: 'neon_city' }, { userId: 'u1' });

    expect(order).toContain('rpc');
    expect(order.indexOf('emit:UI_THEME_CHANGED')).toBeLessThan(order.indexOf('rpc'));
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
  it('maps live faceDeckId to DB face_deck_id and paints the DOM immediately', async () => {
    await applyTableAppearance(
      { faceDeckId: 'neon-circuit' },
      { userId: 'face-writer', gameType: 'NLH' }
    );

    expect(rpc.mock.calls[0]).toEqual([
      'fn_patch_table_appearance',
      {
        p_expected_user_id: 'face-writer',
        p_mutation_id: expect.any(String),
        p_game_type: 'NLH',
        p_patch: { face_deck_id: 'neon-circuit' },
      },
    ]);
    expect(rpc.mock.calls[0][1].p_patch).not.toHaveProperty('faceDeckId');
    expect(emitsOf('UI_THEME_CHANGED')[0]).toMatchObject({
      value: { faceDeckId: 'neon-circuit' },
    });
    expect(document.documentElement).toHaveAttribute('data-face-deck', 'neon-circuit');
  });

  it('sends the composite key plus the patch, and nothing else', async () => {
    await applyTableAppearance({ cards_id: 'royal' }, { userId: 'u1' });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0]).toEqual([
      'fn_patch_table_appearance',
      {
        p_expected_user_id: 'u1',
        p_mutation_id: expect.any(String),
        p_game_type: 'ALL',
        p_patch: { cards_id: 'royal' },
      },
    ]);
  });

  it('never re-sends generated columns — the HamburgerMenu bug', async () => {
    /* It used to SELECT '*' and spread the result, handing PostgREST back
       `id`, `created_at`, `updated_at`. One immutable column and every save
       failed, reverting the tile for no reason the player could see. */
    await applyTableAppearance({ background_id: 'midnight' }, { userId: 'u1' });
    const row = rpc.mock.calls[0][1].p_patch;
    for (const forbidden of ['id', 'created_at', 'updated_at']) {
      expect(Object.keys(row)).not.toContain(forbidden);
    }
  });

  it('writes the per-game-type bucket when asked', async () => {
    await applyTableAppearance({ table_id: 'x' }, { userId: 'u1', gameType: 'PLO' });
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_expected_user_id: 'u1',
      p_game_type: 'PLO',
      p_patch: { table_id: 'x' },
    });
    expect(emitsOf('UI_THEME_CHANGED')[0]).toMatchObject({
      key: 'PLO',
      value: { table_id: 'x' },
      userId: 'u1',
    });
  });
});

describe('a rejected write puts the felt back', () => {
  it('restores the previous face finish after a rejected write', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'face deck denied' } });

    const result = await applyTableAppearance(
      { faceDeckId: 'royal-purple' },
      { userId: 'face-rollback', previous: { faceDeckId: 'house-classic' } }
    );

    expect(result).toMatchObject({ ok: false, reverted: { faceDeckId: 'house-classic' } });
    expect(document.documentElement).toHaveAttribute('data-face-deck', 'house-classic');
    expect(emitsOf('UI_THEME_CHANGED').at(-1)).toMatchObject({
      value: { faceDeckId: 'house-classic' },
    });
  });

  it('re-emits the previous selection and reports not-ok', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'immutable column' } });

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
    rpc
      .mockImplementationOnce(
        () =>
          new Promise<{ error: { message: string } }>((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce({ data: {}, error: null });

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
    expect(rpc).toHaveBeenCalledTimes(1);
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

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls.map(([, args]) => args.p_patch.table_id)).toEqual(['first', 'second']);
    expect(emitsOf('UI_THEME_CHANGED')).toHaveLength(2);
  });

  it('retries a thrown network failure before rolling anything back', async () => {
    rpc.mockRejectedValueOnce(new Error('network down'));
    const result = await applyTableAppearance(
      { background_id: 'vegas' },
      { userId: 'u1', previous: { background_id: 'midnight' } }
    );

    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0][1].p_mutation_id).toBe(rpc.mock.calls[1][1].p_mutation_id);
    expect(emitsOf('UI_THEME_CHANGED')).toHaveLength(1);
  });

  it('turns exhausted network retries into a stale-safe rollback result', async () => {
    rpc.mockRejectedValue(new Error('network down'));
    const result = await applyTableAppearance(
      { background_id: 'vegas' },
      { userId: 'u1', previous: { background_id: 'midnight' } }
    );

    expect(result.ok).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0][1].p_mutation_id).toBe(rpc.mock.calls[1][1].p_mutation_id);
    expect(result.reverted).toEqual({ background_id: 'midnight' });
    expect(emitsOf('UI_THEME_CHANGED').at(-1)).toMatchObject({
      key: 'ALL',
      value: { background_id: 'midnight' },
    });
  });

  it('aborts two hung attempts instead of wedging the row write queue', async () => {
    vi.useFakeTimers();
    rpc.mockImplementation(() => ({
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

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0][1].p_mutation_id).toBe(rpc.mock.calls[1][1].p_mutation_id);
    expect(result).toMatchObject({ ok: false, reverted: { table_id: 'durable' } });
    expect(emitsOf('UI_THEME_CHANGED').at(-1)).toMatchObject({
      value: { table_id: 'durable' },
    });
  });

  it('two rejected rapid taps return to the last durable artwork', async () => {
    rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'first denied' } })
      .mockResolvedValueOnce({ data: null, error: { message: 'second denied' } });

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
    rpc.mockResolvedValue({ data: null, error: { message: 'nope' } });
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
    expect(rpc).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });
});
