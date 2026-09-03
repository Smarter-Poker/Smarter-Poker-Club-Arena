import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE HEADER ORB — regression cover for 2026-08-22
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `profiles.arena_avatar_url` was added by a migration that did not grant it.
 * public.profiles is granted per COLUMN (so email / phone / stripe_customer_id
 * stay unreadable), and a column grant does not extend to columns added later,
 * so every browser read of that column came back 42501 / 403 — for all 1022
 * profiles, on every avatar surface in the app.
 *
 * The grant is the bug. What made it cost a day is in this file:
 *
 *   1. supabase-js RESOLVES on a rejected request. A 403 arrives as
 *      { data: null, error }, never as a throw, so the store's try/catch never
 *      saw it and nothing reached Sentry or the console.
 *   2. Reading `.data?.avatar_url` straight through made "you are not allowed
 *      to read this" indistinguishable from "this player has no avatar".
 *   3. A failed read then WROTE that null into the store, so even a cached
 *      avatar was erased by the failure.
 *
 * These assertions are about behaviour under failure, which is the part that
 * had no cover at all.
 */

const supabaseMock = vi.hoisted(() => ({
  profileResult: { data: null as unknown, error: null as unknown },
  from: vi.fn(),
}));

const reported = vi.hoisted(() => ({ calls: [] as Array<[unknown, string]> }));
const busMock = vi.hoisted(() => ({
  handlers: new Map<string, Array<(event: { payload: any }) => void>>(),
}));

function emitBus(event: string, payload: unknown) {
  for (const handler of busMock.handlers.get(event) ?? []) handler({ payload });
}

vi.mock('@/lib/supabase', () => {
  const builder = (table: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = vi.fn(() => {
      if (table === 'profiles') return chain;
      // notifications / messages are head+count queries and resolve directly
      return Object.assign(Promise.resolve({ count: 0, error: null }), chain);
    });
    chain.eq = vi.fn(() => {
      if (table === 'profiles') return chain;
      return Object.assign(Promise.resolve({ count: 0, error: null }), chain);
    });
    chain.maybeSingle = vi.fn(() => Promise.resolve(supabaseMock.profileResult));
    void self;
    return chain;
  };
  return { supabase: { from: vi.fn((table: string) => builder(table)) } };
});

vi.mock('@/utils/errorReporter', () => ({
  reportError: vi.fn((e: unknown, ctx: string) => {
    reported.calls.push([e, ctx]);
  }),
  reportWarning: vi.fn(),
}));

vi.mock('@/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn((event: string, handler: (event: { payload: any }) => void) => {
      const handlers = busMock.handlers.get(event) ?? [];
      handlers.push(handler);
      busMock.handlers.set(event, handlers);
      return () => {
        const index = handlers.indexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
      };
    }),
    getOrCreateChannel: vi.fn(() => ({
      on: vi.fn(function (this: unknown) {
        return this;
      }),
      subscribe: vi.fn(),
    })),
    removeRegisteredChannel: vi.fn(),
  },
}));

const USER = '47965354-0e56-43ef-931c-ddaab82af765';
const OTHER_USER = '00000000-0000-0000-0000-000000000999';
const PROFILE_PHOTO = '/profile-photos/player.jpg';
const AVATAR = '/avatars/table/free_owl@2x.webp';

async function freshStore() {
  vi.resetModules();
  reported.calls = [];
  const mod = await import('@/stores/useHeaderDataStore');
  return mod.useHeaderDataStore;
}

/** The store writes through localStorage; jsdom gives us a real one. */
function seedCache(userId: string, url: string) {
  localStorage.setItem('ca-header-portrait-cache-v2', JSON.stringify({ u: userId, a: url }));
}

describe('header avatar resilience', () => {
  beforeEach(() => {
    localStorage.clear();
    busMock.handlers.clear();
    supabaseMock.profileResult = { data: null, error: null };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports a rejected avatar read instead of swallowing it', async () => {
    const useHeaderDataStore = await freshStore();
    supabaseMock.profileResult = {
      data: null,
      error: { code: '42501', message: 'permission denied for column arena_avatar_url' },
    };

    useHeaderDataStore.getState().loadOnce(USER);
    await vi.waitFor(() => {
      expect(reported.calls.some(([, ctx]) => ctx === 'useHeaderDataStore.avatar_fetch')).toBe(
        true
      );
    });
  });

  it('does not erase a cached avatar when the read is rejected', async () => {
    seedCache(USER, AVATAR);
    const useHeaderDataStore = await freshStore();
    supabaseMock.profileResult = {
      data: null,
      error: { code: '42501', message: 'permission denied' },
    };

    useHeaderDataStore.getState().loadOnce(USER);
    expect(useHeaderDataStore.getState().avatarUrl).toBe(AVATAR);

    await vi.waitFor(() => {
      expect(reported.calls.length).toBeGreaterThan(0);
    });
    // Still there. A failure is not evidence the player has no avatar.
    expect(useHeaderDataStore.getState().avatarUrl).toBe(AVATAR);
  });

  it('paints the cached avatar on the first frame, before any fetch resolves', async () => {
    seedCache(USER, AVATAR);
    const useHeaderDataStore = await freshStore();

    // Synchronous — this is the whole point. No await.
    useHeaderDataStore.getState().loadOnce(USER);
    expect(useHeaderDataStore.getState().avatarUrl).toBe(AVATAR);
  });

  it('never shows one account the cached avatar of another', async () => {
    seedCache(OTHER_USER, AVATAR);
    const useHeaderDataStore = await freshStore();

    useHeaderDataStore.getState().loadOnce(USER);
    expect(useHeaderDataStore.getState().avatarUrl).toBeNull();
  });

  it('lets a successful read clear an avatar that really was removed', async () => {
    seedCache(USER, AVATAR);
    const useHeaderDataStore = await freshStore();
    supabaseMock.profileResult = { data: { avatar_url: null }, error: null };

    useHeaderDataStore.getState().loadOnce(USER);
    await vi.waitFor(() => {
      expect(useHeaderDataStore.getState().avatarUrl).toBeNull();
    });
    expect(localStorage.getItem('ca-header-portrait-cache-v2')).toBeNull();
  });

  it('drops the cached avatar on teardown so the next login starts clean', async () => {
    seedCache(USER, AVATAR);
    const useHeaderDataStore = await freshStore();

    useHeaderDataStore.getState().loadOnce(USER);
    useHeaderDataStore.getState().teardown();

    expect(localStorage.getItem('ca-header-portrait-cache-v2')).toBeNull();
    expect(useHeaderDataStore.getState().avatarUrl).toBeNull();
  });

  it('keeps an optimistic avatar visible when the initial read returns an older value', async () => {
    const useHeaderDataStore = await freshStore();
    supabaseMock.profileResult = {
      data: {
        avatar_url: PROFILE_PHOTO,
        arena_avatar_url: '/avatars/table/old.webp',
        use_avatar_as_profile_pic: true,
      },
      error: null,
    };

    useHeaderDataStore.getState().loadOnce(USER);
    await vi.waitFor(() => {
      expect(useHeaderDataStore.getState().avatarUrl).toBe('/avatars/table/old.webp');
    });
    emitBus('CUSTOMIZATION_MUTATION_STATE', {
      kind: 'player-appearance',
      scope: USER,
      mutationId: 'avatar-2',
      state: 'pending',
    });
    emitBus('PLAYER_APPEARANCE_CHANGED', {
      userId: USER,
      avatar: '/avatars/table/new.webp',
      mutationId: 'avatar-2',
      source: 'avatar-picker',
    });

    await vi.waitFor(() => {
      expect(useHeaderDataStore.getState().avatarUrl).toBe('/avatars/table/new.webp');
    });
  });

  it('uses the real profile photo globally by default', async () => {
    const useHeaderDataStore = await freshStore();
    supabaseMock.profileResult = {
      data: {
        avatar_url: PROFILE_PHOTO,
        arena_avatar_url: AVATAR,
        use_avatar_as_profile_pic: false,
      },
      error: null,
    };

    useHeaderDataStore.getState().loadOnce(USER);
    await vi.waitFor(() => {
      expect(useHeaderDataStore.getState().avatarUrl).toBe(PROFILE_PHOTO);
    });
  });

  it('uses the Arena avatar only after the user enables Use Avatar', async () => {
    const useHeaderDataStore = await freshStore();
    supabaseMock.profileResult = {
      data: {
        avatar_url: PROFILE_PHOTO,
        arena_avatar_url: AVATAR,
        use_avatar_as_profile_pic: true,
      },
      error: null,
    };

    useHeaderDataStore.getState().loadOnce(USER);
    await vi.waitFor(() => {
      expect(useHeaderDataStore.getState().avatarUrl).toBe(AVATAR);
    });
  });

  it('does not let an Arena avatar event replace the global photo without opt-in', async () => {
    const useHeaderDataStore = await freshStore();
    supabaseMock.profileResult = {
      data: {
        avatar_url: PROFILE_PHOTO,
        arena_avatar_url: AVATAR,
        use_avatar_as_profile_pic: false,
      },
      error: null,
    };
    useHeaderDataStore.getState().loadOnce(USER);
    await vi.waitFor(() => expect(useHeaderDataStore.getState().avatarUrl).toBe(PROFILE_PHOTO));

    emitBus('PLAYER_APPEARANCE_CHANGED', {
      userId: USER,
      avatar: '/avatars/table/new.webp',
      source: 'avatar-picker',
    });

    expect(useHeaderDataStore.getState().avatarUrl).toBe(PROFILE_PHOTO);
    expect(useHeaderDataStore.getState().arenaAvatarUrl).toBe('/avatars/table/new.webp');
  });

  it('activates VIP only while the entitlement has not expired', async () => {
    const { resolveActiveVip } = await import('@/stores/useHeaderDataStore');
    expect(resolveActiveVip(true, null, 100)).toBe(true);
    expect(resolveActiveVip(true, '2030-01-01T00:00:00.000Z', 100)).toBe(true);
    expect(resolveActiveVip(true, '2020-01-01T00:00:00.000Z', Date.now())).toBe(false);
    expect(resolveActiveVip(false, '2030-01-01T00:00:00.000Z', 100)).toBe(false);
  });

  it('does not apply an avatar event from another signed-in account', async () => {
    const useHeaderDataStore = await freshStore();
    useHeaderDataStore.getState().loadOnce(USER);
    emitBus('PLAYER_APPEARANCE_CHANGED', {
      userId: OTHER_USER,
      avatar: AVATAR,
      source: 'avatar-picker',
    });
    expect(useHeaderDataStore.getState().avatarUrl).toBeNull();
  });
});
