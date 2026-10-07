import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import TransactionLedgerView from '../../src/components/common/TransactionLedgerView';

const reads: Array<{
  resolve: (value: { data: unknown; error: unknown }) => void;
  filters: string[];
}> = [];
const rpc = vi.fn();
const PLAYER_A = '11111111-1111-4111-8111-111111111111';
const PLAYER_B = '22222222-2222-4222-8222-222222222222';
const CLUB_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_CLUB_ID = '44444444-4444-4444-8444-444444444444';
const UNION_ID = '55555555-5555-4555-8555-555555555555';

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

const entry = (id: string, label: string, userId = PLAYER_A) => ({
  id,
  performed_by: userId,
  from_type: 'player_wallet',
  from_entity_id: userId,
  from_label: label,
  to_type: 'club_treasury',
  to_entity_id: CLUB_ID,
  to_label: 'Shark Club',
  amount: 100,
  category: 'transfer',
  description: `${label} Transfer`,
  created_at: '2026-10-03T12:00:00Z',
  club_id: null,
  union_id: null,
});

const clubReceipt = (rows: unknown[], clubId = CLUB_ID, limit = 25) => ({
  contract: 'ca_club_chip_ledger.v2',
  contract_version: 2,
  club_id: clubId,
  requested_limit: limit,
  requested_before: null,
  requested_include_hand_rows: false,
  hand_rows_included: false,
  rows,
});

describe('TransactionLedgerView scope identity', () => {
  it('never publishes an old player response after the component moves to another player', async () => {
    reads.length = 0;
    const view = render(<TransactionLedgerView userId={PLAYER_A} />);
    await waitFor(() => expect(reads).toHaveLength(1));

    view.rerender(<TransactionLedgerView userId={PLAYER_B} />);
    await waitFor(() => expect(reads).toHaveLength(2));
    expect(screen.getByText('Loading Transactions...')).toBeTruthy();

    await act(async () => {
      reads[1].resolve({ data: [entry('new', 'Current Player', PLAYER_B)], error: null });
    });
    expect(await screen.findByText('Current Player To Shark Club')).toBeTruthy();
    const scroll = screen.getByRole('list');
    expect(scroll.tabIndex).toBe(0);
    scroll.focus();
    expect(scroll).toHaveFocus();

    await act(async () => {
      reads[0].resolve({ data: [entry('old', 'Previous Player', PLAYER_A)], error: null });
    });
    expect(screen.queryByText('Previous Player To Shark Club')).toBeNull();
    expect(reads[0].filters.join(' ')).toContain(PLAYER_A);
    expect(reads[1].filters.join(' ')).toContain(PLAYER_B);
  });

  it('refuses a malformed successful read instead of painting a false empty ledger', async () => {
    reads.length = 0;
    render(<TransactionLedgerView userId={PLAYER_A} />);
    await waitFor(() => expect(reads).toHaveLength(1));
    await act(async () => {
      reads[0].resolve({ data: null, error: null });
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('The Ledger Could Not Be Loaded');
    expect(screen.queryByText('No Transactions Yet')).toBeNull();
  });

  it('refuses a well-formed ledger row that is not bound to the requested player', async () => {
    reads.length = 0;
    render(<TransactionLedgerView userId={PLAYER_A} />);
    await waitFor(() => expect(reads).toHaveLength(1));
    await act(async () => {
      reads[0].resolve({ data: [entry('wrong-player', 'Other Player', PLAYER_B)], error: null });
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('The Ledger Could Not Be Loaded');
    expect(screen.queryByText('Other Player To Shark Club')).not.toBeInTheDocument();
  });

  it('refuses a well-formed ledger row that is not bound to the requested club', async () => {
    reads.length = 0;
    render(<TransactionLedgerView clubId={CLUB_ID} />);
    await waitFor(() => expect(reads).toHaveLength(1));
    await act(async () => {
      reads[0].resolve({
        data: [{ ...entry('wrong-club', 'Player Wallet'), club_id: OTHER_CLUB_ID }],
        error: null,
      });
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('The Ledger Could Not Be Loaded');
    expect(screen.queryByText('Player Wallet To Shark Club')).not.toBeInTheDocument();
  });

  it('refuses a well-formed ledger row that is not bound to the requested union', async () => {
    reads.length = 0;
    render(<TransactionLedgerView unionId={UNION_ID} />);
    await waitFor(() => expect(reads).toHaveLength(1));
    await act(async () => {
      reads[0].resolve({
        data: [
          {
            ...entry('wrong-union', 'Player Wallet'),
            union_id: '66666666-6666-4666-8666-666666666666',
          },
        ],
        error: null,
      });
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('The Ledger Could Not Be Loaded');
    expect(screen.queryByText('Player Wallet To Shark Club')).not.toBeInTheDocument();
  });

  it('never reveals a horse funding identity anywhere in the rendered row', async () => {
    reads.length = 0;
    render(<TransactionLedgerView userId={PLAYER_A} />);
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
    render(<TransactionLedgerView userId={PLAYER_A} />);
    await waitFor(() => expect(reads).toHaveLength(1));
    await act(async () => {
      reads[0].resolve({ data: [entry('funding', 'Horse Seat 17')], error: null });
    });
    expect(await screen.findByText('Table Funding')).toBeTruthy();
    expect(document.body.innerHTML.toLowerCase()).not.toContain('horse');
  });

  it('redacts an internal horse account type when its labels are absent', async () => {
    reads.length = 0;
    render(<TransactionLedgerView userId={PLAYER_A} />);
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

  it('maps internal ledger enums and identifiers to safe customer-facing copy', async () => {
    reads.length = 0;
    render(<TransactionLedgerView userId={PLAYER_A} />);
    await waitFor(() => expect(reads).toHaveLength(1));
    await act(async () => {
      reads[0].resolve({
        data: [
          {
            ...entry('internal-copy', 'Internal Transfer'),
            from_type: 'settlement_suspense',
            from_label: 'agents.agent_wallet_balance',
            to_type: 'agent_wallet',
            to_label: '11111111-1111-4111-8111-111111111111',
            category: 'settlement_adjustment',
            description: 'auto-ledgered agents.agent_wallet_balance delta 100.00',
          },
        ],
        error: null,
      });
    });

    expect(await screen.findByText('Recorded Movement')).toBeInTheDocument();
    expect(screen.getByText('Settlement Review To Agent Wallet')).toBeInTheDocument();
    const visible = document.body.textContent || '';
    expect(visible).not.toContain('settlement_suspense');
    expect(visible).not.toContain('settlement_adjustment');
    expect(visible).not.toContain('agents.agent_wallet_balance');
    expect(visible).not.toContain('11111111-1111-4111-8111-111111111111');
    expect(visible).not.toContain('auto-ledgered');
    expect(visible).not.toContain('.00');
  });

  it('removes zero-only cents from otherwise public ledger descriptions', async () => {
    reads.length = 0;
    render(<TransactionLedgerView userId={PLAYER_A} />);
    await waitFor(() => expect(reads).toHaveLength(1));
    await act(async () => {
      reads[0].resolve({
        data: [
          {
            ...entry('public-copy', 'Player Wallet'),
            description: 'Settlement Amount 100.00 Confirmed',
          },
        ],
        error: null,
      });
    });

    expect(await screen.findByText('Settlement Amount 100 Confirmed')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('100.00');
  });

  it('withholds an ambiguous decimal description instead of exposing chip cents', async () => {
    reads.length = 0;
    render(<TransactionLedgerView userId={PLAYER_A} />);
    await waitFor(() => expect(reads).toHaveLength(1));
    await act(async () => {
      reads[0].resolve({
        data: [
          {
            ...entry('decimal-copy', 'Player Wallet'),
            description: 'Settlement Amount 100.50 Confirmed',
          },
        ],
        error: null,
      });
    });

    expect(await screen.findByText('Player Wallet To Shark Club')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('100.50');
    expect(document.body.textContent).not.toContain('Settlement Amount');
  });

  it.each([
    '00000000-0000-0000-0000-000000000000',
    'fade0000-0000-0000-0000-000000000001',
    '0199a57f-7b6f-7cc4-8e8e-1a2b3c4d5e6f',
  ])('withholds descriptions containing the internal identifier %s', async (identifier) => {
    reads.length = 0;
    render(<TransactionLedgerView userId={PLAYER_A} />);
    await waitFor(() => expect(reads).toHaveLength(1));
    await act(async () => {
      reads[0].resolve({
        data: [
          {
            ...entry(`identifier-${identifier}`, 'Player Wallet'),
            description: `Settlement Record ${identifier} Confirmed`,
          },
        ],
        error: null,
      });
    });

    expect(await screen.findByText('Player Wallet To Shark Club')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(identifier);
    expect(document.body.textContent).not.toContain('Settlement Record');
  });

  it('never rounds a positive cent-scale ledger movement down to a visible zero', async () => {
    reads.length = 0;
    render(<TransactionLedgerView userId={PLAYER_A} />);
    await waitFor(() => expect(reads).toHaveLength(1));
    await act(async () => {
      reads[0].resolve({
        data: [{ ...entry('cent-scale', 'Player Wallet'), amount: 0.5 }],
        error: null,
      });
    });

    expect(await screen.findByText('Under 1 Chip')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('0.5');
  });

  it('fails the whole read closed when one immutable ledger movement is duplicated', async () => {
    reads.length = 0;
    render(<TransactionLedgerView userId={PLAYER_A} />);
    await waitFor(() => expect(reads).toHaveLength(1));
    await act(async () => {
      reads[0].resolve({
        data: [entry('duplicate', 'First Copy'), entry('duplicate', 'Second Copy')],
        error: null,
      });
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('The Ledger Could Not Be Loaded');
    expect(screen.queryByText('First Copy To Shark Club')).not.toBeInTheDocument();
    expect(screen.queryByText('Second Copy To Shark Club')).not.toBeInTheDocument();
  });

  it('fails closed when a read returns more rows than its requested limit', async () => {
    reads.length = 0;
    render(<TransactionLedgerView userId={PLAYER_A} limit={1} />);
    await waitFor(() => expect(reads).toHaveLength(1));
    await act(async () => {
      reads[0].resolve({
        data: [entry('first', 'First Movement'), entry('second', 'Second Movement')],
        error: null,
      });
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('The Ledger Could Not Be Loaded');
    expect(screen.queryByText(/Movement To Shark Club/)).not.toBeInTheDocument();
  });

  it('names every club role that the finance authorization contract admits', async () => {
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: 'not authorized for this club' },
    });
    render(<TransactionLedgerView clubId="11111111-1111-4111-8111-111111111111" clubScoped />);

    expect(
      await screen.findByText(
        'This Ledger Is Available To Club Owners, CO Owners, Admins And Super Agents.'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('announces a verified empty ledger instead of silently replacing the loading state', async () => {
    reads.length = 0;
    render(<TransactionLedgerView userId={PLAYER_A} />);
    await waitFor(() => expect(reads).toHaveLength(1));
    await act(async () => {
      reads[0].resolve({ data: [], error: null });
    });

    expect(await screen.findByRole('status')).toHaveTextContent('No Transactions Yet');
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  it('refuses a malformed club ledger receipt', async () => {
    rpc.mockResolvedValueOnce({ data: {}, error: null });
    render(<TransactionLedgerView clubId="11111111-1111-4111-8111-111111111111" clubScoped />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The Club Ledger Could Not Be Loaded'
    );
    expect(screen.queryByText('No Transactions Yet')).toBeNull();
  });

  it('refuses a club ledger receipt whose rows belong to another club', async () => {
    rpc.mockResolvedValueOnce({
      data: clubReceipt([{ ...entry('wrong-club-rpc', 'Player Wallet'), club_id: OTHER_CLUB_ID }]),
      error: null,
    });
    render(<TransactionLedgerView clubId={CLUB_ID} clubScoped />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The Club Ledger Could Not Be Loaded'
    );
    expect(screen.queryByText('Player Wallet To Shark Club')).not.toBeInTheDocument();
  });

  it('accepts an empty club ledger only when the receipt names the exact club and request', async () => {
    rpc.mockResolvedValueOnce({ data: clubReceipt([]), error: null });
    render(<TransactionLedgerView clubId={CLUB_ID} clubScoped />);

    expect(await screen.findByRole('status')).toHaveTextContent('No Transactions Yet');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('refuses an empty club ledger receipt stamped for another club', async () => {
    rpc.mockResolvedValueOnce({ data: clubReceipt([], OTHER_CLUB_ID), error: null });
    render(<TransactionLedgerView clubId={CLUB_ID} clubScoped />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The Club Ledger Could Not Be Loaded'
    );
    expect(screen.queryByText('No Transactions Yet')).not.toBeInTheDocument();
  });

  it('refuses a ledger row with a malformed account identity', async () => {
    reads.length = 0;
    render(<TransactionLedgerView userId={PLAYER_A} />);
    await waitFor(() => expect(reads).toHaveLength(1));
    await act(async () => {
      reads[0].resolve({
        data: [{ ...entry('bad-account', 'Player Wallet'), from_entity_id: 'not-a-uuid' }],
        error: null,
      });
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('The Ledger Could Not Be Loaded');
    expect(screen.queryByText('Player Wallet To Shark Club')).not.toBeInTheDocument();
  });
});
