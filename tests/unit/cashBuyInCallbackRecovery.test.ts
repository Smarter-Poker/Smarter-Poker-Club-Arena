import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uuid } from '../../src/utils/uuid';

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
  const dependencies = {
    uuid,
    buyInProcessingRef: ref(false),
    buyInIdempotencyKeyRef: ref(null),
    pendingSeatStackRef: ref(0),
    selectedSeat: 2,
    userId: 'member',
    tableId: 'table',
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
    useUserStore: { getState: () => ({ currentClubId: 'club' }) },
    reportError: vi.fn(),
    toast: { error: vi.fn(), warning: vi.fn() },
    cashBuyInRefusalText: () => null,
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
  const handler = new Function(...Object.keys(dependencies), `${compiled}\nreturn handler;`)(
    ...Object.values(dependencies)
  );
  return { d: dependencies, handler, state: () => state };
}
afterEach(() => vi.unstubAllGlobals());

describe('cash buy-in callback recovery', () => {
  it('buys in without native randomUUID and without a preliminary seat read', async () => {
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(7) });
    const f = fixture();
    await f.handler(100, false);
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
    f.d.sendAction.mockRejectedValue(new Error('socket offline'));
    await f.handler(100, false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.state().heroSeat).toBe(2);
    expect(f.d.toast.error).not.toHaveBeenCalled();
    expect(f.d.toast.warning).toHaveBeenCalled();
    expect(f.d.masterBus.emit).toHaveBeenCalled();
    expect(f.d.setPostOrWaitOpen).toHaveBeenCalledWith(true);
    expect(f.d.buyInProcessingRef.current).toBe(false);
    expect(f.d.applyBalanceDelta).toHaveBeenCalledTimes(1);
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

  it('still rolls back an explicit refusal and releases the processing latch', async () => {
    const f = fixture();
    f.d.supabase.rpc.mockResolvedValue({
      data: { success: false, error: 'seat_taken' } as any,
      error: null,
    });
    await f.handler(100, false);
    expect(f.state().heroSeat).toBe(0);
    expect(f.d.applyBalanceDelta).not.toHaveBeenCalled();
    expect(f.d.buyInIdempotencyKeyRef.current).toBeNull();
    expect(f.d.buyInProcessingRef.current).toBe(false);
    expect(f.d.toast.error).toHaveBeenCalled();
  });
});
