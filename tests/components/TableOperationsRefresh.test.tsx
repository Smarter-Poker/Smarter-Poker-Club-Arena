import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TableOperationsPanel from '../../src/components/club/TableOperationsPanel';
const api = vi.hoisted(() => ({
  getClubTables: vi.fn(),
  getSeatedPlayers: vi.fn(),
  getTableStats: vi.fn(),
}));
vi.mock('../../src/services/TableService', () => ({ tableService: api }));
vi.mock('../../src/lib/supabase', () => ({ supabase: {} }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => ({ error: vi.fn() }) }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
const table = (name = 'First Table') => ({
  id: 'table-a',
  name,
  game_variant: 'nlh',
  small_blind: 1,
  big_blind: 2,
  max_players: 6,
  current_players: 1,
  status: 'running',
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  api.getClubTables.mockResolvedValue([table()]);
  api.getSeatedPlayers.mockResolvedValue([]);
  api.getTableStats.mockResolvedValue({ totalHands: 0, totalRake: 0 });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it('reads changes while visible and refreshes on return without WAL delivery', async () => {
  await act(async () => {
    render(<TableOperationsPanel clubId="club-a" />);
  });
  expect(screen.getByText('First Table')).toBeInTheDocument();
  fireEvent.click(screen.getByText('First Table'));
  await act(async () => {});
  expect(api.getSeatedPlayers).toHaveBeenCalledWith('table-a');
  api.getClubTables.mockResolvedValue([table('Changed Table')]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
  });
  expect(screen.getByText('Changed Table')).toBeInTheDocument();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  fireEvent(document, new Event('visibilitychange'));
  const count = api.getClubTables.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(api.getClubTables).toHaveBeenCalledTimes(count);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  await act(async () => {
    fireEvent(document, new Event('visibilitychange'));
  });
  expect(api.getClubTables).toHaveBeenCalledTimes(count + 1);
});
it('reports failed initial reads and retries rather than claiming an empty club', async () => {
  api.getClubTables.mockRejectedValueOnce(new Error('offline'));
  await act(async () => {
    render(<TableOperationsPanel clubId="club-a" />);
  });
  expect(screen.getByRole('alert')).toHaveTextContent('Could Not Load Tables');
  expect(screen.queryByText('No Active Tables In This Club')).not.toBeInTheDocument();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  });
  expect(screen.getByText('First Table')).toBeInTheDocument();
});
it('discards a reply from the previous club', async () => {
  let finish: (data: unknown) => void = () => {};
  api.getClubTables.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const view = render(<TableOperationsPanel clubId="old-club" />);
  await act(async () => {
    view.rerender(<TableOperationsPanel clubId="new-club" />);
  });
  await act(async () => {
    finish([table('Old Club Table')]);
  });
  expect(screen.getByText('First Table')).toBeInTheDocument();
  expect(screen.queryByText('Old Club Table')).not.toBeInTheDocument();
});
