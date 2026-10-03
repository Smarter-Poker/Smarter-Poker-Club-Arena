import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import TransactionLedgerView from '../../src/components/common/TransactionLedgerView';

const reads: Array<{
  resolve: (value: { data: unknown; error: unknown }) => void;
  filters: string[];
}> = [];
const rpc = vi.fn();

vi.mock('../../src/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscriptions: vi.fn(),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    from: vi.fn(() => {
      const filters: string[] = [];
      const query: Record<string, unknown> = {};
      for (const method of ['select', 'order', 'limit']) query[method] = vi.fn(() => query);
      query.eq = vi.fn((column: string, value: string) => {
        filters.push(`${column}:${value}`);
        return query;
      });
      query.or = vi.fn((value: string) => {
        filters.push(value);
        return query;
      });
      query.then = (done: (value: unknown) => unknown, fail: (error: unknown) => unknown) => {
        const promise = new Promise<{ data: unknown; error: unknown }>((resolve) => {
          reads.push({ resolve, filters });
        });
        return promise.then(done, fail);
      };
      return query;
    }),
  },
}));

const entry = (id: string, label: string) => ({
  id,
  performed_by: 'actor',
  from_type: 'player_wallet',
  from_label: label,
  to_type: 'club_treasury',
  to_label: 'Shark Club',
  amount: 100,
  category: 'transfer',
  description: `${label} Transfer`,
  created_at: '2026-10-03T12:00:00Z',
  club_id: null,
  union_id: null,
});

describe('TransactionLedgerView scope identity', () => {
  it('never publishes an old player response after the component moves to another player', async () => {
    reads.length = 0;
    const view = render(<TransactionLedgerView userId="player-a" />);
    await waitFor(() => expect(reads).toHaveLength(1));

    view.rerender(<TransactionLedgerView userId="player-b" />);
    await waitFor(() => expect(reads).toHaveLength(2));
    expect(screen.getByText('Loading Transactions...')).toBeTruthy();

    await act(async () => {
      reads[1].resolve({ data: [entry('new', 'Current Player')], error: null });
    });
    expect(await screen.findByText('Current Player To Shark Club')).toBeTruthy();

    await act(async () => {
      reads[0].resolve({ data: [entry('old', 'Previous Player')], error: null });
    });
    expect(screen.queryByText('Previous Player To Shark Club')).toBeNull();
    expect(reads[0].filters.join(' ')).toContain('player-a');
    expect(reads[1].filters.join(' ')).toContain('player-b');
  });

  it('refuses a malformed successful read instead of painting a false empty ledger', async () => {
    reads.length = 0;
    render(<TransactionLedgerView userId="player-a" />);
    await waitFor(() => expect(reads).toHaveLength(1));
    await act(async () => {
      reads[0].resolve({ data: null, error: null });
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('The Ledger Could Not Be Loaded');
    expect(screen.queryByText('No Transactions Yet')).toBeNull();
  });

  it('never reveals a horse funding identity anywhere in the rendered row', async () => {
    reads.length = 0;
    render(<TransactionLedgerView userId="player-a" />);
    await waitFor(() => expect(reads).toHaveLength(1));
    await act(async () => {
      reads[0].resolve({
        data: [
          {
            ...entry('funding', 'Horse Seat 17'),
            category: 'horse_funding',
            to_label: 'Horse Player Alias',
            description: 'Horse buy-in funded from club treasury',
          },
        ],
        error: null,
      });
    });
    expect(await screen.findByText('Table Funding')).toBeTruthy();
    expect(screen.getByText('The Club To A Table')).toBeTruthy();
    expect(document.body.textContent?.toLowerCase()).not.toContain('horse');
    expect(document.body.innerHTML.toLowerCase()).not.toContain('horse');
  });

  it('redacts an internal horse identity even when the ledger category is generic', async () => {
    reads.length = 0;
    render(<TransactionLedgerView userId="player-a" />);
    await waitFor(() => expect(reads).toHaveLength(1));
    await act(async () => {
      reads[0].resolve({ data: [entry('funding', 'Horse Seat 17')], error: null });
    });
    expect(await screen.findByText('Table Funding')).toBeTruthy();
    expect(document.body.innerHTML.toLowerCase()).not.toContain('horse');
  });

  it('redacts an internal horse account type when its labels are absent', async () => {
    reads.length = 0;
    render(<TransactionLedgerView userId="player-a" />);
    await waitFor(() => expect(reads).toHaveLength(1));
    await act(async () => {
      reads[0].resolve({
        data: [
          {
            ...entry('funding-type', 'Internal Transfer'),
            category: 'transfer',
            from_type: 'horse_wallet',
            to_type: 'horse_seat',
            from_label: null,
            to_label: null,
          },
        ],
        error: null,
      });
    });
    expect(await screen.findByText('Table Funding')).toBeTruthy();
    expect(screen.getByText('The Club To A Table')).toBeTruthy();
    expect(document.body.innerHTML.toLowerCase()).not.toContain('horse');
  });

  it('refuses a malformed club ledger receipt', async () => {
    rpc.mockResolvedValueOnce({ data: {}, error: null });
    render(<TransactionLedgerView clubId="11111111-1111-4111-8111-111111111111" clubScoped />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The Club Ledger Could Not Be Loaded'
    );
    expect(screen.queryByText('No Transactions Yet')).toBeNull();
  });
});
