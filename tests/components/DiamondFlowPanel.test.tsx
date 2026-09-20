/**
 * "Where Your Diamonds Go" renders every outcome the read can return, lets the
 * player switch between lifetime and the last 30 days, and never draws a bar
 * for a figure it did not read.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DiamondFlow, DiamondFlowLine } from '@/services/DiamondService';

const getDiamondFlow = vi.fn<() => Promise<DiamondFlow | null>>();
vi.mock('@/services/DiamondService', () => ({
  DiamondService: { getDiamondFlow: () => getDiamondFlow() },
}));
vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn(), auth: {} } }));
vi.mock('@/utils/errorReporter', () => ({ reportError: vi.fn() }));

const { default: DiamondFlowPanel } = await import('@/components/wallet/DiamondFlowPanel');

const line = (over: Partial<DiamondFlowLine>): DiamondFlowLine => ({
  bucket: 'games',
  label: 'Games And Arcade',
  lifetime: 0,
  lifetimeCount: 0,
  last30: 0,
  last30Count: 0,
  ...over,
});

const flow = (over: Partial<DiamondFlow> = {}): DiamondFlow => ({
  spent: [
    line({
      bucket: 'arena',
      label: 'Diamond Arena Seats',
      lifetime: 800,
      lifetimeCount: 10,
      last30: 160,
      last30Count: 2,
    }),
    line({
      bucket: 'gifts_sent',
      label: 'Gifts To Friends',
      lifetime: 200,
      lifetimeCount: 4,
      last30: 0,
      last30Count: 0,
    }),
  ],
  earned: [
    line({
      bucket: 'rewards',
      label: 'Daily Rewards And Challenges',
      lifetime: 3000,
      lifetimeCount: 60,
      last30: 300,
      last30Count: 6,
    }),
    line({
      bucket: 'arena_cash_outs',
      label: 'Diamond Arena Cash-Outs',
      lifetime: 1000,
      lifetimeCount: 8,
      last30: 100,
      last30Count: 1,
    }),
  ],
  spentTotal: 1000,
  earnedTotal: 4000,
  spentLast30: 160,
  earnedLast30: 400,
  readAt: '2026-09-14T00:00:00Z',
  ...over,
});

describe('DiamondFlowPanel', () => {
  beforeEach(() => getDiamondFlow.mockReset());

  it('says it is reading, then prints both sides with a bar per bucket', async () => {
    let resolve!: (f: DiamondFlow) => void;
    getDiamondFlow.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    render(<DiamondFlowPanel userId="u-1" />);
    expect(screen.getByText('Reading Where Your Diamonds Go...')).toBeTruthy();
    resolve(flow());
    await waitFor(() => expect(screen.getByText('Diamond Arena Seats')).toBeTruthy());

    const spent = screen.getByRole('region', { name: 'Spent' });
    expect(within(spent).getByText('1,000 Diamonds')).toBeTruthy();
    expect(within(spent).getByText('800')).toBeTruthy();
    expect(within(spent).getByText('Gifts To Friends')).toBeTruthy();
    // The arena line is the biggest sink, so its bar is the full width.
    const arenaBar = within(spent).getByRole('img', {
      name: 'Diamond Arena Seats: 800 Diamonds, 80 Percent Of Spent',
    });
    expect((arenaBar.firstElementChild as HTMLElement).style.width).toBe('80%');

    const earned = screen.getByRole('region', { name: 'Earned' });
    expect(within(earned).getByText('4,000 Diamonds')).toBeTruthy();
    expect(within(earned).getByText('Diamond Arena Cash-Outs')).toBeTruthy();
    expect(within(earned).getByText('60 Entries')).toBeTruthy();
    // Nothing on the panel is a chip.
    expect(document.body.textContent).not.toMatch(/chip/i);
  });

  it('Last 30 Days swaps the figures and hides buckets that carried nothing', async () => {
    getDiamondFlow.mockResolvedValueOnce(flow());
    render(<DiamondFlowPanel userId="u-1" />);
    await waitFor(() => expect(screen.getByText('Diamond Arena Seats')).toBeTruthy());

    const last30 = screen.getByRole('button', { name: 'Last 30 Days' });
    expect(last30.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(last30);
    expect(last30.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Lifetime' }).getAttribute('aria-pressed')).toBe(
      'false'
    );

    const spent = screen.getByRole('region', { name: 'Spent' });
    expect(within(spent).getByText('160 Diamonds')).toBeTruthy();
    expect(within(spent).getByText('160')).toBeTruthy();
    expect(within(spent).getByText('2 Entries')).toBeTruthy();
    // Gifts carried nothing in the window: not listed, not a zero bar.
    expect(within(spent).queryByText('Gifts To Friends')).toBeNull();
    const earned = screen.getByRole('region', { name: 'Earned' });
    expect(within(earned).getByText('400 Diamonds')).toBeTruthy();
    expect(within(earned).getByText('1 Entry')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Lifetime' }));
    expect(within(spent).getByText('Gifts To Friends')).toBeTruthy();
  });

  it('a side with nothing in the window says so instead of drawing an empty list', async () => {
    getDiamondFlow.mockResolvedValueOnce(
      flow({
        spent: [
          line({ bucket: 'store', label: 'Store Items And Perks', lifetime: 25, lifetimeCount: 1 }),
        ],
        spentTotal: 25,
        spentLast30: 0,
      })
    );
    render(<DiamondFlowPanel userId="u-1" />);
    await waitFor(() => expect(screen.getByText('Store Items And Perks')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Last 30 Days' }));
    expect(screen.getByText('Nothing Spent In The Last 30 Days.')).toBeTruthy();
    expect(screen.queryByText('Store Items And Perks')).toBeNull();
  });

  it('a failed read is Unavailable with a retry, never zeros or empty bars', async () => {
    getDiamondFlow
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(flow({ spent: [], earned: [], spentTotal: 0, earnedTotal: 0 }));
    render(<DiamondFlowPanel userId="u-1" />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText(/Where Your Diamonds Go Could Not Be Read/)).toBeTruthy();
    expect(screen.queryByText('0')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText(/No Diamond Movements Yet/)).toBeTruthy());
    expect(getDiamondFlow).toHaveBeenCalledTimes(2);
  });

  it('does not read without a user', () => {
    render(<DiamondFlowPanel userId={undefined} />);
    expect(getDiamondFlow).not.toHaveBeenCalled();
  });
});
