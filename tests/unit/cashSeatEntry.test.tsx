import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: transport }));
import { useCashSeatEntry } from '../../src/components/table/useCashSeatEntry';

beforeEach(() => vi.clearAllMocks());
function setup(gameId: string | null = 'game') {
  const callbacks = {
    openBuyIn: vi.fn(),
    goToTable: vi.fn(),
    showWaitlist: vi.fn(),
    notify: vi.fn(),
  };
  const hook = renderHook(
    ({ userId }) =>
      useCashSeatEntry({
        tableId: 'main',
        userId,
        gameId,
        ...callbacks,
      }),
    { initialProps: { userId: 'player' } }
  );
  return { ...hook, ...callbacks };
}
describe('a cash seat tap always has an actionable admission outcome', () => {
  it('opens the server assigned table without submitting a purchase', async () => {
    transport.rpc.mockResolvedValue({
      data: { ok: true, action: 'seat', table_id: 'feeder', table_name: 'Feeder 2' },
      error: null,
    });
    const h = setup();
    await act(() => h.result.current(4));
    expect(h.goToTable).toHaveBeenCalledExactlyOnceWith('feeder');
    expect(h.openBuyIn).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('Feeder 2'));
    expect(transport.rpc).toHaveBeenCalledExactlyOnceWith('fn_cash_game_join', {
      p_game_id: 'game',
    });
  });
  it('opens buy-in at the current table after admission, retaining a named chair', async () => {
    transport.rpc.mockResolvedValue({
      data: { ok: true, action: 'seat', table_id: 'main', seat_number: 6 },
      error: null,
    });
    const h = setup();
    await act(() => h.result.current(4));
    expect(h.openBuyIn).toHaveBeenCalledExactlyOnceWith(6);
    expect(h.goToTable).not.toHaveBeenCalled();
  });
  it('shows the confirmed queue place and its lobby when there is no seat', async () => {
    transport.rpc.mockResolvedValue({
      data: { ok: true, action: 'waitlisted', position: 3 },
      error: null,
    });
    const h = setup();
    await act(() => h.result.current(4));
    expect(h.showWaitlist).toHaveBeenCalledOnce();
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('Number 3'));
    expect(h.openBuyIn).not.toHaveBeenCalled();
    expect(h.goToTable).not.toHaveBeenCalled();
  });
  it('keeps an admission refusal visible and offers the lobby rather than opening a doomed buy-in', async () => {
    transport.rpc.mockResolvedValue({ data: null, error: { message: 'GAME_CLOSED' } });
    const h = setup();
    await act(() => h.result.current(4));
    expect(h.notify).toHaveBeenCalledWith('This Game Is Not Taking Players.');
    expect(h.showWaitlist).toHaveBeenCalledOnce();
    expect(h.openBuyIn).not.toHaveBeenCalled();
  });
  it.each(['account', 'unmount'])(
    'suppresses duplicate taps and ignores an old %s reply',
    async (change) => {
      let resolve!: (reply: unknown) => void;
      transport.rpc.mockReturnValue(
        new Promise((done) => {
          resolve = done;
        })
      );
      const h = setup();
      let pending!: Promise<void>;
      act(() => {
        pending = h.result.current(4);
        void h.result.current(5);
      });
      expect(transport.rpc).toHaveBeenCalledOnce();
      if (change === 'account') h.rerender({ userId: 'other' });
      else h.unmount();
      await act(async () => {
        resolve({ data: { ok: true, action: 'seat', table_id: 'feeder' }, error: null });
        await pending;
      });
      expect(h.goToTable).not.toHaveBeenCalled();
      expect(h.openBuyIn).not.toHaveBeenCalled();
      expect(h.notify).not.toHaveBeenCalled();
    }
  );
  it('preserves direct buy-in for ordinary cash tables', async () => {
    const h = setup(null);
    await act(() => h.result.current(4));
    expect(h.openBuyIn).toHaveBeenCalledExactlyOnceWith(4);
    expect(transport.rpc).not.toHaveBeenCalled();
  });
});
