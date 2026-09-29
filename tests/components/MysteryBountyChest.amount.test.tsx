import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MysteryBountyChest, {
  type MysteryChestData,
} from '../../src/components/tournament/MysteryBountyChest';
import { CHIP_UNIT_CENTS } from '../../server/src/tournament/tournamentUnit';

vi.mock('../../src/services/SoundService', () => ({ soundService: {} }));
vi.mock('../../src/utils/animationSpeed', () => ({
  getAnimationSpeed: () => 1,
  prefersReducedMotion: () => false,
}));
vi.mock('../../src/utils/vibrationGate', () => ({ fireVibration: vi.fn() }));
vi.mock('../../src/components/tournament/CoinShower', () => ({ default: () => null }));
vi.mock('../../src/utils/mediaBase', () => ({ mediaUrl: (path: string) => path }));
vi.mock('canvas-confetti', () => ({ default: Object.assign(vi.fn(), { reset: vi.fn() }) }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('MysteryBountyChest authoritative amount delivery', () => {
  const pending: MysteryChestData = {
    awardId: 'award-1',
    knockerUserId: 'winner',
    knockerName: 'Winner',
    eliminatedName: 'Opponent',
    amount: 0,
    amountPending: true,
    tier: 'minor',
    currency: '$',
  };

  it.each<[string, number]>([
    ['during the lid swing', 500],
    ['during the count-up', 1_800],
    ['after the count-up', 3_000],
  ])('finishes on the received amount when it arrives %s', (_label, delay) => {
    const onDone = vi.fn();
    const view = (data: MysteryChestData) => (
      <MysteryBountyChest
        data={data}
        unitCents={CHIP_UNIT_CENTS}
        viewerUserId="winner"
        onDone={onDone}
        playSounds={false}
      />
    );
    const { container, rerender } = render(view(pending));
    act(() => vi.advanceTimersByTime(700));
    fireEvent.click(container.querySelector('button.mbc__chest')!);
    act(() => vi.advanceTimersByTime(delay));
    rerender(view({ ...pending, amount: 500, amountPending: false }));
    act(() => vi.advanceTimersByTime(3_000));

    expect(container.querySelector('.mbc__amount')?.textContent).toBe('$500');
    expect(onDone).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(4_000));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
