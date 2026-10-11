import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  club: 'first-club',
  rpc: vi.fn(),
  wallet: vi.fn(),
  member: vi.fn(),
  roster: vi.fn(),
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
  signals: [] as AbortSignal[],
}));
vi.mock('react-router-dom', () => ({
  useParams: () => ({ clubId: state.club }),
  useSearchParams: () => [new URLSearchParams()],
  useNavigate: () => vi.fn(),
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: 'viewer' } }) }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => state.toast }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/utils/strictClubIdResolver', () => ({
  resolveClubUUIDStrict: async (club: string) => club,
}));
vi.mock('../../src/services/ClubRosterService', () => ({
  default: { getRoster: (...args: unknown[]) => state.roster(...args) },
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => {
      const request = state.rpc(name, args);
      return {
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          request.then(resolve, reject),
        abortSignal: (signal: AbortSignal) => {
          state.signals.push(signal);
          return request;
        },
      };
    },
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        abortSignal: (signal: AbortSignal) => {
          state.signals.push(signal);
          return chain;
        },
        maybeSingle: () => {
          return table === 'club_diamond_wallets' ? state.wallet() : state.member();
        },
      };
      return chain;
    },
  },
}));
import PromoVaultPage from '../../src/pages/PromoVaultPage';
const catalog = [
  { item_key: 'time-bank', category: 'feature', label: 'Time Bank', quantity: 1, diamond_cost: 10 },
];
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.clearAllMocks();
  state.club = 'first-club';
  state.signals = [];
  state.rpc.mockResolvedValue({ data: catalog, error: null });
  state.wallet.mockResolvedValue({ data: null, error: null });
  state.member.mockResolvedValue({ data: { role: 'owner' }, error: null });
  state.roster.mockResolvedValue([{ user_id: 'viewer', role: 'owner' }]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe('Promo Vault owns truthful bounded reads', () => {
  it('keeps a stalled catalog loading at eight seconds and reports the deadline instead of an empty vault', async () => {
    vi.useFakeTimers();
    state.rpc.mockReturnValue(new Promise(() => {}));
    render(<PromoVaultPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(screen.queryByText('Click An Item To Grant')).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(32_000);
    });
    expect(screen.getByText(/live vault catalog could not be loaded/i)).toBeInTheDocument();
    expect(state.signals.every((signal) => signal.aborted)).toBe(true);
    expect(state.rpc).toHaveBeenCalledTimes(1);
  });
  it.each(['wallet', 'roster', 'member'])(
    'reports a failed %s read rather than showing a valid zero or stale authority',
    async (owner) => {
      if (owner === 'roster') state.roster.mockRejectedValue(new Error('unavailable'));
      if (owner === 'wallet')
        state.wallet.mockResolvedValue({ data: null, error: { message: 'unavailable' } });
      if (owner === 'member') {
        state.roster.mockResolvedValue([]);
        state.member.mockResolvedValue({ data: null, error: { message: 'unavailable' } });
      }
      render(<PromoVaultPage />);
      expect(
        await screen.findByText(/live vault catalog could not be loaded/i)
      ).toBeInTheDocument();
      expect(screen.queryByText('Time Bank')).not.toBeInTheDocument();
      expect(screen.getByTitle('Club Diamond Balance')).toHaveTextContent('Unavailable');
    }
  );
  it('accepts an actual empty catalog and absent wallet row', async () => {
    state.rpc.mockResolvedValue({ data: [], error: null });
    render(<PromoVaultPage />);
    expect(await screen.findByText('Click An Item To Grant')).toBeInTheDocument();
    expect(state.toast.error).not.toHaveBeenCalled();
  });
  it('rejects an incomplete catalog rather than fabricating an empty inventory', async () => {
    state.rpc.mockResolvedValue({ data: null, error: null });
    render(<PromoVaultPage />);
    expect(await screen.findByText(/live vault catalog could not be loaded/i)).toBeInTheDocument();
  });
  it('cancels an old club request and ignores its late catalog', async () => {
    const old = deferred<{ data: typeof catalog; error: null }>();
    state.rpc.mockReturnValueOnce(old.promise);
    const view = render(<PromoVaultPage />);
    await waitFor(() => expect(state.rpc).toHaveBeenCalledTimes(1));
    const oldSignal = state.signals[0];
    state.club = 'second-club';
    view.rerender(<PromoVaultPage />);
    expect(await screen.findByText('Time Bank')).toBeInTheDocument();
    expect(oldSignal.aborted).toBe(true);
    await act(async () =>
      old.resolve({ data: [{ ...catalog[0], label: 'Old Club Item' }], error: null })
    );
    expect(screen.queryByText('Old Club Item')).not.toBeInTheDocument();
  });
  it('shows a retryable records error instead of an empty history and recovers manually', async () => {
    render(<PromoVaultPage />);
    await screen.findByText('Time Bank');
    state.rpc.mockResolvedValueOnce({ data: null, error: { message: 'records denied' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Records' }));
    expect(
      await screen.findByText('The Live Vault Records Could Not Be Loaded.')
    ).toBeInTheDocument();
    state.rpc.mockResolvedValueOnce({ data: [], error: null });
    fireEvent.click(screen.getByRole('button', { name: /retry|try again/i }));
    await waitFor(() =>
      expect(
        screen.queryByText('The Live Vault Records Could Not Be Loaded.')
      ).not.toBeInTheDocument()
    );
  });
  it('bounds stalled records and ignores records from a club left behind', async () => {
    const old = deferred<{ data: unknown[]; error: null }>();
    const view = render(<PromoVaultPage />);
    await screen.findByText('Time Bank');
    state.rpc.mockReturnValueOnce(old.promise);
    fireEvent.click(screen.getByRole('tab', { name: 'Records' }));
    await waitFor(() => expect(state.rpc).toHaveBeenCalledTimes(2));
    const oldSignal = state.signals[state.signals.length - 1];
    state.rpc.mockImplementation((name) =>
      Promise.resolve({ data: name === 'ca_promo_vault_records' ? [] : catalog, error: null })
    );
    state.club = 'second-club';
    view.rerender(<PromoVaultPage />);
    await waitFor(() =>
      expect(state.rpc).toHaveBeenCalledWith('ca_promo_vault_records', {
        p_club_id: 'second-club',
        p_limit: 100,
      })
    );
    expect(oldSignal.aborted).toBe(true);
    await act(async () =>
      old.resolve({
        data: [
          {
            id: 'old',
            item_label: 'Old Club Purchase',
            action: 'purchase',
            created_at: '2026-10-10',
            quantity: 1,
          },
        ],
        error: null,
      })
    );
    expect(screen.queryByText('Old Club Purchase')).not.toBeInTheDocument();
  });
  it('reports a stalled history at its deadline without retrying it', async () => {
    render(<PromoVaultPage />);
    await screen.findByText('Time Bank');
    vi.useFakeTimers();
    state.rpc.mockReturnValueOnce(new Promise(() => {}));
    fireEvent.click(screen.getByRole('tab', { name: 'Records' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    expect(screen.getByText('The Live Vault Records Could Not Be Loaded.')).toBeInTheDocument();
    expect(state.rpc).toHaveBeenCalledTimes(2);
  });
});

it('ignores an old club purchase answer after navigation', async () => {
  const old = deferred<{ data: Record<string, unknown>; error: null }>();
  state.wallet.mockResolvedValue({ data: { balance: 100 }, error: null });
  state.rpc.mockImplementation((name) =>
    name === 'ca_promo_vault_buy' ? old.promise : Promise.resolve({ data: catalog, error: null })
  );
  const view = render(<PromoVaultPage />);
  await screen.findByText('Time Bank');
  fireEvent.click(screen.getByRole('button', { name: 'Buy More Time Bank' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  await waitFor(() =>
    expect(state.rpc).toHaveBeenCalledWith('ca_promo_vault_buy', expect.anything())
  );
  state.club = 'second-club';
  view.rerender(<PromoVaultPage />);
  await screen.findByText('Time Bank');
  await act(async () =>
    old.resolve({
      data: { success: true, quantity: 99, diamond_balance: 1, diamonds_spent: 10 },
      error: null,
    })
  );
  expect(screen.getByTitle('Club Diamond Balance')).toHaveTextContent('100');
  expect(state.toast.success).not.toHaveBeenCalled();
});

it('bounds a stalled purchase without automatically replaying it', async () => {
  state.wallet.mockResolvedValue({ data: { balance: 100 }, error: null });
  render(<PromoVaultPage />);
  await screen.findByText('Time Bank');
  vi.useFakeTimers();
  state.rpc.mockImplementation((name) =>
    name === 'ca_promo_vault_buy'
      ? new Promise(() => {})
      : Promise.resolve({ data: catalog, error: null })
  );
  fireEvent.click(screen.getByRole('button', { name: 'Buy More Time Bank' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(40_000);
  });
  expect(state.toast.error).toHaveBeenCalledWith('That Purchase Could Not Be Completed');
  expect(state.rpc.mock.calls.filter(([name]) => name === 'ca_promo_vault_buy')).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled();
});

it('retains the same grant receipt after an unknown answer and separates a new club attempt', async () => {
  state.roster.mockResolvedValue([
    { user_id: 'viewer', role: 'owner', alias: 'Recipient', username: 'recipient' },
  ]);
  const view = render(<PromoVaultPage />);
  await screen.findByText('Time Bank');
  const grantCalls: Array<{ p_op_id: string; p_club_id: string }> = [];
  state.rpc.mockImplementation((name, args) => {
    if (name === 'ca_promo_vault_grant') {
      grantCalls.push(args);
      return Promise.resolve({ data: null, error: { message: 'Unknown Acknowledgement' } });
    }
    return Promise.resolve({ data: catalog, error: null });
  });
  fireEvent.click(screen.getByRole('button', { name: 'Grant Time Bank' }));
  fireEvent.click(screen.getByRole('button', { name: /Recipient/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  await waitFor(() => expect(grantCalls).toHaveLength(1));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  await waitFor(() => expect(grantCalls).toHaveLength(2));
  expect(grantCalls[1].p_op_id).toBe(grantCalls[0].p_op_id);
  state.club = 'second-club';
  view.rerender(<PromoVaultPage />);
  await screen.findByText('Time Bank');
  fireEvent.click(screen.getByRole('button', { name: 'Grant Time Bank' }));
  fireEvent.click(screen.getByRole('button', { name: /Recipient/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  await waitFor(() => expect(grantCalls).toHaveLength(3));
  expect(grantCalls[2].p_op_id).not.toBe(grantCalls[0].p_op_id);
  expect(grantCalls[2].p_club_id).toBe('second-club');
});
