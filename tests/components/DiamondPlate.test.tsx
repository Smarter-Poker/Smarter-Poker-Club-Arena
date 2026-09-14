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
    openCashTables: 17,
    minCashBuyIn: 80,
    cheapestTable: { id: 't-1', name: 'NLH 1/2', smallBlind: 1, bigBlind: 2 },
  },
  lifetimeEarned: 0,
  lifetimeSpent: 0,
  readAt: '2026-09-14T00:00:00Z',
  ...over,
});

describe('DiamondPlate', () => {
  it('while reading, the figures say so instead of printing a zero', () => {
    render(
      <DiamondPlate
        diamonds={1200}
        summary={undefined}
        onBuy={vi.fn()}
        onBuyToSitDown={vi.fn()}
        onArena={vi.fn()}
        nextFreerollAt={null}
      />
    );
    expect(screen.getByText('Diamonds On Hand')).toBeTruthy();
    expect(screen.getAllByText('...')).toHaveLength(2);
    expect(screen.queryByText(/Opens Soon|Sit Down|Return To/)).toBeNull();
  });

  it('a failed read prints Unavailable, never a zero (10.86)', () => {
    render(
      <DiamondPlate
        diamonds={1200}
        summary={null}
        onBuy={vi.fn()}
        onBuyToSitDown={vi.fn()}
        onArena={vi.fn()}
        nextFreerollAt={null}
      />
    );
    expect(screen.getAllByText('Unavailable')).toHaveLength(2);
  });

  it('known: On Hand in the bay, Sendable and In The Arena in the footer, collateral explained', () => {
    render(
      <DiamondPlate
        diamonds={1200}
        summary={summary({ inArena: 350 })}
        onBuy={vi.fn()}
        onBuyToSitDown={vi.fn()}
        onArena={vi.fn()}
        nextFreerollAt={null}
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
    render(
      <DiamondPlate
        diamonds={5}
        summary={summary()}
        onBuy={vi.fn()}
        onBuyToSitDown={vi.fn()}
        onArena={onArena}
        nextFreerollAt={null}
      />
    );
    expect(screen.getByRole('status').textContent).toBe('Diamond Arena Opens Soon');
    expect(screen.queryByRole('button', { name: /Diamond Arena/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Buy Diamonds' })).toBeTruthy();
  });

  it('an open arena with enough on hand is a door that fires', () => {
    const onArena = vi.fn();
    render(
      <DiamondPlate
        diamonds={500}
        summary={summary({ arena: { ...summary().arena!, cashGamesEnabled: true } })}
        onBuy={vi.fn()}
        onBuyToSitDown={vi.fn()}
        onArena={onArena}
        nextFreerollAt={null}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sit Down In The Diamond Arena' }));
    expect(onArena).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/The Cheapest Seat Is 80 Diamonds \(NLH 1\/2\)/)).toBeTruthy();
  });

  it('an open arena with too few diamonds sends the player to buy, saying how many more (phase 3)', () => {
    const onArena = vi.fn();
    const onBuyToSitDown = vi.fn();
    render(
      <DiamondPlate
        diamonds={30}
        summary={summary({ arena: { ...summary().arena!, cashGamesEnabled: true } })}
        onBuy={vi.fn()}
        onBuyToSitDown={onBuyToSitDown}
        onArena={onArena}
        nextFreerollAt={null}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Buy Diamonds To Sit Down, 50 More' }));
    expect(onBuyToSitDown).toHaveBeenCalledTimes(1);
    expect(onArena).not.toHaveBeenCalled();
  });

  it('a closed arena with a scheduled freeroll counts down to the one free way in', () => {
    render(
      <DiamondPlate
        diamonds={0}
        summary={summary()}
        onBuy={vi.fn()}
        onBuyToSitDown={vi.fn()}
        onArena={vi.fn()}
        nextFreerollAt={Date.now() + 2 * 3_600_000 + 14 * 60_000}
      />
    );
    expect(
      screen.getByText(
        /Next Diamond Freeroll In 2:1[34]:\d\d\. A Freeroll Costs Nothing To Enter\./
      )
    ).toBeTruthy();
  });

  it('when the cheapest seat is unknown, the open door never claims an amount', () => {
    render(
      <DiamondPlate
        diamonds={1}
        summary={summary({
          arena: {
            ...summary().arena!,
            cashGamesEnabled: true,
            minCashBuyIn: null,
            cheapestTable: null,
          },
        })}
        onBuy={vi.fn()}
        onBuyToSitDown={vi.fn()}
        onArena={vi.fn()}
        nextFreerollAt={null}
      />
    );
    expect(screen.getByRole('button', { name: 'Sit Down In The Diamond Arena' })).toBeTruthy();
    expect(screen.queryByText(/More$/)).toBeNull();
  });

  it('a held seat offers the way back, even while the arena is closed to new seats', () => {
    render(
      <DiamondPlate
        diamonds={5}
        summary={summary({ inArena: 80, arenaSeats: 1 })}
        onBuy={vi.fn()}
        onBuyToSitDown={vi.fn()}
        onArena={vi.fn()}
        nextFreerollAt={null}
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
        onBuyToSitDown={vi.fn()}
        onArena={vi.fn()}
        nextFreerollAt={null}
      />
    );
    expect(container.textContent).not.toMatch(/chip/i);
  });
});
