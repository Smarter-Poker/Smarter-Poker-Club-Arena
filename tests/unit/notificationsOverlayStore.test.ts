/**
 * Opening notifications acknowledges the badge, whichever door was used.
 *
 * The bug this covers shipped in the first pass of the popup work: the badge
 * clear was written out on GlobalHeader's bell handler, so opening the same
 * popup from the hamburger or the account rail left the bell sitting behind it
 * still claiming unread notifications the player had just read. It was
 * invisible while those doors navigated away; the popup is what made it
 * visible, because the header stays on screen.
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';

const headerData = vi.hoisted(() => ({
  _userId: 'player-1' as string | null,
  clearUnreadNotifications: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/stores/useHeaderDataStore', () => ({
  useHeaderDataStore: Object.assign(() => headerData, { getState: () => headerData }),
}));

import { useNotificationsOverlayStore } from '@/stores/useNotificationsOverlayStore';

describe('useNotificationsOverlayStore', () => {
  beforeEach(() => {
    headerData._userId = 'player-1';
    headerData.clearUnreadNotifications.mockClear();
    useNotificationsOverlayStore.getState().closeNotifications();
  });

  it.each([
    ['global-header-bell'],
    ['hamburger-menu'],
    ['arena-section-rail'],
    ['notification-bell'],
  ])('clears the badge when opened from %s', (source) => {
    useNotificationsOverlayStore.getState().openNotifications(source);

    expect(useNotificationsOverlayStore.getState().isOpen).toBe(true);
    expect(useNotificationsOverlayStore.getState().openedFrom).toBe(source);
    expect(headerData.clearUnreadNotifications).toHaveBeenCalledWith('player-1');
  });

  it('opens anyway when nobody is signed in yet, rather than throwing on the way', () => {
    // The header store hydrates asynchronously. A bell tap that lands before it
    // knows the user must still show the list.
    headerData._userId = null;

    useNotificationsOverlayStore.getState().openNotifications('global-header-bell');

    expect(useNotificationsOverlayStore.getState().isOpen).toBe(true);
    expect(headerData.clearUnreadNotifications).not.toHaveBeenCalled();
  });

  it('closing leaves no trace of which door was used', () => {
    useNotificationsOverlayStore.getState().openNotifications('hamburger-menu');
    useNotificationsOverlayStore.getState().closeNotifications();

    expect(useNotificationsOverlayStore.getState().isOpen).toBe(false);
    expect(useNotificationsOverlayStore.getState().openedFrom).toBeNull();
  });
});
