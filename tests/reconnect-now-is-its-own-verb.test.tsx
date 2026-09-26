/**
 * RECONNECT-NOW IS ITS OWN VERB (Create A Club Phase 2, 2026-09-22).
 *
 * On 2026-09-20 the "try again now, the tables row says this table wakes on
 * demand" signal from TablePage rode requestSnapshot(), whose job is the
 * RESYNC after a confirmed buy-in. One verb doing two things meant a buy-in
 * confirmation at a missing table could start a reconnect. The client and the
 * hook now carry reconnectNow() for the one and leave requestSnapshot() the
 * other. The client's half is pinned in tests/a-new-table-is-waking-not-gone;
 * this is the hook's.
 */
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  useEngineTableState,
  type UseEngineTableStateResult,
} from '../src/hooks/useEngineTableState';

const calls = vi.hoisted(() => ({ reconnectNow: 0, requestSnapshot: 0 }));
vi.mock('../src/lib/authToken', () => ({ getFreshAccessToken: vi.fn() }));
vi.mock('../src/services/EngineStateClient', () => ({
  default: class {
    connect() {
      return Promise.resolve();
    }
    disconnect() {}
    noteScheduledRestart() {}
    requestSnapshot() {
      calls.requestSnapshot += 1;
    }
    reconnectNow() {
      calls.reconnectNow += 1;
    }
  },
}));

afterEach(() => {
  cleanup();
  calls.reconnectNow = 0;
  calls.requestSnapshot = 0;
});

function mount() {
  const seen: UseEngineTableStateResult[] = [];
  function Consumer({ tick }: { tick: number }) {
    const api = useEngineTableState('table-a');
    seen.push(api);
    return <span data-tick={tick} />;
  }
  const view = render(<Consumer tick={0} />);
  return { seen, rerender: (tick: number) => view.rerender(<Consumer tick={tick} />) };
}

it('hands reconnectNow to the client, and requestSnapshot stays the resync', () => {
  const { seen } = mount();
  act(() => seen.at(-1)!.reconnectNow());
  expect(calls).toEqual({ reconnectNow: 1, requestSnapshot: 0 });
  act(() => seen.at(-1)!.requestSnapshot());
  expect(calls).toEqual({ reconnectNow: 1, requestSnapshot: 1 });
});

it('is the same function on every render, so an effect that lists it runs once per error', () => {
  const { seen, rerender } = mount();
  rerender(1);
  rerender(2);
  expect(seen.length).toBeGreaterThanOrEqual(3);
  const first = seen[0];
  for (const api of seen) {
    expect(api.reconnectNow).toBe(first.reconnectNow);
    expect(api.requestSnapshot).toBe(first.requestSnapshot);
  }
});

it('with no client (no table, or disabled) it is a safe no-op', () => {
  const seen: UseEngineTableStateResult[] = [];
  function Consumer() {
    seen.push(useEngineTableState(null));
    return null;
  }
  render(<Consumer />);
  expect(() => act(() => seen.at(-1)!.reconnectNow())).not.toThrow();
  expect(calls.reconnectNow).toBe(0);
});
