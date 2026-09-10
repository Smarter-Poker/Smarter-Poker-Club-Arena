import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../../src/lib/storage';
import { clearUnionFlagCache, writeCachedQuickLinkClubs } from '../../src/utils/clubQuickLink';

type Membership = {
  role: string;
  club: { id: string; slug: string; name: string; is_union: boolean };
};
type OwnedUnion = { id: string; slug: string; name: string; ownerId: string; memberCount: number };

const h = vi.hoisted(() => ({
  userId: 'viewer-a',
  memberships: vi.fn(),
  ownedUnions: vi.fn(),
  navigate: vi.fn(),
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
  bus: new Map<string, Set<(event: { payload: unknown }) => void>>(),
}));

vi.mock('../../src/lib/supabase', () => ({
  getAuthUser: async () => ({ data: { user: { id: h.userId } }, error: null }),
  supabase: {
    rpc: vi.fn(async () => ({ data: [], error: null })),
    from: vi.fn(() => ({ select: () => ({ in: async () => ({ data: [], error: null }) }) })),
  },
}));
vi.mock('../../src/services/ClubsService', () => ({
  ClubsService: { getUserMemberships: h.memberships },
}));
vi.mock('../../src/services/UnionService', () => ({
  UnionService: { getOwnedUnions: h.ownedUnions },
}));
vi.mock('../../src/services/ClubJoinService', () => ({
  ClubJoinService: { resumePending: async () => null },
}));
vi.mock('../../src/services/ClubEntryTrustService', () => ({
  ClubEntryTrustService: {
    getFlags: async () => ({ create_club: true, find_player: true, join_club: true }),
    track: vi.fn(),
  },
}));
vi.mock('../../src/services/ClubCardBackfill', () => ({ backfillClubCards: vi.fn() }));
vi.mock('../../src/context/InTabLobbyContext', () => ({
  useAppNavigate: () => h.navigate,
  useInTabLobby: () => null,
}));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: h.userId }, isHydrating: false }),
}));
vi.mock('../../src/core/MasterBus', () => {
  const subscribe = (key: string, callback: (event: { payload: unknown }) => void) => {
    const handlers = h.bus.get(key) ?? new Set();
    handlers.add(callback);
    h.bus.set(key, handlers);
    return () => handlers.delete(callback);
  };
  return { masterBus: { subscribe, subscribeDebounced: subscribe } };
});
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => h.toast }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/utils/ChunkPreloader', () => ({ preloadRoute: vi.fn() }));
vi.mock('../../src/services/HapticService', () => ({
  default: { light: vi.fn(), medium: vi.fn() },
}));
vi.mock('../../src/utils/playPremiumSfx', () => ({ playPremiumSfx: vi.fn() }));

// Keep HomePage, ClubQuickLinkTile and the directory resolver mounted. These
// sibling surfaces have their own contracts and do not decide Cashier readiness.
vi.mock('../../src/components/navigation/GlobalHeader', () => ({ default: () => null }));
vi.mock('../../src/components/home/FloatingOrbs', () => ({ default: () => null }));
vi.mock('../../src/components/home/CarouselSection', () => ({ default: () => null }));
vi.mock('../../src/components/home/ClubContextMenu', () => ({ default: () => null }));
vi.mock('../../src/components/modals/CreateClubModal', () => ({ default: () => null }));
vi.mock('../../src/components/modals/FindPlayerModal', () => ({ default: () => null }));
vi.mock('../../src/components/daily-bonus/DailyBonusEntry', () => ({ default: () => null }));
vi.mock('../../src/components/modals/JoinClubModal', () => ({
  default: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div role="dialog" aria-label="Join A Club" /> : null,
}));

import HomePage from '../../src/pages/HomePage';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function holdDirectory() {
  const memberships = deferred<Membership[]>();
  const unions = deferred<OwnedUnion[]>();
  h.memberships.mockReturnValueOnce(memberships.promise);
  h.ownedUnions.mockReturnValueOnce(unions.promise);
  return { memberships, unions };
}
const member = (name = 'First Club', slug = 'first-club'): Membership => ({
  role: 'member',
  club: { id: '11111111-1111-4111-8111-111111111111', slug, name, is_union: false },
});
const mount = () =>
  render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>
  );
const flush = () => act(async () => {});
const cashier = () => screen.getByRole('button', { name: /^Cashier(?: For| \()/ });
const invoke = (input: 'tile' | 'shortcut') => {
  if (input === 'tile') fireEvent.click(cashier());
  else fireEvent.keyDown(window, { key: '4' });
};
function expectNoFalseJoin() {
  expect(screen.queryByRole('dialog', { name: 'Join A Club' })).not.toBeInTheDocument();
  expect(h.toast.info.mock.calls.some(([message]) => /join.*club.*cashier/i.test(message))).toBe(
    false
  );
  expect(h.navigate).not.toHaveBeenCalled();
}
function emitAuth(userId: string) {
  h.userId = userId;
  act(() => {
    for (const callback of h.bus.get('AUTH_STATE_CHANGED') ?? [])
      callback({ payload: { isAuthenticated: true, userId } });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  h.memberships.mockReset().mockResolvedValue([]);
  h.ownedUnions.mockReset().mockResolvedValue([]);
  h.userId = 'viewer-a';
  h.bus.clear();
  localStorage.clear();
  sessionStorage.clear();
  clearUnionFlagCache();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('mounted home Cashier directory readiness', () => {
  it.each(['tile', 'shortcut'] as const)(
    'keeps %s honest after the spinner timeout and opens the resolved wallet',
    async (input) => {
      const pending = holdDirectory();
      mount();
      await flush();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(screen.queryByText('Loading Arena')).not.toBeInTheDocument();

      invoke(input);
      expectNoFalseJoin();
      expect(h.toast.info).toHaveBeenCalledWith('Loading Cashier Directory');
      expect(h.memberships).toHaveBeenCalledTimes(1);
      expect(h.ownedUnions).toHaveBeenCalledTimes(1);

      await act(async () => {
        pending.memberships.resolve([member()]);
        pending.unions.resolve([]);
      });
      invoke(input);
      expect(h.navigate).toHaveBeenCalledWith('/clubs/first-club/cashier');
    }
  );

  it('waits for canonical union ownership even after memberships are confirmed empty', async () => {
    const pending = holdDirectory();
    mount();
    await flush();
    await act(async () => pending.memberships.resolve([]));
    fireEvent.click(cashier());
    expectNoFalseJoin();
    expect(h.toast.info).toHaveBeenCalledWith('Loading Cashier Directory');

    await act(async () =>
      pending.unions.resolve([
        {
          id: '22222222-2222-4222-8222-222222222222',
          slug: 'owned-union',
          name: 'Owned Union',
          ownerId: 'viewer-a',
          memberCount: 2,
        },
      ])
    );
    fireEvent.click(cashier());
    expect(h.navigate).toHaveBeenCalledWith('/unions/owned-union/operations?tab=wallet');
  });

  it('keeps Join guidance for a successfully confirmed empty directory', async () => {
    mount();
    await flush();
    invoke('shortcut');
    expect(h.toast.info).toHaveBeenCalledWith(expect.stringMatching(/join.*club.*cashier/i));
    fireEvent.click(cashier());
    await flush();
    expect(screen.getByRole('dialog', { name: 'Join A Club' })).toBeInTheDocument();
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it('retries a failed directory once and keeps repeated activation pending until recovery', async () => {
    const first = holdDirectory();
    mount();
    await flush();
    await act(async () => {
      first.memberships.resolve([]);
      first.unions.reject(new Error('Directory unavailable'));
    });
    const retry = holdDirectory();
    fireEvent.click(cashier());
    await flush();
    expect(h.toast.info).toHaveBeenCalledWith('Retrying Cashier Directory');
    invoke('shortcut');
    fireEvent.click(cashier());
    await flush();
    expectNoFalseJoin();
    expect(h.memberships).toHaveBeenCalledTimes(2);
    expect(h.ownedUnions).toHaveBeenCalledTimes(2);

    await act(async () => {
      retry.memberships.resolve([member()]);
      retry.unions.resolve([]);
    });
    fireEvent.click(cashier());
    expect(h.navigate).toHaveBeenCalledWith('/clubs/first-club/cashier');
  });

  it('does not let the previous account completion end the active account wait', async () => {
    const first = holdDirectory();
    mount();
    await flush();
    const second = holdDirectory();
    emitAuth('viewer-b');
    await flush();
    await act(async () => {
      first.memberships.resolve([member()]);
      first.unions.resolve([]);
      await vi.advanceTimersByTimeAsync(6_000);
    });
    fireEvent.click(cashier());
    expectNoFalseJoin();
    expect(h.toast.info).toHaveBeenCalledWith('Loading Cashier Directory');

    await act(async () => {
      second.memberships.resolve([member('Second Club', 'second-club')]);
      second.unions.resolve([]);
    });
    fireEvent.click(cashier());
    expect(h.navigate).toHaveBeenCalledWith('/clubs/second-club/cashier');
  });

  it('ends the Cashier wait on logout and ignores the old directory completion', async () => {
    const pending = holdDirectory();
    mount();
    await flush();
    act(() => {
      for (const callback of h.bus.get('AUTH_STATE_CHANGED') ?? [])
        callback({ payload: { isAuthenticated: false, userId: null } });
    });
    await act(async () => {
      pending.memberships.resolve([member()]);
      pending.unions.resolve([]);
    });
    invoke('shortcut');
    expect(h.toast.info).not.toHaveBeenCalledWith('Loading Cashier Directory');
    expect(h.toast.info).toHaveBeenCalledWith(expect.stringMatching(/join.*club.*cashier/i));
    fireEvent.click(cashier());
    await flush();
    expect(screen.getByRole('dialog', { name: 'Join A Club' })).toBeInTheDocument();
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it('keeps a matching account cached wallet usable during authoritative refresh', async () => {
    writeCachedQuickLinkClubs('viewer-a', [member().club]);
    localStorage.setItem(STORAGE_KEYS.CLUBS_CACHE_TS, String(Date.now()));
    holdDirectory();
    mount();
    await flush();
    fireEvent.click(cashier());
    expect(h.navigate).toHaveBeenCalledWith('/clubs/first-club/cashier');
    expect(h.toast.info).not.toHaveBeenCalledWith('Loading Cashier Directory');
  });
});
