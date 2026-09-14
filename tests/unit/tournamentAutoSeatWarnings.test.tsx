import React, {
  StrictMode,
  Suspense,
  startTransition,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { render, act, cleanup, fireEvent } from '@testing-library/react';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
const h = vi.hoisted(() => ({
  user: { id: 'actor-A' } as any,
  reads: [] as any[],
  events: [] as any[],
  listeners: new Map<string, Set<any>>(),
  navigate: vi.fn(),
  warm: vi.fn(),
  report: vi.fn(),
  resync: vi.fn(),
  cap: vi.fn(),
  committed: [] as any[],
  setTabs: null as any,
  transport: null as any,
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => h.navigate }));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: h.user }) }));
vi.mock('../../src/services/tableWarmup', () => ({ warmTable: h.warm }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: h.report }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (relation: string) => {
      const filters: any[] = [];
      const query: any = {
        select: (columns: string) => {
          filters.push(['select', columns]);
          return query;
        },
        eq: (...args: any[]) => {
          filters.push(['eq', ...args]);
          return query;
        },
        is: (...args: any[]) => {
          filters.push(['is', ...args]);
          return query;
        },
        limit: (limit: number) =>
          new Promise((resolve, reject) =>
            h.reads.push({ relation, filters, limit, resolve, reject })
          ),
      };
      return query;
    },
  },
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribe: (name: string, callback: any) => {
      if (h.transport) return h.transport.subscribe(name, callback);
      if (!h.listeners.has(name)) h.listeners.set(name, new Set());
      h.listeners.get(name)!.add(callback);
      return () => h.listeners.get(name)?.delete(callback);
    },
    emit: (name: string, payload: any) => {
      h.events.push({ name, payload });
      if (h.transport) return h.transport.emit(name, payload);
      for (const callback of [...(h.listeners.get(name) || [])]) callback({ payload });
    },
  },
}));
import AutoSeat from '../../src/components/tournament/TournamentAutoSeat';
import { masterBus } from '../../src/core/MasterBus';

const row = (table = 'destination-A', away = false) => ({
  table_id: table,
  joined_at: new Date().toISOString(),
  stack: 100,
  is_away: away,
  is_sitting_out: false,
  tables: { id: table, name: 'Fixture Event - Table 1', tournament_id: 'event', status: 'running' },
});
const seated = () => h.events.filter((e) => e.name === 'TABLE_SEATED');
const replies = () => h.events.filter((e) => e.name === 'TOURNAMENT_TABLE_OPEN_RESULT');
const storedSeen = () =>
  Object.keys(sessionStorage)
    .filter((k) => k.startsWith('ca_tourney_autoseat_seen:'))
    .flatMap((k) => JSON.parse(sessionStorage.getItem(k)!));
async function respond(n: number, rows: any[]) {
  await act(async () => {
    h.reads[n].resolve({ data: rows.slice(0, h.reads[n].limit), error: null });
    await Promise.resolve();
  });
}
async function poll() {
  await act(async () => {
    vi.advanceTimersByTime(12000);
  });
}
function emit(name: any, payload: any) {
  act(() => masterBus.emit(name, payload));
}
beforeEach(() => {
  vi.useFakeTimers();
  h.user = { id: 'actor-A' };
  h.reads = [];
  h.events = [];
  h.listeners.clear();
  h.committed = [];
  h.setTabs = null;
  h.transport = null;
  [h.navigate, h.warm, h.report, h.resync, h.cap].forEach((fn) => fn.mockClear());
  sessionStorage.clear();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});
afterEach(() => {
  cleanup();
  expect([...h.listeners.values()].every((s) => s.size === 0)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

function named(id: string, away = true) {
  const value = row(id, away);
  value.tables.name = `Event ${id} - Table 1`;
  return value;
}
it('control: current own live away tournament produces a warning', async () => {
  const v = render(<AutoSeat />);
  await respond(0, [named('A')]);
  expect(v.getByRole('dialog').textContent).toContain('Event A');
  expect(h.reads[0].filters).toContainEqual(['eq', 'user_id', 'actor-A']);
  expect(h.reads[0].filters).toContainEqual(['is', 'left_at', null]);
});
it('control: returned non-away clears and a later away transition rearms', async () => {
  const v = render(<AutoSeat />);
  await respond(0, [named('A')]);
  await poll();
  await respond(1, [named('A', false)]);
  expect(v.queryByRole('dialog')).toBeNull();
  await poll();
  await respond(2, [named('A')]);
  expect(v.getByRole('dialog').textContent).toContain('Event A');
});
it('control: failed query cannot certify warning departure', async () => {
  const v = render(<AutoSeat />);
  await respond(0, [named('A')]);
  await poll();
  await act(async () => {
    h.reads[1].resolve({ data: null, error: new Error('unavailable') });
    await Promise.resolve();
  });
  expect(v.getByRole('dialog').textContent).toContain('Event A');
  expect(h.report).toHaveBeenCalledTimes(1);
});
it('policy control: never-attempted old seat is not auto-opened but can warn', async () => {
  const v = render(<AutoSeat />);
  const seat = { ...named('A'), joined_at: new Date(Date.now() - 600001).toISOString() };
  await respond(0, [seat]);
  expect(seated()).toHaveLength(0);
  expect(v.getByRole('dialog').textContent).toContain('Event A');
});
it('CB015 desired safety: returned terminal table retires its urgent warning', async () => {
  const v = render(<AutoSeat />);
  await respond(0, [named('A')]);
  await poll();
  await respond(1, [{ ...named('A'), tables: { ...named('A').tables, status: 'completed' } }]);
  expect(v.queryByRole('dialog')).toBeNull();
});
it('CB015 desired presentation: every current away seat remains available after prior dismissal', async () => {
  const v = render(<AutoSeat />);
  const seats = [named('A'), named('B'), named('C')];
  await respond(0, seats);
  const displayed = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const dialog = v.queryByRole('dialog');
    expect(dialog).not.toBeNull();
    for (const id of ['A', 'B', 'C'])
      if (dialog!.textContent?.includes(`Event ${id}`)) displayed.add(id);
    fireEvent.click(v.getByText('Dismiss'));
  }
  expect([...displayed].sort()).toEqual(['A', 'B', 'C']);
});
it('CB015 desired freshness: retained warning refreshes observed stack', async () => {
  const v = render(<AutoSeat />);
  await respond(0, [named('A')]);
  await poll();
  await respond(1, [{ ...named('A'), stack: 75 }]);
  expect(v.getByRole('dialog').textContent).toContain('75 Chips Left');
});
it('CB015 desired safety: terminal observation retires a retained cap dialog', async () => {
  const v = render(<AutoSeat />);
  await respond(0, [named('A', false)]);
  emit('TOURNAMENT_TABLE_OPEN_RESULT', { ...seated()[0].payload, status: 'cap_blocked' });
  expect(v.getByRole('dialog').getAttribute('aria-label')).toBe('Tournament Started');
  await poll();
  await respond(1, [{ ...named('A', false), tables: { ...named('A').tables, status: 'closed' } }]);
  expect(v.queryByRole('dialog')).toBeNull();
});

it('queue order survives reordered snapshots and duplicate rows', async () => {
  const v = render(<AutoSeat />);
  await respond(0, [named('A'), named('A'), named('B')]);
  expect(v.getByRole('dialog').textContent).toContain('Event A');
  await poll();
  await respond(1, [named('B'), named('A'), named('C'), named('B')]);
  expect(v.getByRole('dialog').textContent).toContain('Event A');
  fireEvent.click(v.getByText('Dismiss'));
  expect(v.getByRole('dialog').textContent).toContain('Event B');
  fireEvent.click(v.getByText('Dismiss'));
  expect(v.getByRole('dialog').textContent).toContain('Event C');
  fireEvent.click(v.getByText('Dismiss'));
  expect(v.queryByRole('dialog')).toBeNull();
});
it('dismissed continuous episode stays suppressed and positive non-away rearms only that table', async () => {
  const v = render(<AutoSeat />);
  await respond(0, [named('A'), named('B')]);
  fireEvent.click(v.getByText('Dismiss'));
  fireEvent.click(v.getByText('Dismiss'));
  await poll();
  await respond(1, [named('A'), named('B')]);
  expect(v.queryByRole('dialog')).toBeNull();
  await poll();
  await respond(2, [named('A', false), named('B')]);
  await poll();
  await respond(3, [named('A'), named('B')]);
  expect(v.getByRole('dialog').textContent).toContain('Event A');
  fireEvent.click(v.getByText('Dismiss'));
  expect(v.queryByRole('dialog')).toBeNull();
});
it.each(['closed', 'cancelled', 'finished'])(
  'explicit %s head removal preserves another warning and rejects the retired attempt ACK',
  async (status) => {
    const v = render(<AutoSeat />);
    await respond(0, [named('A'), named('B')]);
    fireEvent.click(v.getByText('Take My Seat'));
    const request = seated().at(-1)!.payload;
    emit('TOURNAMENT_TABLE_OPEN_RESULT', { ...request, status: 'cap_blocked' });
    await poll();
    await respond(1, [{ ...named('A'), tables: { ...named('A').tables, status } }, named('B')]);
    expect(v.getByRole('dialog').textContent).toContain('Event B');
    emit('TOURNAMENT_TABLE_OPEN_RESULT', { ...request, status: 'opened' });
    expect(h.navigate).not.toHaveBeenCalled();
    expect(storedSeen()).toEqual([]);
    fireEvent.click(v.getByText('Dismiss'));
    expect(v.queryByRole('dialog')).toBeNull();
  }
);
it('explicit non-tournament row retires urgent/cap/pending while null join remains unknown', async () => {
  const v = render(<AutoSeat />);
  await respond(0, [named('A')]);
  fireEvent.click(v.getByText('Take My Seat'));
  const request = seated().at(-1)!.payload;
  emit('TOURNAMENT_TABLE_OPEN_RESULT', { ...request, status: 'cap_blocked' });
  await poll();
  await respond(1, [{ ...named('A'), tables: null }]);
  expect(v.getByRole('dialog').textContent).toContain('Event A');
  await poll();
  await respond(2, [{ ...named('A'), tables: { ...named('A').tables, tournament_id: null } }]);
  expect(v.queryByRole('dialog')).toBeNull();
  emit('TOURNAMENT_TABLE_OPEN_RESULT', { ...request, status: 'opened' });
  expect(h.navigate).not.toHaveBeenCalled();
  expect(storedSeen()).toEqual([]);
});
it('removing a queued table does not remove or repeat the displayed warning', async () => {
  const v = render(<AutoSeat />);
  await respond(0, [named('A'), named('B'), named('C')]);
  await poll();
  await respond(1, [{ ...named('B'), tables: { ...named('B').tables, status: 'closed' } }]);
  expect(v.getByRole('dialog').textContent).toContain('Event A');
  fireEvent.click(v.getByText('Dismiss'));
  expect(v.getByRole('dialog').textContent).toContain('Event C');
  fireEvent.click(v.getByText('Dismiss'));
  expect(v.queryByRole('dialog')).toBeNull();
});
it('latest name and stack refresh without reordering or losing exact cap explanation', async () => {
  const v = render(<AutoSeat />);
  await respond(0, [named('A'), named('B')]);
  fireEvent.click(v.getByText('Take My Seat'));
  emit('TOURNAMENT_TABLE_OPEN_RESULT', { ...seated().at(-1)!.payload, status: 'cap_blocked' });
  await poll();
  await respond(1, [
    named('B'),
    { ...named('A'), stack: 75, tables: { ...named('A').tables, name: 'Renamed Event - Table 2' } },
  ]);
  expect(v.getByRole('dialog').textContent).toContain('Renamed Event');
  expect(v.getByRole('dialog').textContent).toContain('75 Chips Left');
  expect(v.getByRole('dialog').textContent).toContain('Close A Table');
  fireEvent.click(v.getByText('Dismiss'));
  expect(v.getByRole('dialog').textContent).toContain('Event B');
});
it('positive non-away removes urgent warning but preserves a valid capped opening', async () => {
  const v = render(<AutoSeat />);
  await respond(0, [named('A')]);
  emit('TOURNAMENT_TABLE_OPEN_RESULT', { ...seated()[0].payload, status: 'cap_blocked' });
  await poll();
  await respond(1, [named('A', false)]);
  expect(v.getByRole('dialog').getAttribute('aria-label')).toBe('Tournament Started');
  expect(v.getByRole('dialog').textContent).toContain('Event A');
});
it('same-user session replacement discards every queued warning and old terminal completion', async () => {
  const v = render(<AutoSeat />);
  await respond(0, [named('A'), named('B')]);
  await poll();
  emit('AUTH_STATE_CHANGED', { isAuthenticated: true, userId: 'actor-A' });
  expect(v.queryByRole('dialog')).toBeNull();
  await respond(2, [named('new')]);
  await respond(1, [
    { ...named('new'), tables: { ...named('new').tables, status: 'closed' } },
    named('old'),
  ]);
  expect(v.getByRole('dialog').textContent).toContain('Event new');
  fireEvent.click(v.getByText('Dismiss'));
  expect(v.queryByRole('dialog')).toBeNull();
});
it('account replacement removes the whole queue and stale result cannot append', async () => {
  const v = render(<AutoSeat />);
  await respond(0, [named('A'), named('B')]);
  await poll();
  h.user = { id: 'actor-B' };
  v.rerender(<AutoSeat />);
  await respond(2, [named('new')]);
  await respond(1, [named('old')]);
  expect(v.getByRole('dialog').textContent).toContain('Event new');
  fireEvent.click(v.getByText('Dismiss'));
  expect(v.queryByRole('dialog')).toBeNull();
});
it('superseded terminal and non-away results cannot erase newer queued warnings or values', async () => {
  const v = render(<AutoSeat />);
  await respond(0, [named('A')]);
  await poll();
  await poll();
  await respond(2, [{ ...named('A'), stack: 75 }, named('B')]);
  await respond(1, [
    { ...named('A'), tables: { ...named('A').tables, status: 'closed' } },
    named('B', false),
    named('old'),
  ]);
  expect(v.getByRole('dialog').textContent).toContain('75 Chips Left');
  fireEvent.click(v.getByText('Dismiss'));
  expect(v.getByRole('dialog').textContent).toContain('Event B');
  fireEvent.click(v.getByText('Dismiss'));
  expect(v.queryByRole('dialog')).toBeNull();
});
it('hidden in-flight completion cannot add or remove warnings and visible current poll can', async () => {
  const v = render(<AutoSeat />);
  await respond(0, [named('A'), named('B')]);
  await poll();
  act(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await respond(1, [
    { ...named('A'), tables: { ...named('A').tables, status: 'closed' } },
    named('old'),
  ]);
  expect(v.getByRole('dialog').textContent).toContain('Event A');
  act(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await respond(2, [
    { ...named('A'), tables: { ...named('A').tables, status: 'closed' } },
    named('B'),
  ]);
  expect(v.getByRole('dialog').textContent).toContain('Event B');
  fireEvent.click(v.getByText('Dismiss'));
  expect(v.queryByRole('dialog')).toBeNull();
});
it('bounded missing rows preserve notices and pending attempts instead of certifying absence', async () => {
  const v = render(<AutoSeat />);
  await respond(0, [named('A'), named('B')]);
  const request = seated()[0].payload;
  await poll();
  await respond(1, []);
  expect(v.getByRole('dialog').textContent).toContain('Event A');
  emit('TOURNAMENT_TABLE_OPEN_RESULT', { ...request, status: 'cap_blocked' });
  fireEvent.click(v.getByText('Dismiss'));
  expect(v.getByRole('dialog').textContent).toContain('Event B');
});
it('matched explicit opening advances only its warning and duplicate reply cannot navigate twice', async () => {
  const v = render(<AutoSeat />);
  await respond(0, [named('A'), named('B')]);
  fireEvent.click(v.getByText('Take My Seat'));
  const request = seated().at(-1)!.payload;
  emit('TOURNAMENT_TABLE_OPEN_RESULT', { ...request, status: 'opened' });
  emit('TOURNAMENT_TABLE_OPEN_RESULT', { ...request, status: 'opened' });
  expect(h.navigate).toHaveBeenCalledExactlyOnceWith('/table/A');
  expect(v.getByRole('dialog').textContent).toContain('Event B');
});
