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
