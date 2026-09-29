/**
 * THE CHEST REVEALS ITS PRIZE AT THE UNIT THE EVENT PAYS IN (2026-09-21).
 *
 * A Diamond chest holds whole Diamonds (`a_diamond_mystery_chest_holds_whole_
 * diamonds`), and the reveal is the moment the Diamond Arena exists for, so its
 * figure must say what was won. A chip chest prints exactly what it printed
 * before, currency mark included. An unread arena prints no figure at all.
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MysteryBountyChest, {
  type MysteryChestData,
} from '../../src/components/tournament/MysteryBountyChest';
import { CHIP_UNIT_CENTS, DIAMOND_UNIT_CENTS } from '../../server/src/tournament/tournamentUnit';

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

const CHEST: MysteryChestData = {
  awardId: 'award-1',
  knockerUserId: 'winner',
  knockerName: 'Winner',
  eliminatedName: 'Opponent',
  amount: 500,
  tier: 'minor',
};

const SPLIT: MysteryChestData = {
  ...CHEST,
  awardId: 'award-2',
  recipients: [
    { userId: 'winner', name: 'Winner', amount: 250 },
    { userId: 'other', name: 'Other', amount: 250 },
  ],
};

/** Land the chest, tap it open, and let the count-up finish. */
function reveal(data: MysteryChestData, unitCents: number | null) {
  const view = render(
    <MysteryBountyChest
      data={data}
      unitCents={unitCents}
      viewerUserId="winner"
      onDone={vi.fn()}
      playSounds={false}
    />
  );
  act(() => vi.advanceTimersByTime(700));
  fireEvent.click(view.container.querySelector('button.mbc__chest')!);
  act(() => vi.advanceTimersByTime(3_000));
  return view.container;
}

const figure = (container: HTMLElement) =>
  container.querySelector('.mbc__amount')?.textContent ?? null;
const splitFigures = (container: HTMLElement) =>
  [...container.querySelectorAll('.mbc__split-amount')].map((el) => el.textContent);

describe('the mystery chest reveals its prize at the event unit', () => {
  it('a chip chest prints exactly what it printed before, currency mark and all', () => {
    expect(figure(reveal({ ...CHEST, currency: '$' }, CHIP_UNIT_CENTS))).toBe('$500');
    cleanup();
    expect(figure(reveal(CHEST, CHIP_UNIT_CENTS))).toBe('500');
  });

  it('a chip split prints each share exactly as before', () => {
    expect(splitFigures(reveal(SPLIT, CHIP_UNIT_CENTS))).toEqual(['250', '250']);
  });

  it('a Diamond chest prints whole Diamonds and names them', () => {
    expect(figure(reveal(CHEST, DIAMOND_UNIT_CENTS))).toBe('500 Diamonds');
    cleanup();
    expect(figure(reveal({ ...CHEST, amount: 12500 }, DIAMOND_UNIT_CENTS))).toBe('12,500 Diamonds');
  });

  it('a chip currency mark never rides on a Diamond', () => {
    const container = reveal({ ...CHEST, currency: '$' }, DIAMOND_UNIT_CENTS);
    expect(figure(container)).toBe('500 Diamonds');
    expect(container.textContent).not.toContain('$');
    expect(container.textContent).not.toMatch(/Chips/);
  });

  it('a Diamond split names every share', () => {
    expect(splitFigures(reveal(SPLIT, DIAMOND_UNIT_CENTS))).toEqual([
      '250 Diamonds',
      '250 Diamonds',
    ]);
  });

  it('an unread arena reveals the chest with no figure in it', () => {
    const container = reveal({ ...SPLIT, currency: '$' }, null);
    expect(container.querySelector('.mbc__reveal')).not.toBeNull();
    expect(figure(container)).toBe('');
    expect(splitFigures(container)).toEqual(['', '']);
    // The names still say who shares it; only the figure waits for its unit.
    expect(container.querySelector('.mbc__split')?.textContent).toContain('Other');
    expect(container.textContent).not.toContain('$');
  });
});
