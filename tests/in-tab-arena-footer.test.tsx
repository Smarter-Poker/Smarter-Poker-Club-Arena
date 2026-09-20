import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import {
  publishInTabLobbyActive,
  resetInTabLobbyActiveForTests,
  useInTabLobbyActive,
  useInTabLobbyClubId,
} from '../src/components/club/inTabLobbySurface';
import {
  shouldShowClubFooterFor,
  shouldShowDiamondFooterFor,
} from '../src/components/club/clubFooterVisibility';

afterEach(resetInTabLobbyActiveForTests);

it('follows arena changes while the same lobby tab remains active', () => {
  const hook = renderHook(() => ({ active: useInTabLobbyActive(), clubId: useInTabLobbyClubId() }));
  const visible = () =>
    shouldShowClubFooterFor(
      '/table/running',
      hook.result.current.active,
      hook.result.current.clubId
    );
  /* The Diamond bar is the other half of the same answer: it stands exactly
     where the chip bar does not, on the Diamond lobby tab. */
  const diamondVisible = () =>
    shouldShowDiamondFooterFor(
      '/table/running',
      '',
      hook.result.current.active,
      hook.result.current.clubId
    );
  act(() => publishInTabLobbyActive(true, 'shark-club'));
  expect(hook.result.current.clubId).toBe('shark-club');
  expect(visible()).toBe(true);
  expect(diamondVisible()).toBe(false);
  for (const diamond of ['diamond-arena', '002c2d27-9584-4e52-835a-bb2be148fc81']) {
    act(() => publishInTabLobbyActive(true, diamond));
    expect(hook.result.current.clubId).toBe(diamond);
    expect(visible()).toBe(false);
    expect(diamondVisible()).toBe(true);
  }
  act(() => publishInTabLobbyActive(true, null));
  expect(visible()).toBe(false);
  expect(diamondVisible()).toBe(false);
  act(() => publishInTabLobbyActive(true, 'club-jaqk'));
  expect(hook.result.current.clubId).toBe('club-jaqk');
  expect(visible()).toBe(true);
  expect(diamondVisible()).toBe(false);
  act(() => publishInTabLobbyActive(false));
  expect(hook.result.current).toEqual({ active: false, clubId: undefined });
  expect(visible()).toBe(false);
  expect(diamondVisible()).toBe(false);
  hook.unmount();
});
