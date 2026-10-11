import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import GameLifetimeAverages from '../../src/components/games/GameLifetimeAverages';
const games = ['wheel', 'mines', 'crossing', 'crash', 'plinko'].map((game) => ({
  game,
  rounds: 10,
  losses: 3,
  average_return: 0.8,
  average_safe_steps: 2,
  average_before_loss: 1.5,
  average_crash: 2.7,
}));
beforeEach(() => rpc.mockReset());
afterEach(cleanup);
it('reads real recorded averages with denominators and a past-results explanation', async () => {
  rpc.mockResolvedValue({ data: { ok: true, games }, error: null });
  render(<GameLifetimeAverages clubId="host" />);
  await act(async () => {});
  expect(rpc).toHaveBeenCalledWith('fn_diamond_game_lifetime', { p_club_id: 'host' });
  expect(screen.getByText(/Average Crash Point 2.7x/)).toBeInTheDocument();
  expect(screen.getByText(/Before A Mine: 1.5 \(3 Losses\)/)).toBeInTheDocument();
  expect(screen.getByText(/Averages Describe Past Games/)).toBeInTheDocument();
});
it('does not label completed but unmeasured free spins as zero completed games', async () => {
  rpc.mockResolvedValue({
    data: { ok: true, games: games.map((g) => ({ ...g, average_return: null })) },
    error: null,
  });
  render(<GameLifetimeAverages clubId="host" />);
  await act(async () => {});
  expect(screen.getByText(/Average Wheel Prize Value No Measured Results/)).toBeInTheDocument();
});
it.each(['duplicate', 'negative', 'incomplete', 'network'])(
  'keeps a %s response visibly unavailable',
  async (defect) => {
    const invalid = structuredClone(games);
    if (defect === 'duplicate') invalid[1].game = 'wheel';
    if (defect === 'negative') invalid[1].average_before_loss = -1;
    if (defect === 'incomplete') invalid.pop();
    rpc.mockResolvedValue({
      data: { ok: true, games: invalid },
      error: defect === 'network' ? new Error('Offline') : null,
    });
    render(<GameLifetimeAverages clubId="host" />);
    await act(async () => {});
    expect(screen.getByRole('status')).toHaveTextContent('Lifetime Averages Are Unavailable');
  }
);
it('rejects stale host responses after the scope changes', async () => {
  let resolveFirst!: (v: unknown) => void;
  rpc
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        })
    )
    .mockResolvedValue({
      data: { ok: true, games: games.map((g) => ({ ...g, rounds: 20 })) },
      error: null,
    });
  const view = render(<GameLifetimeAverages clubId="first" />);
  view.rerender(<GameLifetimeAverages clubId="second" />);
  await act(async () => {});
  await act(async () => resolveFirst({ data: { ok: true, games }, error: null }));
  expect(screen.getByText('Diamond Spins · 20 Completed Games')).toBeInTheDocument();
  expect(screen.queryByText('Diamond Spins · 10 Completed Games')).toBeNull();
});
