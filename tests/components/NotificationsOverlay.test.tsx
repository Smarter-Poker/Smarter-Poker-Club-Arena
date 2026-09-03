/**
 * The notifications popup, exercised the way a player uses it.
 *
 * Dan, 2026-09-02: "IT SHOULD CREATE A 'FULL SCREEN POP UP' SO YOU STAY ON THE
 * PAGE YOU WERE ON... YOU SHOULD BE ABLE TO 'X' OFF THE NOTIFICATIONS POP UP
 * AND STAY ON THE SAME PAGE YOU WERE ON STILL."
 *
 * `notifications-open-as-a-popup.law.test.ts` reads the source and pins that
 * each door calls the store. This file renders the thing and checks it actually
 * behaves: opens over the page, dismisses three ways, and hands the scroll lock
 * back to whatever set it.
 *
 * NotificationsSurface is mocked deliberately. What is under test here is the
 * popup shell — portal, dismissal, scroll lock, unmount-when-closed. The feed
 * inside it is the same component the /notifications route renders and is
 * covered there; mounting it would drag in Supabase, auth and a realtime
 * channel to prove none of them.
 */

import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import NotificationsOverlay from '@/components/notifications/NotificationsOverlay';
import { useNotificationsOverlayStore } from '@/stores/useNotificationsOverlayStore';

const headerData = vi.hoisted(() => ({
  _userId: 'player-1',
  clearUnreadNotifications: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/stores/useHeaderDataStore', () => ({
  useHeaderDataStore: Object.assign(() => headerData, { getState: () => headerData }),
}));

vi.mock('@/components/notifications/NotificationsSurface', () => ({
  default: ({ onRequestClose }: { onRequestClose?: () => void }) => (
    <div data-testid="surface">
      <button type="button" onClick={() => onRequestClose?.()}>
        Follow A Notification
      </button>
    </div>
  ),
}));

const open = () =>
  act(() => {
    useNotificationsOverlayStore.getState().openNotifications('test');
  });

describe('NotificationsOverlay', () => {
  beforeEach(() => {
    act(() => {
      useNotificationsOverlayStore.getState().closeNotifications();
    });
    document.body.style.overflow = '';
  });

  afterEach(() => {
    document.body.style.overflow = '';
  });

  it('renders nothing at all until something opens it', () => {
    render(
      <MemoryRouter>
        <NotificationsOverlay />
      </MemoryRouter>
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // Unmounted rather than hidden: the surface holds a feed poll and a
    // realtime subscription, and neither should run for a popup nobody opened.
    expect(screen.queryByTestId('surface')).not.toBeInTheDocument();
  });

  it('opens over the page as a labelled modal dialog carrying the surface', () => {
    render(
      <MemoryRouter>
        <NotificationsOverlay />
      </MemoryRouter>
    );
    open();

    const dialog = screen.getByRole('dialog', { name: 'Notifications' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByTestId('surface')).toBeInTheDocument();
  });

  it('closes on the X, and the page underneath is still there', () => {
    render(
      <MemoryRouter>
        <div>The Page You Were On</div>
        <NotificationsOverlay />
      </MemoryRouter>
    );
    open();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Close Notifications'));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('The Page You Were On')).toBeInTheDocument();
  });

  it('closes on Escape and on a backdrop press', () => {
    render(
      <MemoryRouter>
        <NotificationsOverlay />
      </MemoryRouter>
    );

    open();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    open();
    const backdrop = document.querySelector('.ca-notif-overlay') as HTMLElement;
    fireEvent.mouseDown(backdrop);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('ignores a press that started inside the panel and drifted onto the backdrop', () => {
    render(
      <MemoryRouter>
        <NotificationsOverlay />
      </MemoryRouter>
    );
    open();

    fireEvent.mouseDown(screen.getByTestId('surface'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closes itself when the surface navigates, so nothing is delivered underneath it', () => {
    render(
      <MemoryRouter>
        <NotificationsOverlay />
      </MemoryRouter>
    );
    open();

    fireEvent.click(screen.getByText('Follow A Notification'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  /* ── Swipe down to dismiss ──────────────────────────────────────────
   * The X is pinned top-right, which is the hardest pixel to reach on a phone
   * held one-handed, and this popup is full screen so there is no card edge to
   * tap past either. These pin the three rules that keep the gesture from
   * eating the scroll it shares a direction with. */

  const scroller = () => document.querySelector('.ca-notif-overlay__scroll') as HTMLElement;
  const panel = () => document.querySelector('.ca-notif-overlay__panel') as HTMLElement;

  const swipe = (from: number, to: number, opts: { pointerType?: string } = {}) => {
    const el = scroller();
    const pointerType = opts.pointerType ?? 'touch';
    fireEvent.pointerDown(el, { clientY: from, pointerType });
    fireEvent.pointerMove(el, { clientY: to, pointerType });
  };

  it('dismisses on a long downward swipe from the top of the list', () => {
    render(
      <MemoryRouter>
        <NotificationsOverlay />
      </MemoryRouter>
    );
    open();

    swipe(100, 400);
    // Tracks the finger before release.
    expect(panel().style.transform).not.toBe('');

    fireEvent.pointerUp(scroller(), { clientY: 400, pointerType: 'touch' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('springs back instead of dismissing when the swipe is short', () => {
    render(
      <MemoryRouter>
        <NotificationsOverlay />
      </MemoryRouter>
    );
    open();

    swipe(100, 140);
    fireEvent.pointerUp(scroller(), { clientY: 140, pointerType: 'touch' });

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(panel().style.transform).toBe('');
  });

  it('leaves the gesture alone when the list is scrolled down, because that is a scroll', () => {
    render(
      <MemoryRouter>
        <NotificationsOverlay />
      </MemoryRouter>
    );
    open();

    // A player reading halfway down a long feed drags down to scroll up.
    Object.defineProperty(scroller(), 'scrollTop', { value: 240, configurable: true });
    swipe(100, 400);
    fireEvent.pointerUp(scroller(), { clientY: 400, pointerType: 'touch' });

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('ignores a mouse drag, which has the X and Escape instead', () => {
    render(
      <MemoryRouter>
        <NotificationsOverlay />
      </MemoryRouter>
    );
    open();

    swipe(100, 400, { pointerType: 'mouse' });
    fireEvent.pointerUp(scroller(), { clientY: 400, pointerType: 'mouse' });

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('hands the scroll lock back exactly as it found it', () => {
    // A table page that had deliberately locked its own scroll must not be
    // silently unlocked when the popup closes.
    document.body.style.overflow = 'clip';

    render(
      <MemoryRouter>
        <NotificationsOverlay />
      </MemoryRouter>
    );

    open();
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.click(screen.getByLabelText('Close Notifications'));
    expect(document.body.style.overflow).toBe('clip');
  });
});
