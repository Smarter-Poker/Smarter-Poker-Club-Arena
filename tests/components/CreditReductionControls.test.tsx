import { act, fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { CREDIT_ID as ID, creditSnapshot, creditEnvelope } from '../helpers/creditReductionReceipt';
const auth = vi.hoisted(() => ({
  user: null as string | null,
  handlers: new Set<(event: any) => void>(),
}));
vi.mock('../../src/core/IdentityDNA', () => ({
  getIdentityDNAStatus: () => ({ loaded: true, authenticated: !!auth.user, userId: auth.user }),
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn((name, handler) => {
      if (name === 'AUTH_STATE_CHANGED') auth.handlers.add(handler);
      return () => auth.handlers.delete(handler);
    }),
    subscribeDebounced: () => () => {},
  },
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
vi.mock('../../src/utils/strictClubIdResolver', () => ({
  resolveClubUUIDStrict: vi.fn(async (id) => id),
}));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: async (id: string) => id }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: auth.user } }),
}));
vi.mock('../../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: vi.fn() }));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../src/services/WalletService', () => ({ WalletService: {} }));
vi.mock('../../src/components/common/TransactionLedgerView', () => ({ default: () => null }));
vi.mock('../../src/components/agent/AgentScoreCard', () => ({ default: () => null }));
vi.mock('../../src/components/agent/AgentBackOffice', () => ({ default: () => null }));
vi.mock('../../src/services/CreditService', async () => {
  const { runCreditReduction } = await import('../../src/services/CreditReductionOperation');
  return { CreditService: { lowerCreditLine: vi.fn(runCreditReduction) } };
});
import { CreditReductionControls } from '../../src/pages/AgentDashboardPage';
import { supabase } from '../../src/lib/supabase';
import { CreditService } from '../../src/services/CreditService';
import { masterBus } from '../../src/core/MasterBus';
import { useCashoutScopeKey } from '../../src/hooks/useCashoutScope';
const lookup = vi.fn(),
  apply = vi.fn(),
  retire = vi.fn();
const view = () => true;
let revision = 0;
const props = () => ({
  actorId: ID.actor,
  clubId: ID.club,
  targetUserId: ID.target,
  amount: '250',
  note: '',
  enabled: true,
  isCurrent: view,
  revision,
  getRevision: () => revision,
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function signIn(user: string | null) {
  auth.user = user;
  for (const handler of auth.handlers)
    handler({ payload: { isAuthenticated: !!user, userId: user } });
}
function EpochWrapper() {
  const key = useCashoutScopeKey(ID.actor, ID.club);
  return <CreditReductionControls key={key} {...props()} />;
}
beforeEach(() => {
  revision = 0;
  signIn(null);
  signIn(ID.actor);
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
  vi.mocked(masterBus.emit).mockClear();
  vi.mocked(CreditService.lowerCreditLine).mockClear();
  lookup
    .mockReset()
    .mockImplementation(async (_name, args) => ({ data: creditEnvelope(args), error: null }));
  apply.mockReset().mockImplementation(async (_name, args) => ({
    data: creditEnvelope(args, 'recorded', {}, false),
    error: null,
  }));
  retire.mockReset().mockImplementation(async (_name, args) => ({
    data: creditEnvelope(args, 'retired', {}, false),
    error: null,
  }));
  vi.mocked(supabase.rpc)
    .mockReset()
    .mockImplementation((name, args) => {
      if (name === 'fn_agent_credit_reduction_snapshot_v1')
        return Promise.resolve({ data: creditSnapshot(), error: null }) as never;
      if (name === 'fn_agent_credit_reduction_receipt_v1') return lookup(name, args);
      if (name === 'fn_reduce_agent_credit_v1') return apply(name, args);
      if (name === 'fn_retire_agent_credit_reduction_v1') return retire(name, args);
      throw new Error('Unexpected RPC');
    });
  const locks = new Map<string, Promise<unknown>>();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (key: string, _options: unknown, fn: () => unknown) => {
        const next = (locks.get(key) ?? Promise.resolve()).then(fn);
        locks.set(
          key,
          next.catch(() => undefined)
        );
        return next;
      },
    },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const button = () =>
  screen.getByRole('button', { name: 'Reduce Credit Line' }) as HTMLButtonElement;
async function submit() {
  await waitFor(() => expect(button().disabled).toBe(false));
  fireEvent.click(button());
}

// Actual controls + operation/coordinator/receipt parser, with remote/auth and page imports mocked.
// These are authored mounted-source tests, not a protected/native/provider run.
describe('credit reduction controls and retained receipts', () => {
  it('debounces idle preparation while immediate invalidation keeps only the latest exact intent eligible', async () => {
    vi.useFakeTimers();
    const snapshots = () =>
      vi
        .mocked(supabase.rpc)
        .mock.calls.filter(([name]) => name === 'fn_agent_credit_reduction_snapshot_v1');
    const component = render(<CreditReductionControls {...props()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(snapshots()).toHaveLength(0);
    expect(button().disabled).toBe(true);
    revision += 1;
    component.rerender(<CreditReductionControls {...props()} amount="25" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(snapshots()).toHaveLength(0);
    revision += 1;
    component.rerender(<CreditReductionControls {...props()} amount="27.15" note=" Updated " />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(snapshots()).toHaveLength(0);
    expect(button().disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await vi.waitFor(() => expect(snapshots()).toHaveLength(1));
    await vi.waitFor(() => expect(button().disabled).toBe(false));
    apply.mockImplementationOnce(async (_name, args) => ({
      data: creditEnvelope(
        args,
        'recorded',
        {
          requested_reduction: '27.15',
          applied_reduction: '27.15',
          after_limit: '72.85',
          after_prepaid: false,
          reason: 'Updated',
          assignment_reason: 'Updated',
        },
        false
      ),
      error: null,
    }));
    fireEvent.click(button());
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(apply.mock.calls[0][1].p_requested_reduction).toBe('27.15');
    expect(apply.mock.calls[0][1].p_reason).toBe('Updated');
  });
  it.each(['start', 'check', 'cancel'] as const)(
    'shows a synchronous %s capture failure with no dispatch or stuck busy state',
    async (action) => {
      if (action !== 'start') apply.mockRejectedValueOnce(new Error('lost'));
      render(<CreditReductionControls {...props()} />);
      if (action !== 'start') {
        await submit();
        await screen.findByText(/Response Was Lost/);
        await screen.findByRole('button', { name: 'Check Receipt' });
      } else await waitFor(() => expect(button().disabled).toBe(false));
      const previousApplies = apply.mock.calls.length,
        previousLookups = lookup.mock.calls.length;
      vi.spyOn(crypto, 'getRandomValues').mockImplementationOnce(() => {
        throw new Error('Random Source Unavailable');
      });
      fireEvent.click(
        action === 'start'
          ? button()
          : screen.getByRole('button', {
              name: action === 'check' ? 'Check Receipt' : 'Cancel Pending Change',
            })
      );
      expect(await screen.findByText('Random Source Unavailable')).toBeTruthy();
      expect(screen.queryByText('Checking Credit Change...')).toBeNull();
      expect(apply).toHaveBeenCalledTimes(previousApplies);
      expect(lookup).toHaveBeenCalledTimes(previousLookups);
      expect(retire).not.toHaveBeenCalled();
    }
  );
  it('shows applied reduction and historical limit, never the requested amount as a successful payment', async () => {
    render(<CreditReductionControls {...props()} />);
    await submit();
    expect(await screen.findByText('Credit Line Reduced By 100.00 Chips.')).toBeTruthy();
    expect(screen.getByText('Limit After This Change: 0.00 Chips.')).toBeTruthy();
    expect(screen.queryByText('Credit Line Reduced By 250.00 Chips.')).toBeNull();
    expect(screen.getByText(/No Chips Moved And No Payment Is Due/)).toBeTruthy();
    expect(masterBus.emit).toHaveBeenCalledTimes(1);
    expect(masterBus.emit).toHaveBeenCalledWith('CREDIT_UPDATED', {
      clubId: ID.club,
      userId: ID.target,
    });
  });
  it('restores an unknown item after unmount, and Check Receipt cannot become another reduction', async () => {
    apply.mockRejectedValueOnce(new Error('lost'));
    const first = render(<CreditReductionControls {...props()} />);
    await submit();
    await screen.findByText(/Response Was Lost/);
    const operation = apply.mock.calls[0][1].p_operation_id;
    first.unmount();
    sessionStorage.clear();
    render(<CreditReductionControls {...props()} amount="1" />);
    const check = await screen.findByRole('button', { name: 'Check Receipt' });
    fireEvent.click(check);
    expect(
      await screen.findByText('No Recorded Result Yet. This Change Remains Pending.')
    ).toBeTruthy();
    // The receipt status renders before the asynchronous pending-index refresh.
    expect(await screen.findByText('Pending Credit Change 1')).toBeTruthy();
    expect(lookup.mock.calls.at(-1)![1].p_operation_id).toBe(operation);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(button().disabled).toBe(true);
    const cancel = await screen.findByRole('button', { name: 'Cancel Pending Change' });
    await waitFor(() => expect(cancel).not.toBeDisabled());
    fireEvent.click(cancel);
    expect(
      await screen.findByText('Pending Change Cancelled. Its Original Request Cannot Apply.')
    ).toBeTruthy();
    expect(retire.mock.calls[0][1].p_operation_id).toBe(operation);
  });
  it('recovers an already-applied original result after reload without another apply', async () => {
    apply.mockRejectedValueOnce(new Error('lost'));
    const first = render(<CreditReductionControls {...props()} />);
    await submit();
    await screen.findByText(/Response Was Lost/);
    first.unmount();
    sessionStorage.clear();
    lookup.mockImplementation(async (_name, args) => ({
      data: creditEnvelope(args, 'recorded'),
      error: null,
    }));
    render(<CreditReductionControls {...props()} enabled={false} targetUserId="" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check Receipt' }));
    expect(await screen.findByText('Credit Line Reduced By 100.00 Chips.')).toBeTruthy();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Reduce Credit Line' })).toBeNull();
  });
  it('retires a pending form gesture through amount ABA before its receipt lookup returns', async () => {
    const delayed = deferred<any>();
    lookup.mockReturnValueOnce(delayed.promise);
    const component = render(<CreditReductionControls {...props()} />);
    await submit();
    await waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    act(() => {
      revision += 2;
      component.rerender(<CreditReductionControls {...props()} />);
    });
    await act(async () => {
      delayed.resolve({ data: creditEnvelope(lookup.mock.calls[0][1]), error: null });
    });
    await waitFor(() => expect(screen.queryByText('Checking Credit Change...')).toBeNull());
    expect(apply).not.toHaveBeenCalled();
    expect(screen.queryByText(/Credit Line Reduced By/)).toBeNull();
    expect(await screen.findByRole('button', { name: 'Check Receipt' })).toBeTruthy();
  });
  it('remounts the actual account epoch while an old request remains pending, with no manual rerender', async () => {
    const delayed = deferred<any>();
    lookup.mockReturnValueOnce(delayed.promise);
    render(<EpochWrapper />);
    await submit();
    await waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    act(() => {
      signIn(null);
      signIn(ID.actor);
    });
    await screen.findByRole('button', { name: 'Check Receipt' });
    await act(async () => {
      delayed.resolve({ data: creditEnvelope(lookup.mock.calls[0][1], 'recorded'), error: null });
    });
    expect(screen.queryByText(/Credit Line Reduced By/)).toBeNull();
    expect(masterBus.emit).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Check Receipt' }));
    expect(
      await screen.findByText('No Recorded Result Yet. This Change Remains Pending.')
    ).toBeTruthy();
  });
  it('blocks invalid precision during idle preparation without dispatching', async () => {
    render(<CreditReductionControls {...props()} amount="1.001" />);
    expect(await screen.findByText(/At Most Two Decimal Places/)).toBeTruthy();
    expect(button().disabled).toBe(true);
    expect(apply).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(supabase.rpc)
        .mock.calls.filter(([name]) => name === 'fn_agent_credit_reduction_snapshot_v1')
    ).toHaveLength(0);
  });
});
