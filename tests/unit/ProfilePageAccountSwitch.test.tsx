import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

type ProfileResult = { data: Record<string, unknown> | null; error: null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function profile(id: string, alias: string, lifetime: boolean): ProfileResult {
  return {
    data: {
      id,
      username: alias,
      alias,
      display_name: alias,
      first_name: null,
      last_name: null,
      full_name: null,
      display_name_preference: 'alias',
      use_real_name: false,
      player_number: id === 'account-a' ? 101 : 202,
      avatar_url: '',
      arena_avatar_url: '',
      use_avatar_as_profile_pic: false,
      created_at: '2026-01-01T00:00:00.000Z',
      diamonds: id === 'account-a' ? 111 : 222,
      is_vip: lifetime,
      vip_tier: lifetime ? 'lifetime' : null,
      vip_expires_at: null,
      login_streak: 0,
      bio: '',
      player_tags: [],
    },
    error: null,
  };
}

const mocks = vi.hoisted(() => ({
  currentStoreUser: { id: 'account-a' } as { id: string } | null,
  currentAuthUser: { id: 'account-a' } as { id: string } | null,
  profileReads: new Map<string, Promise<ProfileResult>>(),
  requestedProfileIds: [] as string[],
  mountedRef: { current: true },
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: (selector: (state: { user: { id: string } | null }) => unknown) =>
    selector({ user: mocks.currentStoreUser }),
}));

vi.mock('../../src/lib/supabase', () => {
  const from = (table: string) => {
    let requestedUserId = '';
    const builder: Record<string, any> = {};
    builder.select = () => builder;
    builder.eq = (_column: string, value: string) => {
      requestedUserId = value;
      return builder;
    };
    builder.order = () => builder;
    builder.limit = () => Promise.resolve({ data: [], error: null });
    builder.maybeSingle = () => {
      if (table !== 'profiles') return Promise.resolve({ data: null, error: null });
      mocks.requestedProfileIds.push(requestedUserId);
      return (
        mocks.profileReads.get(requestedUserId) ?? Promise.resolve({ data: null, error: null })
      );
    };
    return builder;
  };

  return {
    getAuthUser: () => Promise.resolve({ data: { user: mocks.currentAuthUser } }),
    supabase: {
      from,
      rpc: () => Promise.resolve({ data: null, error: null }),
      auth: {
        getUser: () => Promise.resolve({ data: { user: mocks.currentAuthUser } }),
      },
    },
  };
});

vi.mock('../../src/utils/retryFetch', () => ({
  retryFetch: (operation: () => Promise<unknown>) => operation(),
}));
vi.mock('../../src/services/AchievementService', () => ({
  achievementService: { getUserAchievements: () => Promise.resolve([]), getById: () => null },
}));
vi.mock('../../src/services/DiamondService', () => ({
  DiamondService: { getBalance: () => Promise.resolve({ balance: 0 }) },
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribeDebounced: () => () => {} },
}));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => mocks.toast }));
vi.mock('../../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: vi.fn() }));
vi.mock('../../src/hooks/useIsMounted', () => ({ useIsMounted: () => mocks.mountedRef }));
vi.mock('../../src/hooks/useSwipeTabs', () => ({ useSwipeTabs: () => ({}) }));
vi.mock('../../src/utils/lazyWithRetry', () => ({ lazyWithRetry: () => () => null }));
vi.mock('../../src/components/common/EmptyState', () => ({
  LoadingState: ({ message }: { message: string }) => <div>{message}</div>,
}));
vi.mock('../../src/components/layouts/StandardContentLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock('../../src/components/social/FriendListPanel', () => ({ default: () => null }));
vi.mock('../../src/components/social/UserProfileEdit', () => ({ default: () => null }));
vi.mock('../../src/components/customization/AvatarGallery', () => ({ AvatarGallery: () => null }));
vi.mock('../../src/components/gamification/StreakFire', () => ({ StreakFire: () => null }));
vi.mock('../../src/components/gamification/StreakMultiplier', () => ({ default: () => null }));
vi.mock('../../src/components/common/CircularGauge', () => ({ default: () => null }));
vi.mock('../../src/components/effects/DiamondRainEffect', () => ({ default: () => null }));
vi.mock('../../src/components/social/PlayerActivityFeed', () => ({ default: () => null }));
vi.mock('../../src/components/social/ReferralDashboard', () => ({ default: () => null }));

import ProfilePage from '../../src/pages/ProfilePage';

function view() {
  return (
    <MemoryRouter initialEntries={['/profile']}>
      <ProfilePage />
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  mocks.currentStoreUser = { id: 'account-a' };
  mocks.currentAuthUser = { id: 'account-a' };
  mocks.profileReads.clear();
  mocks.requestedProfileIds.length = 0;
  mocks.mountedRef.current = true;
  sessionStorage.clear();
  vi.clearAllMocks();
});

describe('Profile Page Account Isolation', () => {
  it('masks account A synchronously while account B loads', async () => {
    mocks.profileReads.set('account-a', Promise.resolve(profile('account-a', 'AlphaAce', true)));
    const accountB = deferred<ProfileResult>();
    mocks.profileReads.set('account-b', accountB.promise);

    const rendered = render(view());
    await waitFor(() => expect(screen.getByRole('heading', { name: 'AlphaAce' })).toBeTruthy());
    expect(screen.queryAllByText('Lifetime VIP').length).toBeGreaterThan(0);

    mocks.currentStoreUser = { id: 'account-b' };
    mocks.currentAuthUser = { id: 'account-b' };
    rendered.rerender(view());

    expect(screen.queryByText('AlphaAce')).toBeNull();
    expect(screen.queryAllByText('Lifetime VIP')).toHaveLength(0);
    expect(screen.getByText('Loading profile...')).toBeTruthy();

    await act(async () => {
      accountB.resolve(profile('account-b', 'BetaBluff', false));
      await accountB.promise;
    });

    await waitFor(() => expect(screen.getByRole('heading', { name: 'BetaBluff' })).toBeTruthy());
    expect(screen.queryByText('AlphaAce')).toBeNull();
    expect(screen.queryAllByText('Lifetime VIP')).toHaveLength(0);
  });

  it('ignores an account A response that settles after account B', async () => {
    const accountA = deferred<ProfileResult>();
    const accountB = deferred<ProfileResult>();
    mocks.profileReads.set('account-a', accountA.promise);
    mocks.profileReads.set('account-b', accountB.promise);

    const rendered = render(view());
    await waitFor(() => expect(mocks.requestedProfileIds).toContain('account-a'));

    mocks.currentStoreUser = { id: 'account-b' };
    mocks.currentAuthUser = { id: 'account-b' };
    rendered.rerender(view());
    await waitFor(() => expect(mocks.requestedProfileIds).toContain('account-b'));

    await act(async () => {
      accountB.resolve(profile('account-b', 'BetaBluff', false));
      await accountB.promise;
    });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'BetaBluff' })).toBeTruthy());

    await act(async () => {
      accountA.resolve(profile('account-a', 'AlphaAce', true));
      await accountA.promise;
    });

    expect(screen.getByRole('heading', { name: 'BetaBluff' })).toBeTruthy();
    expect(screen.queryByText('AlphaAce')).toBeNull();
    expect(screen.queryAllByText('Lifetime VIP')).toHaveLength(0);
  });
});
