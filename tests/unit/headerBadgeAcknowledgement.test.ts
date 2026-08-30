import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  error: null as unknown,
  table: '',
  update: vi.fn(),
  filters: [] as Array<[string, unknown]>,
}));

const reported = vi.hoisted(() => ({ calls: [] as Array<[unknown, string]> }));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn((table: string) => {
      database.table = table;
      const chain: Record<string, unknown> = {};
      chain.update = vi.fn((value: unknown) => {
        database.update(value);
        return chain;
      });
      chain.eq = vi.fn((column: string, value: unknown) => {
        database.filters.push([column, value]);
        return chain;
      });
      chain.then = (resolve: (value: { error: unknown }) => unknown) =>
        Promise.resolve({ error: database.error }).then(resolve);
      return chain;
    }),
  },
}));

vi.mock('@/utils/errorReporter', () => ({
  reportError: vi.fn((error: unknown, context: string) => {
    reported.calls.push([error, context]);
  }),
}));

vi.mock('@/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
    removeRegisteredChannel: vi.fn(),
    getOrCreateChannel: vi.fn(),
  },
}));

const USER = '47965354-0e56-43ef-931c-ddaab82af765';

async function freshStore() {
  vi.resetModules();
  return (await import('@/stores/useHeaderDataStore')).useHeaderDataStore;
}

describe('header unread badges are acknowledged by their destinations', () => {
  beforeEach(() => {
    localStorage.clear();
    database.error = null;
    database.table = '';
    database.update.mockClear();
    database.filters = [];
    reported.calls = [];
  });

  it('zeros Notifications immediately and persists every unread row as read', async () => {
    const store = await freshStore();
    store.setState({ notificationCount: 5, _userId: USER });

    const pending = store.getState().clearUnreadNotifications(USER);
    expect(store.getState().notificationCount).toBe(0);
    expect(localStorage.getItem('ca-notif-count')).toBe('0');
    await expect(pending).resolves.toBe(true);

    expect(database.table).toBe('notifications');
    expect(database.update).toHaveBeenCalledWith({ read: true });
    expect(database.filters).toEqual([
      ['user_id', USER],
      ['read', false],
    ]);
  });

  it('zeros Messages immediately and persists every received message as read', async () => {
    const store = await freshStore();
    store.setState({ unreadMessages: 7, _userId: USER });

    const pending = store.getState().clearUnreadMessages(USER);
    expect(store.getState().unreadMessages).toBe(0);
    expect(localStorage.getItem('ca-msg-count')).toBe('0');
    await expect(pending).resolves.toBe(true);

    expect(database.table).toBe('messages');
    expect(database.update).toHaveBeenCalledWith({ is_read: true });
    expect(database.filters).toEqual([
      ['receiver_id', USER],
      ['is_read', false],
    ]);
  });

  it('restores the visible count and reports the failure when acknowledgement fails', async () => {
    const store = await freshStore();
    store.setState({ unreadMessages: 3, _userId: USER });
    database.error = { code: '42501', message: 'permission denied' };

    await expect(store.getState().clearUnreadMessages(USER)).resolves.toBe(false);

    expect(store.getState().unreadMessages).toBe(3);
    expect(localStorage.getItem('ca-msg-count')).toBe('3');
    expect(reported.calls.at(-1)?.[1]).toBe('useHeaderDataStore.clear_unread_messages');
  });
});
