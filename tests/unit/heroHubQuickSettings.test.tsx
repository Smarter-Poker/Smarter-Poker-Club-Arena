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
import { render, screen, cleanup } from '@testing-library/react';
import { HeroHubPanel } from '../../src/components/table/HeroHubPanel';

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

describe('the table menu is the single settings entry', () => {
  it('keeps stats and optional entertainment while removing duplicate settings controls', () => {
    const onToggle = vi.fn();
    render(<HeroHubPanel {...base} quickSettings={quick} onToggleQuickSetting={onToggle} />);
    expect(screen.queryByRole('tab', { name: 'Table' })).toBeNull();
    expect(screen.queryByText('All Table Settings')).toBeNull();
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    expect(screen.getByRole('tab', { name: 'Stats' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Throwables' })).toBeTruthy();
    expect(onToggle).not.toHaveBeenCalled();
  });
  it('recovers a previously remembered settings tab into Stats', () => {
    sessionStorage.setItem('ca_hero_hub_tab', 'settings');
    render(<HeroHubPanel {...base} />);
    expect(screen.getByRole('tab', { name: 'Stats' }).getAttribute('aria-selected')).toBe('true');
  });
});
