/**
 * SIX COMPONENTS NEEDED ONE BOOLEAN AND MOUNTED A SETTINGS ENGINE EACH.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `useButtonImage` picks between two words in a URL — "blue" or "black" — from
 * `blue_buttons_enabled`. It used to get that by mounting the whole of
 * `useUserTableSettings`, which per call site is a full row of React state,
 * five mutation refs and TWO MasterBus subscriptions, and which re-renders its
 * consumer when ANY setting changes.
 *
 * TableMenu, PreviousHandCard, MiniStatsCard, RabbitHunt, TableChat and
 * TimebankCounter all call it, plus two more calls inside TablePage — eight per
 * table, and MultiTablePage keeps four tables mounted. Thirty-two settings
 * engines and sixty-four subscriptions to choose an icon colour.
 *
 * `useBlueButtonsEnabled` is a read-only shared store: ONE subscription per
 * user, one boolean, no write path. These tests pin the three properties that
 * make that safe — it is shared, it is live, and it does not re-render
 * consumers for settings they did not ask about.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let queryCount = 0;
let pending: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            new Promise((resolve, reject) => {
              queryCount += 1;
              pending.push({ resolve, reject });
            }),
        }),
      }),
    }),
  },
}));

const { masterBus } = await import('../../src/core/MasterBus');
const { useBlueButtonsEnabled, __blueButtonStoreCount, __resetBlueButtonStores } =
  await import('../../src/hooks/useTableButtonStyle');

const USER = 'user-skin-1';

/**
 * `tests/setup.ts` mocks MasterBus globally — `emit` is a `vi.fn()` no-op, so no
 * test in this suite can drive a real broadcast. Calling `emit` and asserting a
 * repaint would therefore pass or fail for reasons that have nothing to do with
 * this store.
 *
 * `subscribe` IS a `vi.fn`, so the handler the store registered is recorded in
 * its mock calls. Pulling it out and invoking it directly tests exactly what
 * this file is responsible for — how the store reacts to a SETTINGS_CHANGED
 * payload — and leaves delivery to MasterBus's own tests.
 */
function deliverSettingsChanged(payload: Record<string, unknown>) {
  const calls = (masterBus.subscribe as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  const handlers = calls
    .filter((c) => c[0] === 'SETTINGS_CHANGED')
    .map((c) => c[1] as (e: { payload: unknown }) => void);
  expect(
    handlers.length,
    'the store never subscribed to SETTINGS_CHANGED — it cannot react to a toggle'
  ).toBeGreaterThan(0);
  act(() => {
    for (const h of handlers) h({ payload });
  });
}

describe('the button skin is a shared, read-only selector', () => {
  beforeEach(() => {
    queryCount = 0;
    pending = [];
    __resetBlueButtonStores();
    try {
      localStorage.clear();
    } catch {
      /* jsdom always has it; guard anyway */
    }
  });

  afterEach(() => {
    __resetBlueButtonStores();
  });

  it('serves eight consumers from ONE store', () => {
    // Eight is the real per-table count: six components plus two calls in
    // TablePage.
    const hooks = Array.from({ length: 8 }, () => renderHook(() => useBlueButtonsEnabled(USER)));
    expect(__blueButtonStoreCount(), 'one store per user, not per consumer').toBe(1);
    hooks.forEach((h) => h.unmount());
  });

  it('adds no query of its own — it rides the de-duplicated settings read', () => {
    renderHook(() => useBlueButtonsEnabled(USER));
    renderHook(() => useBlueButtonsEnabled(USER));
    renderHook(() => useBlueButtonsEnabled(USER));
    // The read is de-duplicated per user in useUserTableSettings, so eight
    // consumers must not become eight round trips.
    expect(queryCount, 'the selector issued more than one read').toBeLessThanOrEqual(1);
  });

  it('repaints every consumer the moment the setting is toggled', () => {
    const a = renderHook(() => useBlueButtonsEnabled(USER));
    const b = renderHook(() => useBlueButtonsEnabled(USER));
    const before = a.result.current;

    deliverSettingsChanged({
      setting: 'blue_buttons_enabled',
      value: !before,
      userId: USER,
      origin: 'settings-panel',
    });

    expect(a.result.current, 'the toggling consumer did not update').toBe(!before);
    expect(b.result.current, 'a sibling consumer did not update').toBe(!before);
    a.unmount();
    b.unmount();
  });

  it('ignores a broadcast for a DIFFERENT user', () => {
    const a = renderHook(() => useBlueButtonsEnabled(USER));
    const before = a.result.current;
    deliverSettingsChanged({
      setting: 'blue_buttons_enabled',
      value: !before,
      userId: 'somebody-else',
      origin: 'settings-panel',
    });
    expect(a.result.current).toBe(before);
    a.unmount();
  });

  it('ignores settings it does not care about — that is the whole point', () => {
    /* The old hook re-rendered all 32 icon consumers whenever ANY setting
       changed. If this ever regresses, the selector has stopped being one.
     *
     * THE VALUES MUST DIFFER OR THIS TEST PROVES NOTHING. The first version of
     * it delivered `show_avatars: false` while the store already held `false`,
     * so deleting the setting-name filter changed nothing and the mutation went
     * undetected. Drive the store to `true` first, then deliver an unrelated
     * setting whose value is `false`: without the filter that would flip it. */
    const a = renderHook(() => useBlueButtonsEnabled(USER));
    deliverSettingsChanged({
      setting: 'blue_buttons_enabled',
      value: true,
      userId: USER,
      origin: 'settings-panel',
    });
    expect(a.result.current, 'setup failed — the store never went true').toBe(true);

    deliverSettingsChanged({
      setting: 'show_avatars',
      value: false,
      userId: USER,
      origin: 'settings-panel',
    });
    expect(
      a.result.current,
      'an unrelated setting changed the button skin — the selector is not filtering'
    ).toBe(true);
    a.unmount();
  });

  it('falls back to the canonical default with no user', () => {
    const { result } = renderHook(() => useBlueButtonsEnabled(undefined));
    expect(typeof result.current).toBe('boolean');
    expect(__blueButtonStoreCount(), 'a signed-out viewer created a store').toBe(0);
  });
});

describe('useButtonImage no longer mounts the settings engine', () => {
  const SRC = readFileSync(resolve(__dirname, '../../src/hooks/useButtonImage.ts'), 'utf8');
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('reads the narrow selector, not useUserTableSettings', () => {
    expect(CODE).toMatch(/useBlueButtonsEnabled/);
    expect(
      CODE,
      'useButtonImage is pulling the whole settings row again to read one boolean'
    ).not.toMatch(/useUserTableSettings/);
  });
});
