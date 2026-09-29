import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DiamondWheel from '../../src/components/wheel/DiamondWheel';
import { WheelPrizeGallery } from '../../src/components/wheel/WheelCabinet';
import type { WheelSegment } from '../../src/services/DiamondWheelService';

// Owner ruling 2026-09-21 (wheel v4, R2): an active or lifetime VIP never wins
// Throwables, Time Bank or Rabbit Hunt. The server returns ords 3, 6 and 9 as
// instant chip wins of equal value instead, so the FACE must read every card
// from its segment's kind - and, for chips, from the multiplier - never from a
// fixed ord-to-art table and never from the weights.

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/services/SoundService', () => ({
  soundService: {
    playSpinStart: vi.fn(),
    playSpinTicking: vi.fn(),
    playSpinPeg: vi.fn(),
    playSpinResult: vi.fn(),
  },
}));
vi.mock('../../src/utils/animationSpeed', () => ({
  getAnimationSpeed: () => 1,
  prefersReducedMotion: () => false,
}));

type Row = [number, string, Partial<WheelSegment>];
// The v4 base weights, exactly as the contract publishes them.
const V4: Row[] = [
  [
    1,
    'Diamond Plinko',
    { kind: 'bonus', game: 'plinko', amount: 100, multiplier: 1, weight: 11950 },
  ],
  [2, '1x Chips', { kind: 'chips', amount: 1, multiplier: 1, weight: 29600 }],
  [3, 'Throwables', { kind: 'throwables', amount: 25, multiplier: 0.25, weight: 6667 }],
  [4, 'Diamond Crash', { kind: 'bonus', game: 'crash', amount: 100, multiplier: 1, weight: 11950 }],
  [5, 'Diamonds', { kind: 'diamonds', amount: 100, multiplier: 1, weight: 1200 }],
  [6, 'Time Bank', { kind: 'time_bank', amount: 25, multiplier: 0.25, weight: 6666 }],
  [
    7,
    'Donkey Cross',
    { kind: 'bonus', game: 'crossing', amount: 100, multiplier: 1, weight: 11950 },
  ],
  [8, '2x Chips', { kind: 'chips', amount: 2, multiplier: 2, weight: 240 }],
  [9, 'Rabbit Hunt', { kind: 'rabbit_hunt', amount: 25, multiplier: 0.25, weight: 6667 }],
  [
    10,
    'Diamond Mines',
    { kind: 'bonus', game: 'mines', amount: 100, multiplier: 1, weight: 11950 },
  ],
  [11, '3x Chips', { kind: 'chips', amount: 3, multiplier: 3, weight: 160 }],
  [12, 'Upgrade', { kind: 'upgrade', amount: 400, multiplier: 4, weight: 1000 }],
];
// What a VIP is served instead, same ords, same weights, same value.
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

let observe: ((rect: { width: number; height: number }) => void) | null = null;
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: (entries: { contentRect: unknown }[]) => void) {
        observe = (rect) => this.callback([{ contentRect: rect }]);
      }
      observe() {}
      disconnect() {}
    }
  );
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  observe = null;
});

function face(segments: WheelSegment[]) {
  const view = render(
    <DiamondWheel
      segments={segments}
      landingOrd={null}
      spinKey={0}
      spinning={false}
      onLanded={vi.fn()}
      presentation="assembly"
      fitViewport
    />
  );
  act(() => observe?.({ width: 360, height: 415 }));
  return view;
}
const card = (container: HTMLElement, ord: number) =>
  container.querySelector(`[data-slot="${ord}"] [data-wheel-card]`)!;

describe('the VIP wheel face reads its cards from the prize, not the position', () => {
  it('prints chip stacks and chip amounts where a standard table shows the three items', () => {
    const { container } = face(VIP);
    for (const [ord, amount] of [
      [3, '0.2'],
      [6, '0.25'],
      [9, '0.3'],
    ] as const) {
      const element = card(container, ord);
      expect(element).toHaveAttribute('data-wheel-card', 'chips');
      // Card 5 of the approved sheet is the single chip stack with the blank
      // title plate; the amount is printed on it exactly as 1x Chips is.
      expect(element).toHaveAttribute('data-card-index', '5');
      expect(element).toHaveAccessibleName(`${amount} Chips`);
      expect(element.querySelector('textPath')).toHaveTextContent(`${amount} CHIPS`);
    }
    // Two and three stacks still belong to the 2x and 3x wins.
    expect(card(container, 8)).toHaveAttribute('data-card-index', '6');
    expect(card(container, 11)).toHaveAttribute('data-card-index', '7');
  });

  it('shows no throwable, time bank or rabbit art anywhere on a VIP face', () => {
    const { container } = face(VIP);
    for (const kind of ['throwables', 'time_bank', 'rabbit_hunt'])
      expect(container.querySelectorAll(`[data-wheel-card="${kind}"]`)).toHaveLength(0);
    const indexes = [...container.querySelectorAll('[data-card-index]')].map((element) =>
      Number(element.getAttribute('data-card-index'))
    );
    expect(indexes.filter((index) => [8, 9, 10].includes(index))).toEqual([]);
    expect(indexes).toEqual([0, 5, 5, 1, 11, 5, 2, 6, 5, 3, 7, 4]);
  });

  it('still shows the three items to everybody else', () => {
    const { container } = face(STANDARD);
    expect(card(container, 3)).toHaveAttribute('data-card-index', '8');
    expect(card(container, 6)).toHaveAttribute('data-card-index', '9');
    expect(card(container, 9)).toHaveAttribute('data-card-index', '10');
    expect(card(container, 3)).toHaveAccessibleName('Throwables');
  });

  it('follows the kind when the server moves a prize to another ord', () => {
    const moved = table([
      [1, 'Throwables', { kind: 'throwables', amount: 25, multiplier: 0.25, weight: 6667 }],
      [
        2,
        'Diamond Mines',
        { kind: 'bonus', game: 'mines', amount: 100, multiplier: 1, weight: 11950 },
      ],
      [3, '3x Chips', { kind: 'chips', amount: 3, multiplier: 3, weight: 160 }],
    ]);
    const { container } = face(moved);
    expect(card(container, 1)).toHaveAttribute('data-card-index', '8');
    expect(card(container, 2)).toHaveAttribute('data-card-index', '3');
    expect(card(container, 3)).toHaveAttribute('data-card-index', '7');
  });

  it('draws the same face whatever the weights say, so a model change cannot move the art', () => {
    // React's generated ids differ per render; the art must not.
    const art = (container: HTMLElement) => container.innerHTML.replace(/_r_[0-9a-z]+_/g, 'id');
    const { container } = face(VIP);
    const painted = art(container);
    cleanup();
    // The retired v3 weights, and a table with none at all.
    const v3 = [29600, 5000, 14600, 10000, 5000, 14600, 10000, 2000, 14600, 10000, 2200, 2000];
    const reweighted = VIP.map((segment, index) => ({
      ...segment,
      weight: v3[index],
      probability: v3[index] / 100000,
    }));
    const { container: second } = face(reweighted as WheelSegment[]);
    expect(art(second)).toBe(painted);
    cleanup();
    const { container: third } = face(
      VIP.map((segment) => ({ ...segment, weight: 0, probability: 0 })) as WheelSegment[]
    );
    expect(art(third)).toBe(painted);
  });
});

describe('the VIP prize gallery matches the VIP face', () => {
  it('lists chip art and chip titles for ords 3, 6 and 9 and no item art', () => {
    render(<WheelPrizeGallery segments={VIP} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(12);
    for (const [index, amount] of [
      [2, '0.2'],
      [5, '0.25'],
      [8, '0.3'],
    ] as const) {
      // Region 5 of the prize atlas is the single chip stack.
      expect(items[index].querySelector('svg')).toHaveAttribute('viewBox', '397 445 301 246');
      expect(items[index]).toHaveTextContent(`${amount} Chips`);
      expect(items[index]).toHaveTextContent(`${amount}x Chip Payout`);
    }
    expect(screen.queryByText('Throwables')).toBeNull();
    expect(screen.queryByText('Time Bank')).toBeNull();
    expect(screen.queryByText('Rabbit Hunt')).toBeNull();
    // The combination throwables art belongs to the standard table only.
    expect(document.body.innerHTML).not.toContain('wheel-prize-throwables-v1.webp');
  });

  it('keeps the combination throwables art on a standard table', () => {
    render(<WheelPrizeGallery segments={STANDARD} />);
    expect(screen.getByText('Throwables')).toBeInTheDocument();
    expect(document.body.innerHTML).toContain('wheel-prize-throwables-v1.webp');
  });
});
