/**
 * The diamonds plate prints three figures and opens the arena (phase 2).
 * THE DIAMOND ARENA IS DIAMONDS ONLY. NO CHIPS, EVER.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DiamondPlate } from '@/pages/PlayerWalletPage';
import type { DiamondWalletSummary } from '@/services/DiamondService';

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn(), auth: {} } }));
vi.mock('@/utils/errorReporter', () => ({ reportError: vi.fn() }));

const summary = (over: Partial<DiamondWalletSummary> = {}): DiamondWalletSummary => ({
  onHand: 1200,
  collateral: 200,
  sendable: 1000,
  inArena: 0,
  arenaSeats: 0,
  arenaEntries: 0,
  arena: {
    clubId: '002c2d27-9584-4e52-835a-bb2be148fc81',
    name: 'Diamond Arena',
    slug: 'diamond-arena',
    cashGamesEnabled: false,
    tournamentsEnabled: false,
  },
  lifetimeEarned: 0,
  lifetimeSpent: 0,
  readAt: '2026-09-14T00:00:00Z',
  ...over,
});

describe('DiamondPlate', () => {
  it('while reading, the figures say so instead of printing a zero', () => {
    render(<DiamondPlate diamonds={1200} summary={undefined} onBuy={vi.fn()} onArena={vi.fn()} />);
    expect(screen.getByText('Diamonds On Hand')).toBeTruthy();
    expect(screen.getAllByText('...')).toHaveLength(2);
    expect(screen.queryByText(/Opens Soon|Sit Down|Return To/)).toBeNull();
  });

  it('a failed read prints Unavailable, never a zero (10.86)', () => {
    render(<DiamondPlate diamonds={1200} summary={null} onBuy={vi.fn()} onArena={vi.fn()} />);
    expect(screen.getAllByText('Unavailable')).toHaveLength(2);
  });

  it('known: On Hand in the bay, Sendable and In The Arena in the footer, collateral explained', () => {
    render(
      <DiamondPlate
        diamonds={1200}
        summary={summary({ inArena: 350 })}
        onBuy={vi.fn()}
        onArena={vi.fn()}
      />
    );
    expect(screen.getByText('Sendable')).toBeTruthy();
    expect(screen.getByText('In The Arena')).toBeTruthy();
    expect(screen.getByText(/200 Bought Recently Are Held/)).toBeTruthy();
    expect(
      screen.getByRole('article', { name: /1,200 On Hand, 1,000 Sendable, 350 In The Arena/ })
    ).toBeTruthy();
  });

  it('a closed arena is a sentence, not a dead button', () => {
    const onArena = vi.fn();
    render(<DiamondPlate diamonds={5} summary={summary()} onBuy={vi.fn()} onArena={onArena} />);
    expect(screen.getByRole('status').textContent).toBe('Diamond Arena Opens Soon');
    expect(screen.queryByRole('button', { name: /Diamond Arena/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Buy Diamonds' })).toBeTruthy();
  });

  it('an open arena is a door that fires', () => {
    const onArena = vi.fn();
    render(
      <DiamondPlate
        diamonds={5}
        summary={summary({ arena: { ...summary().arena!, cashGamesEnabled: true } })}
        onBuy={vi.fn()}
        onArena={onArena}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sit Down In The Diamond Arena' }));
    expect(onArena).toHaveBeenCalledTimes(1);
  });

  it('a held seat offers the way back, even while the arena is closed to new seats', () => {
    render(
      <DiamondPlate
        diamonds={5}
        summary={summary({ inArena: 80, arenaSeats: 1 })}
        onBuy={vi.fn()}
        onArena={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Return To The Diamond Arena' })).toBeTruthy();
  });

  it('never a chip, anywhere on the plate', () => {
    const { container } = render(
      <DiamondPlate
        diamonds={5}
        summary={summary({ inArena: 80 })}
        onBuy={vi.fn()}
        onArena={vi.fn()}
      />
    );
    expect(container.textContent).not.toMatch(/chip/i);
  });
});
