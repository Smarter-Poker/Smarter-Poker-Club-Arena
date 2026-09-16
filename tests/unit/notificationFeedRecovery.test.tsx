import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  user: { id: 'account-a' } as { id: string } | null,
  getSession: vi.fn(),
  fetch: vi.fn(),
  update: vi.fn(),
  emit: vi.fn(),
  channels: [] as any[],
  visibility: () => {},
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: fixture.user }) }));
vi.mock('../../src/hooks/useVisibilityRefresh', () => ({
  useVisibilityRefresh: (callback: () => void) => {
    fixture.visibility = callback;
  },
}));
vi.mock('../../src/components/notifications/PushEnableBanner', () => ({ default: () => null }));
vi.mock('../../src/components/account/AccountSurfaceHeader', () => ({
  default: ({ title, status, children }: any) => (
    <header>
      <h1>{title}</h1>
      <span>{status}</span>
      {children}
    </header>
  ),
}));
vi.mock('../../src/lib/openExternal', () => ({ leaveForHub: vi.fn(), openInBrowser: vi.fn() }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: fixture.emit,
    getOrCreateChannel: (name: string) => {
      const channel: any = { name, bindings: [], state: 'closed' };
      channel.on = (_kind: string, filter: any, callback: any) => {
        channel.bindings.push({ filter, callback });
        return channel;
      };
      channel.subscribe = (callback: any) => {
        channel.status = callback;
        return channel;
      };
      fixture.channels.push(channel);
      return channel;
    },
    registerChannelFactory: vi.fn(),
    removeChannelFactory: vi.fn(),
    removeRegisteredChannel: vi.fn(),
  },
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: { getSession: fixture.getSession },
    from: (table: string) => ({
      update: (values: unknown) => {
        const filters: Record<string, unknown> = {};
        const chain: any = {
          eq: (key: string, value: unknown) => {
            filters[key] = value;
            return chain;
          },
          then: (yes: any, no: any) =>
            Promise.resolve(fixture.update({ table, values, filters })).then(yes, no),
        };
        return chain;
      },
    }),
  },
}));
import NotificationsPage from '../../src/pages/NotificationsPage';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function row(id: string, message = id, read = false) {
  return {
    id,
    user_id: fixture.user?.id,
    title: 'Tournament',
    actor_name: 'Tournament',
    message,
    created_at: new Date().toISOString(),
    read,
    link: '/hub/club-arena/tournaments/event',
  };
}
const response = (rows: any[] = [], ok = true) => ({
  ok,
  status: ok ? 200 : 503,
  json: async () => ({ success: ok, notifications: rows }),
});
const feeds: any[] = [];
function feedCalls() {
  return fixture.fetch.mock.calls.filter(([url]) => String(url).includes('/feed?'));
}
function mount() {
  return render(
    <MemoryRouter>
      <NotificationsPage />
    </MemoryRouter>
  );
}
async function flush() {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}
function emitInsert(channel = fixture.channels.at(-1)) {
  channel.bindings[0].callback({ new: row('incoming'), eventType: 'INSERT' });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  localStorage.clear();
  fixture.channels.length = 0;
  feeds.length = 0;
  fixture.user = { id: 'account-a' };
  fixture.getSession.mockImplementation(async () => ({
    data: {
      session: fixture.user
        ? {
            user: { id: fixture.user.id },
            access_token: 'token-' + fixture.user.id,
          }
        : null,
    },
  }));
  fixture.update.mockResolvedValue({ error: null });
  fixture.fetch.mockImplementation((url: string, options: any) => {
    if (url.includes('/feed?')) return Promise.resolve(feeds.shift() ?? response());
    if (url === '/api/notifications/mark-read' || url === '/api/poker/notifications') {
      return Promise.resolve(fixture.update({ url, options })).then(({ error }) =>
        response([], !error)
      );
    }
    return Promise.resolve(response());
  });
  vi.stubGlobal('fetch', fixture.fetch);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('The mounted notification feed owns recovery and account state', () => {
  it('does not paint a personal feed cached before operational destination cutover', async () => {
    localStorage.setItem('ca-notif-cache:v1:account-a', JSON.stringify([
      { ...row('retained-alert', 'Old Operational Alert'), _cache_ts: Date.now() },
    ]));
    const pending = deferred<any>();
    feeds.push(pending.promise);
    mount();
    await flush();
    expect(screen.queryByText('Old Operational Alert')).toBeNull();
    await act(async () => pending.resolve(response([row('personal', 'Personal Notice')])));
    await flush();
    expect(screen.queryByText('Personal Notice')).not.toBeNull();
    expect(localStorage.getItem('ca-notif-cache:v2:account-a')).toContain('Personal Notice');
  });

  it('rejects an auth read error even if the SDK also returns cached session data', async () => {
    fixture.getSession.mockResolvedValue({
      data: { session: { user: { id: 'account-a' }, access_token: 'cached-token' } },
      error: new Error('Session Read Refused'),
    });
    mount();
    await flush();
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/Could Not Be Loaded/);
  });

  it('stops claiming a live feed when its subscription closes', async () => {
    feeds.push(response([row('confirmed')]), response([row('confirmed')]));
    mount();
    await flush();
    act(() => fixture.channels[0].status('SUBSCRIBED'));
    await flush();
    expect(screen.queryByText('Live Feed')).not.toBeNull();
    act(() => fixture.channels[0].status('CLOSED'));
    expect(screen.queryByText('Live Feed')).toBeNull();
    expect(screen.queryByText('Reconnecting')).not.toBeNull();
  });

  it('waits for both read owners and reconciles a partial mark-all refusal', async () => {
    const pageWrite = deferred<any>();
    const social = row('social', 'Social Read');
    const poker = row('poker-page', 'Page Refused');
    feeds.push(response([social, poker]), response([{ ...social, read: true }, poker]));
    fixture.update.mockImplementation(({ url }) =>
      url === '/api/poker/notifications' ? pageWrite.promise : Promise.resolve({ error: null })
    );
    const view = mount();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Mark All Read' }));
    await flush();
    expect(fixture.update.mock.calls.map(([x]) => [x.url, JSON.parse(x.options.body)])).toEqual([
      ['/api/notifications/mark-read', {}],
      ['/api/poker/notifications', { mark_all: true }],
    ]);
    expect(feedCalls()).toHaveLength(1);
    await act(async () => pageWrite.resolve({ error: { message: 'Refused' } }));
    await flush();
    expect(feedCalls()).toHaveLength(2);
    expect(
      view.container
        .querySelector('[data-notif-id="social"]')
        ?.classList.contains('ca-notif__row--unread')
    ).toBe(false);
    expect(
      view.container
        .querySelector('[data-notif-id="poker-page"]')
        ?.classList.contains('ca-notif__row--unread')
    ).toBe(true);
    expect(fixture.emit).not.toHaveBeenCalledWith(
      'NOTIFICATION_READ',
      expect.objectContaining({ allRead: true })
    );
  });

  it('requests a fresh authenticated feed when the subscription recovers', async () => {
    feeds.push(response([row('first')]), response([row('second')]));
    mount();
    await flush();
    act(() => fixture.channels[0].status('SUBSCRIBED'));
    await flush();
    const [url, options] = feedCalls().at(-1)!;
    expect(new URL(url, 'https://example.test').searchParams.get('bust')).toBe('1');
    expect(options.cache).toBe('no-store');
    expect(options.headers.Authorization).toBe('Bearer token-account-a');
  });
  it('marks a page signal through its authenticated page-read endpoint', async () => {
    const n = row('poker-page-id', 'Page Read');
    feeds.push(response([n]), response([{ ...n, read: true }]));
    mount();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /Tournament Page Read/ }));
    await flush();
    const call = fixture.fetch.mock.calls.find(([url]) => url === '/api/poker/notifications');
    expect(call).toBeDefined();
    expect(call![1].method).toBe('PUT');
    expect(JSON.parse(call![1].body)).toEqual({ notification_id: 'page-id' });
    expect(call![1].headers.Authorization).toBe('Bearer token-account-a');
  });

  it('uses only the current account cache on a warm revisit', async () => {
    feeds.push(response([row('warm', 'Warm Account A')]));
    const view = mount();
    await flush();
    fixture.user = { id: 'account-b' };
    feeds.push(deferred<any>().promise);
    view.rerender(
      <MemoryRouter>
        <NotificationsPage />
      </MemoryRouter>
    );
    await flush();
    expect(screen.queryByText('Warm Account A', { exact: false })).toBeNull();
    fixture.user = { id: 'account-a' };
    feeds.push(deferred<any>().promise);
    view.rerender(
      <MemoryRouter>
        <NotificationsPage />
      </MemoryRouter>
    );
    expect(screen.queryByText('Warm Account A', { exact: false })).not.toBeNull();
    await flush();
  });
  it('does not request or mark seen with a session belonging to another account', async () => {
    fixture.getSession.mockResolvedValue({
      data: { session: { user: { id: 'account-b' }, access_token: 'token-b' } },
    });
    mount();
    await flush();
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/Could Not Be Loaded/);
  });
  it('a successful single read cannot be undone by an older pending feed', async () => {
    const old = deferred<any>();
    const write = deferred<any>();
    const n = row('read-one', 'Single Read');
    feeds.push(response([n]), old.promise, response([{ ...n, read: true }]));
    fixture.update.mockReturnValue(write.promise);
    const view = mount();
    await flush();
    act(() => {
      fixture.visibility();
    });
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /Tournament Single Read/ }));
    await flush();
    expect(fixture.update).toHaveBeenCalledTimes(1);
    expect(fixture.update.mock.calls[0][0].url).toBe('/api/notifications/mark-read');
    expect(JSON.parse(fixture.update.mock.calls[0][0].options.body)).toEqual({
      notificationId: 'read-one',
    });
    expect(fixture.update.mock.calls[0][0].options.headers.Authorization).toBe(
      'Bearer token-account-a'
    );
    await act(async () => old.resolve(response([n])));
    await flush();
    expect(feedCalls()).toHaveLength(2);
    expect(
      view.container
        .querySelector('[data-notif-id="read-one"]')
        ?.classList.contains('ca-notif__row--unread')
    ).toBe(false);
    await act(async () => write.resolve({ error: null }));
    await flush();
    expect(feedCalls()).toHaveLength(3);
    expect(
      view.container
        .querySelector('[data-notif-id="read-one"]')
        ?.classList.contains('ca-notif__row--unread')
    ).toBe(false);
  });
  it('keeps a dismissal until acknowledgment, then reconciles the confirmed removal', async () => {
    const deletion = deferred<any>();
    const n = row('delete-one', 'Await Confirmation');
    feeds.push(response([n]), response());
    fixture.fetch.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('/feed?')
          ? (feeds.shift() ?? response())
          : url.includes('/delete')
            ? deletion.promise
            : response()
      )
    );
    mount();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }));
    await flush();
    expect(screen.queryByText('Await Confirmation', { exact: false })).not.toBeNull();
    await act(async () => deletion.resolve(response()));
    await flush();
    expect(screen.queryByText('Await Confirmation', { exact: false })).toBeNull();
    expect(feedCalls()).toHaveLength(2);
  });
  it('dismisses a synthetic signal locally without issuing a delete mutation', async () => {
    const n = row('poker-derived', 'Derived Signal');
    feeds.push(response([n]), response([n]));
    mount();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }));
    await flush();
    expect(screen.queryByText('Derived Signal', { exact: false })).toBeNull();
    expect(fixture.fetch.mock.calls.some(([url]) => String(url).includes('/delete'))).toBe(false);
  });
  it('receives update and delete invalidations through the actual hook binding', async () => {
    const n = row('changed', 'Other Tab Updated');
    feeds.push(response([n]), response([{ ...n, read: true }]), response());
    const view = mount();
    await flush();
    const binding = fixture.channels[0].bindings[0];
    const deliver = (eventType: string, payload: any) => {
      if (binding.filter.event === '*' || binding.filter.event === eventType)
        binding.callback({ ...payload, eventType });
    };
    act(() => {
      deliver('UPDATE', { new: { id: n.id, user_id: 'account-a' } });
    });
    await flush();
    expect(
      view.container
        .querySelector('[data-notif-id="changed"]')
        ?.classList.contains('ca-notif__row--unread')
    ).toBe(false);
    act(() => {
      deliver('DELETE', { old: { id: n.id } });
    });
    await flush();
    expect(screen.queryByText('Other Tab Updated', { exact: false })).toBeNull();
    expect(feedCalls()).toHaveLength(3);
  });

  it('does not paint an unowned legacy cache before the current account feed arrives', async () => {
    localStorage.setItem(
      'sp-notif-cache',
      JSON.stringify([{ ...row('foreign', 'Other Account Signal'), _cache_ts: Date.now() }])
    );
    feeds.push(deferred<any>().promise);
    mount();
    await flush();
    expect(screen.queryByText('Other Account Signal', { exact: false })).toBeNull();
  });
  it('reloads after a recovered subscription and keeps the resolved destination', async () => {
    feeds.push(response([row('old', 'Old Signal')]), response([row('missed', 'Missed Signal')]));
    mount();
    await flush();
    await act(async () => {
      fixture.channels[0].status('SUBSCRIBED');
    });
    await flush();
    expect(screen.queryByText('Missed Signal', { exact: false })).not.toBeNull();
    expect(screen.queryByText('Old Signal', { exact: false })).toBeNull();
    expect(feedCalls()).toHaveLength(2);
  });
  it('retains one follow-up invalidation while a read is pending', async () => {
    const pending = deferred<any>();
    feeds.push(
      response([row('base')]),
      pending.promise,
      response([row('latest', 'Latest Signal')])
    );
    mount();
    await flush();
    act(() => {
      fixture.visibility();
    });
    await flush();
    act(() => {
      for (let i = 0; i < 8; i++) emitInsert();
    });
    await flush();
    expect(feedCalls()).toHaveLength(2);
    await act(async () => pending.resolve(response([row('stale', 'Stale Signal')])));
    await flush();
    expect(feedCalls()).toHaveLength(3);
    expect(screen.queryByText('Latest Signal', { exact: false })).not.toBeNull();
    expect(screen.queryByText('Stale Signal', { exact: false })).toBeNull();
  });
  it('retires the previous account response and cache when the account changes', async () => {
    const old = deferred<any>();
    const foreign = row('foreign', 'Account A Private');
    feeds.push(old.promise, response([row('own', 'Account B Current')]));
    const view = mount();
    await flush();
    fixture.user = { id: 'account-b' };
    view.rerender(
      <MemoryRouter>
        <NotificationsPage />
      </MemoryRouter>
    );
    await flush();
    await act(async () => old.resolve(response([foreign])));
    await flush();
    expect(screen.queryByText('Account A Private', { exact: false })).toBeNull();
    expect(screen.queryByText('Account B Current', { exact: false })).not.toBeNull();
    expect(localStorage.getItem('sp-notif-cache')).toBeNull();
  });
  it('starts the feed when account hydration finishes', async () => {
    fixture.user = null;
    const view = mount();
    await flush();
    feeds.push(response([row('ready', 'Signed In Signal')]));
    fixture.user = { id: 'account-a' };
    view.rerender(
      <MemoryRouter>
        <NotificationsPage />
      </MemoryRouter>
    );
    await flush();
    expect(screen.queryByText('Signed In Signal', { exact: false })).not.toBeNull();
  });
  it('distinguishes an initial refused read from an empty inbox and supports retry', async () => {
    feeds.push(response([], false), response([row('recovered', 'Recovered Signal')]));
    mount();
    await flush();
    expect(screen.queryByText('No Signals Yet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    await flush();
    expect(screen.queryByText('Recovered Signal', { exact: false })).not.toBeNull();
  });
  it('preserves confirmed rows and shows a refresh error instead of claiming a live feed', async () => {
    feeds.push(response([row('confirmed', 'Confirmed Signal')]), response([], false));
    mount();
    await flush();
    act(() => {
      fixture.visibility();
    });
    await flush();
    expect(screen.queryByText('Confirmed Signal', { exact: false })).not.toBeNull();
    expect(screen.getByRole('alert').textContent).toMatch(/Could Not Be Refreshed/);
  });
  it('a refused dismiss cannot be erased later by the old fade timer', async () => {
    const n = row('refused', 'Keep This Signal');
    feeds.push(response([n]), response([n]));
    fixture.fetch.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('/feed?')
          ? (feeds.shift() ?? response([n]))
          : response([], !url.includes('/delete'))
      )
    );
    mount();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }));
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    await flush();
    expect(screen.queryByText('Keep This Signal', { exact: false })).not.toBeNull();
  });
  it('a read refusal reconciles the optimistic read marker', async () => {
    const n = row('unread', 'Unread Signal');
    feeds.push(response([n]), response([n]));
    fixture.update.mockResolvedValue({ error: { message: 'Write Refused' } });
    const view = mount();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Mark All Read' }));
    await flush();
    expect(
      view.container
        .querySelector('[data-notif-id="unread"]')
        ?.classList.contains('ca-notif__row--unread')
    ).toBe(true);
  });
});
