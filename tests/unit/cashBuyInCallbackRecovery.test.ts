import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uuid } from '../../src/utils/uuid';
import { cashBuyInRefusalText } from '../../src/lib/cashBuyIn';
import {
  createCashBuyInJournal,
  executeCashBuyIn,
  sameCashBuyInIntent,
} from '../../src/services/CashBuyInRecovery';

// Execute the actual JSX callback, with only its external dependencies replaced.
// This catches failures in the real ordering and cleanup, without moving chips.
const source = readFileSync('src/pages/TablePage.tsx', 'utf8');
const start = source.indexOf('onConfirmBuyIn={') + 'onConfirmBuyIn={'.length;
const end = source.indexOf('\n        }}', start);
if (start < 15 || end < start) throw new Error('Buy-in callback not found');
const compiled = ts.transpile(`const handler = ${source.slice(start, end)}\n};`, {
  target: ts.ScriptTarget.ES2022,
});

function fixture() {
  let state: any = { players: Array(6).fill(null), heroSeat: 0, tableName: 'Test' };
  const ref = (current: any) => ({ current });
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  const storage = (map: Map<string, string>) => ({
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  });
  const journal = createCashBuyInJournal(() => ({
    local: storage(local),
    session: storage(session),
    lock: async <T>(_key: string, work: () => T) => work(),
    createId: uuid,
  }));
  const dependencies: Record<string, any> = {
    uuid,
    buyInProcessingRef: ref(false),
    buyInIdempotencyKeyRef: ref(null),
    cashBuyInRecovery: null,
    cashBuyInPendingRef: ref(null),
    buyInOperationRef: ref(null),
    buyInScopeRef: ref('d0000000-0000-4000-8000-000000000001:b0000000-0000-4000-8000-000000000001'),
    cashBuyInJournal: journal,
    sameCashBuyInIntent,
    executeCashBuyIn: (attempt: any, recovery: boolean, _rpc: unknown, current: () => boolean) =>
      executeCashBuyIn(
        attempt,
        recovery,
        (name, payload) => dependencies.supabase.rpc(name, payload),
        current
      ),
    setCashBuyInRecovery: (attempt: any) => {
      dependencies.cashBuyInRecovery = attempt;
    },
    retryAccountBalance: vi.fn(),
    requestEngineSnapshot: vi.fn(),
    pendingSeatStackRef: ref(0),
    selectedSeat: 2,
    userId: 'd0000000-0000-4000-8000-000000000001',
    tableId: 'b0000000-0000-4000-8000-000000000001',
    username: 'Member',
    heroAvatarUrl: '',
    setShowBuyInModal: vi.fn(),
    setTableState: (update: any) => {
      state = update(state);
    },
    heroSeatRef: ref(0),
    leftSeatPendingRef: ref(false),
    setPendingSeat: vi.fn(),
    supabase: { rpc: vi.fn().mockResolvedValue({ data: null, error: null }), from: vi.fn() },
    useUserStore: { getState: () => ({ currentClubId: 'a0000000-0000-4000-8000-000000000001' }) },
    reportError: vi.fn(),
    toast: { error: vi.fn(), warning: vi.fn() },
    cashBuyInRefusalText,
    applyBalanceDelta: vi.fn(),
    totalBuyInRef: ref(0),
    peakStackRef: ref(0),
    seatAcquiredAtRef: ref(0),
    bootNoticeShownRef: ref(false),
    HydraService: { onRealPlayerJoined: vi.fn() },
    sendAction: vi.fn().mockResolvedValue(undefined),
    masterBus: { emit: vi.fn() },
    tableState: state,
    tableStateRef: ref({ isTournament: false }),
    setPostOrWaitOpen: vi.fn(),
    setSelectedSeat: vi.fn(),
  };
  const handler = (...args: any[]) =>
    new Function(...Object.keys(dependencies), `${compiled}\nreturn handler;`)(
      ...Object.values(dependencies)
    )(...args);
  return { d: dependencies, handler, state: () => state };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('cash buy-in callback recovery', () => {
  it('buys in without native randomUUID and without a preliminary seat read', async () => {
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(7) });
    const f = fixture();
    f.d.leftSeatPendingRef.current = true;
    await f.handler(100, false);
    expect(f.d.leftSeatPendingRef.current).toBe(false);
    expect(f.d.supabase.from).not.toHaveBeenCalled();
    expect(f.d.supabase.rpc).toHaveBeenCalledWith(
      'atomic_table_buyin',
      expect.objectContaining({
        p_amount: 100,
        p_seat_number: 2,
        p_idempotency_key: expect.stringMatching(/^[a-f0-9-]{36}$/),
      })
    );
    expect(f.state().heroSeat).toBe(2);
    expect(f.d.buyInProcessingRef.current).toBe(false);
  });

  it('releases the latch and reports a UUID exception so another click can succeed', async () => {
    const randomUUID = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('crypto unavailable');
      })
      .mockReturnValue('00000000-0000-4000-8000-000000000001');
    vi.stubGlobal('crypto', { randomUUID });
    const f = fixture();
    await f.handler(100, false);
    expect(f.d.buyInProcessingRef.current).toBe(false);
    expect(f.d.toast.error).toHaveBeenCalled();
    expect(f.d.supabase.rpc).not.toHaveBeenCalled();
    await f.handler(100, false);
    expect(f.d.supabase.rpc).toHaveBeenCalledTimes(1);
  });

  it('keeps the confirmed seat when both engine notifications throw', async () => {
    const f = fixture();
    f.d.HydraService.onRealPlayerJoined.mockImplementation(() => {
      throw new Error('hydra');
    });
    f.d.requestEngineSnapshot.mockImplementation(() => {
      throw new Error('socket offline');
    });
    await f.handler(100, false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.state().heroSeat).toBe(2);
    expect(f.d.toast.error).not.toHaveBeenCalled();
    expect(f.d.toast.warning).toHaveBeenCalled();
    expect(f.d.masterBus.emit).toHaveBeenCalled();
    expect(f.d.setPostOrWaitOpen).toHaveBeenCalledWith(true);
    expect(f.d.buyInProcessingRef.current).toBe(false);
    expect(f.d.applyBalanceDelta).not.toHaveBeenCalled();
    expect(f.d.retryAccountBalance).toHaveBeenCalledOnce();
  });

  it('finishes confirmation even if the engine notification never settles', async () => {
    const f = fixture();
    f.d.sendAction.mockReturnValue(new Promise(() => {}));
    await f.handler(100, false);
    expect(f.d.buyInProcessingRef.current).toBe(false);
    expect(f.d.setPostOrWaitOpen).toHaveBeenCalledWith(true);
  });

  it('cannot revert a committed seat when another post-commit UI callback throws', async () => {
    const f = fixture();
    f.d.masterBus.emit.mockImplementation(() => {
      throw new Error('listener');
    });
    await f.handler(100, false);
    expect(f.state().heroSeat).toBe(2);
    expect(f.d.toast.error).not.toHaveBeenCalled();
    expect(f.d.toast.warning).toHaveBeenCalled();
    expect(f.d.buyInProcessingRef.current).toBe(false);
  });

  it('keeps the sheet open while the purchase is pending, then closes on confirmation', async () => {
    const f = fixture();
    let finish!: (value: any) => void;
    f.d.supabase.rpc.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const pending = f.handler(100, false);
    expect(f.d.setShowBuyInModal).not.toHaveBeenCalledWith(false);
    expect(f.d.buyInProcessingRef.current).toBe(true);
    await vi.waitFor(() => expect(f.d.supabase.rpc).toHaveBeenCalledOnce());
    finish({ data: null, error: null });
    expect(await pending).toBe(true);
    expect(f.d.setShowBuyInModal).toHaveBeenCalledWith(false);
  });

  it('still rolls back an explicit refusal and releases the processing latch', async () => {
    const f = fixture();
    f.d.supabase.rpc.mockResolvedValue({
      data: { success: false, error: 'seat_taken' } as any,
      error: null,
    });
    expect(await f.handler(100, false)).toBe(false);
    expect(f.d.setShowBuyInModal).not.toHaveBeenCalledWith(false);
    expect(f.d.setSelectedSeat).not.toHaveBeenCalledWith(null);
    expect(f.state().heroSeat).toBe(0);
    expect(f.d.applyBalanceDelta).not.toHaveBeenCalled();
    expect(f.d.buyInIdempotencyKeyRef.current).toBeNull();
    expect(f.d.buyInProcessingRef.current).toBe(false);
    expect(f.d.toast.error).toHaveBeenCalled();
  });
});

it('retains an unknown request after the response deadline and ignores a late result', async () => {
  vi.useFakeTimers();
  const f = fixture();
  let finish!: (value: any) => void;
  f.d.supabase.rpc.mockImplementation((name: string) =>
    name === 'atomic_table_buyin'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve({ data: { status: 'unconfirmed' }, error: null })
  );
  const pending = f.handler(100, false);
  await vi.advanceTimersByTimeAsync(15_001);
  expect(await pending).toBe(false);
  const saved = f.d.cashBuyInJournal.read(f.d.userId, f.d.tableId);
  expect(saved.payload.p_amount).toBe(100);
  expect(f.d.buyInProcessingRef.current).toBe(false);
  expect(f.state().heroSeat).toBe(0);
  finish({ data: null, error: null });
  await Promise.resolve();
  expect(f.d.cashBuyInJournal.read(f.d.userId, f.d.tableId)).toEqual(saved);
  expect(f.d.setShowBuyInModal).not.toHaveBeenCalledWith(false);
});

it('recovers a committed receipt without restoring an old stack or subtracting the wallet again', async () => {
  const f = fixture();
  f.d.leftSeatPendingRef.current = true;
  f.d.supabase.rpc.mockImplementation((name: string) => {
    if (name === 'atomic_table_buyin') return Promise.reject(new Error('response lost'));
    const p = f.d.cashBuyInJournal.read(f.d.userId, f.d.tableId).payload;
    return Promise.resolve({
      error: null,
      data: {
        status: 'confirmed',
        request: {
          door: 'atomic_table_buyin',
          user_id: p.p_user_id,
          table_id: p.p_table_id,
          seat_number: p.p_seat_number,
          amount: p.p_amount,
          auto_rebuy: p.p_auto_rebuy,
          club_id: p.p_club_id,
        },
      },
    });
  });
  expect(await f.handler(100, false)).toBe(true);
  await Promise.resolve();
  expect(
    f.d.supabase.rpc.mock.calls.filter((call: any[]) => call[0] === 'atomic_table_buyin')
  ).toHaveLength(1);
  expect(f.d.applyBalanceDelta).not.toHaveBeenCalled();
  expect(f.d.retryAccountBalance).toHaveBeenCalledOnce();
  expect(f.d.requestEngineSnapshot).toHaveBeenCalledOnce();
  expect(f.state().heroSeat).toBe(0);
  expect(f.d.totalBuyInRef.current).toBe(0);
  expect(f.d.leftSeatPendingRef.current).toBe(true);
});

it('keeps a late confirmation inside its original view and cannot clear a newer operation latch', async () => {
  const f = fixture();
  let finish!: (value: any) => void;
  f.d.supabase.rpc.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  const pending = f.handler(100, false);
  await vi.waitFor(() => expect(f.d.supabase.rpc).toHaveBeenCalledOnce());
  f.d.buyInScopeRef.current = 'another-view';
  const replacement = Symbol('replacement');
  f.d.buyInOperationRef.current = replacement;
  finish({ data: null, error: null });
  expect(await pending).toBe(false);
  expect(f.d.buyInOperationRef.current).toBe(replacement);
  expect(f.d.buyInProcessingRef.current).toBe(true);
  expect(f.d.retryAccountBalance).not.toHaveBeenCalled();
  expect(f.d.setShowBuyInModal).not.toHaveBeenCalledWith(false);
  expect(f.state().heroSeat).toBe(0);
});

it('treats a successful retried mutation as recovery when the original may have completed late', async () => {
  const f = fixture();
  const saved = await f.d.cashBuyInJournal.reserve({
    p_user_id: f.d.userId,
    p_table_id: f.d.tableId,
    p_seat_number: 2,
    p_amount: 100,
    p_auto_rebuy: false,
    p_club_id: f.d.useUserStore.getState().currentClubId,
  });
  f.d.cashBuyInRecovery = saved.attempt;
  f.d.cashBuyInPendingRef.current = saved.attempt;
  f.d.leftSeatPendingRef.current = true;
  f.d.supabase.rpc.mockImplementation((name: string) =>
    Promise.resolve({
      data: name === 'fn_ca_cash_buyin_receipt' ? { status: 'unconfirmed' } : null,
      error: null,
    })
  );
  // A receipt read can precede the original commit. The idempotent retry
  // then returns the original success after waiting on that transaction.
  expect(await f.handler(100, false)).toBe(true);
  expect(f.d.supabase.rpc.mock.calls.map((call: any[]) => call[0])).toEqual([
    'fn_ca_cash_buyin_receipt',
    'atomic_table_buyin',
  ]);
  expect(f.d.supabase.rpc.mock.calls[1][1]).toEqual(saved.attempt.payload);
  expect(f.state().heroSeat).toBe(0);
  expect(f.d.totalBuyInRef.current).toBe(0);
  expect(f.d.leftSeatPendingRef.current).toBe(true);
  expect(f.d.retryAccountBalance).toHaveBeenCalledOnce();
});

it.each([
  [
    {
      code: '23505',
      message:
        'duplicate key value violates unique constraint "table_seats_table_id_seat_number_key"',
    },
    'That Seat Was Taken. Please Choose Another Seat.',
  ],
  [
    {
      code: '23505',
      message: 'duplicate key value violates unique constraint "idx_unique_active_user_per_table"',
    },
    'You Are Already Seated At This Table',
  ],
  [
    {
      code: 'P0001',
      message: 'SEAT_RESERVED: the open seat is held for the next player on the waiting list',
    },
    'This Seat Is Reserved For The Next Player On The Waiting List. Please Join The Waitlist.',
  ],
  [
    { code: 'P0001', message: 'Insufficient club chips for buy-in (club abc)' },
    'Your Club Wallet Does Not Have Enough Chips For This Buy In',
  ],
])(
  'releases a confirmed refusal and permits a newly reviewed seat and amount: %j',
  async (error, message) => {
    const f = fixture();
    f.d.supabase.rpc.mockImplementation((name: string) =>
      Promise.resolve({
        data: name === 'fn_ca_cash_buyin_receipt' ? { status: 'unconfirmed' } : null,
        error: name === 'atomic_table_buyin' ? error : null,
      })
    );
    expect(await f.handler(100, false)).toBe(false);
    await Promise.resolve();
    expect(f.d.toast.error).toHaveBeenCalledWith(message);
    expect(f.d.cashBuyInJournal.read(f.d.userId, f.d.tableId)).toBeNull();
    expect(f.d.cashBuyInPendingRef.current).toBeNull();
    expect(f.d.buyInProcessingRef.current).toBe(false);
    expect(f.state().heroSeat).toBe(0);
    expect(f.d.setShowBuyInModal).not.toHaveBeenCalledWith(false);
    const originalKey = f.d.supabase.rpc.mock.calls[0][1].p_idempotency_key;
    f.d.selectedSeat = 3;
    f.d.supabase.rpc.mockResolvedValue({ data: null, error: null });
    expect(await f.handler(80, false)).toBe(true);
    const purchase = f.d.supabase.rpc.mock.calls.at(-1)[1];
    expect(purchase.p_seat_number).toBe(3);
    expect(purchase.p_amount).toBe(80);
    expect(purchase.p_idempotency_key).not.toBe(originalKey);
  }
);

it.each([
  {
    code: '23505',
    message:
      'duplicate key value violates unique constraint "entry_purchase_idempotency_receipts_pkey"',
  },
  { code: '23505', message: 'duplicate key value violates unique constraint "table_seats_pkey"' },
  {
    code: '57014',
    message:
      'duplicate key value violates unique constraint "table_seats_table_id_seat_number_key"',
  },
  {
    code: '42501',
    message: 'SEAT_RESERVED: the open seat is held for the next player on the waiting list',
  },
])(
  'retains uncertain outcomes rather than treating unrelated errors as safe to retry: %j',
  async (error) => {
    const f = fixture();
    f.d.supabase.rpc.mockImplementation((name: string) =>
      Promise.resolve({
        data: name === 'fn_ca_cash_buyin_receipt' ? { status: 'unconfirmed' } : null,
        error: name === 'atomic_table_buyin' ? error : null,
      })
    );
    expect(await f.handler(100, false)).toBe(false);
    expect(f.d.cashBuyInJournal.read(f.d.userId, f.d.tableId)).not.toBeNull();
    expect(f.d.cashBuyInPendingRef.current).not.toBeNull();
    expect(f.d.toast.error).not.toHaveBeenCalled();
    expect(
      f.d.supabase.rpc.mock.calls.filter((call: any[]) => call[0] === 'atomic_table_buyin')
    ).toHaveLength(1);
  }
);
