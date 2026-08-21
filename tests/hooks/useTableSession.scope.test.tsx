/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  SESSION COUNTERS BELONG TO ONE TABLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-21: "the Session Complete is not working or functional, it's not
 * pulling the real time stats or data from the table you just left."
 *
 * The MasterBus is global and this hook's three subscriptions filtered on
 * nothing. This app is built for multi-tabling (MultiTablePage keeps up to
 * four TablePage instances mounted, and the lobby has a "+" to open another
 * game), and each mounted table runs its own copy of this hook. So every table
 * counted every OTHER table's hands, pots and top-ups into its own session.
 *
 * Leave one of four tables and the card reported all four tables' numbers.
 * They were real numbers, which is what made it convincing; they belonged to
 * the wrong table. On a single table it looked perfect, which is why two
 * earlier passes at this card did not catch it.
 */
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

/**
 * tests/setup.ts mocks MasterBus globally with a no-op subscribe/emit, which
 * is right for the suite at large (dozens of modules subscribe at import time
 * and would otherwise need a live bus) but makes it impossible to prove
 * anything about a SUBSCRIBER here: nothing is ever delivered, so a broken
 * filter and a correct one both count zero.
 *
 * This file therefore supplies a real one. Deliberately minimal, and
 * deliberately faithful on the two details this test depends on: handlers
 * receive the wrapped { type, payload } BusEvent, not the bare payload, and
 * subscribe returns its unsubscribe.
 *
 * The 500ms duplicate suppression of the real bus is NOT reproduced. It would
 * only decide which of these emits arrive, which is the harness deciding the
 * result rather than the code under test; real hands always differ by handId
 * anyway, and the helper below gives every emit a unique one.
 */
const handlers = new Map<string, Set<(e: unknown) => void>>();
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribe: (type: string, handler: (e: unknown) => void) => {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(handler);
      return () => handlers.get(type)?.delete(handler);
    },
    emit: (type: string, payload: unknown) => {
      for (const h of handlers.get(type) ?? []) h({ type, payload });
    },
    subscribeDebounced: () => () => {},
  },
  useMasterBusSubscription: vi.fn(),
}));

import { useTableSession } from '../../src/hooks/useTableSession';
import { masterBus } from '../../src/core/MasterBus';

const MINE = 'table-mine';
const OTHER = 'table-other';

/**
 * MasterBus suppresses an IDENTICAL payload seen within 500ms (see its
 * DEDUP_WINDOW_MS). Real hands always differ by handId, so give every emit a
 * unique one here; otherwise the bus, not the code under test, decides what
 * this file proves.
 */
let handSeq = 0;
const handAt = (tableId: string, won: boolean, heroStack: number) =>
  act(() => {
    masterBus.emit('HAND_COMPLETED', {
      handId: `h${++handSeq}`,
      tableId,
      won,
      potWon: 0,
      heroStack,
    });
  });

describe('useTableSession is scoped to its own table', () => {
  it('counts only hands played at ITS table', () => {
    const { result } = renderHook(() => useTableSession(MINE));

    handAt(MINE, true, 500);
    handAt(OTHER, true, 9999);
    handAt(OTHER, true, 9999);
    handAt(MINE, false, 400);

    expect(result.current.handsPlayedRef.current, 'counted another table').toBe(2);
    expect(result.current.handsWonRef.current).toBe(1);
  });

  it('never takes another table’s peak stack', () => {
    const { result } = renderHook(() => useTableSession(MINE));
    handAt(MINE, true, 500);
    handAt(OTHER, true, 999_999);
    expect(result.current.peakStackRef.current).toBe(500);
  });

  it('never takes another table’s biggest pot', () => {
    const { result } = renderHook(() => useTableSession(MINE));
    act(() => {
      masterBus.emit('POT_DISTRIBUTED', { table_id: MINE, total_pot: 250 } as never);
      masterBus.emit('POT_DISTRIBUTED', { table_id: OTHER, total_pot: 100_000 } as never);
    });
    expect(result.current.biggestPotRef.current).toBe(250);
  });

  it('drops an event that names no table rather than guessing', () => {
    // An unattributable event is precisely what caused the original bug, and a
    // missing stat is cheaper than a wrong one on a card whose whole job is to
    // report what happened at ONE table.
    const { result } = renderHook(() => useTableSession(MINE));
    act(() => {
      masterBus.emit('HAND_COMPLETED', {
        handId: `h${++handSeq}`,
        won: true,
        potWon: 0,
        heroStack: 800,
      } as never);
    });
    expect(result.current.handsPlayedRef.current).toBe(0);
  });

  it('starts a fresh session when the table changes', () => {
    const { result, rerender } = renderHook(({ id }) => useTableSession(id), {
      initialProps: { id: MINE },
    });
    handAt(MINE, true, 700);
    expect(result.current.handsPlayedRef.current).toBe(1);

    rerender({ id: OTHER });
    expect(result.current.handsPlayedRef.current, 'carried the old table over').toBe(0);
    expect(result.current.peakStackRef.current).toBe(0);

    handAt(OTHER, true, 300);
    expect(result.current.handsPlayedRef.current).toBe(1);
    expect(result.current.peakStackRef.current).toBe(300);
  });
});
