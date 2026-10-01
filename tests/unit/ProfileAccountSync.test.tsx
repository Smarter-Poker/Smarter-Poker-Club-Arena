import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const model = vi.hoisted(() => ({
  state: { user: { id: 'player-a', alias: 'Old' } as Record<string, any> | null },
  stateListeners: new Set<(next: any, previous: any) => void>(),
  listeners: new Map<string, (event: any) => void>(),
  emit: vi.fn(),
  read: vi.fn(),
  select: vi.fn(),
  report: vi.fn(),
  options: null as any,
  signals: [] as AbortSignal[],
  theme: { themePreference: 'dark', receiveTheme: vi.fn() },
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: (...args: any[]) => {
      model.emit(...args);
      model.listeners.get(args[0])?.({ payload: args[1] });
    },
    subscribe: (type: string, callback: any) => {
      model.listeners.set(type, callback);
      return () => model.listeners.delete(type);
    },
  },
}));
vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: Object.assign((select: any) => select(model.state), {
    getState: () => model.state,
    setState: (next: any) => {
      Object.assign(model.state, next);
    },
    subscribe: (callback: any) => {
      model.stateListeners.add(callback);
      return () => model.stateListeners.delete(callback);
    },
  }),
}));
vi.mock('../../src/stores/useSettingsStore', () => ({
  useSettingsStore: { getState: () => model.theme },
}));
vi.mock('../../src/utils/vipStatus', () => ({ resolveVipStatus: () => 'none' }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: model.report }));
vi.mock('../../src/hooks/useMasterBusBroadcastChannel', () => ({
  useMasterBusBroadcastChannel: (options: unknown) => {
    model.options = options;
  },
}));
// The player's own row is read through the owner door (ruling 25):
// get_my_full_profile(), filtered by id, then the columns.
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (name: string) => {
      if (name !== 'get_my_full_profile') throw new Error('unexpected rpc ' + name);
      return {
        eq: () => ({
          select: (columns: string) => {
            model.select(columns);
            return {
              abortSignal: (signal: AbortSignal) => {
                model.signals.push(signal);
                return { maybeSingle: () => model.read() };
              },
            };
          },
        }),
      };
    },
  },
}));
import { ProfileAccountSync } from '../../src/hooks/useProfileAccountSync';
const row = (extra = {}) => ({
  data: {
    id: 'player-a',
    alias: 'Fresh',
    diamonds: 70,
    profile_theme: 'auto',
    achievement_notifications: false,
    settlement_alerts: true,
    ...extra,
  },
  error: null,
});
async function mount() {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<ProfileAccountSync />);
  });
  return view;
}
async function signal(domains: string[], user_id = 'player-a') {
  await act(async () => model.options.onPayload({ payload: { user_id, domains } }));
}
function deferred() {
  let resolve!: (value: any) => void;
  const promise = new Promise((r) => {
    resolve = r;
  });
  model.read.mockReturnValueOnce(promise);
  return resolve;
}
function identity(id: string | null) {
  const previous = { ...model.state };
  model.state.user = id ? { id } : null;
  model.stateListeners.forEach((callback) => callback(model.state, previous));
}
beforeEach(() => {
  vi.clearAllMocks();
  model.listeners.clear();
  model.stateListeners.clear();
  model.signals = [];
  model.state.user = { id: 'player-a', alias: 'Old' };
  model.theme.themePreference = 'dark';
  model.read.mockReset().mockResolvedValue(row());
  localStorage.clear();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe('the private own-account carrier', () => {
  it('mounts one private owner topic and populates the existing consumers from narrow authority', async () => {
    localStorage.setItem('club-arena-user-settings', JSON.stringify({ soundVolume: 42 }));
    await mount();
    expect(model.options).toMatchObject({
      channelName: 'profile-account:player-a',
      private: true,
      event: 'account_changed',
    });
    expect(model.select.mock.calls[0][0]).not.toMatch(/\*|last_seen|total_hands/);
    expect(model.select.mock.calls[0][0]).toContain('profile_theme:settings->theme');
    expect(model.state.user?.alias).toBe('Fresh');
    expect(model.theme.receiveTheme).toHaveBeenCalledWith('auto', 'player-a');
    expect(JSON.parse(localStorage.getItem('club-arena-user-settings')!)).toEqual({
      soundVolume: 42,
      theme: 'auto',
      achievementNotifications: false,
      settlementAlerts: true,
    });
    expect(model.emit).toHaveBeenCalledWith('DIAMOND_BALANCE_CHANGED', {
      userId: 'player-a',
      newBalance: 70,
      delta: 0,
      source: 'profile-account',
    });
  });
  it('reads only the changed domains and ignores another account or invented domains', async () => {
    await mount();
    model.read.mockClear();
    model.select.mockClear();
    model.emit.mockClear();
    await signal(['diamonds'], 'player-b');
    await signal(['internal']);
    expect(model.read).not.toHaveBeenCalled();
    await signal(['diamonds']);
    expect(model.select).toHaveBeenCalledWith('id,diamonds');
    expect(model.emit.mock.calls.map((call) => call[0])).toEqual(['DIAMOND_BALANCE_CHANGED']);
  });
  it('coalesces a burst and never overlaps reads, then refuses the superseded result', async () => {
    await mount();
    model.read.mockClear();
    model.emit.mockClear();
    const old = deferred();
    await signal(['diamonds']);
    await act(async () => {
      model.options.onPayload({ payload: { user_id: 'player-a', domains: ['diamonds'] } });
      model.options.onPayload({ payload: { user_id: 'player-a', domains: ['settings'] } });
    });
    expect(model.read).toHaveBeenCalledTimes(1);
    await act(async () => old(row({ diamonds: 1 })));
    expect(model.read).toHaveBeenCalledTimes(2);
    expect(
      model.emit.mock.calls
        .filter((call) => call[0] === 'DIAMOND_BALANCE_CHANGED')
        .map((call) => call[1].newBalance)
    ).toEqual([70]);
  });
  it('does not replace a newer local change with an older response', async () => {
    await mount();
    model.emit.mockClear();
    const old = deferred();
    await signal(['diamonds', 'settings']);
    act(() => {
      model.listeners.get('DIAMOND_BALANCE_CHANGED')!({
        payload: { userId: 'player-a', source: 'purchase', newBalance: 85 },
      });
      model.listeners.get('UI_THEME_CHANGED')!({ payload: { userId: 'player-a', key: 'theme' } });
    });
    await act(async () => old(row({ diamonds: 2, profile_theme: 'light' })));
    expect(model.emit).not.toHaveBeenCalled();
  });
  it('fences A to B to A even before React can render and aborts old reads', async () => {
    await mount();
    model.emit.mockClear();
    const old = deferred();
    await signal(['diamonds']);
    act(() => {
      identity('player-b');
      identity('player-a');
    });
    expect(model.signals.at(-1)?.aborted).toBe(true);
    await act(async () => old(row({ diamonds: 1 })));
    expect(
      model.emit.mock.calls
        .filter((call) => call[0] === 'DIAMOND_BALANCE_CHANGED')
        .map((call) => call[1].newBalance)
    ).toEqual([70]);
  });
  it('defers hidden reads and recovers on visibility and channel rejoin without polling', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await mount();
    await signal(['diamonds']);
    expect(model.read).not.toHaveBeenCalled();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(model.read).toHaveBeenCalledTimes(1);
    await act(async () => model.options.onSubscriptionStatus('SUBSCRIBED'));
    expect(model.read).toHaveBeenCalledTimes(2);
  });
  it('keeps known values on unknown reads and permits the next real invalidation', async () => {
    await mount();
    model.emit.mockClear();
    model.read.mockResolvedValueOnce({ data: null, error: { message: 'offline' } });
    await signal(['diamonds']);
    expect(model.emit).not.toHaveBeenCalled();
    expect(model.report).toHaveBeenCalledOnce();
    await signal(['diamonds']);
    expect(model.emit).toHaveBeenCalledWith(
      'DIAMOND_BALANCE_CHANGED',
      expect.objectContaining({ newBalance: 70 })
    );
  });
  it('bounds a slow read and refuses its eventual stale response', async () => {
    await mount();
    model.emit.mockClear();
    vi.useFakeTimers();
    const old = deferred();
    await signal(['diamonds']);
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(model.signals.at(-1)?.aborted).toBe(true);
    await act(async () => old(row({ diamonds: 1 })));
    expect(model.emit).not.toHaveBeenCalled();
    await signal(['diamonds']);
    expect(model.emit).toHaveBeenCalledWith(
      'DIAMOND_BALANCE_CHANGED',
      expect.objectContaining({ newBalance: 70 })
    );
  });
  it('updates live consumers even if browser cache persistence is denied', async () => {
    const failure = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    try {
      await mount();
      expect(model.theme.receiveTheme).toHaveBeenCalledWith('auto', 'player-a');
      expect(model.emit).toHaveBeenCalledWith(
        'DIAMOND_BALANCE_CHANGED',
        expect.objectContaining({ newBalance: 70 })
      );
      expect(model.report).toHaveBeenCalledWith(
        expect.any(Error),
        'ProfileAccountSync.Preference_cache_failed'
      );
    } finally {
      failure.mockRestore();
    }
  });
  it('applies canonical defaults when remote profile preferences are removed', async () => {
    localStorage.setItem(
      'club-arena-user-settings',
      JSON.stringify({ theme: 'light', settlementAlerts: false })
    );
    model.read.mockResolvedValue(
      row({ profile_theme: null, achievement_notifications: null, settlement_alerts: null })
    );
    await mount();
    expect(JSON.parse(localStorage.getItem('club-arena-user-settings')!)).toMatchObject({
      theme: 'dark',
      achievementNotifications: true,
      settlementAlerts: true,
    });
    expect(model.theme.receiveTheme).toHaveBeenCalledWith('dark', 'player-a');
  });
  it('retires reads and queued callbacks on unmount', async () => {
    const view = await mount();
    model.emit.mockClear();
    const old = deferred();
    await signal(['diamonds']);
    const callback = model.options.onPayload;
    view.unmount();
    expect(model.signals.at(-1)?.aborted).toBe(true);
    await act(async () => {
      old(row({ diamonds: 1 }));
      callback({ payload: { user_id: 'player-a', domains: ['diamonds'] } });
    });
    expect(model.emit).not.toHaveBeenCalled();
    expect(model.listeners.size).toBe(0);
    expect(model.stateListeners.size).toBe(0);
  });
  it('rejects invalid balances and recovers a malformed local cache', async () => {
    localStorage.setItem('club-arena-user-settings', '{');
    model.read.mockResolvedValue(row({ diamonds: -5 }));
    await mount();
    expect(model.emit.mock.calls.some((call) => call[0] === 'DIAMOND_BALANCE_CHANGED')).toBe(false);
    expect(model.theme.receiveTheme).toHaveBeenCalledWith('auto', 'player-a');
    expect(model.report).toHaveBeenCalledOnce();
  });
  it('keeps Auto following the local system and removes its listener', async () => {
    const listeners = new Set<() => void>();
    vi.stubGlobal('matchMedia', () => ({
      addEventListener: (_: string, callback: () => void) => listeners.add(callback),
      removeEventListener: (_: string, callback: () => void) => listeners.delete(callback),
    }));
    const view = await mount();
    model.theme.receiveTheme.mockClear();
    model.theme.themePreference = 'auto';
    act(() => listeners.forEach((callback) => callback()));
    expect(model.theme.receiveTheme).toHaveBeenCalledWith('auto', 'player-a');
    model.theme.themePreference = 'dark';
    model.theme.receiveTheme.mockClear();
    act(() => listeners.forEach((callback) => callback()));
    expect(model.theme.receiveTheme).not.toHaveBeenCalled();
    view.unmount();
    expect(listeners.size).toBe(0);
    vi.unstubAllGlobals();
  });
});
