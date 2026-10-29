import { act, cleanup, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bus = vi.hoisted(() => ({ listeners: new Map<string, Set<(event: any) => void>>() }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribe: (name: string, fn: (event: any) => void) => {
      const set = bus.listeners.get(name) || new Set();
      set.add(fn);
      bus.listeners.set(name, set);
      return () => set.delete(fn);
    },
    emit: (name: string, payload: unknown) => {
      for (const fn of bus.listeners.get(name) || []) fn({ payload });
    },
  },
}));
const db = vi.hoisted(() => ({ insert: vi.fn(() => Promise.resolve({ error: null })) }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { from: () => ({ insert: db.insert }) } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import { masterBus } from '../../src/core/MasterBus';
import { sessionStatsService as stats } from '../../src/services/SessionStatsService';
import { useTableSession } from '../../src/hooks/useTableSession';
import { useGameSessionLifecycle } from '../../src/hooks/useGameSessionLifecycle';
import { useSeatMoveNavigation } from '../../src/hooks/useSeatMoveNavigation';
import { clearUserCaches } from '../../src/utils/clearUserCaches';
import { mergeSessionFacts, sessionBuyInTotal } from '../../src/utils/sessionBuyInTotal';

beforeEach(() => {
  stats.resetAll();
  localStorage.clear();
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  stats.resetAll();
  vi.restoreAllMocks();
});

function useMovingSession(event: Record<string, unknown> | null) {
  const [table, setTable] = useState('a');
  const refs = useTableSession(table, 'hero');
  useGameSessionLifecycle({
    tableId: table,
    userId: 'hero',
    seated: true,
    stack: stats.getStats(table)?.currentStack || 100,
    bigBlind: 2,
    arenaAsset: 'chips',
    onNewSession: refs.resetSession,
  });
  useSeatMoveNavigation({
    tableId: table,
    userId: 'hero',
    event,
    follow: (to) => {
      stats.moveSession(table, to, 'hero');
      setTable(to);
    },
  });
  return { table, refs };
}
const move = (from: string, to: string, user = 'hero') => ({
  type: 'SEAT_MOVED',
  data: { table_id: from, to_table_id: to, user_id: user },
});

describe('one game session follows the confirmed chair move', () => {
  it('carries real hook counters, VPIP, original funding, duration and service stats through repeated moves', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { result, rerender } = renderHook(({ event }) => useMovingSession(event), {
      initialProps: { event: null as Record<string, unknown> | null },
    });
    stats.startSession('a', 'hero', 100, 2);
    expect(result.current.refs.totalBuyInRef.current).toBe(100);
    expect(result.current.refs.peakStackRef.current).toBe(100);
    result.current.refs.vpipCountRef.current = 1;
    act(() => {
      stats.recordHand('a', 150, true, true, true, 'a:1');
      masterBus.emit('HAND_COMPLETED', { tableId: 'a', handId: '1', won: true, heroStack: 150 });
      masterBus.emit('POT_DISTRIBUTED', { tableId: 'a', total_pot: 90 });
    });
    clock.mockReturnValue(1_000_000 + 2 * 3_600_000);
    rerender({ event: move('a', 'b') });
    expect(result.current.table).toBe('b');
    expect(result.current.refs.handsPlayedRef.current).toBe(1);
    expect(result.current.refs.handsWonRef.current).toBe(1);
    expect(result.current.refs.vpipCountRef.current).toBe(1);
    expect(result.current.refs.biggestPotRef.current).toBe(90);
    expect(result.current.refs.totalBuyInRef.current).toBe(100);
    expect(stats.getStats('a')).toBeNull();
    stats.startSession('b', 'hero', 150, 2);
    expect(stats.getStats('b')).toMatchObject({
      initialStack: 100,
      buyInTotal: 100,
      handsPlayed: 1,
      vpipPercent: 100,
      pfrPercent: 100,
      profitLoss: 50,
      sessionStartTime: 1_000_000,
    });
    stats.recordHand('b', 150, true, true, true, 'a:1'); // retained old hand cannot count again
    expect(stats.getStats('b')?.handsPlayed).toBe(1);
    const merged = mergeSessionFacts({
      serverFacts: { hands_played: 0, hands_won: 0 },
      carried: result.current.refs.sessionCarryRef.current,
      atAsk: { startMs: 1_000_000, handsPlayed: 1, handsWon: 1, peakStack: 150 },
      now: { startMs: 1_000_000, handsPlayed: 1, handsWon: 1, peakStack: 150 },
    });
    expect(merged.handsPlayed).toBe(1);
    expect(
      sessionBuyInTotal({
        serverBaseline: 150,
        totalAtAsk: 100,
        totalNow: 100,
        carriedAdjustment: result.current.refs.sessionCarryRef.current.fundingAdjustment,
      })
    ).toBe(100);
    act(() => {
      stats.recordHand('b', 130, false, false, false, 'b:1');
      masterBus.emit('HAND_COMPLETED', { tableId: 'b', handId: '1', won: false, heroStack: 130 });
    });
    rerender({ event: move('b', 'c') });
    expect(result.current.refs.handsPlayedRef.current).toBe(2);
    expect(stats.getStats('c')).toMatchObject({
      handsPlayed: 2,
      vpipPercent: 50,
      pfrPercent: 50,
      profitLoss: 30,
    });
    expect(stats.endSession('a')).toBeNull();
    expect(db.insert).not.toHaveBeenCalled();
    stats.endSession('c');
    expect(db.insert).toHaveBeenCalledTimes(1);
    stats.startSession('c', 'hero', 80, 2);
    expect(stats.getStats('c')).toMatchObject({ handsPlayed: 0, buyInTotal: 80, profitLoss: 0 });
  });

  it('preserves a destination already open as an observer without mixing other games or accounts', () => {
    const source = renderHook(() => useTableSession('a', 'hero'));
    const destination = renderHook(() => useTableSession('b', 'hero'));
    const other = renderHook(() => useTableSession('x', 'hero'));
    const foreign = renderHook(() => useTableSession('b', 'someone-else'));
    stats.startSession('a', 'hero', 100, 2);
    stats.startSession('x', 'hero', 200, 5);
    source.result.current.handsPlayedRef.current = 12;
    source.result.current.totalBuyInRef.current = 100;
    other.result.current.handsPlayedRef.current = 7;
    expect(stats.moveSession('a', 'b', 'someone-else')).toBe(false);
    expect(stats.moveSession('a', 'b', 'hero')).toBe(true);
    expect(destination.result.current.handsPlayedRef.current).toBe(12);
    expect(other.result.current.handsPlayedRef.current).toBe(7);
    expect(foreign.result.current.handsPlayedRef.current).toBe(0);
    source.unmount();
    destination.unmount();
    const remounted = renderHook(() => useTableSession('b', 'hero'));
    expect(remounted.result.current.handsPlayedRef.current).toBe(12);
    stats.endSession('b');
    remounted.unmount();
    const fresh = renderHook(() => useTableSession('b', 'hero'));
    expect(fresh.result.current.handsPlayedRef.current).toBe(0);
  });

  it('keeps a session through an empty snapshot and unmount, ending only on the matching confirmed leave', () => {
    const mount = () =>
      renderHook(
        ({ seated }) => {
          const refs = useTableSession('a', 'hero');
          useGameSessionLifecycle({
            tableId: 'a',
            userId: 'hero',
            seated,
            stack: 100,
            bigBlind: 2,
            arenaAsset: 'chips',
            onNewSession: refs.resetSession,
          });
          return refs;
        },
        { initialProps: { seated: true } }
      );
    const first = mount();
    stats.recordHand('a', 120, true, true, false, 'a:1');
    first.rerender({ seated: false });
    first.unmount();
    expect(stats.getStats('a')?.handsPlayed).toBe(1);
    expect(db.insert).not.toHaveBeenCalled();
    const current = mount();
    act(() => masterBus.emit('SESSION_ENDED', { tableId: 'a', userId: 'other' }));
    expect(stats.getStats('a')?.handsPlayed).toBe(1);
    act(() => masterBus.emit('SESSION_ENDED', { tableId: 'a', userId: 'hero' }));
    expect(stats.getStats('a')).toBeNull();
    expect(db.insert).toHaveBeenCalledTimes(1);
    current.rerender({ seated: false });
    current.rerender({ seated: true });
    expect(stats.getStats('a')).toMatchObject({ handsPlayed: 0, buyInTotal: 100 });
  });

  it('clears retained session memory on sign-out without publishing a result for another account', () => {
    const current = renderHook(() => useTableSession('a', 'hero'));
    stats.startSession('a', 'hero', 100, 2);
    current.result.current.handsPlayedRef.current = 8;
    clearUserCaches();
    expect(stats.getStats('a')).toBeNull();
    expect(db.insert).not.toHaveBeenCalled();
    const next = renderHook(() => useTableSession('a', 'another-user'));
    expect(next.result.current.handsPlayedRef.current).toBe(0);
  });

  it('does not treat another player moving as this player continuing a session', () => {
    const { result, rerender } = renderHook(({ event }) => useMovingSession(event), {
      initialProps: { event: null as Record<string, unknown> | null },
    });
    stats.startSession('a', 'hero', 100, 2);
    rerender({ event: move('a', 'b', 'someone-else') });
    expect(result.current.table).toBe('a');
    expect(stats.getStats('b')).toBeNull();
  });
});
