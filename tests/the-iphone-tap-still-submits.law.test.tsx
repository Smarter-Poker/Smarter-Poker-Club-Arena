/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A TAP ON ENTER ARENA ON AN iPHONE FINISHES THE PROFILE (Dan 2026-10-17)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "THE LAST TWO PLAYERS TO SIGN UP WITH MY REFERRAL LINK HAVE
 * BOTH STATED THAT AFTER THEY GOT THE CODE VERIFIED THROUGH THE EMAIL, AND GOT
 * TO THE PICK AVATAR / ALIAS THAT IT TOOK AN EXTREMELY LONG TIME TO
 * LOAD/FINISH. THIS NEEDS TO UPDATE INSTANTLY IN REAL TIME ... THEN HARD CODE
 * FIX IT SO THIS CAN NEVER HAPPEN AGIAN".
 *
 * What happened, read from the edge logs: TomTomTamale and Dinodollars, both on
 * iPhone Safari, saved an avatar in under a second and then tapped ENTER ARENA.
 * No request left the phone. Every plate in a pop-up carries TapHaptic, an
 * invisible native switch over the plate's face (the only haptic an iPhone
 * browser can play), and a click has ONE activation target: that checkbox. So
 * the `type="submit" form="complete-profile-form"` plate never submitted. Tom
 * sat on the screen for 35 minutes and Dino for 4, until each reloaded and the
 * gate found the avatar already saved. Every computer test passed, because
 * TapHaptic only exists on an iPhone browser.
 *
 * These pins run the REAL modal with an iPhone user agent, so the switch is
 * really there, and tap THE SWITCH - where an iPhone finger lands.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1';

const mocks = vi.hoisted(() => ({
  user: null as any,
  setUser: vi.fn(),
  update: vi.fn(),
  ilike: vi.fn(),
  setUserAvatar: vi.fn(),
  takenAliases: new Set<string>(),
}));

vi.mock('../src/lib/supabase', () => {
  const builder = (): any => {
    const b: any = {
      _pattern: null as string | null,
      select: () => b,
      eq: () => b,
      neq: () => b,
      ilike: (_col: string, pattern: string) => {
        mocks.ilike(pattern);
        b._pattern = pattern;
        return b;
      },
      update: (patch: unknown) => {
        mocks.update(patch);
        return { eq: () => Promise.resolve({ error: null }) };
      },
      maybeSingle: () => {
        // An escaped pattern only matches the literal alias.
        const literal = String(b._pattern || '').replace(/\\(.)/g, '$1');
        return Promise.resolve({
          data: mocks.takenAliases.has(literal.toLowerCase()) ? { id: 'someone-else' } : null,
          error: null,
        });
      },
    };
    return b;
  };
  return { supabase: { from: () => builder() } };
});

vi.mock('../src/stores/useUserStore', () => ({
  useUserStore: () => ({ user: mocks.user, setUser: mocks.setUser }),
}));
vi.mock('../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../src/services/AvatarService', () => ({
  avatarService: { setUserAvatar: mocks.setUserAvatar },
}));
vi.mock('../src/components/customization/AvatarGallery', () => ({
  AvatarGallery: ({ isOpen, onClose, onAvatarChanged }: any) =>
    isOpen ? (
      <div data-testid="avatar-gallery">
        <button
          onClick={() => {
            onAvatarChanged('/avatars/table/free_lion@2x.webp');
            onClose();
          }}
        >
          Done
        </button>
      </div>
    ) : null,
}));

import CompleteProfileModal from '../src/components/modals/CompleteProfileModal';
import { escapeLikePattern, isOfferableAlias } from '../src/utils/aliasRules';
import { __resetVibrationCoalescing } from '../src/utils/vibrationGate';

const enterArena = () => screen.getByRole('button', { name: /Enter Arena/ });
const switchOn = (el: HTMLElement) => el.querySelector('input[data-tap-haptic]') as HTMLElement;
const aliasField = () => screen.getByPlaceholderText('E.G. SharkPro99') as HTMLInputElement;

beforeEach(() => {
  localStorage.clear();
  __resetVibrationCoalescing();
  vi.stubGlobal('navigator', { userAgent: IPHONE, maxTouchPoints: 5 });
  mocks.user = {
    id: 'user-tom',
    username: 'TomTomTamale',
    display_name: null,
    avatar_url: '/avatars/table/free_lion@2x.webp',
  };
  mocks.setUser.mockReset();
  mocks.update.mockReset();
  mocks.ilike.mockReset();
  mocks.setUserAvatar.mockReset();
  mocks.setUserAvatar.mockResolvedValue(true);
  mocks.takenAliases = new Set();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ENTER ARENA on an iPhone browser', () => {
  it('the plate really carries the haptic switch on an iPhone (the condition that broke it)', async () => {
    render(<CompleteProfileModal isOpen onComplete={vi.fn()} />);
    await waitFor(() => expect(switchOn(enterArena())).not.toBeNull());
  });

  it('a finger on the switch saves the profile and lets the player in, at once', async () => {
    const onComplete = vi.fn();
    render(<CompleteProfileModal isOpen onComplete={onComplete} />);
    await waitFor(() => expect(switchOn(enterArena())).not.toBeNull());
    await waitFor(() => expect(enterArena()).not.toBeDisabled());

    fireEvent.click(switchOn(enterArena()));

    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'TomTomTamale' })
    );
    // No "Welcome" pause between the write and the way in.
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });

  it('the whole path: pick an avatar, come back, tap ENTER ARENA, and it saves once', async () => {
    mocks.user = { ...mocks.user, avatar_url: null };
    const onComplete = vi.fn();
    const { rerender } = render(<CompleteProfileModal isOpen onComplete={onComplete} />);

    fireEvent.click(screen.getByRole('button', { name: /Avatar/ }));
    await waitFor(() => expect(screen.getByTestId('avatar-gallery')).toBeTruthy());
    fireEvent.click(screen.getByText('Done'));
    // The gallery writes the store; the store hands the modal a NEW user object.
    mocks.user = { ...mocks.user, avatar_url: '/avatars/table/free_lion@2x.webp' };
    rerender(<CompleteProfileModal isOpen onComplete={onComplete} />);

    await waitFor(() => expect(switchOn(enterArena())).not.toBeNull());
    fireEvent.click(switchOn(enterArena()));
    fireEvent.click(switchOn(enterArena()));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });
});

describe('the form never fights the player', () => {
  it('an alias the player typed survives the store rewriting the user (choosing an avatar)', async () => {
    const { rerender } = render(<CompleteProfileModal isOpen onComplete={vi.fn()} />);
    fireEvent.change(aliasField(), { target: { value: 'TomTom_Tamale' } });

    await act(async () => {
      mocks.user = { ...mocks.user, avatar_url: '/avatars/table/free_chef@2x.webp' };
      rerender(<CompleteProfileModal isOpen onComplete={vi.fn()} />);
    });

    expect(aliasField().value).toBe('TomTom_Tamale');
  });

  it('a session stub is not offered as the alias, and the real profile replaces it when it lands', async () => {
    mocks.user = { ...mocks.user, username: 'michael.alan.reynolds' };
    const { rerender } = render(<CompleteProfileModal isOpen onComplete={vi.fn()} />);
    expect(aliasField().value).toBe('');

    await act(async () => {
      mocks.user = { ...mocks.user, username: 'TomTomTamale' };
      rerender(<CompleteProfileModal isOpen onComplete={vi.fn()} />);
    });
    expect(aliasField().value).toBe('TomTomTamale');
  });

  it('an underscore is matched literally: Tom_Tamale is not Taken because TomXTamale exists', async () => {
    mocks.takenAliases = new Set(['tomxtamale']);
    render(<CompleteProfileModal isOpen onComplete={vi.fn()} />);
    fireEvent.change(aliasField(), { target: { value: 'Tom_Tamale' } });

    await waitFor(() => expect(mocks.ilike).toHaveBeenCalledWith('Tom\\_Tamale'));
    await waitFor(() => expect(screen.getByText('Available')).toBeTruthy());
  });

  it('the alias helpers say what they mean', () => {
    expect(escapeLikePattern('a_b%c\\d')).toBe('a\\_b\\%c\\\\d');
    expect(isOfferableAlias('TomTomTamale')).toBe(true);
    expect(isOfferableAlias('michael.alan.reynolds')).toBe(false);
    expect(isOfferableAlias('Player408df6b55')).toBe(false);
    expect(isOfferableAlias('ab')).toBe(false);
  });
});

describe('the mechanism stays', () => {
  it('TapHaptic finishes its host native submit/reset, so no submit plate can go dead again', () => {
    const source = readFileSync(
      resolve(__dirname, '../src/components/haptics/TapHaptic.tsx'),
      'utf8'
    );
    expect(source).toMatch(/finishHostActivation\(event\.currentTarget, event\.nativeEvent\)/);
    expect(source).toMatch(/requestSubmit\(host\)/);
  });
});
