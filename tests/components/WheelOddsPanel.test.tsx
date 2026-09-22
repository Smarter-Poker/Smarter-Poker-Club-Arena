/**
 * THE ODDS PANEL STATES THE MIX THE PLAYER FACES (owner ruling 2026-09-21,
 * R13 and R2, wheel v4 contract sections 1 and 2).
 *
 * Dan's mix: a bonus game 50% of the time, an instant chip win 30%, and
 * throwables / time bank / rabbit hunt 20%; back-to-back spins never give the
 * same prize twice in a row; and an active or lifetime VIP never wins the
 * three items at all, so for them those sectors are instant chip wins.
 *
 * The numbers are READ OFF THE TABLE THE SERVER SENT, never written into the
 * client: a VIP's table has no items on it, a host may lock a tier, and a
 * figure typed here would keep saying 20% long after the server had stopped
 * sending any. That is the point of this file - it feeds the panel both
 * tables and reads the sentences back.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WheelPrizeGallery,
  wheelPrizeMix,
  sharePercent,
} from '../../src/components/wheel/WheelCabinet';
import type { WheelSegment } from '../../src/services/DiamondWheelService';

type Row = [number, string, Partial<WheelSegment>];
/** The v4 base weights, exactly as the contract publishes them. */
const V4: Row[] = [
  [1, 'Diamond Plinko', { kind: 'bonus', game: 'plinko', amount: 100, weight: 11950 }],
  [2, '1x Chips', { kind: 'chips', amount: 1, multiplier: 1, weight: 29600 }],
  [3, 'Throwables', { kind: 'throwables', amount: 25, multiplier: 0.25, weight: 6667 }],
  [4, 'Diamond Crash', { kind: 'bonus', game: 'crash', amount: 100, weight: 11950 }],
  [5, 'Diamonds', { kind: 'diamonds', amount: 100, weight: 1200 }],
  [6, 'Time Bank', { kind: 'time_bank', amount: 25, multiplier: 0.25, weight: 6666 }],
  [7, 'Donkey Cross', { kind: 'bonus', game: 'crossing', amount: 100, weight: 11950 }],
  [8, '2x Chips', { kind: 'chips', amount: 2, multiplier: 2, weight: 240 }],
  [9, 'Rabbit Hunt', { kind: 'rabbit_hunt', amount: 25, multiplier: 0.25, weight: 6667 }],
  [10, 'Diamond Mines', { kind: 'bonus', game: 'mines', amount: 100, weight: 11950 }],
  [11, '3x Chips', { kind: 'chips', amount: 3, multiplier: 3, weight: 160 }],
  [12, 'Upgrade', { kind: 'upgrade', amount: 400, multiplier: 4, weight: 1000 }],
];
/** What a VIP is served instead: same ords, same weights, chips in their place. */
const VIP_ROWS: Record<number, Row> = {
  3: [3, '0.2x Chips', { kind: 'chips', amount: 0.2, multiplier: 0.2, weight: 6667 }],
  6: [6, '0.25x Chips', { kind: 'chips', amount: 0.25, multiplier: 0.25, weight: 6666 }],
  9: [9, '0.3x Chips', { kind: 'chips', amount: 0.3, multiplier: 0.3, weight: 6667 }],
};
const table = (rows: Row[]): WheelSegment[] =>
  rows.map(
    ([ord, label, rest]) =>
      ({
        ord,
        label,
        value_chips: 1,
        probability: (rest.weight ?? 0) / 100000,
        locked: false,
        unlocks_at: null,
        ...rest,
      }) as WheelSegment
  );
const STANDARD = table(V4);
const VIP = table(V4.map((row) => VIP_ROWS[row[0]] ?? row));

afterEach(cleanup);

describe('the mix, read off the table', () => {
  it('buckets the v4 weights into the owner three', () => {
    expect(wheelPrizeMix(STANDARD)).toEqual({ games: 0.5, chips: 0.3, items: 0.2 });
    // A VIP's items are chip wins, so the chips bucket holds both halves.
    expect(wheelPrizeMix(VIP)).toEqual({ games: 0.5, chips: 0.5, items: 0 });
    // No table at all is no claim at all, never a division by zero.
    expect(wheelPrizeMix([])).toEqual({ games: 0, chips: 0, items: 0 });
  });

  it('prints a share rounded DOWN to one decimal, with a bare .0 dropped', () => {
    expect(sharePercent(0.5)).toBe('50%');
    expect(sharePercent(0.2)).toBe('20%');
    expect(sharePercent(0.12349)).toBe('12.3%');
    expect(sharePercent(0.129999)).toBe('12.9%');
    expect(sharePercent(0)).toBe('0%');
  });
});

describe('the odds panel', () => {
  it('states the games, the chips, the items and the no-repeat rule', () => {
    render(<WheelPrizeGallery segments={STANDARD} />);
    expect(
      screen.getByText(
        'A Bonus Game Or The Diamond Cards 50% Of The Time. Instant Chip Wins 30%. Throwables, Time Banks And Rabbit Hunts 20%.'
      )
    ).toBeInTheDocument();
    expect(screen.getByText('Never The Same Prize Twice In A Row.')).toBeInTheDocument();
  });

  it('tells a VIP their items are paid as chips, and claims no items at all', () => {
    render(<WheelPrizeGallery segments={VIP} vip />);
    expect(
      screen.getByText('A Bonus Game Or The Diamond Cards 50% Of The Time. Instant Chip Wins 50%.')
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Your VIP Card Pays Throwables, Time Banks And Rabbit Hunts As Instant Chip Wins Instead.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/Rabbit Hunts 0%/)).toBeNull();
    expect(screen.getByText('Never The Same Prize Twice In A Row.')).toBeInTheDocument();
  });

  it('says nothing about a mix it was given no table for', () => {
    render(<WheelPrizeGallery segments={[]} />);
    expect(screen.queryByText(/Of The Time/)).toBeNull();
    expect(screen.queryByText('Never The Same Prize Twice In A Row.')).toBeNull();
  });
});
