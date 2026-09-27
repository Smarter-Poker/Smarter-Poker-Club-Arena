import React from 'react';
import { createServer } from 'node:http';
import { setTimeout as realDelay } from 'node:timers/promises';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  client: null as SupabaseClient | null,
  user: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  toast: { error: vi.fn() },
}));
vi.mock('../../src/lib/supabase', () => ({
  get supabase() {
    return state.client;
  },
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: state.user }) }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => state.toast }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { subscribeDebounced: () => () => {} } }));
vi.mock('recharts', () => ({
  ResponsiveContainer: () => null,
  BarChart: () => null,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  CartesianGrid: () => null,
}));
import RakebackPage from '../../src/pages/RakebackPage';

const row = (id: string, user: string, amount: number) => ({
  id,
  user_id: user,
  club_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  period_start: '2026-09-01',
  period_end: '2026-09-07',
  rake_generated: amount * 10,
  rakeback_rate: 0.1,
  rakeback_earned: amount,
  status: 'pending',
});
function ready() {
  return within(screen.getByLabelText('Rakeback Engine Live Summary'))
    .getByText('Next Ready Period')
    .parentElement!.querySelector('dd')!.textContent;
}

it('observes external availability through actual SDK HTTP reads on the mounted page, without WAL or money commands', async () => {
  // Local protocol peer only. Native policy tests establish database authority;
  // this fixture establishes actual SDK query serialization and mounted state.
  let rows: ReturnType<typeof row>[] = [];
  const requests: Array<{ method: string; url: URL }> = [];
  let fail = false;
  const server = createServer((request, response) => {
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('access-control-allow-headers', '*');
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end();
      return;
    }
    const url = new URL(request.url!, 'http://fixture');
    requests.push({ method: request.method!, url });
    response.setHeader('content-type', 'application/json');
    if (request.method !== 'GET' || url.pathname !== '/rest/v1/rakeback_periods') {
      response.writeHead(400).end(JSON.stringify({ message: 'Unexpected request' }));
      return;
    }
    if (fail) {
      response.writeHead(500).end(JSON.stringify({ message: 'Read failed' }));
      return;
    }
    const uid = url.searchParams.get('user_id')?.replace(/^eq\./, '');
    const limit = Number(url.searchParams.get('limit'));
    response.end(JSON.stringify(rows.filter((entry) => entry.user_id === uid).slice(0, limit)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local fixture did not bind');
  state.client = createClient(`http://127.0.0.1:${address.port}`, 'local-fixture-only', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const eventually = async (assertion: () => void) => {
    let last: unknown;
    for (let attempt = 0; attempt < 100; ++attempt) {
      await act(async () => {
        await realDelay(5);
      });
      try {
        assertion();
        return;
      } catch (error) {
        last = error;
      }
    }
    throw last;
  };
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-09-11T12:00:00Z'));
  try {
    render(
      <MemoryRouter>
        <RakebackPage />
      </MemoryRouter>
    );
    await eventually(() => {
      expect(requests).toHaveLength(2);
      expect(ready()).toBe('0');
    });
    // Another actor commits a new period at the server. No client bus event,
    // refresh click, route transition or synthetic money RPC is sent.
    rows = [
      row('foreign', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 900),
      row('own', state.user.id, 23),
    ];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await eventually(() => expect(ready()).toBe('23'));
    expect(requests).toHaveLength(4);
    for (const request of requests) {
      expect(request.method).toBe('GET');
      expect(request.url.searchParams.get('user_id')).toBe(`eq.${state.user.id}`);
      expect(request.url.searchParams.get('order')).toBe('period_start.desc');
      expect(request.url.searchParams.get('select')).not.toBe('*');
    }
    const eligible = requests.filter((r) => r.url.searchParams.get('limit') === '1');
    expect(eligible).toHaveLength(2);
    expect(eligible[1].url.searchParams.get('status')).toBe('eq.pending');
    expect(eligible[1].url.searchParams.get('rakeback_earned')).toBe('gt.0');
    expect(eligible[1].url.searchParams.get('period_end')).toBe('lt.2026-09-11');
    expect(eligible[1].url.searchParams.get('club_id')).toBe('not.is.null');
    expect(state.client.getChannels()).toHaveLength(0);
    fail = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await eventually(() =>
      expect(
        screen.getByText('Rakeback Data Could Not Be Refreshed. Please Try Again.')
      ).toBeVisible()
    );
    expect(ready()).toBe('23');
    expect(requests).toHaveLength(6);
  } finally {
    cleanup();
    vi.useRealTimers();
    await state.client.removeAllChannels();
    state.client = null;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
