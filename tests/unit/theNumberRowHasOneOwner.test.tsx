/**
 * THE NUMBER ROW HAS ONE OWNER (launch audit 2026-10-05).
 *
 * 1-4 size a bet while the sizing panel is open and switch tables otherwise.
 * The table switcher ran regardless, so with two tables open pressing 2 for
 * half pot also flipped to table two.
 */
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tableSizingOwnsNumberRow, useTableKeyboard } from '../../src/hooks/useTableKeyboard';

const base = {
  isActive: true,
  isHeroTurn: true,
  isSpectator: false,
  isModalOpen: false,
  isSizingOpen: true,
};

describe('the number row has one owner', () => {
  it('the sizing panel of the active table owns it, and only then', () => {
    expect(tableSizingOwnsNumberRow()).toBe(false);
    const { rerender, unmount } = renderHook((p: typeof base) => useTableKeyboard(p), {
      initialProps: base,
    });
    expect(tableSizingOwnsNumberRow()).toBe(true);
    rerender({ ...base, isSizingOpen: false });
    expect(tableSizingOwnsNumberRow()).toBe(false);
    rerender({ ...base, isActive: false });
    expect(tableSizingOwnsNumberRow()).toBe(false);
    rerender({ ...base, isHeroTurn: false });
    expect(tableSizingOwnsNumberRow()).toBe(false);
    rerender({ ...base, isModalOpen: true });
    expect(tableSizingOwnsNumberRow()).toBe(false);
    rerender(base);
    expect(tableSizingOwnsNumberRow()).toBe(true);
    unmount();
    expect(tableSizingOwnsNumberRow()).toBe(false);
  });

  it('the table switcher asks before it switches', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'pages', 'MultiTablePage.tsx'),
      'utf8'
    );
    const digits = src.indexOf("if (e.key >= '1' && e.key <= String(MAX_TABLES)) {");
    const ask = src.indexOf('if (tableSizingOwnsNumberRow()) return;', digits);
    const sw = src.indexOf('setActiveIndex(idx);', digits);
    expect(digits).toBeGreaterThan(-1);
    expect(ask).toBeGreaterThan(digits);
    expect(sw).toBeGreaterThan(ask);
  });

  it('a tournament table sizes in whole chips', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'pages', 'TablePage.tsx'), 'utf8');
    expect(src).toContain(
      "unit={tableState.arenaAsset === 'diamonds' || tableState.isTournament ? 1 : 0.01}"
    );
  });
});
