import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  user: { id: 'player-1' },
  result: { data: [] as Record<string, unknown>[], error: null as unknown },
  rpc: vi.fn(),
  from: vi.fn(),
  eq: vi.fn(),
  emit: vi.fn(),
  toast: { error: vi.fn() },
  refresh: (() => {}) as () => void,
}));

// Only external boundaries are replaced. The page, readiness helper, header and retry owner run.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      fixture.from(table);
      const query = {
        select: () => query,
        eq: (...args: unknown[]) => {
          fixture.eq(...args);
          return query;
        },
        order: () => query,
        limit: () => Promise.resolve(fixture.result),
      };
      return query;
    },
    rpc: (...args: unknown[]) => fixture.rpc(...args),
  },
}));
vi.mock('@/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: fixture.user }) }));
vi.mock('@/hooks/useMasterBusChannel', () => ({ useMasterBusChannel: () => {} }));
vi.mock('@/hooks/useVisibilityRefresh', () => ({
  useVisibilityRefresh: (refresh: () => void) => {
    fixture.refresh = refresh;
  },
}));
vi.mock('@/components/common/Toast', () => ({ useToast: () => fixture.toast }));
vi.mock('@/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('@/core/MasterBus', () => ({
  masterBus: {
    subscribeDebounced: () => () => {},
    emit: (...args: unknown[]) => fixture.emit(...args),
  },
}));
// Charts are unrelated to readiness and need a measured browser layout.
vi.mock('recharts', () => ({
  ResponsiveContainer: () => null,
  BarChart: () => null,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  CartesianGrid: () => null,
}));

import RakebackPage from '@/pages/RakebackPage';

function period(id: string, club: string, end: string, earned: number, status = 'pending') {
  return {
    id,
    user_id: 'player-1',
    club_id: club,
    period_start: end,
    period_end: end,
    rake_generated: earned * 10,
    rakeback_rate: 0.1,
    rakeback_earned: earned,
    status,
  };
}
async function openPage(rows: Record<string, unknown>[]) {
  fixture.result = { data: rows, error: null };
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <MemoryRouter>
        <RakebackPage />
      </MemoryRouter>
    );
  });
  return view;
}
function readyValue() {
  const summary = screen.getByLabelText('Rakeback Engine Live Summary');
  return within(summary).getByText('Ready To Claim').parentElement!.querySelector('dd')!
    .textContent;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-11T12:00:00.000Z'));
  vi.clearAllMocks();
  fixture.rpc.mockResolvedValue({
    data: { success: true, total_payout: 0, periods_claimed: 0 },
    error: null,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('RakebackPage closed UTC earning periods', () => {
  it('keeps an end-today period visible as pending without offering a claim', async () => {
    const view = await openPage([period('open', 'club-open', '2026-09-11', 17)]);
    expect(readyValue()).toBe('0');
    expect(screen.getByText('Pending Earnings: 17')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Claim Rakeback' })).toBeNull();
    expect(view.container.querySelectorAll('.period-row')).toHaveLength(1);
    expect(view.container.querySelector('.period-earned .status')).toHaveTextContent('Pending');
    expect(fixture.rpc).not.toHaveBeenCalled();
  });

  it('targets a positive closed club across newer open, zero, missing-club and paid rows', async () => {
    const rows = [
      period('open', 'club-open', '2026-09-11', 30),
      period('zero', 'club-zero', '2026-09-10', 0),
      period('missing-club', '', '2026-09-10', 5),
      period('ready', 'club-ready', '2026-09-10', 20),
      period('other-ready', 'club-other', '2026-09-09', 10),
      period('paid', 'club-paid', '2026-09-08', 7, 'paid'),
    ];
    fixture.rpc.mockImplementation(async () => {
      fixture.result = {
        data: rows.map((row) => (row.id === 'ready' ? { ...row, status: 'paid' } : row)),
        error: null,
      };
      return { data: { success: true, total_payout: 20, periods_claimed: 1 }, error: null };
    });
    const view = await openPage(rows);
    expect(readyValue()).toBe('30');
    expect(screen.getByText('Pending Earnings: 35')).toBeInTheDocument();
    expect(view.container.querySelectorAll('.period-row')).toHaveLength(6);
    expect(view.container.querySelectorAll('.period-earned .status.paid')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Claim All' })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Claim Rakeback' }));
    });
    expect(fixture.rpc).toHaveBeenCalledExactlyOnceWith('fn_claim_rakeback', {
      p_club_id: 'club-ready',
    });
    expect(readyValue()).toBe('10');
    expect(screen.getByText('Pending Earnings: 35')).toBeInTheDocument();
    expect(view.container.querySelectorAll('.period-row')).toHaveLength(6);
    expect(fixture.eq).toHaveBeenCalledWith('user_id', 'player-1');
    expect(fixture.emit).toHaveBeenCalledWith('RAKEBACK_CLAIMED', {
      clubId: 'club-ready',
      amount: 20,
      userId: 'player-1',
    });
  });

  it('becomes ready at the next UTC midnight while the page stays open', async () => {
    vi.setSystemTime(new Date('2026-09-11T23:59:59.999Z'));
    const view = await openPage([period('boundary', 'club-boundary', '2026-09-11', 9)]);
    expect(readyValue()).toBe('0');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(readyValue()).toBe('9');
    expect(screen.getByText('Pending Earnings: 0')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Claim Rakeback' })).toBeEnabled();
    expect(fixture.from).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rechecks the current clock before any RPC even if the displayed readiness is stale', async () => {
    await openPage([period('closed', 'club-closed', '2026-09-10', 9)]);
    expect(readyValue()).toBe('9');
    vi.setSystemTime(new Date('2026-09-10T23:59:59.000Z'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Claim Rakeback' }));
    });
    expect(fixture.rpc).not.toHaveBeenCalled();
    expect(readyValue()).toBe('0');
    expect(screen.getByText('No Closed Earning Periods Are Ready To Claim.')).toBeInTheDocument();
  });

  it.each(['2026-02-30', 'unknown', '2026-09-10T00:00:00Z'])(
    'does not convert malformed DATE %s into eligibility',
    async (end) => {
      const view = await openPage([period('malformed', 'club-unknown', end, 4)]);
      expect(readyValue()).toBe('0');
      expect(screen.getByText('Pending Earnings: 4')).toBeInTheDocument();
      expect(view.container.querySelectorAll('.period-row')).toHaveLength(1);
      expect(screen.queryByRole('button', { name: 'Claim Rakeback' })).toBeNull();
      expect(fixture.rpc).not.toHaveBeenCalled();
    }
  );

  it('disables a stale ready claim when refreshing the earning periods fails', async () => {
    await openPage([period('closed', 'club-closed', '2026-09-10', 9)]);
    fixture.result = { data: [], error: { message: 'read unavailable' } };
    await act(async () => {
      fixture.refresh();
    });
    expect(screen.getByRole('button', { name: 'Claim Rakeback' })).toBeDisabled();
    expect(fixture.rpc).not.toHaveBeenCalled();
    expect(fixture.toast.error).toHaveBeenCalled();
  });
});

describe('RakebackPage installed claim response contract', () => {
  async function claim(response: unknown) {
    fixture.rpc.mockResolvedValue({ data: response, error: null });
    await openPage([period('closed', 'club-closed', '2026-09-10', 9)]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Claim Rakeback' }));
    });
  }

  it('shows an explicit RPC refusal without claiming a payout', async () => {
    await claim({ success: false, error: 'authentication required' });
    expect(screen.getByText('authentication required')).toBeInTheDocument();
    expect(fixture.emit).not.toHaveBeenCalled();
    expect(fixture.toast.error).toHaveBeenCalledWith('authentication required');
  });

  it('reports a valid zero aggregate as no payout rather than a successful claim', async () => {
    await claim({ success: true, total_payout: 0, periods_claimed: 0 });
    expect(
      screen.getByText('No Rakeback Was Paid. Pending Periods May Be Deferred.')
    ).toBeInTheDocument();
    expect(fixture.emit).not.toHaveBeenCalled();
    expect(fixture.from).toHaveBeenCalledTimes(2);
  });

  it('reports only the server-confirmed partial payout and triggers authoritative wallet refresh', async () => {
    await claim({ success: true, total_payout: 4.5, periods_claimed: 1 });
    expect(screen.getByText('Claimed 4.5 chips!')).toBeInTheDocument();
    expect(screen.queryByText('Claimed 9 chips!')).toBeNull();
    expect(fixture.emit).toHaveBeenCalledWith('WALLET_REFRESHED', {
      walletType: 'PLAYER',
      available: 0,
      total: 0,
    });
    expect(fixture.emit).toHaveBeenCalledWith('RAKEBACK_CLAIMED', {
      clubId: 'club-closed',
      amount: 4.5,
      userId: 'player-1',
    });
  });

  it('keeps a second claim pending past the previous success timer and retains its refusal', async () => {
    const rows = [
      period('first', 'club-first', '2026-09-10', 9),
      period('second', 'club-second', '2026-09-09', 11),
    ];
    let finishSecond!: (value: unknown) => void;
    fixture.rpc.mockImplementationOnce(async () => {
      fixture.result = { data: [{ ...rows[0], status: 'paid' }, rows[1]], error: null };
      return { data: { success: true, total_payout: 9, periods_claimed: 1 }, error: null };
    });
    fixture.rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSecond = resolve;
        })
    );
    await openPage(rows);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Claim Rakeback' }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '✓ Claimed!' }));
    });
    expect(fixture.rpc).toHaveBeenNthCalledWith(2, 'fn_claim_rakeback', {
      p_club_id: 'club-second',
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(screen.getByRole('button', { name: 'Claiming...' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Claiming...' }));
    expect(fixture.rpc).toHaveBeenCalledTimes(2);
    await act(async () => {
      finishSecond({ data: { success: false, error: 'Second Claim Refused' }, error: null });
    });
    expect(screen.getByText('Second Claim Refused')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByText('Second Claim Refused')).toBeInTheDocument();
    expect(fixture.rpc).toHaveBeenCalledTimes(2);
  });

  it('never treats a refused response with contradictory positive numbers as paid', async () => {
    await claim({ success: false, error: 'Claim Refused', total_payout: 9, periods_claimed: 1 });
    expect(screen.getByText('Claim Refused')).toBeInTheDocument();
    expect(fixture.emit).not.toHaveBeenCalled();
  });

  it.each([
    ['missing result', null],
    ['missing success flag', { total_payout: 9, periods_claimed: 1 }],
    [
      'success with error',
      { success: true, error: 'Unknown Outcome', total_payout: 9, periods_claimed: 1 },
    ],
    ['non-number amount', { success: true, total_payout: 'NaN', periods_claimed: 1 }],
    ['infinite amount', { success: true, total_payout: 'Infinity', periods_claimed: 1 }],
    ['negative amount', { success: true, total_payout: -1, periods_claimed: 1 }],
    [
      'unsafe amount',
      { success: true, total_payout: Number.MAX_SAFE_INTEGER + 1, periods_claimed: 1 },
    ],
    ['fractional count', { success: true, total_payout: 9, periods_claimed: 1.5 }],
    ['negative count', { success: true, total_payout: 9, periods_claimed: -1 }],
    [
      'positive amount without a paid period',
      { success: true, total_payout: 9, periods_claimed: 0 },
    ],
    [
      'paid period without a positive amount',
      { success: true, total_payout: 0, periods_claimed: 1 },
    ],
    ['null amount', { success: true, total_payout: null, periods_claimed: 1 }],
  ])(
    'refuses to assert a claim for %s and refreshes the unknown outcome',
    async (_name, response) => {
      await claim(response);
      expect(
        screen.getByText(
          'Claim Result Could Not Be Confirmed. Please Check Your Refreshed Balances.'
        )
      ).toBeInTheDocument();
      expect(screen.queryByText(/^Claimed .* chips!$/)).toBeNull();
      expect(fixture.emit).not.toHaveBeenCalledWith('RAKEBACK_CLAIMED', expect.anything());
      expect(fixture.emit).toHaveBeenCalledExactlyOnceWith('WALLET_REFRESHED', {
        walletType: 'PLAYER',
        available: 0,
        total: 0,
      });
      expect(fixture.from).toHaveBeenCalledTimes(2);
    }
  );
});
