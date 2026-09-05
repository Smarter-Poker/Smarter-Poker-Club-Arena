/**
 * A HOTKEY FOR THE RABBIT HUNT (P4, 2026-09-05)
 *
 * The 2026-09-05 competitive research found the industry's answer to a
 * short rabbit-hunt window for multi-tablers: GGPoker's mappable hotkey. This
 * is ours. B runs the tile's OWN reveal - the same single-flight, the same
 * charge, the same toasts as a tap - through useTableKeyboard, the only
 * keyboard system the table has. When no offer is up the tile registers no
 * handler and B does nothing.
 *
 * Run against the pre-feature tree: the hook pins fail (no `b` case, no
 * onRabbitHunt), the tile pins fail (no hotkeyRef prop).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { useTableKeyboard } from '../../src/hooks/useTableKeyboard';

vi.mock('../../src/hooks/useButtonImage', () => ({ useButtonImage: () => '/rabbit.webp' }));
vi.mock('../../src/services/VIPService', () => ({
  FEATURE_PRICING: { rabbit_hunt: { cost: 5 } },
  vipService: {
    checkVIPStatus: vi.fn().mockResolvedValue({
      isVIP: false,
      monthlyLimits: { rabbitHunts: { used: 0, limit: 0 } },
    }),
  },
}));
const toast = { error: vi.fn(), info: vi.fn() };
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => toast }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import RabbitHunt from '../../src/components/table/RabbitHunt';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const press = (key: string, init: KeyboardEventInit = {}) =>
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  );

const base = {
  isActive: true,
  isHeroTurn: false,
  isSpectator: false,
  isModalOpen: false,
  isSizingOpen: false,
};

describe('B in useTableKeyboard', () => {
  it('fires onRabbitHunt between hands, on the active table only, never for a spectator or under a modal', () => {
    const onRabbitHunt = vi.fn();
    const { rerender } = renderHook(
      (p: Parameters<typeof useTableKeyboard>[0]) => useTableKeyboard(p),
      {
        initialProps: { ...base, onRabbitHunt },
      }
    );
    press('b');
    expect(onRabbitHunt).toHaveBeenCalledTimes(1);
    press('B');
    expect(onRabbitHunt).toHaveBeenCalledTimes(2);
    rerender({ ...base, isActive: false, onRabbitHunt });
    press('b');
    expect(onRabbitHunt, 'a table the player is not looking at').toHaveBeenCalledTimes(2);
    rerender({ ...base, isSpectator: true, onRabbitHunt });
    press('b');
    expect(onRabbitHunt, 'a spectator has nothing to hunt').toHaveBeenCalledTimes(2);
    rerender({ ...base, isModalOpen: true, onRabbitHunt });
    press('b');
    expect(onRabbitHunt, 'a modal owns the keyboard').toHaveBeenCalledTimes(2);
    rerender({ ...base, onRabbitHunt });
    press('b', { metaKey: true });
    press('b', { ctrlKey: true });
    expect(onRabbitHunt, 'Cmd/Ctrl+B belongs to the browser').toHaveBeenCalledTimes(2);
  });
  it('is a no-op with no handler, and never touches the action keys', () => {
    const onFold = vi.fn();
    renderHook(() => useTableKeyboard({ ...base, onFold }));
    press('b');
    expect(onFold).not.toHaveBeenCalled();
  });
});

describe('the tile hands its reveal to the hotkey', () => {
  it('registers the same handler a tap runs while an offer is up, and withdraws it after the reveal', async () => {
    const hotkeyRef = { current: null as null | (() => void) };
    const registerHotkey = (h: (() => void) | null) => {
      hotkeyRef.current = h;
    };
    const onReveal = vi.fn().mockResolvedValue({
      success: true,
      cards: [{ rank: 'A', suit: 'c' }],
      diamondsSpent: 5,
    });
    const { rerender } = render(
      <RabbitHunt
        isAvailable={true}
        cardsAvailable={1}
        rabbitDiamondCost={5}
        userId="11111111-2222-4333-8444-555555555555"
        onReveal={onReveal}
        registerHotkey={registerHotkey}
      />
    );
    expect(hotkeyRef.current, 'an offer is up: the key has a handler').toBeTypeOf('function');
    hotkeyRef.current!();
    await waitFor(() => expect(onReveal).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(hotkeyRef.current, 'revealed: nothing left to hunt').toBeNull());
    // A second press after the reveal reaches nothing.
    expect(onReveal).toHaveBeenCalledTimes(1);
    rerender(
      <RabbitHunt
        isAvailable={false}
        cardsAvailable={0}
        rabbitDiamondCost={5}
        userId="11111111-2222-4333-8444-555555555555"
        onReveal={onReveal}
        registerHotkey={registerHotkey}
      />
    );
    expect(hotkeyRef.current).toBeNull();
  });
  it('the button says so for assistive tech', () => {
    const { getByRole } = render(
      <RabbitHunt
        isAvailable={true}
        cardsAvailable={1}
        rabbitDiamondCost={5}
        userId="11111111-2222-4333-8444-555555555555"
        onReveal={vi.fn()}
      />
    );
    expect(getByRole('button').getAttribute('aria-keyshortcuts')).toBe('b');
  });
});

describe('the page wires the one keyboard system, not a second listener', () => {
  it('passes the ref to the tile and the key to the hook', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const page = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');
    expect(page).toContain('registerHotkey={registerRabbitHotkey}');
    // The page makes the assignment itself (bustHoldIsWired guards that every
    // callable ref on the page is assigned on the page).
    expect(page).toContain('rabbitHotkeyRef.current = handler;');
    expect(page).toContain('onRabbitHunt: () => rabbitHotkeyRef.current?.(),');
    // The only keydown listener the page ever had is the one the 2026-08-28
    // note describes as deleted; a live `window.addEventListener('keydown'`
    // statement (not the comment about it) must not come back for this.
    expect(page.match(/^\s*window\.addEventListener\('keydown'/gm) ?? []).toHaveLength(0);
  });
});
