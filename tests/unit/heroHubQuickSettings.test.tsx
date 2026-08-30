/**
 * ═══ THE TABLE TAB HAS SWITCHES IN IT (2026-08-30) ═════════════════════════
 *
 * Same weakness the Stats tab had before its figures were inlined: "Table"
 * was a tab containing ONE button that closed the hub and opened
 * SettingsPanel. The switches a player reaches for mid-session are now one
 * tap from the avatar.
 *
 * The thing that must never break while doing that is the rule
 * `tests/unit/settingsHaveOneOwner.test.ts` exists to defend: ONE owner and
 * ONE persisted copy per setting. The hub adds a SURFACE — it reads values
 * handed to it and calls back; it holds no state and writes no storage. These
 * beats pin both the surface and that restraint.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { HeroHubPanel } from '../../src/components/table/HeroHubPanel';
import { TABLE_SETTINGS_META } from '../../src/hooks/useUserTableSettings';

const noop = () => {};
const base = {
  isOpen: true,
  onClose: noop,
  userId: 'user-1',
  emojiEnabled: false,
  isTournament: false,
  onThrowableSelect: noop,
  onOpenStats: noop,
  onOpenTournamentInfo: noop,
  onOpenProfileView: noop,
  onOpenAvatarPicker: noop,
  onOpenIdentity: noop,
  onOpenTableSettings: noop,
};

const quick = [
  { key: 'show_avatars', label: 'Show Avatars', description: 'd1', value: true },
  { key: 'card_squeeze', label: 'Card Squeeze', description: 'd2', value: false },
];

beforeEach(() => {
  sessionStorage.clear();
  cleanup();
});

describe('the quick switches render and report their state', () => {
  it('renders one switch per quick setting, with its on/off state exposed', () => {
    render(<HeroHubPanel {...base} quickSettings={quick} onToggleQuickSetting={noop} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Table' }));
    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(2);
    expect(switches[0].getAttribute('aria-checked')).toBe('true');
    expect(switches[1].getAttribute('aria-checked')).toBe('false');
  });

  it('a tap calls back with the setting KEY — the hub stores nothing itself', () => {
    const onToggle = vi.fn();
    render(<HeroHubPanel {...base} quickSettings={quick} onToggleQuickSetting={onToggle} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Table' }));
    fireEvent.click(screen.getByRole('switch', { name: /Card Squeeze/ }));
    expect(onToggle).toHaveBeenCalledWith('card_squeeze');
  });

  it('the full panel is still reachable', () => {
    render(<HeroHubPanel {...base} quickSettings={quick} onToggleQuickSetting={noop} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Table' }));
    expect(screen.getByText('All Table Settings')).toBeTruthy();
  });

  it('with no quick settings supplied the tab still works (launcher only)', () => {
    render(<HeroHubPanel {...base} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Table' }));
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    expect(screen.getByText('All Table Settings')).toBeTruthy();
  });
});

describe('ONE OWNER: the hub adds a surface, not a second store', () => {
  const hub = readFileSync(
    path.resolve(__dirname, '../../src/components/table/HeroHubPanel.tsx'),
    'utf8'
  );

  it('the hub never persists a table setting itself', () => {
    // Its only storage is the last-used TAB, which is a UI convenience and not
    // a table setting. Any settings write here would be the second copy the
    // one-owner rule forbids.
    const writes = hub.match(/(localStorage|sessionStorage)\.setItem\(([^)]*)\)/g) ?? [];
    for (const w of writes) {
      expect(w, `the hub writes storage other than the tab memory: ${w}`).toContain(
        'HERO_HUB_TAB_KEY'
      );
    }
    expect(hub.includes('supabase'), 'the hub talks to the database directly').toBe(false);
  });

  it('the quick list is DERIVED from the settings meta, not a second key list', () => {
    const page = readFileSync(path.resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');
    expect(
      /TABLE_SETTINGS_META\.filter\(\(m\) => m\.quick\)/.test(page),
      'the quick settings are hand-listed somewhere instead of derived from the meta — ' +
        'that list will drift from the settings it names'
    ).toBe(true);
  });

  it('the writes go through the same toggle the full panel uses', () => {
    const page = readFileSync(path.resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');
    expect(/onToggleQuickSetting=\{\(key\) => \{\s*\n?\s*void toggleV8Setting\(/.test(page)).toBe(
      true
    );
  });
});

describe('the quick flag is a real, curated subset', () => {
  it('marks at least one and fewer than all — a subset, not a second panel', () => {
    const flagged = TABLE_SETTINGS_META.filter((m) => m.quick);
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged.length).toBeLessThan(TABLE_SETTINGS_META.length);
  });

  it('every flagged setting is one the full panel also lists', () => {
    // Same array, so this is structurally guaranteed — asserted anyway,
    // because the failure it guards (a quick-only key that the panel cannot
    // show or reset) would be invisible until a player went looking for it.
    for (const m of TABLE_SETTINGS_META.filter((x) => x.quick)) {
      expect(TABLE_SETTINGS_META.some((x) => x.key === m.key)).toBe(true);
    }
  });
});
