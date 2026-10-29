import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { CommunityCards } from '../../src/components/table/CommunityCards';
const sound = vi.hoisted(() => ({ isEnabled: () => true, playCommunityCard: vi.fn() }));
const haptics = vi.hoisted(() => ({ light: vi.fn(), medium: vi.fn(), strong: vi.fn() }));
vi.mock('../../src/hooks/useDeckStyle', () => ({ useDeckStyle: () => '4color' }));
vi.mock('../../src/services/SoundService', () => ({ soundService: sound, haptic: haptics }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  document.documentElement.style.removeProperty('--animation-speed');
  vi.restoreAllMocks();
});
const cards = [
  { rank: 'A', suit: 's' },
  { rank: 'K', suit: 'd' },
] as any;
it('plays one simultaneous cue at the chosen-speed turn, not when backs first appear', async () => {
  vi.useFakeTimers();
  document.documentElement.style.setProperty('--animation-speed', '2');
  const view = render(
    <CommunityCards cards={[]} stage="preflop" rabbitCards={cards} rabbitHandId={41} playSounds />
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(239);
  });
  expect(sound.playCommunityCard).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(sound.playCommunityCard).toHaveBeenCalledTimes(1);
  expect(haptics.light).toHaveBeenCalledTimes(1);
  view.rerender(
    <CommunityCards
      cards={[]}
      stage="preflop"
      rabbitCards={[...cards]}
      rabbitHandId={41}
      handId={42}
      playSounds
    />
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(sound.playCommunityCard).toHaveBeenCalledTimes(1);
  view.rerender(
    <CommunityCards
      cards={[]}
      stage="preflop"
      rabbitCards={cards}
      rabbitHandId={42}
      handId={43}
      playSounds
    />
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(240);
  });
  expect(sound.playCommunityCard).toHaveBeenCalledTimes(2);
});
it('does not queue a hidden-page sound to burst on resume', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  render(
    <CommunityCards cards={[]} stage="preflop" rabbitCards={cards} rabbitHandId={41} playSounds />
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120);
  });
  expect(sound.playCommunityCard).not.toHaveBeenCalled();
});

it('enabling sound after an already-visible muted reveal does not replay its cue', async () => {
  vi.useFakeTimers();
  const view = render(
    <CommunityCards
      cards={[]}
      stage="preflop"
      rabbitCards={cards}
      rabbitHandId={41}
      playSounds={false}
    />
  );
  view.rerender(
    <CommunityCards cards={[]} stage="preflop" rabbitCards={cards} rabbitHandId={41} playSounds />
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(sound.playCommunityCard).not.toHaveBeenCalled();
});
