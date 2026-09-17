import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { MemoryRouter } from 'react-router-dom';
import {
  CASHOUT_IDS as ID,
  cashoutV2Receipt,
  cashoutLookupEnvelope,
} from '../helpers/cashoutV2Receipt';
const identity = vi.hoisted(() => ({ userId: '' }));
vi.unmock('../../src/core/MasterBus');
vi.mock('../../src/core/IdentityDNA', () => ({
  getIdentityDNAStatus: () => ({
    loaded: !!identity.userId,
    authenticated: !!identity.userId,
    userId: identity.userId,
  }),
}));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: identity.userId } }),
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
// No store initialization, provider connection or financial DB is exercised.
// The real bus emitter/subscriber/debounce, wrapper and receipt parser ARE used.
vi.mock('../../src/stores/useArenaStore', () => ({ useArenaStore: {} }));
vi.mock('../../src/stores/useClubStore', () => ({ useClubStore: {} }));
vi.mock('../../src/stores/useTableStore', () => ({ useTableStore: {} }));
vi.mock('../../src/stores/useUnionStore', () => ({ useUnionStore: {} }));
vi.mock('../../src/stores/useWalletStore', () => ({ useWalletStore: {} }));
vi.mock('../../src/stores/useSettingsStore', () => ({ useSettingsStore: {} }));
vi.mock('../../src/stores/useUserStore', () => ({ useUserStore: {} }));
vi.mock('../../src/services/RealtimeChannelService', () => ({ realtimeChannelService: {} }));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: async (id: string) => id }));
vi.mock('../../src/utils/strictClubIdResolver', () => ({
  resolveClubUUIDStrict: async (id: string) => id,
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/utils/avatarGenerator', () => ({ generateDefaultAvatar: () => '' }));
vi.mock('../../src/lib/date', () => ({ formatRelativeShort: () => 'Recently' }));
vi.mock('../../src/utils/vibrationGate', () => ({ fireVibration: vi.fn() }));
vi.mock('../../src/utils/settlementLock', () => ({
  checkSettlementLock: vi.fn(async () => ({ locked: false })),
}));
vi.mock('../../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: () => {} }));
vi.mock('../../src/utils/resolvePageClubId', () => ({
  resolvePageClubId: async () => '51000000-0000-4000-8000-000000000004',
  pickPreferredClubId: () => null,
}));
vi.mock('../../src/utils/retryFetch', () => ({ retryFetch: (fn: () => unknown) => fn() }));
vi.mock('../../src/components/common/confirmDialog', () => ({
  confirmDialog: vi.fn(async () => true),
}));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../src/services/WalletService', () => ({ WalletService: {} }));
vi.mock('../../src/services/CreditService', () => ({ CreditService: {} }));
vi.mock('../../src/components/common/TransactionLedgerView', () => ({ default: () => null }));
vi.mock('../../src/components/agent/AgentScoreCard', () => ({ default: () => null }));
vi.mock('../../src/components/agent/AgentBackOffice', () => ({ default: () => null }));
import { masterBus } from '../../src/core/MasterBus';
import { supabase } from '../../src/lib/supabase';
import { cashoutService } from '../../src/services/CashoutService';
import AgentDashboardPage from '../../src/pages/AgentDashboardPage';
import AgentCashoutPanel from '../../src/components/agent/AgentCashoutPanel';
import CashoutRequestModal from '../../src/components/wallet/CashoutRequestModal';
const row = {
  id: ID.cashout,
  clubId: ID.club,
  playerId: ID.player,
  agentId: ID.agent,
  playerName: 'Original Player',
  amount: 250,
  status: 'pending' as const,
  createdAt: '2026-09-15T09:00:00+00:00',
};
let providerChange: () => void;
let receiptReturned: boolean;
let gateAcknowledgment: boolean;
let ackWaiting: boolean;
let releaseAck: () => void;
let done: ReturnType<typeof vi.fn>;
let dashboardReads: number;
let dashboardReadGate: Promise<unknown> | null;
function signIn(userId: string) {
  identity.userId = userId;
  masterBus.emit('AUTH_STATE_CHANGED', { userId, isAuthenticated: !!userId });
}
function retainedHistory() {
  // Use the Storage API: the shared harness stores values behind length/key(),
  // so object properties are methods, not persisted operation identities.
  const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
  const key = keys.find(
    (key): key is string =>
      key !== null &&
      key.startsWith('smarter-poker:cashout-generations:v2:') &&
      JSON.parse(localStorage.getItem(key)!).generations.some(
        (generation: any) => generation.starts.length > 0
      )
  );
  return key ? JSON.parse(localStorage.getItem(key)!) : null;
}
beforeEach(() => {
  signIn('');
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
  done = vi.fn();
  dashboardReads = 0;
  dashboardReadGate = null;
  gateAcknowledgment = true;
  receiptReturned = false;
  ackWaiting = false;
  providerChange = () => {
    throw new Error('Channel Has Not Been Registered');
  };
  const locks = new Map<string, Promise<unknown>>();
  const ack = new Promise<void>((resolve) => {
    releaseAck = resolve;
  });
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (key: string, _options: unknown, callback: () => unknown) => {
        const next = (locks.get(key) ?? Promise.resolve()).then(async () => {
          if (gateAcknowledgment && receiptReturned && !ackWaiting) {
            ackWaiting = true;
            await ack;
          }
          return callback();
        });
        locks.set(
          key,
          next.catch(() => undefined)
        );
        return next;
      },
    },
  });
  const channel = { on: vi.fn(), subscribe: vi.fn() };
  channel.on.mockImplementation((_event, _filter, callback) => {
    providerChange = callback;
    return channel;
  });
  channel.subscribe.mockReturnValue(channel);
  vi.spyOn(masterBus, 'getOrCreateChannel').mockReturnValue(channel as never);
  vi.spyOn(masterBus, 'removeRegisteredChannel').mockImplementation(() => {});
  vi.spyOn(cashoutService, 'getAgentPendingCashouts').mockResolvedValue([row]);
  vi.spyOn(cashoutService, 'getPlayerCashouts').mockResolvedValue([row]);
  vi.mocked(supabase.from).mockImplementation((table: string) => {
    const query: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'order', 'limit', 'or'])
      query[method] = () => query;
    query.maybeSingle = () => Promise.resolve({ data: { role: 'agent' }, error: null });
    query.then = (resolve: (value: unknown) => unknown) => {
      if (table === 'cashout_requests') dashboardReads += 1;
      if (table === 'cashout_requests' && dashboardReadGate) return dashboardReadGate.then(resolve);
      return Promise.resolve({
        data:
          table === 'cashout_requests'
            ? [
                {
                  id: ID.cashout,
                  player_id: ID.player,
                  club_id: ID.club,
                  amount: 250,
                  status: 'pending',
                  created_at: row.createdAt,
                },
              ]
            : [],
        error: null,
      }).then(resolve);
    };
    return query as never;
  });
  vi.mocked(supabase.rpc)
    .mockReset()
    .mockImplementation(async (name, args) => {
      if (name === 'fn_cashout_operation_receipt_v2')
        return { data: cashoutLookupEnvelope(args!), error: null } as never;
      receiptReturned = true;
      return {
        data: {
          ...cashoutV2Receipt(name === 'fn_cashout_approve_v2' ? 'approval' : 'cancellation'),
          op_id: args!.p_op_id,
        },
        error: null,
      } as never;
    });
});
afterEach(() => {
  cleanup();
  releaseAck();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(['panel', 'modal'] as const)(
  'hides already visible %s rows on a batched real auth ABA while the new read is pending',
  async (surface) => {
    const actor = surface === 'panel' ? ID.agent : ID.player;
    signIn(actor);
    const element = () =>
      surface === 'panel' ? (
        <AgentCashoutPanel clubId={ID.club} />
      ) : (
        <CashoutRequestModal
          isOpen
          playerId={ID.player}
          clubId={ID.club}
          currentBalance={500}
          onClose={() => {}}
        />
      );
    const view = render(element());
    const action = surface === 'panel' ? 'Approve Cashout' : 'Cancel';
    await screen.findByRole('button', { name: action });
    let resolveRows!: (value: (typeof row)[]) => void;
    const rows = new Promise<(typeof row)[]>((resolve) => {
      resolveRows = resolve;
    });
    const read =
      surface === 'panel'
        ? vi.mocked(cashoutService.getAgentPendingCashouts)
        : vi.mocked(cashoutService.getPlayerCashouts);
    read.mockReturnValue(rows);
    act(() => {
      signIn(ID.other);
      signIn(actor);
      view.rerender(element());
    });
    expect(screen.queryByRole('button', { name: action })).toBeNull();
    expect(screen.queryByText(surface === 'panel' ? 'Original Player' : '250 Chips')).toBeNull();
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(vi.mocked(supabase.rpc)).not.toHaveBeenCalled();
    await act(async () => resolveRows([{ ...row, playerName: 'Fresh Player', amount: 875 }]));
    await screen.findByRole('button', { name: action });
    expect(screen.queryByText(surface === 'panel' ? 'Original Player' : '250 Chips')).toBeNull();
  }
);

it('hides already visible dashboard cashout actions and totals on a batched real auth ABA before its new read returns', async () => {
  signIn(ID.agent);
  const element = () => (
    <MemoryRouter initialEntries={[`/agent-dashboard?club=${ID.club}`]}>
      <AgentDashboardPage />
    </MemoryRouter>
  );
  const view = render(element());
  fireEvent.click(await screen.findByRole('button', { name: /Cashouts/ }));
  await screen.findByRole('button', { name: 'Approve' });
  const before = dashboardReads;
  let resolveRows!: (value: unknown) => void;
  dashboardReadGate = new Promise((resolve) => {
    resolveRows = resolve;
  });
  act(() => {
    signIn(ID.other);
    signIn(ID.agent);
    view.rerender(element());
  });
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  expect(screen.queryByText('1 Pending')).toBeNull();
  await waitFor(() => expect(dashboardReads).toBeGreaterThan(before));
  expect(vi.mocked(supabase.rpc)).not.toHaveBeenCalled();
  await act(async () => resolveRows({ data: [], error: null }));
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
});

it.each(['panel', 'modal', 'dashboard'] as const)(
  'a real auth ABA remounts %s while its old action is pending and preserves the operation for a fresh explicit recovery',
  async (surface) => {
    gateAcknowledgment = false;
    const actor = surface === 'modal' ? ID.player : ID.agent;
    const kind = surface === 'modal' ? 'cancellation' : 'approval';
    signIn(actor);
    const pending: Array<{ args: any; resolve: (value: any) => void }> = [];
    vi.mocked(supabase.rpc).mockImplementation((name, args) => {
      if (name === 'fn_cashout_operation_receipt_v2')
        return Promise.resolve({ data: cashoutLookupEnvelope(args!), error: null }) as never;
      return new Promise((resolve) => pending.push({ args, resolve })) as never;
    });
    if (surface === 'panel')
      render(<AgentCashoutPanel clubId={ID.club} onCashoutProcessed={done} />);
    else if (surface === 'modal')
      render(
        <CashoutRequestModal
          isOpen
          playerId={ID.player}
          clubId={ID.club}
          currentBalance={500}
          onClose={() => {}}
          onComplete={done}
        />
      );
    else
      render(
        <MemoryRouter initialEntries={[`/agent-dashboard?club=${ID.club}`]}>
          <AgentDashboardPage />
        </MemoryRouter>
      );
    const name =
      surface === 'panel' ? 'Approve Cashout' : surface === 'modal' ? 'Cancel' : 'Approve';
    if (surface === 'dashboard')
      fireEvent.click(await screen.findByRole('button', { name: /Cashouts/ }));
    const originalButton = await screen.findByRole('button', { name });
    await waitFor(() => expect(originalButton).not.toBeDisabled());
    fireEvent.click(originalButton);
    await waitFor(() => expect(pending).toHaveLength(1));
    const operation = pending[0].args.p_op_id;
    let freshRows!: () => void;
    if (surface === 'dashboard') {
      dashboardReadGate = new Promise((resolve) => {
        freshRows = () =>
          resolve({
            data: [
              {
                id: row.id,
                club_id: row.clubId,
                player_id: row.playerId,
                amount: row.amount,
                status: row.status,
                created_at: row.createdAt,
              },
            ],
            error: null,
          });
      });
    } else {
      const read =
        surface === 'panel'
          ? vi.mocked(cashoutService.getAgentPendingCashouts)
          : vi.mocked(cashoutService.getPlayerCashouts);
      read.mockReturnValue(
        new Promise((resolve) => {
          freshRows = () => resolve([row]);
        })
      );
    }
    const readsBefore =
      surface === 'dashboard'
        ? dashboardReads
        : surface === 'panel'
          ? vi.mocked(cashoutService.getAgentPendingCashouts).mock.calls.length
          : vi.mocked(cashoutService.getPlayerCashouts).mock.calls.length;
    // No caller rerender: the real auth bus must wake the outer scope-key hook.
    act(() => {
      signIn(ID.other);
      signIn(actor);
    });
    expect(screen.queryByRole('button', { name })).toBeNull();
    await waitFor(() =>
      expect(
        surface === 'dashboard'
          ? dashboardReads
          : surface === 'panel'
            ? vi.mocked(cashoutService.getAgentPendingCashouts).mock.calls.length
            : vi.mocked(cashoutService.getPlayerCashouts).mock.calls.length
      ).toBeGreaterThan(readsBefore)
    );
    await act(async () => freshRows());
    if (surface === 'dashboard')
      fireEvent.click(await screen.findByRole('button', { name: /Cashouts/ }));
    const freshButton = await screen.findByRole('button', { name });
    await waitFor(() => expect(freshButton).not.toBeDisabled());
    fireEvent.click(freshButton);
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[1].args.p_op_id).toBe(operation);
    // This fixture returns authoritative absence for the explicit new lookup;
    // the transition still receives the SAME idempotent operation, never G2.
    await act(async () =>
      pending[0].resolve({ data: { ...cashoutV2Receipt(kind), op_id: operation }, error: null })
    );
    await waitFor(() => expect(freshButton).toBeDisabled());
    expect(done).not.toHaveBeenCalled();
    expect(screen.queryByText('Cashout approved. Invoice recorded.')).toBeNull();
    fireEvent.click(freshButton);
    expect(pending).toHaveLength(2);
    await act(async () =>
      pending[1].resolve({
        data: { ...cashoutV2Receipt(kind, { replayed: true }), op_id: operation },
        error: null,
      })
    );
    if (surface === 'dashboard') await screen.findByText('Cashout approved. Invoice recorded.');
    else await waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(retainedHistory().generations).toHaveLength(1);
    expect(retainedHistory().generations[0].operationId).toBe(operation);
    expect(retainedHistory().generations[0].acknowledged).toBe(true);
  }
);

it.each(['approval', 'cancellation'] as const)(
  'real %s bus/realtime refresh waits for receipt acknowledgment',
  async (kind) => {
    signIn(kind === 'approval' ? ID.agent : ID.player);
    if (kind === 'approval')
      render(<AgentCashoutPanel clubId={ID.club} onCashoutProcessed={done} />);
    else
      render(
        <CashoutRequestModal
          isOpen
          playerId={ID.player}
          clubId={ID.club}
          currentBalance={500}
          onClose={() => {}}
          onComplete={done}
        />
      );
    const button = await screen.findByRole('button', {
      name: kind === 'approval' ? 'Approve Cashout' : 'Cancel',
    });
    await waitFor(() => expect(button).not.toBeDisabled());
    const read =
      kind === 'approval'
        ? vi.mocked(cashoutService.getAgentPendingCashouts)
        : vi.mocked(cashoutService.getPlayerCashouts);
    expect(read).toHaveBeenCalledOnce();
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(button);
    });
    await vi.waitFor(() => expect(ackWaiting).toBe(true));
    expect(retainedHistory().generations[0].acknowledged).toBe(false);
    // The service emitted through the actual bus before returning. Its actual
    // debounced listener now fires while the local acknowledgment lock is held.
    await act(async () => {
      providerChange();
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(read).toHaveBeenCalledOnce();
    expect(done).not.toHaveBeenCalled();
    await act(async () => {
      releaseAck();
    });
    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(retainedHistory().generations[0].acknowledged).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(supabase.rpc)
        .mock.calls.filter(([name]) => name !== 'fn_cashout_operation_receipt_v2')
    ).toHaveLength(1);
  }
);

it('a real auth A to B to A event still retires the accepted action while ordinary refresh is deferred', async () => {
  signIn(ID.agent);
  render(<AgentCashoutPanel clubId={ID.club} onCashoutProcessed={done} />);
  const button = await screen.findByRole('button', { name: 'Approve Cashout' });
  await waitFor(() => expect(button).not.toBeDisabled());
  vi.useFakeTimers();
  await act(async () => {
    fireEvent.click(button);
  });
  await vi.waitFor(() => expect(ackWaiting).toBe(true));
  await act(async () => {
    providerChange();
    signIn(ID.other);
    signIn(ID.agent);
    releaseAck();
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(done).not.toHaveBeenCalled();
  // The service call may have committed. Losing the view does not cancel it or
  // authorize another payment, and the original operation remains retained.
  expect(retainedHistory().generations[0].operationId).toBeTruthy();
  expect(
    vi
      .mocked(supabase.rpc)
      .mock.calls.filter(([name]) => name !== 'fn_cashout_operation_receipt_v2')
  ).toHaveLength(1);
});

it('retains an unknown terminal operation after the pending row disappears, then checks its exact receipt without payment', async () => {
  gateAcknowledgment = false;
  signIn(ID.agent);
  const read = vi.mocked(cashoutService.getAgentPendingCashouts);
  read.mockResolvedValueOnce([row]).mockResolvedValue([]);
  let failResponse!: () => void;
  let originalOperation = '';
  vi.mocked(supabase.rpc).mockImplementation(async (name, args) => {
    if (name === 'fn_cashout_operation_receipt_v2')
      return { data: cashoutLookupEnvelope(args!), error: null } as never;
    originalOperation = String(args!.p_op_id);
    return new Promise((resolve) => {
      failResponse = () =>
        resolve({ data: null, error: { message: 'Lost After Commit' } } as never);
    });
  });
  render(<AgentCashoutPanel clubId={ID.club} onCashoutProcessed={done} />);
  const approve = await screen.findByRole('button', { name: 'Approve Cashout' });
  await waitFor(() => expect(approve).not.toBeDisabled());
  fireEvent.click(approve);
  await waitFor(() => expect(originalOperation).not.toBe(''));
  await act(async () => {
    providerChange();
    failResponse();
  });
  const check = await screen.findByRole('button', { name: 'Check Receipt' });
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Approve Cashout' })).toBeNull());
  const callsBeforeCheck = vi.mocked(supabase.rpc).mock.calls.length;
  vi.mocked(supabase.rpc).mockImplementation(async (name, args) => {
    expect(name).toBe('fn_cashout_operation_receipt_v2');
    expect(args!.p_op_id).toBe(originalOperation);
    return {
      data: cashoutLookupEnvelope(args!, {
        ...cashoutV2Receipt('approval', { replayed: true }),
        op_id: originalOperation,
      }),
      error: null,
    } as never;
  });
  fireEvent.click(check);
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(screen.queryByRole('button', { name: 'Check Receipt' })).toBeNull();
  expect(
    vi
      .mocked(supabase.rpc)
      .mock.calls.slice(callsBeforeCheck)
      .map(([name]) => name)
  ).toEqual(['fn_cashout_operation_receipt_v2']);
});

it('an unknown receipt check stays unresolved and an account change removes the in-view card', async () => {
  gateAcknowledgment = false;
  signIn(ID.agent);
  vi.mocked(supabase.rpc).mockResolvedValue({
    data: null,
    error: { message: 'Lookup Unavailable' },
  } as never);
  const view = render(<AgentCashoutPanel clubId={ID.club} />);
  const approve = await screen.findByRole('button', { name: 'Approve Cashout' });
  await waitFor(() => expect(approve).not.toBeDisabled());
  fireEvent.click(approve);
  const check = await screen.findByRole('button', { name: 'Check Receipt' });
  fireEvent.click(check);
  await screen.findByText(
    'The Receipt Could Not Be Verified. The Original Operation Is Still Unconfirmed.'
  );
  expect(screen.getByRole('button', { name: 'Check Receipt' })).not.toBeDisabled();
  expect(
    vi.mocked(supabase.rpc).mock.calls.every(([name]) => name === 'fn_cashout_operation_receipt_v2')
  ).toBe(true);
  act(() => signIn(ID.other));
  vi.mocked(cashoutService.getAgentPendingCashouts).mockResolvedValue([]);
  view.rerender(<AgentCashoutPanel clubId={ID.club} />);
  expect(screen.queryByRole('button', { name: 'Check Receipt' })).toBeNull();
});

it('the real dashboard bus listeners defer their full reload until its approval receipt is acknowledged', async () => {
  signIn(ID.agent);
  render(
    <MemoryRouter initialEntries={[`/agent-dashboard?club=${ID.club}`]}>
      <AgentDashboardPage />
    </MemoryRouter>
  );
  const cashoutsTab = await screen.findByRole('button', { name: /Cashouts/ });
  fireEvent.click(cashoutsTab);
  const approve = await screen.findByRole('button', { name: 'Approve' });
  await waitFor(() => expect(approve).not.toBeDisabled());
  const priorReads = dashboardReads;
  vi.useFakeTimers();
  await act(async () => {
    fireEvent.click(approve);
  });
  await vi.waitFor(() => expect(ackWaiting).toBe(true));
  await act(async () => {
    providerChange();
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(dashboardReads).toBe(priorReads);
  expect(screen.queryByText('Cashout approved. Invoice recorded.')).toBeNull();
  await act(async () => releaseAck());
  await vi.waitFor(() => expect(retainedHistory().generations[0].acknowledged).toBe(true));
  await vi.waitFor(() =>
    expect(screen.getByText('Cashout approved. Invoice recorded.')).toBeTruthy()
  );
  expect(dashboardReads).toBe(priorReads + 1);
});
