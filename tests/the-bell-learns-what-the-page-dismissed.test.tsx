/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE BELL LEARNS WHAT THE NOTIFICATIONS PAGE DISMISSED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dismissing a notification hard-deletes the row (/api/notifications/delete,
 * service role). Every surface that shows notifications subscribes to realtime
 * to stay current, and for DELETE none of them can be:
 *
 *   `notifications` carries two RESTRICTIVE SELECT policies —
 *     messenger_private_notification_content →
 *         fn_messenger_notification_visible_to(id, auth.uid())
 *     personal_notification_destination →
 *         fn_notification_has_personal_destination(id, user_id)
 *   — and the first does EXISTS(SELECT 1 FROM notifications WHERE n.id = ...).
 *   After the delete there is no row, so the policy denies, and Realtime drops
 *   the DELETE for every subscriber. This is a server-side fact; no client
 *   subscription change can recover an event that is never sent.
 *
 * The bell was the worst hit because it also never refetches: its subscription
 * is INSERT-only and its load effect is keyed on `user?.id`, so opening the
 * dropdown does not re-read. A row dismissed on /notifications stayed in the
 * bell for the rest of the session — in the SAME tab — and clicking it
 * navigated to a notification that no longer existed.
 *
 * `NOTIFICATION_DISMISSED` was declared in MasterBus (event union and payload
 * map) and never emitted or subscribed anywhere. This is that wire.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

const USER = vi.hoisted(() => ({ id: 'user-1' }));

/**
 * tests/setup.ts replaces MasterBus globally with a stub whose subscribe()
 * records handlers and whose emit() never calls them — correct for the suites
 * that only need the module to exist, useless for a test about whether a
 * component reacts to an event. This file supplies a real, minimal bus so the
 * assertion below is about the component and not about the stub.
 */
const bus = vi.hoisted(() => {
  const subscribers = new Map<string, Set<(e: unknown) => void>>();
  return {
    subscribers,
    subscribe(type: string, handler: (e: unknown) => void) {
      if (!subscribers.has(type)) subscribers.set(type, new Set());
      subscribers.get(type)!.add(handler);
      return () => subscribers.get(type)?.delete(handler);
    },
    emit(type: string, payload: unknown) {
      subscribers.get(type)?.forEach((h) => h({ type, payload, timestamp: '' }));
    },
  };
});

vi.mock('../src/core/MasterBus', () => ({
  masterBus: {
    subscribe: bus.subscribe,
    subscribeDebounced: (t: string, h: (e: unknown) => void) => bus.subscribe(t, h),
    emit: bus.emit,
    onEvent: () => () => undefined,
    init: () => ({ online: true }),
    reset: () => undefined,
    getOrCreateChannel: () => {
      const ch: Record<string, unknown> = {};
      ch.on = () => ch;
      ch.subscribe = (cb?: (s: string) => void) => {
        cb?.('SUBSCRIBED');
        return ch;
      };
      ch.unsubscribe = () => Promise.resolve('ok');
      return ch;
    },
    removeRegisteredChannel: () => undefined,
  },
}));

vi.mock('../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: USER }) }));

/** The realtime channel is the thing that CANNOT deliver a delete. Stub it to
 *  nothing, so anything the bell learns here it learned from the bus. */
vi.mock('../src/hooks/useMasterBusChannel', () => ({ useMasterBusChannel: () => undefined }));

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: async () => ({
        data: { session: { access_token: 'tok', user: { id: 'user-1' } } },
      }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }),
      }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  },
}));

vi.mock('../src/lib/openExternal', () => ({ leaveForHub: vi.fn() }));

import NotificationDropdown from '../src/components/navigation/NotificationDropdown';
import { masterBus } from '../src/core/MasterBus';

const FEED = [
  {
    id: 'n-1',
    type: 'club',
    title: 'Alpha Notice',
    message: 'first',
    read: false,
    created_at: '2026-09-20T00:00:00.000Z',
    link: null,
  },
  {
    id: 'n-2',
    type: 'club',
    title: 'Beta Notice',
    message: 'second',
    read: false,
    created_at: '2026-09-20T00:01:00.000Z',
    link: null,
  },
];

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: true, notifications: FEED }),
    }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Render, let the feed settle, then open the dropdown. */
async function openBell() {
  const view = render(<NotificationDropdown />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  const trigger = view.container.querySelector('button');
  await act(async () => {
    trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  return view;
}

describe('the bell and a dismissal on another surface', () => {
  it('shows both notifications before anything is dismissed', async () => {
    await openBell();
    expect(screen.getByText('Alpha Notice')).toBeInTheDocument();
    expect(screen.getByText('Beta Notice')).toBeInTheDocument();
  });

  it('drops the row the page dismissed, without a refetch and without a DELETE event', async () => {
    await openBell();
    expect(screen.getByText('Alpha Notice')).toBeInTheDocument();
    const callsBefore = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls
      .length;

    await act(async () => {
      masterBus.emit('NOTIFICATION_DISMISSED', { notificationId: 'n-1' });
    });

    expect(screen.queryByText('Alpha Notice')).not.toBeInTheDocument();
    // Beta must survive: a dismissal is one row, not a reload.
    expect(screen.getByText('Beta Notice')).toBeInTheDocument();
    // And it must not have gone back to the server to find that out.
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(
      callsBefore
    );
  });

  it('recounts the badge instead of decrementing it', async () => {
    const view = await openBell();
    expect(view.container.textContent).toContain('2');

    await act(async () => {
      masterBus.emit('NOTIFICATION_DISMISSED', { notificationId: 'n-1' });
    });
    expect(view.container.textContent).toContain('1');

    // A dismissal of a row this bell never had must not move the badge.
    await act(async () => {
      masterBus.emit('NOTIFICATION_DISMISSED', { notificationId: 'not-in-this-list' });
    });
    expect(view.container.textContent).toContain('1');
  });

  it('follows a read marked on another surface', async () => {
    const view = await openBell();
    expect(view.container.textContent).toContain('2');

    await act(async () => {
      masterBus.emit('NOTIFICATION_READ', { notifId: 'n-1', allRead: false });
    });
    expect(view.container.textContent).toContain('1');
    // The row stays — read is not dismissed.
    expect(screen.getByText('Alpha Notice')).toBeInTheDocument();

    await act(async () => {
      masterBus.emit('NOTIFICATION_READ', { notifId: null, allRead: true });
    });
    expect(screen.getByText('Beta Notice')).toBeInTheDocument();
  });

  it('a dismissal of an already-read row does not move the badge', async () => {
    const view = await openBell();
    await act(async () => {
      masterBus.emit('NOTIFICATION_READ', { notifId: 'n-1', allRead: false });
    });
    expect(view.container.textContent).toContain('1');

    await act(async () => {
      masterBus.emit('NOTIFICATION_DISMISSED', { notificationId: 'n-1' });
    });
    // Still 1: n-2 is the only unread row, and it was never touched.
    expect(view.container.textContent).toContain('1');
    expect(screen.queryByText('Alpha Notice')).not.toBeInTheDocument();
  });
});
