import { StrictMode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSeatMoveAnnouncement } from '../../src/hooks/useSeatMoveAnnouncement';
const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const q = { select: () => q, eq: () => q, maybeSingle: () => read(table) };
      return q;
    },
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
const move = (extra = {}) => ({
  type: 'seat_moved',
  table_id: 'source',
  user_id: 'alice',
  to_table_id: 'destination',
  timestamp: 1,
  reason: 'seat_change',
  ...extra,
});
const props = (event: Record<string, unknown> | null = move()) => ({
  tableId: 'source',
  event,
  players: [{ id: 'alice', name: 'VeryPainful' }],
  announce: vi.fn(),
});
beforeEach(() => {
  read.mockReset();
  read.mockResolvedValue({ data: { name: 'Main 2' }, error: null });
});
describe('source-table seat move announcements', () => {
  it('tells remaining spectators who moved to the main game', async () => {
    const p = props();
    renderHook(useSeatMoveAnnouncement, { initialProps: p });
    await waitFor(() =>
      expect(p.announce).toHaveBeenCalledWith(
        'VeryPainful Was Moved To The Main Game',
        expect.any(String)
      )
    );
  });
  it('names another destination for a requested seat change', async () => {
    read.mockResolvedValue({ data: { name: 'PLO Feeder 3' }, error: null });
    const p = props();
    renderHook(useSeatMoveAnnouncement, { initialProps: p });
    await waitFor(() =>
      expect(p.announce).toHaveBeenCalledWith(
        'VeryPainful Was Moved To PLO Feeder 3',
        expect.any(String)
      )
    );
  });
  it('keeps the source roster name after the seat disappears', async () => {
    const p = props(null);
    const h = renderHook(useSeatMoveAnnouncement, { initialProps: p });
    h.rerender({ ...p, event: move(), players: [] });
    await waitFor(() =>
      expect(p.announce).toHaveBeenCalledWith(
        'VeryPainful Was Moved To The Main Game',
        expect.any(String)
      )
    );
  });
  it('resolves a swap partner not present in the current roster', async () => {
    read.mockImplementation(async (table) => ({
      data:
        table === 'profiles'
          ? { alias: 'SwapPartner', username: 'swappartner' }
          : { name: 'Feeder' },
      error: null,
    }));
    const p = { ...props(), players: [] };
    renderHook(useSeatMoveAnnouncement, { initialProps: p });
    await waitFor(() =>
      expect(p.announce).toHaveBeenCalledWith('SwapPartner Was Moved To Feeder', expect.any(String))
    );
  });
  for (const extra of [
    { replayed: true },
    { table_id: 'other' },
    { to_table_id: 'source' },
    { type: 'seat_move_pending' },
  ]) {
    it(`ignores historical, foreign or uncommitted moves ${JSON.stringify(extra)}`, async () => {
      const p = props(move(extra));
      renderHook(useSeatMoveAnnouncement, { initialProps: p });
      expect(read).not.toHaveBeenCalled();
      expect(p.announce).not.toHaveBeenCalled();
    });
  }
  it('deduplicates repeated delivery and StrictMode effects', async () => {
    const p = props();
    const h = renderHook(useSeatMoveAnnouncement, { initialProps: p, wrapper: StrictMode });
    await waitFor(() => expect(p.announce).toHaveBeenCalledTimes(1));
    h.rerender({ ...p, event: move() });
    expect(p.announce).toHaveBeenCalledTimes(1);
  });
  it('drops a late read when the viewed table changes', async () => {
    let resolve!: (value: unknown) => void;
    read.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );
    const p = props();
    const h = renderHook(useSeatMoveAnnouncement, { initialProps: p });
    h.rerender({ ...p, tableId: 'new-table' });
    resolve({ data: { name: 'Main' }, error: null });
    await Promise.resolve();
    await Promise.resolve();
    expect(p.announce).not.toHaveBeenCalled();
  });
  it('uses truthful fallback copy when the destination read fails', async () => {
    read.mockRejectedValue(new Error('offline'));
    const p = props(move({ reason: 'must_move' }));
    renderHook(useSeatMoveAnnouncement, { initialProps: p });
    await waitFor(() =>
      expect(p.announce).toHaveBeenCalledWith(
        'VeryPainful Was Moved To The Main Game',
        expect.any(String)
      )
    );
  });
});
