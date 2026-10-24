/**
 * PICK 1 OF 3 (Dan 2026-10-22): the knockout is offered three sealed chests,
 * picks one, wins what is inside it, and is then shown what the other two held.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MysteryBountyChest, {
  parseMysteryChestOffer,
  winnerAutoOpenMs,
  type MysteryChestData,
} from '../../src/components/tournament/MysteryBountyChest';
import { CHIP_UNIT_CENTS } from '../../server/src/tournament/tournamentUnit';

vi.mock('../../src/services/SoundService', () => ({ soundService: {} }));
vi.mock('../../src/utils/animationSpeed', () => ({
  getAnimationSpeed: () => 1,
  prefersReducedMotion: () => false,
}));
vi.mock('../../src/utils/vibrationGate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/vibrationGate')>()),
  fireVibration: vi.fn(),
}));
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

const offered: MysteryChestData = {
  awardId: 'award-1',
  knockerUserId: 'winner',
  knockerName: 'Winner',
  eliminatedName: 'Opponent',
  amount: 0,
  amountPending: true,
  offerSlots: 3,
};

function view(data: MysteryChestData, viewer: string, extra: Record<string, unknown> = {}) {
  return (
    <MysteryBountyChest
      data={data}
      unitCents={CHIP_UNIT_CENTS}
      viewerUserId={viewer}
      onDone={vi.fn()}
      playSounds={false}
      {...extra}
    />
  );
}

describe('pick 1 of 3', () => {
  it('offers three sealed chests to the player who made the knockout', () => {
    const { container } = render(view(offered, 'winner'));
    act(() => vi.advanceTimersByTime(700));
    const picks = container.querySelectorAll('button.mbc__pick');
    expect(picks).toHaveLength(3);
    picks.forEach((b) => expect((b as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText('Pick 1 Of 3 Chests')).toBeTruthy();
  });

  it('records the picked slot with the reveal and tells the table which one', () => {
    const onRequestReveal = vi.fn();
    const onBroadcastOpen = vi.fn();
    const { container } = render(view(offered, 'winner', { onRequestReveal, onBroadcastOpen }));
    act(() => vi.advanceTimersByTime(700));
    fireEvent.click(container.querySelectorAll('button.mbc__pick')[1]);
    expect(onRequestReveal).toHaveBeenCalledTimes(1);
    expect(onRequestReveal).toHaveBeenCalledWith(2);
    expect(onBroadcastOpen).toHaveBeenCalledWith(2);
    // A second tap cannot pick again or re-reveal.
    fireEvent.click(container.querySelectorAll('button.mbc__pick')[0] ?? document.body);
    expect(onRequestReveal).toHaveBeenCalledTimes(1);
  });

  it('lets everyone else watch, but never pick', () => {
    const onRequestReveal = vi.fn();
    const { container } = render(view(offered, 'spectator', { onRequestReveal }));
    act(() => vi.advanceTimersByTime(700));
    const picks = container.querySelectorAll('button.mbc__pick');
    picks.forEach((b) => expect((b as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(picks[0]);
    expect(onRequestReveal).not.toHaveBeenCalled();
    expect(screen.getByText(/Winner Is Picking A Chest/)).toBeTruthy();
  });

  it('opens by itself if the player never picks, leaving the slot to the server', () => {
    const onRequestReveal = vi.fn();
    render(view(offered, 'winner', { onRequestReveal }));
    act(() => vi.advanceTimersByTime(700));
    act(() => vi.advanceTimersByTime(9_000));
    expect(onRequestReveal).toHaveBeenCalledWith(undefined);
  });

  it('shows what the two chests that were not picked held', () => {
    const { container, rerender } = render(view(offered, 'winner'));
    act(() => vi.advanceTimersByTime(700));
    fireEvent.click(container.querySelectorAll('button.mbc__pick')[0]);
    rerender(
      view(
        {
          ...offered,
          amount: 50,
          amountPending: false,
          pickedSlot: 1,
          choices: [
            { slot: 1, amount: 50, picked: true },
            { slot: 2, amount: 400, tierLabel: 'Major Prize', picked: false },
            { slot: 3, amount: 12, picked: false },
          ],
        },
        'winner'
      )
    );
    act(() => vi.advanceTimersByTime(4_000));
    expect(screen.getByText('The Other Chests Held')).toBeTruthy();
    const others = Array.from(container.querySelectorAll('.mbc__other-amount')).map(
      (n) => n.textContent
    );
    expect(others).toEqual(['400', '12']);
    expect(container.querySelector('.mbc__amount')?.textContent).toBe('50');
    // Every seat can tell which chest held the prize and which held the rest.
    expect(container.querySelector('.mbc__picked-slot')?.textContent).toBe('You Picked Chest 1');
    expect(
      Array.from(container.querySelectorAll('.mbc__other-slot')).map((n) => n.textContent)
    ).toEqual(['Chest 2', 'Chest 3']);
  });

  it('tells the rest of the table which chest the knockout picked', () => {
    const { container } = render(
      view(
        {
          ...offered,
          amount: 50,
          amountPending: false,
          pickedSlot: 3,
          choices: [
            { slot: 1, amount: 12, picked: false },
            { slot: 2, amount: 400, picked: false },
            { slot: 3, amount: 50, picked: true },
          ],
        },
        'spectator',
        { remoteOpened: true }
      )
    );
    act(() => vi.advanceTimersByTime(700));
    act(() => vi.advanceTimersByTime(5_000));
    expect(container.querySelector('.mbc__picked-slot')?.textContent).toBe('Winner Picked Chest 3');
  });

  it('is the single chest it always was when only one is on offer', () => {
    const { container } = render(view({ ...offered, offerSlots: 1 }, 'winner'));
    act(() => vi.advanceTimersByTime(700));
    expect(container.querySelectorAll('button.mbc__pick')).toHaveLength(0);
    expect(container.querySelector('button.mbc__chest')).toBeTruthy();
    expect(screen.getByText('Tap The Chest To Open')).toBeTruthy();
  });
});

describe('the chest is honest about who chose', () => {
  it('says which chest held the prize when nobody picked', () => {
    const { container } = render(
      view(
        {
          ...offered,
          amount: 50,
          amountPending: false,
          pickedSlot: 2,
          chosen: false,
          choices: [
            { slot: 1, amount: 12, picked: false },
            { slot: 2, amount: 50, picked: true },
            { slot: 3, amount: 400, picked: false },
          ],
        },
        'spectator',
        { remoteOpened: true }
      )
    );
    act(() => vi.advanceTimersByTime(700));
    act(() => vi.advanceTimersByTime(5_000));
    expect(container.querySelector('.mbc__picked-slot')?.textContent).toBe(
      'Chest 2 Held The Prize'
    );
  });

  it('closes the winner window inside the engine deadline at any animation speed', () => {
    for (const speed of [0.5, 1, 1.5, 2, 3]) {
      expect(winnerAutoOpenMs(speed)).toBeLessThanOrEqual(8200);
    }
    expect(winnerAutoOpenMs(0.5)).toBe(4500);
  });

  it('keeps one auto-open timer while the table re-renders', () => {
    const onRequestReveal = vi.fn();
    const { rerender } = render(view(offered, 'winner', { onRequestReveal }));
    act(() => vi.advanceTimersByTime(700));
    // TablePage hands a fresh arrow every render; the deadline must not move.
    for (let i = 0; i < 8; i += 1) {
      act(() => vi.advanceTimersByTime(1_000));
      rerender(view(offered, 'winner', { onRequestReveal: (s?: number) => onRequestReveal(s) }));
    }
    act(() => vi.advanceTimersByTime(400));
    expect(onRequestReveal).toHaveBeenCalledTimes(1);
  });
});

describe('reading the offer', () => {
  it('hides the amounts until the server shows them, and maps them when it does', () => {
    expect(parseMysteryChestOffer({ ok: true, slots: 3, picked_slot: null, choices: [] })).toEqual(
      { slots: 3, pickedSlot: null, choices: undefined }
    );
    const revealed = parseMysteryChestOffer({
      ok: true,
      slots: 3,
      picked_slot: 2,
      choices: [
        { slot: 1, picked: false, amount_cents: 1200, tier: 'base' },
        { slot: 2, picked: true, amount_cents: 5000, tier: 'medium' },
        { slot: 3, picked: false, amount_cents: 40000, tier: 'major' },
      ],
    });
    expect(revealed?.pickedSlot).toBe(2);
    expect(revealed?.choices?.map((c) => c.amount)).toEqual([12, 50, 400]);
  });

  it('refuses anything that is not a well-formed answer', () => {
    expect(parseMysteryChestOffer(null)).toBeNull();
    expect(parseMysteryChestOffer({ ok: false })).toBeNull();
    expect(parseMysteryChestOffer({ ok: true, slots: 7 })).toBeNull();
  });
});
