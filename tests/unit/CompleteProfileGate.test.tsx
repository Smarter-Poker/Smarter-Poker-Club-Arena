/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE PROFILE GATE — two bugs that stopped people playing (2026-08-30)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 1. "Select Avatar" silently failed. AvatarGallery portals to document.body at
 *    z-index 9999; CompleteProfileModal's overlay is a sibling at 10000 with an
 *    85% black fill and an 8px backdrop blur. The gallery opened every time and
 *    was painted underneath it, while AvatarGallery locked body scroll and
 *    trapped focus in a dialog nobody could see.
 *
 * 2. The gate stopped members who had already passed it. It decided from the
 *    Zustand user, which four hydration paths seed with a session stub whose
 *    avatar_url is null — the avatar lives in profiles.arena_avatar_url and a
 *    JWT does not carry it.
 *
 * Both pins are behavioural: the first asserts the two surfaces are never on
 * screen together, the second asserts the gate never opens for a complete row
 * no matter what the store says.
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  profileRow: { username: 'danimal5022', arena_avatar_url: '/avatars/table/free_samurai@2x.webp' },
  profileError: null as any,
  profileFailuresRemaining: 0,
  profileReadCount: 0,
  user: {
    id: 'user-1',
    username: 'danimal5022',
    display_name: 'Danimal Bekavac',
    avatar_url: '/avatars/table/free_samurai@2x.webp',
    vip_level: 'bronze',
  } as any,
  setUser: vi.fn(),
  setUserAvatar: vi.fn(),
}));

vi.mock('../../src/lib/supabase', () => {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    ilike: () => builder,
    neq: () => builder,
    update: () => builder,
    maybeSingle: () => {
      mocks.profileReadCount += 1;
      if (mocks.profileFailuresRemaining > 0) {
        mocks.profileFailuresRemaining -= 1;
        return Promise.resolve({
          data: null,
          error: { code: '08006', message: 'connection failure' },
        });
      }
      return Promise.resolve({ data: mocks.profileRow, error: mocks.profileError });
    },
  };
  return { supabase: { from: () => builder } };
});

vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: () => ({ user: mocks.user, setUser: mocks.setUser }),
}));

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/services/AvatarService', () => ({
  avatarService: { setUserAvatar: mocks.setUserAvatar },
}));

// The gallery's own internals are covered by AvatarGalleryAccessibility. Here it
// only has to be a portalled, fixed-position surface so the stacking question is
// the same one the browser asks.
vi.mock('../../src/components/customization/AvatarGallery', () => ({
  AvatarGallery: ({ isOpen, onClose }: any) =>
    isOpen ? (
      <div data-testid="avatar-gallery">
        <button onClick={onClose}>Close Gallery</button>
      </div>
    ) : null,
}));

import CompleteProfileModal, {
  useCompleteProfile,
} from '../../src/components/modals/CompleteProfileModal';

beforeEach(() => {
  vi.useRealTimers();
  mocks.profileError = null;
  mocks.profileFailuresRemaining = 0;
  mocks.profileReadCount = 0;
  mocks.profileRow = {
    username: 'danimal5022',
    arena_avatar_url: '/avatars/table/free_samurai@2x.webp',
  };
  mocks.setUser.mockReset();
  mocks.setUserAvatar.mockReset();
  mocks.setUserAvatar.mockResolvedValue(true);
});

describe('Choosing an avatar is never hidden behind the gate that demands one', () => {
  it('takes the profile modal off screen while the gallery is open, and brings it back', async () => {
    render(<CompleteProfileModal isOpen onComplete={vi.fn()} />);

    expect(screen.getByText('Complete Your Profile')).toBeTruthy();
    expect(screen.queryByTestId('avatar-gallery')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Avatar/i }));

    // The two surfaces are never both mounted: whichever is not being used
    // steps off the screen rather than stacking underneath.
    await waitFor(() => expect(screen.getByTestId('avatar-gallery')).toBeTruthy());
    expect(screen.queryByText('Complete Your Profile')).toBeNull();

    fireEvent.click(screen.getByText('Close Gallery'));

    await waitFor(() => expect(screen.getByText('Complete Your Profile')).toBeTruthy());
    expect(screen.queryByTestId('avatar-gallery')).toBeNull();
  });

  it('keeps the alias the player typed while the gallery is up', async () => {
    render(<CompleteProfileModal isOpen onComplete={vi.fn()} />);

    const input = screen.getByPlaceholderText('E.G. SharkPro99') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'RiverShark42' } });

    fireEvent.click(screen.getByRole('button', { name: /Avatar/i }));
    await waitFor(() => expect(screen.getByTestId('avatar-gallery')).toBeTruthy());
    fireEvent.click(screen.getByText('Close Gallery'));

    await waitFor(() =>
      expect((screen.getByPlaceholderText('E.G. SharkPro99') as HTMLInputElement).value).toBe(
        'RiverShark42'
      )
    );
  });
});

describe('The gate reads the profile row, not the session stub', () => {
  it('does not open for a member whose row has an alias and an arena avatar', async () => {
    const { result } = renderHook(() => useCompleteProfile({ id: 'user-1' }));

    await waitFor(() => expect(result.current.isReady).toBe(true));
    expect(result.current.showProfileModal).toBe(false);
    expect(result.current.profileStatus).toBe('complete');
  });

  it('does not open just because the store user arrived as a stub', async () => {
    // Exactly what IdentityDNA/AuthGuard/useAuthUser write before the profile
    // lands: the email prefix as a username and a null avatar.
    const stub = { id: 'user-1', username: 'daniel', avatar_url: null };

    const { result } = renderHook(() => useCompleteProfile(stub));

    await waitFor(() => expect(result.current.isReady).toBe(true));
    expect(result.current.showProfileModal).toBe(false);
  });

  it('opens for a row that really is incomplete', async () => {
    mocks.profileRow = { username: 'Player4821', arena_avatar_url: null } as any;

    const { result } = renderHook(() => useCompleteProfile({ id: 'user-2' }));

    await waitFor(() => expect(result.current.isReady).toBe(true));
    expect(result.current.showProfileModal).toBe(true);
    expect(result.current.profileStatus).toBe('incomplete');
  });

  it('opens for a real alias with no arena avatar', async () => {
    mocks.profileRow = { username: 'danimal5022', arena_avatar_url: '' } as any;

    const { result } = renderHook(() => useCompleteProfile({ id: 'user-3' }));

    await waitFor(() => expect(result.current.isReady).toBe(true));
    expect(result.current.showProfileModal).toBe(true);
  });

  it('recovers the same signed-in account after a transient profile read failure', async () => {
    vi.useFakeTimers();
    mocks.profileFailuresRemaining = 1;

    const { result } = renderHook(() => useCompleteProfile({ id: 'user-4' }));

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(result.current.isReady).toBe(true);
    expect(result.current.showProfileModal).toBe(false);
    expect(result.current.profileStatus).toBe('complete');
    expect(mocks.profileReadCount).toBe(2);
  });

  it('never gates on a query that remains unavailable after bounded retries', async () => {
    vi.useFakeTimers();
    mocks.profileError = { code: '08006', message: 'connection failure' };

    const { result } = renderHook(() => useCompleteProfile({ id: 'user-4' }));

    await act(async () => await Promise.resolve());
    for (const delay of [1_000, 2_000, 4_000]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay);
        await Promise.resolve();
      });
    }
    expect(mocks.profileReadCount).toBe(4);
    expect(result.current.isReady).toBe(true);
    expect(result.current.showProfileModal).toBe(false);
    expect(result.current.profileStatus).toBe('unavailable');
  });

  it('does not re-litigate the gate when the store rewrites the user on token refresh', async () => {
    const { result, rerender } = renderHook(({ u }) => useCompleteProfile(u), {
      initialProps: { u: { id: 'user-1', username: 'danimal5022', avatar_url: 'x' } as any },
    });

    await waitFor(() => expect(result.current.isReady).toBe(true));

    // TOKEN_REFRESHED -> hydrateUserFromSession() replaces the object with a
    // stub. Same account, so the gate must not ask again and must not flicker.
    await act(async () => {
      rerender({ u: { id: 'user-1', username: 'daniel', avatar_url: null } as any });
    });

    expect(result.current.showProfileModal).toBe(false);
  });
});
