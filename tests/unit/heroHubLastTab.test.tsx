/**
 * HERO HUB — the hub reopens on the tab the player last used (2026-08-29).
 *
 * One tap saved per open for a player who lives in Stats; a fresh session
 * still lands on Throwables. The memory is sessionStorage and must NEVER be
 * load-bearing: blocked storage (private mode, thumbnails) falls back to the
 * default with no throw. Both halves are pinned here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
  HeroHubPanel,
  HERO_HUB_TAB_KEY,
  readInitialHubTab,
  rememberHubTab,
} from '../../src/components/table/HeroHubPanel';

const noop = () => {};

/** emojiEnabled=false on purpose: the Throwables tab then renders the plain
 *  disabled notice instead of mounting ThrowableSelector and its service. */
const hubProps = {
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

describe('the hub remembers the last-used tab across opens (this session)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    cleanup();
  });

  it('a fresh session opens on Throwables', () => {
    render(<HeroHubPanel {...hubProps} />);
    expect(screen.getByRole('tab', { name: 'Throwables' }).getAttribute('aria-selected')).toBe(
      'true'
    );
  });

  it('close and reopen lands on the tab that was in use', () => {
    const first = render(<HeroHubPanel {...hubProps} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Stats' }));
    expect(screen.getByRole('tab', { name: 'Stats' }).getAttribute('aria-selected')).toBe('true');
    first.unmount();

    render(<HeroHubPanel {...hubProps} />);
    expect(screen.getByRole('tab', { name: 'Stats' }).getAttribute('aria-selected')).toBe('true');
  });

  it('junk in storage falls back to the default, never crashes the hub', () => {
    sessionStorage.setItem(HERO_HUB_TAB_KEY, 'not-a-tab');
    render(<HeroHubPanel {...hubProps} />);
    expect(screen.getByRole('tab', { name: 'Throwables' }).getAttribute('aria-selected')).toBe(
      'true'
    );
  });

  it('blocked storage is survived on read AND write', () => {
    const getSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      expect(readInitialHubTab()).toBe('throwables');
      expect(() => rememberHubTab('stats')).not.toThrow();
    } finally {
      getSpy.mockRestore();
      setSpy.mockRestore();
    }
  });
});
